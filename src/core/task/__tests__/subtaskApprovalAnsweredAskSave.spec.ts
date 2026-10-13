// Regression: an approved new_task handoff is refused by the approval's own answered-ask save.
//
// Task.handleWebviewAskResponse("yesButtonClicked") marks the last unanswered tool ask answered and
// starts an UN-AWAITED saveClineMessages(), which holds the parent's handoff fence (bounded
// persistence acquire). The ask waiter returns as soon as askResponse is set, NewTaskTool only
// awaits the assistant-turn save, and ClineProvider.delegateParentAndOpenChild acquires the same
// fence with zero wait. If the answered-ask save still holds it, the handoff is refused with
// ParentHandoffFenceUnavailableError (timeout).
//
// Real Task, presenter, NewTaskTool, provider transition, TaskHistoryStore and fence on a temp dir.
// The answered-ask save is held deterministically at saveTaskMessages and released by NewTaskTool's
// waitForAnsweredAskPersistence() call (the fix) or, without the fix, by the zero-wait handoff
// acquire that it then races. Liveness timers only keep a broken variant from hanging; every
// holdAnsweredAskSave test asserts which of those released the save, so a timer never decides a pass.
import { AsyncLocalStorage } from "async_hooks"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { TelemetryService } from "@roo-code/telemetry"
import type { ClineMessage } from "@roo-code/types"
import { Task } from "../Task"
import { TaskScheduler } from "../TaskScheduler"
import { TaskRegistry } from "../TaskRegistry"
import { TaskHistoryStore } from "../../task-persistence/TaskHistoryStore"
import { ParentHandoffFence } from "../../task-persistence/parentHandoffFence"
import { ClineProvider } from "../../webview/ClineProvider"
import * as assistantMessage from "../../assistant-message"

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

/** Liveness only: bounds a zero-wait acquire waiting for an in-flight save to reach its hold. */
const LIVENESS_FALLBACK_MS = 3_000
const WAIT = { timeout: 10_000, interval: 25 }
/**
 * Liveness only: ends a variant in which nothing releases the held save. Longer than every WAIT
 * budget, so a correct but slow run reaches NewTaskTool's wait (or fails a WAIT) first; shorter than
 * the 20 s vitest testTimeout. `releasedBy()` is asserted, so this timer never decides a pass.
 */
const HOLD_LIVENESS_MS = 15_000

function signal() {
	let release!: () => void
	const promise = new Promise<void>((resolve) => {
		release = resolve
	})
	return { promise, release }
}
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const pending = new Set<Promise<unknown>>()
function track<T>(promise: Promise<T>): Promise<T> {
	pending.add(promise)
	const settle = () => pending.delete(promise)
	void promise.then(settle, settle)
	return promise
}
type Outcome = { ok: true } | { ok: false; error: string }
const outcome = (promise: Promise<unknown>): Promise<Outcome> =>
	promise.then(
		() => ({ ok: true as const }),
		(error: Error) => ({ ok: false as const, error: `${error.name}: ${error.message}` }),
	)
const leaseIsFree = (id: string) =>
	new ParentHandoffFence(root).acquire(id, { timeoutMs: 0 }).then(
		async (lease) => {
			await lease.release()
			return true
		},
		() => false,
	)

let root: string
let store: TaskHistoryStore
const tasks: Task[] = []
const gates: ReturnType<typeof signal>[] = []
const timers: ReturnType<typeof setTimeout>[] = []
beforeEach(async () => {
	if (!TelemetryService.hasInstance()) TelemetryService.createInstance([])
	root = await fs.mkdtemp(path.join(os.tmpdir(), "subtask-approval-answered-save-"))
	store = new TaskHistoryStore(root)
	await store.initialize()
})
afterEach(async () => {
	timers.splice(0).forEach(clearTimeout)
	gates.splice(0).forEach((gate) => gate.release())
	for (const task of tasks) {
		task.abort = true
		task["cancelAssistantMessagePersistence"]()
	}
	// Every scheduler run is tracked, including the child run that delegateParentAndOpenChild
	// enqueues through scheduleTask (a detached `void scheduler.schedule(...)`). That run is
	// admitted only after the parent run releases the permit, so after a test body ends it can
	// still hold fresh parent and child start-exclusion leases (Task.runScheduled ->
	// withStartExclusion) under `.handoff-fences`; removing the root under it fails with
	// ENOTEMPTY. The detached presenter (presentAssistantMessageSafe) is tracked too. Drain until
	// quiescent: a settling run can enqueue further tracked work.
	while (pending.size > 0) await Promise.allSettled([...pending])
	// Un-awaited answered-ask saves (handleWebviewAskResponse) hold their task's fence lease.
	await Promise.all(tasks.map((task) => task.waitForAnsweredAskPersistence()))
	for (const task of tasks.splice(0)) {
		await task.dispose().catch(() => {})
		task["debouncedEmitTokenUsage"].cancel()
	}
	store.dispose()
	vi.restoreAllMocks()
	await fs.rm(root, { recursive: true, force: true })
})

