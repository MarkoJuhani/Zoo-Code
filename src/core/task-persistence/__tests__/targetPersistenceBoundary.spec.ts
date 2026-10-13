import * as fs from "fs/promises"
import * as crypto from "crypto"
import * as os from "os"
import * as path from "path"
import type { HistoryItem } from "@roo-code/types"
import { bindTargetPersistence, withPersistenceExclusions } from "../targetPersistenceBoundary"
import { ParentHandoffFence, ParentHandoffFenceUnavailableError } from "../parentHandoffFence"
import { TaskHistoryStore } from "../TaskHistoryStore"
import { readApiMessages, saveApiMessages } from "../apiMessages"

const action = {
	kind: "create_subtask" as const,
	actionId: "old",
	mode: "code",
	message: "old",
	todos: [],
	approvalText: "old",
}
const item = (id: string): HistoryItem => ({
	id,
	number: 1,
	ts: 1,
	task: id,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	status: "interrupted",
	childIds: [],
	pendingAction: id === "parent" ? action : undefined,
})

it("refuses a held parent fence without stealing it and allows an unrelated parent", async () => {
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), "ordinary-fence-refusal-"))
	const first = new TaskHistoryStore(storage)
	const second = new TaskHistoryStore(storage)
	try {
		await first.initialize()
		await second.initialize()
		await first.upsert(item("parent"))
		await first.upsert(item("other"))
		const lease = await new ParentHandoffFence(storage).acquire("parent")
		const effect = vi.fn(async () => second.upsert({ ...item("parent"), task: "stale" }))
		await expect(withPersistenceExclusions(storage, ["parent"], effect, { failFast: true })).rejects.toMatchObject({
			name: ParentHandoffFenceUnavailableError.name,
			reason: "timeout",
		})
		expect(effect).not.toHaveBeenCalled()
		await second.upsert({ ...item("other"), task: "progress" })
		await lease.assertOwned()
		expect((await first.readAuthoritative("parent")).kind).toBe("found")
		expect(
			JSON.parse(await fs.readFile(path.join(storage, "tasks", "parent", "history_item.json"), "utf8")).task,
		).toBe("parent")
		expect(
			JSON.parse(await fs.readFile(path.join(storage, "tasks", "other", "history_item.json"), "utf8")).task,
		).toBe("progress")
		await lease.release()
	} finally {
		first.dispose()
		second.dispose()
		await fs.rm(storage, { recursive: true, force: true })
	}
})

it("retains an abandoned disposable fence instead of stealing an uncertain holder", async () => {
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), "abandoned-fence-refusal-"))
	try {
		const lease = await new ParentHandoffFence(storage).acquire("parent")
		const lock = path.join(
			storage,
			".handoff-fences",
			`${crypto.createHash("sha256").update("parent").digest("hex")}.lock`,
		)
		await expect(new ParentHandoffFence(storage).acquire("parent", { timeoutMs: 0 })).rejects.toMatchObject({
			reason: "timeout",
		})
		await lease.assertOwned()
		expect(await fs.readdir(lock)).toContain("owner.json")
		// Simulate a holder that never calls release; only the disposable root is removed in teardown.
	} finally {
		await fs.rm(storage, { recursive: true, force: true })
	}
})

