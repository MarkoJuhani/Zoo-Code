import * as crypto from "crypto"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { TelemetryService } from "@roo-code/telemetry"
import type { HistoryItem } from "@roo-code/types"
import { TaskHistoryStore } from "../../task-persistence/TaskHistoryStore"
import { Task } from "../Task"
import { ClineProvider } from "../../webview/ClineProvider"

vi.mock("../../ignore/RooIgnoreController", () => ({
	RooIgnoreController: class {
		initialize = async () => {}
		dispose = () => {}
	},
}))
vi.mock("../../protect/RooProtectedController", () => ({ RooProtectedController: class {} }))
vi.mock("../../context-tracking/FileContextTracker", () => ({ FileContextTracker: class {} }))
vi.mock("../../../api", () => ({ buildApiHandler: vi.fn(() => ({})) }))

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
		addToApiConversationHistory: (message: import("@anthropic-ai/sdk").Anthropic.MessageParam) => Promise<void>
		questionResultDelivered: boolean
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
		context: { globalStorageUri: { fsPath: root }, workspaceState: { get: () => false } },
		contextProxy: { globalStorageUri: { fsPath: root } },
		taskHistoryStore: store,
		providerSettingsManager: { getModeConfigId: async () => undefined },
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

const diskEffects = vi.hoisted(() => ({
	beforeRename: undefined as undefined | ((from: string, to: string) => Promise<void>),
	afterRename: undefined as undefined | ((from: string, to: string) => Promise<void>),
	afterCopy: undefined as undefined | ((from: string, to: string) => Promise<void>),
}))
vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	return {
		...actual,
		copyFile: async (from: string, to: string, mode?: number) => {
			await actual.copyFile(from, to, mode)
			await diskEffects.afterCopy?.(String(from), String(to))
		},
		rename: async (from: string, to: string) => {
			await diskEffects.beforeRename?.(String(from), String(to))
			await actual.rename(from, to)
			await diskEffects.afterRename?.(String(from), String(to))
		},
	}
})
beforeEach(() => {
	diskEffects.beforeRename = undefined
	diskEffects.afterRename = undefined
	diskEffects.afterCopy = undefined
})

import { ParentHandoffFence } from "../../task-persistence/parentHandoffFence"
import { withProviderStartExclusion, withPersistenceExclusions } from "../../task-persistence/targetPersistenceBoundary"

it("does not publish message bytes while Task metadata acquisition is waiting", async () => {
	const item = record("ordinary")
	await store.upsert(item)
	const task = await instance(item)
	expect(await seams(task).saveClineMessages()).toBe(true)
	const original = await bytes(root, item.id, "ui_messages.json")
	const lease = await new ParentHandoffFence(root).acquire(item.id)
	const acquire = vi.spyOn(ParentHandoffFence.prototype, "acquire")
	task.clineMessages.push({ messageId: "late", ts: 2, type: "say", say: "text", text: "must wait" })
	const saving = seams(task).saveClineMessages()
	try {
		await vi.waitFor(() => expect(acquire).toHaveBeenCalled())
		expect(await bytes(root, item.id, "ui_messages.json")).toBe(original)
	} finally {
		await lease.release()
		await saving
	}
})

it("reports message-committed/metadata-failed partial effects without rollback", async () => {
	const item = record("ordinary")
	await store.upsert(item)
	const task = await instance(item)
	expect(await seams(task).saveClineMessages()).toBe(true)
	const metadata = await bytes(root, item.id, "history_item.json")
	diskEffects.beforeRename = async (_from, to) => {
		if (String(to).endsWith("history_item.json")) throw new Error("metadata publication injected")
	}
	task.clineMessages.push({ messageId: "committed", ts: 2, type: "say", say: "text", text: "committed" })
	expect(await seams(task).saveClineMessages()).toBe(false)
	expect(await bytes(root, item.id, "ui_messages.json")).toContain("committed")
	expect(await bytes(root, item.id, "history_item.json")).toBe(metadata)
})

