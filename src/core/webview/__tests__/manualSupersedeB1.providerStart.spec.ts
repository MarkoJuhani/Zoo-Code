import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import type { HistoryItem } from "@roo-code/types"
import { TaskHistoryStore } from "../../task-persistence/TaskHistoryStore"
import { bindTargetPersistence, withProviderStartExclusion } from "../../task-persistence/targetPersistenceBoundary"
import type { Task } from "../../task/Task"
import { ClineProvider, scheduleTask } from "../ClineProvider"

const action = {
	kind: "create_subtask" as const,
	actionId: "old",
	mode: "code",
	message: "old",
	todos: [],
	approvalText: "old",
}
const item = (id: string): HistoryItem => ({
	id,
	number: 1,
	ts: 1,
	task: id,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	status: "interrupted",
	childIds: [],
	pendingAction: id === "parent" ? action : undefined,
})

it("actual delegation entry retains parent exclusion through a paused capable callback and blocks a later bound target", async () => {
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), "b1-provider-start-"))
	const alias = `${storage}-alias`
	const first = new TaskHistoryStore(storage)
	const second = new TaskHistoryStore(storage)
	let release!: () => void
	let entered!: () => void
	const pause = new Promise<void>((resolve) => {
		release = resolve
	})
	const atEffect = new Promise<void>((resolve) => {
		entered = resolve
	})
	const effect = vi.fn(async () => {
		entered()
		await pause
		return {} as Task
	})
	const makeProvider = (root: string) =>
		({
			contextProxy: { globalStorageUri: { fsPath: root } },
			getCurrentTask: () => undefined,
			runDelegationTransition: (_id: string, fn: () => Promise<Task>) => fn(),
			delegateParentAndOpenChildUnlocked: effect,
		}) as unknown as ClineProvider
	const params = {
		parentTaskId: "parent",
		message: "old",
		initialTodos: [],
		mode: "code" as const,
		pendingActionId: "old",
	}
	try {
		await fs.symlink(storage, alias)
		await first.initialize()
		await second.initialize()
		await first.upsert(item("parent"))
		await first.upsert(item("other"))
		const running = ClineProvider.prototype.delegateParentAndOpenChild.call(makeProvider(alias), params)
		await atEffect
		await expect(bindTargetPersistence(storage, "parent", action)).rejects.toThrow(/parent/i)
		const unrelated = vi.fn(async () => "continued")
		await expect(withProviderStartExclusion(storage, "other", unrelated)).resolves.toBe("continued")
		expect(unrelated).toHaveBeenCalledOnce()
		expect(effect).toHaveBeenCalledTimes(1)
		release()
		await running
		await bindTargetPersistence(storage, "parent", action)
		await expect(
			ClineProvider.prototype.delegateParentAndOpenChild.call(makeProvider(storage), params),
		).rejects.toThrow(/Bound parent/)
		expect(effect).toHaveBeenCalledTimes(1)
	} finally {
		release()
		first.dispose()
		second.dispose()
		await fs.rm(alias, { force: true })
		await fs.rm(storage, { recursive: true, force: true })
	}
})

for (const entry of ["createTask", "createTaskWithHistoryItem"] as const) {
	it(`the actual provider ${entry} entry rejects bound parent before child publication or restoration`, async () => {
		const storage = await fs.mkdtemp(path.join(os.tmpdir(), "b1-provider-bound-"))
		const store = new TaskHistoryStore(storage)
		try {
			await store.initialize()
			await store.upsert(item("parent"))
			await bindTargetPersistence(storage, "parent", action)
			const effect = vi.fn(async () => ({}) as Task)
			const provider = {
				contextProxy: { globalStorageUri: { fsPath: storage } },
				taskHistoryStore: store,
				historyTaskCreationQueue: undefined,
				createTaskUnlocked: effect,
				createTaskWithHistoryItemUnlocked: effect,
			} as unknown as ClineProvider
			if (entry === "createTask") {
				await expect(
					ClineProvider.prototype.createTask.call(provider, "child", undefined, { taskId: "parent" } as Task),
				).rejects.toThrow(/Bound parent/)
			} else {
				await expect(
					ClineProvider.prototype.createTaskWithHistoryItem.call(provider, item("parent")),
				).rejects.toThrow(/Bound parent/)
			}
			expect(effect).not.toHaveBeenCalled()
		} finally {
			store.dispose()
			await fs.rm(storage, { recursive: true, force: true })
		}
	})
}

it("fallback callback takes new exclusion after enqueue and refuses a newly bound parent", async () => {
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), "b1-fallback-"))
	const store = new TaskHistoryStore(storage)
	let release!: () => void
	let arrived!: () => void
	const pause = new Promise<void>((resolve) => {
		release = resolve
	})
	const entered = new Promise<void>((resolve) => {
		arrived = resolve
	})
	let failed!: () => void
	const settled = new Promise<void>((resolve) => {
		failed = resolve
	})
	const effect = vi.fn(async () => {})
	const runWithStartExclusion = vi.fn(async (callback: () => Promise<void>) => {
		arrived()
		await pause
		await withProviderStartExclusion(storage, "parent", callback, { fresh: true })
	})
	const task = { abort: false, abandoned: false, runWithStartExclusion } as unknown as Task
	try {
		await store.initialize()
		await store.upsert(item("parent"))
		expect(
			scheduleTask(undefined, task, "b1-fallback", effect, (stage) => {
				if (stage === "failed") failed()
			}),
		).toBe(true)
		await entered
		await bindTargetPersistence(storage, "parent", action)
		release()
		await settled
		expect(runWithStartExclusion).toHaveBeenCalledOnce()
		expect(effect).not.toHaveBeenCalled()
	} finally {
		release()
		store.dispose()
		await fs.rm(storage, { recursive: true, force: true })
	}
})
