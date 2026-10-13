// Case 19 gap (a) fix: the window between a restored ask's presentation and its answer.
//
// resumeTaskFromHistory presents a restored approval under the start exclusion, waits for the
// user outside every scope, and applies the answer under a NEW bounded (fresh) exclusion after
// re-checking that the instance is live, its authority is not refused, the on-disk pending action
// is still the one shown, and the answer belongs to the shown ask. These tests drive that window
// with a real Task, TaskHistoryStore and fence; only the webview transport and the provider's
// delegation (the effect under test) are doubles.
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import type { MockInstance } from "vitest"
import { TelemetryService } from "@roo-code/telemetry"
import type { ClineMessage, HistoryItem, PendingTaskAction } from "@roo-code/types"
import { Task } from "../Task"
import { TaskRegistry } from "../TaskRegistry"
import { TaskHistoryStore } from "../../task-persistence/TaskHistoryStore"
import {
	ParentHandoffFence,
	ParentHandoffFenceUnavailableError,
	type ParentHandoffFenceLease,
} from "../../task-persistence/parentHandoffFence"
import { saveApiMessages, saveTaskMessages, type ApiMessage } from "../../task-persistence"
import {
	advanceOrdinaryPersistenceAuthority,
	OrdinaryPersistenceAuthorityError,
	withProviderStartExclusion,
} from "../../task-persistence/targetPersistenceBoundary"
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
 * Production waits 30 s for a fresh or persistence lease. The ordering is identical with a
 * compressed bound; it must exceed a few queued real-disk saves under parallel suite load.
 */
const COMPRESSED_FENCE_WAIT_MS = 5_000
/** Contention tests shorten the bound so the resolve phase's acquisition expires quickly. */
let fenceWaitMs = COMPRESSED_FENCE_WAIT_MS
const realAcquire = ParentHandoffFence.prototype.acquire
const compressed = (options: { timeoutMs?: number } = {}) => ({
	...options,
	timeoutMs: options.timeoutMs ? Math.min(options.timeoutMs, fenceWaitMs) : options.timeoutMs,
})
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
let acquireSpy: MockInstance<ParentHandoffFence["acquire"]>
const tasks: Task[] = []
const gates: ReturnType<typeof signal>[] = []
const leases: ParentHandoffFenceLease[] = []
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
/** Zero-wait probe: free only when no scope (presentation, save, resolve) holds the lease. */
const leaseIsFree = (id: string) =>
	new ParentHandoffFence(root).acquire(id, { timeoutMs: 0 }).then(
		async (lease) => {
			await lease.release()
			return true
		},
		() => false,
	)
/** Another async context holds the task lease (zero-wait, so only once it is free). */
async function holdLease(id: string): Promise<ParentHandoffFenceLease> {
	let lease: ParentHandoffFenceLease | undefined
	await vi.waitFor(async () => {
		lease = await new ParentHandoffFence(root).acquire(id, { timeoutMs: 0 })
	}, WAIT)
	leases.push(lease!)
	return lease!
}
const files = ["history_item.json", "ui_messages.json", "api_conversation_history.json"] as const
const bytes = (id: string, name: (typeof files)[number]) => fs.readFile(path.join(root, "tasks", id, name), "utf8")

