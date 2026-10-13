import * as fs from "fs/promises"
import * as crypto from "crypto"
import * as os from "os"
import * as path from "path"
import { vi } from "vitest"
import type { HistoryItem } from "@roo-code/types"
import { TaskHistoryStore } from "../TaskHistoryStore"
import { bindTargetPersistence } from "../targetPersistenceBoundary"

const renameGate = vi.hoisted(() => ({
	before: undefined as undefined | ((from: string, to: string) => Promise<void>),
	afterRead: undefined as undefined | ((file: string) => Promise<void>),
}))
vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	return {
		...actual,
		readFile: async (...args: Parameters<typeof actual.readFile>) => {
			const result = await actual.readFile(...args)
			await renameGate.afterRead?.(String(args[0]))
			return result
		},
		rename: async (from: string, to: string) => {
			await renameGate.before?.(from, to)
			return actual.rename(from, to)
		},
	}
})

const action = {
	kind: "create_subtask" as const,
	actionId: "old",
	mode: "code",
	message: "work",
	todos: [],
	approvalText: "work",
}
const item = (id: string, changes: Partial<HistoryItem> = {}): HistoryItem => ({
	id,
	number: 1,
	ts: 1,
	task: id,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	childIds: [],
	...changes,
})

it("refuses bound-parent startup intent before either record effect while reconciling another parent", async () => {
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), "b1-startup-quarantine-"))
	const store = new TaskHistoryStore(storage)
	const tasks = path.join(storage, "tasks")
	const parent = item("parent", {
		status: "delegated",
		pendingAction: action,
		awaitingChildId: "child",
		childIds: ["child"],
	})
	const child = item("child", { status: "active", parentTaskId: "parent" })
	const other = item("other", { status: "delegated", awaitingChildId: "missing" })
	const intent = {
		version: 1,
		operationId: "repair",
		parentTaskId: "parent",
		childTaskId: "child",
		expected: {
			parent: { status: "delegated", awaitingChildId: "child" },
			child: { status: "active", parentTaskId: "parent" },
		},
		target: { childStatus: "interrupted", parentStatus: "active" },
	}
	const intentPath = path.join(tasks, "_delegation_repair_intent.json")
	try {
		for (const record of [parent, child, other]) {
			const dir = path.join(tasks, record.id)
			await fs.mkdir(dir, { recursive: true })
			await fs.writeFile(path.join(dir, "history_item.json"), JSON.stringify(record))
		}
		await bindTargetPersistence(storage, "parent", action)
		await fs.writeFile(intentPath, JSON.stringify(intent))
		await store.initialize()
		const read = async (id: string): Promise<HistoryItem> =>
			JSON.parse(await fs.readFile(path.join(tasks, id, "history_item.json"), "utf8"))
		expect(await read("parent")).toEqual(parent)
		expect(await read("child")).toEqual(child)
		expect(JSON.parse(await fs.readFile(intentPath, "utf8"))).toEqual(intent)
		expect((await read("other")).status).toBe("active")
	} finally {
		store.dispose()
		await fs.rm(storage, { recursive: true, force: true })
	}
})

it("refuses to publish a fresh active-child repair intent for a bound parent", async () => {
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), "b1-startup-active-child-"))
	const store = new TaskHistoryStore(storage)
	const tasks = path.join(storage, "tasks")
	const parent = item("parent", {
		status: "delegated",
		pendingAction: action,
		awaitingChildId: "child",
		childIds: ["child"],
	})
	const child = item("child", { status: "active", parentTaskId: "parent" })
	try {
		for (const record of [parent, child]) {
			const dir = path.join(tasks, record.id)
			await fs.mkdir(dir, { recursive: true })
			await fs.writeFile(path.join(dir, "history_item.json"), JSON.stringify(record))
		}
		await bindTargetPersistence(storage, "parent", action)
		await store.initialize()
		for (const record of [parent, child]) {
			expect(JSON.parse(await fs.readFile(path.join(tasks, record.id, "history_item.json"), "utf8"))).toEqual(
				record,
			)
		}
		await expect(fs.access(path.join(tasks, "_delegation_repair_intent.json"))).rejects.toMatchObject({
			code: "ENOENT",
		})
	} finally {
		store.dispose()
		await fs.rm(storage, { recursive: true, force: true })
	}
})

