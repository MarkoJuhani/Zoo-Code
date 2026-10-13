import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { TelemetryService } from "@roo-code/telemetry"
import { RooCodeEventName, type HistoryItem } from "@roo-code/types"
import { Task } from "../Task"
import { TaskScheduler } from "../TaskScheduler"
import { TaskRegistry } from "../TaskRegistry"
import { TaskHistoryStore } from "../../task-persistence/TaskHistoryStore"
import {
	withProviderStartExclusion,
	providerStartExclusionDiagnostics,
	advanceOrdinaryPersistenceAuthority,
} from "../../task-persistence/targetPersistenceBoundary"
import { ParentHandoffFence } from "../../task-persistence/parentHandoffFence"
import { ClineProvider, DelegationRecoverableError, scheduleTask } from "../../webview/ClineProvider"
import { OutputInterceptor } from "../../../integrations/terminal/OutputInterceptor"
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

function signal() {
	let release!: () => void
	const promise = new Promise<void>((resolve) => {
		release = resolve
	})
	return { promise, release }
}
const pending = new Set<Promise<unknown>>()
function track<T>(promise: Promise<T>): Promise<T> {
	pending.add(promise)
	void promise.then(
		() => pending.delete(promise),
		() => pending.delete(promise),
	)
	return promise
}
let root: string
let store: TaskHistoryStore
const tasks: Task[] = []
const gates: ReturnType<typeof signal>[] = []
beforeEach(async () => {
	if (!TelemetryService.hasInstance()) TelemetryService.createInstance([])
	root = await fs.mkdtemp(path.join(os.tmpdir(), "ordinary-delegation-composition-"))
	store = new TaskHistoryStore(root)
	await store.initialize()
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

async function fixture() {
	const registry = new TaskRegistry()
	const scheduler = new TaskScheduler(1)
	const scheduled: Promise<void>[] = []
	const stages: string[] = []
	const errors: unknown[] = []
	const transitions: Promise<Task>[] = []
	// Constructor-only VS Code/MCP activation is excluded. This provider shell
	// executes real transitions, registry teardown, store and file publications.
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
		postStateToWebviewWithoutTaskHistory: vi.fn(async () => {}),
		postStateToWebviewThrottled: vi.fn(async () => {}),
		flushPostStateToWebviewThrottled: vi.fn(async () => {}),
		postMessageToWebview: vi.fn(async () => {}),
		handleModeSwitch: vi.fn(async () => {}),
		emit: vi.fn(),
		taskScheduler: scheduler,
	})
	const delegate = provider.delegateParentAndOpenChild.bind(provider)
	vi.spyOn(provider, "delegateParentAndOpenChild").mockImplementation((params) => {
		const result = track(delegate(params))
		transitions.push(result)
		return result
	})
	const originalSchedule = scheduler.schedule.bind(scheduler)
	vi.spyOn(scheduler, "schedule").mockImplementation((task, run, observe) => {
		const result = track(
			originalSchedule(task, run, (stage, error) => {
				stages.push(`${task.taskId}:${stage}`)
				if (error) errors.push(error)
				observe?.(stage, error)
			}),
		)
		scheduled.push(result)
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
		const child = await instance("child", parentTask)
		vi.spyOn(child, "recursivelyMakeClineRequests").mockResolvedValue(true)
		return child
	})
	provider.createTaskWithHistoryItem = vi.fn(async (item) => instance(item.id, undefined, item))
	const parent = await instance("parent")
	return { provider, parent, scheduler, scheduled, stages, errors, registry, transitions, instance }
}

type Diagnostic = {
	correlation: string
	task: string
	instance: string | null
	action: string | null
	child: string | null
	transition: number | null
	phase: string
	stage: string
	disposition: string
	ownership: string
	guard: { active: boolean; generation: number | null; ownerCorrelation: string | null }
	failure?: { type: string; code?: string }
	elapsedMs: number
	phaseElapsedMs: number
}
function diagnostics(f: Awaited<ReturnType<typeof fixture>>): Diagnostic[] {
	return vi
		.mocked(f.provider.log)
		.mock.calls.map(([message]) => message)
		.filter((message) => message.startsWith("[ordinary_delegation] "))
		.map((message) => JSON.parse(message.slice("[ordinary_delegation] ".length)) as Diagnostic)
}
function ordered(records: Diagnostic[], expected: string[]) {
	const phases = records.map((record) => `${record.phase}:${record.stage}`)
	let previous = -1
	for (const phase of expected) {
		const next = phases.indexOf(phase, previous + 1)
		expect(next, `${phase} after ${expected.slice(0, expected.indexOf(phase)).join(",")}`).toBeGreaterThan(previous)
		previous = next
	}
}

function questionEvents(task: Task) {
	const ready = signal(),
		delivered = signal()
	const prepare = task["prepareAsk"].bind(task)
	task["prepareAsk"] = async (...args) => {
		const wait = await prepare(...args)
		return () => {
			const answer = wait()
			if (task["activeQuestionWaitId"]) ready.release()
			return answer
		}
	}
	const push = task.pushToolResultToUserContent.bind(task)
	vi.spyOn(task, "pushToolResultToUserContent").mockImplementation((block) => {
		const accepted = push(block)
		if (accepted && block.tool_use_id === "call") delivered.release()
		return accepted
	})
	return { ready, delivered }
}

async function nativeTurn(task: Task, name: "new_task" | "ask_followup_question") {
	const input =
		name === "new_task"
			? { mode: "code", message: "offline child", todos: "" }
			: { question: "Choose?", follow_up: [{ text: "A" }] }
	task["resetAssistantMessagePersistence"]()
	await task["addToApiConversationHistory"]({
		role: "assistant",
		content: [{ type: "tool_use", id: "call", name, input }],
	})
	task.assistantMessageContent = [
		{ type: "tool_use", name, id: "call", params: {}, nativeArgs: input, partial: false },
	]
	task.currentStreamingContentIndex = 0
	task.didCompleteReadingStream = true
	task["presentAssistantMessageSafe"]()
}
async function delegated(f: Awaited<ReturnType<typeof fixture>>) {
	await Promise.all(f.transitions)
	expect(f.provider.createTask).toHaveBeenCalledOnce()
	await Promise.all(f.scheduled)
	expect(f.stages).toContain("child:settled")
	const parent = await store.readAuthoritative("parent")
	const child = await store.readAuthoritative("child")
	expect(parent).toMatchObject({
		kind: "found",
		item: {
			status: "delegated",
			awaitingChildId: "child",
			delegatedToId: "child",
			childIds: ["child"],
		},
	})
	expect(parent.kind === "found" ? parent.item.pendingAction : "missing").toBeUndefined()
	expect(child).toMatchObject({
		kind: "found",
		item: { status: "active", parentTaskId: "parent", rootTaskId: "parent" },
	})
	expect(f.errors).toEqual([])
}

