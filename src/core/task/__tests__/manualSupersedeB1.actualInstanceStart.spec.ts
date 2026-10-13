import * as crypto from "crypto"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { TelemetryService } from "@roo-code/telemetry"
import type { HistoryItem } from "@roo-code/types"
import { TaskHistoryStore } from "../../task-persistence/TaskHistoryStore"
import { saveApiMessages } from "../../task-persistence/apiMessages"
import { ParentHandoffFence, ParentHandoffFenceUnavailableError } from "../../task-persistence/parentHandoffFence"
import { bindTargetPersistence } from "../../task-persistence/targetPersistenceBoundary"
import type { ClineProvider } from "../../webview/ClineProvider"
import { Task } from "../Task"

vi.mock("../../ignore/RooIgnoreController", () => ({
	RooIgnoreController: class {
		initialize = async () => {}
		dispose = () => {}
	},
}))
vi.mock("../../protect/RooProtectedController", () => ({ RooProtectedController: class {} }))
vi.mock("../../context-tracking/FileContextTracker", () => ({ FileContextTracker: class {} }))
vi.mock("../../../api", () => ({ buildApiHandler: vi.fn(() => ({})) }))

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
	task: "parent",
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

// Private mechanical seams stop telemetry timers and the model loop; the constructor,
// static factory, real start body and canonical disk exclusion are not replaced.
const seams = Task.prototype as unknown as {
	startIdleTelemetryCheck: () => void
	getEnabledMcpToolsCount: () => Promise<{ enabledToolCount: number; enabledServerCount: number }>
	initiateTaskLoop: () => Promise<void>
}

beforeEach(() => {
	if (!TelemetryService.hasInstance()) TelemetryService.createInstance([])
	vi.spyOn(seams, "startIdleTelemetryCheck").mockImplementation(() => {})
	vi.spyOn(Task.prototype, "say").mockResolvedValue(undefined)
	vi.spyOn(seams, "getEnabledMcpToolsCount").mockResolvedValue({ enabledToolCount: 0, enabledServerCount: 0 })
	vi.spyOn(seams, "initiateTaskLoop").mockResolvedValue(undefined)
})
afterEach(() => vi.restoreAllMocks())

async function fixture() {
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), "b1-actual-instance-"))
	const store = new TaskHistoryStore(storage),
		competitor = new TaskHistoryStore(storage)
	await store.initialize()
	await competitor.initialize()
	await store.upsert(item)
	const entered = signal(),
		finish = signal()
	const provider = {
		context: { globalStorageUri: { fsPath: storage } },
		getState: async () => ({ mode: "code", currentApiConfigName: "fixture" }),
		log: vi.fn(),
		postStateToWebviewWithoutTaskHistory: vi.fn(async () => {
			entered.release()
			await finish.promise
		}),
	} as unknown as ClineProvider
	return {
		storage,
		store,
		competitor,
		entered,
		finish,
		provider,
		options: {
			provider,
			apiConfiguration: {},
			taskId: "child",
			task: "offline fixture",
			parentTask: { taskId: "parent", workspacePath: storage } as Task,
			enableCheckpoints: false,
		},
		close: async () => {
			finish.release()
			store.dispose()
			competitor.dispose()
			await fs.rm(storage, { recursive: true, force: true })
		},
	}
}

