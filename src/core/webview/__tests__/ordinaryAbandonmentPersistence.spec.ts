import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { TelemetryService } from "@roo-code/telemetry"
import type { HistoryItem } from "@roo-code/types"
import { TaskHistoryStore } from "../../task-persistence/TaskHistoryStore"
import { Task } from "../../task/Task"
import { ClineProvider } from "../ClineProvider"

vi.mock("../../ignore/RooIgnoreController", () => ({
	RooIgnoreController: class {
		initialize = async () => {}
		dispose = () => {}
	},
}))
vi.mock("../../protect/RooProtectedController", () => ({ RooProtectedController: class {} }))
vi.mock("../../context-tracking/FileContextTracker", () => ({ FileContextTracker: class {} }))
vi.mock("../../../api", () => ({ buildApiHandler: vi.fn(() => ({})) }))

const abandonmentEffects = vi.hoisted(() => ({ failParent: false }))
vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	return {
		...actual,
		rename: async (from: string, to: string) => {
			if (abandonmentEffects.failParent && String(to).endsWith("/parent/history_item.json"))
				throw new Error("second abandonment publication injected")
			await actual.rename(from, to)
		},
	}
})
beforeEach(() => {
	abandonmentEffects.failParent = false
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
	childIds: [],
	...changes,
})
const bytes = (root: string, id: string, file: string) => fs.readFile(path.join(root, "tasks", id, file), "utf8")
const seams = (task: Task) =>
	task as unknown as {
		saveClineMessages: () => Promise<boolean>
		saveApiConversationHistory: () => Promise<boolean>
		assistantMessageSavedToHistory: boolean
	}
let root: string
let store: TaskHistoryStore
let provider: ClineProvider
const tasks: Task[] = []
beforeEach(async () => {
	if (!TelemetryService.hasInstance()) TelemetryService.createInstance([])
	root = await fs.mkdtemp(path.join(os.tmpdir(), "ordinary-1021-"))
	store = new TaskHistoryStore(root)
	await store.initialize()
	// Structural provider shell avoids extension-host initialization. All persistence,
	// metadata lookup, action clearing and abandonment methods are production methods.
	provider = Object.assign(Object.create(ClineProvider.prototype), {
		context: { globalStorageUri: { fsPath: root } },
		contextProxy: { globalStorageUri: { fsPath: root } },
		taskHistoryStore: store,
		cancelledDelegationChildIds: new Set<string>(),
		getState: async () => ({ mode: "code", currentApiConfigName: "offline" }),
		getCurrentTask: () => undefined,
		log: vi.fn(),
		postStateToWebviewThrottled: vi.fn(async () => {}),
		postMessageToWebview: vi.fn(async () => {}),
	}) as ClineProvider
})
afterEach(async () => {
	for (const task of tasks.splice(0)) task["debouncedEmitTokenUsage"].cancel()
	store.dispose()
	vi.restoreAllMocks()
	await fs.rm(root, { recursive: true, force: true })
})
async function instance(item: HistoryItem): Promise<Task> {
	const task = new Task({
		provider,
		apiConfiguration: {},
		historyItem: structuredClone(item),
		startTask: false,
		enableCheckpoints: false,
	})
	tasks.push(task)
	await task.waitForModeInitialization()
	await task.waitForApiConfigInitialization()
	task.clineMessages = [{ messageId: `${item.id}-old`, ts: 1, type: "say", say: "text", text: item.id }]
	task.apiConversationHistory = [{ messageId: `${item.id}-api`, ts: 1, role: "user", content: "old" }]
	return task
}

async function delegatedFixture() {
	const parentItem = record("parent", {
		status: "delegated",
		awaitingChildId: "child",
		delegatedToId: "child",
		childIds: ["child"],
	})
	const childItem = record("child", { status: "interrupted", parentTaskId: "parent", rootTaskId: "parent" })
	await store.upsert(parentItem)
	await store.upsert(childItem)
	const parent = await instance(parentItem)
	const child = await instance(childItem)
	for (const task of [parent, child]) {
		expect(await seams(task).saveClineMessages()).toBe(true)
		expect(await seams(task).saveApiConversationHistory()).toBe(true)
	}
	return { parent, child }
}

