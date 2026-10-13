// Case 19: "sometimes delegation or tool calling stays hanging".
//
// Field evidence (2026-10-09 10:30:51-10:31:50): the parent fence generation stopped at
// the save that wrote ui_messages/history_item at 10:30:51, the VS Code renderer was
// throttled ("Extension host (Remote) is unresponsive" 10:30:54-10:31:50), then the
// background usage drain timed out on the parent fence, the authority became sticky-
// refused and the presenter failed before new_task could record its approval.
//
// Mechanism under test: Task.saveClineMessages -> ClineProvider.updateTaskHistory awaits
// the webview postMessage round trip while the task's handoff fence is still held. A slow
// renderer therefore holds the fence; any concurrent ordinary persistence for the same
// task (usage drain, presenter, tool) times out and permanently refuses the instance.
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { TelemetryService } from "@roo-code/telemetry"
import type { ExtensionMessage, HistoryItem } from "@roo-code/types"
import { Task } from "../Task"
import { TaskScheduler } from "../TaskScheduler"
import { TaskRegistry } from "../TaskRegistry"
import { TaskHistoryStore } from "../../task-persistence/TaskHistoryStore"
import { providerStartExclusionDiagnostics } from "../../task-persistence/targetPersistenceBoundary"
import {
	ParentHandoffFence,
	ParentHandoffFenceOwnershipError,
	ParentHandoffFenceUnavailableError,
} from "../../task-persistence/parentHandoffFence"
import { readTaskMessages } from "../../task-persistence"
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

/**
 * Production waits 30 s; the ordering is identical with a compressed bound. The bound must
 * exceed a few queued real-disk saves of the same task (about 70-100 ms each, more under
 * parallel suite load) and stay below the slow-renderer window (3x this bound), so a fence
 * held across the renderer round trip still times out while ordinary queuing does not.
 */
const COMPRESSED_FENCE_WAIT_MS = 1_500

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

