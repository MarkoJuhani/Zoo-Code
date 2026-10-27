// npx vitest run __tests__/provider-delegation.spec.ts

import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { afterEach, beforeEach, describe, it, expect, vi, type Mock } from "vitest"
import type { HistoryItem } from "@roo-code/types"
import { providerIdentifiers, RooCodeEventName } from "@roo-code/types"
import { ClineProvider } from "../core/webview/ClineProvider"
import { TaskScheduler } from "../core/task/TaskScheduler"
import { TaskHistoryStore } from "../core/task-persistence/TaskHistoryStore"

let storageRoot: string
const disposableStores: TaskHistoryStore[] = []

beforeEach(async () => {
	storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "provider-delegation-fixture-"))
})

afterEach(async () => {
	for (const store of disposableStores.splice(0)) store.dispose()
	await fs.rm(storageRoot, { recursive: true, force: true })
})

const parentHistoryItem: HistoryItem = {
	id: "parent-1",
	task: "Parent",
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	childIds: [],
} as unknown as HistoryItem

/** Minimal taskHistoryStore stub whose atomicReadAndUpdate calls the updater with the parent item. */
function makeStoreStub(overrides: Partial<{ atomicReadAndUpdate: Mock; get: Mock }> = {}) {
	return {
		delete: vi.fn().mockResolvedValue(undefined),
		invalidate: vi.fn().mockResolvedValue(undefined),
		atomicReadAndUpdate: vi.fn(async (_taskId: string, updater: (h: HistoryItem) => HistoryItem) => {
			updater(parentHistoryItem)
			return []
		}),
		get: vi.fn((id: string) => (id === parentHistoryItem.id ? parentHistoryItem : undefined)),
		...overrides,
	}
}

/**
 * Parent task double with the methods delegateParentAndOpenChild reads from
 * `parent`. Without flushPendingToolResultsToHistory the method hits its
 * non-fatal flush-error branch and never reaches the happy delegation path.
 */
const makeParentTask = () =>
	({
		taskId: "parent-1",
		userMessageContent: [],
		dispose: vi.fn().mockResolvedValue(undefined),
		apiConfiguration: { apiProvider: providerIdentifiers.anthropic, anthropicApiKey: "task-local-key" },
		getTaskMode: vi.fn().mockResolvedValue("code"),
		getTaskApiConfigName: vi.fn().mockResolvedValue("task-local-profile"),
		emit: vi.fn(),
		flushPendingToolResultsToHistory: vi.fn().mockResolvedValue(true),
		retrySaveApiConversationHistory: vi.fn(),
	}) as any

type ProviderFixture = {
	[key: string]: unknown
	taskHistoryStore?: {
		get: (id: string) => HistoryItem | undefined
		atomicReadAndUpdate?: Mock
		readAuthoritative?: Mock
		upsert?: Mock
		delete?: Mock
	}
	updateTaskHistory?: Mock
	createTask?: Mock
}

async function prepareProvider(stub: ProviderFixture): Promise<ClineProvider> {
	const fixture = stub.taskHistoryStore
	if (!fixture) throw new Error("Delegation fixture requires a store scenario")
	const store = new TaskHistoryStore(storageRoot)
	disposableStores.push(store)
	await store.initialize()
	const parent = fixture.get("parent-1")
	if (parent && (await store.readAuthoritative(parent.id)).kind === "missing") await store.upsert(parent)
	if (parent?.awaitingChildId) {
		const child = fixture.get(parent.awaitingChildId)
		if (child && (await store.readAuthoritative(child.id)).kind === "missing") await store.upsert(child)
	}

	// Keep scenario gates/failures, but every successful mutation must still cross
	// the real store mutex, exclusion, file lock and final publication checks.
	const beforeCommit = fixture.atomicReadAndUpdate
	const beforeUpsert = fixture.upsert
	const beforeDelete = fixture.delete
	const atomicReadAndUpdate = store.atomicReadAndUpdate.bind(store)
	const upsert = store.upsert.bind(store)
	const deleteItem = store.delete.bind(store)
	Object.assign(fixture, {
		get: vi.spyOn(store, "get"),
		readAuthoritative: vi.spyOn(store, "readAuthoritative"),
		atomicReadAndUpdate: vi.spyOn(store, "atomicReadAndUpdate").mockImplementation(async (id, updater) => {
			// Scenario hooks may gate or fail before the actual mutation. Their return
			// value is never publication: the real updater must still validate disk.
			await beforeCommit?.(id, updater)
			return atomicReadAndUpdate(id, updater)
		}),
		upsert: vi.spyOn(store, "upsert").mockImplementation(async (item) => {
			await beforeUpsert?.(item)
			return upsert(item)
		}),
		delete: vi.spyOn(store, "delete").mockImplementation(async (id) => {
			await beforeDelete?.(id)
			return deleteItem(id)
		}),
	})
	Object.assign(stub, {
		taskHistoryStore: store,
		contextProxy: { globalStorageUri: { fsPath: storageRoot } },
	})
	stub.updateTaskHistory ??= vi.fn((item: HistoryItem) => store.upsert(item))

	if (stub.createTask) {
		const create = stub.createTask.getMockImplementation()
		stub.createTask.mockImplementation(async (...args: Parameters<ClineProvider["createTask"]>) => {
			const child = await create!(...args)
			child.getTaskMode ??= vi.fn().mockResolvedValue(args[3]?.handoffExecutionContext?.mode ?? "code")
			child.getTaskApiConfigName ??= vi.fn().mockResolvedValue("child-profile")
			child.taskNumber ??= 2
			child.cwd ??= "/workspace"
			child.rootTaskId ??= "parent-1"
			child.dispose ??= vi.fn().mockResolvedValue(undefined)
			child.runScheduled ??= vi.fn(() => child.run())
			return child
		})
	}
	if (vi.isMockFunction(stub.createTaskWithHistoryItem) && vi.isMockFunction(stub.getCurrentTask)) {
		const restore = stub.createTaskWithHistoryItem.getMockImplementation()
		const current = stub.getCurrentTask
		stub.createTaskWithHistoryItem.mockImplementation(
			async (item: HistoryItem, options: { startTask?: boolean }) => {
				const task = (await restore?.(item, options)) ?? makeParentTask()
				task.taskId ??= item.id
				task.emit ??= vi.fn()
				current.mockReturnValue(task)
				return task
			},
		)
	}
	// The fixture supplies only the provider members exercised by delegation.
	return stub as unknown as ClineProvider
}