it("refuses paused API replacement and late task, question and deletion while target is excluded; unrelated parent proceeds", async () => {
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), "target-boundary-"))
	const first = new TaskHistoryStore(storage)
	const second = new TaskHistoryStore(storage)
	try {
		await first.initialize()
		await second.initialize()
		await first.upsert(item("parent"))
		await first.upsert(item("other"))
		await second.reconcile({ forceRefresh: true })
		await saveApiMessages({
			globalStoragePath: storage,
			taskId: "parent",
			messages: [{ role: "user", content: "original" }],
		})
		await bindTargetPersistence(storage, "parent", action)
		const lease = await new ParentHandoffFence(storage).acquire("parent")
		try {
			await expect(
				saveApiMessages({
					globalStoragePath: storage,
					taskId: "parent",
					messages: [{ role: "user", content: "stale" }],
				}),
			).rejects.toThrow()
			await expect(second.upsert({ ...item("parent"), task: "late" })).rejects.toThrow()
			await expect(
				second.updateQuestion("parent", (current) => ({ ...current, pendingQuestion: undefined })),
			).rejects.toThrow()
			await expect(second.delete("parent")).rejects.toThrow()
			await second.upsert({ ...item("other"), task: "continues" })
			expect((await readApiMessages({ globalStoragePath: storage, taskId: "parent" }))[0].content).toBe(
				"original",
			)
			expect((await first.readAuthoritative("parent")).kind).toBe("found")
		} finally {
			await lease.release()
		}
	} finally {
		first.dispose()
		second.dispose()
		await fs.rm(storage, { recursive: true, force: true })
	}
})

it("canonicalizes a root alias and refuses a bound target while allowing another parent's question", async () => {
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), "target-alias-"))
	const alias = `${storage}-alias`
	const first = new TaskHistoryStore(storage)
	const second = new TaskHistoryStore(alias)
	try {
		await fs.symlink(storage, alias)
		await first.initialize()
		await first.upsert(item("parent"))
		await first.upsert(item("other"))
		await second.initialize()
		await bindTargetPersistence(storage, "parent", action)
		const lease = await new ParentHandoffFence(alias).acquire("parent")
		try {
			await expect(second.deleteMany(["other", "parent"])).rejects.toThrow()
			expect((await first.readAuthoritative("other")).kind).toBe("found")
			await second.updateQuestion("other", (current) => ({
				...current,
				pendingQuestion: { id: "q", taskId: "other", toolCallId: "call", text: "ordinary" },
			}))
			expect((await first.readAuthoritative("other")).kind).toBe("found")
			await expect(
				saveApiMessages({ globalStoragePath: alias, taskId: "parent", messages: [] }),
			).rejects.toThrow()
		} finally {
			await lease.release()
		}
	} finally {
		first.dispose()
		second.dispose()
		await fs.rm(alias, { force: true })
		await fs.rm(storage, { recursive: true, force: true })
	}
})

it.each(["action", "owner", "question"] as const)(
	"rejects changed %s at the task and API final effects",
	async (change) => {
		const storage = await fs.mkdtemp(path.join(os.tmpdir(), "target-changed-"))
		const first = new TaskHistoryStore(storage)
		const second = new TaskHistoryStore(storage)
		try {
			await first.initialize()
			await first.upsert(item("parent"))
			await second.initialize()
			await saveApiMessages({
				globalStoragePath: storage,
				taskId: "parent",
				messages: [{ role: "user", content: "original" }],
			})
			await bindTargetPersistence(storage, "parent", action)
			const file = path.join(storage, "tasks", "parent", "history_item.json")
			const changed: HistoryItem = {
				...item("parent"),
				...(change === "action"
					? { pendingAction: { ...action, approvalText: "new" } }
					: change === "owner"
						? { awaitingChildId: "child" }
						: { pendingQuestion: { id: "q", taskId: "parent", toolCallId: "call", text: "question" } }),
			}
			await fs.writeFile(file, JSON.stringify(changed))
			await expect(second.upsert(item("parent"))).rejects.toThrow()
			await expect(
				saveApiMessages({ globalStoragePath: storage, taskId: "parent", messages: [] }),
			).rejects.toThrow()
			expect(JSON.parse(await fs.readFile(file, "utf8"))).toMatchObject(changed)
		} finally {
			first.dispose()
			second.dispose()
			await fs.rm(storage, { recursive: true, force: true })
		}
	},
)