it("rejects expired inherited authority before message publication and on later attempts", async () => {
	const item = record("ordinary")
	await store.upsert(item)
	const task = await instance(item)
	expect(await seams(task).saveClineMessages()).toBe(true)
	const original = await bytes(root, item.id, "ui_messages.json")
	let callback!: () => void
	let finished!: (result: Promise<boolean>) => void
	const attempt = new Promise<boolean>((resolve, reject) => {
		finished = (p) => p.then(resolve, reject)
	})
	await withProviderStartExclusion(root, item.id, async () => {
		// Promise continuation retains the released AsyncLocalStorage context.
		const trigger = new Promise<void>((resolve) => {
			callback = resolve
		})
		void trigger.then(() => finished(seams(task).saveClineMessages()))
	})
	task.clineMessages.push({ messageId: "expired", ts: 2, type: "say", say: "text", text: "expired" })
	callback()
	await expect(attempt).rejects.toThrow(/expired|authority/i)
	expect(await bytes(root, item.id, "ui_messages.json")).toBe(original)
	await expect(seams(task).saveClineMessages()).rejects.toThrow(/authority|refused/i)
	expect(await bytes(root, item.id, "ui_messages.json")).toBe(original)
})

it("held fail-fast exclusion prevents its effect and unrelated task still progresses", async () => {
	await store.upsert(record("held"))
	const lease = await new ParentHandoffFence(root).acquire("held")
	const effect = vi.fn(async () => {})
	try {
		await expect(withPersistenceExclusions(root, ["held"], effect, { failFast: true })).rejects.toThrow()
		expect(effect).not.toHaveBeenCalled()
		await store.upsert(record("other"))
		expect(store.get("other")?.id).toBe("other")
	} finally {
		await lease.release()
	}
})

it("failed save/repeated flush retains content without duplicate correlated results", async () => {
	const item = record("ordinary")
	await store.upsert(item)
	const task = await instance(item)
	task.apiConversationHistory = [
		{
			messageId: "assistant",
			ts: 1,
			role: "assistant",
			content: [{ type: "tool_use", id: "result-1", name: "execute_command", input: {} }],
		},
	]
	seams(task).assistantMessageSavedToHistory = true
	task.userMessageContent = [{ type: "tool_result", tool_use_id: "result-1", content: "retained" }]
	let fail = true
	diskEffects.beforeRename = async (_from, to) => {
		if (fail && String(to).endsWith("api_conversation_history.json")) throw new Error("API publication injected")
	}
	expect(await task.flushPendingToolResultsToHistory()).toBe(false)
	expect(await task.flushPendingToolResultsToHistory()).toBe(false)
	expect(task.userMessageContent).toEqual([{ type: "tool_result", tool_use_id: "result-1", content: "retained" }])
	expect(task.apiConversationHistory.filter((m) => m.role === "user")).toHaveLength(1)
	fail = false
	expect(await task.flushPendingToolResultsToHistory()).toBe(true)
	expect(task.userMessageContent).toEqual([])
	const history = JSON.parse(await bytes(root, item.id, "api_conversation_history.json")) as { role: string }[]
	expect(history.filter((m) => m.role === "user")).toHaveLength(1)
})

const generationFile = (id: string) =>
	path.join(root, ".handoff-fences", `${crypto.createHash("sha256").update(id).digest("hex")}.generation`)

it("an arbitrary effect retains its lease and refuses an inherited idle question wait", async () => {
	const item = record("ordinary", {
		pendingQuestion: { id: "owned", taskId: "ordinary", toolCallId: "call", text: "Choose?" },
	})
	await store.upsert(item)
	const task = await instance(item)
	let contend!: () => void
	const contender = new Promise<void>((resolve) => {
		contend = resolve
	}).then(() => withPersistenceExclusions(root, [item.id], async () => {}, { failFast: true }))
	void contender.catch(() => {})
	await task.runWithStartExclusion(async () => {
		await expect(task["resumePendingQuestion"]()).rejects.toThrow(/independent orchestration context/i)
		// Refusal does not surrender the arbitrary caller's last-effect window.
		contend()
		await expect(contender).rejects.toThrow()
		expect(await seams(task).saveClineMessages()).toBe(true)
	})
	expect(task["activeQuestionWaitId"]).toBeUndefined()
	expect(store.get(item.id)?.pendingQuestion?.answer).toBeUndefined()
})

it("a fresh callback acquires a new lease instead of inheriting its expired enqueuer", async () => {
	const item = record("ordinary")
	await store.upsert(item)
	const task = await instance(item)
	let trigger!: () => void
	let attempt!: Promise<void>
	await withProviderStartExclusion(root, item.id, async () => {
		const queued = new Promise<void>((resolve) => {
			trigger = resolve
		})
		attempt = queued.then(() =>
			task.runWithStartExclusion(async () => {
				expect(await seams(task).saveClineMessages()).toBe(true)
				expect(await seams(task).saveApiConversationHistory()).toBe(true)
			}),
		)
	})
	const previous = await fs.readFile(generationFile(item.id), "utf8")
	trigger()
	await attempt
	expect(Number(await fs.readFile(generationFile(item.id), "utf8"))).toBeGreaterThan(Number(previous))
})

