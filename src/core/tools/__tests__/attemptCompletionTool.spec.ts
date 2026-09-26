import { RooCodeEventName, TodoItem } from "@roo-code/types"

import { AttemptCompletionToolUse } from "../../../shared/tools"

// Mock the formatResponse module before importing the tool
vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		toolError: vi.fn((msg: string) => `Error: ${msg}`),
		toolResult: vi.fn((msg: string) => `Result: ${msg}`),
		toolDenied: vi.fn(() => "Denied"),
	},
}))

// Mock vscode module
vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: vi.fn(() => ({
			get: vi.fn(),
		})),
	},
}))

// Mock Package module
vi.mock("../../../shared/package", () => ({
	Package: {
		name: "zoo-code",
	},
}))

import { attemptCompletionTool, AttemptCompletionCallbacks } from "../AttemptCompletionTool"
import { Task } from "../../task/Task"
import { AskApproval, HandleError, PushToolResult } from "../../../shared/tools"
import * as vscode from "vscode"

describe("attemptCompletionTool", () => {
	let mockTask: Partial<Task>
	let mockPushToolResult: ReturnType<typeof vi.fn<PushToolResult>>
	let mockAskApproval: ReturnType<typeof vi.fn<AskApproval>>
	let mockHandleError: ReturnType<typeof vi.fn<HandleError>>
	let mockToolDescription: ReturnType<typeof vi.fn<() => string>>
	let mockAskFinishSubTaskApproval: ReturnType<typeof vi.fn<() => Promise<boolean>>>
	let mockGetConfiguration: ReturnType<typeof vi.fn<() => any>>

	beforeEach(() => {
		mockPushToolResult = vi.fn<PushToolResult>()
		mockAskApproval = vi.fn<AskApproval>()
		mockHandleError = vi.fn<HandleError>()
		mockToolDescription = vi.fn<() => string>()
		mockAskFinishSubTaskApproval = vi.fn<() => Promise<boolean>>()
		mockGetConfiguration = vi.fn<() => any>(() => ({
			get: vi.fn((key: string, defaultValue: any) => {
				if (key === "preventCompletionWithOpenTodos") {
					return defaultValue // Default to false unless overridden in test
				}
				return defaultValue
			}),
		}))

		// Setup vscode mock
		vi.mocked(vscode.workspace.getConfiguration).mockImplementation(mockGetConfiguration)

		mockTask = {
			consecutiveMistakeCount: 0,
			recordToolError: vi.fn(),
			stopDelegatedCompletion: vi.fn().mockResolvedValue(undefined),
			todoList: undefined,
			say: vi.fn().mockResolvedValue(undefined),
			ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked", text: "", images: [] }),
			emitFinalTokenUsageUpdate: vi.fn(),
			emit: vi.fn(),
			getTokenUsage: vi.fn().mockReturnValue({}),
			toolUsage: {},
			messageCounts: { user: 0, assistant: 0 },
			taskId: "task_1",
			apiConfiguration: { apiProvider: "test" } as any,
			api: { getModel: vi.fn().mockReturnValue({ id: "test-model", info: {} }) } as any,
			flushTelemetryInstallment: vi.fn(),
			setPendingTaskAction: vi.fn(),
			persistQueuedFeedbackAndAcknowledge: vi.fn().mockResolvedValue(true),
			waitForCurrentAssistantMessagePersistence: vi.fn().mockResolvedValue(true),
		}
	})

	describe("todo list validation", () => {
		it("should allow completion when there is no todo list", async () => {
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "Task completed successfully" },
				nativeArgs: { result: "Task completed successfully" },
				partial: false,
			}

			mockTask.todoList = undefined

			const callbacks: AttemptCompletionCallbacks = {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
				toolDescription: mockToolDescription,
			}
			await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

			// Should not call pushToolResult with an error for empty todo list
			expect(mockTask.consecutiveMistakeCount).toBe(0)
			expect(mockTask.recordToolError).not.toHaveBeenCalled()
		})

		it("should allow completion when todo list is empty", async () => {
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "Task completed successfully" },
				nativeArgs: { result: "Task completed successfully" },
				partial: false,
			}

			mockTask.todoList = []

			const callbacks: AttemptCompletionCallbacks = {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
				toolDescription: mockToolDescription,
			}
			await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

			expect(mockTask.consecutiveMistakeCount).toBe(0)
			expect(mockTask.recordToolError).not.toHaveBeenCalled()
		})

		it("should allow completion when all todos are completed", async () => {
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "Task completed successfully" },
				nativeArgs: { result: "Task completed successfully" },
				partial: false,
			}

			const completedTodos: TodoItem[] = [
				{ id: "1", content: "First task", status: "completed" },
				{ id: "2", content: "Second task", status: "completed" },
			]

			mockTask.todoList = completedTodos

			const callbacks: AttemptCompletionCallbacks = {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
				toolDescription: mockToolDescription,
			}
			await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

			expect(mockTask.consecutiveMistakeCount).toBe(0)
			expect(mockTask.recordToolError).not.toHaveBeenCalled()
		})

		it("should prevent completion when there are pending todos", async () => {
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "Task completed successfully" },
				nativeArgs: { result: "Task completed successfully" },
				partial: false,
			}

			const todosWithPending: TodoItem[] = [
				{ id: "1", content: "First task", status: "completed" },
				{ id: "2", content: "Second task", status: "pending" },
			]

			mockTask.todoList = todosWithPending

			// Enable the setting to prevent completion with open todos
			mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string, defaultValue: any) => {
					if (key === "preventCompletionWithOpenTodos") {
						return true // Setting is enabled
					}
					return defaultValue
				}),
			})

			const callbacks: AttemptCompletionCallbacks = {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
				toolDescription: mockToolDescription,
			}
			await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("attempt_completion")
			expect(mockPushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("Cannot complete task while there are incomplete todos"),
			)
		})

		it("should prevent completion when there are in-progress todos", async () => {
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "Task completed successfully" },
				nativeArgs: { result: "Task completed successfully" },
				partial: false,
			}

			const todosWithInProgress: TodoItem[] = [
				{ id: "1", content: "First task", status: "completed" },
				{ id: "2", content: "Second task", status: "in_progress" },
			]

			mockTask.todoList = todosWithInProgress

			// Enable the setting to prevent completion with open todos
			mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string, defaultValue: any) => {
					if (key === "preventCompletionWithOpenTodos") {
						return true // Setting is enabled
					}
					return defaultValue
				}),
			})

			const callbacks: AttemptCompletionCallbacks = {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
				toolDescription: mockToolDescription,
			}
			await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("attempt_completion")
			expect(mockPushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("Cannot complete task while there are incomplete todos"),
			)
		})

		it("should prevent completion when there are mixed incomplete todos", async () => {
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "Task completed successfully" },
				nativeArgs: { result: "Task completed successfully" },
				partial: false,
			}

			const mixedTodos: TodoItem[] = [
				{ id: "1", content: "First task", status: "completed" },
				{ id: "2", content: "Second task", status: "pending" },
				{ id: "3", content: "Third task", status: "in_progress" },
			]

			mockTask.todoList = mixedTodos

			// Enable the setting to prevent completion with open todos
			mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string, defaultValue: any) => {
					if (key === "preventCompletionWithOpenTodos") {
						return true // Setting is enabled
					}
					return defaultValue
				}),
			})

			const callbacks: AttemptCompletionCallbacks = {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
				toolDescription: mockToolDescription,
			}
			await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("attempt_completion")
			expect(mockPushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("Cannot complete task while there are incomplete todos"),
			)
		})

		it("should allow completion when setting is disabled even with incomplete todos", async () => {
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "Task completed successfully" },
				nativeArgs: { result: "Task completed successfully" },
				partial: false,
			}

			const todosWithPending: TodoItem[] = [
				{ id: "1", content: "First task", status: "completed" },
				{ id: "2", content: "Second task", status: "pending" },
			]

			mockTask.todoList = todosWithPending

			// Ensure the setting is disabled (default behavior)
			mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string, defaultValue: any) => {
					if (key === "preventCompletionWithOpenTodos") {
						return false // Setting is disabled
					}
					return defaultValue
				}),
			})

			const callbacks: AttemptCompletionCallbacks = {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
				toolDescription: mockToolDescription,
			}
			await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

			// Should not prevent completion when setting is disabled
			expect(mockTask.consecutiveMistakeCount).toBe(0)
			expect(mockTask.recordToolError).not.toHaveBeenCalled()
			expect(mockPushToolResult).not.toHaveBeenCalledWith(
				expect.stringContaining("Cannot complete task while there are incomplete todos"),
			)
		})

		it("should prevent completion when setting is enabled with incomplete todos", async () => {
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "Task completed successfully" },
				nativeArgs: { result: "Task completed successfully" },
				partial: false,
			}

			const todosWithPending: TodoItem[] = [
				{ id: "1", content: "First task", status: "completed" },
				{ id: "2", content: "Second task", status: "pending" },
			]

			mockTask.todoList = todosWithPending

			// Enable the setting
			mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string, defaultValue: any) => {
					if (key === "preventCompletionWithOpenTodos") {
						return true // Setting is enabled
					}
					return defaultValue
				}),
			})

			const callbacks: AttemptCompletionCallbacks = {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
				toolDescription: mockToolDescription,
			}
			await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

			// Should prevent completion when setting is enabled and there are incomplete todos
			expect(mockTask.consecutiveMistakeCount).toBe(1)
			expect(mockTask.recordToolError).toHaveBeenCalledWith("attempt_completion")
			expect(mockPushToolResult).toHaveBeenCalledWith(
				expect.stringContaining("Cannot complete task while there are incomplete todos"),
			)
		})

		it("should allow completion when setting is enabled but all todos are completed", async () => {
			const block: AttemptCompletionToolUse = {
				type: "tool_use",
				name: "attempt_completion",
				params: { result: "Task completed successfully" },
				nativeArgs: { result: "Task completed successfully" },
				partial: false,
			}

			const completedTodos: TodoItem[] = [
				{ id: "1", content: "First task", status: "completed" },
				{ id: "2", content: "Second task", status: "completed" },
			]

			mockTask.todoList = completedTodos

			// Enable the setting
			mockGetConfiguration.mockReturnValue({
				get: vi.fn((key: string, defaultValue: any) => {
					if (key === "preventCompletionWithOpenTodos") {
						return true // Setting is enabled
					}
					return defaultValue
				}),
			})

			const callbacks: AttemptCompletionCallbacks = {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
				askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
				toolDescription: mockToolDescription,
			}
			await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

			// Should allow completion when setting is enabled but all todos are completed
			expect(mockTask.consecutiveMistakeCount).toBe(0)
			expect(mockTask.recordToolError).not.toHaveBeenCalled()
			expect(mockPushToolResult).not.toHaveBeenCalledWith(
				expect.stringContaining("Cannot complete task while there are incomplete todos"),
			)
		})

		describe("tool failure guardrail", () => {
			it("should prevent completion when a previous tool failed in the current turn", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "Task completed successfully" },
					nativeArgs: { result: "Task completed successfully" },
					partial: false,
				}

				mockTask.todoList = undefined
				mockTask.didToolFailInCurrentTurn = true

				const callbacks: AttemptCompletionCallbacks = {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				}

				const mockSay = vi.fn()
				mockTask.say = mockSay

				await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

				expect(mockSay).toHaveBeenCalledWith(
					"error",
					expect.stringContaining("errors.attempt_completion_tool_failed"),
				)
				expect(mockPushToolResult).toHaveBeenCalledWith(
					expect.stringContaining("errors.attempt_completion_tool_failed"),
				)
			})

			it("should allow completion when no tools failed", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "Task completed successfully" },
					nativeArgs: { result: "Task completed successfully" },
					partial: false,
				}

				mockTask.todoList = undefined
				mockTask.didToolFailInCurrentTurn = false

				const callbacks: AttemptCompletionCallbacks = {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				}

				await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

				expect(mockTask.consecutiveMistakeCount).toBe(0)
				expect(mockTask.recordToolError).not.toHaveBeenCalled()
			})
		})

		describe("completion lifecycle", () => {
			it("delegates an active subtask completion when the active parent awaits that child", async () => {
				let markPersistenceReady!: () => void
				const persistenceReady = new Promise<boolean>((resolve) => {
					markPersistenceReady = () => resolve(true)
				})
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "9" },
					nativeArgs: { result: "9" },
					partial: false,
				}
				const mockProvider = {
					log: vi.fn(),
					getTaskMetadata: vi.fn().mockImplementation((id: string) => {
						if (id === "child-1") {
							return Promise.resolve({
								kind: "found",
								item: { id, status: "active", parentTaskId: "parent-1" },
							})
						}
						if (id === "parent-1") {
							return Promise.resolve({
								kind: "found",
								item: { id, status: "active", awaitingChildId: "child-1" },
							})
						}
						throw new Error(`unexpected task id ${id}`)
					}),
					setPendingTaskAction: vi.fn().mockResolvedValue(undefined),
					clearPendingTaskAction: vi.fn().mockResolvedValue(true),
					reopenParentFromDelegation: vi.fn().mockResolvedValue(true),
					emitDelegatedTaskCompleted: vi.fn(),
				}

				Object.assign(mockTask, {
					taskId: "child-1",
					parentTaskId: "parent-1",
					providerRef: { deref: () => mockProvider },
					waitForCurrentAssistantMessagePersistence: vi.fn(() => persistenceReady),
				})
				mockAskFinishSubTaskApproval.mockResolvedValue(true)

				const callbacks: AttemptCompletionCallbacks = {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
					toolCallId: "call-attempt-completion",
				}

				const handlingCompletion = attemptCompletionTool.handle(mockTask as Task, block, callbacks)
				await vi.waitFor(() => expect(mockTask.waitForCurrentAssistantMessagePersistence).toHaveBeenCalled())
				expect(mockProvider.reopenParentFromDelegation).not.toHaveBeenCalled()

				markPersistenceReady()
				await handlingCompletion

				expect(mockAskFinishSubTaskApproval).toHaveBeenCalled()
				expect(mockProvider.setPendingTaskAction).toHaveBeenCalledWith("child-1", {
					kind: "finish_subtask",
					actionId: "call-attempt-completion",
					approvalText: JSON.stringify({ tool: "finishTask" }),
					parentTaskId: "parent-1",
					result: "9",
				})
				expect(mockProvider.reopenParentFromDelegation).toHaveBeenCalledWith({
					parentTaskId: "parent-1",
					childTaskId: "child-1",
					completionResultSummary: "9",
					pendingActionId: "call-attempt-completion",
				})
				expect(mockTask.ask).not.toHaveBeenCalled()
				expect(mockPushToolResult).toHaveBeenCalledWith("")
				expect(mockTask.emitFinalTokenUsageUpdate).toHaveBeenCalledTimes(1)
				expect(mockProvider.emitDelegatedTaskCompleted).toHaveBeenCalledTimes(1)
				expect(mockTask.emit).not.toHaveBeenCalledWith(
					RooCodeEventName.TaskCompleted,
					expect.anything(),
					expect.anything(),
					expect.anything(),
				)
			})

			it("does not delegate or emit completion when child history persistence fails", async () => {
				const persistenceError = new Error("history unavailable")
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "9" },
					nativeArgs: { result: "9" },
					partial: false,
				}
				const mockProvider = {
					log: vi.fn(),
					getTaskMetadata: vi.fn().mockImplementation((id: string) =>
						Promise.resolve({
							kind: "found",
							item:
								id === "child-1"
									? { id, status: "active", parentTaskId: "parent-1" }
									: { id, status: "active", awaitingChildId: "child-1" },
						}),
					),
					setPendingTaskAction: vi.fn().mockResolvedValue(undefined),
					reopenParentFromDelegation: vi.fn().mockResolvedValue(true),
				}

				Object.assign(mockTask, {
					taskId: "child-1",
					parentTaskId: "parent-1",
					providerRef: { deref: () => mockProvider },
					waitForCurrentAssistantMessagePersistence: vi.fn().mockRejectedValue(persistenceError),
				})

				await attemptCompletionTool.handle(mockTask as Task, block, {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
					toolCallId: "call-attempt-completion",
				})

				expect(mockHandleError).not.toHaveBeenCalled()
				expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("preapproval_durability"))
				expect(mockAskFinishSubTaskApproval).not.toHaveBeenCalled()
				expect(mockProvider.reopenParentFromDelegation).not.toHaveBeenCalled()
				expect(mockTask.emit).not.toHaveBeenCalledWith(
					RooCodeEventName.TaskCompleted,
					expect.anything(),
					expect.anything(),
					expect.anything(),
				)
			})

			it("does not delegate or report an error when child history persistence is cancelled", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "9" },
					nativeArgs: { result: "9" },
					partial: false,
				}
				const mockProvider = {
					log: vi.fn(),
					getTaskMetadata: vi.fn().mockImplementation((id: string) =>
						Promise.resolve({
							kind: "found",
							item:
								id === "child-1"
									? { id, status: "active", parentTaskId: "parent-1" }
									: { id, status: "active", awaitingChildId: "child-1" },
						}),
					),
					setPendingTaskAction: vi.fn().mockResolvedValue(undefined),
					reopenParentFromDelegation: vi.fn().mockResolvedValue(true),
				}

				Object.assign(mockTask, {
					taskId: "child-1",
					parentTaskId: "parent-1",
					providerRef: { deref: () => mockProvider },
					waitForCurrentAssistantMessagePersistence: vi.fn().mockResolvedValue(false),
				})

				await attemptCompletionTool.handle(mockTask as Task, block, {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
					toolCallId: "call-attempt-completion",
				})

				expect(mockHandleError).not.toHaveBeenCalled()
				expect(mockAskFinishSubTaskApproval).not.toHaveBeenCalled()
				expect(mockProvider.reopenParentFromDelegation).not.toHaveBeenCalled()
				expect(mockTask.emit).not.toHaveBeenCalledWith(
					RooCodeEventName.TaskCompleted,
					expect.anything(),
					expect.anything(),
					expect.anything(),
				)
			})

			it("does not reopen the parent when persistence is cancelled during approval", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "9" },
					nativeArgs: { result: "9" },
					partial: false,
				}
				const mockProvider = {
					log: vi.fn(),
					getTaskMetadata: vi.fn().mockImplementation((id: string) =>
						Promise.resolve({
							kind: "found",
							item:
								id === "child-1"
									? { id, status: "active", parentTaskId: "parent-1" }
									: { id, status: "active", awaitingChildId: "child-1" },
						}),
					),
					setPendingTaskAction: vi.fn().mockResolvedValue(undefined),
					reopenParentFromDelegation: vi.fn().mockResolvedValue(true),
				}

				Object.assign(mockTask, {
					taskId: "child-1",
					parentTaskId: "parent-1",
					providerRef: { deref: () => mockProvider },
					waitForCurrentAssistantMessagePersistence: vi
						.fn()
						.mockResolvedValueOnce(true)
						.mockResolvedValueOnce(false),
				})
				mockAskFinishSubTaskApproval.mockResolvedValue(true)

				await attemptCompletionTool.handle(mockTask as Task, block, {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
					toolCallId: "call-attempt-completion",
				})

				expect(mockTask.waitForCurrentAssistantMessagePersistence).toHaveBeenCalledTimes(2)
				expect(mockProvider.reopenParentFromDelegation).not.toHaveBeenCalled()
				expect(mockTask.emit).not.toHaveBeenCalledWith(
					RooCodeEventName.TaskCompleted,
					expect.anything(),
					expect.anything(),
					expect.anything(),
				)
			})

			it("keeps a still-owned child blocked when handoff fails after approval", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "9" },
					nativeArgs: { result: "9" },
					partial: false,
				}
				const mockProvider = {
					log: vi.fn(),
					getTaskMetadata: vi.fn().mockImplementation((id: string) => {
						if (id === "child-1") {
							return Promise.resolve({
								kind: "found",
								item: { id, status: "active", parentTaskId: "parent-1" },
							})
						}
						if (id === "parent-1") {
							return Promise.resolve({
								kind: "found",
								item: { id, status: "delegated", awaitingChildId: "child-1" },
							})
						}
						throw new Error(`unexpected task id ${id}`)
					}),
					setPendingTaskAction: vi.fn().mockResolvedValue(undefined),
					clearPendingTaskAction: vi.fn().mockResolvedValue(true),
					markDelegatedChildProtocolBlocked: vi.fn().mockResolvedValue(true),
					reopenParentFromDelegation: vi.fn().mockResolvedValue({
						kind: "recoverable_failure",
						phase: "precommit",
						reason: "history_write_failed",
					}),
				}

				Object.assign(mockTask, {
					taskId: "child-1",
					parentTaskId: "parent-1",
					providerRef: { deref: () => mockProvider },
				})
				mockTask.ask = vi.fn().mockResolvedValue({ response: "messageResponse", text: "revise", images: [] })
				mockAskFinishSubTaskApproval.mockResolvedValue(true)

				const callbacks: AttemptCompletionCallbacks = {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
					toolCallId: "call-stale-completion",
				}

				await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

				expect(mockProvider.reopenParentFromDelegation).toHaveBeenCalledWith({
					parentTaskId: "parent-1",
					childTaskId: "child-1",
					completionResultSummary: "9",
					pendingActionId: "call-stale-completion",
				})
				expect(mockProvider.clearPendingTaskAction).not.toHaveBeenCalled()
				expect(mockProvider.markDelegatedChildProtocolBlocked).toHaveBeenCalledWith({
					parentTaskId: "parent-1",
					childTaskId: "child-1",
				})
				expect(mockTask.ask).not.toHaveBeenCalledWith("completion_result", "", false)
				expect(mockPushToolResult).toHaveBeenCalledWith(
					expect.stringContaining('"reason":"history_write_failed"'),
				)
				expect(mockPushToolResult).not.toHaveBeenCalledWith("")
				expect(mockTask.flushTelemetryInstallment).not.toHaveBeenCalled()
			})

			it("does not resume the parent when the parent is no longer awaiting this child", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "9" },
					nativeArgs: { result: "9" },
					partial: false,
				}
				const mockProvider = {
					log: vi.fn(),
					getTaskMetadata: vi.fn().mockImplementation((id: string) => {
						if (id === "child-1") {
							return Promise.resolve({
								kind: "found",
								item: { id, status: "active", parentTaskId: undefined },
							})
						}
						if (id === "parent-1") {
							return Promise.resolve({
								kind: "found",
								item: { id, status: "active", awaitingChildId: undefined },
							})
						}
						throw new Error(`unexpected task id ${id}`)
					}),
					reopenParentFromDelegation: vi.fn().mockResolvedValue(undefined),
				}

				Object.assign(mockTask, {
					taskId: "child-1",
					parentTaskId: "parent-1",
					providerRef: { deref: () => mockProvider },
				})
				mockAskFinishSubTaskApproval.mockResolvedValue(true)

				const callbacks: AttemptCompletionCallbacks = {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				}

				await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

				expect(mockAskFinishSubTaskApproval).not.toHaveBeenCalled()
				expect(mockProvider.reopenParentFromDelegation).not.toHaveBeenCalled()
				expect(mockTask.ask).toHaveBeenCalledWith("completion_result", "", false)
				expect(mockTask.flushTelemetryInstallment).not.toHaveBeenCalled()
			})

			it("delegates an interrupted subtask completion when the parent is still delegated and awaiting that child", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "9" },
					nativeArgs: { result: "9" },
					partial: false,
				}
				const mockProvider = {
					log: vi.fn(),
					getTaskMetadata: vi.fn().mockImplementation((id: string) => {
						if (id === "child-1") {
							return Promise.resolve({
								kind: "found",
								item: { id, status: "interrupted", parentTaskId: "parent-1" },
							})
						}
						if (id === "parent-1") {
							return Promise.resolve({
								kind: "found",
								item: { id, status: "delegated", awaitingChildId: "child-1" },
							})
						}
						throw new Error(`unexpected task id ${id}`)
					}),
					reopenParentFromDelegation: vi.fn().mockResolvedValue(true),
					emitDelegatedTaskCompleted: vi.fn(),
				}

				Object.assign(mockTask, {
					taskId: "child-1",
					parentTaskId: "parent-1",
					providerRef: { deref: () => mockProvider },
				})
				mockAskFinishSubTaskApproval.mockResolvedValue(true)

				const callbacks: AttemptCompletionCallbacks = {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				}

				await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

				expect(mockAskFinishSubTaskApproval).toHaveBeenCalled()
				expect(mockProvider.reopenParentFromDelegation).toHaveBeenCalledWith({
					parentTaskId: "parent-1",
					childTaskId: "child-1",
					completionResultSummary: "9",
				})
				expect(mockTask.ask).not.toHaveBeenCalled()
				expect(mockPushToolResult).toHaveBeenCalledWith("")
				expect(mockProvider.emitDelegatedTaskCompleted).toHaveBeenCalledTimes(1)
			})

			it("does not resume the parent when the parent is active but awaiting a different child", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "9" },
					nativeArgs: { result: "9" },
					partial: false,
				}
				const mockProvider = {
					log: vi.fn(),
					getTaskMetadata: vi.fn().mockImplementation((id: string) => {
						if (id === "child-1") {
							return Promise.resolve({
								kind: "found",
								item: { id, status: "active", parentTaskId: "parent-1" },
							})
						}
						if (id === "parent-1") {
							return Promise.resolve({
								kind: "found",
								item: { id, status: "active", awaitingChildId: "different-child" },
							})
						}
						throw new Error(`unexpected task id ${id}`)
					}),
					reopenParentFromDelegation: vi.fn().mockResolvedValue(undefined),
				}

				Object.assign(mockTask, {
					taskId: "child-1",
					parentTaskId: "parent-1",
					providerRef: { deref: () => mockProvider },
				})
				mockAskFinishSubTaskApproval.mockResolvedValue(true)

				const callbacks: AttemptCompletionCallbacks = {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				}

				await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

				expect(mockAskFinishSubTaskApproval).not.toHaveBeenCalled()
				expect(mockProvider.reopenParentFromDelegation).not.toHaveBeenCalled()
				expect(mockTask.ask).not.toHaveBeenCalledWith("completion_result", "", false)
				expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining('"reason":"ownership_moved"'))
				expect(mockTask.flushTelemetryInstallment).not.toHaveBeenCalled()
			})

			it("emits TaskCompleted only when completion is accepted", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "2" },
					nativeArgs: { result: "2" },
					partial: false,
				}

				mockTask.ask = vi.fn().mockResolvedValue({ response: "yesButtonClicked", text: "", images: [] })

				const callbacks: AttemptCompletionCallbacks = {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				}

				await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

				expect(mockHandleError).not.toHaveBeenCalled()
				expect(mockTask.flushTelemetryInstallment).toHaveBeenCalledTimes(1)
				expect(mockTask.flushTelemetryInstallment).toHaveBeenCalledWith("attempt_completion")
				expect(mockTask.waitForCurrentAssistantMessagePersistence).toHaveBeenCalledTimes(1)
				expect(
					vi.mocked(mockTask.waitForCurrentAssistantMessagePersistence!).mock.invocationCallOrder[0],
				).toBeLessThan(vi.mocked(mockTask.emit!).mock.invocationCallOrder[0])
				expect(mockTask.emit).toHaveBeenCalledWith(
					RooCodeEventName.TaskCompleted,
					"task_1",
					expect.anything(),
					expect.anything(),
				)
			})

			it("does not emit TaskCompleted when persistence is cancelled", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "2" },
					nativeArgs: { result: "2" },
					partial: false,
				}
				mockTask.ask = vi.fn().mockResolvedValue({ response: "yesButtonClicked", text: "", images: [] })
				mockTask.waitForCurrentAssistantMessagePersistence = vi.fn().mockResolvedValue(false)

				await attemptCompletionTool.handle(mockTask as Task, block, {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				})

				expect(mockHandleError).not.toHaveBeenCalled()
				expect(mockTask.emit).not.toHaveBeenCalledWith(
					RooCodeEventName.TaskCompleted,
					expect.anything(),
					expect.anything(),
					expect.anything(),
				)
			})

			it("reports accepted-completion persistence failures with persistence context", async () => {
				const persistenceError = new Error("history write failed")
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "2" },
					nativeArgs: { result: "2" },
					partial: false,
				}
				mockTask.ask = vi.fn().mockResolvedValue({ response: "yesButtonClicked", text: "", images: [] })
				mockTask.waitForCurrentAssistantMessagePersistence = vi.fn().mockRejectedValue(persistenceError)

				await attemptCompletionTool.handle(mockTask as Task, block, {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				})

				expect(mockHandleError).toHaveBeenCalledWith("persisting task completion", persistenceError)
				expect(mockTask.emit).not.toHaveBeenCalledWith(
					RooCodeEventName.TaskCompleted,
					expect.anything(),
					expect.anything(),
					expect.anything(),
				)
			})

			it("reports telemetry but does not emit the public TaskCompleted event when user provides follow-up feedback", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "2" },
					nativeArgs: { result: "2" },
					partial: false,
				}

				mockTask.ask = vi.fn().mockResolvedValue({
					response: "messageResponse",
					text: "Different question now: what is 3+3?",
					images: [],
				})

				const callbacks: AttemptCompletionCallbacks = {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				}

				await attemptCompletionTool.handle(mockTask as Task, block, callbacks)

				expect(mockHandleError).not.toHaveBeenCalled()
				// Telemetry is reported on every model-initiated attempt_completion call,
				// regardless of whether the user accepts, declines, or gives feedback.
				expect(mockTask.flushTelemetryInstallment).toHaveBeenCalledTimes(1)
				expect(mockTask.flushTelemetryInstallment).toHaveBeenCalledWith("attempt_completion")
				// The public RooCodeEventName.TaskCompleted API event still only fires once
				// the user actually accepts the result.
				expect(mockTask.emit).not.toHaveBeenCalledWith(
					RooCodeEventName.TaskCompleted,
					expect.anything(),
					expect.anything(),
					expect.anything(),
				)
				expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("<user_message>"))
			})

			it("durably persists queued completion feedback before continuing", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "Done" },
					nativeArgs: { result: "Done" },
					partial: false,
				}
				mockTask.ask = vi.fn().mockResolvedValue({
					response: "messageResponse",
					text: "One more change",
					queuedMessageId: "queued-1",
				})

				await attemptCompletionTool.handle(mockTask as Task, block, {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				})

				expect(mockTask.persistQueuedFeedbackAndAcknowledge).toHaveBeenCalledWith(
					"queued-1",
					"One more change",
					undefined,
				)
				expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("One more change"))
			})

			it("does not continue when queued completion feedback persistence fails", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "Done" },
					nativeArgs: { result: "Done" },
					partial: false,
				}
				mockTask.ask = vi.fn().mockResolvedValue({
					response: "messageResponse",
					text: "One more change",
					queuedMessageId: "queued-1",
				})
				mockTask.persistQueuedFeedbackAndAcknowledge = vi.fn().mockResolvedValue(false)

				await attemptCompletionTool.handle(mockTask as Task, block, {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				})

				expect(mockHandleError).toHaveBeenCalledWith(
					"inspecting site",
					expect.objectContaining({ message: expect.stringContaining("queued-1") }),
				)
				expect(mockPushToolResult).not.toHaveBeenCalled()
			})

			it("records image-only completion feedback before continuing", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "Done" },
					nativeArgs: { result: "Done" },
					partial: false,
				}
				mockTask.ask = vi.fn().mockResolvedValue({
					response: "messageResponse",
					images: ["data:image/png;base64,feedback"],
				})

				await attemptCompletionTool.handle(mockTask as Task, block, {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				})

				expect(mockTask.say).toHaveBeenCalledWith("user_feedback", "", ["data:image/png;base64,feedback"])
				expect(mockPushToolResult).toHaveBeenCalledTimes(1)
			})

			it("does not clear pending metadata when stale delegation continues without an action id", async () => {
				const block: AttemptCompletionToolUse = {
					type: "tool_use",
					name: "attempt_completion",
					params: { result: "Done" },
					nativeArgs: { result: "Done" },
					partial: false,
				}
				const mockProvider = {
					log: vi.fn(),
					getTaskMetadata: vi.fn().mockImplementation((id: string) =>
						Promise.resolve({
							kind: "found",
							item:
								id === "child-1"
									? { id, status: "active", parentTaskId: "parent-1" }
									: { id, status: "delegated", awaitingChildId: "child-1" },
						}),
					),
					setPendingTaskAction: vi.fn(),
					clearPendingTaskAction: vi.fn(),
					reopenParentFromDelegation: vi
						.fn()
						.mockResolvedValue({ kind: "detached", phase: "precommit", reason: "ownership_moved" }),
				}
				Object.assign(mockTask, {
					taskId: "child-1",
					parentTaskId: "parent-1",
					providerRef: { deref: () => mockProvider },
				})
				mockAskFinishSubTaskApproval.mockResolvedValue(true)

				await attemptCompletionTool.handle(mockTask as Task, block, {
					askApproval: mockAskApproval,
					handleError: mockHandleError,
					pushToolResult: mockPushToolResult,
					askFinishSubTaskApproval: mockAskFinishSubTaskApproval,
					toolDescription: mockToolDescription,
				})

				expect(mockProvider.reopenParentFromDelegation).toHaveBeenCalledWith({
					parentTaskId: "parent-1",
					childTaskId: "child-1",
					completionResultSummary: "Done",
				})
				expect(mockProvider.clearPendingTaskAction).not.toHaveBeenCalled()
				expect(mockTask.ask).toHaveBeenCalledWith("completion_result", "", false)
			})
		})
	})
})

