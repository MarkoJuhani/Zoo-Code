// npx vitest run __tests__/delegation-handoff-robustness.spec.ts

import { describe, it, expect, vi, beforeEach } from "vitest"
import { RooCodeEventName } from "@roo-code/types"
import type { HistoryItem } from "@roo-code/types"

/* vscode mock */
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

vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureTaskCompleted: vi.fn(),
		},
	},
}))

vi.mock("../core/task-persistence/taskMessages", () => ({
	readTaskMessages: vi.fn().mockResolvedValue([]),
}))
vi.mock("../core/task-persistence", async (importOriginal) => {
	const real = await importOriginal<typeof import("../core/task-persistence")>()
	return {
		...real,
		readApiMessages: vi.fn().mockResolvedValue([]),
		saveApiMessages: vi.fn(async ({ messages }: { messages: unknown[] }) => messages),
		saveTaskMessages: vi.fn(async ({ messages }: { messages: unknown[] }) => messages),
	}
})

import { ClineProvider } from "../core/webview/ClineProvider"
import { makeProviderStub } from "./helpers/provider-stub"
import { TaskScheduler } from "../core/task/TaskScheduler"

function makeTaskHistoryStoreStub(childItem: Record<string, any>, parentItem: Record<string, any>) {
	const itemMap = new Map<string, Partial<HistoryItem>>([
		[childItem.id!, childItem],
		[parentItem.id!, parentItem],
	])

	const atomicUpdatePair = vi.fn(
		async (
			firstId: string,
			secondId: string,
			firstUpdater: (h: HistoryItem) => HistoryItem,
			secondUpdater: (h: HistoryItem) => HistoryItem,
		) => {
			firstUpdater(itemMap.get(firstId) as HistoryItem)
			secondUpdater(itemMap.get(secondId) as HistoryItem)
			return []
		},
	)

	return {
		atomicUpdatePair,
		get: vi.fn((id: string) => itemMap.get(id)),
	}
}

describe("Delegation handoff robustness - async scheduling and correlated lifecycle", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("reopenParentFromDelegation resolves immediately without waiting for a long-running parent task loop", async () => {
		const emitSpy = vi.fn()
		const parentItem = {
			id: "parent-async",
			status: "delegated",
			awaitingChildId: "child-async",
			childIds: [],
			ts: 100,
			task: "Parent Async Task",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const taskHistoryStore = makeTaskHistoryStoreStub({ id: "child-async", status: "active" }, parentItem)

		// Create a parent instance whose runResumeLoop never finishes (simulating a live running task)
		let parentLoopStarted = false
		const longRunningResumeLoop = vi.fn(() => {
			parentLoopStarted = true
			return new Promise<void>(() => {
				// never resolves to simulate indefinite multi-turn execution
			})
		})

		const parentInstance = {
			taskId: "parent-async",
			prepareAfterDelegation: vi.fn().mockResolvedValue(undefined),
			runResumeLoop: longRunningResumeLoop,
			overwriteClineMessages: vi.fn().mockResolvedValue(undefined),
			overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
		}

		const scheduler = new TaskScheduler(1)

		const provider = makeProviderStub({
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: parentItem }),
			emit: emitSpy,
			getCurrentTask: vi.fn(() => ({ taskId: "child-async" })),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTaskWithHistoryItem: vi.fn().mockResolvedValue(parentInstance),
			taskHistoryStore,
			taskScheduler: scheduler,
		} as any)

		// Record transition generation 2
		;(provider as any).delegationTransitions = new Map([["parent-async", 2]])

		// Call reopenParentFromDelegation - this must resolve to true immediately and NOT hang!
		const reopenPromise = (ClineProvider.prototype as any).reopenParentFromDelegation.call(provider, {
			parentTaskId: "parent-async",
			childTaskId: "child-async",
			completionResultSummary: "Subtask Done",
		})

		const result = await reopenPromise
		expect(result).toBe(true)

		// Verify preparation occurred synchronously
		expect(parentInstance.prepareAfterDelegation).toHaveBeenCalledTimes(1)

		// Verify lifecycle events with transition generation 2
		expect(emitSpy).toHaveBeenCalledWith(
			RooCodeEventName.TaskDelegationCompleted,
			"parent-async",
			"child-async",
			"Subtask Done",
			2,
		)
		expect(emitSpy).toHaveBeenCalledWith(
			RooCodeEventName.TaskResumeScheduled,
			"parent-async",
			"child-async",
			true,
			2,
		)
		expect(emitSpy).toHaveBeenCalledWith(RooCodeEventName.TaskDelegationResumed, "parent-async", "child-async", 2)

		// Wait a tick to allow the scheduled microtask to begin running
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(parentLoopStarted).toBe(true)
	})

	it("releases the delegation transition lock immediately so a subsequent transition can run", async () => {
		const parentItem = {
			id: "parent-lock",
			status: "delegated",
			awaitingChildId: "child-lock-1",
			childIds: [],
			ts: 200,
			task: "Parent Lock Task",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
		}
		const taskHistoryStore = makeTaskHistoryStoreStub({ id: "child-lock-1", status: "active" }, parentItem)

		const parentInstance = {
			taskId: "parent-lock",
			prepareAfterDelegation: vi.fn().mockResolvedValue(undefined),
			runResumeLoop: vi.fn().mockReturnValue(new Promise(() => {})), // never resolves
			overwriteClineMessages: vi.fn().mockResolvedValue(undefined),
			overwriteApiConversationHistory: vi.fn().mockResolvedValue(undefined),
		}

		const provider = makeProviderStub({
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: parentItem }),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => ({ taskId: "child-lock-1" })),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTaskWithHistoryItem: vi.fn().mockResolvedValue(parentInstance),
			taskHistoryStore,
			taskScheduler: new TaskScheduler(1),
		} as any)

		// 1st reopen completes
		await (ClineProvider.prototype as any).reopenParentFromDelegation.call(provider, {
			parentTaskId: "parent-lock",
			childTaskId: "child-lock-1",
			completionResultSummary: "Result 1",
		})

		// A subsequent transition on the same parent is NOT blocked behind the running parent loop
		let secondTransitionRan = false
		await (provider as any).runDelegationTransition("parent-lock", async () => {
			secondTransitionRan = true
		})

		expect(secondTransitionRan).toBe(true)
	})
})