beforeEach(async () => {
	if (!TelemetryService.hasInstance()) TelemetryService.createInstance([])
	root = await fs.mkdtemp(path.join(os.tmpdir(), "case19a-answer-window-"))
	store = new TaskHistoryStore(root)
	await store.initialize()
	fenceWaitMs = COMPRESSED_FENCE_WAIT_MS
	acquireSpy = vi.spyOn(ParentHandoffFence.prototype, "acquire").mockImplementation(function (
		this: ParentHandoffFence,
		id,
		options,
	) {
		return realAcquire.call(this, id, compressed(options))
	})
})
afterEach(async () => {
	gates.splice(0).forEach((gate) => gate.release())
	for (const lease of leases.splice(0)) await lease.release().catch(() => {})
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

type RestoreOptions = {
	/** create: a parent's restored subtask approval; finish: a child's; generic: no pending action. */
	kind?: "create" | "finish" | "generic"
	/** Disk status of the restored task, when it differs from the status the Task was built with. */
	diskStatus?: HistoryItem["status"]
	/** Runs before the restored task starts, e.g. to queue a message its presentation claims. */
	beforeRun?: (task: Task) => void
	/** Wait until the ask is presented and its scope released (false when the scope rejects). */
	presented?: boolean
}

/** Real Task, store, fence and ClineProvider eviction; webview transport and handoffs are doubles. */
async function restore({ kind = "create", diskStatus, beforeRun, presented = true }: RestoreOptions = {}) {
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
	// "subtask" sorts after "parent" ON PURPOSE: it avoids the known pre-existing lock-order defect
	// recorded under Case 19 in docs/architecture/task-lifecycle-model.md. withStartExclusion locks
	// parent then child, withPersistenceExclusions locks sorted ids; a child id sorting first lets the
	// yes-click's own save and the resolve phase's re-acquire deadlock until their bounded waits expire.
	const id = kind === "finish" ? "subtask" : "parent"
	const action = kind === "create" ? createAction : kind === "finish" ? finishAction : undefined
	const messages: ClineMessage[] = [
		{ ts: 1, type: "say", say: "text", text: id },
		...(action ? [{ ts: 2, type: "ask" as const, ask: "tool" as const, text: action.approvalText }] : []),
	]
	const api: ApiMessage[] = [
		{ ts: 1, role: "user", content: [{ type: "text", text: id }] },
		action
			? {
					ts: 2,
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: action.actionId,
							name: kind === "create" ? "new_task" : "attempt_completion",
							input: {},
						},
					],
				}
			: { ts: 2, role: "assistant", content: [{ type: "text", text: "done so far" }] },
	]
	if (kind === "finish")
		await store.upsert(
			record("parent", {
				status: "delegated",
				delegatedToId: "subtask",
				awaitingChildId: "subtask",
				childIds: ["subtask"],
			}),
		)
	const item = record(id, kind === "finish" ? { parentTaskId: "parent", rootTaskId: "parent" } : {})
	await store.upsert(action ? { ...item, pendingAction: action } : item)
	await saveTaskMessages({ messages, taskId: id, globalStoragePath: root })
	await saveApiMessages({ messages: api, taskId: id, globalStoragePath: root })

	const historyItem = store.get(id)!
	if (diskStatus)
		await atTask(id, () => store.atomicReadAndUpdate(id, (current) => ({ ...current, status: diskStatus })))
	const task = new Task({
		provider,
		apiConfiguration: {},
		historyItem,
		startTask: false,
		enableCheckpoints: false,
		initialStatus: historyItem.status,
	})
	tasks.push(task)
	// Clicks start un-awaited saves (handleWebviewAskResponse); cleanup awaits every one of them.
	// Private member; no public seam.
	const saves = task as unknown as { saveClineMessages: (merge?: boolean) => Promise<boolean> }
	const save = saves.saveClineMessages.bind(task)
	vi.spyOn(saves, "saveClineMessages").mockImplementation((merge) => track(save(merge)))
	await task.waitForModeInitialization()
	await task.waitForApiConfigInitialization()
	task["startIdleTelemetryCheck"] = vi.fn()
	registry.push(task)
	// The effects under test: the yes path's provider handoffs.
	const delegate = vi.spyOn(provider, "delegateParentAndOpenChild").mockImplementation(async () => task)
	const reopen = vi.spyOn(provider, "reopenParentFromDelegation").mockResolvedValue({
		kind: "committed",
		phase: "committed",
		resumeState: "queued",
		correlationId: "test",
	})
	const loop = vi.spyOn(task, "recursivelyMakeClineRequests").mockResolvedValue(true)
	beforeRun?.(task)
	const run = outcome(task.runScheduled())
	if (presented)
		await presentedAsk(task, action ? { ask: "tool", text: action.approvalText } : { ask: "resume_task" })
	return { provider, registry, task, run, delegate, reopen, loop, id }
}

const restoredApproval = () => restore()

/** Another context's write to a task's metadata, under that task's (and its parent's) exclusion. */
// Bounded (fresh), so a click's un-awaited save that still holds the lease delays it, not refuses it.
const atTask = <T>(id: string, effect: () => Promise<T>) =>
	id === "parent"
		? withProviderStartExclusion(root, "parent", effect, { fresh: true })
		: withProviderStartExclusion(
				root,
				"parent",
				() => withProviderStartExclusion(root, id, effect, { fresh: true }),
				{ fresh: true },
			)

/** The ask is on screen, unanswered, and the scope that presented it has released its leases. */
async function presentedAsk(task: Task, ask: Partial<ClineMessage>) {
	await vi.waitFor(
		() => expect(task.clineMessages.at(-1)).toMatchObject({ type: "ask", ...ask, isAnswered: undefined }),
		WAIT,
	)
	for (const id of task.parentTaskId ? [task.parentTaskId, task.taskId] : [task.taskId])
		await vi.waitFor(async () => expect(await leaseIsFree(id)).toBe(true), WAIT)
}