for (const boundary of ["ui_messages.json", "api_conversation_history.json", "history_item.json"] as const) {
	it(`lost generation at final ${boundary} publication preserves old bytes and permanently refuses instance`, async () => {
		const item = record("ordinary")
		await store.upsert(item)
		const task = await instance(item)
		expect(await seams(task).saveClineMessages()).toBe(true)
		expect(await seams(task).saveApiConversationHistory()).toBe(true)
		const before = await bytes(root, item.id, boundary)
		task.clineMessages.push({ messageId: "lost", ts: 2, type: "say", say: "text", text: "lost" })
		task.apiConversationHistory.push({ messageId: "lost-api", ts: 2, role: "user", content: "lost" })
		diskEffects.afterCopy = async (from) => {
			if (from.endsWith(boundary)) await fs.writeFile(generationFile(item.id), "999999")
		}
		const save =
			boundary === "api_conversation_history.json"
				? seams(task).saveApiConversationHistory()
				: seams(task).saveClineMessages()
		await expect(save).rejects.toThrow(/ownership|generation|authority/i)
		expect(await bytes(root, item.id, boundary)).toBe(before)
		await expect(seams(task).saveApiConversationHistory()).rejects.toThrow(/authority|refused/i)
		await expect(seams(task).saveClineMessages()).rejects.toThrow(/authority|refused/i)
		await store.upsert(record("other"))
		expect(store.get("other")?.id).toBe("other")
	})

	it(`post-replacement ${boundary} failure reports failure but does not restore old bytes`, async () => {
		const item = record("ordinary")
		await store.upsert(item)
		const task = await instance(item)
		expect(await seams(task).saveClineMessages()).toBe(true)
		expect(await seams(task).saveApiConversationHistory()).toBe(true)
		const before = await bytes(root, item.id, boundary)
		task.clineMessages.push({ messageId: "published", ts: 2, type: "say", say: "text", text: "published" })
		task.apiConversationHistory.push({ messageId: "published-api", ts: 2, role: "user", content: "published" })
		diskEffects.afterRename = async (_from, to) => {
			if (to.endsWith(boundary)) throw new Error("after replacement injected")
		}
		const saved =
			boundary === "api_conversation_history.json"
				? await seams(task).saveApiConversationHistory()
				: await seams(task).saveClineMessages()
		expect(saved).toBe(false)
		expect(await bytes(root, item.id, boundary)).not.toBe(before)
		if (boundary !== "history_item.json") expect(await bytes(root, item.id, boundary)).toContain("published")
	})
}

it("metadata ownership loss after committed messages is a truthful partial effect with sticky refusal", async () => {
	const item = record("ordinary")
	await store.upsert(item)
	const task = await instance(item)
	expect(await seams(task).saveClineMessages()).toBe(true)
	const before = await bytes(root, item.id, "history_item.json")
	task.clineMessages.push({ messageId: "committed", ts: 2, type: "say", say: "text", text: "committed" })
	diskEffects.afterRename = async (_from, to) => {
		if (to.endsWith("ui_messages.json")) await fs.writeFile(generationFile(item.id), "999999")
	}
	await expect(seams(task).saveClineMessages()).rejects.toThrow(/authority|ownership|generation/i)
	expect(await bytes(root, item.id, "ui_messages.json")).toContain("committed")
	expect(await bytes(root, item.id, "history_item.json")).toBe(before)
	await expect(seams(task).saveClineMessages()).rejects.toThrow(/authority|refused/i)
})

it("lost ancestor generation blocks child message publication", async () => {
	await store.upsert(record("parent", { status: "delegated", awaitingChildId: "child", delegatedToId: "child" }))
	const child = record("child", { parentTaskId: "parent", rootTaskId: "parent" })
	await store.upsert(child)
	const task = await instance(child)
	expect(await seams(task).saveClineMessages()).toBe(true)
	const before = await bytes(root, child.id, "ui_messages.json")
	task.clineMessages.push({ messageId: "lost", ts: 2, type: "say", say: "text", text: "lost" })
	diskEffects.afterCopy = async (from) => {
		if (from.endsWith("ui_messages.json")) await fs.writeFile(generationFile("parent"), "999999")
	}
	await expect(seams(task).saveClineMessages()).rejects.toThrow(/authority|ownership|generation/i)
	expect(await bytes(root, child.id, "ui_messages.json")).toBe(before)
})

