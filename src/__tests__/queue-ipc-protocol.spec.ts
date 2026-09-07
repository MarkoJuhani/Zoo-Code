// npx vitest run __tests__/queue-ipc-protocol.spec.ts

import { describe, it, expect, vi, beforeEach } from "vitest"
import { TaskCommandName, IpcMessageType, RooCodeEventName } from "@roo-code/types"

vi.mock("vscode", () => {
	const window = {
		createTextEditorDecorationType: vi.fn(() => ({ dispose: vi.fn() })),
		showErrorMessage: vi.fn(),
		onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
	}
	const workspace = {
		getConfiguration: vi.fn(() => ({
			get: vi.fn((_key: string, defaultValue: any) => defaultValue),
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
		private listeners: Record<string, Function[]> = {}

		public on(event: string, fn: Function) {
			this.listeners[event] = this.listeners[event] || []
			this.listeners[event].push(fn)
			return this
		}

		public async trigger(event: string, ...args: any[]) {
			const fns = this.listeners[event] || []
			for (const fn of fns) {
				await fn(...args)
			}
		}
	}
	return { IpcServer: MockIpcServer }
})

import { API } from "../extension/api"

describe("Queue Protocol v1 - Lease, Targeted Acceptance, Snapshot and Cancellation", () => {
	let outputChannel: any
	let mockSidebarProvider: any
	let api: API
	let mockIpc: any

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

		api = new API(outputChannel, mockSidebarProvider, "/tmp/test.sock", false)
		mockIpc = (api as any).ipc
	})

	it("QueueAcquireLease grants exclusive lease to caller and rejects competing owner", async () => {
		// 1. Acquire lease
		await mockIpc.trigger(IpcMessageType.TaskCommand, "client-1", {
			commandName: TaskCommandName.QueueAcquireLease,
			data: {
				rpcId: "rpc-1",
				queueId: "q-1",
				ownerToken: "token-alpha",
			},
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

		// 2. Competing client with different ownerToken is rejected
		await mockIpc.trigger(IpcMessageType.TaskCommand, "client-2", {
			commandName: TaskCommandName.QueueAcquireLease,
			data: {
				rpcId: "rpc-2",
				queueId: "q-2",
				ownerToken: "token-beta",
			},
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
		// Acquire lease first
		await mockIpc.trigger(IpcMessageType.TaskCommand, "client-1", {
			commandName: TaskCommandName.QueueAcquireLease,
			data: { rpcId: "rpc-1", queueId: "q-1", ownerToken: "token-alpha" },
		})

		// Start task with valid lease
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

	it("QueueAcceptCompletion validates target task, ownerToken, and approves task completion", async () => {
		// Acquire lease and start task
		await mockIpc.trigger(IpcMessageType.TaskCommand, "client-1", {
			commandName: TaskCommandName.QueueAcquireLease,
			data: { queueId: "q-1", ownerToken: "token-alpha" },
		})
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

		const mockTask = { taskId: "root-123", approveAsk: vi.fn() }
		mockSidebarProvider.getCurrentTask.mockReturnValue(mockTask)

		// Reject completion acceptance with wrong ownerToken
		await mockIpc.trigger(IpcMessageType.TaskCommand, "client-1", {
			commandName: TaskCommandName.QueueAcceptCompletion,
			data: {
				rpcId: "rpc-accept-bad",
				queueId: "q-1",
				ownerToken: "wrong-token",
				generation: 1,
				requestId: "req-1",
				rootTaskId: "root-123",
				result: "QUEUE_RESULT: DONE",
			},
		})
		expect(mockIpc.send).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({
				data: expect.objectContaining({
					rpcId: "rpc-accept-bad",
					ok: false,
				}),
			}),
		)
		expect(mockTask.approveAsk).not.toHaveBeenCalled()

		// Accept completion with valid credentials and matching rootTaskId
		await mockIpc.trigger(IpcMessageType.TaskCommand, "client-1", {
			commandName: TaskCommandName.QueueAcceptCompletion,
			data: {
				rpcId: "rpc-accept-ok",
				queueId: "q-1",
				ownerToken: "token-alpha",
				generation: 1,
				requestId: "req-1",
				rootTaskId: "root-123",
				result: "QUEUE_RESULT: DONE",
			},
		})
		expect(mockIpc.send).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({
				data: expect.objectContaining({
					rpcId: "rpc-accept-ok",
					ok: true,
					value: { accepted: true, taskId: "root-123" },
				}),
			}),
		)
		expect(mockTask.approveAsk).toHaveBeenCalled()
	})

	it("untargeted CancelTask is ignored while queue lease is active, protecting queue-owned work", async () => {
		// Acquire lease
		await mockIpc.trigger(IpcMessageType.TaskCommand, "client-1", {
			commandName: TaskCommandName.QueueAcquireLease,
			data: { queueId: "q-1", ownerToken: "token-alpha" },
		})

		// Untargeted cancel
		await mockIpc.trigger(IpcMessageType.TaskCommand, "client-unrelated", {
			commandName: TaskCommandName.CancelTask,
		})

		expect(mockSidebarProvider.cancelTask).not.toHaveBeenCalled()

		// Targeted cancel with valid ownership succeeds
		mockSidebarProvider.getCurrentTask.mockReturnValue({ taskId: "root-123" })
		;(api as any).queueDispatches.set("root-123", { rootTaskId: "root-123" })

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
})