for (const entry of ["capable-callback", "ordinary"] as const) {
	it(`fresh actual scheduler/presenter/provider ${entry} owns gated final disposal after loop settlement`, async () => {
		const f = await fixture()
		const entered = signal(),
			finish = signal(),
			loopSettled = signal()
		gates.push(finish)
		const cleanup = OutputInterceptor.cleanup
		vi.spyOn(OutputInterceptor, "cleanup").mockImplementation(async (directory, ...rest) => {
			await cleanup.call(OutputInterceptor, directory, ...rest)
			if (directory.includes(`${path.sep}parent${path.sep}`)) {
				entered.release()
				await finish.promise
			}
		})
		vi.spyOn(f.parent, "recursivelyMakeClineRequests").mockImplementation(async () => {
			await nativeTurn(f.parent, "new_task")
			await vi.waitFor(() => expect(f.parent.abort).toBe(true))
			loopSettled.release()
			return true
		})
		const owner = track(
			entry === "ordinary"
				? f.scheduler.schedule(f.parent)
				: f.scheduler.schedule(f.parent, () => f.parent.run()),
		)
		let settled = false
		void owner.then(
			() => {
				settled = true
			},
			() => {
				settled = true
			},
		)
		await vi.waitFor(() => expect(f.parent.abort).toBe(true), { timeout: 2500 })
		await entered.promise
		await vi.waitFor(() => expect(f.parent.abort).toBe(true))
		// This barrier proves original loop settlement, not a wall-clock race.
		await loopSettled.promise
		if (entry === "ordinary") await owner
		expect(settled).toBe(entry === "ordinary")
		expect(f.provider.createTask).not.toHaveBeenCalled()
		const duringDisposal = diagnostics(f)
		expect(duringDisposal).toContainEqual(
			expect.objectContaining({
				phase: "parent_disposal",
				stage: "begin",
				guard: expect.objectContaining({ active: true }),
			}),
		)
		expect(
			duringDisposal.some((record) =>
				["parent_disposal:end", "fence_scope:end", "provider_return:end"].includes(
					`${record.phase}:${record.stage}`,
				),
			),
		).toBe(false)
		await expect(new ParentHandoffFence(root).acquire("parent", { timeoutMs: 0 })).rejects.toThrow(/fence|parent/i)
		finish.release()
		await owner
		await delegated(f)
		const records = diagnostics(f)
		ordered(records, [
			"transition_acquire:begin",
			"transition_acquire:end",
			"fence_acquire:begin",
			"fence_acquire:end",
			"parent_flush:begin",
			"parent_flush:end",
			"parent_disposal:begin",
			"parent_abort:begin",
			"parent_abort:end",
			"parent_disposal:end",
			"child_prepare:begin",
			"child_prepare:end",
			"durable_child:begin",
			"durable_child:end",
			"durable_parent:begin",
			"durable_parent:end",
			"enqueue:begin",
			"enqueue:end",
			"fence_scope:end",
			"provider_return:end",
			"scheduler:settled",
		])
		expect(new Set(records.map((record) => record.correlation)).size).toBe(1)
		const held = records.filter((record) =>
			["parent_disposal", "durable_child", "durable_parent"].includes(record.phase),
		)
		expect(held.every((record) => record.guard.active && record.guard.generation !== null)).toBe(true)
		expect(new Set(held.map((record) => record.guard.ownerCorrelation)).size).toBe(1)
		expect(held[0].guard.ownerCorrelation).toMatch(/^[a-f0-9]{16}$/)
		const ownerFiles = await fs.readdir(path.join(root, ".handoff-fences"))
		expect(ownerFiles.some((name) => name.endsWith(".lock"))).toBe(false)
	})
}

it("native delegation waits outside the fence for an approved turn's in-flight assistant save", async () => {
	const f = await fixture()
	const saving = signal(),
		finishSave = signal(),
		finishLoop = signal()
	gates.push(finishSave, finishLoop)
	const apiMessages = await import("../../task-persistence/apiMessages")
	const save = apiMessages.saveApiMessages
	vi.spyOn(apiMessages, "saveApiMessages").mockImplementation(async (options) => {
		if (options.taskId === "parent" && options.messages.some((message) => message.role === "assistant")) {
			saving.release()
			await finishSave.promise
		}
		return save(options)
	})
	const input = { mode: "code", message: "offline child", todos: "" }
	const wait = vi.spyOn(f.parent, "waitForCurrentAssistantMessagePersistence")
	const ask = f.parent.ask.bind(f.parent)
	let publication!: Promise<void>
	vi.spyOn(f.parent, "ask").mockImplementation(async (...args) => {
		const response = await ask(...args)
		if (args[0] === "tool" && args[2] !== true) {
			publication = track(
				f.parent["addToApiConversationHistory"]({
					role: "assistant",
					content: [{ type: "tool_use", id: "call", name: "new_task", input }],
				}),
			)
			await saving.promise
		}
		return response
	})
	vi.spyOn(f.parent, "recursivelyMakeClineRequests").mockImplementation(async () => {
		f.parent["resetAssistantMessagePersistence"]()
		f.parent.assistantMessageContent = [
			{ type: "tool_use", name: "new_task", id: "call", params: {}, nativeArgs: input, partial: false },
		]
		f.parent.currentStreamingContentIndex = 0
		f.parent.didCompleteReadingStream = true
		f.parent["presentAssistantMessageSafe"]()
		await finishLoop.promise
		return true
	})
	const run = track(f.scheduler.schedule(f.parent))
	await saving.promise
	await vi.waitFor(() => expect(wait.mock.calls.length + f.transitions.length).toBeGreaterThan(0))
	// The old native path attempts immediate acquisition while its own save holds this fence.
	expect(f.provider.delegateParentAndOpenChild).not.toHaveBeenCalled()
	expect(f.provider.createTask).not.toHaveBeenCalled()
	expect(f.parent.abort).toBe(false)
	await expect(new ParentHandoffFence(root).acquire("parent", { timeoutMs: 0 })).rejects.toThrow(/fence/)
	finishSave.release()
	await publication
	await vi.waitFor(() => expect(f.parent.abort).toBe(true))
	finishLoop.release()
	await run
	await delegated(f)
	const saved = JSON.parse(
		await fs.readFile(path.join(root, "tasks", "parent", "api_conversation_history.json"), "utf8"),
	)
	expect(saved.filter((message: { role: string }) => message.role === "assistant")).toHaveLength(1)
	expect(diagnostics(f).some((record) => record.stage === "failure")).toBe(false)
})

for (const terminal of ["cancelled", "failed"] as const) {
	it(`native delegation preserves the parent and pending action when assistant persistence is ${terminal}`, async () => {
		const f = await fixture()
		await f.parent.say("text", "offline parent")
		await store.upsert({ ...store.get("parent")!, status: "active" })
		f.parent["resetAssistantMessagePersistence"]()
		const { newTaskTool } = await import("../../tools/NewTaskTool")
		const wait = vi.spyOn(f.parent, "waitForCurrentAssistantMessagePersistence")
		const handleError = vi.fn(async () => {})
		const pushToolResult = vi.fn()
		const attempt = track(
			newTaskTool.execute({ mode: "code", message: "offline child", todos: "" }, f.parent, {
				askApproval: async () => true,
				handleError,
				pushToolResult,
				toolCallId: "call",
			}),
		)
		await vi.waitFor(() => expect(wait).toHaveBeenCalledOnce())
		// Waiting holds no capable scope: a cooperating holder can acquire normally.
		const lease = await new ParentHandoffFence(root).acquire("parent", { timeoutMs: 0 })
		await lease.release()
		if (terminal === "cancelled") {
			f.parent.abort = true
			f.parent["cancelAssistantMessagePersistence"]()
		} else {
			f.parent["retrySaveApiConversationHistoryWithCancellation"] = vi.fn(async () => false)
			f.parent["resolveAssistantMessagePersistence"](false)
		}
		await attempt
		expect(f.provider.delegateParentAndOpenChild).not.toHaveBeenCalled()
		expect(f.provider.createTask).not.toHaveBeenCalled()
		expect(f.registry.current).toBe(f.parent)
		expect(pushToolResult).not.toHaveBeenCalled()
		expect(handleError).toHaveBeenCalledTimes(terminal === "failed" ? 1 : 0)
		expect(await store.readAuthoritative("parent")).toMatchObject({
			kind: "found",
			item: { status: "active", pendingAction: { kind: "create_subtask", actionId: "call" } },
		})
	})
}

