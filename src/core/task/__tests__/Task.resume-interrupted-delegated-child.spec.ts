// cd src && npx vitest run core/task/__tests__/Task.resume-interrupted-delegated-child.spec.ts

import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"

import type { ClineMessage, GlobalState, HistoryItem, PendingTaskAction, ProviderSettings } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"
import type { Anthropic } from "@anthropic-ai/sdk"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"

import { type ApiMessage, TaskHistoryStore } from "../../task-persistence"
import {
	interruptDelegatedChild,
	LifecycleTransitionContentionError,
	LifecycleTransitionError,
} from "../../task-persistence/taskLifecycle"
import { Task } from "../Task"
import { ClineProvider } from "../../webview/ClineProvider"
import { ContextProxy } from "../../config/ContextProxy"

type ResumeAccess = {
	resumeTaskFromHistory: () => Promise<void>
	prepareAsk: (...args: Parameters<Task["ask"]>) => Promise<() => ReturnType<Task["ask"]>>
	initiateTaskLoop: (userContent: Anthropic.Messages.ContentBlockParam[]) => Promise<void>
	addToApiConversationHistory: (message: Anthropic.MessageParam) => Promise<void>
}

function access(task: Task): ResumeAccess {
	// Private resume internals; the double assertion is confined to this accessor.
	return task as unknown as ResumeAccess
}

const { mockReadApiMessages, mockReadTaskMessages } = vi.hoisted(() => ({
	mockReadApiMessages: vi.fn().mockResolvedValue([]),
	mockReadTaskMessages: vi.fn().mockResolvedValue([]),
}))

vi.mock("delay", () => ({ __esModule: true, default: vi.fn().mockResolvedValue(undefined) }))
vi.mock("execa", () => ({ execa: vi.fn() }))
vi.mock("p-wait-for", () => ({ default: vi.fn().mockResolvedValue(undefined) }))

vi.mock("../../task-persistence", async (importOriginal) => {
	const mod = await importOriginal<typeof import("../../task-persistence")>()
	return { ...mod, readApiMessages: mockReadApiMessages, readTaskMessages: mockReadTaskMessages }
})

vi.mock("vscode", () => {
	const disposable = { dispose: vi.fn() }
	const eventEmitter = { event: vi.fn(), fire: vi.fn() }
	return {
		TabInputTextDiff: vi.fn(),
		CodeActionKind: { QuickFix: { value: "quickfix" }, RefactorRewrite: { value: "refactor.rewrite" } },
		window: {
			createTextEditorDecorationType: vi.fn().mockReturnValue({ dispose: vi.fn() }),
			visibleTextEditors: [],
			tabGroups: { all: [], close: vi.fn(), onDidChangeTabs: vi.fn(() => disposable) },
			showErrorMessage: vi.fn(),
		},
		workspace: {
			workspaceFolders: [{ uri: { fsPath: "/mock/workspace/path" }, name: "mock-workspace", index: 0 }],
			createFileSystemWatcher: vi.fn(() => ({
				onDidCreate: vi.fn(() => disposable),
				onDidDelete: vi.fn(() => disposable),
				onDidChange: vi.fn(() => disposable),
				dispose: vi.fn(),
			})),
			fs: { stat: vi.fn().mockResolvedValue({ type: 1 }) },
			onDidSaveTextDocument: vi.fn(() => disposable),
			getConfiguration: vi.fn(() => ({ get: (_key: string, defaultValue: unknown) => defaultValue })),
		},
		env: { uriScheme: "vscode", language: "en" },
		EventEmitter: vi.fn().mockImplementation(function () {
			return eventEmitter
		}),
		Disposable: { from: vi.fn() },
		TabInputText: vi.fn(),
	}
})

vi.mock("../../mentions", () => ({
	parseMentions: vi
		.fn()
		.mockImplementation((text: string) => Promise.resolve({ text, mode: undefined, contentBlocks: [] })),
	openMention: vi.fn(),
	getLatestTerminalOutput: vi.fn(),
}))
vi.mock("../../environment/getEnvironmentDetails", () => ({
	getEnvironmentDetails: vi.fn().mockResolvedValue(""),
}))
vi.mock("../../ignore/RooIgnoreController")

function historyItem(id: string, overrides: Partial<HistoryItem>): HistoryItem {
	return { id, number: 1, ts: 1, task: id, tokensIn: 0, tokensOut: 0, totalCost: 0, mode: "code", ...overrides }
}

