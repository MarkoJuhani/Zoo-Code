// npx vitest run core/task/__tests__/flushPendingToolResultsToHistory.spec.ts

import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"

import type { GlobalState, ProviderSettings } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { Task } from "../Task"
import { ClineProvider } from "../../webview/ClineProvider"
import { TaskHistoryStore } from "../../task-persistence"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"

// Mock delay before any imports that might use it
vi.mock("delay", () => ({
	__esModule: true,
	default: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("execa", () => ({
	execa: vi.fn(),
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

const { mockPWaitFor } = vi.hoisted(() => {
	return { mockPWaitFor: vi.fn().mockImplementation(async () => Promise.resolve()) }
})

vi.mock("p-wait-for", () => ({
	default: mockPWaitFor,
}))

vi.mock("vscode", () => {
	const mockDisposable = { dispose: vi.fn() }
	const mockEventEmitter = { event: vi.fn(), fire: vi.fn() }
	const mockTextDocument = { uri: { fsPath: "/mock/workspace/path/file.ts" } }
	const mockTextEditor = { document: mockTextDocument }
	const mockTab = { input: { uri: { fsPath: "/mock/workspace/path/file.ts" } } }
	const mockTabGroup = { tabs: [mockTab] }

	return {
		TabInputTextDiff: vi.fn(),
		CodeActionKind: {
			QuickFix: { value: "quickfix" },
			RefactorRewrite: { value: "refactor.rewrite" },
		},
		window: {
			createTextEditorDecorationType: vi.fn().mockReturnValue({
				dispose: vi.fn(),
			}),
			visibleTextEditors: [mockTextEditor],
			tabGroups: {
				all: [mockTabGroup],
				close: vi.fn(),
				onDidChangeTabs: vi.fn(() => ({ dispose: vi.fn() })),
			},
			showErrorMessage: vi.fn(),
		},
		workspace: {
			workspaceFolders: [
				{
					uri: { fsPath: "/mock/workspace/path" },
					name: "mock-workspace",
					index: 0,
				},
			],
			createFileSystemWatcher: vi.fn(() => ({
				onDidCreate: vi.fn(() => mockDisposable),
				onDidDelete: vi.fn(() => mockDisposable),
				onDidChange: vi.fn(() => mockDisposable),
				dispose: vi.fn(),
			})),
			fs: {
				stat: vi.fn().mockResolvedValue({ type: 1 }),
			},
			onDidSaveTextDocument: vi.fn(() => mockDisposable),
			getConfiguration: vi.fn(() => ({ get: (key: string, defaultValue: any) => defaultValue })),
		},
		env: {
			uriScheme: "vscode",
			language: "en",
		},
		EventEmitter: vi.fn().mockImplementation(function () {
			return mockEventEmitter
		}),
		Disposable: {
			from: vi.fn(),
		},
		TabInputText: vi.fn(),
	}
})

vi.mock("../../mentions", () => ({
	parseMentions: vi.fn().mockImplementation((text) => {
		return Promise.resolve({ text: `processed: ${text}`, mode: undefined, contentBlocks: [] })
	}),
	openMention: vi.fn(),
	getLatestTerminalOutput: vi.fn(),
}))

vi.mock("../../../integrations/misc/extract-text", () => ({
	extractTextFromFile: vi.fn().mockResolvedValue("Mock file content"),
}))

vi.mock("../../environment/getEnvironmentDetails", () => ({
	getEnvironmentDetails: vi.fn().mockResolvedValue(""),
}))

vi.mock("../../ignore/RooIgnoreController")

vi.mock("../../condense", async (importOriginal) => {
	const actual = (await importOriginal()) as any
	return {
		...actual,
		summarizeConversation: vi.fn().mockResolvedValue({
			messages: [{ role: "user", content: [{ type: "text", text: "continued" }], ts: Date.now() }],
			summary: "summary",
			cost: 0,
			newContextTokens: 1,
		}),
	}
})

describe("flushPendingToolResultsToHistory", () => {
	let mockProvider: ClineProvider
	let mockApiConfig: ProviderSettings
	let mockOutputChannel: any
	let mockExtensionContext: vscode.ExtensionContext

	let storageRoot: string
	const tasks: Task[] = []
	beforeEach(async () => {
		beforeRename.mockReset()
		// Only external watchers/timers are disabled; initialization and publication remain real.
		const watcherEffects = TaskHistoryStore.prototype as unknown as {
			startWatcher: () => void
			startPeriodicReconciliation: () => void
		}
		vi.spyOn(watcherEffects, "startWatcher").mockImplementation(() => {})
		vi.spyOn(watcherEffects, "startPeriodicReconciliation").mockImplementation(() => {})
		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ordinary-tool-flush-"))
		const storageUri = { fsPath: storageRoot }

		mockExtensionContext = {
			globalState: {
				get: vi.fn().mockImplementation((key: keyof GlobalState) => undefined),
				update: vi.fn().mockImplementation((_key, _value) => Promise.resolve()),
				keys: vi.fn().mockReturnValue([]),
			},
			globalStorageUri: storageUri,
			workspaceState: {
				get: vi.fn().mockImplementation((_key) => undefined),
				update: vi.fn().mockImplementation((_key, _value) => Promise.resolve()),
				keys: vi.fn().mockReturnValue([]),
			},
			secrets: {
				get: vi.fn().mockImplementation((_key) => Promise.resolve(undefined)),
				store: vi.fn().mockImplementation((_key, _value) => Promise.resolve()),
				delete: vi.fn().mockImplementation((_key) => Promise.resolve()),
			},
			extensionUri: {
				fsPath: "/mock/extension/path",
			},
			extension: {
				packageJSON: {
					version: "1.0.0",
				},
			},
		} as unknown as vscode.ExtensionContext

		mockOutputChannel = {
			appendLine: vi.fn(),
			append: vi.fn(),
			clear: vi.fn(),
			show: vi.fn(),
			hide: vi.fn(),
			dispose: vi.fn(),
		}

		const store = new TaskHistoryStore(storageRoot)
		await store.initialize()
		// Avoid extension/MCP startup, not persistence: provider metadata updates
		// use the production method against this initialized disposable store.
		mockProvider = Object.assign(Object.create(ClineProvider.prototype), {
			context: mockExtensionContext,
			contextProxy: { globalStorageUri: storageUri },
			taskHistoryStore: store,
			providerSettingsManager: { getModeConfigId: async () => undefined },
			getState: async () => ({ mode: "code", currentApiConfigName: "offline" }),
			log: mockOutputChannel.appendLine,
			flushPostStateToWebviewThrottled: vi.fn(),
		}) as ClineProvider

		mockApiConfig = {
			apiProvider: providerIdentifiers.anthropic,
			apiModelId: "claude-3-5-sonnet-20241022",
			apiKey: "test-api-key",
		}

		mockProvider.postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebview = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebviewWithoutTaskHistory = vi.fn().mockResolvedValue(undefined)
		mockProvider.postStateToWebviewThrottled = vi.fn().mockResolvedValue(undefined)
	})

	afterEach(async () => {
		for (const task of tasks.splice(0)) {
			task["debouncedEmitTokenUsage"].cancel()
			await task.waitForModeInitialization()
			await task.waitForApiConfigInitialization()
			await task.dispose()
		}
		mockProvider.taskHistoryStore.dispose()
		vi.restoreAllMocks()
		await fs.rm(storageRoot, { recursive: true, force: true })
	})

	it("should not save anything when userMessageContent is empty", async () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
			onCreated: (task) => tasks.push(task),
		})

		// Ensure userMessageContent is empty
		task.userMessageContent = []
		const initialHistoryLength = task.apiConversationHistory.length

		// Call flush
		await task.flushPendingToolResultsToHistory()

		// History should not have changed since userMessageContent was empty
		expect(task.apiConversationHistory.length).toBe(initialHistoryLength)
	})

	it("should save user message when userMessageContent has pending tool results", async () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
			onCreated: (task) => tasks.push(task),
		})
		task.assistantMessageSavedToHistory = true

		// Set up pending tool result in userMessageContent
		task.userMessageContent = [
			{
				type: "tool_result",
				tool_use_id: "tool-123",
				content: "File written successfully",
			},
		]

		await task.flushPendingToolResultsToHistory()

		// Should have saved 1 user message
		expect(task.apiConversationHistory.length).toBe(1)

		// Check user message with tool result
		const userMessage = task.apiConversationHistory[0]
		expect(userMessage.role).toBe("user")
		expect(Array.isArray(userMessage.content)).toBe(true)
		expect((userMessage.content as any[])[0].type).toBe("tool_result")
		expect((userMessage.content as any[])[0].tool_use_id).toBe("tool-123")
	})

	it("should clear userMessageContent after flushing", async () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
			onCreated: (task) => tasks.push(task),
		})
		task.assistantMessageSavedToHistory = true

		// Set up pending tool result
		task.userMessageContent = [
			{
				type: "tool_result",
				tool_use_id: "tool-456",
				content: "Command executed",
			},
		]

		await task.flushPendingToolResultsToHistory()

		// userMessageContent should be cleared
		expect(task.userMessageContent.length).toBe(0)
	})

	it("should handle multiple tool results in a single flush", async () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
			onCreated: (task) => tasks.push(task),
		})
		task.assistantMessageSavedToHistory = true

		// Set up multiple pending tool results
		task.userMessageContent = [
			{
				type: "tool_result",
				tool_use_id: "tool-1",
				content: "First result",
			},
			{
				type: "tool_result",
				tool_use_id: "tool-2",
				content: "Second result",
			},
		]

		await task.flushPendingToolResultsToHistory()

		// Check user message has both tool results
		const userMessage = task.apiConversationHistory[0]
		expect(Array.isArray(userMessage.content)).toBe(true)
		expect((userMessage.content as any[]).length).toBe(2)
		expect((userMessage.content as any[])[0].tool_use_id).toBe("tool-1")
		expect((userMessage.content as any[])[1].tool_use_id).toBe("tool-2")
	})

	it("should add timestamp to saved messages", async () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
			onCreated: (task) => tasks.push(task),
		})
		task.assistantMessageSavedToHistory = true

		const beforeTs = Date.now()

		task.userMessageContent = [
			{
				type: "tool_result",
				tool_use_id: "tool-ts",
				content: "Result",
			},
		]

		await task.flushPendingToolResultsToHistory()

		const afterTs = Date.now()

		// Message should have timestamp
		expect((task.apiConversationHistory[0] as any).ts).toBeGreaterThanOrEqual(beforeTs)
		expect((task.apiConversationHistory[0] as any).ts).toBeLessThanOrEqual(afterTs)
	})

	it("should skip the persistence barrier when the assistant message is already saved", async () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
			onCreated: (task) => tasks.push(task),
		})

		// Set flag to true (assistant message already saved)
		task.assistantMessageSavedToHistory = true

		// Set up pending tool result
		task.userMessageContent = [
			{
				type: "tool_result",
				tool_use_id: "tool-skip-wait",
				content: "Result when flag is true",
			},
		]

		const waitForPersistence = vi.spyOn(task, "waitForCurrentAssistantMessagePersistence")

		await task.flushPendingToolResultsToHistory()

		expect(waitForPersistence).not.toHaveBeenCalled()

		// Should still save the message
		expect(task.apiConversationHistory.length).toBe(1)
		expect((task.apiConversationHistory[0].content as any[])[0].tool_use_id).toBe("tool-skip-wait")
	})

	it("should await the persistence barrier when the assistant message is not saved", async () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
			onCreated: (task) => tasks.push(task),
		})

		// Flag is false by default - assistant message not yet saved
		expect(task.assistantMessageSavedToHistory).toBe(false)

		// Set up pending tool result
		task.userMessageContent = [
			{
				type: "tool_result",
				tool_use_id: "tool-wait",
				content: "Result when flag is false",
			},
		]

		let resolveWait!: (result: boolean) => void
		const waitDeferred = new Promise<boolean>((res) => {
			resolveWait = res
		})
		const waitForPersistence = vi
			.spyOn(task, "waitForCurrentAssistantMessagePersistence")
			.mockReturnValue(waitDeferred)

		const flushPromise = task.flushPendingToolResultsToHistory()

		// Yield so the async function reaches the persistence await and suspends.
		await Promise.resolve()
		// History save must not start before persistence resolves.
		expect(task.apiConversationHistory.length).toBe(0)

		resolveWait(true)
		await flushPromise

		expect(waitForPersistence).toHaveBeenCalledTimes(1)
		// Should still save the message once persistence settled.
		expect(task.apiConversationHistory.length).toBe(1)
	})

	it("should not flush when task is aborted during wait", async () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
			onCreated: (task) => tasks.push(task),
		})

		// Flag is false - will need to wait
		task.assistantMessageSavedToHistory = false

		// Set up pending tool result
		task.userMessageContent = [
			{
				type: "tool_result",
				tool_use_id: "tool-aborted",
				content: "Should not be saved",
			},
		]

		const waitForPersistence = vi.spyOn(task, "waitForCurrentAssistantMessagePersistence")

		task.abort = true

		await task.flushPendingToolResultsToHistory()

		// Should not have saved anything since task was aborted
		expect(task.apiConversationHistory.length).toBe(0)
		expect(waitForPersistence).not.toHaveBeenCalled()
	})
	it("retains failed pending content and retries the same correlated result exactly once", async () => {
		const task = new Task({
			provider: mockProvider,
			apiConfiguration: mockApiConfig,
			task: "test task",
			startTask: false,
			onCreated: (task) => tasks.push(task),
		})
		task.assistantMessageSavedToHistory = true
		task.userMessageContent = [{ type: "tool_result", tool_use_id: "failed-result", content: "retained" }]
		let failNextWrite = true
		beforeRename.mockImplementation((_from, to) => {
			if (failNextWrite && String(to).endsWith("api_conversation_history.json")) {
				failNextWrite = false
				throw new Error("disk full")
			}
		})
		expect(await task.flushPendingToolResultsToHistory()).toBe(false)
		expect(task.userMessageContent).toEqual([
			{ type: "tool_result", tool_use_id: "failed-result", content: "retained" },
		])
		expect(task.apiConversationHistory).toHaveLength(1)
		const messageId = task.apiConversationHistory[0].messageId
		expect(await task.flushPendingToolResultsToHistory()).toBe(true)
		expect(task.userMessageContent).toEqual([])
		expect(task.apiConversationHistory).toHaveLength(1)
		expect(task.apiConversationHistory[0].messageId).toBe(messageId)
		const saved = JSON.parse(
			await fs.readFile(path.join(storageRoot, "tasks", task.taskId, "api_conversation_history.json"), "utf8"),
		)
		expect(saved).toHaveLength(1)
		expect(saved[0].content).toEqual([{ type: "tool_result", tool_use_id: "failed-result", content: "retained" }])
	})
})