it.each(["{not-json", JSON.stringify({ version: 1, parentTaskId: "parent" })])(
	"preserves ambiguous startup intent for a bound parent without blocking another parent (%s)",
	async (contents) => {
		const storage = await fs.mkdtemp(path.join(os.tmpdir(), "b1-ambiguous-intent-"))
		const store = new TaskHistoryStore(storage)
		const tasks = path.join(storage, "tasks")
		const intentPath = path.join(tasks, "_delegation_repair_intent.json")
		const parent = item("parent", { status: "interrupted", pendingAction: action })
		const other = item("other", { status: "delegated", awaitingChildId: "missing" })
		try {
			for (const record of [parent, other]) {
				const dir = path.join(tasks, record.id)
				await fs.mkdir(dir, { recursive: true })
				await fs.writeFile(path.join(dir, "history_item.json"), JSON.stringify(record))
			}
			await bindTargetPersistence(storage, "parent", action)
			await fs.writeFile(intentPath, contents)
			await store.initialize()
			expect(await fs.readFile(intentPath, "utf8")).toBe(contents)
			expect(JSON.parse(await fs.readFile(path.join(tasks, "parent", "history_item.json"), "utf8"))).toEqual(
				parent,
			)
			expect(JSON.parse(await fs.readFile(path.join(tasks, "other", "history_item.json"), "utf8")).status).toBe(
				"active",
			)
			const entries = await fs.readdir(tasks)
			expect(entries.some((entry) => entry.includes(".quarantine-"))).toBe(false)
		} finally {
			store.dispose()
			await fs.rm(storage, { recursive: true, force: true })
		}
	},
)

it("refuses binding during malformed-intent decision and retains ambiguous bytes; unrelated repair proceeds", async () => {
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), "b1-intent-bind-race-"))
	const store = new TaskHistoryStore(storage)
	const tasks = path.join(storage, "tasks")
	const intentPath = path.join(tasks, "_delegation_repair_intent.json")
	let arrived!: () => void
	let resume!: () => void
	const reached = new Promise<void>((resolve) => (arrived = resolve))
	const resumed = new Promise<void>((resolve) => (resume = resolve))
	let startup: Promise<void> | undefined
	try {
		for (const record of [
			item("parent", { status: "interrupted", pendingAction: action }),
			item("other", { status: "delegated", awaitingChildId: "missing" }),
		]) {
			const dir = path.join(tasks, record.id)
			await fs.mkdir(dir, { recursive: true })
			await fs.writeFile(path.join(dir, "history_item.json"), JSON.stringify(record))
		}
		await fs.writeFile(intentPath, "{not-json")
		renameGate.afterRead = async (file) => {
			if (file === intentPath) {
				arrived()
				await resumed
			}
		}
		try {
			startup = store.initialize()
			await reached
			await expect(bindTargetPersistence(storage, "parent", action)).rejects.toThrow()
			const fences = await fs.readdir(path.join(storage, ".handoff-fences"))
			expect(fences.some((name) => name.endsWith(".target.json"))).toBe(false)
			resume()
			await startup
			expect((await fs.readdir(tasks)).some((name) => name.includes(".quarantine-"))).toBe(false)
			expect(await fs.readFile(intentPath, "utf8")).toBe("{not-json")
			expect(JSON.parse(await fs.readFile(path.join(tasks, "other", "history_item.json"), "utf8")).status).toBe(
				"active",
			)
			await expect(bindTargetPersistence(storage, "parent", action)).rejects.toThrow("unresolved")
		} finally {
			resume()
			await startup
			renameGate.afterRead = undefined
		}
	} finally {
		store.dispose()
		await fs.rm(storage, { recursive: true, force: true })
	}
})