beforeEach(async () => {
	if (!TelemetryService.hasInstance()) TelemetryService.createInstance([])
	root = await fs.mkdtemp(path.join(os.tmpdir(), "case19-webview-ack-"))
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

/** Real Task, store, fence and ClineProvider history broadcast; only the webview transport is a double. */
async function fixture() {
	const registry = new TaskRegistry()
	const scheduler = new TaskScheduler(1)
	const stages: string[] = []
	const uiGate = signal()
	gates.push(uiGate)
	const ui = {
		slow: false,
		entered: signal(),
		guard: undefined as ReturnType<typeof providerStartExclusionDiagnostics> | undefined,
	}
	const postMessageToWebview = vi.fn(async (message: ExtensionMessage) => {
		if (ui.slow && message.type === "taskHistoryItemUpdated") {
			// Diagnostic only: "inherited"/active means the ack is awaited inside the task fence guard.
			ui.guard ??= providerStartExclusionDiagnostics(root, "parent")
			ui.entered.release()
			// A throttled/backgrounded renderer acknowledges the RPC late.
			await uiGate.promise
		}
	})
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
		postMessageToWebview,
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
	vi.spyOn(provider, "delegateParentAndOpenChild").mockImplementation((params) => track(delegate(params)))
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
	return { provider, ui, uiGate, stages, instance, postMessageToWebview }
}

describe("Case 19: webview acknowledgement inside the task persistence fence", () => {
	it("does not hold the task fence while the webview acknowledges a history update", async () => {
		const f = await fixture()
		const task = await f.instance("parent")
		await task.say("text", "seed")
		f.ui.slow = true

		const save = track(task["saveClineMessages"]())
		await f.ui.entered.promise
		// The renderer has received the post and stays unacknowledged for the whole probe.
		// The post is invoked inside the save's fence, so the probe waits a bounded time for
		// the save's own release; it can only succeed if the save does not await the ack.
		const probe = await new ParentHandoffFence(root)
			.acquire("parent", { timeoutMs: COMPRESSED_FENCE_WAIT_MS })
			.then(
				async (lease) => {
					await lease.release()
					return "free"
				},
				(error: Error) => `${error.name}: ${error.message} (guard during ack ${JSON.stringify(f.ui.guard)})`,
			)
		f.uiGate.release()
		await save

		expect(probe).toBe("free")
	})

	it("a slow webview acknowledgement does not time out and permanently refuse a concurrent usage save", async () => {
		const f = await fixture()
		const task = await f.instance("parent")
		await task.say("text", "seed")
		f.ui.slow = true

		const outcome = (promise: Promise<boolean>) =>
			track(
				promise.then(
					(value) => ({ ok: true as const, value }),
					(error: Error) => ({ ok: false as const, error: `${error.name}: ${error.message}` }),
				),
			)
		// Presenter/main-loop save reaches the webview round trip first.
		const first = outcome(task["saveClineMessages"]())
		await f.ui.entered.promise
		// Background usage drain (Task.drainStreamInBackgroundToFindAllUsage -> captureUsageData).
		const drain = outcome(task["saveClineMessages"]())
		// Let the drain's bounded fence wait elapse while the renderer is still slow.
		await delay(COMPRESSED_FENCE_WAIT_MS * 3)
		f.uiGate.release()
		const results = { first: await first, drain: await drain }
		const next = await outcome(task["saveClineMessages"]())

		expect({ ...results, next, refused: task["persistenceAuthority"].refused }).toEqual({
			first: { ok: true, value: true },
			drain: { ok: true, value: true },
			next: { ok: true, value: true },
			refused: false,
		})
	})

	it("post-child continuation still delegates when the renderer is slow during the native new_task turn", async () => {
		vi.spyOn(environmentDetails, "getEnvironmentDetails").mockResolvedValue(
			"<environment_details>offline</environment_details>",
		)
		const errors: string[] = []
		const consoleError = console.error
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			errors.push(
				args.map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg))).join(" "),
			)
			consoleError(...args)
		})
		const f = await fixture()
		const parent = await f.instance("parent")
		await parent.say("text", "offline root")
		await f.provider.delegateParentAndOpenChild({
			parentTaskId: "parent",
			message: "offline child",
			initialTodos: [],
			mode: "code",
		})
		// The child's scheduled run settles after several real-disk saves; the default 1 s bound
		// is too short on a loaded machine.
		await vi.waitFor(() => expect(f.stages).toContain("child-1:settled"), { timeout: 10_000, interval: 50 })
		vi.mocked(f.provider.createTask).mockClear()

		const streamEnded = signal()
		const create = vi.mocked(f.provider.createTaskWithHistoryItem).getMockImplementation()!
		let resumed!: Task
		vi.mocked(f.provider.createTaskWithHistoryItem).mockImplementation(async (...args) => {
			const task = await create(...args)
			resumed = task
			vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
			// Offline model metadata; the real fetch needs provider settings outside this composition.
			task["safeEnsureModelFetched"] = async () => task.api.getModel().info
			let calls = 0
			vi.spyOn(task, "attemptApiRequest").mockImplementation(async function* () {
				if (++calls > 1) {
					yield { type: "text", text: "done" }
					yield { type: "usage", inputTokens: 1, outputTokens: 1 }
					return
				}
				// The user backgrounds VS Code while the parent streams its next native turn.
				f.ui.slow = true
				yield { type: "text", text: "I will delegate the separate re-audit." }
				yield { type: "tool_call_partial", index: 0, id: "call_case19", name: "new_task", arguments: "" }
				yield {
					type: "tool_call_partial",
					index: 0,
					id: undefined,
					name: undefined,
					arguments: JSON.stringify({ mode: "code", message: "re-audit", todos: "" }),
				}
				yield { type: "usage", inputTokens: 10, outputTokens: 5 }
				streamEnded.release()
			} as never)
			return task
		})

		await f.provider.reopenParentFromDelegation({
			parentTaskId: "parent",
			childTaskId: "child-1",
			completionResultSummary: "child result",
		})
		await streamEnded.promise
		// Renderer stays throttled longer than any bounded fence wait, then catches up.
		await delay(COMPRESSED_FENCE_WAIT_MS * 3)
		f.uiGate.release()
		await vi
			.waitFor(() => expect(f.provider.createTask).toHaveBeenCalled(), { timeout: 3_000, interval: 50 })
			.catch(() => {})

		expect({
			delegated: vi.mocked(f.provider.createTask).mock.calls.length > 0,
			refused: resumed["persistenceAuthority"].refused,
			fenceErrors: errors.filter((line) =>
				/Error draining stream for usage data|Background usage collection failed|presentAssistantMessage\] task parent/.test(
					line,
				),
			),
		}).toEqual({ delegated: true, refused: false, fenceErrors: [] })
	})
})

