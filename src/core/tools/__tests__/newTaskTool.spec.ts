// npx vitest core/tools/__tests__/newTaskTool.spec.ts

import type { AskApproval, HandleError, NativeToolArgs, PushToolResult, ToolUse } from "../../../shared/tools"
import type { Task } from "../../task/Task"

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
		publisher: "ZooCodeOrganization",
		version: "1.0.0",
		outputChannel: "Zoo-Code",
	},
}))

// Mock other modules first - these are hoisted to the top
vi.mock("../../../shared/modes", () => ({
	getModeBySlug: vi.fn(),
	defaultModeSlug: "ask",
}))

vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		toolError: vi.fn((msg: string) => `Tool Error: ${msg}`),
	},
}))

vi.mock("../updateTodoListTool", () => ({
	parseMarkdownChecklist: vi.fn((md: string) => {
		// Simple mock implementation
		const lines = md.split("\n").filter((line) => line.trim())
		return lines.map((line, index) => {
			let status = "pending"
			let content = line

			if (line.includes("[x]") || line.includes("[X]")) {
				status = "completed"
				content = line.replace(/^\[x\]\s*/i, "")
			} else if (line.includes("[-]") || line.includes("[~]")) {
				status = "in_progress"
				content = line.replace(/^\[-\]\s*/, "").replace(/^\[~\]\s*/, "")
			} else {
				content = line.replace(/^\[\s*\]\s*/, "")
			}

			return {
				id: `todo-${index}`,
				content,
				status,
			}
		})
	}),
}))

// Define a minimal type for the resolved value
type MockClineInstance = { taskId: string }

// Mock dependencies after modules are mocked
const mockAskApproval = vi.fn<AskApproval>()
const mockHandleError = vi.fn<HandleError>()
const mockPushToolResult = vi.fn()
const mockEmit = vi.fn()
const mockRecordToolError = vi.fn()
const mockSayAndCreateMissingParamError = vi.fn()
const mockStartSubtask = vi
	.fn<(message: string, todoItems: any[], mode: string) => Promise<MockClineInstance>>()
	.mockResolvedValue({ taskId: "mock-subtask-id" })

// Adapter to satisfy legacy expectations while exercising new delegation path
const mockDelegateParentAndOpenChild = vi.fn(
	async (args: { parentTaskId: string; message: string; initialTodos: any[]; mode: string }) => {
		// Call legacy spy so existing expectations still pass
		await mockStartSubtask(args.message, args.initialTodos, args.mode)
		return { taskId: "child-1" }
	},
)
const mockCheckpointSave = vi.fn()

// Mock the Cline instance and its methods/properties
const mockCline = {
	ask: vi.fn(),
	waitForCurrentAssistantMessagePersistence: vi.fn(async () => true),
	waitForAnsweredAskPersistence: vi.fn(async () => {}),
	sayAndCreateMissingParamError: mockSayAndCreateMissingParamError,
	emit: mockEmit,
	recordToolError: mockRecordToolError,
	consecutiveMistakeCount: 0,
	isPaused: false,
	pausedModeSlug: "ask",
	taskId: "mock-parent-task-id",
	enableCheckpoints: false,
	checkpointSave: mockCheckpointSave,
	startSubtask: mockStartSubtask,
	providerRef: {
		deref: vi.fn(() => ({
			getTaskMetadata: vi.fn(async () => ({ kind: "found", item: { status: "active" } })),
			getState: vi.fn(() => ({ customModes: [], mode: "ask" })),
			handleModeSwitch: vi.fn(),
			delegateParentAndOpenChild: mockDelegateParentAndOpenChild,
		})),
	},
}

// Import the class to test AFTER mocks are set up
import { newTaskTool } from "../NewTaskTool"
import { getModeBySlug } from "../../../shared/modes"
import * as vscode from "vscode"

const withNativeArgs = (block: ToolUse<"new_task">): ToolUse<"new_task"> => ({
	...block,
	// Native tool calling: `nativeArgs` is the source of truth for tool execution.
	// These tests intentionally exercise missing-param behavior, so we allow undefined
	// values and let the tool's runtime validation handle it.
	nativeArgs: {
		mode: block.params.mode,
		message: block.params.message,
		todos: block.params.todos,
	} as unknown as NativeToolArgs["new_task"],
})