/** The wait has taken the click: the ask response was consumed by the waiter. */
const answerTaken = (task: Task) => vi.waitFor(() => expect(task["askResponse"]).toBeUndefined(), WAIT)

describe("Case 19 gap (a): between a restored ask's presentation and its answer", () => {
	it.each([
		["approval", (task: Task) => task.approveAsk()],
		["queued feedback", (task: Task) => void task.messageQueueService.addMessage("try another way")],
	])("a superseded pending action refuses the %s with no write and no delegation", async (_name, answer) => {
		const f = await restoredApproval()
		const superseding = { ...createAction, actionId: "call_newer_create" }
		await atTask("parent", () =>
			store.atomicReadAndUpdate("parent", (item) => ({ ...item, pendingAction: superseding })),
		)
		const api = await bytes("parent", "api_conversation_history.json")

		answer(f.task)

		expect(await f.run).toEqual({
			ok: false,
			error: "OrdinaryPersistenceAuthorityError: Ordinary persistence authority refused: Pending action ownership changed",
		})
		expect({
			delegated: f.delegate.mock.calls.length,
			loops: f.loop.mock.calls.length,
			feedback: f.task.clineMessages.filter((message) => message.say === "user_feedback").length,
			pendingAction: store.get("parent")?.pendingAction,
			apiUnchanged: (await bytes("parent", "api_conversation_history.json")) === api,
			// A refused answer releases its claimed queued message for a later owner.
			queued: f.task.messageQueueService.claimNextMessage()?.text,
			refused: f.task["persistenceAuthority"].refused,
		}).toEqual({
			delegated: 0,
			loops: 0,
			feedback: 0,
			pendingAction: superseding,
			apiUnchanged: true,
			queued: _name === "queued feedback" ? "try another way" : undefined,
			refused: true,
		})
	})

	it("an abandoned instance (advanced revision) refuses the approval with no write and no delegation", async () => {
		const f = await restoredApproval()
		await atTask("parent", () => store.atomicReadAndUpdate("parent", advanceOrdinaryPersistenceAuthority))
		const before = await Promise.all(files.map((name) => bytes("parent", name)))

		f.task.approveAsk()

		const result = await f.run
		expect({
			refusedRun: !result.ok && result.error.startsWith("OrdinaryPersistenceAuthorityError"),
			delegated: f.delegate.mock.calls.length,
			loops: f.loop.mock.calls.length,
			unchanged: (await Promise.all(files.map((name) => bytes("parent", name)))).map((b, i) => b === before[i]),
		}).toEqual({ refusedRun: true, delegated: 0, loops: 0, unchanged: [true, true, true] })
	})

	it("eviction during the wait aborts the waiter and nothing runs afterwards", async () => {
		const f = await restoredApproval()
		const api = await bytes("parent", "api_conversation_history.json")

		const evicted = await outcome(f.provider.evictCurrentTask())
		const run = await f.run
		// A click that arrives after eviction has no waiter and no resolve phase.
		f.task.approveAsk()
		f.task.denyAsk()

		expect({
			evicted,
			run,
			aborted: f.task.abort,
			current: f.registry.current?.taskId,
			delegated: f.delegate.mock.calls.length,
			loops: f.loop.mock.calls.length,
			pendingAction: store.get("parent")?.pendingAction?.actionId,
			apiUnchanged: (await bytes("parent", "api_conversation_history.json")) === api,
		}).toEqual({
			evicted: { ok: true },
			run: { ok: true },
			aborted: true,
			current: undefined,
			delegated: 0,
			loops: 0,
			pendingAction: createAction.actionId,
			apiUnchanged: true,
		})
	})

	it("an instance aborted after the click but before the resolve phase returns quietly with no effect", async () => {
		const f = await restoredApproval()
		// Another context holds the lease, so the resolve phase is still acquiring when abort lands.
		const holder = await holdLease("parent")
		const acquiresBefore = acquireSpy.mock.calls.length

		f.task.approveAsk()
		await answerTaken(f.task)
		await vi.waitFor(() => expect(acquireSpy.mock.calls.length).toBeGreaterThan(acquiresBefore), WAIT)
		const aborting = track(f.task.abortTask())
		await holder.release()
		await aborting

		expect({ run: await f.run, delegated: f.delegate.mock.calls.length, loops: f.loop.mock.calls.length }).toEqual({
			run: { ok: true },
			delegated: 0,
			loops: 0,
		})
	})

	it.each([
		["approval", "deny", (task: Task) => task.approveAsk(), (task: Task) => task.denyAsk()],
		["denial", "approve", (task: Task) => task.denyAsk(), (task: Task) => task.approveAsk()],
	])("the %s is applied once; a duplicate or late %s has no effect", async (first, _late, answer, lateAnswer) => {
		const f = await restoredApproval()
		const holder = await holdLease("parent")

		answer(f.task)
		await answerTaken(f.task)
		// Late answers while the resolve phase waits for the lease, then after it settled.
		answer(f.task)
		lateAnswer(f.task)
		await holder.release()
		const run = await f.run
		lateAnswer(f.task)
		answer(f.task)

		expect({ run, delegated: f.delegate.mock.calls.length, loops: f.loop.mock.calls.length }).toEqual({
			run: { ok: true },
			delegated: first === "approval" ? 1 : 0,
			loops: first === "approval" ? 0 : 1,
		})
		if (first === "approval")
			expect(f.delegate).toHaveBeenCalledWith(
				expect.objectContaining({ parentTaskId: "parent", pendingActionId: createAction.actionId }),
			)
		else
			expect(f.loop).toHaveBeenCalledWith(
				[
					expect.objectContaining({
						type: "tool_result",
						tool_use_id: createAction.actionId,
					}),
				],
				true,
			)
	})

	it("a yes-click whose own save holds the lease delays the resolve phase, which then succeeds", async () => {
		const f = await restoredApproval()
		const saveEntered = signal()
		const saveGate = signal()
		gates.push(saveGate)
		const upsert = store.upsert.bind(store)
		vi.spyOn(store, "upsert").mockImplementationOnce(async (item) => {
			// handleWebviewAskResponse("yesButtonClicked") -> un-awaited saveClineMessages, inside its lease.
			saveEntered.release()
			await saveGate.promise
			return upsert(item)
		})
		// Test-only ordering, not a delay: the resolve phase (the only fresh exclusion after the click)
		// starts acquiring once the click's own save holds the lease. Private member; no public seam.
		const access = f.task as unknown as {
			withStartExclusion: (effect: () => Promise<unknown>, fresh?: boolean) => Promise<unknown>
		}
		const start = access.withStartExclusion
		const resolveStarting = signal()
		vi.spyOn(access, "withStartExclusion").mockImplementation(async function (this: Task, effect, fresh) {
			if (fresh) {
				await saveEntered.promise
				resolveStarting.release()
			}
			return start.call(this, effect, fresh)
		})

		f.task.approveAsk()
		await resolveStarting.promise
		const acquiresBefore = acquireSpy.mock.calls.length
		// The resolve phase's own acquisition is in progress while the click's save holds the lease.
		await vi.waitFor(() => expect(acquireSpy.mock.calls.length).toBeGreaterThan(acquiresBefore), WAIT)
		const whileSaving = {
			leaseFree: await leaseIsFree("parent"),
			delegated: f.delegate.mock.calls.length,
		}
		saveGate.release()

		expect({
			whileSaving,
			run: await f.run,
			delegated: f.delegate.mock.calls.length,
			refused: f.task["persistenceAuthority"].refused,
			answeredOnDisk: JSON.parse(await bytes("parent", "ui_messages.json")).at(-1),
		}).toEqual({
			whileSaving: { leaseFree: false, delegated: 0 },
			run: { ok: true },
			delegated: 1,
			refused: false,
			answeredOnDisk: expect.objectContaining({ ask: "tool", isAnswered: true }),
		})
	})
})