describe("Case 19: contention is not lost authority, and history broadcasts never block a save", () => {
	const freeFence = (id: string) =>
		new ParentHandoffFence(root).acquire(id, { timeoutMs: 0 }).then(
			async (lease) => {
				await lease.release()
				return "free"
			},
			(error: Error) => `${error.name}: ${error.message}`,
		)

	it.each([
		["rejects", () => Promise.reject(new Error("renderer gone"))],
		[
			"throws synchronously",
			(): Promise<void> => {
				throw new Error("renderer gone")
			},
		],
	])("a history broadcast that %s neither fails the save nor keeps the fence held", async (_name, post) => {
		const warnings: string[] = []
		vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
			warnings.push(args.map(String).join(" "))
		})
		const f = await fixture()
		const task = await f.instance("parent")
		await task.say("text", "seed")
		f.postMessageToWebview.mockImplementation(async (message) => {
			if (message.type === "taskHistoryItemUpdated") return post()
		})

		const saved = await task["saveClineMessages"]()
		// Delivery failure is reported asynchronously; let the logging handler run.
		await vi.waitFor(() => expect(warnings.join("\n")).toContain("taskHistoryItemUpdated delivery failed"))

		expect({ saved, fence: await freeFence("parent"), refused: task["persistenceAuthority"].refused }).toEqual({
			saved: true,
			fence: "free",
			refused: false,
		})
	})

	it("updateTaskHistory keeps its return value, message content and broadcast option", async () => {
		const f = await fixture()
		const task = await f.instance("parent")
		await task.say("text", "seed")
		const item = store.get("parent")!
		f.postMessageToWebview.mockClear()

		const quiet = await f.provider.updateTaskHistory({ ...item, tokensOut: 3 }, { broadcast: false })
		expect(f.postMessageToWebview).not.toHaveBeenCalled()
		expect(quiet.find((entry) => entry.id === "parent")?.tokensOut).toBe(3)

		const history = await f.provider.updateTaskHistory({ ...item, tokensOut: 4 })
		expect(history.find((entry) => entry.id === "parent")?.tokensOut).toBe(4)
		expect(f.postMessageToWebview.mock.calls).toEqual([
			[{ type: "taskHistoryItemUpdated", taskHistoryItem: store.get("parent") }],
		])
	})

	it("a start-exclusion contention timeout refuses only that attempt; the instance saves afterwards", async () => {
		const f = await fixture()
		const task = await f.instance("parent")
		await task.say("text", "seed")
		const before = await fs.readFile(path.join(root, "tasks", "parent", "history_item.json"))
		const effect = vi.fn(async () => {})

		const holder = await new ParentHandoffFence(root).acquire("parent")
		try {
			await expect(task["withStartExclusion"](effect)).rejects.toMatchObject({
				name: ParentHandoffFenceUnavailableError.name,
				reason: "timeout",
			})
		} finally {
			await holder.release()
		}

		expect(effect).not.toHaveBeenCalled()
		expect(task["persistenceAuthority"].refused).toBe(false)
		expect(await fs.readFile(path.join(root, "tasks", "parent", "history_item.json"))).toEqual(before)
		expect(await task["saveClineMessages"]()).toBe(true)
	})

	it.each([
		["ownership loss", () => new ParentHandoffFenceOwnershipError("parent")],
		["filesystem refusal", () => new ParentHandoffFenceUnavailableError("parent", "filesystem", "EIO")],
		[
			"unrecoverable lock",
			() => new ParentHandoffFenceUnavailableError("parent", "unrecoverable", undefined, "LEGACY_OWNER"),
		],
		// Raised after both exclusions were held: the effect may already have written.
		["timeout raised inside the started effect", () => new ParentHandoffFenceUnavailableError("parent", "timeout")],
	])("a start-exclusion %s stays sticky", async (_name, create) => {
		const f = await fixture()
		const task = await f.instance("parent")
		await task.say("text", "seed")
		const error = create()

		await expect(
			task["withStartExclusion"](async () => {
				throw error
			}),
		).rejects.toBe(error)
		expect(task["persistenceAuthority"].refused).toBe(true)
		await expect(task["saveClineMessages"]()).rejects.toThrow("instance was previously refused")
	})

	it("a contended background usage save is skipped with a warning, schedules one retry, and a later save persists the usage", async () => {
		vi.spyOn(environmentDetails, "getEnvironmentDetails").mockResolvedValue(
			"<environment_details>offline</environment_details>",
		)
		const warnings: string[] = []
		const errors: string[] = []
		vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
			warnings.push(args.map(String).join(" "))
		})
		const consoleError = console.error
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			errors.push(
				args.map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg))).join(" "),
			)
			consoleError(...args)
		})
		const f = await fixture()
		const task = await f.instance("parent")
		// History metrics skip the first message, which is the task text in production.
		await task.say("text", "offline root")
		vi.spyOn(task.diffViewProvider, "reset").mockResolvedValue(undefined)
		task["safeEnsureModelFetched"] = async () => task.api.getModel().info
		const usageOf = (messages: { say?: string; text?: string }[]) => {
			const request = [...messages].reverse().find((message) => message.say === "api_req_started")
			return request?.text ? (JSON.parse(request.text) as { tokensIn?: number }).tokensIn : undefined
		}

		// The first save that carries the usage numbers is the background drain's save.
		// Another holder keeps the task fence for longer than the bounded wait.
		const save = task["saveClineMessages"].bind(task)
		let contended = false
		task["saveClineMessages"] = async (merge?: boolean) => {
			if (contended || usageOf(task.clineMessages) !== 7) return save(merge)
			contended = true
			const holder = await new ParentHandoffFence(root).acquire("parent")
			try {
				return await save(merge)
			} finally {
				await holder.release()
			}
		}
		const schedule = task["scheduleUsageSaveRetry"].bind(task)
		let scheduled = 0
		task["scheduleUsageSaveRetry"] = () => {
			scheduled++
			schedule()
		}
		let calls = 0
		vi.spyOn(task, "attemptApiRequest").mockImplementation(async function* () {
			if (++calls > 1) {
				task.abort = true
				return
			}
			yield { type: "text", text: "done" }
			yield { type: "usage", inputTokens: 7, outputTokens: 3 }
		} as never)

		const run = track(task.recursivelyMakeClineRequests([{ type: "text", text: "go" }]).catch(() => false))
		await vi.waitFor(() => expect(warnings.join("\n")).toContain("Skipped usage save for task parent"), {
			timeout: 3_000,
			interval: 20,
		})
		await run

		expect(scheduled).toBe(1)
		expect(await task["saveClineMessages"]()).toBe(true)
		expect({
			contended,
			refused: task["persistenceAuthority"].refused,
			inMemory: usageOf(task.clineMessages),
			onDisk: usageOf(await readTaskMessages({ taskId: "parent", globalStoragePath: root })),
			history: JSON.parse(await fs.readFile(path.join(root, "tasks", "parent", "history_item.json"), "utf8"))
				.tokensIn,
			drainErrors: errors.filter((line) =>
				/Error draining stream for usage data|Background usage collection failed/.test(line),
			),
		}).toEqual({ contended: true, refused: false, inMemory: 7, onDisk: 7, history: 7, drainErrors: [] })
	})
})