describe("newTaskTool", () => {
	beforeEach(() => {
		// Reset mocks before each test
		vi.clearAllMocks()
		mockAskApproval.mockResolvedValue(true) // Default to approved
		vi.mocked(getModeBySlug).mockReturnValue({
			slug: "code",
			name: "Code Mode",
			roleDefinition: "Test role definition",
			groups: ["command", "read", "edit"],
		}) // Default valid mode
		mockCline.consecutiveMistakeCount = 0
		mockCline.isPaused = false
		// Default: VSCode setting is disabled
		const mockGet = vi.fn().mockReturnValue(false)
		vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
			get: mockGet,
		} as any)
	})

	it("should correctly un-escape \\\\@ to \\@ in the message passed to the new task", async () => {
		const block: ToolUse<"new_task"> = {
			type: "tool_use", // Add required 'type' property
			name: "new_task", // Correct property name
			params: {
				mode: "code",
				message: "Review this: \\\\@file1.txt and also \\\\\\\\@file2.txt", // Input with \\@ and \\\\@
				todos: "[ ] First task\n[ ] Second task",
			},
			partial: false,
		}

		await newTaskTool.handle(mockCline as any, withNativeArgs(block), {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		// Verify askApproval was called
		expect(mockAskApproval).toHaveBeenCalled()

		// Verify the message passed to startSubtask reflects the code's behavior in unit tests
		expect(mockStartSubtask).toHaveBeenCalledWith(
			"Review this: \\@file1.txt and also \\\\\\@file2.txt", // Unit Test Expectation: \\@ -> \@, \\\\@ -> \\\\@
			expect.arrayContaining([
				expect.objectContaining({ content: "First task" }),
				expect.objectContaining({ content: "Second task" }),
			]),
			"code",
		)

		// Verify side effects
		expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Delegated to child task"))
	})

	it("should not un-escape single escaped \@", async () => {
		const block: ToolUse<"new_task"> = {
			type: "tool_use", // Add required 'type' property
			name: "new_task", // Correct property name
			params: {
				mode: "code",
				message: "This is already unescaped: \\@file1.txt",
				todos: "[ ] Test todo",
			},
			partial: false,
		}

		await newTaskTool.handle(mockCline as any, withNativeArgs(block), {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		expect(mockStartSubtask).toHaveBeenCalledWith(
			"This is already unescaped: \\@file1.txt", // Expected: \@ remains \@
			expect.any(Array),
			"code",
		)
	})

	it("should not un-escape non-escaped @", async () => {
		const block: ToolUse<"new_task"> = {
			type: "tool_use", // Add required 'type' property
			name: "new_task", // Correct property name
			params: {
				mode: "code",
				message: "A normal mention @file1.txt",
				todos: "[ ] Test todo",
			},
			partial: false,
		}

		await newTaskTool.handle(mockCline as any, withNativeArgs(block), {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		expect(mockStartSubtask).toHaveBeenCalledWith(
			"A normal mention @file1.txt", // Expected: @ remains @
			expect.any(Array),
			"code",
		)
	})

	it("should handle mixed escaping scenarios", async () => {
		const block: ToolUse<"new_task"> = {
			type: "tool_use", // Add required 'type' property
			name: "new_task", // Correct property name
			params: {
				mode: "code",
				message: "Mix: @file0.txt, \\@file1.txt, \\\\@file2.txt, \\\\\\\\@file3.txt",
				todos: "[ ] Test todo",
			},
			partial: false,
		}

		await newTaskTool.handle(mockCline as any, withNativeArgs(block), {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		expect(mockStartSubtask).toHaveBeenCalledWith(
			"Mix: @file0.txt, \\@file1.txt, \\@file2.txt, \\\\\\@file3.txt", // Unit Test Expectation: @->@, \@->\@, \\@->\@, \\\\@->\\\\@
			expect.any(Array),
			"code",
		)
	})

	it("should handle missing todos parameter gracefully (backward compatibility)", async () => {
		const block: ToolUse<"new_task"> = {
			type: "tool_use",
			name: "new_task",
			params: {
				mode: "code",
				message: "Test message",
				// todos missing - should work for backward compatibility
			},
			partial: false,
		}

		await newTaskTool.handle(mockCline as any, withNativeArgs(block), {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		// Should NOT error when todos is missing
		expect(mockSayAndCreateMissingParamError).not.toHaveBeenCalledWith("new_task", "todos")
		expect(mockCline.consecutiveMistakeCount).toBe(0)
		expect(mockCline.recordToolError).not.toHaveBeenCalledWith("new_task")

		// Should create task with empty todos array
		expect(mockStartSubtask).toHaveBeenCalledWith("Test message", [], "code")

		// Should complete successfully
		expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Delegated to child task"))
	})

	it("should work with todos parameter when provided", async () => {
		const block: ToolUse<"new_task"> = {
			type: "tool_use",
			name: "new_task",
			params: {
				mode: "code",
				message: "Test message with todos",
				todos: "[ ] First task\n[ ] Second task",
			},
			partial: false,
		}

		await newTaskTool.handle(mockCline as any, withNativeArgs(block), {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		// Should parse and include todos when provided
		expect(mockStartSubtask).toHaveBeenCalledWith(
			"Test message with todos",
			expect.arrayContaining([
				expect.objectContaining({ content: "First task" }),
				expect.objectContaining({ content: "Second task" }),
			]),
			"code",
		)

		expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Delegated to child task"))
	})

	it("should error when mode parameter is missing", async () => {
		const block: ToolUse<"new_task"> = {
			type: "tool_use",
			name: "new_task",
			params: {
				// mode missing
				message: "Test message",
				todos: "[ ] Test todo",
			},
			partial: false,
		}

		await newTaskTool.handle(mockCline as any, withNativeArgs(block), {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		expect(mockSayAndCreateMissingParamError).toHaveBeenCalledWith("new_task", "mode")
		expect(mockCline.consecutiveMistakeCount).toBe(1)
		expect(mockCline.recordToolError).toHaveBeenCalledWith("new_task")
	})

	it("should error when message parameter is missing", async () => {
		const block: ToolUse<"new_task"> = {
			type: "tool_use",
			name: "new_task",
			params: {
				mode: "code",
				// message missing
				todos: "[ ] Test todo",
			},
			partial: false,
		}

		await newTaskTool.handle(mockCline as any, withNativeArgs(block), {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		expect(mockSayAndCreateMissingParamError).toHaveBeenCalledWith("new_task", "message")
		expect(mockCline.consecutiveMistakeCount).toBe(1)
		expect(mockCline.recordToolError).toHaveBeenCalledWith("new_task")
	})

	it("should parse todos with different statuses correctly", async () => {
		const block: ToolUse<"new_task"> = {
			type: "tool_use",
			name: "new_task",
			params: {
				mode: "code",
				message: "Test message",
				todos: "[ ] Pending task\n[x] Completed task\n[-] In progress task",
			},
			partial: false,
		}

		await newTaskTool.handle(mockCline as any, withNativeArgs(block), {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
		})

		expect(mockStartSubtask).toHaveBeenCalledWith(
			"Test message",
			expect.arrayContaining([
				expect.objectContaining({ content: "Pending task", status: "pending" }),
				expect.objectContaining({ content: "Completed task", status: "completed" }),
				expect.objectContaining({ content: "In progress task", status: "in_progress" }),
			]),
			"code",
		)
	})

	describe("VSCode setting: newTaskRequireTodos", () => {
		it("should NOT require todos when VSCode setting is disabled (default)", async () => {
			// Ensure VSCode setting is disabled
			const mockGet = vi.fn().mockReturnValue(false)
			vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
				get: mockGet,
			} as any)

			const block: ToolUse<"new_task"> = {
				type: "tool_use",
				name: "new_task",
				params: {
					mode: "code",
					message: "Test message",
					// todos missing - should work when setting is disabled
				},
				partial: false,
			}

			await newTaskTool.handle(mockCline as any, withNativeArgs(block), {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			// Should NOT error when todos is missing and setting is disabled
			expect(mockSayAndCreateMissingParamError).not.toHaveBeenCalledWith("new_task", "todos")
			expect(mockCline.consecutiveMistakeCount).toBe(0)
			expect(mockCline.recordToolError).not.toHaveBeenCalledWith("new_task")

			// Should create task with empty todos array
			expect(mockStartSubtask).toHaveBeenCalledWith("Test message", [], "code")

			// Should complete successfully
			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Delegated to child task"))
		})

		it("should REQUIRE todos when VSCode setting is enabled", async () => {
			// Enable VSCode setting
			const mockGet = vi.fn().mockReturnValue(true)
			vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
				get: mockGet,
			} as any)

			const block: ToolUse<"new_task"> = {
				type: "tool_use",
				name: "new_task",
				params: {
					mode: "code",
					message: "Test message",
					// todos missing - should error when setting is enabled
				},
				partial: false,
			}

			await newTaskTool.handle(mockCline as any, withNativeArgs(block), {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			// Should error when todos is missing and setting is enabled
			expect(mockSayAndCreateMissingParamError).toHaveBeenCalledWith("new_task", "todos")
			expect(mockCline.consecutiveMistakeCount).toBe(1)
			expect(mockCline.recordToolError).toHaveBeenCalledWith("new_task")

			// Should NOT create task
			expect(mockStartSubtask).not.toHaveBeenCalled()
			expect(mockPushToolResult).not.toHaveBeenCalledWith(
				expect.stringContaining("Successfully created new task"),
			)
		})

		it("should work with todos when VSCode setting is enabled", async () => {
			// Enable VSCode setting
			const mockGet = vi.fn().mockReturnValue(true)
			vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
				get: mockGet,
			} as any)

			const block: ToolUse<"new_task"> = {
				type: "tool_use",
				name: "new_task",
				params: {
					mode: "code",
					message: "Test message",
					todos: "[ ] First task\n[ ] Second task",
				},
				partial: false,
			}

			await newTaskTool.handle(mockCline as any, withNativeArgs(block), {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			// Should NOT error when todos is provided and setting is enabled
			expect(mockSayAndCreateMissingParamError).not.toHaveBeenCalledWith("new_task", "todos")
			expect(mockCline.consecutiveMistakeCount).toBe(0)

			// Should create task with parsed todos
			expect(mockStartSubtask).toHaveBeenCalledWith(
				"Test message",
				expect.arrayContaining([
					expect.objectContaining({ content: "First task" }),
					expect.objectContaining({ content: "Second task" }),
				]),
				"code",
			)

			// Should complete successfully
			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Delegated to child task"))
		})

		it("should work with empty todos string when VSCode setting is enabled", async () => {
			// Enable VSCode setting
			const mockGet = vi.fn().mockReturnValue(true)
			vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
				get: mockGet,
			} as any)

			const block: ToolUse<"new_task"> = {
				type: "tool_use",
				name: "new_task",
				params: {
					mode: "code",
					message: "Test message",
					todos: "", // Empty string should be accepted
				},
				partial: false,
			}

			await newTaskTool.handle(mockCline as any, withNativeArgs(block), {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			// Should NOT error when todos is empty string and setting is enabled
			expect(mockSayAndCreateMissingParamError).not.toHaveBeenCalledWith("new_task", "todos")
			expect(mockCline.consecutiveMistakeCount).toBe(0)

			// Should create task with empty todos array
			expect(mockStartSubtask).toHaveBeenCalledWith("Test message", [], "code")

			// Should complete successfully
			expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Delegated to child task"))
		})

		it("should check VSCode setting with Package.name configuration key", async () => {
			const mockGet = vi.fn().mockReturnValue(false)
			const mockGetConfiguration = vi.fn().mockReturnValue({
				get: mockGet,
			} as any)
			vi.mocked(vscode.workspace.getConfiguration).mockImplementation(mockGetConfiguration)

			const block: ToolUse<"new_task"> = {
				type: "tool_use",
				name: "new_task",
				params: {
					mode: "code",
					message: "Test message",
				},
				partial: false,
			}

			await newTaskTool.handle(mockCline as any, withNativeArgs(block), {
				askApproval: mockAskApproval,
				handleError: mockHandleError,
				pushToolResult: mockPushToolResult,
			})

			// Verify that VSCode configuration was accessed with Package.name
			expect(mockGetConfiguration).toHaveBeenCalledWith("zoo-code")
			expect(mockGet).toHaveBeenCalledWith("newTaskRequireTodos", false)
		})
	})

	// Add more tests for error handling (invalid mode, approval denied) if needed
})

describe("newTaskTool delegation flow", () => {
	it("delegates to provider and does not call legacy startSubtask", async () => {
		// Arrange: stub provider delegation
		const providerSpy = {
			getTaskMetadata: vi.fn().mockResolvedValue({ kind: "found", item: { status: "active" } }),
			getState: vi.fn().mockResolvedValue({
				mode: "ask",
				experiments: {},
			}),
			setPendingTaskAction: vi.fn().mockResolvedValue(undefined),
			delegateParentAndOpenChild: vi.fn().mockResolvedValue({ taskId: "child-1" }),
			handleModeSwitch: vi.fn(),
		} as any

		// Use a fresh local cline instance to avoid cross-test interference
		const localStartSubtask = vi.fn()
		const localEmit = vi.fn()
		const localCline = {
			ask: vi.fn(),
			waitForCurrentAssistantMessagePersistence: vi.fn(async () => true),
			waitForAnsweredAskPersistence: vi.fn(async () => {}),
			sayAndCreateMissingParamError: mockSayAndCreateMissingParamError,
			emit: localEmit,
			recordToolError: mockRecordToolError,
			consecutiveMistakeCount: 0,
			isPaused: false,
			pausedModeSlug: "ask",
			taskId: "mock-parent-task-id",
			setPendingTaskAction: vi.fn(),
			enableCheckpoints: false,
			checkpointSave: mockCheckpointSave,
			startSubtask: localStartSubtask,
			providerRef: {
				deref: vi.fn(() => providerSpy),
			},
		}

		const block: ToolUse<"new_task"> = {
			type: "tool_use",
			name: "new_task",
			params: {
				mode: "code",
				message: "Do something",
				// no todos -> should default to []
			},
			partial: false,
		}

		// Act
		await newTaskTool.handle(localCline as any, withNativeArgs(block), {
			askApproval: mockAskApproval,
			handleError: mockHandleError,
			pushToolResult: mockPushToolResult,
			toolCallId: "call-new-task",
		})

		expect(providerSpy.setPendingTaskAction).toHaveBeenCalledWith("mock-parent-task-id", {
			kind: "create_subtask",
			actionId: "call-new-task",
			approvalText: expect.stringContaining('"tool":"newTask"'),
			mode: "code",
			message: "Do something",
			todos: [],
		})
		// Assert: provider method called with correct params
		expect(providerSpy.delegateParentAndOpenChild).toHaveBeenCalledWith({
			parentTaskId: "mock-parent-task-id",
			message: "Do something",
			initialTodos: [],
			mode: "code",
			pendingActionId: "call-new-task",
		})

		// Assert: legacy path not used
		expect(localStartSubtask).not.toHaveBeenCalled()

		// Assert: no pause/unpause events emitted in delegation path
		const pauseEvents = (localEmit as any).mock.calls.filter(
			(c: any[]) => c[0] === "taskPaused" || c[0] === "taskUnpaused",
		)
		expect(pauseEvents.length).toBe(0)

		// Assert: tool result reflects delegation
		expect(mockPushToolResult).toHaveBeenCalledWith(expect.stringContaining("Delegated to child task child-1"))
	})

	/** A tool run against a task whose persisted status is `status`; approval is declined if asked. */
	async function runWithStatus(status: string, item: Record<string, unknown> = {}) {
		const providerSpy = {
			getTaskMetadata: vi.fn().mockResolvedValue({ kind: "found", item: { status, ...item } }),
			getState: vi.fn().mockResolvedValue({ mode: "ask", experiments: {} }),
			setPendingTaskAction: vi.fn(),
			delegateParentAndOpenChild: vi.fn(),
		}
		const localCline = {
			taskId: "status-task",
			consecutiveMistakeCount: 0,
			didToolFailInCurrentTurn: false,
			recordToolError: vi.fn(),
			say: vi.fn().mockResolvedValue(undefined),
			setPendingTaskAction: vi.fn(),
			providerRef: { deref: vi.fn(() => providerSpy) },
		}
		const block: ToolUse<"new_task"> = {
			type: "tool_use",
			name: "new_task",
			params: { mode: "code", message: "Follow up" },
			partial: false,
		}
		const callbacks = {
			askApproval: vi.fn<AskApproval>(async () => false),
			handleError: vi.fn<HandleError>(async () => {}),
			pushToolResult: vi.fn<PushToolResult>(),
			toolCallId: "call-new-task",
		}

		// Double assertion: the tool reads only these members; a real Task needs a provider,
		// API handler and storage, and its providerRef is a WeakRef that cannot hold this double.
		await newTaskTool.handle(localCline as unknown as Task, withNativeArgs(block), callbacks)
		return { providerSpy, localCline, callbacks }
	}

	it.each([
		["completed", {}, "This task is already completed", "start a new task"],
		[
			"blocked_protocol_error",
			{ protocolErrorChildId: "child-1" },
			"blocked by a subtask protocol error",
			"start a new task",
		],
		// A blocked child's own completion is missing; its way out is attempt_completion.
		["blocked_protocol_error", {}, "has not finished with attempt_completion", "call attempt_completion"],
	])(
		"refuses in a %s task %o before saving an action, asking approval or creating a child",
		async (status, item, reason, nextStep) => {
			// This status cannot become delegated; a saved action would only be replayed into a refusal.
			const { providerSpy, localCline, callbacks } = await runWithStatus(status, item)

			expect(providerSpy.getTaskMetadata).toHaveBeenCalledWith("status-task")
			expect(providerSpy.setPendingTaskAction).not.toHaveBeenCalled()
			expect(localCline.setPendingTaskAction).not.toHaveBeenCalled()
			expect(callbacks.askApproval).not.toHaveBeenCalled()
			expect(providerSpy.delegateParentAndOpenChild).not.toHaveBeenCalled()
			expect(localCline.recordToolError).toHaveBeenCalledWith("new_task")
			expect(localCline.didToolFailInCurrentTurn).toBe(true)
			expect(localCline.say).toHaveBeenCalledWith("error", expect.stringContaining(reason))
			expect(localCline.say).toHaveBeenCalledWith("error", expect.stringContaining(nextStep))
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("No subtask was created"))
			expect(callbacks.handleError).not.toHaveBeenCalled()
		},
	)

	it.each(["active", "interrupted", "delegated"])(
		"saves the action and asks approval in an %s task",
		async (status) => {
			// Interrupted tasks keep their saved-handoff recovery path, and a delegated parent may re-delegate
			// once its awaited child is interrupted; the provider decides both.
			const { providerSpy, localCline, callbacks } = await runWithStatus(status)

			expect(providerSpy.setPendingTaskAction).toHaveBeenCalledWith(
				"status-task",
				expect.objectContaining({ kind: "create_subtask", actionId: "call-new-task" }),
			)
			expect(callbacks.askApproval).toHaveBeenCalledOnce()
			expect(localCline.say).not.toHaveBeenCalled()
			expect(localCline.recordToolError).not.toHaveBeenCalled()
		},
	)
})

describe("newTaskTool handoff after the answered-ask save", () => {
	/** The Task members NewTaskTool and BaseTool.handle read on the approved path. */
	type HandoffTaskDouble = Pick<
		Task,
		| "taskId"
		| "instanceId"
		| "abort"
		| "abandoned"
		| "hasPendingQuestion"
		| "consecutiveMistakeCount"
		| "didToolFailInCurrentTurn"
		| "recordToolError"
		| "sayAndCreateMissingParamError"
		| "setPendingTaskAction"
		| "waitForCurrentAssistantMessagePersistence"
		| "waitForAnsweredAskPersistence"
	> & { providerRef: { deref: () => unknown } }

	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(getModeBySlug).mockReturnValue({
			slug: "code",
			name: "Code Mode",
			roleDefinition: "Test role definition",
			groups: ["command", "read", "edit"],
		})
	})

	/** `interrupt` is set on the task while its answered-ask save settles, before the wait resolves. */
	function handoffFixture(interrupt?: "abort" | "abandoned") {
		const diagnostics = { event: vi.fn<(phase: string, stage: string, error?: unknown) => void>() }
		const provider = {
			getTaskMetadata: vi.fn(async () => ({ kind: "found", item: { status: "active" } })),
			getState: vi.fn(async () => ({ mode: "ask", customModes: [] })),
			setPendingTaskAction: vi.fn(async () => {}),
			createDelegationDiagnostics: vi.fn(() => diagnostics),
			delegateParentAndOpenChild: vi.fn(async () => ({ taskId: "child-1" })),
		}
		const answeredAskSaveSettled = vi.fn()
		let settle: (() => void) | undefined
		const task: HandoffTaskDouble = {
			taskId: "parent-task",
			instanceId: "parent-instance",
			abort: false,
			abandoned: false,
			hasPendingQuestion: false,
			consecutiveMistakeCount: 0,
			didToolFailInCurrentTurn: false,
			recordToolError: vi.fn(),
			sayAndCreateMissingParamError: vi.fn(async () => "missing parameter"),
			setPendingTaskAction: vi.fn(),
			waitForCurrentAssistantMessagePersistence: vi.fn(async () => true),
			// Deferred: resolves only when the test settles the answered-ask save.
			waitForAnsweredAskPersistence: vi.fn(
				() =>
					new Promise<void>((resolve) => {
						settle = () => {
							if (interrupt) task[interrupt] = true
							answeredAskSaveSettled()
							resolve()
						}
					}),
			),
			providerRef: { deref: () => provider },
		}
		const callbacks = {
			askApproval: vi.fn<AskApproval>(async () => true),
			handleError: vi.fn<HandleError>(async () => {}),
			pushToolResult: vi.fn<PushToolResult>(),
			toolCallId: "call-new-task",
		}
		const block: ToolUse<"new_task"> = {
			type: "tool_use",
			name: "new_task",
			params: { mode: "code", message: "Do something", todos: "" },
			nativeArgs: { mode: "code", message: "Do something", todos: "" },
			partial: false,
		}
		// Double assertion: the tool reads only the HandoffTaskDouble members. A real Task needs a
		// provider, API handler and storage, and its providerRef is a WeakRef that cannot hold this
		// plain provider double.
		const handle = () => newTaskTool.handle(task as unknown as Task, block, callbacks)
		const settleAnsweredAskSave = () => {
			expect(settle).toBeDefined()
			settle?.()
		}
		const handoffEvents = () => diagnostics.event.mock.calls.filter(([phase]) => phase === "tool_handoff")
		return {
			task,
			provider,
			diagnostics,
			callbacks,
			handle,
			settleAnsweredAskSave,
			answeredAskSaveSettled,
			handoffEvents,
		}
	}

	it.each(["abort", "abandoned"] as const)(
		"does not hand off when the task is marked %s while its answered-ask save settles",
		async (interrupt) => {
			const f = handoffFixture(interrupt)
			const handled = f.handle()
			await vi.waitFor(() => expect(f.task.waitForAnsweredAskPersistence).toHaveBeenCalledOnce())
			expect(f.provider.delegateParentAndOpenChild).not.toHaveBeenCalled()

			f.settleAnsweredAskSave()
			await handled

			expect(f.task[interrupt]).toBe(true)
			expect(f.diagnostics.event).toHaveBeenCalledWith("approval", "end") // Diagnostics are observed.
			expect(f.provider.delegateParentAndOpenChild).not.toHaveBeenCalled()
			expect(f.handoffEvents()).toEqual([])
			expect(f.callbacks.pushToolResult).not.toHaveBeenCalled()
			expect(f.callbacks.handleError).not.toHaveBeenCalled()
		},
	)

	it("hands off only after its answered-ask save settles when the task stays live", async () => {
		const f = handoffFixture()
		const handled = f.handle()
		await vi.waitFor(() => expect(f.task.waitForAnsweredAskPersistence).toHaveBeenCalledOnce())
		expect(f.provider.delegateParentAndOpenChild).not.toHaveBeenCalled()

		f.settleAnsweredAskSave()
		await handled

		expect(f.provider.delegateParentAndOpenChild).toHaveBeenCalledOnce()
		expect(f.answeredAskSaveSettled.mock.invocationCallOrder[0]).toBeLessThan(
			f.provider.delegateParentAndOpenChild.mock.invocationCallOrder[0],
		)
		expect(f.handoffEvents()).toEqual([
			["tool_handoff", "begin"],
			["tool_handoff", "end"],
		])
		expect(f.callbacks.pushToolResult).toHaveBeenCalledWith("Delegated to child task child-1")
		expect(f.callbacks.handleError).not.toHaveBeenCalled()
	})
})