it("caught typed refusal retains pending result and prevents every later stale attempt", async () => {
	const item = record("ordinary")
	await store.upsert(item)
	const task = await instance(item)
	task.apiConversationHistory = [
		{
			messageId: "assistant",
			ts: 1,
			role: "assistant",
			content: [{ type: "tool_use", id: "result", name: "execute_command", input: {} }],
		},
	]
	expect(await seams(task).saveApiConversationHistory()).toBe(true)
	seams(task).assistantMessageSavedToHistory = true
	task.userMessageContent = [{ type: "tool_result", tool_use_id: "result", content: "retain" }]
	const before = await bytes(root, item.id, "api_conversation_history.json")
	diskEffects.afterCopy = async (from) => {
		if (from.endsWith("api_conversation_history.json")) await fs.writeFile(generationFile(item.id), "999999")
	}
	await expect(task.flushPendingToolResultsToHistory()).rejects.toThrow()
	expect(task.userMessageContent).toHaveLength(1)
	await expect(task.flushPendingToolResultsToHistory()).rejects.toThrow(/authority|refused/i)
	await expect(task.retrySaveApiConversationHistory()).rejects.toThrow(/authority|refused/i)
	expect(task.apiConversationHistory.filter((m) => m.role === "user")).toHaveLength(1)
	expect(await bytes(root, item.id, "api_conversation_history.json")).toBe(before)
})

for (const kind of ["action", "question"] as const) {
	it(`${kind} clears only after the actual API result and metadata publication succeed`, async () => {
		const action = {
			kind: "finish_subtask" as const,
			actionId: "result",
			parentTaskId: "parent",
			result: "done",
			approvalText: "done",
		}
		const question = {
			id: "question",
			taskId: "ordinary",
			toolCallId: "result",
			text: "Choose?",
			answer: { text: "answer" },
		}
		const item = record("ordinary", kind === "action" ? { pendingAction: action } : { pendingQuestion: question })
		await store.upsert(item)
		const task = await instance(item)
		task.apiConversationHistory = [
			{
				messageId: "assistant",
				ts: 1,
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "result",
						name: kind === "action" ? "attempt_completion" : "ask_followup_question",
						input: {},
					},
				],
			},
		]
		expect(await seams(task).saveApiConversationHistory()).toBe(true)
		seams(task).assistantMessageSavedToHistory = true
		seams(task).questionResultDelivered = true
		task.userMessageContent = [{ type: "tool_result", tool_use_id: "result", content: "answer" }]
		diskEffects.beforeRename = async (_from, to) => {
			if (to.endsWith("api_conversation_history.json")) throw new Error("result save injected")
		}
		expect(await task.flushPendingToolResultsToHistory()).toBe(false)
		expect(store.get(item.id)?.[kind === "action" ? "pendingAction" : "pendingQuestion"]).toBeDefined()
		diskEffects.beforeRename = undefined
		expect(await task.flushPendingToolResultsToHistory()).toBe(true)
		expect(store.get(item.id)?.[kind === "action" ? "pendingAction" : "pendingQuestion"]).toBeUndefined()
	})
}

it("owner-token loss before a Task save is sticky and does not publish files", async () => {
	const item = record("ordinary")
	await store.upsert(item)
	const task = await instance(item)
	expect(await seams(task).saveClineMessages()).toBe(true)
	const before = await bytes(root, item.id, "ui_messages.json")
	task.clineMessages.push({ messageId: "unauthorized", ts: 2, type: "say", say: "text", text: "unauthorized" })
	await expect(
		withProviderStartExclusion(root, item.id, async () => {
			const key = crypto.createHash("sha256").update(item.id).digest("hex")
			const ownerFile = path.join(root, ".handoff-fences", `${key}.lock`, "owner.json")
			const owner = JSON.parse(await fs.readFile(ownerFile, "utf8"))
			await fs.writeFile(ownerFile, JSON.stringify({ ...owner, ownerToken: "competing-owner" }))
			await seams(task).saveClineMessages()
		}),
	).rejects.toThrow(/ownership|owner|authority/i)
	expect(await bytes(root, item.id, "ui_messages.json")).toBe(before)
	await expect(seams(task).saveClineMessages()).rejects.toThrow(/authority|refused/i)
})