describe("attemptCompletionTool telemetry invariants", () => {
	function makeTask(overrides: Partial<Task> = {}): Partial<Task> {
		return {
			consecutiveMistakeCount: 0,
			recordToolError: vi.fn(),
			stopDelegatedCompletion: vi.fn().mockResolvedValue(undefined),
			todoList: undefined,
			say: vi.fn().mockResolvedValue(undefined),
			ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked", text: "", images: [] }),
			emitFinalTokenUsageUpdate: vi.fn(),
			emit: vi.fn(),
			getTokenUsage: vi.fn().mockReturnValue({}),
			toolUsage: {},
			messageCounts: { user: 0, assistant: 0 },
			taskId: "task_1",
			flushTelemetryInstallment: vi.fn(),
			waitForCurrentAssistantMessagePersistence: vi.fn().mockResolvedValue(true),
			...overrides,
		}
	}

	it("does not emit a duplicate telemetry installment when replaying an already-completed subtask from history", async () => {
		const block: AttemptCompletionToolUse = {
			type: "tool_use",
			name: "attempt_completion",
			params: { result: "done" },
			nativeArgs: { result: "done" },
			partial: false,
		}
		const mockProvider = {
			log: vi.fn(),
			getTaskMetadata: vi.fn().mockImplementation((id: string) => {
				if (id === "child-1") return Promise.resolve({ kind: "found", item: { id, status: "completed" } })
				throw new Error(`unexpected task id ${id}`)
			}),
			reopenParentFromDelegation: vi.fn(),
		}

		const task = makeTask({
			taskId: "child-1",
			parentTaskId: "parent-1",
			toolUsage: { read_file: { attempts: 5, failures: 0 } },
			messageCounts: { user: 3, assistant: 4 },
		})
		Object.assign(task, { providerRef: { deref: () => mockProvider } })

		await attemptCompletionTool.handle(task as Task, block, {
			askApproval: vi.fn(),
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
			askFinishSubTaskApproval: vi.fn(),
			toolDescription: vi.fn(),
		} as AttemptCompletionCallbacks)

		expect(task.flushTelemetryInstallment).not.toHaveBeenCalled()
	})

	it("does not emit the public TaskCompleted event when replaying an already-completed subtask from history", async () => {
		const block: AttemptCompletionToolUse = {
			type: "tool_use",
			name: "attempt_completion",
			params: { result: "done" },
			nativeArgs: { result: "done" },
			partial: false,
		}
		const mockProvider = {
			log: vi.fn(),
			getTaskMetadata: vi.fn().mockImplementation((id: string) => {
				if (id === "child-1") return Promise.resolve({ kind: "found", item: { id, status: "completed" } })
				throw new Error(`unexpected task id ${id}`)
			}),
			reopenParentFromDelegation: vi.fn(),
		}

		const task = makeTask({
			taskId: "child-1",
			parentTaskId: "parent-1",
			ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked", text: "", images: [] }),
		})
		Object.assign(task, { providerRef: { deref: () => mockProvider } })

		await attemptCompletionTool.handle(task as Task, block, {
			askApproval: vi.fn(),
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
			askFinishSubTaskApproval: vi.fn(),
			toolDescription: vi.fn(),
		} as AttemptCompletionCallbacks)

		expect(task.emit).not.toHaveBeenCalledWith(
			RooCodeEventName.TaskCompleted,
			expect.anything(),
			expect.anything(),
			expect.anything(),
		)
	})

	it("emits the public TaskCompleted API event only when completion is accepted, but reports telemetry either way", async () => {
		const block: AttemptCompletionToolUse = {
			type: "tool_use",
			name: "attempt_completion",
			params: { result: "done" },
			nativeArgs: { result: "done" },
			partial: false,
		}

		const task = makeTask({
			ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked", text: "", images: [] }),
		})

		await attemptCompletionTool.handle(task as Task, block, {
			askApproval: vi.fn(),
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
			askFinishSubTaskApproval: vi.fn(),
			toolDescription: vi.fn(),
		} as AttemptCompletionCallbacks)

		expect(task.flushTelemetryInstallment).toHaveBeenCalledTimes(1)
		expect(task.flushTelemetryInstallment).toHaveBeenCalledWith("attempt_completion")
		expect(task.emit).toHaveBeenCalledWith(
			RooCodeEventName.TaskCompleted,
			"task_1",
			expect.anything(),
			expect.anything(),
		)
	})

	it("still reports telemetry for a model-initiated completion even when the user provides follow-up feedback instead of accepting", async () => {
		const block: AttemptCompletionToolUse = {
			type: "tool_use",
			name: "attempt_completion",
			params: { result: "done" },
			nativeArgs: { result: "done" },
			partial: false,
		}

		const task = makeTask({
			ask: vi.fn().mockResolvedValue({ response: "messageResponse", text: "one more thing", images: [] }),
		})

		await attemptCompletionTool.handle(task as Task, block, {
			askApproval: vi.fn(),
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
			askFinishSubTaskApproval: vi.fn(),
			toolDescription: vi.fn(),
		} as AttemptCompletionCallbacks)

		expect(task.flushTelemetryInstallment).toHaveBeenCalledTimes(1)
		expect(task.flushTelemetryInstallment).toHaveBeenCalledWith("attempt_completion")
		expect(task.emit).not.toHaveBeenCalledWith(
			RooCodeEventName.TaskCompleted,
			expect.anything(),
			expect.anything(),
			expect.anything(),
		)
	})
})