it("actual abandon then refresh permanently rejects delayed old parent/child message and API saves", async () => {
	const { parent, child } = await delegatedFixture()
	expect(await provider.abandonSubtask(child.taskId)).toBe(true)
	await store.reconcile()
	expect(store.get("child")?.parentTaskId).toBeUndefined()
	expect(store.get("parent")?.awaitingChildId).toBeUndefined()
	const before = new Map<string, string>()
	for (const task of [parent, child])
		for (const file of ["history_item.json", "ui_messages.json", "api_conversation_history.json"])
			before.set(`${task.taskId}/${file}`, await bytes(root, task.taskId, file))
	for (const task of [parent, child]) {
		task.clineMessages.push({ messageId: "stale", ts: 2, type: "say", say: "text", text: "stale" })
		task.apiConversationHistory.push({ messageId: "stale-api", ts: 2, role: "user", content: "stale" })
		await expect(seams(task).saveClineMessages()).rejects.toThrow(/authority|lineage|stale/i)
		await expect(seams(task).saveApiConversationHistory()).rejects.toThrow(/authority|lineage|stale/i)
		await expect(seams(task).saveClineMessages()).rejects.toThrow(/authority|refused|stale/i)
	}
	for (const task of [parent, child])
		for (const file of ["history_item.json", "ui_messages.json", "api_conversation_history.json"])
			expect(await bytes(root, task.taskId, file)).toBe(before.get(`${task.taskId}/${file}`))
})

it("fresh instance after abandonment may save detached child without restoring old lineage", async () => {
	const { child } = await delegatedFixture()
	expect(await provider.abandonSubtask(child.taskId)).toBe(true)
	await store.reconcile()
	const current = store.get("child")!
	const fresh = await instance(current)
	expect(await seams(fresh).saveClineMessages()).toBe(true)
	expect(await seams(fresh).saveApiConversationHistory()).toBe(true)
	expect(JSON.parse(await bytes(root, "child", "history_item.json")).parentTaskId).toBeUndefined()
})

it("valid newly created child retains delegated parent and root lineage", async () => {
	await store.upsert(
		record("parent", {
			status: "delegated",
			awaitingChildId: "new-child",
			delegatedToId: "new-child",
			childIds: ["new-child"],
		}),
	)
	const parent = await instance(store.get("parent")!)
	const child = new Task({
		provider,
		apiConfiguration: {},
		taskId: "new-child",
		task: "offline child",
		parentTask: parent,
		rootTask: parent,
		startTask: false,
		initialStatus: "active",
		enableCheckpoints: false,
	})
	tasks.push(child)
	await child.waitForModeInitialization()
	await child.waitForApiConfigInitialization()
	child.clineMessages = [{ messageId: "new", ts: 1, type: "say", say: "text", text: "new child" }]
	expect(await seams(child).saveClineMessages()).toBe(true)
	expect(store.get("new-child")).toMatchObject({ parentTaskId: "parent", rootTaskId: "parent", status: "active" })
})

it("refreshed store rejects explicit delayed Task metadata snapshots independently of Task save wrapper", async () => {
	const { parent, child } = await delegatedFixture()
	const snapshots = [parent, child].map((task) => ({
		...store.get(task.taskId)!,
		ordinaryPersistenceRevision: task["persistenceAuthority"].revision,
	}))
	expect(await provider.abandonSubtask(child.taskId)).toBe(true)
	await store.reconcile()
	for (const snapshot of snapshots) {
		const before = await bytes(root, snapshot.id, "history_item.json")
		await expect(provider.updateTaskHistory(snapshot)).rejects.toThrow(/authority|snapshot/i)
		expect(await bytes(root, snapshot.id, "history_item.json")).toBe(before)
	}
})

it("failed parent half of actual abandonment leaves committed detached child, not an atomic rollback", async () => {
	const { parent, child } = await delegatedFixture()
	const parentBefore = await bytes(root, parent.taskId, "history_item.json")
	const childBefore = await bytes(root, child.taskId, "history_item.json")
	abandonmentEffects.failParent = true
	await expect(provider.abandonSubtask(child.taskId)).rejects.toThrow(/publication/i)
	expect(await bytes(root, parent.taskId, "history_item.json")).toBe(parentBefore)
	expect(await bytes(root, child.taskId, "history_item.json")).not.toBe(childBefore)
	const detached = JSON.parse(await bytes(root, child.taskId, "history_item.json"))
	expect(detached.parentTaskId).toBeUndefined()
	expect(detached.rootTaskId).toBeUndefined()
	expect(detached.ordinaryPersistenceRevision).toEqual(expect.any(String))
	await store.reconcile()
	await expect(seams(child).saveClineMessages()).rejects.toThrow(/authority|stale/i)
	await expect(seams(child).saveApiConversationHistory()).rejects.toThrow(/authority|refused/i)
	expect(await bytes(root, parent.taskId, "history_item.json")).toBe(parentBefore)
})
