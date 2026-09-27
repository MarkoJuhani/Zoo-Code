import type { HistoryItem, PendingQuestion, ClineMessage } from "@roo-code/types"
import { Task } from "../Task"
import { presentAssistantMessage } from "../../assistant-message/presentAssistantMessage"
import { AskFollowupQuestionTool } from "../../tools/AskFollowupQuestionTool"
import { AttemptCompletionTool } from "../../tools/AttemptCompletionTool"
import type { ToolCallbacks } from "../../tools/BaseTool"
import { MessageQueueService } from "../../message-queue/MessageQueueService"
import { formatResponse } from "../../prompts/responses"
import { clearPendingQuestion } from "../../task-persistence/taskLifecycle"

vi.mock("@roo-code/telemetry", () => ({ TelemetryService: { instance: { captureToolUsage: vi.fn() } } }))

vi.mock("../../checkpoints", () => ({ getCheckpointService: vi.fn(async () => undefined) }))

const question: PendingQuestion = {
	id: "q1",
	taskId: "task",
	toolCallId: "call",
	text: JSON.stringify({ question: "Choose?", suggest: [{ answer: "A" }] }),
}
const ownership = { taskId: "task", questionId: "q1", explicitAnswer: true }

function fixture(
	initial: PendingQuestion | undefined = structuredClone(question),
	state: Record<string, unknown> = {},
) {
	let stored: HistoryItem = {
		id: "task",
		number: 1,
		ts: 1,
		task: "test",
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		pendingQuestion: initial,
	}
	const task = Object.create(Task.prototype) as Task
	Object.assign(task, {
		taskId: "task",
		instanceId: "instance",
		abort: false,
		abandoned: false,
		clineMessages: [],
		apiConversationHistory: [],
		pendingQuestion: initial,
		messageQueueService: new MessageQueueService(),
		userMessageContent: [],
		assistantMessageContent: [],
		currentStreamingContentIndex: 0,
		consecutiveMistakeCount: 0,
		consecutiveNoToolUseCount: 0,
		emit: vi.fn(),
		api: { getModel: () => ({ id: "test", info: {} }), createMessage: vi.fn() },
		apiConfiguration: {},
		providerRef: {
			deref: () => ({
				getState: async () => state,
				taskHistoryStore: {
					updateQuestion: vi.fn(async (_id: string, update: (item: HistoryItem) => HistoryItem) => {
						stored = update(stored)
						return stored
					}),
				},
			}),
		},
	})
	task["saveClineMessages"] = vi.fn(async () => true)
	task["saveApiConversationHistory"] = vi.fn(async () => true)
	task["addToClineMessages"] = vi.fn(async (message: ClineMessage) => {
		task.clineMessages.push(message)
	})
	task["updateClineMessage"] = vi.fn(async () => undefined)
	task.say = vi.fn(async () => undefined)
	task.checkpointSave = vi.fn(async () => undefined)
	return { task, stored: () => stored }
}

const callbacks = (): ToolCallbacks => ({
	askApproval: vi.fn(async () => true),
	handleError: vi.fn(),
	pushToolResult: vi.fn(),
	toolCallId: "call",
})

afterEach(() => {
	vi.restoreAllMocks()
	vi.useRealTimers()
})