it("rejects a lost generation at a paused task final effect", async () => {
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), "target-generation-"))
	const store = new TaskHistoryStore(storage)
	try {
		await store.initialize()
		await store.upsert(item("parent"))
		await bindTargetPersistence(storage, "parent", action)
		const original = store["writeTaskFile"].bind(store)
		let arrived!: () => void
		let resume!: () => void
		const reached = new Promise<void>((resolve) => {
			arrived = resolve
		})
		const resumed = new Promise<void>((resolve) => {
			resume = resolve
		})
		Reflect.set(store, "writeTaskFile", async (value: HistoryItem, delta?: Partial<HistoryItem>) => {
			arrived()
			await resumed
			return original(value, delta)
		})
		const pending = store.upsert({ ...item("parent"), task: "late" })
		const assertion = expect(pending).rejects.toThrow()
		await Promise.race([
			reached,
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("write did not reach pause")), 1000)),
		])
		const fences = path.join(storage, ".handoff-fences")
		const generation = path.join(fences, `${crypto.createHash("sha256").update("parent").digest("hex")}.generation`)
		await fs.writeFile(generation, "99")
		resume()
		await assertion
		expect(
			JSON.parse(await fs.readFile(path.join(storage, "tasks", "parent", "history_item.json"), "utf8")).task,
		).toBe("parent")
	} finally {
		store.dispose()
		await fs.rm(storage, { recursive: true, force: true })
	}
})

it("refuses a legacy API migration for a bound parent but retains ordinary migration", async () => {
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), "target-migration-"))
	const store = new TaskHistoryStore(storage)
	try {
		await store.initialize()
		await store.upsert(item("parent"))
		await store.upsert(item("other"))
		for (const id of ["parent", "other"])
			await fs.writeFile(
				path.join(storage, "tasks", id, "claude_messages.json"),
				JSON.stringify([{ role: "user", content: id }]),
			)
		await bindTargetPersistence(storage, "parent", action)
		await expect(readApiMessages({ globalStoragePath: storage, taskId: "parent" })).rejects.toThrow()
		expect(await fs.readdir(path.join(storage, "tasks", "parent"))).toContain("claude_messages.json")
		expect((await readApiMessages({ globalStoragePath: storage, taskId: "other" }))[0].content).toBe("other")
	} finally {
		store.dispose()
		await fs.rm(storage, { recursive: true, force: true })
	}
})

it("refuses startup delegation reconciliation's internal target write", async () => {
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), "target-startup-"))
	const first = new TaskHistoryStore(storage)
	const second = new TaskHistoryStore(storage)
	try {
		await first.initialize()
		await first.upsert(item("parent"))
		const file = path.join(storage, "tasks", "parent", "history_item.json")
		const delegated = { ...item("parent"), status: "delegated" }
		await fs.writeFile(file, JSON.stringify(delegated))
		await bindTargetPersistence(storage, "parent", action)
		await second.initialize()
		expect(JSON.parse(await fs.readFile(file, "utf8"))).toMatchObject({
			status: "delegated",
			pendingAction: action,
		})
	} finally {
		first.dispose()
		second.dispose()
		await fs.rm(storage, { recursive: true, force: true })
	}
})

it("excludes binding while an ordinary API replacement waits for its file lock, then refuses stale saves", async () => {
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), "target-paused-api-"))
	const store = new TaskHistoryStore(storage)
	let release!: () => void
	try {
		await store.initialize()
		await store.upsert(item("parent"))
		await saveApiMessages({
			globalStoragePath: storage,
			taskId: "parent",
			messages: [{ role: "user", content: "original" }],
		})
		// Hold the real advisory file lock while the ordinary save queues behind it.
		const lockfile = await import("proper-lockfile")
		release = await lockfile.lock(path.join(storage, "tasks", "parent", "api_conversation_history.json"), {
			realpath: false,
		})
		const pending = saveApiMessages({
			globalStoragePath: storage,
			taskId: "parent",
			messages: [{ role: "user", content: "stale" }],
		})
		await waitForParentLease(storage)
		await expect(bindTargetPersistence(storage, "parent", action)).rejects.toThrow(/parent/i)
		await release()
		release = undefined!
		await pending
		await bindTargetPersistence(storage, "parent", action)
		await expect(
			saveApiMessages({
				globalStoragePath: storage,
				taskId: "parent",
				messages: [{ role: "user", content: "original" }],
			}),
		).rejects.toThrow()
		expect((await readApiMessages({ globalStoragePath: storage, taskId: "parent" }))[0].content).toBe("stale")
	} finally {
		if (release) await release()
		store.dispose()
		await fs.rm(storage, { recursive: true, force: true })
	}
})

