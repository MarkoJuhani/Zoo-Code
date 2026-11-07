// Regression: a resumed orchestrator's new_task handoff is refused by the turn's own background
// usage save.
//
// Field evidence (2026-11-05 20:10:12, parent 01a1acce, correlation 815c0c81): after a child
// completed, reopenParentFromDelegation re-instantiated the parent and resumed it. Its next native
// turn called new_task; approval ended, NewTaskTool's two pre-handoff waits resolved within 1 ms,
// and the zero-wait handoff acquire failed 3 ms later with
// "Parent handoff fence is unavailable for <parent> (timeout)" (fence_acquire:authority_refused).
//
// Mechanism under test: at stream end Task.recursivelyMakeClineRequests launches
// drainStreamInBackgroundToFindAllUsage un-awaited. Its captureUsageData calls saveClineMessages,
// an ordinary persistence write that takes the parent's handoff fence with a bounded (polling,
// non-FIFO) wait. NewTaskTool only awaits the assistant-turn api-history save
// (waitForCurrentAssistantMessagePersistence) and the approval's answered-ask save
// (waitForAnsweredAskPersistence). Nothing awaits the usage save, so when its poll wins the fence
// after those saves and before ClineProvider.delegateParentAndOpenChild's zero-wait acquire, the
// handoff is refused.
//
// Real Task, request loop, background usage drain, presenter, NewTaskTool, provider transition,
// TaskHistoryStore and fence on a temp dir. The drain's save is started at its natural time; only
// its fence acquisition is gated until the handoff begins (the starved-poller interleaving), and it
// is then held inside the fence until the handoff's acquire has run. Liveness timers only keep a
// fixed variant from hanging; reachedHold is asserted so the scenario cannot pass vacuously.
import { AsyncLocalStorage } from "async_hooks"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { TelemetryService } from "@roo-code/telemetry"
import type { HistoryItem } from "@roo-code/types"
import { Task } from "../Task"
import { TaskScheduler } from "../TaskScheduler"
import { TaskRegistry } from "../TaskRegistry"
import { TaskHistoryStore } from "../../task-persistence/TaskHistoryStore"
import { ParentHandoffFence } from "../../task-persistence/parentHandoffFence"
import { ClineProvider } from "../../webview/ClineProvider"
import * as environmentDetails from "../../environment/getEnvironmentDetails"

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

/** Production bounded waits are 30 s; compressed so a blocked variant ends inside the test timeout. */
const COMPRESSED_FENCE_WAIT_MS = 5_000
/** Liveness only (shorter than the compressed bound): ends a variant in which nothing opens a gate. */
const LIVENESS_MS = 2_500
const WAIT = { timeout: 10_000, interval: 25 }

function signal() {
	let release!: () => void
	const promise = new Promise<void>((resolve) => {
		release = resolve
	})
	return { promise, release }
}
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
type Outcome = { ok: true } | { ok: false; error: string }
const outcome = (promise: Promise<unknown>): Promise<Outcome> =>
	promise.then(
		() => ({ ok: true as const }),
		(error: Error) => ({ ok: false as const, error: `${error.name}: ${error.message}` }),
	)

let root: string
let store: TaskHistoryStore
const tasks: Task[] = []
const gates: ReturnType<typeof signal>[] = []
const timers: ReturnType<typeof setTimeout>[] = []
const pending = new Set<Promise<unknown>>()
function track<T>(promise: Promise<T>): Promise<T> {
	pending.add(promise)
	const settle = () => pending.delete(promise)
	void promise.then(settle, settle)
	return promise
}

/** Async context of the background usage drain's own saveClineMessages call. */
const drainSave = new AsyncLocalStorage<true>()
type HoldRelease = "zero-wait handoff acquire" | "bounded handoff acquire" | "liveness"
const hold = {
	armed: false,
	drainSaveCalled: false,
	handoffStarted: false,
	handoffAcquireSeen: false,
	reachedHold: false,
	releasedBy: undefined as HoldRelease | undefined,
	openAcquire: signal(),
	atHold: signal(),
	releaseSave: signal(),
}
function releaseHold(by: HoldRelease) {
	hold.releasedBy ??= by
	hold.releaseSave.release()
}

