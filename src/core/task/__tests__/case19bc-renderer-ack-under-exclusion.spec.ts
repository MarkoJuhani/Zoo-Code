// Case 19 follow-up, gaps (b) and (c): renderer round trips awaited while a start exclusion
// (ParentHandoffFence file lease) is held.
//
// (b) delegateParentAndOpenChild holds the parent's lease (withProviderStartExclusion) and,
//     inside it, awaits removeClineFromStack -> Task.abortTask -> flushPostStateToWebviewThrottled
//     (unbounded) and handleModeSwitch -> postStateToWebview (bounded by the provider-profile
//     mutation timeout, ClineProvider.PENDING_OPERATION_TIMEOUT_MS = 30 s).
// (c) Task.startTask holds the task's (and, for a child, the parent's) lease and, inside it,
//     startTaskUnprotected awaits postStateToWebviewWithoutTaskHistory and say/addToClineMessages
//     awaits the throttled state post.
//
// webview.postMessage resolves when the extension host's RPC to the renderer returns (VS Code
// docs: "resolves when the message is posted to a webview"), not when the React app handles it.
// A throttled or unresponsive renderer therefore delays the reply. Here the transport
// (view.webview.postMessage) is a controllable gate; every ClineProvider post function, the
// lodash debounce, handleModeSwitch and its mutation timeout are the production code.
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import debounce from "lodash.debounce"
import { TelemetryService } from "@roo-code/telemetry"
import type { HistoryItem } from "@roo-code/types"
import { Task } from "../Task"
import { TaskScheduler } from "../TaskScheduler"
import { TaskRegistry } from "../TaskRegistry"
import { TaskHistoryStore } from "../../task-persistence/TaskHistoryStore"
import { ParentHandoffFence } from "../../task-persistence/parentHandoffFence"
import { saveTaskMessages } from "../../task-persistence"
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

/** Production waits 30 s for an ordinary persistence lease; same ordering, compressed bound. */
const COMPRESSED_FENCE_WAIT_MS = 1_500
/** Matches USAGE_SAVE_RETRY_DELAY_MS in Task.ts. */
const USAGE_RETRY_DELAY_MS = 1_000
/** A renderer stall longer than any bounded wait used below. */
const STALL_MS = COMPRESSED_FENCE_WAIT_MS * 3
const WAIT = { timeout: 15_000, interval: 25 }

