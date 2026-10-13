// Startup repair must not detach an active delegated child that another live store may be running.
// Regression: a second extension host (F5 dev host) started on shared storage reset a running pair
// to parent "active" / child "interrupted", so the child's completion failed with ownership_moved.
import { spawnSync } from "child_process"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { HistoryItem } from "@roo-code/types"

import { TaskHistoryStore } from "../TaskHistoryStore"
import {
	HOST_PRESENCE_DIRECTORY,
	findLivePeerHosts,
	publishHostPresence,
	releaseAllHostPresence,
} from "../hostPresence"
import { currentHolder } from "../parentHandoffFence"
import { GlobalFileNames } from "../../../shared/globalFileNames"

vi.mock("../../../utils/storage", () => ({
	getStorageBasePath: vi.fn().mockImplementation((defaultPath: string) => defaultPath),
}))

function item(overrides: Partial<HistoryItem> & { id: string }): HistoryItem {
	return { number: 1, ts: 1, task: overrides.id, tokensIn: 0, tokensOut: 0, totalCost: 0, ...overrides }
}

async function writeTask(storage: string, value: HistoryItem) {
	const directory = path.join(storage, "tasks", value.id)
	await fs.mkdir(directory, { recursive: true })
	await fs.writeFile(path.join(directory, GlobalFileNames.historyItem), JSON.stringify(value))
}

async function readTask(storage: string, id: string): Promise<HistoryItem> {
	return JSON.parse(await fs.readFile(path.join(storage, "tasks", id, GlobalFileNames.historyItem), "utf8"))
}

/** The running pair as the delegating host persists it. */
async function writeRunningPair(storage: string) {
	await writeTask(
		storage,
		item({ id: "parent", ts: 1000, status: "delegated", awaitingChildId: "child", delegatedToId: "child" }),
	)
	await writeTask(storage, item({ id: "child", ts: 2000, status: "active", parentTaskId: "parent" }))
}

async function writePresence(storage: string, name: string, contents: string) {
	await fs.mkdir(path.join(storage, HOST_PRESENCE_DIRECTORY), { recursive: true })
	await fs.writeFile(path.join(storage, HOST_PRESENCE_DIRECTORY, name), contents)
}

/** A pid that existed on this host and has exited (reaped by spawnSync). */
function exitedPid(): number {
	const pid = spawnSync(process.execPath, ["-e", ""]).pid
	if (!pid) throw new Error("could not spawn a short-lived process")
	return pid
}

