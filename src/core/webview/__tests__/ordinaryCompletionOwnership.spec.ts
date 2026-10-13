import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { RooCodeEventName, type HistoryItem } from "@roo-code/types"
import type { TaskHistoryStore } from "../../task-persistence/TaskHistoryStore"
import type { Task } from "../../task/Task"
import type { ClineProvider } from "../ClineProvider"

vi.mock("../../ignore/RooIgnoreController", () => ({
	RooIgnoreController: class {
		initialize = async () => {}
		dispose = () => {}
	},
}))
vi.mock("../../protect/RooProtectedController", () => ({ RooProtectedController: class {} }))
vi.mock("../../context-tracking/FileContextTracker", () => ({ FileContextTracker: class {} }))
vi.mock("../../../api", () => ({ buildApiHandler: vi.fn(() => ({})) }))

const effects = vi.hoisted(() => ({
	readFile: "",
	renameFile: "",
	failFile: "",
	entered: () => {},
	release: Promise.resolve(),
}))
vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	return {
		...actual,
		readFile: async (...args: Parameters<typeof actual.readFile>) => {
			const result = await actual.readFile(...args)
			if (String(args[0]) === effects.readFile) {
				effects.readFile = ""
				effects.entered()
				await effects.release
			}
			return result
		},
		rename: async (...args: Parameters<typeof actual.rename>) => {
			if (String(args[1]) === effects.failFile) {
				effects.failFile = ""
				throw Object.assign(new Error("injected parent publication failure"), { code: "EIO" })
			}
			await actual.rename(...args)
			if (String(args[1]) === effects.renameFile) {
				effects.renameFile = ""
				effects.entered()
				await effects.release
			}
		},
	}
})

const record = (id: string, changes: Partial<HistoryItem> = {}): HistoryItem => ({
	id,
	number: 1,
	ts: 1,
	task: id,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	status: "active",
	mode: "code",
	apiConfigName: "offline",
	childIds: [],
	...changes,
})
const completion = {
	parentTaskId: "parent",
	childTaskId: "old-child",
	completionResultSummary: "caller summary is not the saved finish result",
	pendingActionId: "finish-old",
}
let root: string
const hosts: { store: TaskHistoryStore }[] = []
const tasks: Task[] = []
const pending: Promise<unknown>[] = []
let openGate = () => {}

function gate(kind: "readFile" | "renameFile", file: string) {
	let signalEntered!: () => void
	let release!: () => void
	const entered = new Promise<void>((resolve) => {
		signalEntered = resolve
	})
	effects[kind] = file
	effects.entered = signalEntered
	effects.release = new Promise<void>((resolve) => {
		release = resolve
	})
	openGate = release
	return entered
}
function track<T>(promise: Promise<T>): Promise<T> {
	pending.push(promise)
	// Observe immediately, including when an assertion fails before awaiting it.
	void promise.catch(() => {})
	return promise
}
const file = (id: string, name: string) => path.join(root, "tasks", id, name)
async function snapshot() {
	const result = new Map<string, string>()
	for (const id of ["parent", "old-child", "new-child"])
		for (const name of ["history_item.json", "ui_messages.json", "api_conversation_history.json"]) {
			try {
				result.set(`${id}/${name}`, await fs.readFile(file(id, name), "utf8"))
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			}
		}
	return result
}