it("normal ungated fresh handoff durably saves one child and admits its actual run", async () => {
	const f = await fixture()
	vi.spyOn(f.parent, "recursivelyMakeClineRequests").mockImplementation(async () => {
		await nativeTurn(f.parent, "new_task")
		await vi.waitFor(() => expect(f.parent.abort).toBe(true))
		return true
	})
	await track(f.scheduler.schedule(f.parent, () => f.parent.run()))
	await delegated(f)
})

it("teardown failure publishes no child and leaves authoritative parent resumable", async () => {
	const f = await fixture()
	// A failed final disposal effect, not a provider/tool replacement.
	f.parent["diffReversionPromise"] = Promise.reject(new Error("injected final teardown failure"))
	void f.parent["diffReversionPromise"].catch(() => {})
	vi.spyOn(f.parent, "recursivelyMakeClineRequests").mockImplementation(async () => {
		await nativeTurn(f.parent, "new_task")
		await vi.waitFor(() => expect(f.parent.abort).toBe(true))
		return true
	})
	await track(f.scheduler.schedule(f.parent, () => f.parent.run()))
	await Promise.allSettled(f.transitions)
	expect(f.provider.createTask).not.toHaveBeenCalled()
	expect(await store.readAuthoritative("parent")).toMatchObject({
		kind: "found",
		item: {
			pendingAction: { kind: "create_subtask", actionId: "call" },
		},
	})
	expect(await store.readAuthoritative("child")).toMatchObject({ kind: "missing" })
	// Provider-owned remaining blocker: durable recovery evidence is not a focused UI.
	expect(f.registry.current?.taskId).toBe("parent")
})

it("phase-scoped fresh scheduler run answers an externally owned question without retaining an idle lease", async () => {
	const f = await fixture()
	const events = questionEvents(f.parent)
	const result = signal()
	gates.push(result)
	vi.spyOn(f.parent, "recursivelyMakeClineRequests").mockImplementation(async () => {
		await nativeTurn(f.parent, "ask_followup_question")
		await result.promise
		await f.parent["addToApiConversationHistory"]({ role: "user", content: f.parent.userMessageContent })
		return true
	})
	const run = track(f.scheduler.schedule(f.parent))
	await events.ready.promise
	expect(f.parent["activeQuestionWaitId"]).toBeTruthy()
	const question = structuredClone(f.parent.pendingQuestion!)
	const external = await new ParentHandoffFence(root).acquire("parent", { timeoutMs: 0 })
	await external.release()
	f.parent.handleWebviewAskResponse("messageResponse", "external answer", undefined, {
		taskId: "parent",
		questionId: question.id,
		explicitAnswer: true,
	})
	await vi.waitFor(() =>
		expect(
			f.parent.userMessageContent.some((block) => block.type === "tool_result" && block.tool_use_id === "call"),
		).toBe(true),
	)
	result.release()
	await run
	const current = await store.readAuthoritative("parent")
	expect(current.kind).toBe("found")
	expect(current.kind === "found" ? current.item.pendingQuestion : "missing").toBeUndefined()
	expect(f.errors).toEqual([])
})

it("phase-scoped scheduler history resume records one exact answer result before the continuation loop", async () => {
	const f = await fixture()
	await f.parent.say("text", "offline root")
	await nativeTurn(f.parent, "ask_followup_question")
	await vi.waitFor(() => expect(f.parent["activeQuestionWaitId"]).toBeTruthy())
	await f.parent.abortTask()
	const saved = await store.readAuthoritative("parent")
	if (saved.kind !== "found") throw new Error("missing saved question")
	const resumed = await f.provider.createTaskWithHistoryItem(saved.item, { startTask: false })
	const loopEntered = signal(),
		loopFinish = signal()
	gates.push(loopFinish)
	vi.spyOn(resumed, "recursivelyMakeClineRequests").mockImplementation(async () => {
		loopEntered.release()
		await loopFinish.promise
		return true
	})
	const run = track(f.scheduler.schedule(resumed))
	await vi.waitFor(() => expect(resumed["activeQuestionWaitId"]).toBe(saved.item.pendingQuestion!.id))
	const external = await new ParentHandoffFence(root).acquire("parent", { timeoutMs: 0 })
	await external.release()
	resumed.handleWebviewAskResponse("messageResponse", "saved external answer", undefined, {
		taskId: "parent",
		questionId: saved.item.pendingQuestion!.id,
		explicitAnswer: true,
	})
	await loopEntered.promise
	const duringLoop = await new ParentHandoffFence(root).acquire("parent", { timeoutMs: 0 })
	await duringLoop.release()
	const messages = JSON.parse(
		await fs.readFile(path.join(root, "tasks", "parent", "api_conversation_history.json"), "utf8"),
	)
	const results = messages
		.flatMap((message: { content: { type: string; tool_use_id?: string }[] | string }) =>
			typeof message.content === "string" ? [] : message.content,
		)
		.filter(
			(block: { type: string; tool_use_id?: string }) =>
				block.type === "tool_result" && block.tool_use_id === "call",
		)
	expect(results).toHaveLength(1)
	const current = await store.readAuthoritative("parent")
	expect(current.kind).toBe("found")
	expect(current.kind === "found" ? current.item.pendingQuestion : "missing").toBeUndefined()
	loopFinish.release()
	await run
	expect(f.errors).toEqual([])
})

it("actual scheduler arbitrary callback keeps its capable lease and refuses a question idle wait", async () => {
	const f = await fixture()
	await f.parent.say("text", "offline root")
	const entered = signal(),
		finish = signal()
	gates.push(finish)
	const run = track(
		f.scheduler.schedule(f.parent, async () => {
			await f.parent["addToApiConversationHistory"]({
				role: "assistant",
				content: [{ type: "tool_use", id: "call", name: "ask_followup_question", input: {} }],
			})
			await f.parent.registerQuestion("owned question", "call")
			await expect(f.parent.ask("followup", "owned question", false)).rejects.toThrow(/independent orchestration/)
			entered.release()
			await finish.promise
		}),
	)
	await entered.promise
	await expect(new ParentHandoffFence(root).acquire("parent", { timeoutMs: 0 })).rejects.toThrow(/parent|fence/)
	finish.release()
	await run
})

it("refuses active fresh reacquisition immediately instead of deadlocking or surrendering ownership", async () => {
	const f = await fixture()
	await withProviderStartExclusion(root, "parent", async () => {
		await expect(withProviderStartExclusion(root, "parent", async () => {}, { fresh: true })).rejects.toThrow(
			/inherited capable scope/,
		)
		await expect(new ParentHandoffFence(root).acquire("parent", { timeoutMs: 0 })).rejects.toThrow(/parent|fence/)
	})
	expect(f.provider.createTask).not.toHaveBeenCalled()
})