describe("Resuming an interrupted delegated child (nested orchestrator)", () => {
	let provider: ClineProvider
	let storageRoot: string
	const pending = new Set<Promise<unknown>>()
	const track = <T>(operation: Promise<T>): Promise<T> => {
		pending.add(operation)
		void operation.then(
			() => pending.delete(operation),
			() => pending.delete(operation),
		)
		return operation
	}

	beforeEach(async () => {
		// Private store effects; the double assertion exposes them only for spying.
		const watcherEffects = TaskHistoryStore.prototype as unknown as {
			startWatcher: () => void
			startPeriodicReconciliation: () => void
		}
		vi.spyOn(watcherEffects, "startWatcher").mockImplementation(() => {})
		vi.spyOn(watcherEffects, "startPeriodicReconciliation").mockImplementation(() => {})
		const initialize = TaskHistoryStore.prototype.initialize
		vi.spyOn(TaskHistoryStore.prototype, "initialize").mockImplementation(function (this: TaskHistoryStore) {
			return track(initialize.call(this))
		})
		// Private Task save methods; the double assertion exposes them only for spying.
		const saves = Task.prototype as unknown as {
			saveApiConversationHistory: (merge?: boolean) => Promise<boolean>
			saveClineMessages: (merge?: boolean) => Promise<boolean>
		}
		for (const method of ["saveApiConversationHistory", "saveClineMessages"] as const) {
			const original = saves[method]
			vi.spyOn(saves, method).mockImplementation(function (this: Task, merge?: boolean) {
				return track(original.call(this, merge))
			})
		}
		if (!TelemetryService.hasInstance()) TelemetryService.createInstance([])

		storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "resume-interrupted-child-"))
		const context = {
			globalState: {
				get: vi.fn().mockImplementation((_key: keyof GlobalState) => undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			globalStorageUri: { fsPath: storageRoot },
			workspaceState: {
				get: vi.fn().mockReturnValue(undefined),
				update: vi.fn().mockResolvedValue(undefined),
				keys: vi.fn().mockReturnValue([]),
			},
			secrets: {
				get: vi.fn().mockResolvedValue(undefined),
				store: vi.fn().mockResolvedValue(undefined),
				delete: vi.fn().mockResolvedValue(undefined),
			},
			extensionUri: { fsPath: "/mock/extension/path" },
			extension: { packageJSON: { version: "1.0.0" } },
		} as unknown as vscode.ExtensionContext // Partial structural double: only members ClineProvider reads.
		const output = {
			appendLine: vi.fn(),
			append: vi.fn(),
			clear: vi.fn(),
			show: vi.fn(),
			hide: vi.fn(),
			dispose: vi.fn(),
		} as unknown as vscode.OutputChannel // Partial structural double: only members ClineProvider reads.
		provider = new ClineProvider(context, output, "sidebar", new ContextProxy(context))
		provider.postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		provider.postStateToWebview = vi.fn().mockResolvedValue(undefined)
		provider.postStateToWebviewWithoutTaskHistory = vi.fn().mockResolvedValue(undefined)
		provider.log = vi.fn()
		await Promise.all([...pending])
	})

	afterEach(async () => {
		for (let batch = 0; pending.size > 0 && batch < 8; batch++) await Promise.allSettled([...pending])
		provider.taskHistoryStore.dispose()
		vi.restoreAllMocks()
		await fs.rm(storageRoot, { recursive: true, force: true })
	})

	it("restores a live status after Resume so the resumed child can delegate again", async () => {
		// Persisted shape from the field report: root awaits the orchestrator, whose own
		// child ("lead") has already completed back into it (orchestrator active).
		const root = historyItem("root", {
			status: "delegated",
			awaitingChildId: "orch",
			delegatedToId: "orch",
			childIds: ["orch"],
		})
		const orch = historyItem("orch", {
			status: "active",
			parentTaskId: "root",
			rootTaskId: "root",
			completedByChildId: "lead",
			childIds: ["lead"],
		})
		await provider.updateTaskHistory(root)
		await provider.updateTaskHistory(orch)

		// cancelTask() on the running orchestrator (ClineProvider.cancelTask's delegated-child
		// branch) persists exactly this reducer result, then rehydrates it in place.
		await provider.updateTaskHistory(interruptDelegatedChild(root, orch))
		const interrupted = await provider.getTaskMetadata("orch")
		expect(interrupted).toMatchObject({ kind: "found", item: { status: "interrupted" } })
		if (interrupted.kind !== "found") throw new Error("seed failed")

		// createTaskWithHistoryItem() builds the rehydrated instance from the persisted item.
		const messages: ClineMessage[] = [
			{ ts: 1, type: "say", say: "text", text: "Delegating review" },
			{ ts: 2, type: "say", say: "subtask_result", text: "Review done" },
		]
		mockReadTaskMessages.mockResolvedValue(messages)
		mockReadApiMessages.mockResolvedValue([
			{ role: "user", content: [{ type: "text", text: "Run the ticket" }], ts: 1 },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "call_lead", name: "new_task", input: {} }],
				ts: 2,
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "call_lead", content: "Subtask lead completed." }],
				ts: 3,
			},
		])
		const apiConfiguration: ProviderSettings = {
			apiProvider: providerIdentifiers.anthropic,
			apiModelId: "claude-3-5-sonnet-20241022",
			apiKey: "test-api-key",
		}
		const task = new Task({
			provider,
			apiConfiguration,
			historyItem: interrupted.item,
			initialStatus: interrupted.item.status,
			startTask: false,
		})

		// The user clicks Resume on the in-place resume_task ask.
		vi.spyOn(task, "ask").mockResolvedValue({ response: "yesButtonClicked" })
		vi.spyOn(access(task), "prepareAsk").mockImplementation(
			async (...args) =>
				() =>
					task.ask(...args),
		)
		const loop = vi.spyOn(access(task), "initiateTaskLoop").mockResolvedValue(undefined)

		await access(task).resumeTaskFromHistory()

		// The orchestrator is live again: its agentic loop was started.
		expect(loop).toHaveBeenCalledTimes(1)
		// delegateParentAndOpenChildUnlocked reads exactly this record and refuses
		// "Parent orch is interrupted; refusing to dispose it for delegation" while it is
		// still "interrupted". A resumed, running task must not keep the stopped status.
		const resumed = await provider.getTaskMetadata("orch")
		expect(resumed.kind === "found" ? resumed.item.status : resumed.kind).toBe("active")
		// The link to the awaiting root is preserved.
		expect(await provider.getTaskMetadata("root")).toMatchObject({
			kind: "found",
			item: { status: "delegated", awaitingChildId: "orch" },
		})
	})

	/** The persisted shape above: root awaits the interrupted orchestrator. */
	async function openInterruptedOrchestrator({
		orch: orchOverrides = {},
		api = [
			{ role: "user", content: [{ type: "text", text: "Run the ticket" }], ts: 1 },
			{ role: "assistant", content: [{ type: "text", text: "Working" }], ts: 2 },
		],
	}: { orch?: Partial<HistoryItem>; api?: ApiMessage[] } = {}): Promise<Task> {
		const root = historyItem("root", {
			status: "delegated",
			awaitingChildId: "orch",
			delegatedToId: "orch",
			childIds: ["orch"],
		})
		const orch = historyItem("orch", {
			status: "active",
			parentTaskId: "root",
			rootTaskId: "root",
			...orchOverrides,
		})
		await provider.updateTaskHistory(root)
		await provider.updateTaskHistory(orch)
		await provider.updateTaskHistory(interruptDelegatedChild(root, orch))
		const interrupted = await provider.getTaskMetadata("orch")
		if (interrupted.kind !== "found") throw new Error("seed failed")
		mockReadTaskMessages.mockResolvedValue([{ ts: 1, type: "say", say: "text", text: "Orchestrate" }])
		mockReadApiMessages.mockResolvedValue(api)
		return new Task({
			provider,
			apiConfiguration: {
				apiProvider: providerIdentifiers.anthropic,
				apiModelId: "claude-3-5-sonnet-20241022",
				apiKey: "test-api-key",
			},
			historyItem: interrupted.item,
			initialStatus: interrupted.item.status,
			startTask: false,
		})
	}

	it("keeps the interrupted status when the chat is only opened, not resumed", async () => {
		const task = await openInterruptedOrchestrator()
		let answer!: (value: Awaited<ReturnType<Task["ask"]>>) => void
		const ask = vi.spyOn(task, "ask").mockReturnValue(new Promise((resolve) => (answer = resolve)))
		vi.spyOn(access(task), "prepareAsk").mockImplementation(
			async (...args) =>
				() =>
					task.ask(...args),
		)
		const loop = vi.spyOn(access(task), "initiateTaskLoop").mockResolvedValue(undefined)
		const restore = vi.spyOn(provider, "resumeInterruptedTask")

		const opened = access(task).resumeTaskFromHistory()
		await vi.waitFor(() => expect(ask).toHaveBeenCalledWith("resume_task"))

		// Rehydrated and showing the Resume ask: nothing is restored yet.
		expect(await provider.getTaskMetadata("orch")).toMatchObject({ kind: "found", item: { status: "interrupted" } })
		// The user closes the chat instead of answering.
		await task.abortTask(true)
		answer({ response: "yesButtonClicked" })
		await opened

		expect(restore).not.toHaveBeenCalled()
		expect(loop).not.toHaveBeenCalled()
		expect(await provider.getTaskMetadata("orch")).toMatchObject({ kind: "found", item: { status: "interrupted" } })
		expect(await provider.getTaskMetadata("root")).toMatchObject({
			kind: "found",
			item: { status: "delegated", awaitingChildId: "orch" },
		})
	})

	it("does not restore a status when the instance is stopped while the restore waits", async () => {
		const task = await openInterruptedOrchestrator()
		vi.spyOn(task, "ask").mockResolvedValue({ response: "yesButtonClicked" })
		vi.spyOn(access(task), "prepareAsk").mockImplementation(
			async (...args) =>
				() =>
					task.ask(...args),
		)
		vi.spyOn(access(task), "initiateTaskLoop").mockResolvedValue(undefined)
		const restore = vi.spyOn(provider, "resumeInterruptedTask")
		// A concurrent cancellation holds the parent's delegation transition.
		let releaseTransition!: () => void
		const transition = provider["runDelegationTransition"](
			"root",
			() => new Promise<void>((resolve) => (releaseTransition = resolve)),
		)

		const resumed = access(task).resumeTaskFromHistory()
		await vi.waitFor(() => expect(restore).toHaveBeenCalledTimes(1))
		// Cancellation aborts the instance synchronously before its own transition step.
		task.abort = true
		releaseTransition()
		await transition
		await resumed

		await expect(restore.mock.results[0]?.value).resolves.toBeUndefined()
		expect(task["liveStatus"]).toBe("interrupted")
		expect(await provider.getTaskMetadata("orch")).toMatchObject({ kind: "found", item: { status: "interrupted" } })
	})

	it("stops applying interrupted-only gates once the instance is resumed", async () => {
		const task = await openInterruptedOrchestrator()
		vi.spyOn(task, "ask").mockResolvedValue({ response: "yesButtonClicked" })
		vi.spyOn(access(task), "prepareAsk").mockImplementation(
			async (...args) =>
				() =>
					task.ask(...args),
		)
		vi.spyOn(access(task), "initiateTaskLoop").mockResolvedValue(undefined)

		await access(task).resumeTaskFromHistory()

		expect(task["liveStatus"]).toBe("active")
		// The Continue gate for an interrupted create handoff no longer swallows Continue.
		task["pendingAction"] = {
			kind: "create_subtask",
			actionId: "later-action",
			approvalText: "newTask",
			mode: "code",
			message: "Child",
			todos: [],
		}
		task.clineMessages.push({ ts: 3, type: "ask", ask: "resume_task" })
		task.handleWebviewAskResponse("yesButtonClicked")
		expect(task["askResponse"]).toBe("yesButtonClicked")
	})

	/** Answer presented asks in order; any further ask is a test failure. */
	function answerAsks(task: Task, ...answers: Array<Awaited<ReturnType<Task["ask"]>>>) {
		const ask = vi.spyOn(task, "ask").mockImplementation(async (type) => {
			throw new Error(`unexpected ask ${type}`)
		})
		for (const answer of answers) ask.mockResolvedValueOnce(answer)
		vi.spyOn(access(task), "prepareAsk").mockImplementation(
			async (...args) =>
				() =>
					task.ask(...args),
		)
		return ask
	}

	async function persistedStatus(id: string) {
		const read = await provider.getTaskMetadata(id)
		return read.kind === "found" ? read.item.status : read.kind
	}

	describe("restore placement and failure exits", () => {
		const finishAction = {
			kind: "finish_subtask",
			actionId: "finish-1",
			approvalText: "finish approval",
			parentTaskId: "root",
			result: "orchestrated",
		} as const

		it("restores active before the denied loop of a restored pending action", async () => {
			const task = await openInterruptedOrchestrator({ orch: { pendingAction: finishAction } })
			const ask = answerAsks(task, { response: "messageResponse", text: "Revise it" })
			const reopen = vi.spyOn(provider, "reopenParentFromDelegation")
			const restore = vi.spyOn(provider, "resumeInterruptedTask")
			const loop = vi.spyOn(access(task), "initiateTaskLoop").mockResolvedValue(undefined)

			await access(task).resumeTaskFromHistory()

			expect(ask).toHaveBeenCalledTimes(1)
			expect(ask).toHaveBeenCalledWith("tool", finishAction.approvalText, false)
			expect(reopen).not.toHaveBeenCalled()
			expect(restore).toHaveBeenCalledTimes(1)
			expect(loop).toHaveBeenCalledTimes(1)
			expect(loop.mock.calls[0]?.[0]).toEqual([
				expect.objectContaining({ type: "tool_result", tool_use_id: finishAction.actionId }),
			])
			expect(restore.mock.invocationCallOrder[0]).toBeLessThan(loop.mock.invocationCallOrder[0])
			expect(task["liveStatus"]).toBe("active")
			expect(await persistedStatus("orch")).toBe("active")
			expect(await provider.getTaskMetadata("root")).toMatchObject({
				kind: "found",
				item: { status: "delegated", awaitingChildId: "orch" },
			})
		})

		it("restores active before the completion_result fallback loop", async () => {
			const task = await openInterruptedOrchestrator({ orch: { pendingAction: finishAction } })
			const ask = answerAsks(
				task,
				{ response: "yesButtonClicked" },
				{ response: "messageResponse", text: "Keep going" },
			)
			const reopen = vi
				.spyOn(provider, "reopenParentFromDelegation")
				.mockResolvedValue({ kind: "detached", phase: "precommit", reason: "ownership_moved" })
			const clear = vi.spyOn(provider, "clearPendingTaskAction")
			const restore = vi.spyOn(provider, "resumeInterruptedTask")
			const loop = vi.spyOn(access(task), "initiateTaskLoop").mockResolvedValue(undefined)

			await access(task).resumeTaskFromHistory()

			expect(reopen).toHaveBeenCalledTimes(1)
			expect(ask.mock.calls.map(([type]) => type)).toEqual(["tool", "completion_result"])
			expect(clear).toHaveBeenCalledWith("orch", finishAction.actionId)
			expect(restore).toHaveBeenCalledTimes(1)
			expect(clear.mock.invocationCallOrder[0]).toBeLessThan(restore.mock.invocationCallOrder[0])
			expect(loop).toHaveBeenCalledTimes(1)
			expect(restore.mock.invocationCallOrder[0]).toBeLessThan(loop.mock.invocationCallOrder[0])
			const orch = await provider.getTaskMetadata("orch")
			expect(orch).toMatchObject({ kind: "found", item: { status: "active" } })
			expect(orch.kind === "found" ? orch.item : undefined).not.toHaveProperty("pendingAction")
		})

		const question = {
			id: "question-1",
			taskId: "orch",
			toolCallId: "call_question",
			text: "Which option?",
			answer: { text: "Option B" },
		}
		const questionCall: ApiMessage = {
			role: "assistant",
			content: [
				{ type: "tool_use", id: question.toolCallId, name: "ask_followup_question", input: { question: "?" } },
			],
			ts: 2,
		}

		it("auto-continues a recorded question answer on open and restores active first", async () => {
			const task = await openInterruptedOrchestrator({
				orch: { pendingQuestion: question },
				api: [
					{ role: "user", content: [{ type: "text", text: "Run the ticket" }], ts: 1 },
					questionCall,
					{
						role: "user",
						content: [{ type: "tool_result", tool_use_id: question.toolCallId, content: "Option B" }],
						ts: 3,
					},
				],
			})
			const ask = answerAsks(task)
			const restore = vi.spyOn(provider, "resumeInterruptedTask")
			const loop = vi.spyOn(access(task), "initiateTaskLoop").mockResolvedValue(undefined)

			await access(task).resumeTaskFromHistory()

			// Pre-existing auto-continue: no click is needed for an already answered question.
			expect(ask).not.toHaveBeenCalled()
			expect(restore).toHaveBeenCalledTimes(1)
			expect(loop).toHaveBeenCalledTimes(1)
			expect(loop.mock.calls[0]?.[0]).toEqual([{ type: "text", text: "Continue from the recorded answer." }])
			expect(restore.mock.invocationCallOrder[0]).toBeLessThan(loop.mock.invocationCallOrder[0])
			const orch = await provider.getTaskMetadata("orch")
			expect(orch).toMatchObject({ kind: "found", item: { status: "active" } })
			expect(orch.kind === "found" ? orch.item : undefined).not.toHaveProperty("pendingQuestion")
		})

		it("auto-continues a durably answered question on open and restores active after delivering it", async () => {
			const task = await openInterruptedOrchestrator({
				orch: { pendingQuestion: question },
				api: [{ role: "user", content: [{ type: "text", text: "Run the ticket" }], ts: 1 }, questionCall],
			})
			const ask = answerAsks(task)
			const addResult = vi.spyOn(access(task), "addToApiConversationHistory")
			const restore = vi.spyOn(provider, "resumeInterruptedTask")
			const loop = vi.spyOn(access(task), "initiateTaskLoop").mockResolvedValue(undefined)

			await access(task).resumeTaskFromHistory()

			expect(ask).not.toHaveBeenCalled()
			expect(addResult).toHaveBeenCalledWith({
				role: "user",
				content: [expect.objectContaining({ type: "tool_result", tool_use_id: question.toolCallId })],
			})
			expect(restore).toHaveBeenCalledTimes(1)
			expect(loop).toHaveBeenCalledTimes(1)
			expect(addResult.mock.invocationCallOrder[0]).toBeLessThan(restore.mock.invocationCallOrder[0])
			expect(restore.mock.invocationCallOrder[0]).toBeLessThan(loop.mock.invocationCallOrder[0])
			expect(await persistedStatus("orch")).toBe("active")
		})

		it("keeps a superseded child interrupted, warns, and still starts its loop", async () => {
			const task = await openInterruptedOrchestrator()
			const root = await provider.getTaskMetadata("root")
			if (root.kind !== "found") throw new Error("seed failed")
			// The parent re-delegated to another child while this one was interrupted.
			await provider.updateTaskHistory({
				...root.item,
				awaitingChildId: "other",
				delegatedToId: "other",
				childIds: ["orch", "other"],
			})
			answerAsks(task, { response: "yesButtonClicked" })
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
			const restore = vi.spyOn(provider, "resumeInterruptedTask")
			const loop = vi.spyOn(access(task), "initiateTaskLoop").mockResolvedValue(undefined)

			await access(task).resumeTaskFromHistory()

			const refusal: unknown = await restore.mock.results[0]?.value.then(
				() => undefined,
				(error: unknown) => error,
			)
			expect(refusal).toBeInstanceOf(LifecycleTransitionError)
			expect(refusal).not.toBeInstanceOf(LifecycleTransitionContentionError)
			expect(warn).toHaveBeenCalledWith(expect.stringContaining("orch stays interrupted"))
			expect(loop).toHaveBeenCalledTimes(1)
			expect(task["liveStatus"]).toBe("interrupted")
			expect(await persistedStatus("orch")).toBe("interrupted")
		})

		it("does not start the loop when the restore fails for a non-lifecycle reason", async () => {
			const task = await openInterruptedOrchestrator()
			answerAsks(task, { response: "yesButtonClicked" })
			vi.spyOn(provider, "resumeInterruptedTask").mockRejectedValue(new Error("metadata write failed"))
			const loop = vi.spyOn(access(task), "initiateTaskLoop").mockResolvedValue(undefined)

			await expect(access(task).resumeTaskFromHistory()).rejects.toThrow("metadata write failed")

			expect(loop).not.toHaveBeenCalled()
			expect(task["liveStatus"]).toBe("interrupted")
			expect(await persistedStatus("orch")).toBe("interrupted")
		})

		it("gives up a busy parent lock within its bound, writes nothing, and lets the holder finish", async () => {
			const task = await openInterruptedOrchestrator()
			const root = await provider.getTaskMetadata("root")
			if (root.kind !== "found") throw new Error("seed failed")
			answerAsks(task, { response: "yesButtonClicked" })
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
			const restore = vi.spyOn(provider, "resumeInterruptedTask")
			const loop = vi.spyOn(access(task), "initiateTaskLoop").mockResolvedValue(undefined)
			const bound = ClineProvider["resumeDelegationLockWaitMs"]
			ClineProvider["resumeDelegationLockWaitMs"] = 100
			try {
				// A cancellation-like holder: it owns the parent's delegation lock, then writes the
				// parent, which needs the fences the resuming caller holds.
				let enter!: () => void
				const entered = new Promise<void>((resolve) => (enter = resolve))
				const holder = provider["runDelegationTransition"]("root", async () => {
					await entered
					await provider.updateTaskHistory({ ...root.item, tokensIn: 7 })
				})
				const resumed = access(task).resumeTaskFromHistory()
				await vi.waitFor(() => expect(restore).toHaveBeenCalledTimes(1))
				enter()
				const startedAt = Date.now()

				await resumed
				expect(Date.now() - startedAt).toBeLessThan(5_000)
				await holder

				const refusal: unknown = await restore.mock.results[0]?.value.then(
					() => undefined,
					(error: unknown) => error,
				)
				expect(refusal).toBeInstanceOf(LifecycleTransitionContentionError)
				expect(warn).toHaveBeenCalledWith(expect.stringContaining("orch stays interrupted"))
				expect(loop).toHaveBeenCalledTimes(1)
				expect(task["liveStatus"]).toBe("interrupted")
				expect(await persistedStatus("orch")).toBe("interrupted")
				expect(await provider.getTaskMetadata("root")).toMatchObject({
					kind: "found",
					item: { status: "delegated", awaitingChildId: "orch", tokensIn: 7 },
				})
			} finally {
				ClineProvider["resumeDelegationLockWaitMs"] = bound
			}
		})
	})

	describe("saved subtask handoff on reopen", () => {
		const createAction: PendingTaskAction = {
			kind: "create_subtask",
			actionId: "call_followup",
			approvalText: JSON.stringify({ tool: "newTask", mode: "Code", content: "Follow up" }),
			mode: "code",
			message: "Follow up",
			todos: [],
		}

		/** Field shape: the child finished into its parent, then feedback led it to call new_task. */
		async function openCompletedOrchestrator(): Promise<Task> {
			await provider.updateTaskHistory(
				historyItem("root", { status: "completed", childIds: ["orch"], completedByChildId: "orch" }),
			)
			await provider.updateTaskHistory(
				historyItem("orch", {
					status: "completed",
					parentTaskId: "root",
					rootTaskId: "root",
					pendingAction: createAction,
				}),
			)
			const completed = await provider.getTaskMetadata("orch")
			if (completed.kind !== "found") throw new Error("seed failed")
			mockReadTaskMessages.mockResolvedValue([
				{ ts: 1, type: "say", say: "completion_result", text: "TICKET_RESULT: FAILED" },
				{ ts: 2, type: "ask", ask: "tool", text: createAction.approvalText },
			])
			mockReadApiMessages.mockResolvedValue([
				{ role: "user", content: [{ type: "text", text: "Why is it blocked?" }], ts: 1 },
				{
					role: "assistant",
					content: [{ type: "tool_use", id: createAction.actionId, name: "new_task", input: {} }],
					ts: 2,
				},
			])
			return new Task({
				provider,
				apiConfiguration: {
					apiProvider: providerIdentifiers.anthropic,
					apiModelId: "claude-3-5-sonnet-20241022",
					apiKey: "test-api-key",
				},
				historyItem: completed.item,
				initialStatus: completed.item.status,
				startTask: false,
			})
		}

		it("drops the handoff on open instead of replaying it, so an approval creates no empty child", async () => {
			const task = await openCompletedOrchestrator()
			// The field approvals answered the replayed handoff with Yes; here Yes meets the Resume ask.
			const ask = answerAsks(task, { response: "yesButtonClicked" })
			const delegate = vi.spyOn(provider, "delegateParentAndOpenChild")
			const loop = vi.spyOn(access(task), "initiateTaskLoop").mockResolvedValue(undefined)

			await access(task).resumeTaskFromHistory()

			// The completed Resume ask is shown; the subtask approval is not replayed.
			expect(ask.mock.calls.map(([type]) => type)).toEqual(["resume_completed_task"])
			expect(delegate).not.toHaveBeenCalled()
			expect(
				provider.taskHistoryStore
					.getAll()
					.map((item) => item.id)
					.sort(),
			).toEqual(["orch", "root"])
			const orch = await provider.getTaskMetadata("orch")
			expect(orch).toMatchObject({ kind: "found", item: { status: "completed" } })
			expect(orch.kind === "found" ? orch.item : undefined).not.toHaveProperty("pendingAction")
			expect(await provider.getTaskMetadata("root")).toMatchObject({
				kind: "found",
				item: { status: "completed", childIds: ["orch"] },
			})
			// The unfinished call is answered as an error.
			expect(loop).toHaveBeenCalledTimes(1)
			expect(loop.mock.calls[0]?.[0]).toEqual([
				expect.objectContaining({ type: "tool_result", tool_use_id: createAction.actionId, is_error: true }),
			])
		})

		it("answers the unfinished call as an error before the user's feedback", async () => {
			const task = await openCompletedOrchestrator()
			answerAsks(task, { response: "messageResponse", text: "Assign the fixes" })
			const loop = vi.spyOn(access(task), "initiateTaskLoop").mockResolvedValue(undefined)

			await access(task).resumeTaskFromHistory()

			expect(loop.mock.calls[0]?.[0]).toEqual([
				expect.objectContaining({ type: "tool_result", tool_use_id: createAction.actionId, is_error: true }),
				{ type: "text", text: "<user_message>\nAssign the fixes\n</user_message>" },
			])
		})

		it("does not replay a newer stored handoff adopted when the clear finds a different action", async () => {
			const task = await openCompletedOrchestrator()
			const newer: PendingTaskAction = { ...createAction, actionId: "call_newer" }
			// Another host rewrote the stored action between the open snapshot and the clear.
			vi.spyOn(provider, "clearPendingTaskAction").mockResolvedValue(false)
			const get = provider.taskHistoryStore.get.bind(provider.taskHistoryStore)
			vi.spyOn(provider.taskHistoryStore, "get").mockImplementation((id) => {
				const item = get(id)
				return id === "orch" && item ? { ...item, pendingAction: newer } : item
			})
			const ask = answerAsks(task, { response: "yesButtonClicked" })
			const delegate = vi.spyOn(provider, "delegateParentAndOpenChild")
			vi.spyOn(access(task), "initiateTaskLoop").mockResolvedValue(undefined)

			await access(task).resumeTaskFromHistory()

			expect(task["pendingAction"]).toEqual(newer)
			expect(ask.mock.calls.map(([type]) => type)).toEqual(["resume_completed_task"])
			expect(delegate).not.toHaveBeenCalled()
		})

		it("drops a blocked task's handoff on open, keeping its blocked delegation intact", async () => {
			// A blocked parent cannot delegate either; replaying the approval only ended in a refusal.
			await provider.updateTaskHistory(
				historyItem("orch", {
					status: "blocked_protocol_error",
					awaitingChildId: "lead",
					delegatedToId: "lead",
					protocolErrorChildId: "lead",
					protocolErrorCode: "missing_attempt_completion",
					childIds: ["lead"],
					pendingAction: createAction,
				}),
			)
			await provider.updateTaskHistory(
				historyItem("lead", {
					status: "blocked_protocol_error",
					parentTaskId: "orch",
					rootTaskId: "orch",
					protocolErrorCode: "missing_attempt_completion",
				}),
			)
			const blocked = await provider.getTaskMetadata("orch")
			if (blocked.kind !== "found") throw new Error("seed failed")
			mockReadTaskMessages.mockResolvedValue([
				{ ts: 1, type: "ask", ask: "tool", text: createAction.approvalText },
			])
			mockReadApiMessages.mockResolvedValue([
				{ role: "user", content: [{ type: "text", text: "Continue" }], ts: 1 },
				{
					role: "assistant",
					content: [{ type: "tool_use", id: createAction.actionId, name: "new_task", input: {} }],
					ts: 2,
				},
			])
			const task = new Task({
				provider,
				apiConfiguration: {
					apiProvider: providerIdentifiers.anthropic,
					apiModelId: "claude-3-5-sonnet-20241022",
					apiKey: "test-api-key",
				},
				historyItem: blocked.item,
				initialStatus: blocked.item.status,
				startTask: false,
			})
			const ask = answerAsks(task, { response: "yesButtonClicked" })
			const delegate = vi.spyOn(provider, "delegateParentAndOpenChild")
			const loop = vi.spyOn(access(task), "initiateTaskLoop").mockResolvedValue(undefined)

			await access(task).resumeTaskFromHistory()

			expect(ask.mock.calls.map(([type]) => type)).toEqual(["resume_task"])
			expect(delegate).not.toHaveBeenCalled()
			expect(
				provider.taskHistoryStore
					.getAll()
					.map((item) => item.id)
					.sort(),
			).toEqual(["lead", "orch"])
			const orch = await provider.getTaskMetadata("orch")
			expect(orch).toMatchObject({
				kind: "found",
				item: { status: "blocked_protocol_error", awaitingChildId: "lead", protocolErrorChildId: "lead" },
			})
			expect(orch.kind === "found" ? orch.item : undefined).not.toHaveProperty("pendingAction")
			expect(loop.mock.calls[0]?.[0]).toEqual([
				expect.objectContaining({ type: "tool_result", tool_use_id: createAction.actionId, is_error: true }),
			])
		})

		it("still replays a delegated parent's re-delegation once its awaited child is interrupted", async () => {
			// Delegated is excluded from the drop: re-delegation depends on the awaited child, not the parent.
			const root = historyItem("root", {
				status: "delegated",
				awaitingChildId: "orch",
				delegatedToId: "orch",
				childIds: ["orch"],
			})
			const orch = historyItem("orch", { status: "active", parentTaskId: "root", rootTaskId: "root" })
			await provider.updateTaskHistory(root)
			await provider.updateTaskHistory(orch)
			await provider.updateTaskHistory(interruptDelegatedChild(root, orch))
			await provider.updateTaskHistory({ ...root, pendingAction: createAction })
			const delegated = await provider.getTaskMetadata("root")
			if (delegated.kind !== "found") throw new Error("seed failed")
			mockReadTaskMessages.mockResolvedValue([
				{ ts: 1, type: "ask", ask: "tool", text: createAction.approvalText },
			])
			mockReadApiMessages.mockResolvedValue([
				{ role: "user", content: [{ type: "text", text: "Retry the work" }], ts: 1 },
				{
					role: "assistant",
					content: [{ type: "tool_use", id: createAction.actionId, name: "new_task", input: {} }],
					ts: 2,
				},
			])
			const task = new Task({
				provider,
				apiConfiguration: {
					apiProvider: providerIdentifiers.anthropic,
					apiModelId: "claude-3-5-sonnet-20241022",
					apiKey: "test-api-key",
				},
				historyItem: delegated.item,
				initialStatus: delegated.item.status,
				startTask: false,
			})
			// Deny the replayed approval so the test observes the replay without starting a child.
			const ask = answerAsks(task, { response: "noButtonClicked" })
			vi.spyOn(access(task), "initiateTaskLoop").mockResolvedValue(undefined)

			await access(task).resumeTaskFromHistory()

			expect(ask).toHaveBeenCalledExactlyOnceWith("tool", createAction.approvalText, false)
		})
	})
})