async function host() {
	// Separate module registries represent separate host-local transition maps and
	// async contexts; no production serialization or filesystem ownership is mocked.
	vi.resetModules()
	const { ClineProvider: Provider } = await import("../ClineProvider")
	const { Task: RuntimeTask } = await import("../../task/Task")
	const { TaskHistoryStore } = await import("../../task-persistence/TaskHistoryStore")
	const { TelemetryService } = await import("@roo-code/telemetry")
	if (!TelemetryService.hasInstance()) TelemetryService.createInstance([])
	const store = new TaskHistoryStore(root)
	await store.initialize()
	let current: Task | undefined
	const emit = vi.fn()
	// Only extension-host initialization, configuration/UI, and task execution are
	// doubled. Public provider transitions, metadata, store and writers are real.
	const provider: ClineProvider = Object.assign(Object.create(Provider.prototype), {
		context: { globalStorageUri: { fsPath: root }, workspaceState: { get: () => false } },
		contextProxy: { globalStorageUri: { fsPath: root } },
		taskHistoryStore: store,
		cancelledDelegationChildIds: new Set<string>(),
		getState: async () => ({ mode: "code", currentApiConfigName: "offline" }),
		getCurrentTask: () => current,
		providerSettingsManager: { getModeConfigId: async () => undefined },
		log: vi.fn(),
		emit,
		postStateToWebviewThrottled: vi.fn(async () => {}),
		postMessageToWebview: vi.fn(async () => {}),
		handleModeSwitch: vi.fn(async () => {}),
		removeClineFromStack: vi.fn(async () => {
			current = undefined
		}),
		taskScheduler: { schedule: vi.fn(async () => {}) },
	})
	async function instance(item: HistoryItem) {
		const task = new RuntimeTask({
			provider,
			apiConfiguration: {},
			historyItem: structuredClone(item),
			startTask: false,
			enableCheckpoints: false,
		})
		tasks.push(task)
		await task.waitForModeInitialization()
		await task.waitForApiConfigInitialization()
		vi.spyOn(task, "dispose").mockResolvedValue(undefined)
		vi.spyOn(task, "flushPendingToolResultsToHistory").mockResolvedValue(true)
		vi.spyOn(task, "prepareAfterDelegation").mockResolvedValue(undefined)
		return task
	}
	const createChild = vi.fn(async () => {
		current = await instance(record("new-child", { parentTaskId: "parent", rootTaskId: "parent" }))
		return current
	})
	provider.createTask = createChild
	provider.createTaskWithHistoryItem = vi.fn(async (item: HistoryItem) => {
		current = await instance(item)
		return current
	})
	const result = {
		provider,
		store,
		emit,
		createChild,
		instance,
		setCurrent: (task: Task) => {
			current = task
		},
	}
	hosts.push(result)
	return result
}

beforeEach(async () => {
	effects.readFile = effects.renameFile = effects.failFile = ""
	root = await fs.mkdtemp(path.join(os.tmpdir(), "ordinary-completion-1469-"))
})
afterEach(async () => {
	openGate()
	await Promise.allSettled(pending.splice(0))
	for (const task of tasks.splice(0)) task["debouncedEmitTokenUsage"].cancel()
	for (const { store } of hosts.splice(0)) store.dispose()
	vi.restoreAllMocks()
	await fs.rm(root, { recursive: true, force: true })
})
async function fixture() {
	// Initialize both stores before publishing lineage: startup reconciliation is
	// not the completion/redelegation protocol being tested.
	const a = await host()
	const b = await host()
	const parent = record("parent", {
		status: "delegated",
		awaitingChildId: "old-child",
		delegatedToId: "old-child",
		childIds: ["old-child"],
	})
	await a.store.upsert(parent)
	await a.store.upsert(
		record("old-child", {
			status: "interrupted",
			parentTaskId: "parent",
			rootTaskId: "parent",
			pendingAction: {
				kind: "finish_subtask",
				actionId: "finish-old",
				approvalText: "offline finish approval",
				parentTaskId: "parent",
				result: "saved old result",
			},
		}),
	)
	const { saveTaskMessages } = await import("../../task-persistence/taskMessages")
	const { saveApiMessages } = await import("../../task-persistence/apiMessages")
	await saveTaskMessages({ globalStoragePath: root, taskId: "parent", messages: [] })
	await saveApiMessages({
		globalStoragePath: root,
		taskId: "parent",
		messages: [
			{
				messageId: "previous-use",
				ts: 1,
				role: "assistant",
				content: [{ type: "tool_use", id: "prior-call", name: "new_task", input: {} }],
			},
			{
				messageId: "previous-result",
				ts: 2,
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "prior-call", content: "prior result" }],
			},
			{
				messageId: "old-use",
				ts: 3,
				role: "assistant",
				content: [{ type: "tool_use", id: "old-call", name: "new_task", input: {} }],
			},
		],
	})
	b.setCurrent(await b.instance(parent))
	return { a, b }
}
const redelegate = (provider: ClineProvider) =>
	provider.delegateParentAndOpenChild({
		parentTaskId: "parent",
		message: "new ordinary child",
		initialTodos: [],
		mode: "code",
	})