type DelegationTransitionRunner = {
	runDelegationTransition: <T>(parentTaskId: string, fn: () => Promise<T>) => Promise<T>
}

const runDelegationTransition = (ClineProvider.prototype as unknown as DelegationTransitionRunner)
	.runDelegationTransition

describe("ClineProvider.delegateParentAndOpenChild()", () => {
	it("rejects an interrupted parent before disposing it or creating a child", async () => {
		const pendingAction = {
			kind: "create_subtask" as const,
			actionId: "create-action",
			approvalText: "{}",
			mode: "code",
			message: "Do something",
			todos: [],
		}
		const parentTask = makeParentTask()
		const removeClineFromStack = vi.fn()
		const createTask = vi.fn()
		const taskHistoryStore = makeStoreStub({
			get: vi.fn().mockReturnValue({ ...parentHistoryItem, status: "interrupted", pendingAction }),
		})
		const provider = await prepareProvider({
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack,
			createTask,
			taskHistoryStore,
		})

		await expect(
			ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
				parentTaskId: "parent-1",
				message: "Do something",
				initialTodos: [],
				mode: "code",
				pendingActionId: "create-action",
			}),
		).rejects.toThrow("is interrupted")
		expect(parentTask.flushPendingToolResultsToHistory).not.toHaveBeenCalled()
		expect(removeClineFromStack).not.toHaveBeenCalled()
		expect(createTask).not.toHaveBeenCalled()
		expect(taskHistoryStore.atomicReadAndUpdate).not.toHaveBeenCalled()
	})

	it.each(["completed", "blocked_protocol_error"] as const)(
		"rejects a %s parent before disposing it or writing an orphan child record",
		async (status) => {
			// The parent commit would refuse this status only after the durable child write.
			const pendingAction = {
				kind: "create_subtask" as const,
				actionId: "create-action",
				approvalText: "{}",
				mode: "code",
				message: "Do something",
				todos: [],
			}
			const parentTask = makeParentTask()
			const removeClineFromStack = vi.fn()
			const createTask = vi.fn()
			const taskHistoryStore = makeStoreStub({
				get: vi.fn().mockReturnValue({ ...parentHistoryItem, status, pendingAction }),
			})
			const provider = await prepareProvider({
				getCurrentTask: vi.fn(() => parentTask),
				removeClineFromStack,
				createTask,
				taskHistoryStore,
			})

			await expect(
				ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
					parentTaskId: "parent-1",
					message: "Do something",
					initialTodos: [],
					mode: "code",
					pendingActionId: "create-action",
				}),
			).rejects.toThrow(`is ${status}; refusing to delegate before any write`)
			expect(parentTask.flushPendingToolResultsToHistory).not.toHaveBeenCalled()
			expect(removeClineFromStack).not.toHaveBeenCalled()
			expect(createTask).not.toHaveBeenCalled()
			const store = provider.taskHistoryStore as TaskHistoryStore
			// prepareProvider spies on the real store, so upsert is a mock here.
			expect(store.upsert).not.toHaveBeenCalled()
			expect(taskHistoryStore.atomicReadAndUpdate).not.toHaveBeenCalled()
			expect(store.getAll().map((item) => item.id)).toEqual(["parent-1"])
		},
	)

	it("rejects a stale restored action before delegation side effects", async () => {
		const parentTask = makeParentTask()
		const removeClineFromStack = vi.fn()
		const createTask = vi.fn()
		const handleModeSwitch = vi.fn()
		const taskHistoryStore = makeStoreStub({
			get: vi.fn().mockReturnValue({
				...parentHistoryItem,
				pendingAction: {
					kind: "create_subtask",
					actionId: "current-action",
					approvalText: "{}",
					mode: "code",
					message: "Do something",
					todos: [],
				},
			}),
		})
		const provider = await prepareProvider({
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack,
			createTask,
			handleModeSwitch,
			taskHistoryStore,
		})

		await expect(
			ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
				parentTaskId: "parent-1",
				message: "Do something",
				initialTodos: [],
				mode: "code",
				pendingActionId: "stale-action",
			}),
		).rejects.toThrow("Pending action mismatch")

		expect(parentTask.flushPendingToolResultsToHistory).not.toHaveBeenCalled()
		expect(removeClineFromStack).not.toHaveBeenCalled()
		expect(handleModeSwitch).not.toHaveBeenCalled()
		expect(createTask).not.toHaveBeenCalled()
		expect(taskHistoryStore.atomicReadAndUpdate).not.toHaveBeenCalled()
	})

	it("clears a matching pending action when delegation commits", async () => {
		const pendingAction = {
			kind: "create_subtask" as const,
			actionId: "create-action",
			approvalText: "{}",
			mode: "code",
			message: "Do something",
			todos: [],
		}
		let current: HistoryItem = { ...parentHistoryItem, status: "active", pendingAction }
		const taskHistoryStore = {
			invalidate: vi.fn().mockResolvedValue(undefined),
			get: vi.fn(() => current),
			atomicReadAndUpdate: vi.fn(async (_taskId: string, updater: (item: HistoryItem) => HistoryItem) => {
				current = updater(current)
				return [current]
			}),
		}
		const parentTask = makeParentTask()
		const child = { taskId: "child-1", run: vi.fn().mockResolvedValue(undefined) }
		const provider = await prepareProvider({
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask: vi.fn().mockResolvedValue(child),
			handleModeSwitch: vi.fn().mockResolvedValue(undefined),
			log: vi.fn(),
			isViewLaunched: false,
			taskHistoryStore,
		})

		await ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "Do something",
			initialTodos: [],
			mode: "code",
			pendingActionId: "create-action",
		})

		expect(current.pendingAction).toBeUndefined()
		expect(current).toMatchObject({ status: "delegated", awaitingChildId: "child-1" })
	})

	it("rolls back when pending-action ownership changes before the atomic parent update", async () => {
		const pendingAction = {
			kind: "create_subtask" as const,
			actionId: "create-action",
			approvalText: "{}",
			mode: "code",
			message: "Do something",
			todos: [],
		}
		const parentTask = makeParentTask()
		const child = { taskId: "child-1", run: vi.fn().mockResolvedValue(undefined) }
		const getCurrentTask = vi.fn(() => parentTask)
		const createTask = vi.fn(async () => {
			getCurrentTask.mockReturnValue(child)
			return child
		})
		const replacementAction = { ...pendingAction, actionId: "replacement-action" }
		const taskHistoryStore = makeStoreStub({
			get: vi.fn().mockReturnValue({ ...parentHistoryItem, status: "active", pendingAction }),
			atomicReadAndUpdate: vi.fn(async (_taskId: string, updater: (item: HistoryItem) => HistoryItem) => {
				updater({ ...parentHistoryItem, status: "active", pendingAction: replacementAction })
				return []
			}),
		})
		const deleteTaskWithId = vi.fn().mockResolvedValue(undefined)
		const createTaskWithHistoryItem = vi.fn().mockResolvedValue(undefined)
		const provider = await prepareProvider({
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask,
			removeClineFromStack: vi.fn(async () => {
				getCurrentTask.mockReturnValue(undefined)
			}),
			createTask,
			handleModeSwitch: vi.fn().mockResolvedValue(undefined),
			deleteTaskWithId,
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: parentHistoryItem }),
			createTaskWithHistoryItem,
			log: vi.fn(),
			isViewLaunched: false,
			taskHistoryStore,
		})

		await expect(
			ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
				parentTaskId: "parent-1",
				message: "Do something",
				initialTodos: [],
				mode: "code",
				pendingActionId: "create-action",
			}),
		).rejects.toMatchObject({
			name: "DelegationRecoverableError",
			originalError: expect.objectContaining({
				message: expect.stringContaining("Pending action, owner, revision or question changed before commit"),
			}),
		})

		expect(child.run).not.toHaveBeenCalled()
		expect(taskHistoryStore.delete).not.toHaveBeenCalled()
		expect(await provider.taskHistoryStore.readAuthoritative("child-1")).toMatchObject({
			kind: "found",
			item: { id: "child-1", parentTaskId: "parent-1", status: "active" },
		})
		expect(createTaskWithHistoryItem).toHaveBeenCalledWith(expect.objectContaining({ id: "parent-1" }), {
			startTask: false,
		})
	})

	it("persists parent delegation metadata via atomicReadAndUpdate and emits TaskDelegated", async () => {
		const providerEmit = vi.fn()
		const parentTask = makeParentTask()

		const childRun = vi.fn().mockResolvedValue(undefined)
		const removeClineFromStack = vi.fn().mockResolvedValue(undefined)
		const createTask = vi.fn().mockResolvedValue({ taskId: "child-1", start: vi.fn(), run: childRun })
		const handleModeSwitch = vi.fn().mockResolvedValue(undefined)
		const taskHistoryStore = makeStoreStub()

		const provider = await prepareProvider({
			taskScheduler: new TaskScheduler(),
			emit: providerEmit,
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack,
			createTask,
			handleModeSwitch,
			log: vi.fn(),
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore,
		})

		const child = await (ClineProvider.prototype as any).delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "Do something",
			initialTodos: [],
			mode: "code",
		})
		await Promise.resolve() // drain scheduler microtask so child.run() is invoked

		expect(child.taskId).toBe("child-1")

		// Invariant: parent closed before child creation
		expect(removeClineFromStack).toHaveBeenCalledTimes(1)

		// Child task created with startTask: false and initialStatus: "active"
		expect(createTask).toHaveBeenCalledWith("Do something", undefined, parentTask, {
			handoffExecutionContext: {
				apiConfigName: "task-local-profile",
				apiConfiguration: {
					apiProvider: providerIdentifiers.anthropic,
					anthropicApiKey: "task-local-key",
				},
				mode: "code",
			},
			initialTodos: [],
			initialStatus: "active",
			startTask: false,
		})

		// Delegation metadata written via atomicReadAndUpdate with correct taskId
		expect(taskHistoryStore.atomicReadAndUpdate).toHaveBeenCalledTimes(1)
		const [calledTaskId, updater] = taskHistoryStore.atomicReadAndUpdate.mock.calls[0]
		expect(calledTaskId).toBe("parent-1")

		// The updater must produce the correct delegation fields
		const result = updater(parentHistoryItem)
		expect(result).toMatchObject({
			id: "parent-1",
			status: "delegated",
			delegatedToId: "child-1",
			awaitingChildId: "child-1",
			childIds: expect.arrayContaining(["child-1"]),
		})

		// child.run() called AFTER parent metadata is persisted (via taskScheduler)
		expect(childRun).toHaveBeenCalledTimes(1)

		// Provider-level event
		expect(providerEmit).toHaveBeenCalledWith(RooCodeEventName.TaskDelegated, "parent-1", "child-1", 1)

		expect(handleModeSwitch).toHaveBeenCalledWith("code")
	})

	it("uses an explicitly saved different-mode profile without reading shared current identity", async () => {
		const parentTask = makeParentTask()
		const child = { taskId: "child-ask", run: vi.fn().mockResolvedValue(undefined) }
		const createTask = vi.fn().mockResolvedValue(child)
		const providerSettingsManager = {
			getModeConfigId: vi.fn().mockResolvedValue("ask-profile-id"),
			getProfile: vi.fn().mockResolvedValue({
				name: "ask-profile",
				id: "ask-profile-id",
				apiProvider: providerIdentifiers.openrouter,
				openRouterModelId: "openai/gpt-4.1-mini",
			}),
			getCurrentProfileName: vi.fn(),
		}
		const workspaceGet = vi.fn().mockReturnValue(false)
		const provider = await prepareProvider({
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask,
			log: vi.fn(),
			isViewLaunched: false,
			taskHistoryStore: makeStoreStub(),
			providerSettingsManager,
			context: { workspaceState: { get: workspaceGet } },
		})

		await ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "Ask child",
			initialTodos: [],
			mode: "ask",
		})

		expect(providerSettingsManager.getModeConfigId).toHaveBeenCalledWith("ask")
		expect(workspaceGet).toHaveBeenCalledWith("lockApiConfigAcrossModes", false)
		expect(providerSettingsManager.getProfile).toHaveBeenCalledWith({ id: "ask-profile-id" })
		expect(providerSettingsManager.getCurrentProfileName).not.toHaveBeenCalled()
		expect(createTask).toHaveBeenCalledWith(
			"Ask child",
			undefined,
			parentTask,
			expect.objectContaining({
				handoffExecutionContext: {
					mode: "ask",
					apiConfigName: "ask-profile",
					apiConfiguration: {
						apiProvider: providerIdentifiers.openrouter,
						openRouterModelId: "openai/gpt-4.1-mini",
					},
				},
			}),
		)
	})

	it.each([
		{ name: "has no saved mode profile", savedConfigId: undefined, savedProfile: undefined },
		{
			name: "has an unconfigured saved mode profile",
			savedConfigId: "empty-id",
			savedProfile: { name: "empty", id: "empty-id" },
		},
		{
			name: "has a stale saved mode profile",
			savedConfigId: "stale-id",
			savedProfile: new Error("profile not found"),
		},
	])("keeps the parent task-local profile when a different mode $name", async ({ savedConfigId, savedProfile }) => {
		const parentTask = makeParentTask()
		const child = { taskId: "child-fallback", run: vi.fn().mockResolvedValue(undefined) }
		const createTask = vi.fn().mockResolvedValue(child)
		const getProfile =
			savedProfile instanceof Error
				? vi.fn().mockRejectedValue(savedProfile)
				: vi.fn().mockResolvedValue(savedProfile)
		const log = vi.fn()
		const provider = await prepareProvider({
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask,
			log,
			isViewLaunched: false,
			taskHistoryStore: makeStoreStub(),
			providerSettingsManager: {
				getModeConfigId: vi.fn().mockResolvedValue(savedConfigId),
				getProfile,
			},
			context: { workspaceState: { get: vi.fn().mockReturnValue(false) } },
		})

		await ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "Fallback child",
			initialTodos: [],
			mode: "ask",
		})

		if (savedConfigId) expect(getProfile).toHaveBeenCalledWith({ id: savedConfigId })
		else expect(getProfile).not.toHaveBeenCalled()
		if (savedProfile instanceof Error) {
			expect(
				log.mock.calls.some(
					([message]) =>
						message.startsWith("[ordinary_delegation] ") &&
						JSON.parse(message.slice("[ordinary_delegation] ".length)).task === "parent-1" &&
						JSON.parse(message.slice("[ordinary_delegation] ".length)).phase === "child_prepare" &&
						JSON.parse(message.slice("[ordinary_delegation] ".length)).stage === "failure",
				),
			).toBe(true)
		}
		expect(createTask).toHaveBeenCalledWith(
			"Fallback child",
			undefined,
			parentTask,
			expect.objectContaining({
				handoffExecutionContext: {
					mode: "ask",
					apiConfigName: "task-local-profile",
					apiConfiguration: {
						apiProvider: providerIdentifiers.anthropic,
						anthropicApiKey: "task-local-key",
					},
				},
			}),
		)
	})

	it("posts taskHistoryItemUpdated to the webview when isViewLaunched is true", async () => {
		const updatedParent = { ...parentHistoryItem, status: "delegated" } as HistoryItem
		const postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		const parentTask = makeParentTask()
		const taskHistoryStore = makeStoreStub({
			get: vi.fn().mockReturnValueOnce(parentHistoryItem).mockReturnValue(updatedParent),
		})

		const notificationGet = taskHistoryStore.get
		const provider = await prepareProvider({
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask: vi.fn().mockResolvedValue({ taskId: "child-1", start: vi.fn(), run: () => Promise.resolve() }),
			handleModeSwitch: vi.fn().mockResolvedValue(undefined),
			postMessageToWebview,
			log: vi.fn(),
			isViewLaunched: true,
			recentTasksCache: undefined,
			taskHistoryStore,
		})

		// Deliberately stale/missing UI cache; authoritative reads still use real disk.
		vi.mocked(provider["taskHistoryStore"].get).mockImplementation(notificationGet)

		await (ClineProvider.prototype as any).delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "Do something",
			initialTodos: [],
			mode: "code",
		})

		expect(postMessageToWebview).toHaveBeenCalledWith({
			type: "taskHistoryItemUpdated",
			taskHistoryItem: updatedParent,
		})
	})

	it("skips postMessageToWebview when isViewLaunched is true but store returns undefined", async () => {
		const postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		const parentTask = makeParentTask()
		const taskHistoryStore = makeStoreStub({
			get: vi.fn().mockReturnValueOnce(parentHistoryItem).mockReturnValue(undefined),
		})

		const notificationGet = taskHistoryStore.get
		const provider = await prepareProvider({
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask: vi.fn().mockResolvedValue({ taskId: "child-1", start: vi.fn(), run: () => Promise.resolve() }),
			handleModeSwitch: vi.fn().mockResolvedValue(undefined),
			postMessageToWebview,
			log: vi.fn(),
			isViewLaunched: true,
			recentTasksCache: undefined,
			taskHistoryStore,
		})

		// Deliberately stale/missing UI cache; authoritative reads still use real disk.
		vi.mocked(provider["taskHistoryStore"].get).mockImplementation(notificationGet)

		await (ClineProvider.prototype as any).delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "Do something",
			initialTodos: [],
			mode: "code",
		})

		expect(postMessageToWebview).not.toHaveBeenCalled()
	})

	it("calls child.run() only after atomicReadAndUpdate completes (no race condition)", async () => {
		const callOrder: string[] = []

		const parentTask = makeParentTask()
		const childRun = vi.fn(async () => callOrder.push("child.run"))
		const removeClineFromStack = vi.fn().mockResolvedValue(undefined)
		const createTask = vi.fn(async () => {
			callOrder.push("createTask")
			return { taskId: "child-1", start: vi.fn(), run: childRun }
		})
		const handleModeSwitch = vi.fn().mockResolvedValue(undefined)
		const taskHistoryStore = makeStoreStub({
			atomicReadAndUpdate: vi.fn(async (_taskId: string, _updater: (h: HistoryItem) => HistoryItem) => {
				callOrder.push("atomicReadAndUpdate")
				return []
			}),
		})

		const provider = await prepareProvider({
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack,
			createTask,
			handleModeSwitch,
			log: vi.fn(),
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore,
		})

		await (ClineProvider.prototype as any).delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "Do something",
			initialTodos: [],
			mode: "code",
		})
		await Promise.resolve() // drain scheduler microtask so child.run() is invoked

		// createTask → atomicReadAndUpdate → child.run: scheduler admits child only after metadata is persisted
		expect(callOrder).toEqual(["createTask", "atomicReadAndUpdate", "child.run"])
	})

	it("implicitly severs interrupted awaited child and re-delegates when parent is already delegated", async () => {
		const oldChildId = "old-child"
		const oldChild = { id: oldChildId, status: "interrupted" } as unknown as HistoryItem
		const alreadyDelegatedParent: HistoryItem = {
			...parentHistoryItem,
			status: "delegated",
			awaitingChildId: oldChildId,
			delegatedToId: oldChildId,
			childIds: [oldChildId],
		} as unknown as HistoryItem

		const taskHistoryStore = makeStoreStub({
			// store returns: parent (delegated), old child (interrupted)
			get: vi.fn((id: string) =>
				id === "parent-1" ? alreadyDelegatedParent : id === oldChildId ? oldChild : undefined,
			),
			atomicReadAndUpdate: vi.fn(async (_taskId: string, updater: (h: HistoryItem) => HistoryItem) => {
				updater(alreadyDelegatedParent)
				return []
			}),
		})

		const provider = await prepareProvider({
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask: vi.fn(() => makeParentTask()),
			removeClineFromStack: vi.fn().mockResolvedValue(undefined),
			createTask: vi.fn().mockResolvedValue({ taskId: "child-2", start: vi.fn(), run: () => Promise.resolve() }),
			handleModeSwitch: vi.fn().mockResolvedValue(undefined),
			log: vi.fn(),
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore,
		})

		await (ClineProvider.prototype as any).delegateParentAndOpenChild.call(provider, {
			parentTaskId: "parent-1",
			message: "Continue",
			initialTodos: [],
			mode: "code",
		})

		// The updater must sever the old link and apply the new delegation
		const [, updater] = taskHistoryStore.atomicReadAndUpdate.mock.calls[0]
		const result = updater(alreadyDelegatedParent)
		expect(result).toMatchObject({
			status: "delegated",
			awaitingChildId: "child-2",
			delegatedToId: "child-2",
		})
		// Old child ID preserved in childIds (audit trail)
		expect(result.childIds).toContain(oldChildId)
		expect(result.childIds).toContain("child-2")
	})

	it("rejects with 'Cannot re-delegate' when the existing awaited child is still active", async () => {
		const oldChildId = "old-child"
		const activeChild = { id: oldChildId, status: "active" } as unknown as HistoryItem
		const alreadyDelegatedParent: HistoryItem = {
			...parentHistoryItem,
			status: "delegated",
			awaitingChildId: oldChildId,
			delegatedToId: oldChildId,
		} as unknown as HistoryItem

		const child = { taskId: "child-2", start: vi.fn(), run: vi.fn().mockResolvedValue(undefined) }
		const getCurrentTask = vi.fn().mockReturnValue(makeParentTask())
		const createTask = vi.fn().mockImplementation(async () => {
			getCurrentTask.mockReturnValue(child)
			return child
		})

		const taskHistoryStore = makeStoreStub({
			get: vi.fn((id: string) =>
				id === "parent-1" ? alreadyDelegatedParent : id === oldChildId ? activeChild : undefined,
			),
			// Real atomicReadAndUpdate behaviour: call the updater and propagate any throw
			atomicReadAndUpdate: vi.fn(async (_taskId: string, updater: (h: HistoryItem) => HistoryItem) => {
				updater(alreadyDelegatedParent)
				return []
			}),
		})

		const provider = await prepareProvider({
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask,
			removeClineFromStack: vi.fn(async () => {
				getCurrentTask.mockReturnValue(undefined)
			}),
			createTask,
			handleModeSwitch: vi.fn().mockResolvedValue(undefined),
			deleteTaskWithId: vi.fn().mockResolvedValue(undefined),
			getTaskWithId: vi.fn().mockResolvedValue({ historyItem: alreadyDelegatedParent }),
			createTaskWithHistoryItem: vi.fn().mockResolvedValue(undefined),
			log: vi.fn(),
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore,
		})

		await expect(
			(ClineProvider.prototype as any).delegateParentAndOpenChild.call(provider, {
				parentTaskId: "parent-1",
				message: "Continue",
				initialTodos: [],
				mode: "code",
			}),
		).rejects.toThrow("Cannot re-delegate while the awaited child is not interrupted")

		// The authoritative preflight rejects before either provider mutates its stack.
		expect(child.run).not.toHaveBeenCalled()
		expect(createTask).not.toHaveBeenCalled()
		expect((provider as any).deleteTaskWithId).not.toHaveBeenCalled()
	})

	it("rejects a delegated parent whose awaited-child identity is missing", async () => {
		const parentTask = makeParentTask()
		const taskHistoryStore = makeStoreStub({
			get: vi.fn().mockReturnValue({ ...parentHistoryItem, status: "delegated" }),
		})
		const provider = await prepareProvider({
			getCurrentTask: vi.fn(() => parentTask),
			removeClineFromStack: vi.fn(),
			createTask: vi.fn(),
			taskHistoryStore,
		})

		await expect(
			ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
				parentTaskId: "parent-1",
				message: "Continue",
				initialTodos: [],
				mode: "code",
			}),
		).rejects.toThrow("Cannot re-delegate a parent with no awaited child")
		expect(provider.removeClineFromStack).not.toHaveBeenCalled()
	})

	it("serializes same-parent delegation across provider instances and starts only one child", async () => {
		let durableParent = { ...parentHistoryItem, status: "active" as const }
		let releaseCommit!: () => void
		let markCommitStarted!: () => void
		const commitStarted = new Promise<void>((resolve) => {
			markCommitStarted = resolve
		})
		const commitMayFinish = new Promise<void>((resolve) => {
			releaseCommit = resolve
		})

		const makeProvider = async (childId: string) => {
			const parent = makeParentTask()
			const child = { taskId: childId, run: vi.fn().mockResolvedValue(undefined) }
			const removeClineFromStack = vi.fn().mockResolvedValue(undefined)
			const store = {
				invalidate: vi.fn().mockResolvedValue(undefined),
				get: vi.fn((id: string) => (id === parent.taskId ? durableParent : undefined)),
				atomicReadAndUpdate: vi.fn(async (_id: string, updater: (item: HistoryItem) => HistoryItem) => {
					markCommitStarted()
					await commitMayFinish
					durableParent = updater(durableParent) as typeof durableParent
					return [durableParent]
				}),
			}
			const provider = await prepareProvider({
				taskScheduler: new TaskScheduler(),
				emit: vi.fn(),
				getCurrentTask: vi.fn(() => parent),
				runDelegationTransition,
				removeClineFromStack,
				createTask: vi.fn().mockResolvedValue(child),
				log: vi.fn(),
				isViewLaunched: false,
				taskHistoryStore: store,
			})
			return { provider, child, removeClineFromStack }
		}

		const first = await makeProvider("child-1")
		const second = await makeProvider("child-2")
		const firstDelegation = ClineProvider.prototype.delegateParentAndOpenChild.call(first.provider, {
			parentTaskId: "parent-1",
			message: "First",
			initialTodos: [],
			mode: "code",
		})
		await commitStarted
		const secondDelegation = ClineProvider.prototype.delegateParentAndOpenChild.call(second.provider, {
			parentTaskId: "parent-1",
			message: "Second",
			initialTodos: [],
			mode: "ask",
		})

		expect(second.removeClineFromStack).not.toHaveBeenCalled()
		releaseCommit()
		await expect(firstDelegation).resolves.toBe(first.child)
		await expect(secondDelegation).rejects.toThrow("Cannot re-delegate")
		await Promise.resolve()

		expect(first.child.run).toHaveBeenCalledOnce()
		expect(second.child.run).not.toHaveBeenCalled()
		expect(durableParent.awaitingChildId).toBe("child-1")
	})

	it("disposes the paused child, retains its durable evidence and restores the stopped parent after commit failure", async () => {
		const persistError = new Error("parent metadata persist failed")
		const parentTask = makeParentTask()
		const childRun = vi.fn().mockResolvedValue(undefined)
		const removeClineFromStack = vi.fn().mockResolvedValue(undefined)
		const deleteTaskWithId = vi.fn().mockResolvedValue(undefined)
		const createTaskWithHistoryItem = vi.fn().mockResolvedValue(undefined)
		const getTaskWithId = vi.fn().mockResolvedValue({ historyItem: parentHistoryItem })

		const taskHistoryStore = makeStoreStub({
			atomicReadAndUpdate: vi.fn().mockRejectedValue(persistError),
		})

		const child = { taskId: "child-1", start: vi.fn(), run: childRun }
		// Before createTask: getCurrentTask returns parent (used by step 3 close).
		// After createTask: returns child so the rollback guard passes and the child is popped.
		const getCurrentTask = vi.fn().mockReturnValue(parentTask)
		removeClineFromStack.mockImplementation(async () => {
			getCurrentTask.mockReturnValue(undefined)
		})
		const createTask = vi.fn().mockImplementation(async () => {
			getCurrentTask.mockReturnValue(child)
			return child
		})

		const provider = await prepareProvider({
			taskScheduler: new TaskScheduler(),
			emit: vi.fn(),
			getCurrentTask,
			removeClineFromStack,
			createTask,
			getTaskWithId,
			handleModeSwitch: vi.fn().mockResolvedValue(undefined),
			deleteTaskWithId,
			createTaskWithHistoryItem,
			log: vi.fn(),
			isViewLaunched: false,
			recentTasksCache: undefined,
			taskHistoryStore,
		})

		await expect(
			(ClineProvider.prototype as any).delegateParentAndOpenChild.call(provider, {
				parentTaskId: "parent-1",
				message: "Do something",
				initialTodos: [],
				mode: "code",
			}),
		).rejects.toMatchObject({
			name: "DelegationRecoverableError",
			originalError: persistError,
			disposition: "parent_restored",
		})

		expect(childRun).not.toHaveBeenCalled()
		expect(removeClineFromStack).toHaveBeenNthCalledWith(1, "delegation_disposal")
		expect(removeClineFromStack).toHaveBeenNthCalledWith(2, "delegation_disposal")
		expect(taskHistoryStore.delete).not.toHaveBeenCalled()
		expect(await provider.taskHistoryStore.readAuthoritative("child-1")).toMatchObject({
			kind: "found",
			item: { id: "child-1", parentTaskId: "parent-1", status: "active" },
		})
		expect(createTaskWithHistoryItem).toHaveBeenCalledWith(expect.objectContaining({ id: "parent-1" }), {
			startTask: false,
		})
	})
})

