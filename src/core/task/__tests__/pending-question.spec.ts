import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import type { HistoryItem, PendingQuestion, ClineMessage } from "@roo-code/types"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"
import { TelemetryService } from "@roo-code/telemetry"
import { ClineProvider } from "../../webview/ClineProvider"
import { TaskHistoryStore, saveApiMessages, saveTaskMessages } from "../../task-persistence"
import { Task } from "../Task"
import { presentAssistantMessage } from "../../assistant-message/presentAssistantMessage"
import { AskFollowupQuestionTool } from "../../tools/AskFollowupQuestionTool"
import { AttemptCompletionTool } from "../../tools/AttemptCompletionTool"
import type { ToolCallbacks } from "../../tools/BaseTool"
import { formatResponse } from "../../prompts/responses"
import { clearPendingQuestion } from "../../task-persistence/taskLifecycle"
import { ParentHandoffFence } from "../../task-persistence/parentHandoffFence"
import {
	assertProviderStartExclusion,
	bindTargetPersistence,
	withPersistenceExclusions,
} from "../../task-persistence/targetPersistenceBoundary"

vi.mock("../../ignore/RooIgnoreController", () => ({
	RooIgnoreController: class {
		initialize = async () => {}
		dispose = () => {}
	},
}))
vi.mock("../../context-tracking/FileContextTracker", () => ({
	FileContextTracker: class {
		dispose = () => {}
	},
}))
const { beforeRename } = vi.hoisted(() => ({ beforeRename: vi.fn() }))
vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	return {
		...actual,
		rename: async (from: string, to: string) => {
			await beforeRename(from, to)
			return actual.rename(from, to)
		},
	}
})

vi.mock("../../checkpoints", () => ({ getCheckpointService: vi.fn(async () => undefined) }))

const question: PendingQuestion = {
	id: "q1",
	taskId: "task",
	toolCallId: "call",
	text: JSON.stringify({ question: "Choose?", suggest: [{ answer: "A" }] }),
}
const ownership = { taskId: "task", questionId: "q1", explicitAnswer: true }

const fixtures: { task: Task; provider: ClineProvider; store: TaskHistoryStore; root: string }[] = []
const operations = new Set<Promise<unknown>>()
function trackOperation<T>(operation: Promise<T>): Promise<T> {
	operations.add(operation)
	void operation.then(
		() => operations.delete(operation),
		() => operations.delete(operation),
	)
	return operation
}

async function settleDiskTimers<T>(operation: Promise<T>): Promise<T> {
	let settled = false
	void operation.then(
		() => {
			settled = true
		},
		() => {
			settled = true
		},
	)
	await vi.waitFor(() => expect(settled).toBe(true))
	return operation
}

async function fixture(
	initial: PendingQuestion | undefined = structuredClone(question),
	state: Record<string, unknown> = {},
	metadata: Partial<HistoryItem> = {},
) {
	if (!TelemetryService.hasInstance()) TelemetryService.createInstance([])
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "ordinary-question-"))
	const store = new TaskHistoryStore(root)
	await store.initialize()
	const stored: HistoryItem = {
		id: "task",
		number: 1,
		ts: 1,
		task: "test",
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		mode: "code",
		apiConfigName: "offline",
		pendingQuestion: initial,
		...metadata,
	}
	await store.upsert(stored)
	// Structural shell prevents extension/MCP startup. Its metadata update method
	// and all task save/ownership boundaries still execute against real disk.
	const provider = Object.assign(Object.create(ClineProvider.prototype), {
		context: { globalStorageUri: { fsPath: root }, workspaceState: { get: () => false } },
		contextProxy: { globalStorageUri: { fsPath: root } },
		taskHistoryStore: store,
		cancelledDelegationChildIds: new Set<string>(),
		providerSettingsManager: { getModeConfigId: async () => undefined },
		getState: async () => ({ mode: "code", currentApiConfigName: "offline", ...state }),
		getCurrentTask: () => undefined,
		log: vi.fn(),
		postMessageToWebview: vi.fn(async () => {}),
		postStateToWebviewThrottled: vi.fn(async () => {}),
		flushPostStateToWebviewThrottled: vi.fn(),
		postStateToWebviewWithoutTaskHistory: vi.fn(async () => {}),
	}) as ClineProvider
	const task = new Task({
		provider,
		apiConfiguration: {
			apiProvider: providerIdentifiers.anthropic,
			apiModelId: "claude-3-5-sonnet-20241022",
			apiKey: "test-api-key",
		},
		historyItem: structuredClone(stored),
		startTask: false,
		enableCheckpoints: false,
	})
	fixtures.push({ task, provider, store, root })
	await task.waitForModeInitialization()
	await task.waitForApiConfigInitialization()
	vi.spyOn(task.api, "createMessage")
	task.say = vi.fn(async () => undefined)
	task.checkpointSave = vi.fn(async () => undefined)
	return { task, provider, store, root, stored: () => store.get("task")! }
}