it("actual scheduler question wait rejects a delayed external answer after immutable revision changes", async () => {
	const f = await fixture()
	await f.parent.say("text", "offline root")
	await nativeTurn(f.parent, "ask_followup_question")
	await vi.waitFor(() => expect(f.parent["activeQuestionWaitId"]).toBeTruthy())
	await f.parent.abortTask()
	const saved = await store.readAuthoritative("parent")
	if (saved.kind !== "found") throw new Error("missing saved question")
	const resumed = await f.provider.createTaskWithHistoryItem(saved.item, { startTask: false })
	const continuation = vi.spyOn(resumed, "recursivelyMakeClineRequests").mockResolvedValue(true)
	const run = track(f.scheduler.schedule(resumed))
	await vi.waitFor(() => expect(resumed["activeQuestionWaitId"]).toBe(saved.item.pendingQuestion!.id))
	await withProviderStartExclusion(root, "parent", () =>
		store.atomicReadAndUpdate("parent", advanceOrdinaryPersistenceAuthority),
	)
	const names = ["history_item.json", "ui_messages.json", "api_conversation_history.json"]
	const bytes = () => Promise.all(names.map((name) => fs.readFile(path.join(root, "tasks", "parent", name), "utf8")))
	const before = await bytes()
	resumed.handleWebviewAskResponse("messageResponse", "stale answer", undefined, {
		taskId: "parent",
		questionId: saved.item.pendingQuestion!.id,
		explicitAnswer: true,
	})
	await vi.waitFor(() => expect(resumed["acceptingQuestionAnswer"]).toBe(false))
	expect(resumed["persistenceAuthority"].refused).toBe(true)
	expect(await bytes()).toEqual(before)
	expect(continuation).not.toHaveBeenCalled()
	resumed.abort = true
	await run.catch(() => {})
})

it("ordinary provider default scheduling opens an externally answerable full-question waiter", async () => {
	const f = await fixture()
	vi.spyOn(f.parent, "recursivelyMakeClineRequests").mockImplementation(async () => {
		await nativeTurn(f.parent, "ask_followup_question")
		await vi.waitFor(() => expect(f.parent.pendingQuestion).toBeDefined())
		return true
	})
	expect(scheduleTask(f.scheduler, f.parent, "ordinary-provider-composition")).toBe(true)
	await vi.waitFor(() => expect(f.stages).toContain("parent:settled"))
	// The presenter is detached: metadata registration precedes its capable ask
	// preparation. Synchronize on the waiter, not mere model-loop settlement.
	await vi.waitFor(() => expect(f.parent["activeQuestionWaitId"]).toBe(f.parent.pendingQuestion!.id))
	// Do not bypass provider's real default-runner choice: this assertion stays red
	// until the parent routes ordinary scheduling through the no-runner entry.
	expect(f.parent["activeQuestionWaitId"]).toBe(f.parent.pendingQuestion!.id)
})

it("routes bounded safe diagnostics to provider output and observes asynchronous child-start failure without undoing enqueue", async () => {
	const f = await fixture()
	const outputChannel = { appendLine: vi.fn() }
	Object.assign(f.provider, { outputChannel })
	vi.spyOn(console, "log").mockImplementation(() => {})
	vi.mocked(f.provider.log).mockImplementation((message) => ClineProvider.prototype.log.call(f.provider, message))
	await f.parent.say("text", "offline root")
	const begin = signal(),
		finish = signal()
	gates.push(finish)
	const failure = Object.assign(new Error("secret prompt transcript api-key profile-name"), { code: "EIO" })
	f.provider.createTask = vi.fn(async (_message, _images, parentTask) => {
		const child = await f.instance("child", parentTask)
		vi.spyOn(child, "runScheduled").mockImplementation(async () => {
			begin.release()
			await finish.promise
			throw failure
		})
		return child
	})
	const child = await f.provider.delegateParentAndOpenChild({
		parentTaskId: "parent",
		message: "secret prompt",
		initialTodos: [],
		mode: "code",
		pendingActionId: undefined,
	})
	await begin.promise
	const beforeFailure = diagnostics(f)
	expect(beforeFailure).toContainEqual(expect.objectContaining({ phase: "enqueue", stage: "end" }))
	expect(beforeFailure).toContainEqual(expect.objectContaining({ phase: "provider_return", stage: "end" }))
	expect(
		beforeFailure.some((record) => record.phase === "scheduler" && ["settled", "failed"].includes(record.stage)),
	).toBe(false)
	finish.release()
	await Promise.allSettled(f.scheduled)
	const records = diagnostics(f)
	expect(records).toContainEqual(
		expect.objectContaining({
			phase: "scheduler",
			stage: "failed",
			child: child.taskId,
			disposition: "parent_committed",
			failure: { type: "effect_failed", code: "EIO" },
		}),
	)
	expect(records.some((record) => record.phase === "scheduler" && record.stage === "settled")).toBe(false)
	expect(new Set(records.map((record) => record.correlation)).size).toBe(1)
	const output = vi
		.mocked(f.provider.log)
		.mock.calls.map(([message]) => message)
		.join("\n")
	expect(output).not.toMatch(/secret prompt|transcript|api-key|profile-name/)
	expect(outputChannel.appendLine.mock.calls).toEqual(vi.mocked(f.provider.log).mock.calls)
	expect(records.every((record) => record.elapsedMs >= 0 && record.phaseElapsedMs >= 0)).toBe(true)
	expect(records.length).toBeLessThan(128)
	expect(await store.readAuthoritative("parent")).toMatchObject({
		kind: "found",
		item: { status: "delegated", awaitingChildId: child.taskId },
	})
	expect(await store.readAuthoritative(child.taskId)).toMatchObject({ kind: "found", item: { status: "active" } })
})

it("logs fence acquisition refusal before any parent effect and never logs arbitrary error codes or owner tokens", async () => {
	const f = await fixture()
	await f.parent.say("text", "offline root")
	const lease = await new ParentHandoffFence(root).acquire("parent", { timeoutMs: 0 })
	try {
		await expect(
			f.provider.delegateParentAndOpenChild({
				parentTaskId: "parent",
				message: "private",
				initialTodos: [],
				mode: "code",
			}),
		).rejects.toMatchObject({ name: "ParentHandoffFenceUnavailableError" })
		const records = diagnostics(f)
		ordered(records, [
			"transition_acquire:begin",
			"transition_acquire:end",
			"fence_acquire:begin",
			"fence_acquire:failure",
		])
		expect(records.some((record) => record.phase === "parent_abort")).toBe(false)
		expect(records.find((record) => record.phase === "fence_acquire" && record.stage === "failure")).toMatchObject({
			ownership: "acquire",
			guard: { active: false, generation: null, ownerCorrelation: null },
			failure: { type: "authority_refused" },
		})
		expect(JSON.stringify(records)).not.toContain(lease.ownerToken)
	} finally {
		await lease.release()
	}
	await withProviderStartExclusion(root, "parent", async () => {
		const guard = providerStartExclusionDiagnostics(root, "parent")
		expect(guard).toMatchObject({ scope: "inherited", active: true })
		const recorder = f.provider.createDelegationDiagnostics({
			taskId: "parent",
			instanceId: f.parent.instanceId,
			actionId: "unsafe\nsecret",
			childId: "child",
		})
		for (let i = 0; i < 160; i++) recorder.event("tool_handoff", "failure", { code: "SECRET" })
		const records = diagnostics(f).filter((record) => record.correlation === recorder.correlation)
		expect(records).toHaveLength(128)
		expect(
			records.every((record) => record.action?.startsWith("hash-") && record.failure?.code === undefined),
		).toBe(true)
		expect(providerStartExclusionDiagnostics(root, "parent")).toEqual(guard)
	})
})

