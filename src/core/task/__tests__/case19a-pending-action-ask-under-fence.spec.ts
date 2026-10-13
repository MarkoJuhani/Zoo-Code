// Case 19 follow-up, gap (a): an unbounded user wait while the task's start exclusion is held.
//
// Path under test: Task.runScheduled -> run -> resumeTaskFromHistory -> withStartExclusion
// (ParentHandoffFence file lease for the task and, for a child, its parent) ->
// resumeTaskFromHistoryUnprotected -> resumePendingTaskAction -> await ask("tool", ...).
// The lease is held until the user answers. On the deny path resumePendingTaskAction calls
// initiateTaskLoop without a `prepared` callback, so the whole agent loop also runs inside
// that scope. The ordinary start path (startTask -> prepareTaskLoop) instead returns the loop
// as a continuation that runs after the exclusion is released.
//
// Any operation that needs the same lease from another async context (a webview-handler save,
// eviction when the user opens another task, an owned question wait) is refused or times out
// while the user has not answered.
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { TelemetryService } from "@roo-code/telemetry"
import type { ClineMessage, HistoryItem, PendingTaskAction } from "@roo-code/types"
import { Task } from "../Task"
import { TaskRegistry } from "../TaskRegistry"
import { TaskHistoryStore } from "../../task-persistence/TaskHistoryStore"
import { ParentHandoffFence } from "../../task-persistence/parentHandoffFence"
import { saveApiMessages, saveTaskMessages, type ApiMessage } from "../../task-persistence"
import { ClineProvider } from "../../webview/ClineProvider"

vi.mock("../../ignore/RooIgnoreController", () => ({
	RooIgnoreController: class {
		initialize = async () => {}
		dispose = () => {}
	},
}))
vi.mock("../../protect/RooProtectedController", () => ({ RooProtectedController: class {} }))
vi.mock("../../context-tracking/FileContextTracker", () => ({
	FileContextTracker: class {
		dispose = () => {}
	},
}))
vi.mock("../../../api", () => ({
	buildApiHandler: vi.fn(() => ({
		getModel: () => ({
			id: "offline",
			info: { contextWindow: 200000, supportsComputerUse: false, supportsPromptCache: false },
		}),
	})),
}))
vi.mock("../../checkpoints", () => ({
	getCheckpointService: vi.fn(async () => undefined),
	checkpointSave: vi.fn(async () => undefined),
}))

/**
 * Production waits 30 s for an ordinary persistence lease. The ordering is identical with a
 * compressed bound; it must exceed a few queued real-disk saves under parallel suite load.
 */
const COMPRESSED_FENCE_WAIT_MS = 1_500
/** Explicit bound for every waitFor on a loaded machine. */
const WAIT = { timeout: 10_000, interval: 25 }

function signal() {
	let release!: () => void
	const promise = new Promise<void>((resolve) => {
		release = resolve
	})
	return { promise, release }
}

let root: string
let store: TaskHistoryStore
const tasks: Task[] = []
const gates: ReturnType<typeof signal>[] = []
const pending = new Set<Promise<unknown>>()
function track<T>(promise: Promise<T>): Promise<T> {
	pending.add(promise)
	const settle = () => pending.delete(promise)
	void promise.then(settle, settle)
	return promise
}
type Outcome = { ok: true } | { ok: false; error: string }
const outcome = (promise: Promise<unknown>): Promise<Outcome> =>
	track(
		promise.then(
			() => ({ ok: true as const }),
			(error: Error) => ({ ok: false as const, error: `${error.name}: ${error.message}` }),
		),
	)
/** An independent holder (another async context) asks for the lease with the compressed bound. */
const probeFence = (id: string) =>
	new ParentHandoffFence(root).acquire(id, { timeoutMs: COMPRESSED_FENCE_WAIT_MS }).then(
		async (lease) => {
			await lease.release()
			return "free"
		},
		(error: Error) => `${error.name}: ${error.message}`,
	)

beforeEach(async () => {
	if (!TelemetryService.hasInstance()) TelemetryService.createInstance([])
	root = await fs.mkdtemp(path.join(os.tmpdir(), "case19a-pending-ask-"))
	store = new TaskHistoryStore(root)
	await store.initialize()
	const acquire = ParentHandoffFence.prototype.acquire
	vi.spyOn(ParentHandoffFence.prototype, "acquire").mockImplementation(function (
		this: ParentHandoffFence,
		id,
		options = {},
	) {
		const timeoutMs = options.timeoutMs ? Math.min(options.timeoutMs, COMPRESSED_FENCE_WAIT_MS) : options.timeoutMs
		return acquire.call(this, id, { ...options, timeoutMs })
	})
})
afterEach(async () => {
	gates.splice(0).forEach((gate) => gate.release())
	for (const task of tasks) {
		task.abort = true
		task["cancelAssistantMessagePersistence"]()
	}
	await Promise.allSettled([...pending])
	for (const task of tasks.splice(0)) {
		await task.dispose().catch(() => {})
		task["debouncedEmitTokenUsage"].cancel()
	}
	store.dispose()
	vi.restoreAllMocks()
	await fs.rm(root, { recursive: true, force: true })
})