it("preserves malformed intent when a bound parent is absent from a second store cache", async () => {
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), "b1-absent-cache-"))
	const first = new TaskHistoryStore(storage)
	const second = new TaskHistoryStore(storage)
	const tasks = path.join(storage, "tasks")
	try {
		await first.initialize()
		for (const record of [
			item("parent", { status: "interrupted", pendingAction: action }),
			item("other", { status: "delegated", awaitingChildId: "missing" }),
		]) {
			await fs.mkdir(path.join(tasks, record.id), { recursive: true })
			await fs.writeFile(path.join(tasks, record.id, "history_item.json"), JSON.stringify(record))
		}
		await bindTargetPersistence(storage, "parent", action)
		await fs.rename(path.join(tasks, "parent"), path.join(tasks, "_temporarily-hidden-parent"))
		const intent = path.join(tasks, "_delegation_repair_intent.json")
		await fs.writeFile(intent, "{not-json")
		expect(second.get("parent")).toBeUndefined()
		await second.initialize()
		expect(second.get("parent")).toBeUndefined()
		expect(await fs.readFile(intent, "utf8")).toBe("{not-json")
		expect(JSON.parse(await fs.readFile(path.join(tasks, "other", "history_item.json"), "utf8")).status).toBe(
			"active",
		)
	} finally {
		first.dispose()
		second.dispose()
		await fs.rm(storage, { recursive: true, force: true })
	}
})

it.each(["{not-json", JSON.stringify({ version: 1, parentTaskId: "parent", childTaskId: "child" })])(
	"refuses binding to existing intent evidence before startup (%s)",
	async (contents) => {
		const storage = await fs.mkdtemp(path.join(os.tmpdir(), "b1-intent-first-"))
		const tasks = path.join(storage, "tasks")
		try {
			await fs.mkdir(path.join(tasks, "parent"), { recursive: true })
			await fs.writeFile(
				path.join(tasks, "parent", "history_item.json"),
				JSON.stringify(item("parent", { status: "interrupted", pendingAction: action })),
			)
			const intent = path.join(tasks, "_delegation_repair_intent.json")
			await fs.writeFile(intent, contents)
			await expect(bindTargetPersistence(storage, "parent", action)).rejects.toThrow()
			expect(await fs.readFile(intent, "utf8")).toBe(contents)
			expect(
				(await fs.readdir(path.join(storage, ".handoff-fences"))).some((name) => name.endsWith(".target.json")),
			).toBe(false)
		} finally {
			await fs.rm(storage, { recursive: true, force: true })
		}
	},
)

it("refuses a successful binding followed by targeted malformed-intent quarantine across two stores", async () => {
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), "b1-binding-first-"))
	const first = new TaskHistoryStore(storage)
	const second = new TaskHistoryStore(storage)
	const tasks = path.join(storage, "tasks")
	try {
		await fs.mkdir(path.join(tasks, "parent"), { recursive: true })
		await fs.writeFile(
			path.join(tasks, "parent", "history_item.json"),
			JSON.stringify(item("parent", { status: "interrupted", pendingAction: action })),
		)
		await bindTargetPersistence(storage, "parent", action)
		const intent = path.join(tasks, "_delegation_repair_intent.json")
		await fs.writeFile(intent, "{not-json")
		await Promise.all([first.initialize(), second.initialize()])
		expect(await fs.readFile(intent, "utf8")).toBe("{not-json")
		expect((await fs.readdir(tasks)).some((name) => name.includes(".quarantine-"))).toBe(false)
	} finally {
		first.dispose()
		second.dispose()
		await fs.rm(storage, { recursive: true, force: true })
	}
})