it("holds restoration ownership through its last focused-state effect and returns a typed recoverable refusal", async () => {
	const f = await fixture()
	await f.parent.say("text", "offline root")
	const failure = new Error("injected final cleanup failure")
	f.parent["diffReversionPromise"] = Promise.reject(failure)
	void f.parent["diffReversionPromise"].catch(() => {})
	const entered = signal(),
		finish = signal()
	gates.push(finish)
	vi.mocked(f.provider.postStateToWebviewWithoutTaskHistory).mockImplementation(async () => {
		entered.release()
		await finish.promise
	})
	const transition = track(
		f.provider.delegateParentAndOpenChild({
			parentTaskId: "parent",
			message: "offline child",
			initialTodos: [],
			mode: "code",
		}),
	)
	void transition.catch(() => {})
	await entered.promise
	expect(f.registry.current?.taskId).toBe("parent")
	expect(f.registry.current).not.toBe(f.parent)
	expect(f.provider.createTaskWithHistoryItem).toHaveBeenCalledWith(expect.objectContaining({ id: "parent" }), {
		startTask: false,
	})
	expect(diagnostics(f).some((record) => record.phase === "parent_restore" && record.stage === "end")).toBe(false)
	await expect(new ParentHandoffFence(root).acquire("parent", { timeoutMs: 0 })).rejects.toThrow(/held|fence/)
	finish.release()
	await expect(transition).rejects.toBeInstanceOf(DelegationRecoverableError)
	await expect(transition).rejects.toMatchObject({ originalError: failure, disposition: "parent_restored" })
	ordered(diagnostics(f), [
		"parent_disposal:failure",
		"parent_restore:begin",
		"parent_restore:end",
		"fence_scope:failure",
		"provider_return:failure",
	])
	const lease = await new ParentHandoffFence(root).acquire("parent", { timeoutMs: 0 })
	await lease.release()
	expect(f.provider.createTask).not.toHaveBeenCalled()
})

it.each(["revision", "action", "owner"] as const)(
	"refuses restoration after authoritative %s changes and retains exact durable evidence",
	async (change) => {
		const f = await fixture()
		await f.parent.say("text", "offline root")
		let changed = ""
		vi.spyOn(f.parent, "dispose").mockImplementation(async () => {
			await store.atomicReadAndUpdate("parent", (item) =>
				change === "revision"
					? advanceOrdinaryPersistenceAuthority(item)
					: change === "action"
						? {
								...item,
								pendingAction: {
									kind: "create_subtask",
									actionId: "replacement",
									approvalText: "offline",
									mode: "code",
									message: "replacement",
									todos: [],
								},
							}
						: {
								...item,
								status: "delegated",
								awaitingChildId: "moved-child",
								delegatedToId: "moved-child",
								childIds: ["moved-child"],
							},
			)
			changed = await fs.readFile(path.join(root, "tasks", "parent", "history_item.json"), "utf8")
			throw new Error("injected cleanup failure after authority change")
		})
		await expect(
			f.provider.delegateParentAndOpenChild({
				parentTaskId: "parent",
				message: "offline child",
				initialTodos: [],
				mode: "code",
			}),
		).rejects.toMatchObject({ name: "DelegationRecoverableError", disposition: "evidence_retained" })
		expect(f.provider.createTaskWithHistoryItem).not.toHaveBeenCalled()
		expect(f.provider.createTask).not.toHaveBeenCalled()
		expect(await fs.readFile(path.join(root, "tasks", "parent", "history_item.json"), "utf8")).toBe(changed)
	},
)

function questionWaitEntered(task: Task) {
	const entered = signal()
	const prepare = task["prepareAsk"].bind(task)
	// Observe the real private preparation/wait split; do not replace its effects.
	const preparation = task as unknown as { prepareAsk: Task["prepareAsk"] }
	vi.spyOn(preparation, "prepareAsk").mockImplementation(async (...args) => {
		const wait = await prepare(...args)
		return () => {
			const result = wait()
			if (args[0] === "followup" && args[5]) {
				expect(task["activeQuestionWaitId"]).toBe(task.pendingQuestion!.id)
				entered.release()
			}
			return result
		}
	})
	return entered.promise
}

it("ordinary fallback opens an externally answerable question and ignores throwing observations", async () => {
	const f = await fixture()
	const waitEntered = questionWaitEntered(f.parent)
	const finish = signal(),
		settled = signal()
	gates.push(finish)
	vi.spyOn(f.parent, "recursivelyMakeClineRequests").mockImplementation(async () => {
		await nativeTurn(f.parent, "ask_followup_question")
		await finish.promise
		return true
	})
	const observed: string[] = []
	expect(
		scheduleTask(undefined, f.parent, "fallback", undefined, (stage) => {
			observed.push(stage)
			if (stage === "settled") settled.release()
			throw new Error("observer")
		}),
	).toBe(true)
	await waitEntered
	expect(f.parent["activeQuestionWaitId"]).toBe(f.parent.pendingQuestion!.id)
	const lease = await new ParentHandoffFence(root).acquire("parent", { timeoutMs: 0 })
	await lease.release()
	finish.release()
	await settled.promise
	expect(observed).toContain("settled")
	expect(observed).toEqual(["admitted", "started", "settled"])
})

it("custom fallback remains protected to its last effect even with throwing observers and output sink", async () => {
	const f = await fixture()
	await f.parent.say("text", "offline root")
	const entered = signal(),
		finish = signal()
	gates.push(finish)
	vi.mocked(f.provider.log).mockImplementation(() => {
		throw new Error("sink")
	})
	const recorder = f.provider.createDelegationDiagnostics({ taskId: "parent" })
	const observed: string[] = []
	expect(
		scheduleTask(
			undefined,
			f.parent,
			"custom",
			async () => {
				entered.release()
				await finish.promise
			},
			(stage) => {
				observed.push(stage)
				recorder.event("scheduler", stage)
				throw new Error("observer")
			},
		),
	).toBe(true)
	await entered.promise
	await expect(new ParentHandoffFence(root).acquire("parent", { timeoutMs: 0 })).rejects.toThrow(/held|fence/)
	finish.release()
	await vi.waitFor(() => expect(observed).toContain("settled"))
	const lease = await new ParentHandoffFence(root).acquire("parent", { timeoutMs: 0 })
	await lease.release()
	expect(observed).toEqual(["admitted", "started", "settled"])
})

it("routes default scheduling failures to Zoo output without an explicit observer", async () => {
	const f = await fixture()
	const failure = Object.assign(new Error("private transcript and credentials"), { code: "ENOSPC" })
	vi.spyOn(f.parent, "runScheduled").mockRejectedValueOnce(failure)
	expect(scheduleTask(f.scheduler, f.parent, "ordinary-default")).toBe(true)
	await Promise.allSettled(f.scheduled)
	expect(diagnostics(f)).toContainEqual(
		expect.objectContaining({
			phase: "scheduler",
			stage: "failed",
			failure: { type: "effect_failed", code: "ENOSPC" },
		}),
	)
	expect(JSON.stringify(diagnostics(f))).not.toContain("private transcript")
})

it("observes a continuation refusal before custom callback entry without taking ownership or invoking it", async () => {
	const f = await fixture()
	await f.parent.say("text", "offline root")
	await store.atomicReadAndUpdate("parent", advanceOrdinaryPersistenceAuthority)
	const run = vi.fn(async () => {})
	const stages: string[] = []
	expect(
		scheduleTask(f.scheduler, f.parent, "reopenParentFromDelegation", run, (stage) => stages.push(stage), true),
	).toBe(true)
	await Promise.allSettled(f.scheduled)
	expect(stages).toEqual(["admitted", "failed"])
	expect(run).not.toHaveBeenCalled()
	const lease = await new ParentHandoffFence(root).acquire("parent", { timeoutMs: 0 })
	await lease.release()
})