describe("TaskHistoryStore startup repair with host presence", () => {
	let storage: string
	const stores: TaskHistoryStore[] = []

	const startStore = async () => {
		const store = new TaskHistoryStore(storage)
		stores.push(store)
		await store.initialize()
		return store
	}

	beforeEach(async () => {
		storage = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "history-presence-")))
		vi.spyOn(console, "warn").mockImplementation(() => undefined)
	})

	afterEach(async () => {
		for (const store of stores.splice(0)) store.dispose()
		vi.restoreAllMocks()
		await fs.rm(storage, { recursive: true, force: true })
	})

	it("leaves a running pair unchanged while the delegating store is still live", async () => {
		await startStore()
		// The live store delegates after its own startup, exactly like the reported incident.
		await writeRunningPair(storage)

		await startStore()

		expect(await readTask(storage, "parent")).toMatchObject({
			status: "delegated",
			awaitingChildId: "child",
			delegatedToId: "child",
		})
		expect((await readTask(storage, "child")).status).toBe("active")
		expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Left delegated parent parent"))
	})

	it("control: with no other store, startup repairs the orphaned active child", async () => {
		await writeRunningPair(storage)

		await startStore()

		const parent = await readTask(storage, "parent")
		expect(parent.status).toBe("active")
		expect(parent.awaitingChildId).toBeUndefined()
		expect((await readTask(storage, "child")).status).toBe("interrupted")
	})

	it("repairs at a later startup once no other store is live", async () => {
		const first = await startStore()
		await writeRunningPair(storage)
		const second = await startStore()
		expect((await readTask(storage, "child")).status).toBe("active")

		first.dispose()
		await startStore()
		// The second store is still live, so this startup must not repair either.
		expect((await readTask(storage, "child")).status).toBe("active")

		for (const store of stores.splice(0)) store.dispose()
		expect(second["hostPresence"]).toBeUndefined()
		await startStore()

		expect((await readTask(storage, "parent")).status).toBe("active")
		expect((await readTask(storage, "child")).status).toBe("interrupted")
	})

	it("ignores and removes a record whose process provably exited", async () => {
		const holder = currentHolder()
		if (!holder || holder.platform !== "linux") return // exit proof is only available on Linux
		const { startTime: _startTime, ...withoutStartTime } = holder
		await writePresence(
			storage,
			"crashed.json",
			JSON.stringify({
				schemaVersion: 1,
				token: "crashed",
				publishedAt: 1,
				holder: { ...withoutStartTime, pid: exitedPid() },
			}),
		)
		await writeRunningPair(storage)

		const store = await startStore()

		expect((await readTask(storage, "child")).status).toBe("interrupted")
		expect(await fs.readdir(path.join(storage, HOST_PRESENCE_DIRECTORY))).toEqual([
			`${store["hostPresence"]?.token}.json`,
		])
	})

	it.each([
		[
			"another machine",
			JSON.stringify({
				schemaVersion: 1,
				token: "remote",
				publishedAt: 1,
				holder: { pid: 1, hostname: "other-host", platform: "linux" },
			}),
		],
		["no holder identity", JSON.stringify({ schemaVersion: 1, token: "anonymous", publishedAt: 1 })],
		["a malformed record", "{not json"],
	])("treats a peer with %s as live", async (_case, contents) => {
		await writePresence(storage, "peer.json", contents)
		await writeRunningPair(storage)

		await startStore()

		expect((await readTask(storage, "parent")).status).toBe("delegated")
		expect((await readTask(storage, "child")).status).toBe("active")
		expect(await fs.readdir(path.join(storage, HOST_PRESENCE_DIRECTORY))).toContain("peer.json")
	})
})

describe("hostPresence records", () => {
	let storage: string

	beforeEach(async () => {
		storage = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "presence-")))
	})

	afterEach(async () => {
		await fs.rm(storage, { recursive: true, force: true })
	})

	it("publishes one complete record, excludes its own token, and removes it on release", async () => {
		const own = await publishHostPresence(storage)
		const peer = await publishHostPresence(storage)

		expect(await findLivePeerHosts(storage, own.token)).toEqual([
			path.join(storage, HOST_PRESENCE_DIRECTORY, `${peer.token}.json`),
		])
		const names = await fs.readdir(path.join(storage, HOST_PRESENCE_DIRECTORY))
		expect(names.sort()).toEqual([`${own.token}.json`, `${peer.token}.json`].sort())

		peer.release()
		peer.release()
		expect(await findLivePeerHosts(storage, own.token)).toEqual([])
		own.release()
		expect(await fs.readdir(path.join(storage, HOST_PRESENCE_DIRECTORY))).toEqual([])
	})

	it("removes every record this process still holds on process exit, even without dispose", async () => {
		const released = await publishHostPresence(storage)
		await publishHostPresence(storage)
		await publishHostPresence(storage)
		released.release()

		// Shutdown never disposes the sidebar provider; the exit hook is the normal-close cleanup.
		expect(process.listeners("exit")).toContain(releaseAllHostPresence)
		releaseAllHostPresence()
		releaseAllHostPresence()

		expect(await fs.readdir(path.join(storage, HOST_PRESENCE_DIRECTORY))).toEqual([])
	})

	it("ignores an unfinished temporary file and a missing directory", async () => {
		expect(await findLivePeerHosts(storage, undefined)).toEqual([])
		await writePresence(storage, "x.json.123.tmp", "{")
		expect(await findLivePeerHosts(storage, undefined)).toEqual([])
	})

	it("releases immediately when the store was disposed before publication finished", async () => {
		const store = new TaskHistoryStore(storage)
		const starting = store.initialize()
		store.dispose()
		await starting

		expect(store["hostPresence"]).toBeUndefined()
		expect(await fs.readdir(path.join(storage, HOST_PRESENCE_DIRECTORY))).toEqual([])
	})
})