it("refuses a new full action, question, and API replacement without a competing lease", async () => {
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), "target-output-"))
	const first = new TaskHistoryStore(storage)
	const second = new TaskHistoryStore(storage)
	try {
		await first.initialize()
		await first.upsert(item("parent"))
		await second.initialize()
		await saveApiMessages({
			globalStoragePath: storage,
			taskId: "parent",
			messages: [{ role: "user", content: "original" }],
		})
		await bindTargetPersistence(storage, "parent", action)
		await expect(
			second.atomicReadAndUpdate("parent", (current) => ({
				...current,
				pendingAction: { ...action, message: "changed" },
			})),
		).rejects.toThrow()
		await expect(
			second.updateQuestion("parent", (current) => ({
				...current,
				pendingQuestion: { id: "q", taskId: "parent", toolCallId: "call", text: "question" },
			})),
		).rejects.toThrow()
		await expect(second.delete("parent")).rejects.toThrow()
		await expect(second.deleteMany(["parent"])).rejects.toThrow()
		await expect(saveApiMessages({ globalStoragePath: storage, taskId: "parent", messages: [] })).rejects.toThrow()
		expect((await first.readAuthoritative("parent")).kind).toBe("found")
		expect((await readApiMessages({ globalStoragePath: storage, taskId: "parent" }))[0].content).toBe("original")
	} finally {
		first.dispose()
		second.dispose()
		await fs.rm(storage, { recursive: true, force: true })
	}
})

it("rejects the target side of a paired update before either record is written", async () => {
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), "target-pair-"))
	const first = new TaskHistoryStore(storage)
	const second = new TaskHistoryStore(storage)
	try {
		await first.initialize()
		await first.upsert(item("parent"))
		await first.upsert(item("other"))
		await second.initialize()
		await bindTargetPersistence(storage, "parent", action)
		await expect(
			second.atomicUpdatePair(
				"other",
				"parent",
				(other) => ({ ...other, task: "changed" }),
				(parent) => ({
					...parent,
					pendingAction: { ...action, todos: [{ id: "new", content: "new", status: "pending" }] },
				}),
			),
		).rejects.toThrow()
		expect(await first.readAuthoritative("other")).toMatchObject({ kind: "found", item: { task: "other" } })
		expect(await first.readAuthoritative("parent")).toMatchObject({
			kind: "found",
			item: { pendingAction: action },
		})
	} finally {
		first.dispose()
		second.dispose()
		await fs.rm(storage, { recursive: true, force: true })
	}
})

it("rejects a changed API snapshot under the final file lock, with the target metadata untouched", async () => {
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), "target-api-changed-"))
	const store = new TaskHistoryStore(storage)
	try {
		await store.initialize()
		await store.upsert(item("parent"))
		await saveApiMessages({
			globalStoragePath: storage,
			taskId: "parent",
			messages: [{ role: "user", content: "original" }],
		})
		await bindTargetPersistence(storage, "parent", action)
		const file = path.join(storage, "tasks", "parent", "api_conversation_history.json")
		await fs.writeFile(file, JSON.stringify([{ role: "user", content: "later" }]))
		await expect(
			saveApiMessages({
				globalStoragePath: storage,
				taskId: "parent",
				messages: [{ role: "user", content: "original" }],
			}),
		).rejects.toThrow()
		expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual([{ role: "user", content: "later" }])
	} finally {
		store.dispose()
		await fs.rm(storage, { recursive: true, force: true })
	}
})