it("restores a stopped parent after failed redelegation only when its interrupted-child lineage is unchanged", async () => {
	const f = await fixture()
	await f.parent.say("text", "offline root")
	const parent = await store.readAuthoritative("parent")
	if (parent.kind !== "found") throw new Error("missing parent")
	await store.upsert({
		...parent.item,
		id: "old-child",
		status: "interrupted",
		parentTaskId: "parent",
		rootTaskId: "parent",
	})
	await store.atomicReadAndUpdate("parent", (item) => ({
		...item,
		status: "delegated",
		awaitingChildId: "old-child",
		delegatedToId: "old-child",
		childIds: ["old-child"],
	}))
	const before = await fs.readFile(path.join(root, "tasks", "parent", "history_item.json"), "utf8")
	const failure = new Error("injected final redelegation teardown failure")
	f.parent["diffReversionPromise"] = Promise.reject(failure)
	void f.parent["diffReversionPromise"].catch(() => {})
	await expect(
		f.provider.delegateParentAndOpenChild({
			parentTaskId: "parent",
			message: "replacement child",
			initialTodos: [],
			mode: "code",
		}),
	).rejects.toMatchObject({
		name: "DelegationRecoverableError",
		originalError: failure,
		disposition: "parent_restored",
	})
	expect(f.registry.current?.taskId).toBe("parent")
	expect(f.registry.current).not.toBe(f.parent)
	expect(f.provider.createTask).not.toHaveBeenCalled()
	expect(await fs.readFile(path.join(root, "tasks", "parent", "history_item.json"), "utf8")).toBe(before)
	expect(await store.readAuthoritative("old-child")).toMatchObject({
		kind: "found",
		item: { status: "interrupted", parentTaskId: "parent" },
	})
})

async function completingFixture(configure: (task: Task) => void) {
	// Workspace/editor collection is outside this offline lifecycle composition.
	vi.spyOn(environmentDetails, "getEnvironmentDetails").mockResolvedValue(
		"<environment_details>offline</environment_details>",
	)
	const f = await fixture()
	await f.parent.say("text", "offline root")
	await f.provider.delegateParentAndOpenChild({
		parentTaskId: "parent",
		message: "offline child",
		initialTodos: [],
		mode: "code",
	})
	await delegated(f)
	const create = vi.mocked(f.provider.createTaskWithHistoryItem).getMockImplementation()!
	vi.mocked(f.provider.createTaskWithHistoryItem).mockImplementation(async (...args) => {
		const task = await create(...args)
		configure(task)
		return task
	})
	return f
}

for (const scheduling of ["scheduler", "fallback"] as const) {
	it(`actual post-child ordinary continuation ${scheduling} durably answers an external followup without an idle fence`, async () => {
		let resumed!: Task
		let events!: ReturnType<typeof questionEvents>
		const settled = signal()
		const finish = signal()
		gates.push(finish)
		const f = await completingFixture((task) => {
			resumed = task
			events = questionEvents(task)
			vi.spyOn(task, "recursivelyMakeClineRequests").mockImplementation(async () => {
				await nativeTurn(task, "ask_followup_question")
				await finish.promise
				await events.delivered.promise
				expect(task.userMessageContent.some((block) => block.type === "tool_result")).toBe(true)
				await task["addToApiConversationHistory"]({ role: "user", content: task.userMessageContent })
				return true
			})
		})
		vi.mocked(f.provider.log).mockImplementation((message) => {
			if (!message.startsWith("[ordinary_delegation] ")) return
			const record: Diagnostic = JSON.parse(message.slice("[ordinary_delegation] ".length))
			if (record.phase === "parent_continuation" && record.stage === "settled") settled.release()
		})
		if (scheduling === "fallback") Reflect.deleteProperty(f.provider, "taskScheduler")
		const outcome = await f.provider.reopenParentFromDelegation({
			parentTaskId: "parent",
			childTaskId: "child",
			completionResultSummary: "real child result",
		})
		expect(outcome).toMatchObject({ kind: "committed", resumeState: "queued" })
		await events.ready.promise
		expect(resumed["activeQuestionWaitId"]).toBeTruthy()
		const question = structuredClone(resumed.pendingQuestion!)
		const external = await new ParentHandoffFence(root).acquire("parent", { timeoutMs: 0 })
		await external.release()
		resumed.handleWebviewAskResponse("messageResponse", "post-child external answer", undefined, {
			taskId: "parent",
			questionId: question.id,
			explicitAnswer: true,
		})
		await events.delivered.promise
		expect(
			resumed.userMessageContent.some((block) => block.type === "tool_result" && block.tool_use_id === "call"),
		).toBe(true)
		finish.release()
		await settled.promise
		expect(diagnostics(f)).toContainEqual(
			expect.objectContaining({ phase: "parent_continuation", stage: "settled" }),
		)
		const messages: { content: { type: string; tool_use_id?: string; content?: string }[] | string }[] = JSON.parse(
			await fs.readFile(path.join(root, "tasks", "parent", "api_conversation_history.json"), "utf8"),
		)
		const results = messages
			.flatMap((message) => (typeof message.content === "string" ? [] : message.content))
			.filter((block) => block.type === "tool_result" && block.tool_use_id === "call")
		expect(results).toHaveLength(1)
		expect(JSON.stringify(results[0])).toContain("post-child external answer")
		expect(await store.readAuthoritative("parent")).toMatchObject({
			kind: "found",
			item: { status: "active", completedByChildId: "child" },
		})
		const parent = await store.readAuthoritative("parent")
		expect(parent.kind === "found" ? parent.item.pendingQuestion : "missing").toBeUndefined()
		expect(await store.readAuthoritative("child")).toMatchObject({
			kind: "found",
			item: { status: "completed", parentTaskId: "parent" },
		})
		ordered(diagnostics(f), [
			"parent_continuation:admitted",
			"parent_continuation:started",
			"parent_continuation:settled",
		])
		expect(
			diagnostics(f)
				.filter((record) => record.phase === "parent_continuation")
				.every((record) => record.disposition === "parent_committed"),
		).toBe(true)
		expect(
			diagnostics(f)
				.filter((record) => record.phase === "parent_continuation")
				.some((record) => record.stage === "failed"),
		).toBe(false)
		expect(f.errors).toEqual([])
	})
}

for (const change of ["current-instance", "ownership", "transition", "revision"] as const) {
	it(`actual post-child continuation cancels ${change} changed in the prepared-admission gap`, async () => {
		const admitted = signal(),
			finish = signal()
		gates.push(finish)
		let resumed!: Task
		let loop!: ReturnType<typeof vi.fn<Task["recursivelyMakeClineRequests"]>>
		const f = await completingFixture((task) => {
			resumed = task
			loop = vi.spyOn(task, "recursivelyMakeClineRequests").mockResolvedValue(true)
			const resume = task.runScheduledResume.bind(task)
			vi.spyOn(task, "runScheduledResume").mockImplementation((authorize) =>
				resume(async (invoke) => {
					admitted.release()
					await finish.promise
					return authorize(invoke)
				}),
			)
		})
		expect(
			await f.provider.reopenParentFromDelegation({
				parentTaskId: "parent",
				childTaskId: "child",
				completionResultSummary: "child result",
			}),
		).toMatchObject({ kind: "committed", resumeState: "queued" })
		await admitted.promise
		const external = await new ParentHandoffFence(root).acquire("parent", { timeoutMs: 0 })
		await external.release()
		const start = vi.fn()
		resumed.on(RooCodeEventName.TaskStarted, start)
		if (change === "current-instance") await f.instance("parent")
		else if (change === "transition")
			f.provider["delegationTransitions"].set("parent", f.provider["delegationTransitions"].get("parent")! + 1)
		else if (change === "revision") await store.atomicReadAndUpdate("parent", advanceOrdinaryPersistenceAuthority)
		else
			await store.atomicReadAndUpdate("parent", (item) => ({
				...item,
				status: "delegated",
				awaitingChildId: "new-child",
				delegatedToId: "new-child",
				completedByChildId: undefined,
			}))
		const bytes = await fs.readFile(path.join(root, "tasks", "parent", "api_conversation_history.json"), "utf8")
		finish.release()
		await vi.waitFor(() =>
			expect(diagnostics(f)).toContainEqual(
				expect.objectContaining({ phase: "parent_continuation", stage: "cancelled" }),
			),
		)
		expect(loop).not.toHaveBeenCalled()
		expect(start).not.toHaveBeenCalled()
		expect(
			diagnostics(f)
				.filter((record) => record.phase === "parent_continuation")
				.map((record) => record.stage),
		).toEqual(["begin", "admitted", "cancelled"])
		expect(await fs.readFile(path.join(root, "tasks", "parent", "api_conversation_history.json"), "utf8")).toBe(
			bytes,
		)
		expect(f.errors).toEqual([])
	})
}