/** Same provider shell as ordinaryDelegationComposition.spec.ts; only auto-approval differs. */
async function fixture(autoApproveSubtasks: boolean) {
	const registry = new TaskRegistry()
	const scheduler = new TaskScheduler(1)
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
			autoApprovalEnabled: autoApproveSubtasks,
			alwaysAllowSubtasks: autoApproveSubtasks,
		}),
		providerSettingsManager: { getModeConfigId: async () => undefined },
		log: vi.fn(),
		postStateToWebviewWithoutTaskHistory: vi.fn(async () => {}),
		postStateToWebviewThrottled: vi.fn(async () => {}),
		flushPostStateToWebviewThrottled: vi.fn(async () => {}),
		postMessageToWebview: vi.fn(async () => {}),
		handleModeSwitch: vi.fn(async () => {}),
		emit: vi.fn(),
		taskScheduler: scheduler,
	})
	// Track every run (parent and child) and every detached presenter pass, so cleanup can drain
	// them before removing the temp root.
	const schedule = scheduler.schedule.bind(scheduler)
	vi.spyOn(scheduler, "schedule").mockImplementation((task, run, observe) => track(schedule(task, run, observe)))
	const present = assistantMessage.presentAssistantMessage
	vi.spyOn(assistantMessage, "presentAssistantMessage").mockImplementation((task) => track(present(task)))
	const delegate = provider.delegateParentAndOpenChild.bind(provider)
	vi.spyOn(provider, "delegateParentAndOpenChild").mockImplementation((params) => {
		const result = track(delegate(params))
		transitions.push(result)
		return result
	})
	async function instance(id: string, parentTask?: Task) {
		const task = new Task({
			provider,
			apiConfiguration: {},
			taskId: id,
			task: "offline root",
			parentTask,
			rootTask: parentTask,
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
		const child = await instance("child", parentTask)
		vi.spyOn(child, "recursivelyMakeClineRequests").mockResolvedValue(true)
		return child
	})
	const parent = await instance("parent")
	return { provider, parent, scheduler, transitions }
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

/** The assistant turn that calls new_task, presented by the real presenter and NewTaskTool. */
async function newTaskTurn(task: Task) {
	const input = { mode: "code", message: "offline child", todos: "" }
	task["resetAssistantMessagePersistence"]()
	// Awaited, so the assistant-turn save NewTaskTool waits for is already durable.
	await task["addToApiConversationHistory"]({
		role: "assistant",
		content: [{ type: "tool_use", id: "call", name: "new_task", input }],
	})
	task.assistantMessageContent = [
		{ type: "tool_use", name: "new_task", id: "call", params: {}, nativeArgs: input, partial: false },
	]
	task.currentStreamingContentIndex = 0
	task.didCompleteReadingStream = true
	task["presentAssistantMessageSafe"]()
}

type SaveRelease = "answered-ask wait" | "zero-wait acquire" | "bounded acquire" | "liveness"

/**
 * Holds the first parent ui-message save whose snapshot satisfies `isAnsweredAskSave` inside its
 * fence scope. Only NewTaskTool's `waitForAnsweredAskPersistence()` call (the fix) releases it before
 * the handoff; without that wait, the zero-wait handoff acquire runs while it is held and releases it
 * afterwards. `releasedBy()` reports which happened first, so the result never depends on timing.
 *
 * Only a save running in the async context of the approval's own `saveClineMessages()` call is held.
 * The snapshot predicate alone is not enough: the ask-presentation save (addToClineMessages) can
 * still be pending at the click, and its later snapshot also shows the ask answered. Holding that
 * save would block askApproval itself, so NewTaskTool could never reach its wait.
 *
 * Zero-wait acquires are intercepted only while a save started by `handleWebviewAskResponse` is in
 * flight. Earlier zero-wait acquires (e.g. the run's own provider start exclusion) are not the
 * handoff and must neither be delayed nor release the hold.
 * Also records when every save started by `handleWebviewAskResponse` settles and when each zero-wait
 * parent acquire starts, for ordering assertions.
 */
async function holdAnsweredAskSave(task: Task, isAnsweredAskSave: (messages: ClineMessage[]) => boolean) {
	const atGate = signal(),
		releaseSave = signal()
	gates.push(atGate, releaseSave)
	let releasedBy: SaveRelease | undefined
	const release = (by: SaveRelease) => {
		releasedBy ??= by
		releaseSave.release()
	}
	let armed = true
	let held = false
	let reachedHold = false
	let answeredAskSavesInFlight = 0
	const answeredAskSaveContext = new AsyncLocalStorage<true>()
	const taskMessages = await import("../../task-persistence/taskMessages")
	const save = taskMessages.saveTaskMessages
	vi.spyOn(taskMessages, "saveTaskMessages").mockImplementation(async (options) => {
		if (
			armed &&
			answeredAskSaveContext.getStore() === true &&
			options.taskId === task.taskId &&
			isAnsweredAskSave(options.messages)
		) {
			armed = false
			held = true
			reachedHold = true
			atGate.release()
			timers.push(setTimeout(() => release("liveness"), HOLD_LIVENESS_MS))
			await releaseSave.promise
			held = false
		}
		return save(options)
	})
	const zeroWaitAcquire = vi.fn()
	const acquire = ParentHandoffFence.prototype.acquire
	vi.spyOn(ParentHandoffFence.prototype, "acquire").mockImplementation(async function (
		this: ParentHandoffFence,
		id,
		options,
	) {
		const timeoutMs = options?.timeoutMs ?? 1_000
		if (id === task.taskId && timeoutMs === 0) zeroWaitAcquire()
		if (id !== task.taskId || answeredAskSavesInFlight === 0 || (!armed && !held))
			return acquire.call(this, id, options)
		if (timeoutMs !== 0) {
			// A bounded acquire (e.g. the save's own persistence lease) is not the handoff under test;
			// once the save is held, a bounded acquire can wait for it, so let the save finish.
			if (held) release("bounded acquire")
			return acquire.call(this, id, options)
		}
		// A zero-wait acquire while the answered-ask save is in flight: make it run while that save
		// holds the fence, which is exactly the unfixed handoff. The delay is liveness only.
		await Promise.race([atGate.promise, delay(LIVENESS_FALLBACK_MS)])
		try {
			return await acquire.call(this, id, options)
		} finally {
			release("zero-wait acquire")
		}
	})
	// The fix under test: NewTaskTool awaits this before the handoff. Call through after releasing.
	const wait = task.waitForAnsweredAskPersistence.bind(task)
	vi.spyOn(task, "waitForAnsweredAskPersistence").mockImplementation(() => {
		release("answered-ask wait")
		return wait()
	})
	// Observe the exact saves the approval starts (synchronously inside handleWebviewAskResponse).
	const answeredAskSaveStarted = vi.fn()
	const answeredAskSaveSettled = vi.fn()
	let answering = false
	const saveMessages = task["saveClineMessages"].bind(task)
	task["saveClineMessages"] = (merge?: boolean) => {
		if (!answering) return saveMessages(merge)
		answeredAskSavesInFlight++
		answeredAskSaveStarted()
		const saved = answeredAskSaveContext.run(true, () => saveMessages(merge))
		const settle = () => {
			answeredAskSavesInFlight--
			answeredAskSaveSettled()
		}
		void saved.then(settle, settle)
		return saved
	}
	const respond = task.handleWebviewAskResponse.bind(task)
	vi.spyOn(task, "handleWebviewAskResponse").mockImplementation((...args) => {
		answering = true
		try {
			return respond(...args)
		} finally {
			answering = false
		}
	})
	return {
		atGate,
		zeroWaitAcquire,
		answeredAskSaveStarted,
		answeredAskSaveSettled,
		reachedHold: () => reachedHold,
		releasedBy: () => releasedBy,
	}
}

/**
 * The approval's own answered-ask save reached the hold, was released by NewTaskTool's wait (not by
 * the handoff racing it, a bounded acquire, or a liveness timer) and settled before the handoff's
 * zero-wait acquire.
 */
function expectHandoffAfterAnsweredAskSave(
	provider: ClineProvider,
	hold: Awaited<ReturnType<typeof holdAnsweredAskSave>>,
) {
	expect(hold.reachedHold()).toBe(true)
	expect(hold.releasedBy()).toBe("answered-ask wait")
	const started = hold.answeredAskSaveStarted.mock.calls.length
	expect(started).toBeGreaterThan(0)
	expect(hold.answeredAskSaveSettled).toHaveBeenCalledTimes(started)
	const delegated = vi.mocked(provider.delegateParentAndOpenChild).mock.invocationCallOrder[0]
	// The first zero-wait parent acquire after delegation began is the handoff's.
	const handoffAcquire = hold.zeroWaitAcquire.mock.invocationCallOrder.find((order) => order > delegated)
	expect(handoffAcquire).toBeDefined()
	const lastSettled = Math.max(...hold.answeredAskSaveSettled.mock.invocationCallOrder)
	expect(lastSettled).toBeLessThan(delegated)
	expect(lastSettled).toBeLessThan(handoffAcquire ?? -1)
}

const isNewTaskAsk = (message: ClineMessage) =>
	message.type === "ask" && message.ask === "tool" && (message.text ?? "").includes('"tool":"newTask"')

describe("new_task approval vs the approval's own answered-ask save", () => {
	it("a manual Approve click delegates even while its answered-ask save holds the parent fence", async () => {
		const f = await fixture(false)
		vi.spyOn(f.parent, "recursivelyMakeClineRequests").mockImplementation(async () => {
			await newTaskTurn(f.parent)
			await vi.waitFor(() => expect(f.parent.abort).toBe(true), WAIT)
			return true
		})
		// The ask is visible in clineMessages before its presentation save runs. If the click lands while
		// that save waits for the fence, holding the answered-ask save would block askApproval (which
		// awaits the presentation save) instead of the handoff. Click only after it has settled.
		let approvalAskPersisted = false
		const addToClineMessages = f.parent["addToClineMessages"].bind(f.parent)
		f.parent["addToClineMessages"] = async (message: ClineMessage) => {
			await addToClineMessages(message)
			if (isNewTaskAsk(message)) approvalAskPersisted = true
		}
		const run = f.scheduler.schedule(f.parent)
		// The approval is on screen, unanswered and persisted, and nothing holds the parent fence.
		await vi.waitFor(() => {
			const last = f.parent.clineMessages.at(-1)
			expect(last && isNewTaskAsk(last) && last.isAnswered !== true).toBe(true)
			expect(approvalAskPersisted).toBe(true)
		}, WAIT)
		await vi.waitFor(async () => expect(await leaseIsFree("parent")).toBe(true), WAIT)
		const hold = await holdAnsweredAskSave(f.parent, (messages) =>
			messages.some((message) => isNewTaskAsk(message) && message.isAnswered === true),
		)

		// What webviewMessageHandler "askResponse" does for the Approve button.
		f.parent.handleWebviewAskResponse("yesButtonClicked", undefined, undefined, { taskId: "parent" })
		expect(hold.answeredAskSaveStarted).toHaveBeenCalledOnce() // Started synchronously by the click.

		await hold.atGate.promise
		await vi.waitFor(() => expect(f.transitions.length).toBe(1), WAIT)
		const transition = await outcome(f.transitions[0])
		expect({ transition, failures: failures(f.provider) }).toEqual({ transition: { ok: true }, failures: [] })
		expectHandoffAfterAnsweredAskSave(f.provider, hold)
		await vi.waitFor(() => expect(f.parent.abort).toBe(true), WAIT)
		await run
		expect(f.provider.createTask).toHaveBeenCalledOnce()
		expect(await store.readAuthoritative("parent")).toMatchObject({
			kind: "found",
			item: { status: "delegated", awaitingChildId: "child", delegatedToId: "child" },
		})
	})

	// Decision: isAnswered is UI state, not delegation state. A failed answered-ask save is logged
	// only; the handoff waits for it to settle and then proceeds.
	it.each(["resolves false", "rejects"] as const)(
		"a manual Approve click delegates after its answered-ask save %s",
		async (failure) => {
			const f = await fixture(false)
			vi.spyOn(f.parent, "recursivelyMakeClineRequests").mockImplementation(async () => {
				await newTaskTurn(f.parent)
				await vi.waitFor(() => expect(f.parent.abort).toBe(true), WAIT)
				return true
			})
			const run = f.scheduler.schedule(f.parent)
			await vi.waitFor(() => {
				const last = f.parent.clineMessages.at(-1)
				expect(last && isNewTaskAsk(last) && last.isAnswered !== true).toBe(true)
			}, WAIT)

			// The answered-ask save is held until NewTaskTool waits for it, then fails.
			const releaseSave = signal()
			gates.push(releaseSave)
			const saveSettled = vi.fn()
			const errors = vi.spyOn(console, "error").mockImplementation(() => {})
			const save = f.parent["saveClineMessages"].bind(f.parent)
			let armed = true
			f.parent["saveClineMessages"] = async (merge?: boolean) => {
				if (!armed) return save(merge)
				armed = false
				await releaseSave.promise
				saveSettled()
				if (failure === "rejects") throw new Error("answered-ask save failed")
				return false
			}
			const wait = f.parent.waitForAnsweredAskPersistence.bind(f.parent)
			vi.spyOn(f.parent, "waitForAnsweredAskPersistence").mockImplementation(() => {
				releaseSave.release()
				return wait()
			})

			f.parent.handleWebviewAskResponse("yesButtonClicked", undefined, undefined, { taskId: "parent" })
			expect(armed).toBe(false) // The click started the answered-ask save synchronously.

			await vi.waitFor(() => expect(f.transitions.length).toBe(1), WAIT)
			const transition = await outcome(f.transitions[0])
			expect({ transition, failures: failures(f.provider) }).toEqual({ transition: { ok: true }, failures: [] })
			expect(saveSettled.mock.invocationCallOrder[0]).toBeLessThan(
				vi.mocked(f.provider.delegateParentAndOpenChild).mock.invocationCallOrder[0],
			)
			expect(errors.mock.calls.some(([message]) => message === "Failed to save answered tool-ask state:")).toBe(
				failure === "rejects",
			)
			await vi.waitFor(() => expect(f.parent.abort).toBe(true), WAIT)
			await run
			expect(f.provider.createTask).toHaveBeenCalledOnce()
			expect(await store.readAuthoritative("parent")).toMatchObject({
				kind: "found",
				item: { status: "delegated", awaitingChildId: "child", delegatedToId: "child" },
			})
		},
	)

	it("an auto-approved new_task delegates even when approveAsk saves a stale unanswered tool ask", async () => {
		const f = await fixture(true)
		const staleTs = Date.now() - 60_000
		const hold = await holdAnsweredAskSave(f.parent, (messages) =>
			messages.some((message) => message.ts === staleTs && message.isAnswered === true),
		)
		vi.spyOn(f.parent, "recursivelyMakeClineRequests").mockImplementation(async () => {
			// An earlier tool ask that was denied: noButtonClicked never sets isAnswered.
			f.parent.clineMessages.push({
				ts: staleTs,
				type: "ask",
				ask: "tool",
				text: JSON.stringify({ tool: "readFile", path: "a.txt" }),
			})
			await newTaskTurn(f.parent)
			await vi.waitFor(() => expect(f.parent.abort).toBe(true), WAIT)
			return true
		})
		const run = f.scheduler.schedule(f.parent)

		await vi.waitFor(() => expect(f.transitions.length).toBe(1), WAIT)
		const transition = await outcome(f.transitions[0])
		expect({ transition, failures: failures(f.provider) }).toEqual({ transition: { ok: true }, failures: [] })
		expectHandoffAfterAnsweredAskSave(f.provider, hold)
		await vi.waitFor(() => expect(f.parent.abort).toBe(true), WAIT)
		await run
		expect(f.provider.createTask).toHaveBeenCalledOnce()
	})
})