describe("Case 19 gap (a): nested pending-action waits presented in a resolve phase", () => {
	const detached = { kind: "detached", phase: "precommit", reason: "ownership_moved" } as const
	const ownershipChanged =
		"OrdinaryPersistenceAuthorityError: Ordinary persistence authority refused: Pending action ownership changed"

	it.each([true, false])(
		"a detached finish handoff falls back to a completion ask; ownership kept=%s",
		async (kept) => {
			const f = await restore({ kind: "finish" })
			f.reopen.mockResolvedValueOnce(detached)

			f.task.approveAsk()
			// The resolve phase cleared the resolved action and presented the completion fallback.
			await presentedAsk(f.task, { ask: "completion_result", text: "" })
			const newer = { ...finishAction, actionId: "call_newer_finish" }
			if (!kept)
				await atTask("subtask", () =>
					store.atomicReadAndUpdate("subtask", (item) => ({ ...item, pendingAction: newer })),
				)
			f.task.handleWebviewAskResponse("messageResponse", "please revise")

			expect({
				run: await f.run,
				reopened: f.reopen.mock.calls.map(([params]) => params.pendingActionId),
				loops: f.loop.mock.calls.length,
				pendingAction: store.get("subtask")?.pendingAction?.actionId,
			}).toEqual({
				run: kept ? { ok: true } : { ok: false, error: ownershipChanged },
				reopened: [finishAction.actionId],
				loops: kept ? 1 : 0,
				pendingAction: kept ? undefined : newer.actionId,
			})
			if (kept)
				expect(f.loop).toHaveBeenCalledWith(
					[
						expect.objectContaining({
							type: "tool_result",
							tool_use_id: finishAction.actionId,
							content: expect.stringContaining("please revise"),
						}),
					],
					true,
				)
		},
	)

	it.each([true, false])(
		"a newer action adopted on recursion is presented and applied; ownership kept=%s",
		async (kept) => {
			const f = await restore({ kind: "finish" })
			const newer = { ...finishAction, actionId: "call_newer_finish", approvalText: "newer finish" }
			// Another owner replaced the action while this handoff was stale: clearing finds a newer one.
			f.reopen.mockImplementationOnce(async () => {
				await withProviderStartExclusion(root, "subtask", () =>
					store.atomicReadAndUpdate("subtask", (item) => ({ ...item, pendingAction: newer })),
				)
				return detached
			})

			f.task.approveAsk()
			await presentedAsk(f.task, { ask: "tool", text: newer.approvalText })
			const newest = { ...finishAction, actionId: "call_newest_finish" }
			if (!kept)
				await atTask("subtask", () =>
					store.atomicReadAndUpdate("subtask", (item) => ({ ...item, pendingAction: newest })),
				)
			f.task.approveAsk()

			expect({
				run: await f.run,
				reopened: f.reopen.mock.calls.map(([params]) => params.pendingActionId),
				loops: f.loop.mock.calls.length,
			}).toEqual({
				run: kept ? { ok: true } : { ok: false, error: ownershipChanged },
				reopened: kept ? [finishAction.actionId, newer.actionId] : [finishAction.actionId],
				loops: 0,
			})
		},
	)

	it("the status baseline is read under the presenting scope, not at construction", async () => {
		// Built from an `active` snapshot; the disk says `interrupted` before the approval is shown.
		const f = await restore({ diskStatus: "interrupted" })

		f.task.denyAsk()

		expect({ run: await f.run, loops: f.loop.mock.calls.length }).toEqual({ run: { ok: true }, loops: 1 })
	})
})