it("actual post-child authorization owns the matching invocation but not the resumed loop, and releases permits despite throwing observers", async () => {
	const entered = signal(),
		finish = signal(),
		invocation = signal(),
		permitFinish = signal(),
		readEntered = signal(),
		readFinish = signal()
	gates.push(finish, permitFinish, readFinish)
	let resumed!: Task
	let reading = false
	const order: string[] = []
	const metadata = ClineProvider.prototype.getTaskMetadata
	vi.spyOn(ClineProvider.prototype, "getTaskMetadata").mockImplementation(async function (this: ClineProvider, id) {
		const result = await metadata.call(this, id)
		if (id === "parent" && reading) {
			reading = false
			readEntered.release()
			await readFinish.promise
		}
		return result
	})
	const f = await completingFixture((task) => {
		resumed = task
		vi.spyOn(task, "recursivelyMakeClineRequests").mockImplementation(async () => {
			entered.release()
			await finish.promise
			return true
		})
		const resume = task.runScheduledResume.bind(task)
		vi.spyOn(task, "runScheduledResume").mockImplementation((authorize) =>
			resume((prepare) => {
				reading = true
				return authorize(async () => {
					const invoke = await prepare()
					return () => {
						invoke()
						order.push("invoked")
						invocation.release()
					}
				})
			}),
		)
	})
	const originalSchedule = vi.mocked(f.scheduler.schedule).getMockImplementation()!
	vi.spyOn(f.scheduler, "schedule").mockImplementation((task, runner, observe) =>
		originalSchedule(task, runner, (stage, error) => {
			observe?.(stage, error)
			throw new Error("observer outcome must be ignored")
		}),
	)
	const holder = await f.instance("permit-holder")
	f.registry.remove(holder.taskId)
	const holding = signal()
	const held = track(
		f.scheduler.schedule(holder, async () => {
			holding.release()
			await permitFinish.promise
		}),
	)
	await holding.promise
	expect(
		await f.provider.reopenParentFromDelegation({
			parentTaskId: "parent",
			childTaskId: "child",
			completionResultSummary: "child result",
		}),
	).toMatchObject({ kind: "committed", resumeState: "queued" })
	expect(f.scheduler.waiting).toBe(1)
	expect(
		diagnostics(f)
			.filter((record) => record.phase === "parent_continuation")
			.map((record) => record.stage),
	).toEqual(["begin"])
	permitFinish.release()
	await held
	await readEntered.promise
	for (const id of ["parent", "child"])
		await expect(new ParentHandoffFence(root).acquire(id, { timeoutMs: 0 })).rejects.toThrow(/parent|fence/)
	const successorTransition = track(
		f.provider["runDelegationTransition"]("parent", async () => {
			order.push("new-transition")
		}),
	)
	await Promise.resolve()
	expect(order).toEqual([])
	readFinish.release()
	await invocation.promise
	await entered.promise
	await successorTransition
	expect(order).toEqual(["invoked", "new-transition"])
	const lease = await new ParentHandoffFence(root).acquire("parent", { timeoutMs: 0 })
	await lease.release()
	expect(resumed.taskId).toBe("parent")
	finish.release()
	await vi.waitFor(() =>
		expect(diagnostics(f)).toContainEqual(
			expect.objectContaining({ phase: "parent_continuation", stage: "settled" }),
		),
	)
	ordered(diagnostics(f), [
		"parent_continuation:begin",
		"parent_continuation:admitted",
		"parent_continuation:started",
		"parent_continuation:settled",
	])
	const successor = await f.instance("successor")
	const executed = vi.fn(async () => {})
	await track(f.scheduler.schedule(successor, executed))
	expect(executed).toHaveBeenCalledOnce()
	expect(f.errors).toEqual([])
})

for (const change of ["current-instance", "transition"] as const) {
	it(`actual post-child continuation revalidates ${change} after capable preparation before invocation`, async () => {
		const prepared = signal(),
			finish = signal()
		gates.push(finish)
		let loop!: ReturnType<typeof vi.fn<Task["recursivelyMakeClineRequests"]>>
		const f = await completingFixture((task) => {
			loop = vi.spyOn(task, "recursivelyMakeClineRequests").mockResolvedValue(true)
			const resume = task.runScheduledResume.bind(task)
			vi.spyOn(task, "runScheduledResume").mockImplementation((authorize) =>
				resume((prepare) =>
					authorize(async () => {
						const invoke = await prepare()
						prepared.release()
						await finish.promise
						return invoke
					}),
				),
			)
		})
		expect(
			await f.provider.reopenParentFromDelegation({
				parentTaskId: "parent",
				childTaskId: "child",
				completionResultSummary: "child result",
			}),
		).toMatchObject({ kind: "committed", resumeState: "queued" })
		await prepared.promise
		await expect(new ParentHandoffFence(root).acquire("parent", { timeoutMs: 0 })).rejects.toThrow(/parent|fence/)
		if (change === "current-instance") await f.instance("parent")
		else f.provider["delegationTransitions"].set("parent", f.provider["delegationTransitions"].get("parent")! + 1)
		finish.release()
		await vi.waitFor(() =>
			expect(diagnostics(f)).toContainEqual(
				expect.objectContaining({ phase: "parent_continuation", stage: "cancelled" }),
			),
		)
		expect(loop).not.toHaveBeenCalled()
		expect(
			diagnostics(f)
				.filter((record) => record.phase === "parent_continuation")
				.map((record) => record.stage),
		).toEqual(["begin", "admitted", "cancelled"])
		expect(f.errors).toEqual([])
	})
}

it("actual post-child loop rejection reports failed once, not settled, and frees the real scheduler permit", async () => {
	const failure = new Error("injected resumed model failure")
	const f = await completingFixture((task) => {
		vi.spyOn(task, "recursivelyMakeClineRequests").mockRejectedValue(failure)
	})
	const originalSchedule = vi.mocked(f.scheduler.schedule).getMockImplementation()!
	vi.spyOn(f.scheduler, "schedule").mockImplementation((task, runner, observe) =>
		originalSchedule(task, runner, (stage, error) => {
			observe?.(stage, error)
			throw new Error("observer must not change model failure")
		}),
	)
	expect(
		await f.provider.reopenParentFromDelegation({
			parentTaskId: "parent",
			childTaskId: "child",
			completionResultSummary: "child result",
		}),
	).toMatchObject({ kind: "committed", resumeState: "queued" })
	await vi.waitFor(() =>
		expect(diagnostics(f)).toContainEqual(
			expect.objectContaining({ phase: "parent_continuation", stage: "failed" }),
		),
	)
	expect(
		diagnostics(f)
			.filter((record) => record.phase === "parent_continuation")
			.map((record) => record.stage),
	).toEqual(["begin", "admitted", "started", "failed"])
	expect(f.errors).toEqual([failure])
	const successor = await f.instance("successor")
	const ran = vi.fn(async () => {})
	await track(f.scheduler.schedule(successor, ran))
	expect(ran).toHaveBeenCalledOnce()
})

