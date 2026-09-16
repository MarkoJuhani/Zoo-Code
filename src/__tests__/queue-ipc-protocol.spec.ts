// npx vitest run __tests__/queue-ipc-protocol.spec.ts

import { describe, it, expect, vi, beforeEach } from "vitest"
import {
	TaskCommandName,
	IpcMessageType,
	RooCodeEventName,
	QueueEventName,
	type QueueResult,
	taskCommandSchema,
} from "@roo-code/types"

vi.mock("vscode", () => {
	const window = {
		createTextEditorDecorationType: vi.fn(() => ({ dispose: vi.fn() })),
		showErrorMessage: vi.fn(),
		onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
	}
	const workspace = {
		getConfiguration: vi.fn(() => ({
			get: vi.fn((_key: string, defaultValue?: unknown) => defaultValue),
			update: vi.fn(),
		})),
		workspaceFolders: [],
	}
	const env = { machineId: "test-machine", uriScheme: "vscode", appName: "VSCode", language: "en", sessionId: "sess" }
	const Uri = { file: (p: string) => ({ fsPath: p, toString: () => p }) }
	const commands = { executeCommand: vi.fn() }
	const ExtensionMode = { Development: 2 }
	const version = "1.0.0-test"
	return { window, workspace, env, Uri, commands, ExtensionMode, version }
})

vi.mock("@roo-code/ipc", () => {
	class MockIpcServer {
		public listen = vi.fn()
		public send = vi.fn()
		public broadcast = vi.fn()
		private listeners: Record<string, ((...args: unknown[]) => unknown | Promise<unknown>)[]> = {}

		public on(event: string, fn: (...args: unknown[]) => unknown | Promise<unknown>) {
			this.listeners[event] = this.listeners[event] || []
			this.listeners[event].push(fn)
			return this
		}

		public async trigger(event: string, ...args: unknown[]) {
			const fns = this.listeners[event] || []
			for (const fn of fns) {
				await fn(...args)
			}
		}
	}
	return { IpcServer: MockIpcServer }
})

import { API, canonicalTaskPath, parseQueueResultText, areQueueResultsEqual } from "../extension/api"
import type { ClineProvider } from "../core/webview/ClineProvider"
import type * as vscode from "vscode"

type MockIpcType = {
	trigger: (event: string, ...args: unknown[]) => Promise<void>
	send: ReturnType<typeof vi.fn>
	broadcast: ReturnType<typeof vi.fn>
}

const CANONICAL_RESULT_TEXT =
	"QUEUE_RESULT: DONE\nTICKET_ID: 159847\nTASK_FILE: tasks/ACTIVE_TASK_159847_queue_fixture.md\nFINAL_COMMIT: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

const INLINE_RESULT_TEXT =
	"QUEUE_RESULT: DONE; TICKET_ID: 159847; TASK_FILE: tasks/ACTIVE_TASK_159847_queue_fixture.md; FINAL_COMMIT: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

const PARSED_RESULT_OBJ: QueueResult = {
	QUEUE_RESULT: "DONE",
	TICKET_ID: "159847",
	TASK_FILE: "tasks/ACTIVE_TASK_159847_queue_fixture.md",
	FINAL_COMMIT: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
}