async function results() {
	const { readApiMessages } = await import("../../task-persistence/apiMessages")
	const messages = await readApiMessages({ globalStoragePath: root, taskId: "parent" })
	return messages
		.flatMap((message) => (typeof message.content === "string" ? [] : message.content))
		.filter((block) => block.type === "tool_result")
}

it("rejects an old child after actual newer provider delegation without changing any durable bytes", async () => {
	const { a, b } = await fixture()
	await redelegate(b.provider)
	const before = await snapshot()
	expect(await a.provider.reopenParentFromDelegation(completion)).toEqual({
		kind: "detached",
		phase: "precommit",
		reason: "ownership_moved",
	})
	expect(await snapshot()).toEqual(before)
	expect(a.emit).not.toHaveBeenCalled()
	expect(a.provider.createTaskWithHistoryItem).not.toHaveBeenCalled()
	expect(await a.store.readAuthoritative("parent")).toMatchObject({
		kind: "found",
		item: { awaitingChildId: "new-child", delegatedToId: "new-child", status: "delegated" },
	})
})

it("preserves newer-delegation transcripts when an old completion was already admitted on another host", async () => {
	const { a, b } = await fixture()
	const entered = gate("readFile", file("parent", "ui_messages.json"))
	const oldCompletion = track(a.provider.reopenParentFromDelegation(completion))
	await entered
	const { saveApiMessages } = await import("../../task-persistence/apiMessages")
	const { withProviderStartExclusion } = await import("../../task-persistence/targetPersistenceBoundary")
	// As in ordinary presentation, B durably appends its native new_task call
	// before handoff. Both capable effects share B's real, awaited parent scope.
	const beforeAttempt = await snapshot()
	const attempt = await withProviderStartExclusion(root, "parent", async () => {
		await saveApiMessages({
			globalStoragePath: root,
			taskId: "parent",
			merge: true,
			messages: [
				{
					messageId: "new-use",
					ts: 4,
					role: "assistant",
					content: [{ type: "tool_use", id: "new-call", name: "new_task", input: {} }],
				},
			],
		})
		await redelegate(b.provider)
	}).then(
		() => ({ kind: "committed" as const }),
		(error: unknown) => ({ kind: "refused" as const, error }),
	)
	if (attempt.kind === "refused") {
		// A repaired owner may exclude B before transcript I/O. That is safe only
		// with typed refusal, no new child, and ordinary progress after release.
		expect(attempt.error).toMatchObject({ name: "ParentHandoffFenceUnavailableError" })
		expect(b.createChild).not.toHaveBeenCalled()
		expect(await snapshot()).toEqual(beforeAttempt)
		expect(await results()).not.toContainEqual(expect.objectContaining({ tool_use_id: "new-call" }))
		openGate()
		expect(await oldCompletion).toMatchObject({ kind: "committed" })
		expect(await results()).toEqual([
			expect.objectContaining({ tool_use_id: "prior-call", content: "prior result" }),
			expect.objectContaining({
				tool_use_id: "old-call",
				content: "Subtask old-child completed.\n\nResult:\nsaved old result",
			}),
		])
		await redelegate(b.provider)
		const before = await snapshot()
		expect(await a.provider.reopenParentFromDelegation(completion)).toMatchObject({
			kind: "detached",
			reason: "historical_replay",
		})
		expect(await snapshot()).toEqual(before)
		return
	}
	const before = await snapshot()
	openGate()
	expect(await oldCompletion).toEqual({ kind: "detached", phase: "precommit", reason: "ownership_moved" })
	expect(a.emit).not.toHaveBeenCalled()
	expect(a.provider.createTaskWithHistoryItem).not.toHaveBeenCalled()
	// Safety assertion deliberately remains red if refusal followed stale writes.
	expect.soft(await snapshot()).toEqual(before)
	expect.soft(await results()).not.toContainEqual(expect.objectContaining({ tool_use_id: "new-call" }))
})