beforeEach(async () => {
	if (!TelemetryService.hasInstance()) TelemetryService.createInstance([])
	root = await fs.mkdtemp(path.join(os.tmpdir(), "delegation-usage-save-fence-"))
	store = new TaskHistoryStore(root)
	await store.initialize()
	Object.assign(hold, {
		armed: false,
		drainSaveCalled: false,
		handoffStarted: false,
		handoffAcquireSeen: false,
		reachedHold: false,
		releasedBy: undefined,
		openAcquire: signal(),
		atHold: signal(),
		releaseSave: signal(),
	})
	gates.push(hold.openAcquire, hold.atHold, hold.releaseSave)

	const acquire = ParentHandoffFence.prototype.acquire
	vi.spyOn(ParentHandoffFence.prototype, "acquire").mockImplementation(async function (
		this: ParentHandoffFence,
		id,
		options = {},
	) {
		const compressed = {
			...options,
			timeoutMs: options.timeoutMs ? Math.min(options.timeoutMs, COMPRESSED_FENCE_WAIT_MS) : options.timeoutMs,
		}
		if (!hold.armed || id !== "parent") return acquire.call(this, id, compressed)
		if (drainSave.getStore() === true) {
			// The drain save is in flight from stream end, but its poll only wins the fence after the
			// assistant-turn and answered-ask saves, i.e. once the handoff has begun.
			await Promise.race([hold.openAcquire.promise, delay(LIVENESS_MS)])
			return acquire.call(this, id, compressed)
		}
		if (!hold.handoffStarted || hold.handoffAcquireSeen) return acquire.call(this, id, compressed)
		// The first parent acquire after delegateParentAndOpenChild began is the handoff's.
		hold.handoffAcquireSeen = true
		hold.openAcquire.release()
		await Promise.race([hold.atHold.promise, delay(LIVENESS_MS)])
		if (compressed.timeoutMs) {
			// A bounded handoff can wait for the in-flight save; let it finish.
			releaseHold("bounded handoff acquire")
			return acquire.call(this, id, compressed)
		}
		try {
			return await acquire.call(this, id, compressed)
		} finally {
			releaseHold("zero-wait handoff acquire")
		}
	})
	const taskMessages = await import("../../task-persistence/taskMessages")
	const saveTaskMessages = taskMessages.saveTaskMessages
	vi.spyOn(taskMessages, "saveTaskMessages").mockImplementation(async (options) => {
		if (drainSave.getStore() === true && options.taskId === "parent" && !hold.reachedHold) {
			// Inside the drain save's fence scope: hold it while the handoff acquires.
			hold.reachedHold = true
			hold.atHold.release()
			timers.push(setTimeout(() => releaseHold("liveness"), LIVENESS_MS))
			await hold.releaseSave.promise
		}
		return saveTaskMessages(options)
	})
})
afterEach(async () => {
	timers.splice(0).forEach(clearTimeout)
	gates.splice(0).forEach((gate) => gate.release())
	for (const task of tasks) {
		task.abort = true
		task["cancelAssistantMessagePersistence"]()
	}
	while (pending.size > 0) await Promise.allSettled([...pending])
	await Promise.all(tasks.map((task) => task.waitForAnsweredAskPersistence()))
	for (const task of tasks.splice(0)) {
		await task.dispose().catch(() => {})
		task["debouncedEmitTokenUsage"].cancel()
	}
	store.dispose()
	vi.restoreAllMocks()
	await fs.rm(root, { recursive: true, force: true })
})

/** Same provider shell as case19-webview-ack-under-fence.spec.ts, with an immediate renderer. */
async function fixture() {
	const registry = new TaskRegistry()
	const scheduler = new TaskScheduler(1)
	const stages: string[] = []
	const transitions: Promise<Task>[] = []
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
			autoApprovalEnabled: true,
			alwaysAllowSubtasks: true,
		}),
		providerSettingsManager: { getModeConfigId: async () => undefined },
		log: vi.fn(),
		isViewLaunched: true,
		postStateToWebviewWithoutTaskHistory: vi.fn(async () => {}),
		postStateToWebviewThrottled: vi.fn(async () => {}),
		flushPostStateToWebviewThrottled: vi.fn(async () => {}),
		postMessageToWebview: vi.fn(async () => {}),
		handleModeSwitch: vi.fn(async () => {}),
		emit: vi.fn(),
		taskScheduler: scheduler,
	})
	const originalSchedule = scheduler.schedule.bind(scheduler)
	vi.spyOn(scheduler, "schedule").mockImplementation((task, run, observe) =>
		track(
			originalSchedule(task, run, (stage, error) => {
				stages.push(`${task.taskId}:${stage}`)
				observe?.(stage, error)
			}),
		),
	)
	const delegate = provider.delegateParentAndOpenChild.bind(provider)
	vi.spyOn(provider, "delegateParentAndOpenChild").mockImplementation((params) => {
		if (hold.armed) hold.handoffStarted = true
		const result = track(delegate(params))
		transitions.push(result)
		return result
	})
	async function instance(id: string, parentTask?: Task, historyItem?: HistoryItem) {
		const task = new Task({
			provider,
			apiConfiguration: {},
			taskId: id,
			task: historyItem ? undefined : "offline root",
			parentTask,
			rootTask: parentTask,
			historyItem,
			startTask: false,
			enableCheckpoints: false,
		})
		tasks.push(task)
		await task.waitForModeInitialization()
		await task.waitForApiConfigInitialization()
		task["startIdleTelemetryCheck"] = vi.fn()
		registry.push(task)
		return task
	}
	provider.createTask = vi.fn(async (_message, _images, parentTask) => {
		const child = await instance(`child-${tasks.length}`, parentTask)
		vi.spyOn(child, "recursivelyMakeClineRequests").mockResolvedValue(true)
		return child
	})
	provider.createTaskWithHistoryItem = vi.fn(async (item) => instance(item.id, undefined, item))
	return { provider, stages, transitions, instance }
}