const record = (id: string, changes: Partial<HistoryItem> = {}): HistoryItem => ({
	id,
	number: 1,
	ts: 1,
	task: id,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	status: "active",
	childIds: [],
	...changes,
})

/** Real Task, store, fence and ClineProvider eviction; only the webview transport is a double. */
function fixture() {
	const registry = new TaskRegistry()
	const provider: ClineProvider = Object.assign(Object.create(ClineProvider.prototype), {
		context: { globalStorageUri: { fsPath: root }, workspaceState: { get: () => false } },
		contextProxy: { globalStorageUri: { fsPath: root } },
		taskHistoryStore: store,
		taskRegistry: registry,
		taskEventListeners: new WeakMap(),
		cancelledDelegationChildIds: new Set<string>(),
		getState: async () => ({
			mode: "code",
			currentApiConfigName: "offline",
			mcpEnabled: false,
			// The restored approval must wait for the user, as in the reported hang.
			autoApprovalEnabled: false,
		}),
		providerSettingsManager: { getModeConfigId: async () => undefined },
		log: vi.fn(),
		isViewLaunched: true,
		postStateToWebview: vi.fn(async () => {}),
		postStateToWebviewWithoutTaskHistory: vi.fn(async () => {}),
		postStateToWebviewThrottled: vi.fn(async () => {}),
		flushPostStateToWebviewThrottled: vi.fn(async () => {}),
		postMessageToWebview: vi.fn(async () => {}),
		emit: vi.fn(),
	})

	/** Seed disk state as a previous session left it: history item, UI rows, API history. */
	async function seed(item: HistoryItem, action?: PendingTaskAction) {
		const messages: ClineMessage[] = [
			{ ts: 1, type: "say", say: "text", text: item.task },
			...(action ? [{ ts: 2, type: "ask" as const, ask: "tool" as const, text: action.approvalText }] : []),
		]
		const api: ApiMessage[] = [{ ts: 1, role: "user", content: [{ type: "text", text: item.task }] }]
		if (action)
			api.push({
				ts: 2,
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: action.actionId,
						name: action.kind === "create_subtask" ? "new_task" : "attempt_completion",
						input: {},
					},
				],
			})
		await store.upsert(action ? { ...item, pendingAction: action } : item)
		await saveTaskMessages({ messages, taskId: item.id, globalStoragePath: root })
		await saveApiMessages({ messages: api, taskId: item.id, globalStoragePath: root })
	}

	/** Open the stored item the way createTaskWithHistoryItem + scheduleTask do. */
	async function restore(id: string) {
		const historyItem = store.get(id)!
		const task = new Task({
			provider,
			apiConfiguration: {},
			historyItem,
			startTask: false,
			enableCheckpoints: false,
			initialStatus: historyItem.status,
		})
		tasks.push(task)
		await task.waitForModeInitialization()
		await task.waitForApiConfigInitialization()
		task["startIdleTelemetryCheck"] = vi.fn()
		registry.push(task)
		const run = outcome(task.runScheduled())
		// The restored approval (or the generic Resume Task ask) is now waiting for the user.
		await vi.waitFor(
			() =>
				expect(task.clineMessages.at(-1)).toMatchObject(
					historyItem.pendingAction
						? { type: "ask", ask: "tool", text: historyItem.pendingAction.approvalText }
						: { type: "ask", ask: "resume_task" },
				),
			WAIT,
		)
		return { task, run }
	}
	return { provider, registry, seed, restore }
}

const createAction: PendingTaskAction = {
	kind: "create_subtask",
	actionId: "call_pending_create",
	approvalText: JSON.stringify({ tool: "newTask", mode: "code", content: "child work" }),
	mode: "code",
	message: "child work",
	todos: [],
}
const finishAction: PendingTaskAction = {
	kind: "finish_subtask",
	actionId: "call_pending_finish",
	approvalText: JSON.stringify({ tool: "finishTask", content: "child result" }),
	parentTaskId: "parent",
	result: "child result",
}