it("excludes binding through an ordinary task save and refuses a stale protected update after binding", async () => {
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), "target-late-task-"))
	const store = new TaskHistoryStore(storage)
	let resume!: () => void
	try {
		await store.initialize()
		await store.upsert(item("parent"))
		let arrived!: () => void
		const reached = new Promise<void>((resolve) => {
			arrived = resolve
		})
		const resumed = new Promise<void>((resolve) => {
			resume = resolve
		})
		const original = store["writeTaskFile"].bind(store)
		Reflect.set(store, "writeTaskFile", async (value: HistoryItem, delta?: Partial<HistoryItem>) => {
			arrived()
			await resumed
			return original(value, delta)
		})
		const pending = store.upsert({ ...item("parent"), task: "stale" })
		await reached
		await expect(bindTargetPersistence(storage, "parent", action)).rejects.toThrow(/parent/i)
		resume()
		await pending
		await bindTargetPersistence(storage, "parent", action)
		await expect(
			store.upsert({ ...item("parent"), pendingAction: { ...action, message: "stale action" } }),
		).rejects.toThrow()
		expect(
			JSON.parse(await fs.readFile(path.join(storage, "tasks", "parent", "history_item.json"), "utf8")).task,
		).toBe("stale")
	} finally {
		resume?.()
		store.dispose()
		await fs.rm(storage, { recursive: true, force: true })
	}
})

it("excludes binding while deletion waits for its file lock and refuses forced generation loss", async () => {
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), "target-late-delete-"))
	const store = new TaskHistoryStore(storage)
	let release: (() => Promise<void>) | undefined
	try {
		await store.initialize()
		await store.upsert(item("parent"))
		const file = path.join(storage, "tasks", "parent", "history_item.json")
		const lockfile = await import("proper-lockfile")
		release = await lockfile.lock(file, { realpath: false })
		const pending = store.delete("parent")
		const rejected = expect(pending).rejects.toThrow()
		await waitForParentLease(storage)
		await expect(bindTargetPersistence(storage, "parent", action)).rejects.toThrow(/parent/i)
		const crypto = await import("crypto")
		const key = crypto.createHash("sha256").update("parent").digest("hex")
		await fs.writeFile(path.join(storage, ".handoff-fences", `${key}.generation`), "999")
		await release()
		release = undefined
		await rejected
		expect(JSON.parse(await fs.readFile(file, "utf8"))).toMatchObject({ id: "parent", pendingAction: action })
	} finally {
		await release?.()
		store.dispose()
		await fs.rm(storage, { recursive: true, force: true })
	}
})

it("refuses acquiring parent exclusion from inside a store write-through callback", async () => {
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), "target-lock-order-"))
	const setup = new TaskHistoryStore(storage)
	try {
		await setup.initialize()
		await setup.upsert(item("parent"))
		await setup.upsert(item("other"))
		await saveApiMessages({
			globalStoragePath: storage,
			taskId: "parent",
			messages: [{ role: "user", content: "original" }],
		})
		await bindTargetPersistence(storage, "parent", action)
		const store = new TaskHistoryStore(storage, {
			onWrite: async () => {
				await saveApiMessages({ globalStoragePath: storage, taskId: "parent", messages: [] })
			},
		})
		try {
			await store.initialize()
			await expect(store.upsert({ ...item("other"), task: "unrelated" })).rejects.toThrow("inside store mutex")
			expect((await readApiMessages({ globalStoragePath: storage, taskId: "parent" }))[0].content).toBe(
				"original",
			)
		} finally {
			store.dispose()
		}
	} finally {
		setup.dispose()
		await fs.rm(storage, { recursive: true, force: true })
	}
})

async function waitForParentLease(storage: string): Promise<void> {
	const crypto = await import("crypto")
	const key = crypto.createHash("sha256").update("parent").digest("hex")
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			await fs.access(path.join(storage, ".handoff-fences", `${key}.lock`, "owner.json"))
			return
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 5))
	}
	throw new Error("Parent lease was not acquired")
}
