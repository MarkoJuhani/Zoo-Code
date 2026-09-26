import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { EventEmitter } from "node:events"
import type { HistoryItem, PendingTaskAction } from "@roo-code/types"
import { RooCodeEventName } from "@roo-code/types"
import { Task } from "../core/task/Task"
import { ClineProvider } from "../core/webview/ClineProvider"
import { TaskHistoryStore } from "../core/task-persistence/TaskHistoryStore"
import { readTaskMessages, saveTaskMessages } from "../core/task-persistence/taskMessages"
import { readApiMessages, saveApiMessages } from "../core/task-persistence/apiMessages"
import { GlobalFileNames } from "../shared/globalFileNames"
import { makeProviderStub } from "./helpers/provider-stub"

vi.mock("../core/environment/getEnvironmentDetails", () => ({
	getEnvironmentDetails: vi.fn().mockResolvedValue("<environment_details>test</environment_details>"),
}))
vi.mock("../core/checkpoints", () => ({ getCheckpointService: vi.fn().mockResolvedValue(undefined) }))

const metadata = (id: string): HistoryItem => ({
	id,
	number: 1,
	ts: 1,
	task: id,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	status: "active",
})
const action: PendingTaskAction = {
	kind: "finish_subtask",
	actionId: "saved-finish",
	parentTaskId: "parent",
	approvalText: "Finish",
	result: "Approved durable result",
}