// These regressions load both histories through production readers. Only the
// external model loop is replaced; its history append/persistence remains real.
async function prepareHistoryResume(f: Awaited<ReturnType<typeof fixture>>) {
	await saveTaskMessages({
		globalStoragePath: f.root,
		taskId: "task",
		messages: [
			{ messageId: "original", ts: 1, type: "say", say: "task", text: "Original task" },
			{ messageId: "question", ts: 2, type: "ask", ask: "followup", questionId: "q1", text: question.text },
		],
	})
	await saveApiMessages({
		globalStoragePath: f.root,
		taskId: "task",
		messages: [
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "call", name: "ask_followup_question", input: {} }],
			},
		],
	})
	f.task["initiateTaskLoop"] = vi.fn(async (content) => {
		await assertProviderStartExclusion(f.root, "task")
		await f.task["addToApiConversationHistory"]({ role: "user", content })
	})
}
const taskFiles = ["history_item.json", "ui_messages.json", "api_conversation_history.json"] as const
async function questionBytes(root: string) {
	return Promise.all(taskFiles.map((file) => fs.readFile(path.join(root, "tasks", "task", file), "utf8")))
}

const callbacks = (): ToolCallbacks => ({
	askApproval: vi.fn(async () => true),
	handleError: vi.fn(),
	pushToolResult: vi.fn(),
	toolCallId: "call",
})

beforeEach(() => {
	beforeRename.mockReset()
	const watcherEffects = TaskHistoryStore.prototype as unknown as {
		startWatcher: () => void
		startPeriodicReconciliation: () => void
	}
	vi.spyOn(watcherEffects, "startWatcher").mockImplementation(() => {})
	vi.spyOn(watcherEffects, "startPeriodicReconciliation").mockImplementation(() => {})
	// Observe full boundary promises, including fire-and-forget answer publication.
	const taskOperations = Task.prototype as unknown as {
		saveClineMessages: (merge?: boolean) => Promise<boolean>
		saveApiConversationHistory: (merge?: boolean) => Promise<boolean>
		mutatePendingQuestion: (update: (item: HistoryItem) => HistoryItem) => Promise<void>
		withStartExclusion: (effect: () => Promise<void>, fresh?: boolean) => Promise<void>
	}
	for (const method of ["saveClineMessages", "saveApiConversationHistory"] as const) {
		const original = taskOperations[method]
		vi.spyOn(taskOperations, method).mockImplementation(function (this: Task, merge) {
			return trackOperation(original.call(this, merge))
		})
	}
	const mutate = taskOperations.mutatePendingQuestion
	vi.spyOn(taskOperations, "mutatePendingQuestion").mockImplementation(function (this: Task, update) {
		return trackOperation(mutate.call(this, update))
	})
	const start = taskOperations.withStartExclusion
	vi.spyOn(taskOperations, "withStartExclusion").mockImplementation(function (this: Task, effect, fresh) {
		return trackOperation(start.call(this, effect, fresh))
	})
	const ask = Task.prototype.ask
	vi.spyOn(Task.prototype, "ask").mockImplementation(function (this: Task, ...args) {
		return trackOperation(ask.apply(this, args))
	})
})

