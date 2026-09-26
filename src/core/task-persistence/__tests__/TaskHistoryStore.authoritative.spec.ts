import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { HistoryItem } from "@roo-code/types"
import { TaskHistoryStore } from "../TaskHistoryStore"
import { GlobalFileNames } from "../../../shared/globalFileNames"

const item = (id: string): HistoryItem => ({
	id,
	number: 1,
	ts: 1,
	task: id,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	status: "active",
})

describe("authoritative metadata with real files", () => {
	let directory: string
	let stores: TaskHistoryStore[]
	const filename = (id: string) => path.join(directory, "tasks", id, GlobalFileNames.historyItem)
	const create = () => {
		const store = new TaskHistoryStore(directory)
		stores.push(store)
		return store
	}
	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "authoritative-history-"))
		stores = []
	})
	afterEach(async () => {
		for (const store of stores) store.dispose()
		vi.restoreAllMocks()
		await fs.rm(directory, { recursive: true, force: true })
	})

	it("waits for initialization before authoritative reads and pair updaters", async () => {
		const seed = create()
		await seed.initialize()
		await seed.upsert(item("a"))
		await seed.upsert(item("b"))
		seed.dispose()
		const store = create()
		const updater = vi.fn((current: HistoryItem) => ({ ...current, mode: "code" }))
		let readFinished = false
		const read = store.readAuthoritative("a").then((result) => {
			readFinished = true
			return result
		})
		const pair = store.atomicUpdatePair("a", "b", updater, updater)
		await new Promise((resolve) => setImmediate(resolve))
		expect(readFinished).toBe(false)
		expect(updater).not.toHaveBeenCalled()
		await store.initialize()
		expect(await read).toMatchObject({ kind: "found", item: { id: "a" } })
		await pair
		expect(updater).toHaveBeenCalledTimes(2)
	})

	it("refreshes both stale records before updater ownership revalidation", async () => {
		const a = create()
		await a.initialize()
		await a.upsert({ ...item("parent"), awaitingChildId: "child" })
		await a.upsert(item("child"))
		const b = create()
		await b.initialize()
		b.dispose()
		a.dispose()
		await a.upsert({ ...item("parent"), awaitingChildId: "sibling" })
		await a.upsert({ ...item("child"), mode: "architect" })
		expect(b.get("parent")?.awaitingChildId).toBe("child")
		const first = vi.fn((current: HistoryItem) => {
			expect(current.mode).toBe("architect")
			return { ...current, totalCost: 7 }
		})
		await expect(
			b.atomicUpdatePair("child", "parent", first, (current) => {
				if (current.awaitingChildId !== "child") throw new Error("ownership moved")
				return current
			}),
		).rejects.toThrow("ownership moved")
		expect(first).toHaveBeenCalledOnce()
		expect(JSON.parse(await fs.readFile(filename("child"), "utf8")).totalCost).toBe(0)
		expect(await b.readAuthoritative("parent")).toMatchObject({
			kind: "found",
			item: { awaitingChildId: "sibling" },
		})
	})

	it.each(["missing", "parse", "identity", "io"])(
		"does not fall back to cached metadata after %s failure",
		async (failure) => {
			const store = create()
			await store.initialize()
			await store.upsert(item("a"))
			await store.upsert(item("b"))
			store.dispose()
			if (failure === "missing") await fs.unlink(filename("a"))
			if (failure === "parse") await fs.writeFile(filename("a"), "{")
			if (failure === "identity") await fs.writeFile(filename("a"), JSON.stringify(item("wrong")))
			if (failure === "io") {
				await fs.unlink(filename("a"))
				await fs.mkdir(filename("a"))
			}
			expect(store.get("a")).toBeDefined()
			const result = await store.readAuthoritative("a")
			expect(result.kind).toBe(failure === "missing" ? "missing" : "read_error")
			if (failure === "parse" && result.kind === "read_error") expect(result.error).toBeInstanceOf(SyntaxError)
			if (failure === "io" && result.kind === "read_error") expect(result.error).toMatchObject({ code: "EISDIR" })
			const updater = vi.fn((current: HistoryItem) => current)
			await expect(store.atomicUpdatePair("b", "a", updater, updater)).rejects.toThrow()
			expect(updater).not.toHaveBeenCalled()
			expect(JSON.parse(await fs.readFile(filename("b"), "utf8"))).toEqual(item("b"))
		},
	)

	it("serializes authoritative reads behind a pair and exposes an honest partial commit on second-write failure", async () => {
		const store = create()
		await store.initialize()
		await store.upsert(item("a"))
		await store.upsert(item("b"))
		store.dispose()
		const original = store["writeTaskFile"].bind(store)
		let entered!: () => void
		let release!: () => void
		const blocked = new Promise<void>((resolve) => {
			entered = resolve
		})
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		// Expose only the private writer signature for this failure-injection spy.
		const writer = store as unknown as { writeTaskFile: typeof original }
		vi.spyOn(writer, "writeTaskFile").mockImplementation(async (...args) => {
			if (args[0].id === "b") {
				entered()
				await gate
				throw new Error("second write failed")
			}
			return original(...args)
		})
		const pair = store.atomicUpdatePair(
			"a",
			"b",
			(current) => ({ ...current, totalCost: 9 }),
			(current) => ({ ...current, totalCost: 9 }),
		)
		const rejection = expect(pair).rejects.toThrow("second write failed")
		await blocked
		let readFinished = false
		const read = store.readAuthoritative("a").then((result) => {
			readFinished = true
			return result
		})
		await new Promise((resolve) => setImmediate(resolve))
		expect(readFinished).toBe(false)
		release()
		await rejection
		expect(await read).toMatchObject({ kind: "found", item: { totalCost: 9 } })
		expect(store.get("a")?.totalCost).toBe(9)
		expect(store.get("b")?.totalCost).toBe(0)
		const restarted = create()
		await restarted.initialize()
		expect(restarted.get("a")?.totalCost).toBe(9)
		expect(restarted.get("b")?.totalCost).toBe(0)
	})

	it("rejects same-record pairs without running either updater", async () => {
		const store = create()
		await store.initialize()
		await store.upsert(item("a"))
		const updater = vi.fn((current: HistoryItem) => current)
		await expect(store.atomicUpdatePair("a", "a", updater, updater)).rejects.toThrow("distinct task ids")
		expect(updater).not.toHaveBeenCalled()
	})
})
