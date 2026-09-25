// npx vitest run __tests__/delegation-handoff-robustness.spec.ts

import { describe, it, expect, vi, beforeEach } from "vitest"
import { RooCodeEventName } from "@roo-code/types"
import type { HistoryItem } from "@roo-code/types"
import type { DelegationHandoffOutcome } from "../core/task/childCompletionProtocol"

/* vscode mock */
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

function makeTaskHistoryStoreStub(childItem: Partial<HistoryItem>, parentItem: Partial<HistoryItem>) {
	const correlatedChild = Object.hasOwn(childItem, "parentTaskId")
		? childItem
		: { ...childItem, parentTaskId: parentItem.id }
	const itemMap = new Map<string, Partial<HistoryItem>>([
		[correlatedChild.id!, correlatedChild],
		[parentItem.id!, parentItem],
	])

	const atomicUpdatePair = vi.fn(
		async (
			firstId: string,
			secondId: string,
			firstUpdater: (h: HistoryItem) => HistoryItem,
			secondUpdater: (h: HistoryItem) => HistoryItem,
		) => {
			itemMap.set(firstId, firstUpdater(itemMap.get(firstId) as HistoryItem))
			itemMap.set(secondId, secondUpdater(itemMap.get(secondId) as HistoryItem))
			return []
		},
	)

	return {
		atomicUpdatePair,
		get: vi.fn((id: string) => itemMap.get(id)),
		invalidate: vi.fn().mockResolvedValue(undefined),
	}
}

describe("Delegation handoff robustness - async scheduling and correlated lifecycle", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("reopenParentFromDelegation resolves immediately without waiting for a long-running parent task loop", async () => {
		const emitSpy = vi.fn()
		const parentItem: Partial<HistoryItem> = {
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
		let currentTask: { taskId: string } | undefined = { taskId: "child-async" }

		const provider = makeProviderStub({
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: parentItem }),
			emit: emitSpy,
			getCurrentTask: vi.fn(() => currentTask),
			removeClineFromStack: vi.fn(async () => {
				currentTask = undefined
			}),
			createTaskWithHistoryItem: vi.fn(async () => (currentTask = parentInstance)),
			taskHistoryStore,
			taskScheduler: scheduler,
			delegationTransitions: new Map([["parent-async", 2]]),
		})

		// Call reopenParentFromDelegation - this must resolve to true immediately and NOT hang!
		type ReopenMethod = (
			this: ClineProvider,
			params: { parentTaskId: string; childTaskId: string; completionResultSummary?: string },
		) => Promise<DelegationHandoffOutcome>
		const reopenPromise = (
			ClineProvider.prototype as unknown as { reopenParentFromDelegation: ReopenMethod }
		).reopenParentFromDelegation.call(provider, {
			parentTaskId: "parent-async",
			childTaskId: "child-async",
			completionResultSummary: "Subtask Done",
		})

		const result = await reopenPromise
		expect(result).toEqual({
			kind: "committed",
			resumeState: "queued",
			correlationId: "parent-async:child-async:direct",
		})

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
		// Wait a tick to allow the scheduled microtask to begin running
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(parentLoopStarted).toBe(true)
		expect(emitSpy).toHaveBeenCalledWith(RooCodeEventName.TaskDelegationResumed, "parent-async", "child-async", 2)
	})

	it("reports parent preparation failure after the handoff is durably committed", async () => {
		const parentItem = {
			id: "parent-prepare-failure",
			status: "delegated",
			awaitingChildId: "child-prepare-failure",
			childIds: ["child-prepare-failure"],
		} as Partial<HistoryItem>
		const taskHistoryStore = makeTaskHistoryStoreStub({ id: "child-prepare-failure", status: "active" }, parentItem)
		const emit = vi.fn()
		const log = vi.fn()
		const schedule = vi.fn()
		const provider = makeProviderStub({
			contextProxy: { globalStorageUri: { fsPath: "/tmp" } },
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: parentItem }),
			getCurrentTask: vi.fn(() => ({ taskId: "child-prepare-failure" })),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTaskWithHistoryItem: vi.fn().mockResolvedValue({
				taskId: "parent-prepare-failure",
				prepareAfterDelegation: vi.fn().mockRejectedValue(new Error("sensitive failure")),
			}),
			taskHistoryStore,
			taskScheduler: { schedule },
			emit,
			log,
		})

		await expect(
			ClineProvider.prototype.reopenParentFromDelegation.call(provider, {
				parentTaskId: "parent-prepare-failure",
				childTaskId: "child-prepare-failure",
				completionResultSummary: "Done",
			}),
		).resolves.toMatchObject({ kind: "committed", resumeState: "failed" })
		expect(schedule).not.toHaveBeenCalled()
		expect(log).toHaveBeenCalledWith(expect.stringContaining("stage=failed reason=Error"))
		expect(emit).toHaveBeenCalledWith(
			RooCodeEventName.TaskResumeScheduled,
			"parent-prepare-failure",
			"child-prepare-failure",
			false,
		)
	})

	it("releases the delegation transition lock immediately so a subsequent transition can run", async () => {
		const parentItem: Partial<HistoryItem> = {
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
		})

		type ReopenMethod = (
			this: ClineProvider,
			params: { parentTaskId: string; childTaskId: string; completionResultSummary?: string },
		) => Promise<DelegationHandoffOutcome>
		// 1st reopen completes
		await (
			ClineProvider.prototype as unknown as { reopenParentFromDelegation: ReopenMethod }
		).reopenParentFromDelegation.call(provider, {
			parentTaskId: "parent-lock",
			childTaskId: "child-lock-1",
			completionResultSummary: "Result 1",
		})

		// A subsequent transition on the same parent is NOT blocked behind the running parent loop
		let secondTransitionRan = false
		await (
			provider as unknown as {
				runDelegationTransition: (parentTaskId: string, fn: () => Promise<void>) => Promise<void>
			}
		).runDelegationTransition("parent-lock", async () => {
			secondTransitionRan = true
		})

		expect(secondTransitionRan).toBe(true)
	})
})