describe("Case 19 gap (a): a presented ask's queued claim when its scope rejects on exit", () => {
	/** Fail every later lease check, as an ownership loss detected when the scope exits. */
	function failLeaseChecksAfter(presentations: number, task: Task) {
		let failing = false
		acquireSpy.mockImplementation(async function (this: ParentHandoffFence, id, options) {
			const lease = await realAcquire.call(this, id, compressed(options))
			const assertOwned = lease.assertOwned.bind(lease)
			return Object.assign(lease, {
				assertOwned: async () => {
					if (failing) throw new OrdinaryPersistenceAuthorityError("test lease lost at scope exit")
					return assertOwned()
				},
			})
		})
		// Private member; no public seam marks the end of a presentation.
		const access = task as unknown as { presentResumeAsk: (...args: unknown[]) => Promise<unknown> }
		const present = access.presentResumeAsk
		let count = 0
		vi.spyOn(access, "presentResumeAsk").mockImplementation(async function (this: Task, ...args) {
			const presented = await present.apply(this, args)
			if (++count === presentations) failing = true
			return presented
		})
	}
	const refused =
		"OrdinaryPersistenceAuthorityError: Ordinary persistence authority refused: test lease lost at scope exit"

	it("the first phase's presentation claim is released", async () => {
		const f = await restore({
			presented: false,
			beforeRun: (task) => {
				task.messageQueueService.addMessage("queued before the restore")
				failLeaseChecksAfter(1, task)
			},
		})

		expect({
			run: await f.run,
			presented: f.task.clineMessages.at(-1)?.ask,
			queued: f.task.messageQueueService.claimNextMessage()?.text,
		}).toEqual({ run: { ok: false, error: refused }, presented: "tool", queued: "queued before the restore" })
	})

	it("a nested presentation's claim in a resolve phase is released", async () => {
		const f = await restore({ kind: "finish" })
		f.reopen.mockImplementationOnce(async () => {
			f.task.messageQueueService.addMessage("queued during the handoff")
			return { kind: "detached", phase: "precommit", reason: "ownership_moved" }
		})
		failLeaseChecksAfter(1, f.task)

		f.task.approveAsk()

		expect({
			run: await f.run,
			presented: f.task.clineMessages.at(-1)?.ask,
			queued: f.task.messageQueueService.claimNextMessage()?.text,
		}).toEqual({
			run: { ok: false, error: refused },
			presented: "completion_result",
			queued: "queued during the handoff",
		})
	})
})