type Diagnostic = { phase: string; stage: string; failure?: { type: string } }
function failures(provider: ClineProvider): string[] {
	return vi
		.mocked(provider.log)
		.mock.calls.map(([message]) => message)
		.filter((message) => message.startsWith("[ordinary_delegation] "))
		.map((message) => JSON.parse(message.slice("[ordinary_delegation] ".length)) as Diagnostic)
		.filter((record) => record.stage === "failure")
		.map((record) => `${record.phase}:${record.failure?.type}`)
}

describe("new_task handoff vs the turn's own background usage save", () => {
	it("a resumed parent delegates even when the background usage save holds its fence at the handoff", async () => {
		vi.spyOn(environmentDetails, "getEnvironmentDetails").mockResolvedValue(
			"<environment_details>offline</environment_details>",
		)
		const f = await fixture()
		const parent = await f.instance("parent")
		await parent.say("text", "offline root")
		// First delegation and child completion, as before the field failure.
		await f.provider.delegateParentAndOpenChild({
			parentTaskId: "parent",
			message: "offline child",
			initialTodos: [],
			mode: "code",
		})
		await vi.waitFor(() => expect(f.stages).toContain("child-1:settled"), WAIT)
		vi.mocked(f.provider.createTask).mockClear()

		const create = vi.mocked(f.provider.createTaskWithHistoryItem).getMockImplementation()!
		vi.mocked(f.provider.createTaskWithHistoryItem).mockImplementation(async (...args) => {
			const task = await create(...args)
			vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
			// Offline model metadata; the real fetch needs provider settings outside this composition.
			task["safeEnsureModelFetched"] = async () => task.api.getModel().info
			// Identify the drain's call by its caller frame; every other save is untouched.
			const save = task["saveClineMessages"].bind(task)
			task["saveClineMessages"] = (merge?: boolean) => {
				if (hold.armed && !hold.drainSaveCalled && new Error().stack?.includes("captureUsageData")) {
					hold.drainSaveCalled = true
					return drainSave.run(true, () => save(merge))
				}
				return save(merge)
			}
			let calls = 0
			vi.spyOn(task, "attemptApiRequest").mockImplementation(async function* () {
				if (++calls > 1) {
					yield { type: "text", text: "done" }
					yield { type: "usage", inputTokens: 1, outputTokens: 1 }
					return
				}
				yield { type: "text", text: "I will delegate the next step." }
				yield { type: "tool_call_partial", index: 0, id: "call_usage", name: "new_task", arguments: "" }
				yield {
					type: "tool_call_partial",
					index: 0,
					id: undefined,
					name: undefined,
					arguments: JSON.stringify({ mode: "code", message: "next step", todos: "" }),
				}
				yield { type: "usage", inputTokens: 10, outputTokens: 5 }
			} as never)
			return task
		})
		hold.armed = true

		await f.provider.reopenParentFromDelegation({
			parentTaskId: "parent",
			childTaskId: "child-1",
			completionResultSummary: "child result",
		})
		await vi.waitFor(() => expect(f.transitions.length).toBe(2), WAIT)
		const transition = await outcome(f.transitions[1])

		expect({
			drainSaveCalled: hold.drainSaveCalled,
			reachedHold: hold.reachedHold,
			releasedBy: hold.releasedBy,
			transition,
			failures: failures(f.provider),
		}).toEqual({
			drainSaveCalled: true,
			reachedHold: true,
			// Which release fired is reported, never required: a fix may wait or retry.
			releasedBy: expect.any(String),
			transition: { ok: true },
			failures: [],
		})
		await vi.waitFor(() => expect(f.provider.createTask).toHaveBeenCalledOnce(), WAIT)
	})
})