it("actual post-child continuation cancels a current-task change in the validation-to-invocation microtask gap", async () => {
	let armed = false
	let loop!: ReturnType<typeof vi.fn<Task["recursivelyMakeClineRequests"]>>
	const f = await completingFixture((task) => {
		loop = vi.spyOn(task, "recursivelyMakeClineRequests").mockResolvedValue(true)
		const resume = task.runScheduledResume.bind(task)
		vi.spyOn(task, "runScheduledResume").mockImplementation((authorize) =>
			resume((prepare) =>
				authorize(async () => {
					const invoke = await prepare()
					armed = true
					return invoke
				}),
			),
		)
	})
	const replacement = await f.instance("replacement")
	f.registry.remove(replacement.taskId)
	vi.spyOn(f.provider, "getCurrentTask").mockImplementation(() => {
		const task = f.registry.current
		if (armed) {
			armed = false
			queueMicrotask(() => f.registry.push(replacement))
		}
		return task
	})
	expect(
		await f.provider.reopenParentFromDelegation({
			parentTaskId: "parent",
			childTaskId: "child",
			completionResultSummary: "child result",
		}),
	).toMatchObject({ kind: "committed", resumeState: "queued" })
	await vi.waitFor(() =>
		expect(diagnostics(f)).toContainEqual(
			expect.objectContaining({ phase: "parent_continuation", stage: "cancelled" }),
		),
	)
	expect(f.registry.current).toBe(replacement)
	expect(loop).not.toHaveBeenCalled()
	expect(
		diagnostics(f)
			.filter((record) => record.phase === "parent_continuation")
			.map((record) => record.stage),
	).toEqual(["begin", "admitted", "cancelled"])
	expect(f.errors).toEqual([])
})

it.each([
	["complete", "approve"],
	["raw chunks", "approve"],
	["complete", "deny"],
	["raw chunks", "deny"],
	["complete", "cancel"],
	["raw chunks", "cancel"],
	["complete", "supersede"],
	["raw chunks", "supersede"],
] as const)(
	"delegated final text preserves a pending native file read and its durable correlated result (%s, %s)",
	async (encoding, decision) => {
		const f = await fixture()
		const child = await f.instance("auditor-child", f.parent)
		const source = path.join(root, "order-action.txt")
		await fs.writeFile(source, "DISPOSABLE_ORDER_ACTION_CONTENT\n")
		const getState = f.provider.getState.bind(f.provider)
		vi.spyOn(f.provider, "getState").mockImplementation(async () => ({
			...(await getState()),
			autoApprovalEnabled: false,
		}))
		Object.assign(child.rooIgnoreController!, { validateAccess: () => true })
		Object.assign(child.fileContextTracker, { trackFileContext: vi.fn(async () => {}) })
		vi.spyOn(environmentDetails, "getEnvironmentDetails").mockResolvedValue("offline disposable environment")
		vi.spyOn(child.diffViewProvider, "reset").mockResolvedValue(undefined)
		child["safeEnsureModelFetched"] = vi.fn(async () => child.api.getModel().info)
		const save = child["saveClineMessages"].bind(child)
		child["saveClineMessages"] = (...args) => track(save(...args))
		const approvalEntered = signal(),
			textPublished = signal(),
			continuationEntered = signal(),
			finish = signal()
		gates.push(finish)
		let approvalTs: number | undefined
		const prepare = child["prepareAsk"].bind(child)
		child["prepareAsk"] = async (...args) => {
			const wait = await prepare(...args)
			return () => {
				const response = wait()
				if (args[0] === "tool" && args[2] === false) {
					approvalTs = child.lastMessageTs
					approvalEntered.release()
				}
				return response
			}
		}
		const say = child.say.bind(child)
		vi.spyOn(child, "say").mockImplementation(async (...args) => {
			if (args[0] === "text" && args[3] === false) await approvalEntered.promise
			const result = await say(...args)
			if (args[0] === "text" && args[3] === false) textPublished.release()
			return result
		})
		vi.spyOn(child, "attemptApiRequest")
			.mockImplementationOnce(() =>
				(async function* () {
					yield { type: "text" as const, text: "I will inspect the order action." }
					const argumentsText = JSON.stringify({ path: source, offset: 1, limit: 5 })
					if (encoding === "complete") {
						yield {
							type: "tool_call" as const,
							id: "call_audit_read",
							name: "read_file",
							arguments: argumentsText,
						}
					} else {
						yield { type: "tool_call_partial" as const, index: 0, id: "call_audit_read", name: "read_file" }
						yield { type: "tool_call_partial" as const, index: 0, arguments: argumentsText }
					}
					yield { type: "usage" as const, inputTokens: 0, outputTokens: 0 }
				})(),
			)
			.mockImplementationOnce(() =>
				(async function* () {
					continuationEntered.release()
					await finish.promise
					yield { type: "text" as const, text: "controlled test cancellation" }
				})(),
			)
		const outcome = track(
			f.scheduler.schedule(child).then(
				() => undefined,
				(error: unknown) => error,
			),
		)
		await textPublished.promise
		expect(approvalTs).toBeDefined()
		expect(child.lastMessageTs).toBe(approvalTs)
		expect(child.userMessageContent.filter((block) => block.type === "tool_result")).toHaveLength(0)
		const lease = await new ParentHandoffFence(root).acquire(child.taskId, { timeoutMs: 0 })
		await lease.release()
		if (decision === "cancel") {
			child.abort = true
			child.handleWebviewAskResponse("yesButtonClicked")
			finish.release()
			expect(await outcome).toBeUndefined()
			expect(child.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
			expect(f.errors).toEqual([])
			const successor = await f.instance("after-cancel")
			const run = vi.fn(async () => {})
			await track(f.scheduler.schedule(successor, run))
			expect(run).toHaveBeenCalledOnce()
			return
		}
		if (decision === "supersede") {
			const now = vi.spyOn(Date, "now").mockReturnValue(approvalTs! + 1)
			child.supersedePendingAsk()
			now.mockRestore()
		} else child.handleWebviewAskResponse(decision === "approve" ? "yesButtonClicked" : "noButtonClicked")
		await continuationEntered.promise
		const disk = JSON.parse(
			await fs.readFile(path.join(root, "tasks", child.taskId, "api_conversation_history.json"), "utf8"),
		) as typeof child.apiConversationHistory
		const results = disk.flatMap((message) =>
			message.role === "user" && Array.isArray(message.content)
				? message.content.filter(
						(block) => block.type === "tool_result" && block.tool_use_id === "call_audit_read",
					)
				: [],
		)
		expect(results).toHaveLength(1)
		if (decision === "approve") {
			expect(results[0]).toMatchObject({ content: expect.stringContaining("DISPOSABLE_ORDER_ACTION_CONTENT") })
			expect(JSON.stringify(results)).not.toContain("superseded")
			expect(child.fileContextTracker.trackFileContext).toHaveBeenCalledOnce()
		} else {
			expect(JSON.stringify(results)).not.toContain("DISPOSABLE_ORDER_ACTION_CONTENT")
			expect(results[0]).toMatchObject({
				content: expect.stringContaining(decision === "deny" ? "Denied by user" : "superseded"),
			})
			expect(child.fileContextTracker.trackFileContext).not.toHaveBeenCalled()
		}
		expect(disk.findIndex((message) => message.role === "assistant")).toBeLessThan(
			disk.findIndex(
				(message) =>
					message.role === "user" && Array.isArray(message.content) && message.content.includes(results[0]),
			),
		)
		expect(f.parent.apiConversationHistory).toEqual([])
		child.abort = true
		finish.release()
		expect(await outcome).toBeUndefined()
		expect(f.errors).toEqual([])
		expect(f.stages).toContain(`${child.taskId}:settled`)
	},
)