describe("Case 19: one deferred retry after a contention-skipped usage save", () => {
	/** Matches USAGE_SAVE_RETRY_DELAY_MS in Task.ts. */
	const RETRY_DELAY_MS = 1_000
	const usageOf = (messages: { say?: string; text?: string }[]) => {
		const request = [...messages].reverse().find((message) => message.say === "api_req_started")
		return request?.text ? (JSON.parse(request.text) as { tokensIn?: number }).tokensIn : undefined
	}
	const onDisk = async () => ({
		ui: usageOf(await readTaskMessages({ taskId: "parent", globalStoragePath: root })),
		history: JSON.parse(await fs.readFile(path.join(root, "tasks", "parent", "history_item.json"), "utf8"))
			.tokensIn,
	})

	/** The state a contention-skipped drain save leaves: usage only in the in-memory api_req_started. */
	async function skippedUsage() {
		const f = await fixture()
		const task = await f.instance("parent")
		// History metrics skip the first message, which is the task text in production.
		await task.say("text", "offline root")
		task.clineMessages.push({
			ts: Date.now(),
			type: "say",
			say: "api_req_started",
			text: JSON.stringify({ tokensIn: 7, tokensOut: 3, cost: 0 }),
		})
		const save = task["saveClineMessages"].bind(task)
		const saves: number[] = []
		task["saveClineMessages"] = async (merge?: boolean) => {
			saves.push(Date.now())
			// Tracked so cleanup waits for the save's fence release, not just its visible write.
			return track(save(merge))
		}
		const warnings: string[] = []
		vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
			warnings.push(args.map(String).join(" "))
		})
		return { task, saves, warnings }
	}

	it("persists the skipped usage to ui_messages and history_item with no later save", async () => {
		const { task, saves } = await skippedUsage()
		expect(await onDisk()).toEqual({ ui: undefined, history: 0 })

		task["scheduleUsageSaveRetry"]()
		task["scheduleUsageSaveRetry"]() // A second skip before it fires shares the one pending retry.

		await vi.waitFor(async () => expect(await onDisk()).toEqual({ ui: 7, history: 7 }), {
			timeout: RETRY_DELAY_MS * 5,
			interval: 50,
		})
		expect(saves).toHaveLength(1)
	})

	it("a retry that hits contention again runs exactly once, logs the possible loss, and is not rescheduled", async () => {
		const { task, saves, warnings } = await skippedUsage()
		const holder = await new ParentHandoffFence(root).acquire("parent")
		try {
			task["scheduleUsageSaveRetry"]()
			await vi.waitFor(
				() => expect(warnings.join("\n")).toContain("Deferred usage save for task parent failed"),
				{ timeout: RETRY_DELAY_MS + COMPRESSED_FENCE_WAIT_MS * 3, interval: 50 },
			)
			// Longer than another full delay plus bounded wait: nothing else may try.
			await delay(RETRY_DELAY_MS * 2 + COMPRESSED_FENCE_WAIT_MS)
		} finally {
			await holder.release()
		}

		expect({
			saves: saves.length,
			refused: task["persistenceAuthority"].refused,
			disk: await onDisk(),
		}).toEqual({ saves: 1, refused: false, disk: { ui: undefined, history: 0 } })
	})

	it.each([
		["the instance is aborted", (task: Task) => void (task.abort = true)],
		["the instance is disposed", (task: Task) => void task.dispose()],
		[
			"persistence authority was refused for a sticky reason",
			(task: Task) => void (task["persistenceAuthority"].refused = true),
		],
	])("runs no retry when %s", async (_name, end) => {
		const { task, saves } = await skippedUsage()
		task["scheduleUsageSaveRetry"]()
		end(task)
		const before = saves.length

		await delay(RETRY_DELAY_MS * 2)

		expect(saves.length).toBe(before)
	})

	it("skips the retry when a newer save already persisted the messages", async () => {
		const { task, saves } = await skippedUsage()
		task["scheduleUsageSaveRetry"]()
		expect(await task["saveClineMessages"]()).toBe(true)

		await delay(RETRY_DELAY_MS * 2)

		expect({ saves: saves.length, disk: await onDisk() }).toEqual({ saves: 1, disk: { ui: 7, history: 7 } })
	})
})