afterEach(async () => {
	vi.useRealTimers()
	for (const { task } of fixtures) await task.dispose()
	while (operations.size > 0) await Promise.allSettled([...operations])
	for (const { store, root } of fixtures.splice(0)) {
		store.dispose()
		await fs.rm(root, { recursive: true, force: true })
	}
	vi.restoreAllMocks()
})

describe("durable question runtime barrier", () => {
	it("registers via the real dispatcher, retains ownership on interruption, and stops the next loop", async () => {
		const { task, stored } = await fixture()
		task.pendingQuestion = undefined
		// Clear the initial durable fixture through its owner before registering a new question.
		await task["mutatePendingQuestion"]((item) => ({ ...item, pendingQuestion: undefined }))
		task.waitForCurrentAssistantMessagePersistence = vi.fn(async () => true)
		task.getTaskMode = vi.fn(async () => "code")
		task.recordToolUsage = vi.fn()
		task.recordToolError = vi.fn()
		Object.assign(task, { toolRepetitionDetector: { check: () => ({ allowExecution: true }) } })
		task.assistantMessageContent = [
			{
				type: "tool_use",
				id: "call",
				name: "ask_followup_question",
				params: { question: "Choose?" },
				nativeArgs: { question: "Choose?", follow_up: [{ text: "A" }] },
				partial: false,
			},
		]
		const dispatch = presentAssistantMessage(task)
		await vi.waitFor(() => expect(task.clineMessages.at(-1)?.ask).toBe("followup"))
		expect(stored().pendingQuestion?.toolCallId).toBe("call")
		expect(task.clineMessages.at(-1)?.questionId).toBe(stored().pendingQuestion?.id)
		task.abort = true
		await dispatch
		task.abort = false
		expect(await task.recursivelyMakeClineRequests([])).toBe(true)
		expect(task.userMessageContent).toEqual([])
		expect(task.recordToolError).not.toHaveBeenCalled()
		expect(task.currentStreamingContentIndex).toBe(0)
	})

	it("does not replace an active full-question waiter", async () => {
		const { task } = await fixture()
		const first = task.ask("followup", question.text, false)
		await vi.waitFor(() => expect(task.clineMessages).toHaveLength(1))
		// The UI row is staged before its real disk save admits the owned waiter.
		await vi.waitFor(() => expect(task["activeQuestionWaitId"]).toBe("q1"))
		await expect(task.ask("followup", question.text, false)).rejects.toThrow("Ask ignored")
		task.handleWebviewAskResponse("messageResponse", "answer", undefined, ownership)
		expect(await first).toMatchObject({ text: "answer" })
		expect(task.clineMessages).toHaveLength(1)
	})

	it("retains question identity when a partial row becomes complete", async () => {
		const { task } = await fixture()
		task.clineMessages = [{ ts: 1, type: "ask", ask: "followup", text: "Choose", partial: true }]
		const waiting = task.ask("followup", question.text, false)
		await vi.waitFor(() => expect(task.clineMessages[0].questionId).toBe("q1"))
		task.handleWebviewAskResponse("messageResponse", "A", undefined, ownership)
		await waiting
		expect(task.clineMessages[0]).toMatchObject({ ts: 1, partial: false, isAnswered: true, questionId: "q1" })
	})

	it("blocks model requests after answer delivery until the result is durable", async () => {
		const { task } = await fixture({ ...question, answer: { text: "A" } })
		await task.deliverQuestionResult()
		for await (const _chunk of task.attemptApiRequest()) throw new Error("Unexpected model output")
		expect(task.api.createMessage).not.toHaveBeenCalled()
		expect(task.pendingQuestion).toBeDefined()
	})

	it("blocks the actual presenter, duplicate question, dependent tool, and completion without encouragement", async () => {
		const { task } = await fixture()
		const cb = callbacks()
		task.assistantMessageContent = [
			{
				type: "tool_use",
				id: "other",
				name: "attempt_completion",
				params: {},
				nativeArgs: { result: "done" },
				partial: false,
			},
		]
		await presentAssistantMessage(task)
		await new AskFollowupQuestionTool().execute({ question: "Again?", follow_up: [] }, task, cb)
		await new AttemptCompletionTool().handle(
			task,
			task.assistantMessageContent[0] as Parameters<AttemptCompletionTool["handle"]>[1],
			cb,
		)
		await new AttemptCompletionTool().execute({ result: "done" }, task, {
			...cb,
			askFinishSubTaskApproval: vi.fn(async () => true),
			toolDescription: () => "completion",
		})
		expect(task.currentStreamingContentIndex).toBe(0)
		expect(task.say).not.toHaveBeenCalled()
		expect(cb.pushToolResult).not.toHaveBeenCalled()
		expect(cb.handleError).not.toHaveBeenCalled()
	})

	it("stops both loop entry and direct model requests after interruption without missing-tool feedback", async () => {
		const { task } = await fixture()
		const reminder = vi.spyOn(formatResponse, "noToolsUsed")
		await task["initiateTaskLoop"]([])
		expect(await task.recursivelyMakeClineRequests([])).toBe(true)
		for await (const _chunk of task.attemptApiRequest()) throw new Error("Unexpected provider output")
		expect(task.api.createMessage).not.toHaveBeenCalled()
		expect(reminder).not.toHaveBeenCalled()
		expect(task.consecutiveMistakeCount).toBe(0)
	})

	it("does not generate outer-loop encouragement when a request returns with a newly pending question", async () => {
		const { task } = await fixture(undefined)
		task.pendingQuestion = undefined
		task.recursivelyMakeClineRequests = vi.fn(async () => {
			task.pendingQuestion = structuredClone(question)
			return false
		})
		const reminder = vi.spyOn(formatResponse, "noToolsUsed")
		await task["initiateTaskLoop"]([])
		expect(task.recursivelyMakeClineRequests).toHaveBeenCalledTimes(1)
		expect(reminder).not.toHaveBeenCalled()
	})

	it.each([{ text: "" }, { text: "", images: ["data:image/png;base64,aGVsbG8="] }, { text: "free text" }])(
		"accepts an explicit owned answer exactly once: %j",
		async (answer) => {
			const { task, stored } = await fixture()
			const waiting = task.ask("followup", question.text, false)
			await vi.waitFor(() => expect(task.clineMessages).toHaveLength(1))
			task.handleWebviewAskResponse("messageResponse", answer.text, answer.images, ownership)
			task.handleWebviewAskResponse("messageResponse", "duplicate", undefined, ownership)
			expect(await waiting).toMatchObject({ response: "messageResponse", text: answer.text })
			expect(stored().pendingQuestion?.answer).toEqual({ text: answer.text, images: answer.images })
			expect(task.clineMessages[0].isAnswered).toBe(true)
			await task.deliverQuestionResult()
			await task.deliverQuestionResult()
			expect(task.clineMessages.filter((message) => message.say === "user_feedback")).toHaveLength(1)
		},
	)

	it("ignores synthetic empty feedback, generic approvals, stale task/question ownership, and duplicate answers", async () => {
		const { task, stored } = await fixture()
		for (const response of ["messageResponse", "yesButtonClicked", "noButtonClicked"] as const)
			task.handleWebviewAskResponse(response, "")
		task.handleWebviewAskResponse("messageResponse", "stale", undefined, { ...ownership, taskId: "other" })
		task.handleWebviewAskResponse("messageResponse", "stale", undefined, { ...ownership, questionId: "old" })
		task.handleWebviewAskResponse("messageResponse", "", undefined, { ...ownership, explicitAnswer: false })
		await Promise.resolve()
		expect(stored().pendingQuestion?.answer).toBeUndefined()
		expect(task["askResponse"]).toBeUndefined()
	})

	it("retains a question when ask is interrupted and cleans up its owned automatic-answer timer", async () => {
		vi.useFakeTimers()
		const { task, stored } = await fixture(structuredClone(question), {
			autoApprovalEnabled: true,
			alwaysAllowFollowupQuestions: true,
			followupAutoApproveTimeoutMs: 1000,
		})
		const waiting = task.ask("followup", question.text, false).catch((error: Error) => error)
		await vi.waitFor(() => expect(task["autoApprovalTimeoutRef"]).toBeDefined())
		task.abort = true
		await vi.advanceTimersByTimeAsync(100)
		expect(await waiting).toBeInstanceOf(Error)
		await vi.advanceTimersByTimeAsync(2000)
		expect(stored().pendingQuestion?.answer).toBeUndefined()
		expect(vi.getTimerCount()).toBe(0)
	})

	it("ignores timestamp supersession but accepts the original owned answer", async () => {
		const { task } = await fixture()
		const waiting = task.ask("followup", question.text, false)
		await vi.waitFor(() => expect(task.clineMessages).toHaveLength(1))
		task["lastMessageTs"] = 999
		await expect(task.ask("resume_task")).rejects.toThrow("Ask ignored")
		task.handleWebviewAskResponse("messageResponse", "A", undefined, ownership)
		expect(await waiting).toMatchObject({ text: "A" })
	})

	it("preserves configured automatic answers and queue ownership", async () => {
		vi.useFakeTimers()
		const { task } = await fixture(structuredClone(question), {
			autoApprovalEnabled: true,
			alwaysAllowFollowupQuestions: true,
			followupAutoApproveTimeoutMs: 1000,
		})
		const waiting = task.ask("followup", question.text, false)
		await vi.waitFor(() => expect(task["autoApprovalTimeoutRef"]).toBeDefined())
		await vi.advanceTimersByTimeAsync(1100)
		await settleDiskTimers(waiting)
		expect(await waiting).toMatchObject({ text: "A" })
		const queued = await fixture()
		queued.task.messageQueueService.addMessage("queued answer")
		const queuedWait = queued.task.ask("followup", question.text, false)
		await vi.advanceTimersByTimeAsync(100)
		await settleDiskTimers(queuedWait)
		expect(await queuedWait).toMatchObject({ text: "queued answer" })
		expect(queued.task.messageQueueService.isEmpty()).toBe(true)
	})

	it("rejects a stale timer after question replacement", async () => {
		vi.useFakeTimers()
		const { task, stored } = await fixture(structuredClone(question), {
			autoApprovalEnabled: true,
			alwaysAllowFollowupQuestions: true,
			followupAutoApproveTimeoutMs: 1000,
		})
		const waiting = task.ask("followup", question.text, false).catch(() => undefined)
		await vi.waitFor(() => expect(task["autoApprovalTimeoutRef"]).toBeDefined())
		task.pendingQuestion = { ...question, id: "replacement" }
		await vi.advanceTimersByTimeAsync(1100)
		expect(stored().pendingQuestion?.answer).toBeUndefined()
		task.abort = true
		await vi.advanceTimersByTimeAsync(100)
		await waiting
	})

	it("restores only the durable question and preserves native pairing with exactly one answer result", async () => {
		const { task, stored } = await fixture()
		task.apiConversationHistory = [
			{
				role: "assistant",
				content: [
					{ type: "tool_use", id: "call", name: "ask_followup_question", input: {} },
					{ type: "tool_use", id: "dependent", name: "execute_command", input: {} },
				],
			},
		]
		task["initiateTaskLoop"] = vi.fn(async (content) => {
			await task["addToApiConversationHistory"]({ role: "user", content })
		})
		const resumed = task["resumePendingQuestion"]()
		await vi.waitFor(() => expect(task.clineMessages[0]?.ask).toBe("followup"))
		task.handleWebviewAskResponse("yesButtonClicked")
		expect(task["initiateTaskLoop"]).not.toHaveBeenCalled()
		task.handleWebviewAskResponse("messageResponse", "", undefined, ownership)
		await resumed
		expect(stored().pendingQuestion).toBeUndefined()
		expect(task.apiConversationHistory[1].content).toEqual([
			{ type: "tool_result", tool_use_id: "call", content: "<user_message>\n\n</user_message>" },
			{
				type: "tool_result",
				tool_use_id: "dependent",
				content: "Task was interrupted before this tool call could be completed.",
				is_error: true,
			},
		])
		await task["resumePendingQuestion"]()
		expect(task["initiateTaskLoop"]).toHaveBeenCalledTimes(1)
	})

	it("rehydrates through the real history-loading entry point instead of asking for generic resume approval", async () => {
		const { task, stored } = await fixture()
		task["cloudSyncedMessageTimestamps"] = new Set()
		task["getSavedClineMessages"] = vi.fn(
			async (): Promise<ClineMessage[]> => [
				{ ts: 1, type: "say", say: "task", text: "Original task" },
				{ ts: 2, type: "ask", ask: "followup", questionId: "q1", text: question.text },
				{ ts: 3, type: "ask", ask: "resume_task" },
			],
		)
		task["getSavedApiConversationHistory"] = vi.fn(
			async (): ReturnType<Task["getSavedApiConversationHistory"]> => [
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "call", name: "ask_followup_question", input: {} }],
				},
			],
		)
		task["initiateTaskLoop"] = vi.fn(async (content) => {
			await task["addToApiConversationHistory"]({ role: "user", content })
		})
		const resumed = task["resumeTaskFromHistory"]()
		await vi.waitFor(() => expect(task.clineMessages.at(-1)?.questionId).toBe("q1"))
		// Hydration can expose the saved row before resume has admitted its waiter.
		await vi.waitFor(() => expect(task["activeQuestionWaitId"]).toBe("q1"))
		expect(task.clineMessages.some((message) => message.ask === "resume_task")).toBe(false)
		task.handleWebviewAskResponse("yesButtonClicked")
		expect(stored().pendingQuestion?.answer).toBeUndefined()
		task.handleWebviewAskResponse("messageResponse", "owned", undefined, ownership)
		await resumed
		expect(stored().pendingQuestion).toBeUndefined()
		expect(task["initiateTaskLoop"]).toHaveBeenCalledTimes(1)
	})

	it("persists a fresh external answer with no inherited lease and reacquires before real resume continuation", async () => {
		const f = await fixture()
		await prepareHistoryResume(f)
		const resumed = trackOperation(f.task["resumeTaskFromHistory"]())
		await vi.waitFor(() => expect(f.task["activeQuestionWaitId"]).toBe("q1"))
		// Acquisition succeeds independently while the history-resume waiter is idle.
		await withPersistenceExclusions(f.root, ["task"], async () => {}, { failFast: true })
		f.task.handleWebviewAskResponse("messageResponse", "fresh external", undefined, ownership)
		await resumed
		expect(f.task["initiateTaskLoop"]).toHaveBeenCalledOnce()
		expect(f.stored().pendingQuestion).toBeUndefined()
		const [metadata, ui, api] = await questionBytes(f.root)
		expect(JSON.parse(metadata).pendingQuestion).toBeUndefined()
		expect(ui).toContain("fresh external")
		expect(api).toContain("fresh external")
		expect(f.task.api.createMessage).not.toHaveBeenCalled()
	})

	it("does not publish an obsolete idle notification while the external answer UI write is pending", async () => {
		const f = await fixture()
		await prepareHistoryResume(f)
		// Drive only the actual idle callback; disk and ask polling keep real clocks.
		const setTimeout = globalThis.setTimeout
		let notify: (() => void) | undefined
		vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
			if (delay === 2000) {
				notify = () => callback(...args)
				return setTimeout(() => {}, delay)
			}
			return setTimeout(callback, delay, ...args)
		})
		let release!: () => void
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		let markEntered!: () => void
		const entered = new Promise<void>((resolve) => {
			markEntered = resolve
		})
		beforeRename.mockImplementation(async (_from, to) => {
			if (String(to).endsWith("ui_messages.json") && f.task["acceptingQuestionAnswer"]) {
				markEntered()
				await gate
			}
		})
		const resumed = trackOperation(f.task["resumeTaskFromHistory"]())
		void resumed.catch(() => {})
		try {
			await vi.waitFor(() => expect(f.task["activeQuestionWaitId"]).toBe("q1"))
			f.task.handleWebviewAskResponse("messageResponse", "answer before notification", undefined, ownership)
			await entered
			expect(f.stored().pendingQuestion?.answer?.text).toBe("answer before notification")
			expect(notify).toBeDefined()
			notify!()
			expect(f.provider.postMessageToWebview).not.toHaveBeenCalledWith({ type: "interactionRequired" })
			expect(f.task["initiateTaskLoop"]).not.toHaveBeenCalled()
			release()
			await resumed
			expect(f.task["initiateTaskLoop"]).toHaveBeenCalledOnce()
			expect(f.task.api.createMessage).not.toHaveBeenCalled()
		} finally {
			release()
		}
	})

	it("retains the reacquired idle publication lease through its last webview effect", async () => {
		const f = await fixture()
		await prepareHistoryResume(f)
		// Keep acquisition retry delays and the question polling clock live.
		// Observe the durable-answer handoff rather than racing kernel I/O against
		// the fake-clock settling helper's polling deadline.
		let response = f.task["askResponse"]
		let answerPublished!: () => void
		const answered = new Promise<void>((resolve) => {
			answerPublished = resolve
		})
		Object.defineProperty(f.task, "askResponse", {
			configurable: true,
			get: () => response,
			set: (value: typeof response) => {
				response = value
				if (value === "messageResponse") answerPublished()
			},
		})
		let release!: () => void
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		let publicationEntered!: () => void
		const entered = new Promise<void>((resolve) => {
			publicationEntered = resolve
		})
		vi.spyOn(f.provider, "postMessageToWebview").mockImplementation(async (message) => {
			if (message.type === "interactionRequired") {
				publicationEntered()
				await gate
			}
		})
		const resumed = trackOperation(f.task["resumeTaskFromHistory"]())
		void resumed.catch(() => {})
		try {
			await vi.waitFor(() => expect(f.task["activeQuestionWaitId"]).toBe("q1"))
			await entered
			await expect(
				withPersistenceExclusions(f.root, ["task"], async () => {}, { failFast: true }),
			).rejects.toThrow()
			f.task.handleWebviewAskResponse("messageResponse", "answer after publication", undefined, ownership)
			release()
			await answered
			await resumed
			expect(f.task["initiateTaskLoop"]).toHaveBeenCalledOnce()
			expect(f.task.api.createMessage).not.toHaveBeenCalled()
		} finally {
			release()
		}
	})

	it.each(["abandoned", "bound", "replaced"] as const)(
		"refuses a delayed old-instance answer and follow-on work when ownership is %s during idle wait",
		async (change) => {
			const action = {
				kind: "create_subtask" as const,
				actionId: "old",
				mode: "code",
				message: "old",
				todos: [],
				approvalText: "old",
			}
			const f = await fixture(
				structuredClone(question),
				{},
				change === "abandoned"
					? { parentTaskId: "parent", rootTaskId: "parent", status: "interrupted" }
					: { pendingAction: action, status: "interrupted" },
			)
			if (change === "abandoned")
				await f.store.upsert({
					...f.stored(),
					id: "parent",
					status: "delegated",
					parentTaskId: undefined,
					rootTaskId: undefined,
					pendingQuestion: undefined,
					childIds: ["task"],
					awaitingChildId: "task",
					delegatedToId: "task",
				})
			await prepareHistoryResume(f)
			const resumed = trackOperation(f.task["resumeTaskFromHistory"]())
			void resumed.catch(() => {})
			await vi.waitFor(() => expect(f.task["activeQuestionWaitId"]).toBe("q1"))
			if (change === "abandoned") {
				expect(await f.provider.abandonSubtask("task")).toBe(true)
				await f.store.reconcile()
				expect(f.stored().parentTaskId).toBeUndefined()
			} else if (change === "bound") await bindTargetPersistence(f.root, "task", action)
			else
				await f.store.updateQuestion("task", (item) => ({
					...item,
					pendingQuestion: { ...question, id: "q2" },
				}))
			const before = await questionBytes(f.root)
			f.task.handleWebviewAskResponse("messageResponse", "late old answer", undefined, ownership)
			await expect(resumed).rejects.toThrow(/authority|ownership|refused|bound/i)
			await vi.waitFor(() => expect(f.task["acceptingQuestionAnswer"]).toBe(false))
			expect(await questionBytes(f.root)).toEqual(before)
			expect(f.task["initiateTaskLoop"]).not.toHaveBeenCalled()
			expect(f.task.api.createMessage).not.toHaveBeenCalled()
			await expect(f.task["saveClineMessages"]()).rejects.toThrow(/authority|refused/i)
			f.task.handleWebviewAskResponse("messageResponse", "another late answer", undefined, ownership)
			await vi.waitFor(() => expect(f.task["acceptingQuestionAnswer"]).toBe(false))
			expect(await questionBytes(f.root)).toEqual(before)
		},
	)

	it("revalidates a completed answer when binding wins before continuation reacquisition", async () => {
		const action = {
			kind: "create_subtask" as const,
			actionId: "old",
			mode: "code",
			message: "old",
			todos: [],
			approvalText: "old",
		}
		const f = await fixture(structuredClone(question), {}, { pendingAction: action, status: "interrupted" })
		await prepareHistoryResume(f)
		let release!: () => void
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		let entered = false
		const acquire = ParentHandoffFence.prototype.acquire
		vi.spyOn(ParentHandoffFence.prototype, "acquire").mockImplementation(async function (
			this: ParentHandoffFence,
			id,
			options,
		) {
			if (id === "task" && f.task.pendingQuestion?.answer && !f.task["acceptingQuestionAnswer"] && !entered) {
				entered = true
				await gate
			}
			return acquire.call(this, id, options)
		})
		const resumed = trackOperation(f.task["resumeTaskFromHistory"]())
		void resumed.catch(() => {})
		try {
			await vi.waitFor(() => expect(f.task["activeQuestionWaitId"]).toBe("q1"))
			f.task.handleWebviewAskResponse("messageResponse", "durable but not resumed", undefined, ownership)
			await vi.waitFor(() => expect(entered).toBe(true))
			expect(f.stored().pendingQuestion?.answer?.text).toBe("durable but not resumed")
			await bindTargetPersistence(f.root, "task", action)
			const before = await questionBytes(f.root)
			release()
			await expect(resumed).rejects.toThrow(/bound|authority/i)
			expect(await questionBytes(f.root)).toEqual(before)
			expect(f.task["initiateTaskLoop"]).not.toHaveBeenCalled()
			expect(f.task.api.createMessage).not.toHaveBeenCalled()
		} finally {
			release()
		}
	})

	it("retries feedback persistence without duplicating its deterministic history identity", async () => {
		const { task } = await fixture({ ...question, answer: { text: "A" } })
		// Both the new feedback row and its explicit durable save exercise the
		// actual boundary; fail their disk publications, not the ownership checks.
		beforeRename.mockImplementation((_from, to) => {
			if (String(to).endsWith("ui_messages.json")) throw new Error("disk full")
		})
		await expect(task.deliverQuestionResult()).rejects.toThrow("could not be persisted")
		expect(task.hasPendingQuestion).toBe(true)
		beforeRename.mockReset()
		await task.deliverQuestionResult()
		expect(task.clineMessages).toHaveLength(1)
		expect(task.clineMessages[0].messageId).toBe("question-feedback:q1")
	})

	it("does not reconstruct pending state from stale unanswered UI rows", async () => {
		const { task } = await fixture()
		task.pendingQuestion = undefined
		task.clineMessages = [{ ts: 1, type: "ask", ask: "followup", text: "old" }]
		task.handleWebviewAskResponse("yesButtonClicked")
		expect(task.hasPendingQuestion).toBe(false)
		expect(task.clineMessages[0].isAnswered).toBeUndefined()
	})

	it.each(["abandon", "replace"] as const)(
		"explicit %s clears ownership without recording an answer",
		async (reason) => {
			const { task, stored } = await fixture()
			task.abortTask = vi.fn(async () => {
				task.abort = true
			})
			await task.abandonQuestion("stale", reason)
			expect(task.abortTask).not.toHaveBeenCalled()
			await task.abandonQuestion("q1", reason)
			expect(stored().pendingQuestion).toBeUndefined()
			expect(task.abortTask).toHaveBeenCalledTimes(1)
			task.handleWebviewAskResponse("messageResponse", "late", undefined, ownership)
			expect(task["askResponse"]).toBeUndefined()
		},
	)

	it("does not clear an unanswered question for synthetic interruption results", async () => {
		const { stored } = await fixture()
		expect(() => clearPendingQuestion(stored(), "q1", "durable_result")).toThrow()
	})
})
