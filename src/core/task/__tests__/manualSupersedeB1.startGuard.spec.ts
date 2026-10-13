import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import type { HistoryItem } from "@roo-code/types"
import { TaskHistoryStore } from "../../task-persistence/TaskHistoryStore"
import {
	bindTargetPersistence,
	createOrdinaryTaskPersistenceAuthority,
	withProviderStartExclusion,
} from "../../task-persistence/targetPersistenceBoundary"
import { TaskScheduler } from "../TaskScheduler"
import { Task } from "../Task"

const action = {
	kind: "create_subtask" as const,
	actionId: "old",
	mode: "code",
	message: "old",
	todos: [],
	approvalText: "old",
}
const item: HistoryItem = {
	id: "parent",
	number: 1,
	ts: 1,
	task: "old",
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	status: "interrupted",
	childIds: [],
	pendingAction: action,
}
const signal = () => {
	let release!: () => void
	const promise = new Promise<void>((resolve) => {
		release = resolve
	})
	return { promise, release }
}

it("scheduler permit callback refuses a target bound after enqueue and admission; another parent executes", async () => {
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), "b1-permit-"))
	const store = new TaskHistoryStore(storage)
	const scheduler = new TaskScheduler(1)
	try {
		await store.initialize()
		await store.upsert(item)
		const task = {
			taskId: "parent",
			persistenceAuthority: createOrdinaryTaskPersistenceAuthority(item),
			globalStoragePath: storage,
			abort: false,
			abandoned: false,
			runWithStartExclusion: Task.prototype.runWithStartExclusion,
			withStartExclusion: (Task.prototype as unknown as { withStartExclusion: Task["runWithStartExclusion"] })
				.withStartExclusion,
		} as unknown as Task
		const effect = vi.fn(async () => {})
		const hold = signal()
		const first = scheduler.schedule({ abort: false, abandoned: false } as Task, () => hold.promise)
		const queued = scheduler.schedule(task, effect)
		await bindTargetPersistence(storage, "parent", action)
		hold.release()
		await first
		await expect(queued).rejects.toThrow()
		expect(effect).not.toHaveBeenCalled()
		const otherEffect = vi.fn(async () => {})
		await scheduler.schedule({ abort: false, abandoned: false } as Task, otherEffect)
		expect(otherEffect).toHaveBeenCalledOnce()
	} finally {
		store.dispose()
		await fs.rm(storage, { recursive: true, force: true })
	}
})

it("a callback already executing retains exclusion until its last effect", async () => {
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), "b1-executing-"))
	const store = new TaskHistoryStore(storage)
	const scheduler = new TaskScheduler(1)
	try {
		await store.initialize()
		await store.upsert(item)
		const task = {
			taskId: "parent",
			persistenceAuthority: createOrdinaryTaskPersistenceAuthority(item),
			globalStoragePath: storage,
			abort: false,
			abandoned: false,
			runWithStartExclusion: Task.prototype.runWithStartExclusion,
			withStartExclusion: (Task.prototype as unknown as { withStartExclusion: Task["runWithStartExclusion"] })
				.withStartExclusion,
		} as unknown as Task
		const entered = signal(),
			finish = signal()
		const effect = vi.fn(async () => {
			entered.release()
			await finish.promise
		})
		const running = scheduler.schedule(task, effect)
		// Observe early rejection while the gate is pending; the final await still asserts success.
		void running.catch(() => {})
		await entered.promise
		await expect(bindTargetPersistence(storage, "parent", action)).rejects.toThrow(/parent/i)
		finish.release()
		await running
		expect(effect).toHaveBeenCalledOnce()
		await bindTargetPersistence(storage, "parent", action)
		await expect(scheduler.schedule(task, effect)).rejects.toThrow()
		expect(effect).toHaveBeenCalledOnce()
	} finally {
		store.dispose()
		await fs.rm(storage, { recursive: true, force: true })
	}
})

for (const entry of ["startTask", "resumeTaskFromHistory"] as const) {
	it(`the actual Task ${entry} entry refuses a bound parent before its first effect`, async () => {
		const storage = await fs.mkdtemp(path.join(os.tmpdir(), "b1-direct-start-"))
		const store = new TaskHistoryStore(storage)
		try {
			await store.initialize()
			await store.upsert(item)
			await bindTargetPersistence(storage, "parent", action)
			const effect = vi.fn(async () => {})
			const methods = Task.prototype as unknown as Record<string, (...args: unknown[]) => Promise<void>>
			const task = {
				taskId: "parent",
				persistenceAuthority: createOrdinaryTaskPersistenceAuthority(item),
				globalStoragePath: storage,
				withStartExclusion: methods.withStartExclusion,
				startTaskUnprotected: effect,
				resumeTaskFromHistoryUnprotected: effect,
			} as unknown as Task
			await expect(methods[entry].call(task)).rejects.toThrow(/Bound parent/)
			expect(effect).not.toHaveBeenCalled()
		} finally {
			store.dispose()
			await fs.rm(storage, { recursive: true, force: true })
		}
	})
}

it("nested child start reuses its held parent lease without letting binding cross", async () => {
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), "b1-nested-start-"))
	const store = new TaskHistoryStore(storage)
	try {
		await store.initialize()
		await store.upsert(item)
		const task = {
			taskId: "child",
			parentTaskId: "parent",
			globalStoragePath: storage,
			withStartExclusion: (Task.prototype as unknown as { withStartExclusion: Task["runWithStartExclusion"] })
				.withStartExclusion,
		} as unknown as Task
		const effect = vi.fn(async () => {
			await expect(bindTargetPersistence(storage, "parent", action)).rejects.toThrow(/parent/i)
		})
		await withProviderStartExclusion(storage, "parent", () =>
			withProviderStartExclusion(storage, "child", () =>
				(
					Task.prototype as unknown as {
						withStartExclusion: (this: Task, fn: () => Promise<void>) => Promise<void>
					}
				).withStartExclusion.call(task, effect),
			),
		)
		expect(effect).toHaveBeenCalledOnce()
		await bindTargetPersistence(storage, "parent", action)
	} finally {
		store.dispose()
		await fs.rm(storage, { recursive: true, force: true })
	}
})

it("after permit but before callback, a successful binding prevents the callback effect", async () => {
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), "b1-post-permit-"))
	const store = new TaskHistoryStore(storage)
	const scheduler = new TaskScheduler(1)
	const entered = signal(),
		continueCallback = signal()
	const effect = vi.fn(async () => {})
	try {
		await store.initialize()
		await store.upsert(item)
		const task = {
			abort: false,
			abandoned: false,
			runWithStartExclusion: async (callback: () => Promise<void>) => {
				entered.release()
				await continueCallback.promise
				await withProviderStartExclusion(storage, "parent", callback, { fresh: true })
			},
		} as unknown as Task
		const pending = scheduler.schedule(task, effect)
		await entered.promise
		await bindTargetPersistence(storage, "parent", action)
		continueCallback.release()
		await expect(pending).rejects.toThrow(/Bound parent/)
		expect(effect).not.toHaveBeenCalled()
	} finally {
		continueCallback.release()
		store.dispose()
		await fs.rm(storage, { recursive: true, force: true })
	}
})