it("retains cooperative parent exclusion from child publication through final parent publication", async () => {
	const { a, b } = await fixture()
	const entered = gate("renameFile", file("old-child", "history_item.json"))
	const oldCompletion = track(a.provider.reopenParentFromDelegation(completion))
	await entered
	expect(JSON.parse(await fs.readFile(file("old-child", "history_item.json"), "utf8"))).toMatchObject({
		status: "completed",
	})
	expect(JSON.parse(await fs.readFile(file("parent", "history_item.json"), "utf8"))).toMatchObject({
		status: "delegated",
		awaitingChildId: "old-child",
	})
	await expect(redelegate(b.provider)).rejects.toThrow(/held|unavailable/i)
	expect(b.createChild).not.toHaveBeenCalled()
	openGate()
	expect(await oldCompletion).toMatchObject({ kind: "committed" })
	expect(await a.store.readAuthoritative("parent")).toMatchObject({
		kind: "found",
		item: { status: "active", completedByChildId: "old-child" },
	})
	await redelegate(b.provider)
	const before = await snapshot()
	expect(await a.provider.reopenParentFromDelegation(completion)).toMatchObject({
		kind: "detached",
		reason: "historical_replay",
	})
	expect(await snapshot()).toEqual(before)
})

it("correlates current completion to its latest new_task call and never duplicates a committed replay", async () => {
	const { a } = await fixture()
	expect(await a.provider.reopenParentFromDelegation(completion)).toMatchObject({
		kind: "committed",
		resumeState: "queued",
	})
	expect(await results()).toEqual([
		expect.objectContaining({ tool_use_id: "prior-call", content: "prior result" }),
		expect.objectContaining({
			tool_use_id: "old-call",
			content: "Subtask old-child completed.\n\nResult:\nsaved old result",
		}),
	])
	expect(a.emit).toHaveBeenCalledWith(
		RooCodeEventName.TaskDelegationCompleted,
		"parent",
		"old-child",
		"saved old result",
	)
	const before = await snapshot()
	expect(await a.provider.reopenParentFromDelegation(completion)).toMatchObject({
		kind: "detached",
		reason: "historical_replay",
	})
	expect(await snapshot()).toEqual(before)
	expect(a.emit.mock.calls.filter(([name]) => name === RooCodeEventName.TaskDelegationCompleted)).toHaveLength(1)
})

it("reports failed second publication without hiding the committed child or rolling back transcripts", async () => {
	const { a } = await fixture()
	const parentBefore = await fs.readFile(file("parent", "history_item.json"), "utf8")
	effects.failFile = file("parent", "history_item.json")
	expect(await a.provider.reopenParentFromDelegation(completion)).toEqual({
		kind: "recoverable_failure",
		phase: "precommit",
		reason: "lifecycle_commit_failed",
	})
	expect(await fs.readFile(file("parent", "history_item.json"), "utf8")).toBe(parentBefore)
	expect(await a.store.readAuthoritative("old-child")).toMatchObject({ kind: "found", item: { status: "completed" } })
	expect(a.store.get("old-child")?.status).toBe("completed")
	expect(await results()).toContainEqual(
		expect.objectContaining({ tool_use_id: "old-call", content: expect.stringContaining("saved old result") }),
	)
	expect(a.emit).not.toHaveBeenCalled()
	expect(a.provider.createTaskWithHistoryItem).not.toHaveBeenCalled()
})