describe("delegated completion stage boundaries", () => {
	const saved = {
		kind: "finish_subtask" as const,
		actionId: "original-action",
		approvalText: "original approval",
		parentTaskId: "parent",
		result: "original result",
	}
	function setup() {
		const child = {
			id: "child",
			status: "active",
			parentTaskId: "parent",
			pendingAction: undefined as typeof saved | undefined,
		}
		const parent = { id: "parent", status: "delegated", awaitingChildId: "child", delegatedToId: "child" }
		const provider = {
			log: vi.fn(),
			getTaskMetadata: vi.fn(
				async (
					id: string,
				): Promise<
					| { kind: "found"; item: Partial<typeof child & typeof parent> }
					| { kind: "missing" | "read_error"; error?: Error }
				> => ({
					kind: "found",
					item: id === "child" ? child : parent,
				}),
			),
			setPendingTaskAction: vi.fn().mockResolvedValue(undefined),
			clearPendingTaskAction: vi.fn(),
			markDelegatedChildProtocolBlocked: vi.fn().mockResolvedValue(true),
			reopenParentFromDelegation: vi.fn().mockResolvedValue({
				kind: "committed",
				phase: "committed",
				resumeState: "queued",
				correlationId: "pair",
			}),
			emitDelegatedTaskCompleted: vi.fn(),
		}
		const task = {
			taskId: "child",
			parentTaskId: "parent",
			providerRef: { deref: () => provider },
			consecutiveMistakeCount: 0,
			recordToolError: vi.fn(),
			say: vi.fn().mockResolvedValue(undefined),
			ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
			setPendingTaskAction: vi.fn(),
			waitForCurrentAssistantMessagePersistence: vi.fn().mockResolvedValue(true),
			flushTelemetryInstallment: vi.fn(),
			emitFinalTokenUsageUpdate: vi.fn(),
			getTokenUsage: vi.fn().mockReturnValue({}),
			toolUsage: {},
			isDelegatedCompletionStopped: false,
			stopDelegatedCompletion: vi.fn(async (_message: string) => {
				task.isDelegatedCompletionStopped = true
			}),
		}
		const callbacks = {
			askApproval: vi.fn(),
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
			askFinishSubTaskApproval: vi.fn().mockResolvedValue(true),
			toolDescription: vi.fn(),
			toolCallId: "new-action",
		}
		const run = () => attemptCompletionTool.execute({ result: "new result" }, task as unknown as Task, callbacks)
		return { child, parent, provider, task, callbacks, run }
	}

	it.each([
		["completion_display", "completion_display_failed"],
		["child_metadata_read", "metadata_read_failed"],
		["parent_metadata_read", "metadata_read_failed"],
		["pending_action_write", "pending_action_write_failed"],
		["approval", "approval_failed"],
		["preapproval_durability", "durability_failed"],
		["postapproval_durability", "durability_failed"],
		["provider_handoff", "unexpected_provider_rejection"],
	])("stops once with safe diagnostics for rejected %s", async (stage, reason) => {
		const { provider, task, callbacks, run } = setup()
		const error = Object.assign(new Error("SECRET raw message"), { code: "ENOSPC" })
		if (stage === "completion_display") task.say.mockRejectedValueOnce(error)
		if (stage === "child_metadata_read") provider.getTaskMetadata.mockRejectedValueOnce(error)
		if (stage === "parent_metadata_read")
			provider.getTaskMetadata
				.mockResolvedValueOnce({ kind: "found", item: { status: "active", parentTaskId: "parent" } })
				.mockRejectedValueOnce(error)
		if (stage === "pending_action_write") provider.setPendingTaskAction.mockRejectedValue(error)
		if (stage === "approval") callbacks.askFinishSubTaskApproval.mockRejectedValue(error)
		if (stage === "preapproval_durability")
			task.waitForCurrentAssistantMessagePersistence.mockRejectedValueOnce(error)
		if (stage === "postapproval_durability")
			task.waitForCurrentAssistantMessagePersistence.mockResolvedValueOnce(true).mockRejectedValueOnce(error)
		if (stage === "provider_handoff") provider.reopenParentFromDelegation.mockRejectedValue(error)
		await run()
		expect(callbacks.handleError).not.toHaveBeenCalled()
		expect(task.isDelegatedCompletionStopped).toBe(true)
		expect(callbacks.pushToolResult).toHaveBeenCalledTimes(1)
		const message = callbacks.pushToolResult.mock.calls[0][0]
		for (const field of [
			`"stage":"${stage}"`,
			`"reason":"${reason}"`,
			'"phase":"precommit"',
			'"parentTaskId":"parent"',
			'"childTaskId":"child"',
			'"name":"Error"',
			'"code":"ENOSPC"',
		])
			expect(message).toContain(field)
		expect(message).not.toContain("SECRET")
		expect(message).toContain("reopen the child")
		expect(provider.clearPendingTaskAction).not.toHaveBeenCalled()
		expect(provider.emitDelegatedTaskCompleted).not.toHaveBeenCalled()
		await run()
		expect(callbacks.pushToolResult).toHaveBeenCalledTimes(1)
	})

	it.each(["child", "parent"])("distinguishes missing and tagged read errors for %s", async (id) => {
		for (const kind of ["missing", "read_error"] as const) {
			const { provider, callbacks, run } = setup()
			const original = provider.getTaskMetadata.getMockImplementation()!
			provider.getTaskMetadata.mockImplementation(async (key) =>
				key === id ? { kind, error: new TypeError("SECRET") } : original(key),
			)
			await run()
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining(`"stage":"${id}_metadata_read"`),
			)
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining(
					`"reason":"${kind === "missing" ? `${id}_metadata_missing` : "metadata_read_failed"}"`,
				),
			)
		}
	})

	it.each(["awaitingChildId", "delegatedToId", "status"])(
		"classifies %s mismatch as ownership/state, not history lookup",
		async (field) => {
			const { parent, provider, callbacks, run } = setup()
			parent[field as keyof typeof parent] = "other"
			await run()
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(
				expect.stringContaining(
					`"reason":"${field === "status" ? "parent_state_mismatch" : "ownership_moved"}"`,
				),
			)
			expect(provider.reopenParentFromDelegation).not.toHaveBeenCalled()
		},
	)

	it("does not read a detached child's former parent", async () => {
		const { child, provider, run } = setup()
		child.parentTaskId = "other"
		await run()
		expect(provider.getTaskMetadata).toHaveBeenCalledTimes(1)
		expect(provider.reopenParentFromDelegation).not.toHaveBeenCalled()
	})

	it("retains a saved finish action when ownership already moved", async () => {
		const { child, provider, task, callbacks, run } = setup()
		child.parentTaskId = "other"
		child.pendingAction = { ...saved }
		await run()
		expect(provider.getTaskMetadata).toHaveBeenCalledTimes(1)
		expect(provider.clearPendingTaskAction).not.toHaveBeenCalled()
		expect(task.ask).not.toHaveBeenCalled()
		expect(task.isDelegatedCompletionStopped).toBe(true)
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining('"actionId":"original-action"'))
	})

	it("classifies unexpected child status without parent lookup", async () => {
		const { child, provider, callbacks, run } = setup()
		child.status = "delegated"
		await run()
		expect(provider.getTaskMetadata).toHaveBeenCalledTimes(1)
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(
			expect.stringContaining('"reason":"unexpected_child_status"'),
		)
	})

	it("preserves saved action on approval rejection", async () => {
		const { child, provider, callbacks, run } = setup()
		child.pendingAction = { ...saved }
		callbacks.askFinishSubTaskApproval.mockRejectedValue(new Error("SECRET"))
		await run()
		expect(child.pendingAction).toEqual(saved)
		expect(provider.setPendingTaskAction).not.toHaveBeenCalled()
		expect(provider.clearPendingTaskAction).not.toHaveBeenCalled()
		expect(provider.reopenParentFromDelegation).not.toHaveBeenCalled()
	})

	it.each(["telemetry", "final_token_usage", "child_completion_event", "tool_result"])(
		"cannot undo commit when %s and logger throw",
		async (stage) => {
			const { provider, task, callbacks, run } = setup()
			const fail = () => {
				throw Object.assign(new Error("SECRET"), { name: "SECRET name", code: "SECRET code" })
			}
			provider.log.mockImplementation(fail)
			if (stage === "telemetry") task.flushTelemetryInstallment.mockImplementation(fail)
			if (stage === "final_token_usage") task.emitFinalTokenUsageUpdate.mockImplementation(fail)
			if (stage === "child_completion_event") provider.emitDelegatedTaskCompleted.mockImplementation(fail)
			if (stage === "tool_result") callbacks.pushToolResult.mockImplementation(fail)
			await expect(run()).resolves.toBeUndefined()
			expect(callbacks.handleError).not.toHaveBeenCalled()
			expect(task.recordToolError).not.toHaveBeenCalled()
			expect(task.stopDelegatedCompletion).not.toHaveBeenCalled()
			expect(provider.markDelegatedChildProtocolBlocked).not.toHaveBeenCalled()
			expect(provider.reopenParentFromDelegation).toHaveBeenCalledTimes(1)
			expect(provider.emitDelegatedTaskCompleted).toHaveBeenCalledTimes(1)
			expect(callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith("")
			expect(JSON.stringify(provider.log.mock.calls)).not.toContain("SECRET")
		},
	)

	it.each([
		{ name: "SECRET".repeat(1000), code: "SECRET/path/token" },
		{
			get name() {
				throw new Error("SECRET accessor")
			},
			get code() {
				throw new Error("SECRET accessor")
			},
		},
		"SECRET primitive",
		null,
	])("omits unsafe exception properties even if blocking and logging reject", async (error) => {
		const { provider, callbacks, run } = setup()
		provider.getTaskMetadata.mockRejectedValue(error)
		provider.markDelegatedChildProtocolBlocked.mockRejectedValue(error)
		provider.log.mockImplementation(() => {
			throw error
		})
		await run()
		const message = callbacks.pushToolResult.mock.calls[0][0]
		expect(message).not.toContain("SECRET")
		expect(message).not.toContain('"name"')
		expect(message).not.toContain('"code"')
		expect(message.length).toBeLessThan(1000)
		expect(callbacks.handleError).not.toHaveBeenCalled()
	})

	it.each(["committed", "recoverable_failure", "detached", "pending", "rejected"])(
		"retains the original saved finish action through %s",
		async (kind) => {
			const { child, provider, task, callbacks, run } = setup()
			child.pendingAction = { ...saved }
			if (kind === "rejected") provider.reopenParentFromDelegation.mockRejectedValue(new Error("SECRET"))
			else
				provider.reopenParentFromDelegation.mockResolvedValue({
					kind,
					phase: kind === "committed" ? "committed" : "precommit",
					reason: kind === "pending" ? "approval" : "ownership_moved",
					resumeState: "queued",
					correlationId: "pair",
				})
			await run()
			expect(provider.setPendingTaskAction).not.toHaveBeenCalled()
			expect(provider.clearPendingTaskAction).not.toHaveBeenCalled()
			expect(child.pendingAction).toEqual(saved)
			expect(provider.reopenParentFromDelegation).toHaveBeenCalledExactlyOnceWith({
				parentTaskId: "parent",
				childTaskId: "child",
				completionResultSummary: saved.result,
				pendingActionId: saved.actionId,
			})
			expect(task.ask).not.toHaveBeenCalled()
			if (kind !== "committed") expect(task.isDelegatedCompletionStopped).toBe(true)
			expect(callbacks.handleError).not.toHaveBeenCalled()
		},
	)

	it.each([1, 2])("does not hand off when durability wait %i is cancelled", async (wait) => {
		const { task, provider, callbacks, run } = setup()
		if (wait === 2) task.waitForCurrentAssistantMessagePersistence.mockResolvedValueOnce(true)
		task.waitForCurrentAssistantMessagePersistence.mockResolvedValueOnce(false)
		await run()
		expect(provider.reopenParentFromDelegation).not.toHaveBeenCalled()
		expect(callbacks.handleError).not.toHaveBeenCalled()
		expect(callbacks.pushToolResult).not.toHaveBeenCalled()
	})

	it("stops when provider access is unavailable", async () => {
		const { task, callbacks, run } = setup()
		Object.assign(task, { providerRef: { deref: () => undefined } })
		await run()
		expect(task.isDelegatedCompletionStopped).toBe(true)
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining('"stage":"provider_access"'))
	})
})