describe("Case 19 gap (a): contention when the resolve phase re-acquires", () => {
	const contended = () => vi.spyOn(console, "warn").mockImplementation(() => {})
	const rePresentations = (warn: MockInstance<typeof console.warn>) =>
		warn.mock.calls.filter(([message]) => String(message).includes("the answer was not applied, re-presenting"))
			.length
	const rePresented = (warn: MockInstance<typeof console.warn>, count = 1) =>
		vi.waitFor(() => expect(rePresentations(warn)).toBeGreaterThanOrEqual(count), WAIT)
	const asks = (task: Task, ask: string) => task.clineMessages.filter((message) => message.ask === ask).length
	/** The NEW ask row exists (an unanswered old row must not be mistaken for it). */
	const rowCount = (task: Task, ask: string, count: number) =>
		vi.waitFor(() => expect(asks(task, ask)).toBe(count), WAIT)
	const feedback = (task: Task) => task.clineMessages.filter((message) => message.say === "user_feedback").length
	/** Unapplied answer content handed back to the chat input. */
	const restoredToInput = (provider: ClineProvider) =>
		vi
			.mocked(provider.postMessageToWebview)
			.mock.calls.map(([message]) => message)
			.filter((message) => message.type === "invoke" && message.invoke === "setChatBoxMessage")
			.map(({ text, images }) => ({ text, images }))
	/**
	 * The re-presented tool ask is still unanswered after its 2 s interaction timer: no automatic
	 * answer, re-delivery or queued re-claim happened. Event-driven, not a sleep.
	 */
	const stillWaitingForUser = (task: Task) =>
		vi.waitFor(() => expect(task.interactiveAsk?.ts).toBe(task.clineMessages.at(-1)?.ts), WAIT)

	beforeEach(() => {
		// The resolve phase's bounded acquisition must expire while another context holds the lease.
		fenceWaitMs = 1_000
	})

	it("re-presents the approval without applying it; a later click applies it once", async () => {
		const f = await restore()
		const warn = contended()
		const holder = await holdLease("parent")

		f.task.approveAsk()
		await rePresented(warn)
		await holder.release()
		await presentedAsk(f.task, { ask: "tool", text: createAction.approvalText })
		const beforeClick = { delegated: f.delegate.mock.calls.length, asks: asks(f.task, "tool") }
		f.task.approveAsk()

		expect({
			beforeClick,
			run: await f.run,
			delegated: f.delegate.mock.calls.length,
			refused: f.task["persistenceAuthority"].refused,
			// A button-only answer has no content to hand back.
			restored: restoredToInput(f.provider),
		}).toEqual({
			// Each re-presentation adds one ask row (recorded in the lifecycle doc).
			beforeClick: { delegated: 0, asks: 2 },
			run: { ok: true },
			delegated: 1,
			refused: false,
			restored: [],
		})
	})

	it("a typed generic Resume Task answer goes back to the input, not re-delivered; a new answer applies once", async () => {
		const f = await restore({ kind: "generic" })
		const warn = contended()
		const holder = await holdLease("parent")

		f.task.handleWebviewAskResponse("messageResponse", "keep this typed answer", ["data:image/png;base64,AA=="])
		await rePresented(warn)
		await holder.release()
		await rowCount(f.task, "resume_task", 2)
		await presentedAsk(f.task, { ask: "resume_task" })
		const beforeAnswer = {
			restored: restoredToInput(f.provider),
			feedback: feedback(f.task),
			loops: f.loop.mock.calls.length,
		}
		// The user sends the restored draft again: a new user action.
		f.task.handleWebviewAskResponse("messageResponse", "keep this typed answer")

		expect({
			beforeAnswer,
			run: await f.run,
			asks: asks(f.task, "resume_task"),
			feedback: feedback(f.task),
			loops: f.loop.mock.calls.length,
		}).toEqual({
			beforeAnswer: {
				restored: [{ text: "keep this typed answer", images: ["data:image/png;base64,AA=="] }],
				feedback: 0,
				loops: 0,
			},
			run: { ok: true },
			asks: 2,
			feedback: 1,
			loops: 1,
		})
	})

	it("a queued answer leaves the queue for the input and is not re-claimed by the re-presented ask", async () => {
		const f = await restore()
		const warn = contended()
		const holder = await holdLease("parent")

		// Durable-ack queued feedback: claimed by the waiter, kept in the queue until persisted.
		f.task.messageQueueService.addMessage("try another way")
		await rePresented(warn)
		await holder.release()
		await rowCount(f.task, "tool", 2)
		await presentedAsk(f.task, { ask: "tool", text: createAction.approvalText })
		await stillWaitingForUser(f.task)
		const beforeClick = {
			restored: restoredToInput(f.provider),
			queueEmpty: f.task.messageQueueService.isEmpty(),
			consumable: f.task.messageQueueService.claimNextMessage()?.text,
			feedback: feedback(f.task),
			loops: f.loop.mock.calls.length,
		}
		f.task.approveAsk()

		expect({ beforeClick, run: await f.run, delegated: f.delegate.mock.calls.length }).toEqual({
			beforeClick: {
				restored: [{ text: "try another way", images: undefined }],
				queueEmpty: true,
				consumable: undefined,
				feedback: 0,
				loops: 0,
			},
			run: { ok: true },
			delegated: 1,
		})
	})

	it("two consecutive contentions each re-present and wait for a user action; no automatic cycle", async () => {
		const f = await restore()
		const warn = contended()
		let holder = await holdLease("parent")

		f.task.handleWebviewAskResponse("messageResponse", "first draft")
		await rePresented(warn, 1)
		await holder.release()
		await rowCount(f.task, "tool", 2)
		await presentedAsk(f.task, { ask: "tool", text: createAction.approvalText })
		await stillWaitingForUser(f.task)
		const afterFirst = { rePresented: rePresentations(warn), delegated: f.delegate.mock.calls.length }

		holder = await holdLease("parent")
		f.task.approveAsk()
		await rePresented(warn, 2)
		await holder.release()
		await rowCount(f.task, "tool", 3)
		await presentedAsk(f.task, { ask: "tool", text: createAction.approvalText })
		await stillWaitingForUser(f.task)
		const afterSecond = { rePresented: rePresentations(warn), delegated: f.delegate.mock.calls.length }
		f.task.approveAsk()

		expect({
			afterFirst,
			afterSecond,
			run: await f.run,
			delegated: f.delegate.mock.calls.length,
			loops: f.loop.mock.calls.length,
			feedback: feedback(f.task),
			restored: restoredToInput(f.provider),
			asks: asks(f.task, "tool"),
		}).toEqual({
			afterFirst: { rePresented: 1, delegated: 0 },
			afterSecond: { rePresented: 2, delegated: 0 },
			run: { ok: true },
			delegated: 1,
			loops: 0,
			feedback: 0,
			restored: [{ text: "first draft", images: undefined }],
			asks: 3,
		})
	})

	it("a real click on the re-presented ask is not overwritten by the unapplied answer", async () => {
		const f = await restore()
		const warn = contended()
		const holder = await holdLease("parent")

		// Typed feedback on the approval means "deny with this feedback".
		f.task.handleWebviewAskResponse("messageResponse", "deny with this")
		await rePresented(warn)
		await holder.release()
		await rowCount(f.task, "tool", 2)
		await presentedAsk(f.task, { ask: "tool", text: createAction.approvalText })
		f.task.approveAsk()

		expect({
			run: await f.run,
			delegated: f.delegate.mock.calls.length,
			loops: f.loop.mock.calls.length,
			feedback: feedback(f.task),
		}).toEqual({ run: { ok: true }, delegated: 1, loops: 0, feedback: 0 })
	})

	it("abort during the re-presentation returns quietly with no effect", async () => {
		const f = await restore()
		const warn = contended()
		const holder = await holdLease("parent")

		f.task.approveAsk()
		await rePresented(warn)
		const aborting = track(f.task.abortTask())
		await holder.release()
		await aborting

		expect({ run: await f.run, delegated: f.delegate.mock.calls.length, asks: asks(f.task, "tool") }).toEqual({
			run: { ok: true },
			delegated: 0,
			asks: 1,
		})
	})

	it("a sticky refusal on re-acquire still ends the run without re-presenting", async () => {
		const f = await restore()
		const warn = contended()
		const saveEntered = signal()
		const saveGate = signal()
		gates.push(saveGate)
		const upsert = store.upsert.bind(store)
		vi.spyOn(store, "upsert").mockImplementationOnce(async (item) => {
			// The click's own save holds the lease, so the next acquisition is the resolve phase's.
			saveEntered.release()
			await saveGate.promise
			return upsert(item)
		})
		let refuseNext = false
		acquireSpy.mockImplementation(async function (this: ParentHandoffFence, id, options) {
			if (refuseNext) {
				refuseNext = false
				throw new ParentHandoffFenceUnavailableError(id, "unrecoverable")
			}
			return realAcquire.call(this, id, compressed(options))
		})
		// Test-only ordering: the resolve phase (the only fresh exclusion after the click) acquires
		// after the click's save holds the lease. Private member; no public seam.
		const access = f.task as unknown as {
			withStartExclusion: (effect: () => Promise<unknown>, fresh?: boolean) => Promise<unknown>
		}
		const start = access.withStartExclusion
		vi.spyOn(access, "withStartExclusion").mockImplementation(async function (this: Task, effect, fresh) {
			if (fresh) {
				await saveEntered.promise
				refuseNext = true
			}
			return start.call(this, effect, fresh)
		})

		f.task.approveAsk()
		const run = await f.run
		saveGate.release()

		expect({
			run,
			refused: f.task["persistenceAuthority"].refused,
			delegated: f.delegate.mock.calls.length,
			asks: asks(f.task, "tool"),
			rePresented: warn.mock.calls.some(([message]) => String(message).includes("re-presenting")),
		}).toEqual({
			run: {
				ok: false,
				error: "ParentHandoffFenceUnavailableError: Parent handoff fence is unavailable for parent (unrecoverable)",
			},
			refused: true,
			delegated: 0,
			asks: 1,
			rePresented: false,
		})
	})

	it("under auto-approval, the re-presented ask is auto-approved per standing consent and applied once", async () => {
		const f = await restore()
		const warn = contended()
		const holder = await holdLease("parent")

		f.task.approveAsk()
		await rePresented(warn)
		// Standing consent is on when the ask is presented again (deliberate exception in the doc).
		const state = await f.provider.getState()
		vi.spyOn(f.provider, "getState").mockResolvedValue({ ...state, autoApprovalEnabled: true })
		f.task.queueSubtaskApprovalAllowed = () => true
		await holder.release()

		expect({
			run: await f.run,
			delegated: f.delegate.mock.calls.length,
			rePresented: rePresentations(warn),
			reShown: f.task.clineMessages.at(-1),
		}).toEqual({
			run: { ok: true },
			delegated: 1,
			rePresented: 1,
			reShown: expect.objectContaining({ ask: "tool", isAnswered: true, autoApprovalDecision: "approve" }),
		})
	})

	it("a failed re-present acquisition ends the run closed: content restored, no live ask, nothing applied", async () => {
		const f = await restore()
		const warn = contended()
		// Held throughout: both the resolve phase and the re-presentation meet contention.
		await holdLease("parent")

		f.task.handleWebviewAskResponse("messageResponse", "keep my feedback")
		const run = await f.run

		expect({
			run,
			rePresented: rePresentations(warn),
			restored: restoredToInput(f.provider),
			asks: asks(f.task, "tool"),
			delegated: f.delegate.mock.calls.length,
			loops: f.loop.mock.calls.length,
			feedback: feedback(f.task),
			refused: f.task["persistenceAuthority"].refused,
		}).toEqual({
			run: {
				ok: false,
				error: "ParentHandoffFenceUnavailableError: Parent handoff fence is unavailable for parent (timeout)",
			},
			rePresented: 1,
			restored: [{ text: "keep my feedback", images: undefined }],
			asks: 1,
			delegated: 0,
			loops: 0,
			feedback: 0,
			refused: false,
		})
	})

	it("an owner moved during contention is refused before the ask is shown again; content stays restored", async () => {
		const f = await restore()
		const warn = contended()
		const superseding = { ...createAction, actionId: "call_newer_create" }
		// The contention holder is another context's exclusion scope; it moves the pending action
		// under its own lease, then releases.
		const held = signal()
		const move = signal()
		gates.push(move)
		const holder = track(
			withProviderStartExclusion(
				root,
				"parent",
				async () => {
					held.release()
					await move.promise
					await store.atomicReadAndUpdate("parent", (item) => ({ ...item, pendingAction: superseding }))
				},
				{ fresh: true },
			),
		)
		await held.promise

		f.task.handleWebviewAskResponse("messageResponse", "keep my feedback")
		await rePresented(warn)
		move.release()
		await holder

		expect({
			run: await f.run,
			asks: asks(f.task, "tool"),
			restored: restoredToInput(f.provider),
			delegated: f.delegate.mock.calls.length,
			loops: f.loop.mock.calls.length,
			refused: f.task["persistenceAuthority"].refused,
			pendingAction: store.get("parent")?.pendingAction?.actionId,
		}).toEqual({
			run: {
				ok: false,
				error: "OrdinaryPersistenceAuthorityError: Ordinary persistence authority refused: Pending action ownership changed",
			},
			asks: 1,
			restored: [{ text: "keep my feedback", images: undefined }],
			delegated: 0,
			loops: 0,
			refused: true,
			pendingAction: superseding.actionId,
		})
	})
})