for (const entry of ["constructor", "static"] as const) {
	it(`actual ${entry} instance owns parent exclusion through paused initialization and loop admission`, async () => {
		const f = await fixture()
		try {
			let completion: Promise<void> | undefined
			const task =
				entry === "constructor"
					? new Task(f.options)
					: (() => {
							const pair = Task.create(f.options)
							completion = pair[1]
							return pair[0]
						})()
			await f.entered.promise
			await f.competitor.readAuthoritative("parent")
			await expect(bindTargetPersistence(f.storage, "parent", action)).rejects.toThrow(/parent/i)
			expect(task.parentTaskId).toBe("parent")
			f.finish.release()
			if (completion) await completion
			await vi.waitFor(() => expect(seams.initiateTaskLoop).toHaveBeenCalledOnce())
		} finally {
			await f.close()
		}
	})

	it(`actual ${entry} instance refuses a previously bound parent before initialization or loop`, async () => {
		const f = await fixture()
		const logged = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			await bindTargetPersistence(f.storage, "parent", action)
			if (entry === "static") {
				const [, completion] = Task.create(f.options)
				await expect(completion).rejects.toThrow(/Bound parent/)
			} else {
				new Task(f.options)
				await vi.waitFor(() => expect(logged).toHaveBeenCalled())
			}
			expect(f.provider.postStateToWebviewWithoutTaskHistory).not.toHaveBeenCalled()
			expect(Task.prototype.say).not.toHaveBeenCalled()
			expect(seams.initiateTaskLoop).not.toHaveBeenCalled()
		} finally {
			await f.close()
		}
	})

	it(`actual ${entry} instance rejects lost parent generation after initialization before loop`, async () => {
		const f = await fixture()
		const logged = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			let completion: Promise<void> | undefined
			if (entry === "static") [, completion] = Task.create(f.options)
			else new Task(f.options)
			await f.entered.promise
			const key = crypto.createHash("sha256").update("parent").digest("hex")
			await fs.writeFile(path.join(f.storage, ".handoff-fences", `${key}.generation`), "999")
			f.finish.release()
			if (completion) await expect(completion).rejects.toThrow(/ownership|generation/i)
			else await vi.waitFor(() => expect(logged).toHaveBeenCalled())
			expect(seams.initiateTaskLoop).not.toHaveBeenCalled()
		} finally {
			await f.close()
		}
	})
}

it("permits ordinary API and metadata saves while an actual task loop remains pending", async () => {
	const f = await fixture()
	const loop = signal()
	const entered = signal()
	vi.spyOn(seams, "initiateTaskLoop").mockImplementation(async () => {
		await f.store.upsert({
			...item,
			id: "child",
			parentTaskId: "parent",
			rootTaskId: "parent",
			pendingAction: undefined,
		})
		await saveApiMessages({
			globalStoragePath: f.storage,
			taskId: "child",
			messages: [{ role: "user", content: "result" }],
		})
		await f.competitor.upsert({ ...item, id: "other", pendingAction: undefined, tokensIn: 7 })
		entered.release()
		await loop.promise
	})
	try {
		const [, completion] = Task.create(f.options)
		f.finish.release()
		await entered.promise
		expect(
			JSON.parse(
				await fs.readFile(path.join(f.storage, "tasks", "child", "api_conversation_history.json"), "utf8"),
			),
		).toMatchObject([{ content: "result" }])
		expect(
			JSON.parse(await fs.readFile(path.join(f.storage, "tasks", "child", "history_item.json"), "utf8")),
		).toMatchObject({ parentTaskId: "parent" })
		expect(
			JSON.parse(await fs.readFile(path.join(f.storage, "tasks", "other", "history_item.json"), "utf8")),
		).toMatchObject({ tokensIn: 7 })
		loop.release()
		await completion
	} finally {
		loop.release()
		await f.close()
	}
})

it("propagates a typed fence refusal from the Task API save without publishing stale data", async () => {
	const f = await fixture()
	try {
		const [task, completion] = Task.create(f.options)
		f.finish.release()
		await completion
		const save = task as unknown as { saveApiConversationHistory: () => Promise<boolean> }
		const apiFile = path.join(f.storage, "tasks", "child", "api_conversation_history.json")
		const before = await fs.readFile(apiFile, "utf8").catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error
			return null
		})
		const acquire = vi
			.spyOn(ParentHandoffFence.prototype, "acquire")
			.mockRejectedValue(new ParentHandoffFenceUnavailableError("child", "timeout"))
		const logged = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			await expect(save.saveApiConversationHistory()).rejects.toBeInstanceOf(ParentHandoffFenceUnavailableError)
			expect(acquire).toHaveBeenCalled()
			const after = await fs.readFile(apiFile, "utf8").catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error
				return null
			})
			expect(after).toBe(before)
		} finally {
			logged.mockRestore()
			acquire.mockRestore()
		}
	} finally {
		await f.close()
	}
})