for (const kind of ["action", "question"] as const) {
	it(`${kind} metadata-clear failure retains content and retries one already-published result`, async () => {
		const item = record(
			"ordinary",
			kind === "action"
				? {
						pendingAction: {
							kind: "finish_subtask",
							actionId: "result",
							parentTaskId: "parent",
							result: "done",
							approvalText: "done",
						},
					}
				: {
						pendingQuestion: {
							id: "question",
							taskId: "ordinary",
							toolCallId: "result",
							text: "Choose?",
							answer: { text: "answer" },
						},
					},
		)
		await store.upsert(item)
		const task = await instance(item)
		task.apiConversationHistory = [
			{
				messageId: "assistant",
				ts: 1,
				role: "assistant",
				content: [{ type: "tool_use", id: "result", name: "attempt_completion", input: {} }],
			},
		]
		expect(await seams(task).saveApiConversationHistory()).toBe(true)
		seams(task).assistantMessageSavedToHistory = true
		seams(task).questionResultDelivered = true
		task.userMessageContent = [{ type: "tool_result", tool_use_id: "result", content: "answer" }]
		diskEffects.beforeRename = async (_from, to) => {
			if (to.endsWith("history_item.json")) throw new Error("clear publication injected")
		}
		await expect(task.flushPendingToolResultsToHistory()).rejects.toThrow(/publication/i)
		expect(task.userMessageContent).toHaveLength(1)
		expect(store.get(item.id)?.[kind === "action" ? "pendingAction" : "pendingQuestion"]).toBeDefined()
		diskEffects.beforeRename = undefined
		expect(await task.flushPendingToolResultsToHistory()).toBe(true)
		expect(task.userMessageContent).toEqual([])
		expect(store.get(item.id)?.[kind === "action" ? "pendingAction" : "pendingQuestion"]).toBeUndefined()
		const history = JSON.parse(await bytes(root, item.id, "api_conversation_history.json")) as { role: string }[]
		expect(history.filter((m) => m.role === "user")).toHaveLength(1)
	})
}

it("missing owner evidence before final UI publication blocks the instance without restoring authority", async () => {
	const item = record("ordinary")
	await store.upsert(item)
	const task = await instance(item)
	expect(await seams(task).saveClineMessages()).toBe(true)
	const before = await bytes(root, item.id, "ui_messages.json")
	task.clineMessages.push({ messageId: "missing-owner", ts: 2, type: "say", say: "text", text: "missing" })
	diskEffects.afterCopy = async (from) => {
		if (!from.endsWith("ui_messages.json")) return
		const key = crypto.createHash("sha256").update(item.id).digest("hex")
		await fs.unlink(path.join(root, ".handoff-fences", `${key}.lock`, "owner.json"))
	}
	await expect(seams(task).saveClineMessages()).rejects.toThrow(/owner|authority/i)
	expect(await bytes(root, item.id, "ui_messages.json")).toBe(before)
	await expect(seams(task).saveClineMessages()).rejects.toThrow(/authority|refused/i)
})

it("production delegation propagates caught Task refusal before child creation or start", async () => {
	const item = record("ordinary")
	await store.upsert(item)
	const task = await instance(item)
	task.apiConversationHistory = [
		{
			messageId: "assistant",
			ts: 1,
			role: "assistant",
			content: [{ type: "tool_use", id: "result", name: "execute_command", input: {} }],
		},
	]
	expect(await seams(task).saveApiConversationHistory()).toBe(true)
	seams(task).assistantMessageSavedToHistory = true
	task.userMessageContent = [{ type: "tool_result", tool_use_id: "result", content: "retained" }]
	// Catch a real expired-context refusal first, then invoke the actual caller later.
	let trigger!: () => void
	let expired!: Promise<boolean>
	await withProviderStartExclusion(root, item.id, async () => {
		const queued = new Promise<void>((resolve) => {
			trigger = resolve
		})
		expired = queued.then(() => seams(task).saveApiConversationHistory())
	})
	trigger()
	await expect(expired).rejects.toThrow(/expired|authority/i)
	const create = vi.fn(),
		remove = vi.fn(),
		schedule = vi.fn()
	Object.assign(provider, {
		getCurrentTask: () => task,
		createTask: create,
		removeClineFromStack: remove,
		taskScheduler: { schedule },
	})
	await expect(
		provider.delegateParentAndOpenChild({
			parentTaskId: item.id,
			message: "never start",
			initialTodos: [],
			mode: "code",
		}),
	).rejects.toThrow(/authority|refused/i)
	expect(create).not.toHaveBeenCalled()
	expect(remove).not.toHaveBeenCalled()
	expect(schedule).not.toHaveBeenCalled()
	expect(task.userMessageContent).toHaveLength(1)
})