describe("Provider initial-child durability regressions", () => {
	async function setup() {
		const parent = { ...parentHistoryItem, number: 1, ts: 1, status: "active" as const }
		const items = new Map<string, HistoryItem>([[parent.id, parent]])
		const order: string[] = []
		let current: { taskId: string } | undefined = makeParentTask()
		const child = {
			taskId: "paused-child",
			taskNumber: 2,
			rootTaskId: parent.id,
			cwd: "/workspace",
			getTaskMode: vi.fn().mockResolvedValue("code"),
			getTaskApiConfigName: vi.fn().mockResolvedValue("child-profile"),
			dispose: vi.fn(async () => {
				order.push("dispose")
			}),
			run: vi.fn(async () => {
				order.push("run")
				expect(items.get(parent.id)?.awaitingChildId).toBe("paused-child")
			}),
		}
		const store = {
			get: vi.fn((id: string) => items.get(id)),
			readAuthoritative: vi.fn(async (id: string) => {
				const item = items.get(id)
				return item ? { kind: "found", item } : { kind: "missing" }
			}),
			upsert: vi.fn(async (item: HistoryItem) => {
				order.push("child metadata")
				items.set(item.id, item)
				return [...items.values()]
			}),
			delete: vi.fn(async (id: string) => {
				order.push("delete")
				items.delete(id)
			}),
			atomicReadAndUpdate: vi.fn(async (id: string, update: (item: HistoryItem) => HistoryItem) => {
				expect(items.get(child.taskId)).toMatchObject({
					id: child.taskId,
					number: 2,
					parentTaskId: parent.id,
					rootTaskId: parent.id,
					task: "Work",
					workspace: "/workspace",
					mode: "code",
					apiConfigName: "child-profile",
					status: "active",
				})
				order.push("parent commit")
				items.set(id, update(items.get(id)!))
				return [...items.values()]
			}),
		}
		const provider = await prepareProvider({
			taskHistoryStore: store,
			getCurrentTask: vi.fn(() => current),
			removeClineFromStack: vi.fn(async () => {
				current = undefined
			}),
			createTask: vi.fn(async () => {
				current = child
				return child
			}),
			createTaskWithHistoryItem: vi.fn(async () => {
				current = makeParentTask()
				return current
			}),
			handleModeSwitch: vi.fn(),
			log: vi.fn(),
			emit: vi.fn(),
			isViewLaunched: true,
			postMessageToWebview: vi.fn(),
			taskScheduler: new TaskScheduler(),
		})
		const delegate = () =>
			ClineProvider.prototype.delegateParentAndOpenChild.call(provider, {
				parentTaskId: parent.id,
				message: "Work",
				mode: "code",
				initialTodos: [],
			})
		return { provider, parent, child, store, items, order, delegate }
	}

	it("persists complete initial child metadata before parent commit and child scheduling", async () => {
		const f = await setup()
		expect(await f.delegate()).toBe(f.child)
		await vi.waitFor(() => expect(f.child.run).toHaveBeenCalledOnce())
		expect(f.order).toEqual(["child metadata", "parent commit", "run"])
	})

	it.each(["child metadata", "parent commit"])(
		"restores parent after %s failure, drains disposal and retains durable child evidence",
		async (phase) => {
			const f = await setup()
			const failure = new Error(phase)
			if (phase === "child metadata") f.store.upsert.mockRejectedValueOnce(failure)
			else f.store.atomicReadAndUpdate.mockRejectedValueOnce(failure)
			await expect(f.delegate()).rejects.toMatchObject({
				name: "DelegationRecoverableError",
				originalError: failure,
				disposition: "parent_restored",
			})
			expect(f.order.at(-1)).toBe("dispose")
			expect(f.store.delete).not.toHaveBeenCalled()
			const retained = await f.provider.taskHistoryStore.readAuthoritative(f.child.taskId)
			expect(retained.kind).toBe(phase === "parent commit" ? "found" : "missing")
			if (retained.kind === "found")
				expect(retained.item).toMatchObject({ id: f.child.taskId, status: "active", parentTaskId: f.parent.id })
			expect(f.items.has(f.child.taskId)).toBe(phase === "parent commit")
			expect(f.items.get(f.parent.id)?.status).toBe("active")
			expect(f.provider.createTaskWithHistoryItem).toHaveBeenCalledWith(f.parent, { startTask: false })
			expect(f.child.run).not.toHaveBeenCalled()
		},
	)

	it("does not roll back committed delegation when its webview notification rejects", async () => {
		const f = await setup()
		vi.mocked(f.provider.postMessageToWebview).mockRejectedValue(new Error("webview closed"))
		expect(await f.delegate()).toBe(f.child)
		expect(f.store.delete).not.toHaveBeenCalled()
		expect(f.items.get(f.parent.id)?.awaitingChildId).toBe(f.child.taskId)
	})
})