describe("durable question runtime barrier", () => {
	it("registers via the real dispatcher, retains ownership on interruption, and stops the next loop", async () => {
		const { task, stored } = fixture()
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
		const { task } = fixture()
		const first = task.ask("followup", question.text, false)
		await vi.waitFor(() => expect(task.clineMessages).toHaveLength(1))
		await expect(task.ask("followup", question.text, false)).rejects.toThrow("Ask ignored")
		task.handleWebviewAskResponse("messageResponse", "answer", undefined, ownership)
		expect(await first).toMatchObject({ text: "answer" })
		expect(task.clineMessages).toHaveLength(1)
	})

	it("retains question identity when a partial row becomes complete", async () => {
		const { task } = fixture()
		task.clineMessages = [{ ts: 1, type: "ask", ask: "followup", text: "Choose", partial: true }]
		const waiting = task.ask("followup", question.text, false)
		await vi.waitFor(() => expect(task.clineMessages[0].questionId).toBe("q1"))
		task.handleWebviewAskResponse("messageResponse", "A", undefined, ownership)
		await waiting
		expect(task.clineMessages[0]).toMatchObject({ ts: 1, partial: false, isAnswered: true, questionId: "q1" })
	})

	it("blocks model requests after answer delivery until the result is durable", async () => {
		const { task } = fixture({ ...question, answer: { text: "A" } })
		await task.deliverQuestionResult()
		for await (const _chunk of task.attemptApiRequest()) throw new Error("Unexpected model output")
		expect(task.api.createMessage).not.toHaveBeenCalled()
		expect(task.pendingQuestion).toBeDefined()
	})

	it("blocks the actual presenter, duplicate question, dependent tool, and completion without encouragement", async () => {
		const { task } = fixture()
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
		const { task } = fixture()
		const reminder = vi.spyOn(formatResponse, "noToolsUsed")
		await task["initiateTaskLoop"]([])
		expect(await task.recursivelyMakeClineRequests([])).toBe(true)
		for await (const _chunk of task.attemptApiRequest()) throw new Error("Unexpected provider output")
		expect(task.api.createMessage).not.toHaveBeenCalled()
		expect(reminder).not.toHaveBeenCalled()
		expect(task.consecutiveMistakeCount).toBe(0)
	})

	it("does not generate outer-loop encouragement when a request returns with a newly pending question", async () => {
		const { task } = fixture(undefined)
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
			const { task, stored } = fixture()
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
		const { task, stored } = fixture()
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
		const { task, stored } = fixture(structuredClone(question), {
			autoApprovalEnabled: true,
			alwaysAllowFollowupQuestions: true,
			followupAutoApproveTimeoutMs: 1000,
		})
		const waiting = task.ask("followup", question.text, false).catch((error: Error) => error)
		await vi.advanceTimersByTimeAsync(0)
		task.abort = true
		await vi.advanceTimersByTimeAsync(100)
		expect(await waiting).toBeInstanceOf(Error)
		await vi.advanceTimersByTimeAsync(2000)
		expect(stored().pendingQuestion?.answer).toBeUndefined()
		expect(vi.getTimerCount()).toBe(0)
	})

	it("ignores timestamp supersession but accepts the original owned answer", async () => {
		const { task } = fixture()
		const waiting = task.ask("followup", question.text, false)
		await vi.waitFor(() => expect(task.clineMessages).toHaveLength(1))
		task["lastMessageTs"] = 999
		await expect(task.ask("resume_task")).rejects.toThrow("Ask ignored")
		task.handleWebviewAskResponse("messageResponse", "A", undefined, ownership)
		expect(await waiting).toMatchObject({ text: "A" })
	})

	it("preserves configured automatic answers and queue ownership", async () => {
		vi.useFakeTimers()
		const { task } = fixture(structuredClone(question), {
			autoApprovalEnabled: true,
			alwaysAllowFollowupQuestions: true,
			followupAutoApproveTimeoutMs: 1000,
		})
		const waiting = task.ask("followup", question.text, false)
		await vi.advanceTimersByTimeAsync(1100)
		expect(await waiting).toMatchObject({ text: "A" })
		const queued = fixture()
		queued.task.messageQueueService.addMessage("queued answer")
		const queuedWait = queued.task.ask("followup", question.text, false)
		await vi.advanceTimersByTimeAsync(100)
		expect(await queuedWait).toMatchObject({ text: "queued answer" })
		expect(queued.task.messageQueueService.isEmpty()).toBe(true)
	})

	it("rejects a stale timer after question replacement", async () => {
		vi.useFakeTimers()
		const { task, stored } = fixture(structuredClone(question), {
			autoApprovalEnabled: true,
			alwaysAllowFollowupQuestions: true,
			followupAutoApproveTimeoutMs: 1000,
		})
		const waiting = task.ask("followup", question.text, false).catch(() => undefined)
		await vi.advanceTimersByTimeAsync(0)
		task.pendingQuestion = { ...question, id: "replacement" }
		await vi.advanceTimersByTimeAsync(1100)
		expect(stored().pendingQuestion?.answer).toBeUndefined()
		task.abort = true
		await vi.advanceTimersByTimeAsync(100)
		await waiting
	})

	it("restores only the durable question and preserves native pairing with exactly one answer result", async () => {
		const { task, stored } = fixture()
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
		const { task, stored } = fixture()
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
		expect(task.clineMessages.some((message) => message.ask === "resume_task")).toBe(false)
		task.handleWebviewAskResponse("yesButtonClicked")
		expect(stored().pendingQuestion?.answer).toBeUndefined()
		task.handleWebviewAskResponse("messageResponse", "owned", undefined, ownership)
		await resumed
		expect(stored().pendingQuestion).toBeUndefined()
		expect(task["initiateTaskLoop"]).toHaveBeenCalledTimes(1)
	})

	it("retries feedback persistence without duplicating its deterministic history identity", async () => {
		const { task } = fixture({ ...question, answer: { text: "A" } })
		vi.mocked(task["saveClineMessages"]).mockResolvedValueOnce(false)
		await expect(task.deliverQuestionResult()).rejects.toThrow("could not be persisted")
		expect(task.hasPendingQuestion).toBe(true)
		await task.deliverQuestionResult()
		expect(task.clineMessages).toHaveLength(1)
		expect(task.clineMessages[0].messageId).toBe("question-feedback:q1")
	})

	it("does not reconstruct pending state from stale unanswered UI rows", () => {
		const { task } = fixture()
		task.pendingQuestion = undefined
		task.clineMessages = [{ ts: 1, type: "ask", ask: "followup", text: "old" }]
		task.handleWebviewAskResponse("yesButtonClicked")
		expect(task.hasPendingQuestion).toBe(false)
		expect(task.clineMessages[0].isAnswered).toBeUndefined()
	})

	it.each(["abandon", "replace"] as const)(
		"explicit %s clears ownership without recording an answer",
		async (reason) => {
			const { task, stored } = fixture()
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

	it("does not clear an unanswered question for synthetic interruption results", () => {
		const { stored } = fixture()
		expect(() => clearPendingQuestion(stored(), "q1", "durable_result")).toThrow()
	})
})