it("lost startup admission before quarantine leaves the intent and no target authority", async () => {
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), "b1-lost-admission-"))
	const store = new TaskHistoryStore(storage)
	const tasks = path.join(storage, "tasks")
	const intent = path.join(tasks, "_delegation_repair_intent.json")
	let lost = false
	try {
		await fs.mkdir(path.join(tasks, "parent"), { recursive: true })
		await fs.writeFile(
			path.join(tasks, "parent", "history_item.json"),
			JSON.stringify(item("parent", { status: "interrupted", pendingAction: action })),
		)
		await fs.writeFile(intent, "{not-json")
		const generation = path.join(
			storage,
			".handoff-fences",
			`${crypto.createHash("sha256").update("\u0000startup-admission").digest("hex")}.generation`,
		)
		renameGate.afterRead = async (file) => {
			if (file === intent && !lost) {
				lost = true
				await fs.writeFile(generation, "99")
			}
		}
		await expect(store.initialize()).rejects.toThrow()
		expect(lost).toBe(true)
		expect(await fs.readFile(intent, "utf8")).toBe("{not-json")
		expect((await fs.readdir(tasks)).some((name) => name.includes(".quarantine-"))).toBe(false)
		expect(
			(await fs.readdir(path.join(storage, ".handoff-fences"))).some((name) => name.endsWith(".target.json")),
		).toBe(false)
	} finally {
		renameGate.afterRead = undefined
		store.dispose()
		await fs.rm(storage, { recursive: true, force: true })
	}
})

it("refuses binding publication if parent generation is lost after the API snapshot read", async () => {
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), "b1-binding-generation-"))
	const tasks = path.join(storage, "tasks")
	const apiFile = path.join(tasks, "parent", "api_conversation_history.json")
	let lost = false
	try {
		await fs.mkdir(path.dirname(apiFile), { recursive: true })
		await fs.writeFile(
			path.join(tasks, "parent", "history_item.json"),
			JSON.stringify(item("parent", { status: "interrupted", pendingAction: action })),
		)
		await fs.writeFile(apiFile, JSON.stringify([{ role: "user", content: "prior" }]))
		const generation = path.join(
			storage,
			".handoff-fences",
			`${crypto.createHash("sha256").update("parent").digest("hex")}.generation`,
		)
		renameGate.afterRead = async (file) => {
			if (file === apiFile && !lost) {
				lost = true
				await fs.writeFile(generation, "99")
			}
		}
		await expect(bindTargetPersistence(storage, "parent", action)).rejects.toThrow()
		expect(lost).toBe(true)
		expect(
			(await fs.readdir(path.join(storage, ".handoff-fences"))).some((name) => name.endsWith(".target.json")),
		).toBe(false)
	} finally {
		renameGate.afterRead = undefined
		await fs.rm(storage, { recursive: true, force: true })
	}
})

it("refuses binding behind a complete valid target intent while repairing an unrelated parent", async () => {
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), "b1-valid-intent-first-"))
	const store = new TaskHistoryStore(storage)
	const tasks = path.join(storage, "tasks")
	const intent = path.join(tasks, "_delegation_repair_intent.json")
	const parent = item("parent", {
		status: "delegated",
		pendingAction: action,
		awaitingChildId: "child",
		childIds: ["child"],
	})
	const child = item("child", { status: "active", parentTaskId: "parent" })
	try {
		for (const record of [parent, child, item("other", { status: "delegated", awaitingChildId: "missing" })]) {
			await fs.mkdir(path.join(tasks, record.id), { recursive: true })
			await fs.writeFile(path.join(tasks, record.id, "history_item.json"), JSON.stringify(record))
		}
		await fs.writeFile(
			intent,
			JSON.stringify({
				version: 1,
				operationId: "valid",
				parentTaskId: "parent",
				childTaskId: "child",
				expected: {
					parent: { status: "delegated", awaitingChildId: "child" },
					child: { status: "active", parentTaskId: "parent" },
				},
				target: { childStatus: "interrupted", parentStatus: "active" },
			}),
		)
		await expect(bindTargetPersistence(storage, "parent", action)).rejects.toThrow("unresolved")
		expect(
			(await fs.readdir(path.join(storage, ".handoff-fences"))).some((name) => name.endsWith(".target.json")),
		).toBe(false)
		await store.initialize()
		expect(JSON.parse(await fs.readFile(path.join(tasks, "other", "history_item.json"), "utf8")).status).toBe(
			"active",
		)
		// No successful binding was published: normal repair remains authoritative.
		expect(JSON.parse(await fs.readFile(path.join(tasks, "child", "history_item.json"), "utf8")).status).toBe(
			"interrupted",
		)
	} finally {
		store.dispose()
		await fs.rm(storage, { recursive: true, force: true })
	}
})