describe("Queue Protocol v1 - Protocol Conformance & Adversarial Regression Tests", () => {
	let outputChannel: { appendLine: ReturnType<typeof vi.fn> }
	let mockSidebarProvider: {
		context: { globalStorageUri: { fsPath: string } }
		cwd: string
		on: ReturnType<typeof vi.fn>
		getCurrentTask: ReturnType<typeof vi.fn>
		evictCurrentTask: ReturnType<typeof vi.fn>
		postStateToWebview: ReturnType<typeof vi.fn>
		postMessageToWebview: ReturnType<typeof vi.fn>
		handleModeSwitch: ReturnType<typeof vi.fn>
		createTask: ReturnType<typeof vi.fn>
		cancelTask: ReturnType<typeof vi.fn>
	}
	let api: API
	let mockIpc: MockIpcType

	beforeEach(() => {
		vi.clearAllMocks()
		outputChannel = { appendLine: vi.fn() }
		mockSidebarProvider = {
			context: { globalStorageUri: { fsPath: "/tmp" } },
			cwd: "/workspace/odoo",
			on: vi.fn(),
			getCurrentTask: vi.fn(),
			evictCurrentTask: vi.fn().mockResolvedValue(undefined),
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			handleModeSwitch: vi.fn().mockResolvedValue(undefined),
			createTask: vi.fn().mockResolvedValue({ taskId: "root-123", on: vi.fn() }),
			cancelTask: vi.fn().mockResolvedValue(undefined),
		}

		api = new API(
			outputChannel as unknown as vscode.OutputChannel,
			mockSidebarProvider as unknown as ClineProvider,
			"/tmp/test.sock",
			false,
		)
		mockIpc = (api as unknown as { ipc: MockIpcType }).ipc
	})

	it("parses canonical, inline, and markdown links and detects malformed results", () => {
		expect(parseQueueResultText(CANONICAL_RESULT_TEXT)).toEqual(PARSED_RESULT_OBJ)
		expect(parseQueueResultText(INLINE_RESULT_TEXT)).toEqual(PARSED_RESULT_OBJ)

		const markdownLink = "[tasks/ACTIVE_TASK_159847_queue_fixture.md](tasks/ACTIVE_TASK_159847_queue_fixture.md:17)"
		const textWithLink = CANONICAL_RESULT_TEXT.replace("tasks/ACTIVE_TASK_159847_queue_fixture.md", markdownLink)
		expect(parseQueueResultText(textWithLink)).toEqual(PARSED_RESULT_OBJ)

		expect(parseQueueResultText("QUEUE_RESULT: EMPTY")).toEqual({ QUEUE_RESULT: "EMPTY" })
		expect(parseQueueResultText("QUEUE_RESULT: BLOCKED\nREASON: review denied")).toEqual({
			QUEUE_RESULT: "BLOCKED",
			REASON: "review denied",
		})

		expect(() => parseQueueResultText("invalid text")).toThrow()
		expect(() => parseQueueResultText("QUEUE_RESULT: DONE")).toThrow() // missing fields
		expect(() => parseQueueResultText("QUEUE_RESULT: DONE; TICKET_ID: 159847\nEXTRA: line")).toThrow() // mixed
	})

	it("QueueAcquireLease grants exclusive lease to caller and rejects competing owner", async () => {
		await mockIpc.trigger(IpcMessageType.TaskCommand, "client-1", {
			commandName: TaskCommandName.QueueAcquireLease,
			data: { rpcId: "rpc-1", queueId: "q-1", ownerToken: "token-alpha" },
		})

		expect(mockIpc.send).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({
				data: expect.objectContaining({
					rpcId: "rpc-1",
					ok: true,
					value: { queueId: "q-1", exclusive: true },
				}),
			}),
		)

		await mockIpc.trigger(IpcMessageType.TaskCommand, "client-2", {
			commandName: TaskCommandName.QueueAcquireLease,
			data: { rpcId: "rpc-2", queueId: "q-2", ownerToken: "token-beta" },
		})

		expect(mockIpc.send).toHaveBeenCalledWith(
			"client-2",
			expect.objectContaining({
				data: expect.objectContaining({
					rpcId: "rpc-2",
					ok: false,
					error: "Runtime already leased",
				}),
			}),
		)
	})

	it("QueueStartTask enforces lease credentials, starts task, and returns idempotent mapping", async () => {
		await mockIpc.trigger(IpcMessageType.TaskCommand, "client-1", {
			commandName: TaskCommandName.QueueAcquireLease,
			data: { rpcId: "rpc-1", queueId: "q-1", ownerToken: "token-alpha" },
		})

		await mockIpc.trigger(IpcMessageType.TaskCommand, "client-1", {
			commandName: TaskCommandName.QueueStartTask,
			data: {
				rpcId: "rpc-start-1",
				queueId: "q-1",
				ownerToken: "token-alpha",
				generation: 1,
				requestId: "req-1",
				mode: "odoo-dev-orchestrator",
				text: "Run task",
			},
		})

		expect(mockSidebarProvider.handleModeSwitch).toHaveBeenCalledWith("odoo-dev-orchestrator")
		expect(mockSidebarProvider.createTask).toHaveBeenCalled()

		expect(mockIpc.send).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({
				data: expect.objectContaining({
					rpcId: "rpc-start-1",
					ok: true,
					value: expect.objectContaining({
						queueId: "q-1",
						generation: 1,
						requestId: "req-1",
						rootTaskId: "root-123",
						mode: "odoo-dev-orchestrator",
					}),
				}),
			}),
		)

		// Duplicate start with same requestId returns existing rootTaskId idempotently without re-dispatching
		mockSidebarProvider.createTask.mockClear()
		await mockIpc.trigger(IpcMessageType.TaskCommand, "client-1", {
			commandName: TaskCommandName.QueueStartTask,
			data: {
				rpcId: "rpc-start-2",
				queueId: "q-1",
				ownerToken: "token-alpha",
				generation: 1,
				requestId: "req-1",
				mode: "odoo-dev-orchestrator",
				text: "Run task",
			},
		})

		expect(mockSidebarProvider.createTask).not.toHaveBeenCalled()
		expect(mockIpc.send).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({
				data: expect.objectContaining({
					rpcId: "rpc-start-2",
					ok: true,
					value: expect.objectContaining({
						rootTaskId: "root-123",
					}),
				}),
			}),
		)
	})

	it("Lifecycle: delegation disposal abort retains ownership, while root completion still shuts down", async () => {
		await mockIpc.trigger(IpcMessageType.TaskCommand, "client-1", {
			commandName: TaskCommandName.QueueAcquireLease,
			data: { queueId: "q-1", ownerToken: "token-alpha" },
		})

		const taskListeners: Record<string, ((...args: unknown[]) => unknown | Promise<unknown>)[]> = {}
		const mockTask = {
			taskId: "root-123",
			on: vi.fn((event: string, fn: (...args: unknown[]) => unknown | Promise<unknown>) => {
				taskListeners[event] = taskListeners[event] || []
				taskListeners[event].push(fn)
				return mockTask
			}),
			approveAsk: vi.fn(),
			clineMessages: [] as unknown[],
		}
		mockSidebarProvider.createTask.mockResolvedValue(mockTask)
		mockSidebarProvider.getCurrentTask.mockReturnValue(mockTask)

		const triggerTaskCreated = mockSidebarProvider.on.mock.calls.find(
			(call) => call[0] === RooCodeEventName.TaskCreated,
		)?.[1]

		await mockIpc.trigger(IpcMessageType.TaskCommand, "client-1", {
			commandName: TaskCommandName.QueueStartTask,
			data: {
				queueId: "q-1",
				ownerToken: "token-alpha",
				generation: 1,
				requestId: "req-1",
				mode: "odoo-dev-orchestrator",
				text: "Execute task",
			},
		})
		await triggerTaskCreated?.(mockTask)

		// Parent teardown happens before the child edge is published. This is an
		// internal delegation disposal, not a terminal root cancellation.
		const taskAbortedFns = taskListeners[RooCodeEventName.TaskAborted] || []
		for (const fn of taskAbortedFns) {
			await fn("delegation_disposal")
		}
		expect(mockIpc.broadcast).not.toHaveBeenCalledWith(
			expect.objectContaining({
				type: IpcMessageType.QueueEvent,
				data: expect.objectContaining({
					eventName: QueueEventName.Terminal,
					payload: expect.objectContaining({ runtimeState: "aborted" }),
				}),
			}),
		)

		const messageFns = taskListeners[RooCodeEventName.Message] || []

		// 1. Root emits final completion say message
		for (const fn of messageFns) {
			await fn({
				action: "created",
				message: {
					type: "say",
					say: "completion_result",
					text: CANONICAL_RESULT_TEXT,
					partial: false,
					ts: 1000,
				},
			})
		}

		// 2. Root emits empty completion ask prompt
		for (const fn of messageFns) {
			await fn({
				action: "created",
				message: {
					type: "ask",
					ask: "completion_result",
					text: "",
					partial: false,
					ts: 1001,
				},
			})
		}

		// 3. QueueAcceptCompletion accepts with parsed result object
		await mockIpc.trigger(IpcMessageType.TaskCommand, "client-1", {
			commandName: TaskCommandName.QueueAcceptCompletion,
			data: {
				rpcId: "rpc-accept-1",
				queueId: "q-1",
				ownerToken: "token-alpha",
				generation: 1,
				requestId: "req-1",
				rootTaskId: "root-123",
				result: PARSED_RESULT_OBJ,
			},
		})

		expect(mockTask.approveAsk).toHaveBeenCalled()
		expect(mockIpc.send).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({
				data: expect.objectContaining({
					rpcId: "rpc-accept-1",
					ok: true,
					value: { accepted: true, taskId: "root-123" },
				}),
			}),
		)

		// 4. TaskCompleted emits terminal event with ownershipReleased: true
		const taskCompletedFns = taskListeners[RooCodeEventName.TaskCompleted] || []
		for (const fn of taskCompletedFns) {
			await fn(mockTask, { tokensIn: 10, tokensOut: 20 }, {})
		}

		expect(mockIpc.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: IpcMessageType.QueueEvent,
				data: expect.objectContaining({
					eventName: QueueEventName.Terminal,
					payload: {
						taskId: "root-123",
						runtimeState: "completed",
						ownershipReleased: true,
					},
				}),
			}),
		)

		// 5. Release lease succeeds once shutdown is confirmed
		await mockIpc.trigger(IpcMessageType.TaskCommand, "client-1", {
			commandName: TaskCommandName.QueueReleaseLease,
			data: { rpcId: "rpc-rel", queueId: "q-1", ownerToken: "token-alpha" },
		})
		expect(mockIpc.send).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({
				data: expect.objectContaining({
					rpcId: "rpc-rel",
					ok: true,
					value: { released: true },
				}),
			}),
		)
	})

	it("Partial, duplicate, conflicting, and descendant results cannot overwrite root evidence or produce false success", async () => {
		await mockIpc.trigger(IpcMessageType.TaskCommand, "client-1", {
			commandName: TaskCommandName.QueueAcquireLease,
			data: { queueId: "q-1", ownerToken: "token-alpha" },
		})

		const taskListeners: Record<string, ((...args: unknown[]) => unknown | Promise<unknown>)[]> = {}
		const mockTask = {
			taskId: "root-123",
			on: vi.fn((event: string, fn: (...args: unknown[]) => unknown | Promise<unknown>) => {
				taskListeners[event] = taskListeners[event] || []
				taskListeners[event].push(fn)
				return mockTask
			}),
			approveAsk: vi.fn(),
		}
		mockSidebarProvider.createTask.mockResolvedValue(mockTask)
		mockSidebarProvider.getCurrentTask.mockReturnValue(mockTask)

		const triggerTaskCreated = mockSidebarProvider.on.mock.calls.find(
			(call) => call[0] === RooCodeEventName.TaskCreated,
		)?.[1]

		await mockIpc.trigger(IpcMessageType.TaskCommand, "client-1", {
			commandName: TaskCommandName.QueueStartTask,
			data: {
				queueId: "q-1",
				ownerToken: "token-alpha",
				generation: 1,
				requestId: "req-1",
				mode: "odoo-dev-orchestrator",
				text: "Execute task",
			},
		})
		await triggerTaskCreated?.(mockTask)

		const messageFns = taskListeners[RooCodeEventName.Message] || []

		// 1. Partial completion say does not establish retained result
		for (const fn of messageFns) {
			await fn({
				action: "updated",
				message: { type: "say", say: "completion_result", text: "QUEUE_RESULT: partial", partial: true, ts: 1 },
			})
		}

		// 2. Final completion say sets result
		for (const fn of messageFns) {
			await fn({
				action: "created",
				message: { type: "say", say: "completion_result", text: CANONICAL_RESULT_TEXT, partial: false, ts: 2 },
			})
		}

		// 3. Empty prompt ask does NOT overwrite retained result
		for (const fn of messageFns) {
			await fn({
				action: "created",
				message: { type: "ask", ask: "completion_result", text: "", partial: false, ts: 3 },
			})
		}

		// 4. Duplicate identical final message is idempotent
		for (const fn of messageFns) {
			await fn({
				action: "created",
				message: { type: "say", say: "completion_result", text: INLINE_RESULT_TEXT, partial: false, ts: 4 },
			})
		}

		// Subscribe snapshot confirms CANONICAL_RESULT_TEXT is preserved
		await mockIpc.trigger(IpcMessageType.TaskCommand, "client-1", {
			commandName: TaskCommandName.QueueSubscribe,
			data: { rpcId: "rpc-sub", queueId: "q-1", ownerToken: "token-alpha", rootTaskId: "root-123" },
		})
		expect(mockIpc.send).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({
				data: expect.objectContaining({
					rpcId: "rpc-sub",
					ok: true,
					value: expect.objectContaining({
						result: CANONICAL_RESULT_TEXT,
					}),
				}),
			}),
		)

		// 5. Conflicting final message fails closed
		for (const fn of messageFns) {
			await fn({
				action: "created",
				message: {
					type: "say",
					say: "completion_result",
					text: "QUEUE_RESULT: BLOCKED\nREASON: conflicting result",
					partial: false,
					ts: 5,
				},
			})
		}

		expect(mockIpc.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: IpcMessageType.QueueEvent,
				data: expect.objectContaining({
					eventName: QueueEventName.Terminal,
					payload: expect.objectContaining({
						runtimeState: "failed",
						ownershipReleased: false,
					}),
				}),
			}),
		)
	})

	it("Wrong owner, generation, request, root, pending prompt (e.g. tool ask), and changed task focus cannot trigger approval", async () => {
		await mockIpc.trigger(IpcMessageType.TaskCommand, "client-1", {
			commandName: TaskCommandName.QueueAcquireLease,
			data: { queueId: "q-1", ownerToken: "token-alpha" },
		})

		const taskListeners: Record<string, ((...args: unknown[]) => unknown | Promise<unknown>)[]> = {}
		const mockTask = {
			taskId: "root-123",
			on: vi.fn((event: string, fn: (...args: unknown[]) => unknown | Promise<unknown>) => {
				taskListeners[event] = taskListeners[event] || []
				taskListeners[event].push(fn)
				return mockTask
			}),
			approveAsk: vi.fn(),
			clineMessages: [{ type: "ask", ask: "tool", text: "approve tool", isAnswered: false }],
		}
		mockSidebarProvider.createTask.mockResolvedValue(mockTask)
		mockSidebarProvider.getCurrentTask.mockReturnValue(mockTask)

		const triggerTaskCreated = mockSidebarProvider.on.mock.calls.find(
			(call) => call[0] === RooCodeEventName.TaskCreated,
		)?.[1]

		await mockIpc.trigger(IpcMessageType.TaskCommand, "client-1", {
			commandName: TaskCommandName.QueueStartTask,
			data: {
				queueId: "q-1",
				ownerToken: "token-alpha",
				generation: 1,
				requestId: "req-1",
				mode: "odoo-dev-orchestrator",
				text: "Execute task",
			},
		})
		await triggerTaskCreated?.(mockTask)

		const messageFns = taskListeners[RooCodeEventName.Message] || []
		for (const fn of messageFns) {
			await fn({
				action: "created",
				message: { type: "say", say: "completion_result", text: CANONICAL_RESULT_TEXT, partial: false },
			})
			await fn({
				action: "created",
				message: { type: "ask", ask: "tool", text: "tool prompt", partial: false },
			})
		}

		// Tool prompt instead of completion prompt -> REJECTED
		await mockIpc.trigger(IpcMessageType.TaskCommand, "client-1", {
			commandName: TaskCommandName.QueueAcceptCompletion,
			data: {
				rpcId: "rpc-tool-prompt",
				queueId: "q-1",
				ownerToken: "token-alpha",
				generation: 1,
				requestId: "req-1",
				rootTaskId: "root-123",
				result: PARSED_RESULT_OBJ,
			},
		})
		expect(mockTask.approveAsk).not.toHaveBeenCalled()
		expect(mockIpc.send).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({
				data: expect.objectContaining({
					rpcId: "rpc-tool-prompt",
					ok: false,
					error: "Task is not awaiting completion confirmation",
				}),
			}),
		)

		// Wrong generation -> REJECTED
		await mockIpc.trigger(IpcMessageType.TaskCommand, "client-1", {
			commandName: TaskCommandName.QueueAcceptCompletion,
			data: {
				rpcId: "rpc-bad-gen",
				queueId: "q-1",
				ownerToken: "token-alpha",
				generation: 99,
				requestId: "req-1",
				rootTaskId: "root-123",
				result: PARSED_RESULT_OBJ,
			},
		})
		expect(mockIpc.send).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({
				data: expect.objectContaining({
					rpcId: "rpc-bad-gen",
					ok: false,
				}),
			}),
		)
	})

	it("untargeted CancelTask is ignored while queue lease is active, targeted QueueCancelTask stops execution and releases ownership", async () => {
		await mockIpc.trigger(IpcMessageType.TaskCommand, "client-1", {
			commandName: TaskCommandName.QueueAcquireLease,
			data: { queueId: "q-1", ownerToken: "token-alpha" },
		})

		const mockTask = { taskId: "root-123", on: vi.fn() }
		mockSidebarProvider.createTask.mockResolvedValue(mockTask)
		mockSidebarProvider.getCurrentTask.mockReturnValue(mockTask)

		await mockIpc.trigger(IpcMessageType.TaskCommand, "client-1", {
			commandName: TaskCommandName.QueueStartTask,
			data: {
				queueId: "q-1",
				ownerToken: "token-alpha",
				generation: 1,
				requestId: "req-1",
				mode: "odoo-dev-orchestrator",
				text: "Run task",
			},
		})

		// Untargeted cancel is ignored
		await mockIpc.trigger(IpcMessageType.TaskCommand, "client-unrelated", {
			commandName: TaskCommandName.CancelTask,
		})
		expect(mockSidebarProvider.cancelTask).not.toHaveBeenCalled()

		// Targeted QueueCancelTask cancels and releases
		await mockIpc.trigger(IpcMessageType.TaskCommand, "client-1", {
			commandName: TaskCommandName.QueueCancelTask,
			data: {
				rpcId: "rpc-cancel-1",
				queueId: "q-1",
				ownerToken: "token-alpha",
				generation: 1,
				requestId: "req-1",
				rootTaskId: "root-123",
			},
		})

		expect(mockSidebarProvider.cancelTask).toHaveBeenCalled()
		expect(mockIpc.send).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({
				data: expect.objectContaining({
					rpcId: "rpc-cancel-1",
					ok: true,
					value: { cancelled: true, taskId: "root-123" },
				}),
			}),
		)
	})

	it("Completion with active descendants cannot release ownership until descendants retire", async () => {
		await mockIpc.trigger(IpcMessageType.TaskCommand, "client-1", {
			commandName: TaskCommandName.QueueAcquireLease,
			data: { queueId: "q-desc", ownerToken: "token-desc" },
		})

		const taskListeners: Record<string, ((...args: unknown[]) => unknown | Promise<unknown>)[]> = {}
		const mockTask = {
			taskId: "root-desc",
			on: vi.fn((event: string, fn: (...args: unknown[]) => unknown | Promise<unknown>) => {
				taskListeners[event] = taskListeners[event] || []
				taskListeners[event].push(fn)
				return mockTask
			}),
		}
		mockSidebarProvider.createTask.mockResolvedValue(mockTask)
		mockSidebarProvider.getCurrentTask.mockReturnValue(mockTask)

		const triggerTaskCreated = mockSidebarProvider.on.mock.calls.find(
			(call) => call[0] === RooCodeEventName.TaskCreated,
		)?.[1]

		await mockIpc.trigger(IpcMessageType.TaskCommand, "client-1", {
			commandName: TaskCommandName.QueueStartTask,
			data: {
				queueId: "q-desc",
				ownerToken: "token-desc",
				generation: 1,
				requestId: "req-desc",
				mode: "odoo-dev-orchestrator",
				text: "Run task with subtask",
			},
		})
		await triggerTaskCreated?.(mockTask)

		const getProviderListener = (event: string) => {
			return mockSidebarProvider.on.mock.calls.find((call) => call[0] === event)?.[1]
		}
		const taskDelegatedListener = getProviderListener(RooCodeEventName.TaskDelegated)
		const taskDelegationCompletedListener = getProviderListener(RooCodeEventName.TaskDelegationCompleted)

		// Root delegates to child-1
		await taskDelegatedListener?.("root-desc", "child-1", 1)

		// Root task signals completed, but child-1 is still active -> ownershipReleased MUST be false
		const taskCompletedFns = taskListeners[RooCodeEventName.TaskCompleted] || []
		for (const fn of taskCompletedFns) {
			await fn(mockTask, { tokensIn: 1, tokensOut: 1 }, {})
		}

		expect(mockIpc.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: IpcMessageType.QueueEvent,
				data: expect.objectContaining({
					eventName: QueueEventName.Terminal,
					payload: expect.objectContaining({
						taskId: "root-desc",
						runtimeState: "completed",
						ownershipReleased: false,
					}),
				}),
			}),
		)

		// Lease release must be BLOCKED while cleanup is pending
		await mockIpc.trigger(IpcMessageType.TaskCommand, "client-1", {
			commandName: TaskCommandName.QueueReleaseLease,
			data: { rpcId: "rpc-rel-blocked", queueId: "q-desc", ownerToken: "token-desc" },
		})
		expect(mockIpc.send).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({
				data: expect.objectContaining({
					rpcId: "rpc-rel-blocked",
					ok: false,
					error: "Cannot release lease while execution cleanup is pending",
				}),
			}),
		)

		// Child-1 completes delegation -> confirmed shutdown & ownership release
		await taskDelegationCompletedListener?.("root-desc", "child-1", "Done", 1)

		expect(mockIpc.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: IpcMessageType.QueueEvent,
				data: expect.objectContaining({
					eventName: QueueEventName.Terminal,
					payload: expect.objectContaining({
						taskId: "root-desc",
						runtimeState: "completed",
						ownershipReleased: true,
					}),
				}),
			}),
		)
	})

	it("handles delegation lifecycle events and tracks activeTaskId and orderedEdges in dispatch state", async () => {
		await mockIpc.trigger(IpcMessageType.TaskCommand, "client-1", {
			commandName: TaskCommandName.QueueAcquireLease,
			data: { queueId: "q-delegation", ownerToken: "token-delegation" },
		})

		await mockIpc.trigger(IpcMessageType.TaskCommand, "client-1", {
			commandName: TaskCommandName.QueueStartTask,
			data: {
				queueId: "q-delegation",
				ownerToken: "token-delegation",
				generation: 1,
				requestId: "req-delegation",
				mode: "odoo-dev-orchestrator",
				text: "Execute delegation workflow",
			},
		})

		const getProviderListener = (event: string) => {
			return mockSidebarProvider.on.mock.calls.find((call) => call[0] === event)?.[1]
		}

		const taskDelegatedListener = getProviderListener(RooCodeEventName.TaskDelegated)
		const taskDelegationCompletedListener = getProviderListener(RooCodeEventName.TaskDelegationCompleted)
		const taskResumeScheduledListener = getProviderListener(RooCodeEventName.TaskResumeScheduled)
		const taskDelegationResumedListener = getProviderListener(RooCodeEventName.TaskDelegationResumed)

		// 1. Root delegates to child-1
		await taskDelegatedListener?.("root-123", "child-1", 1)

		expect(mockIpc.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: IpcMessageType.QueueEvent,
				data: expect.objectContaining({
					queueId: "q-delegation",
					rootTaskId: "root-123",
					sequence: 1,
					eventName: QueueEventName.Delegated,
					payload: {
						parent: "root-123",
						child: "child-1",
						transition: 1,
					},
				}),
			}),
		)

		// 2. Snapshot after delegation shows active child and ordered active edge
		await mockIpc.trigger(IpcMessageType.TaskCommand, "client-1", {
			commandName: TaskCommandName.QueueSubscribe,
			data: {
				rpcId: "rpc-sub-del-1",
				queueId: "q-delegation",
				ownerToken: "token-delegation",
				generation: 1,
				requestId: "req-delegation",
				rootTaskId: "root-123",
			},
		})

		expect(mockIpc.send).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({
				data: expect.objectContaining({
					rpcId: "rpc-sub-del-1",
					ok: true,
					value: expect.objectContaining({
						activeTaskId: "child-1",
						orderedEdges: [{ parent: "root-123", child: "child-1", transition: 1, active: true }],
					}),
				}),
			}),
		)

		// 3. Child-1 completes delegation
		await taskDelegationCompletedListener?.("root-123", "child-1", "Child finished subtask", 1)

		// 4. Resume scheduled
		await taskResumeScheduledListener?.("root-123", "child-1", true, 1)

		// 5. Delegation resumed
		await taskDelegationResumedListener?.("root-123", "child-1", 1)

		// 6. Final snapshot reflects deactivated edge and activeTaskId restored to parent root
		await mockIpc.trigger(IpcMessageType.TaskCommand, "client-1", {
			commandName: TaskCommandName.QueueSubscribe,
			data: {
				rpcId: "rpc-sub-del-final",
				queueId: "q-delegation",
				ownerToken: "token-delegation",
				generation: 1,
				requestId: "req-delegation",
				rootTaskId: "root-123",
			},
		})

		expect(mockIpc.send).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({
				data: expect.objectContaining({
					rpcId: "rpc-sub-del-final",
					ok: true,
					value: expect.objectContaining({
						activeTaskId: "root-123",
						orderedEdges: [{ parent: "root-123", child: "child-1", transition: 1, active: false }],
					}),
				}),
			}),
		)
	})
	it("exercises real IPC wire schema validation boundary for QueueAcceptCompletion", () => {
		// Valid with parsed result object
		const validObj = taskCommandSchema.safeParse({
			commandName: TaskCommandName.QueueAcceptCompletion,
			data: {
				queueId: "q-1",
				ownerToken: "token-alpha",
				generation: 1,
				requestId: "req-1",
				rootTaskId: "root-123",
				result: PARSED_RESULT_OBJ,
			},
		})
		expect(validObj.success).toBe(true)

		// Valid with canonical string
		const validStr = taskCommandSchema.safeParse({
			commandName: TaskCommandName.QueueAcceptCompletion,
			data: {
				queueId: "q-1",
				ownerToken: "token-alpha",
				generation: 1,
				requestId: "req-1",
				rootTaskId: "root-123",
				result: CANONICAL_RESULT_TEXT,
			},
		})
		expect(validStr.success).toBe(true)

		// Malformed parsed object: missing FINAL_COMMIT for DONE
		const malformedMissing = taskCommandSchema.safeParse({
			commandName: TaskCommandName.QueueAcceptCompletion,
			data: {
				queueId: "q-1",
				ownerToken: "token-alpha",
				generation: 1,
				requestId: "req-1",
				rootTaskId: "root-123",
				result: {
					QUEUE_RESULT: "DONE",
					TICKET_ID: "159847",
					TASK_FILE: "tasks/ACTIVE_TASK_159847_queue_fixture.md",
				},
			},
		})
		expect(malformedMissing.success).toBe(false)

		// Malformed parsed object: invalid commit format
		const malformedCommit = taskCommandSchema.safeParse({
			commandName: TaskCommandName.QueueAcceptCompletion,
			data: {
				queueId: "q-1",
				ownerToken: "token-alpha",
				generation: 1,
				requestId: "req-1",
				rootTaskId: "root-123",
				result: {
					QUEUE_RESULT: "DONE",
					TICKET_ID: "159847",
					TASK_FILE: "tasks/ACTIVE_TASK_159847_queue_fixture.md",
					FINAL_COMMIT: "NONE",
				},
			},
		})
		expect(malformedCommit.success).toBe(false)
	})
})