function signal() {
	let release!: () => void
	const promise = new Promise<void>((resolve) => {
		release = resolve
	})
	return { promise, release }
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

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

let warnings: string[]
beforeEach(async () => {
	if (!TelemetryService.hasInstance()) TelemetryService.createInstance([])
	root = await fs.mkdtemp(path.join(os.tmpdir(), "case19bc-renderer-ack-"))
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
	vi.spyOn(environmentDetails, "getEnvironmentDetails").mockResolvedValue(
		"<environment_details>offline</environment_details>",
	)
	warnings = []
	vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
		warnings.push(args.map(String).join(" "))
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

/** Real Task, store, fence, delegation, mode switch and state posts; only the transport is a gate. */
function fixture() {
	const registry = new TaskRegistry()
	const scheduler = new TaskScheduler(1)
	const renderer = { stalled: false, reply: signal(), stalledPosts: [] as string[] }
	gates.push(renderer.reply)
	const transport = vi.fn(async (message: { type: string }) => {
		if (renderer.stalled) {
			renderer.stalledPosts.push(message.type)
			// The renderer replies to the extension host's postMessage RPC late.
			await renderer.reply.promise
		}
		return true
	})
	const stalls = () => {
		renderer.stalled = true
	}
	const values = new Map<string, unknown>()
	const provider: ClineProvider = Object.assign(Object.create(ClineProvider.prototype), {
		context: { globalStorageUri: { fsPath: root }, workspaceState: { get: () => false } },
		contextProxy: {
			globalStorageUri: { fsPath: root },
			setValue: async (key: string, value: unknown) => void values.set(key, value),
			getValue: (key: string) => values.get(key),
		},
		taskHistoryStore: store,
		taskRegistry: registry,
		taskEventListeners: new WeakMap(),
		cancelledDelegationChildIds: new Set<string>(),
		// Instance fields that Object.create does not initialize.
		providerProfileMutationQueue: Promise.resolve(),
		clineMessagesSeq: 0,
		_disposed: false,
		view: { webview: { postMessage: transport } },
		getState: async () => ({
			mode: "code",
			currentApiConfigName: "offline",
			mcpEnabled: false,
			autoApprovalEnabled: true,
			alwaysAllowSubtasks: true,
		}),
		// The state snapshot is irrelevant; its delivery is what is under test.
		getStateToPostToWebview: async () => ({}),
		providerSettingsManager: {
			getModeConfigId: async () => undefined,
			listConfig: async () => [],
			setModeConfig: async () => {},
		},
		log: vi.fn(),
		isViewLaunched: true,
		emit: vi.fn(),
		taskScheduler: scheduler,
	})
	// Same construction and options as the ClineProvider field initializer.
	Object.assign(provider, {
		_postStateToWebviewThrottled: debounce(
			async () => {
				try {
					await provider.postStateToWebviewWithoutTaskHistory()
				} catch {
					/* logged in production */
				}
			},
			500,
			{ leading: true, trailing: true, maxWait: 1000 },
		),
	})
	afterEachCancel.push(() => provider["_postStateToWebviewThrottled"].cancel())

	async function instance(id: string, options: { parentTask?: Task; historyItem?: HistoryItem } = {}) {
		const task = new Task({
			provider,
			apiConfiguration: {},
			taskId: id,
			task: options.historyItem ? undefined : `offline ${id}`,
			parentTask: options.parentTask,
			rootTask: options.parentTask,
			historyItem: options.historyItem,
			startTask: false,
			enableCheckpoints: false,
		})
		tasks.push(task)
		await task.waitForModeInitialization()
		await task.waitForApiConfigInitialization()
		task["startIdleTelemetryCheck"] = vi.fn()
		vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
		task["safeEnsureModelFetched"] = async () => task.api.getModel().info
		return task
	}
	const children: Task[] = []
	provider.createTask = vi.fn(async (_message, _images, parentTask) => {
		const child = await instance(`child-${children.length + 1}`, { parentTask })
		vi.spyOn(child, "recursivelyMakeClineRequests").mockResolvedValue(true)
		children.push(child)
		registry.push(child)
		return child
	})
	return { provider, registry, renderer, stalls, instance, children }
}
const afterEachCancel: (() => void)[] = []
afterEach(() => afterEachCancel.splice(0).forEach((cancel) => cancel()))

const usageInMemory = (task: Task) => {
	const request = [...task.clineMessages].reverse().find((message) => message.say === "api_req_started")
	return request?.text ? (JSON.parse(request.text) as { tokensIn?: number }).tokensIn : undefined
}
const usageOnDisk = async (id: string) =>
	(JSON.parse(await fs.readFile(path.join(root, "tasks", id, "history_item.json"), "utf8")) as HistoryItem).tokensIn

/** The parent's native new_task turn: text, the tool call, then the provider's usage chunk. */
function newTaskTurn(task: Task, onToolCall: () => void) {
	let calls = 0
	vi.spyOn(task, "attemptApiRequest").mockImplementation(async function* () {
		if (++calls > 1) return
		yield { type: "text", text: "I will delegate the work." }
		yield { type: "tool_call_partial", index: 0, id: "call_delegate", name: "new_task", arguments: "" }
		yield {
			type: "tool_call_partial",
			index: 0,
			id: undefined,
			name: undefined,
			arguments: JSON.stringify({ mode: "code", message: "child work", todos: "" }),
		}
		onToolCall()
		yield { type: "usage", inputTokens: 10, outputTokens: 5 }
	} as never)
}

describe("Case 19 gap (b): renderer acknowledgements under the parent's lease during delegation", () => {
	// Not reproduced as a failure. NewTaskTool awaits waitForCurrentAssistantMessagePersistence
	// (after the stream and its usage save) before delegateParentAndOpenChild takes the parent
	// lease, so the new_task turn's usage save never waits for that lease. A forced variant that
	// withholds the usage chunk until delegation starts cannot occur: delegation never starts
	// while the stream is open.
	it("not a failure: a renderer stall from the new_task turn on delays delegation but loses no parent usage", async () => {
		const f = fixture()
		const parent = await f.instance("parent")
		f.registry.push(parent)
		const steps: string[] = []
		const removeClineFromStack = f.provider.removeClineFromStack.bind(f.provider)
		vi.spyOn(f.provider, "removeClineFromStack").mockImplementation(async (...args) => {
			steps.push(`teardown stalled=${f.renderer.stalledPosts.length > 0}`)
			return removeClineFromStack(...args)
		})
		const save = parent["saveClineMessages"].bind(parent)
		parent["saveClineMessages"] = async (merge?: boolean) => {
			const saved = await save(merge)
			if (usageInMemory(parent) === 10) steps.push("usage saved")
			return saved
		}
		// The user backgrounds VS Code while the parent streams its new_task turn.
		newTaskTurn(parent, f.stalls)

		const run = outcome(parent.runScheduled())
		await vi.waitFor(() => expect(f.renderer.stalledPosts).toContain("state"), WAIT)
		await delay(STALL_MS)
		const beforeReply = [...steps]
		f.renderer.reply.release()
		await vi.waitFor(() => expect(f.children).toHaveLength(1), WAIT)
		await run
		await delay(USAGE_RETRY_DELAY_MS * 2)

		expect({
			// The parent itself waits on the renderer (tool ask/say) before it reaches delegation.
			beforeReply: beforeReply.includes("usage saved") && !beforeReply.some((s) => s.startsWith("teardown")),
			delegated: f.children.length,
			usageOnDisk: await usageOnDisk("parent"),
			usageWarnings: warnings.filter((line) => line.includes("[Background Usage Collection]")),
		}).toEqual({ beforeReply: true, delegated: 1, usageOnDisk: 10, usageWarnings: [] })
	})
})

describe("Case 19 gap (c): renderer acknowledgements under withStartExclusion at task start", () => {
	// Mechanism, with a stand-in collider: no single-host production operation was found that
	// needs the (disposed, delegated) parent's lease during a child's start. Another VS Code
	// window sharing the storage (saving or reopening the parent) is the plausible collider.
	// Known-gap witness for gap (c), expected to fail: delay-only in a single host and out of scope
	// for the gap (a) fix. See "Known remaining waits" under Case 19 in
	// docs/architecture/task-lifecycle-model.md.
	it.fails(
		"a child start stalled on its first state post does not hold the parent lease against another context's save",
		async () => {
			const f = fixture()
			await store.upsert({
				id: "parent",
				number: 1,
				ts: 1,
				task: "parent",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				status: "delegated",
				delegatedToId: "child",
				awaitingChildId: "child",
				childIds: ["child"],
			})
			await saveTaskMessages({
				messages: [{ ts: 1, type: "say", say: "text", text: "parent" }],
				taskId: "parent",
				globalStoragePath: root,
			})
			const parent = await f.instance("parent", { historyItem: store.get("parent") })
			const child = await f.instance("child", { parentTask: parent })
			vi.spyOn(child, "recursivelyMakeClineRequests").mockResolvedValue(true)
			f.registry.push(child)
			f.stalls()

			const start = outcome(child.runScheduled())
			// startTaskUnprotected -> postStateToWebviewWithoutTaskHistory, inside [parent, child].
			await vi.waitFor(() => expect(f.renderer.stalledPosts).toContain("state"), WAIT)
			// Stand-in collider: an ordinary save of the parent from another async context.
			const parentSave = await outcome(parent["saveClineMessages"]())
			f.renderer.reply.release()

			expect({ parentSave, start: await start, refused: parent["persistenceAuthority"].refused }).toEqual({
				parentSave: { ok: true },
				start: { ok: true },
				refused: false,
			})
		},
	)

	it("not a failure: a top-level start stalled on its state post only delays its own lease release", async () => {
		const f = fixture()
		const task = await f.instance("solo")
		vi.spyOn(task, "recursivelyMakeClineRequests").mockResolvedValue(true)
		f.registry.push(task)
		f.stalls()

		const start = outcome(task.runScheduled())
		await vi.waitFor(() => expect(f.renderer.stalledPosts).toContain("state"), WAIT)
		await delay(STALL_MS)
		f.renderer.reply.release()

		// No other async context needs "solo" during its start; the start completes after the reply.
		expect({ start: await start, refused: task["persistenceAuthority"].refused }).toEqual({
			start: { ok: true },
			refused: false,
		})
	})
})