describe("Case 19 gap (a): a restored task waits for the user under its start exclusion", () => {
	it("an unanswered restored approval does not hold the task lease (top-level task)", async () => {
		const f = fixture()
		await f.seed(record("parent"), createAction)
		await f.restore("parent")

		// Another async context (webview handler, scheduler, eviction) asks for the same lease.
		expect(await probeFence("parent")).toBe("free")
	})

	it("an unanswered restored child approval holds neither the child nor the parent lease", async () => {
		const f = fixture()
		await store.upsert(
			record("parent", {
				status: "delegated",
				delegatedToId: "child",
				awaitingChildId: "child",
				childIds: ["child"],
			}),
		)
		await f.seed(record("child", { parentTaskId: "parent", rootTaskId: "parent" }), finishAction)
		await f.restore("child")

		expect({ child: await probeFence("child"), parent: await probeFence("parent") }).toEqual({
			child: "free",
			parent: "free",
		})
	})

	it("a save of the same task from another async context succeeds while the restored approval is unanswered", async () => {
		const f = fixture()
		await f.seed(record("parent"), createAction)
		const { task } = await f.restore("parent")

		// Stands for a webview-handler save, e.g. MessageManager rewind (overwriteClineMessages)
		// or the fire-and-forget save in handleWebviewAskResponse("yesButtonClicked").
		const save = await outcome(task["saveClineMessages"]())

		expect({ save, refused: task["persistenceAuthority"].refused }).toEqual({
			save: { ok: true },
			refused: false,
		})
	})

	it("the user can leave the task (eviction) while the restored approval is unanswered", async () => {
		const f = fixture()
		await f.seed(record("parent"), createAction)
		const { task, run } = await f.restore("parent")
		// Wait until the presentation phase has released the lease. Eviction during the presentation
		// itself (its save and state post) remains a known short window: gap (c), delay-only.
		await vi.waitFor(async () => expect(await probeFence("parent")).toBe("free"), WAIT)

		// createTaskWithHistoryItem/createTask -> evictCurrentTask when the user opens another task.
		const evicted = await outcome(f.provider.evictCurrentTask())

		expect({ evicted, current: f.registry.current?.taskId, aborted: task.abort }).toEqual({
			evicted: { ok: true },
			current: undefined,
			aborted: true,
		})
		await run
	})

	it("after the user denies the restored approval, the agent loop does not run under the start exclusion", async () => {
		const f = fixture()
		await f.seed(record("parent"), createAction)
		const { task } = await f.restore("parent")
		const turn = signal()
		gates.push(turn)
		const entered = signal()
		vi.spyOn(task, "recursivelyMakeClineRequests").mockImplementation(async () => {
			entered.release()
			// A long model turn (streaming, tools, further approvals).
			await turn.promise
			return true
		})

		task.denyAsk()
		await entered.promise
		const during = {
			fence: await probeFence("parent"),
			save: await outcome(task["saveClineMessages"]()),
		}
		turn.release()

		expect(during).toEqual({ fence: "free", save: { ok: true } })
	})

	it("a save started by a callback from the denied-approval loop after that loop ends is not refused", async () => {
		const f = fixture()
		await f.seed(record("parent"), createAction)
		const { task, run } = await f.restore("parent")
		const loopEnded = signal()
		gates.push(loopEnded)
		let late!: Promise<Outcome>
		vi.spyOn(task, "recursivelyMakeClineRequests").mockImplementation(async () => {
			// Created inside the turn, settles later: the background usage drain
			// (drainStreamInBackgroundToFindAllUsage) or the deferred usage-save retry timer.
			late = track(loopEnded.promise.then(() => outcome(task["saveClineMessages"]())))
			return true
		})

		task.denyAsk()
		expect(await run).toEqual({ ok: true })
		loopEnded.release()

		expect({ late: await late, refused: task["persistenceAuthority"].refused }).toEqual({
			late: { ok: true },
			refused: false,
		})
	})

	it("an unanswered generic Resume Task ask of a restored task does not hold the task lease", async () => {
		const f = fixture()
		await f.seed(record("parent"))
		await f.restore("parent")

		expect(await probeFence("parent")).toBe("free")
	})

	it("control: the ordinary start path runs the agent loop after releasing the start exclusion", async () => {
		const f = fixture()
		const task = new Task({
			provider: f.provider,
			apiConfiguration: {},
			taskId: "fresh",
			task: "offline root",
			startTask: false,
			enableCheckpoints: false,
		})
		tasks.push(task)
		await task.waitForModeInitialization()
		await task.waitForApiConfigInitialization()
		task["startIdleTelemetryCheck"] = vi.fn()
		f.registry.push(task)
		const turn = signal()
		gates.push(turn)
		const entered = signal()
		vi.spyOn(task, "recursivelyMakeClineRequests").mockImplementation(async () => {
			entered.release()
			await turn.promise
			return true
		})

		void outcome(task.runScheduled())
		await entered.promise
		const during = await probeFence("fresh")
		turn.release()

		expect(during).toBe("free")
	})

	it("an owned follow-up question asked in the denied-approval loop is presented, not refused", async () => {
		const f = fixture()
		await f.seed(record("parent"), createAction)
		const { task } = await f.restore("parent")
		const asked = signal()
		let question: Outcome | "waiting" | undefined
		vi.spyOn(task, "recursivelyMakeClineRequests").mockImplementation(async () => {
			// The turn's assistant message (with the ask_followup_question tool_use) was saved,
			// as presentAssistantMessage guarantees before a tool runs.
			task["resolveAssistantMessagePersistence"](true)
			// AskFollowupQuestionTool: registerQuestion, then ask("followup").
			if (!(await task.registerQuestion("Which option?", "call_question"))) {
				question = { ok: false, error: "registerQuestion refused" }
			} else {
				const wait = outcome(task.ask("followup", "Which option?", false))
				question = await Promise.race([
					wait,
					new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 500)),
				])
			}
			asked.release()
			return true
		})

		task.denyAsk()
		await asked.promise

		// A presented question waits for its answer; a refused one rejects at once and
		// the tool swallows the error because pendingQuestion is set (silent hang).
		expect(question).toBe("waiting")
	})
})