describe("delegation restart with real persistence and Task prototype loop", () => {
	let directory: string
	let store: TaskHistoryStore
	let provider: ClineProvider
	let current: Task | undefined
	let parent: Task
	let runs: Array<{ task: Task; run: () => Promise<void> }>
	const location = () => ({ taskId: "parent", globalStoragePath: directory })
	const file = (id: string, name: string) => path.join(directory, "tasks", id, name)
	const replay = (task: Task, pending: PendingTaskAction) =>
		(
			task as unknown as { resumePendingTaskAction(action: PendingTaskAction): Promise<void> }
		).resumePendingTaskAction(pending)
	const complete = () =>
		ClineProvider.prototype.reopenParentFromDelegation.call(provider, {
			parentTaskId: "parent",
			childTaskId: "child",
			pendingActionId: action.actionId,
			completionResultSummary: "Do not replace approved result",
		})

	function task(id: string): Task {
		const value = Object.create(Task.prototype) as Task
		EventEmitter.call(value)
		Object.assign(value, {
			taskId: id,
			instanceId: id + "-restarted",
			rootTaskId: "parent",
			taskNumber: 1,
			providerRef: { deref: () => provider },
			apiConfiguration: {},
			apiConversationHistory: [],
			clineMessages: [],
			userMessageContent: [],
			cloudSyncedMessageTimestamps: new Set(),
			abort: false,
			abandoned: false,
			ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
			say: vi.fn().mockResolvedValue(undefined),
			getTaskMode: vi.fn().mockResolvedValue("code"),
			getTaskApiConfigName: vi.fn().mockResolvedValue("test"),
			// Keep persistence real while avoiding constructor-owned UI/accounting dependencies.
			saveApiConversationHistory: async () => {
				await saveApiMessages({
					taskId: id,
					globalStoragePath: directory,
					messages: value.apiConversationHistory,
				})
				return true
			},
			saveClineMessages: async () => {
				await saveTaskMessages({ taskId: id, globalStoragePath: directory, messages: value.clineMessages })
				return true
			},
		})
		return value
	}

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "delegation-restart-"))
		store = new TaskHistoryStore(directory)
		await store.initialize()
		await store.upsert(metadata("parent"))
		await store.upsert({ ...metadata("child"), parentTaskId: "parent", pendingAction: action })
		await store.upsert({
			...metadata("parent"),
			status: "delegated",
			awaitingChildId: "child",
			delegatedToId: "child",
		})
		await saveTaskMessages({ ...location(), messages: [] })
		await saveApiMessages({ ...location(), messages: [] })
		runs = []
		provider = makeProviderStub({
			taskHistoryStore: store,
			contextProxy: { globalStorageUri: { fsPath: directory } },
			getCurrentTask: () => current,
			removeClineFromStack: vi.fn(async () => {
				current = undefined
			}),
			createTaskWithHistoryItem: vi.fn(async () => {
				parent = task("parent")
				current = parent
				return parent
			}),
			createTask: vi.fn(async () => {
				current = task("next-child")
				return current
			}),
			updateTaskHistory: (item: HistoryItem) => store.upsert(item),
			handleModeSwitch: vi.fn().mockResolvedValue(undefined),
			emit: vi.fn(),
			log: vi.fn(),
			getTaskWithId: vi.fn(() => {
				throw new Error("No legacy history fallback")
			}),
			taskScheduler: {
				schedule: vi.fn((scheduled: Task, run: () => Promise<void>) => {
					runs.push({ task: scheduled, run })
					return new Promise<void>(() => {})
				}),
			},
		})
		provider.reopenParentFromDelegation = (params) =>
			ClineProvider.prototype.reopenParentFromDelegation.call(provider, params)
		provider.markDelegatedChildProtocolBlocked = (params) =>
			ClineProvider.prototype.markDelegatedChildProtocolBlocked.call(provider, params)
		current = task("child")
	})
	afterEach(async () => {
		store.dispose()
		vi.restoreAllMocks()
		await fs.rm(directory, { recursive: true, force: true })
	})

	it.each(["ui absent", "ui corrupt", "api corrupt", "metadata absent", "metadata corrupt"])(
		"fails closed with real %s fixtures",
		async (failure) => {
			store.dispose() // Disable watcher invalidation: exercise genuinely stale cache.
			if (failure === "ui absent") await fs.unlink(file("parent", GlobalFileNames.uiMessages))
			if (failure === "ui corrupt") await fs.writeFile(file("parent", GlobalFileNames.uiMessages), "{")
			if (failure === "api corrupt")
				await fs.writeFile(file("parent", GlobalFileNames.apiConversationHistory), "{")
			if (failure === "metadata absent") await fs.unlink(file("child", GlobalFileNames.historyItem))
			if (failure === "metadata corrupt") await fs.writeFile(file("child", GlobalFileNames.historyItem), "{")
			const before = await fs.readFile(file("parent", GlobalFileNames.historyItem), "utf8")
			expect(await complete()).toMatchObject({
				kind: "recoverable_failure",
				phase: "precommit",
				reason:
					failure === "metadata absent"
						? "child_metadata_missing"
						: failure === "metadata corrupt"
							? "metadata_read_failed"
							: "history_read_failed",
			})
			expect(await fs.readFile(file("parent", GlobalFileNames.historyItem), "utf8")).toBe(before)
			expect(runs).toHaveLength(0)
			expect(provider.getTaskWithId).not.toHaveBeenCalled()
		},
	)

	it("allows absent API transcript (legacy empty-history semantics), not absent metadata", async () => {
		await fs.unlink(file("parent", GlobalFileNames.apiConversationHistory))
		expect(await readApiMessages(location())).toEqual([])
		expect(await complete()).toMatchObject({ kind: "committed" })
		expect((await readTaskMessages(location())).filter((message) => message.say === "subtask_result")).toHaveLength(
			1,
		)
	})

	it("restarts a blocked pending finish, commits once, runs the real resume loop and delegates next", async () => {
		await fs.writeFile(file("parent", GlobalFileNames.uiMessages), "{")
		await expect(replay(current!, action)).rejects.toThrow("history_read_failed")
		expect(store.get("child")).toMatchObject({ status: "blocked_protocol_error", pendingAction: action })
		expect(store.get("parent")?.status).toBe("blocked_protocol_error")
		expect(runs).toHaveLength(0)
		store.dispose()
		store = new TaskHistoryStore(directory)
		await store.initialize()
		Object.defineProperty(provider, "taskHistoryStore", { value: store, configurable: true })
		expect(store.get("child")).toMatchObject({ status: "blocked_protocol_error", pendingAction: action })
		await saveTaskMessages({ ...location(), messages: [] })
		current = task("child")
		await replay(current, store.get("child")!.pendingAction!)
		expect(store.get("child")).toMatchObject({ status: "completed" })
		expect(store.get("child")?.pendingAction).toBeUndefined()
		expect(store.get("parent")?.status).toBe("active")
		expect(runs).toHaveLength(1)
		expect(parent.runResumeLoop).toBe(Task.prototype.runResumeLoop)
		expect(parent.prepareAfterDelegation).toBe(Task.prototype.prepareAfterDelegation)
		const started = vi.fn()
		parent.on(RooCodeEventName.TaskStarted, started)
		// Mock the request/transport boundary, NOT runResumeLoop or initiateTaskLoop.
		// The actual loop must iterate twice before a real provider redelegation.
		const requests = vi
			.spyOn(parent, "recursivelyMakeClineRequests")
			.mockResolvedValueOnce(false)
			.mockImplementationOnce(async () => {
				const next = await ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
					parentTaskId: "parent",
					message: "Next work",
					initialTodos: [],
					mode: "code",
				})
				expect(next.taskId).toBe("next-child")
				return true
			})
		await runs[0].run()
		expect(started).toHaveBeenCalledOnce()
		expect(requests).toHaveBeenCalledTimes(2)
		expect(requests).toHaveBeenNthCalledWith(1, [], true)
		expect(requests.mock.calls[1][1]).toBe(false)
		expect(store.get("parent")).toMatchObject({ status: "delegated", awaitingChildId: "next-child" })
		expect(store.get("next-child")).toMatchObject({ status: "active", parentTaskId: "parent" })
		expect(current?.taskId).toBe("next-child")
		const ui = await readTaskMessages(location())
		const api = await readApiMessages(location())
		expect(ui.filter((message) => message.say === "subtask_result")).toHaveLength(1)
		expect(JSON.stringify(api)).toContain("Approved durable result")
		store.dispose()
		store = new TaskHistoryStore(directory)
		await store.initialize()
		Object.defineProperty(provider, "taskHistoryStore", { value: store, configurable: true })
		expect(await complete()).toMatchObject({ kind: "detached", reason: "historical_replay" })
		expect(await readTaskMessages(location())).toEqual(ui)
		expect(await readApiMessages(location())).toEqual(api)
		expect(requests).toHaveBeenCalledTimes(2)
		expect(runs.filter((entry) => entry.task.taskId === "parent")).toHaveLength(1)
	})
})
