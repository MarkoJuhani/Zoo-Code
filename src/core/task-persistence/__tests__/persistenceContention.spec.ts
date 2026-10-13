// Case 19: a bounded fence wait that times out while ACQUIRING exclusion, because a live owner
// keeps the lock, is contention. It refuses that attempt (the effect never ran, nothing is
// published) but must not make the instance's ordinary persistence authority permanently
// refused. Authority loss (stale revision/lineage, ownership loss, filesystem refusal), an
// unrecoverable lock, and a timeout raised inside a started effect stay sticky.
import * as crypto from "crypto"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import type { HistoryItem } from "@roo-code/types"
import {
	advanceOrdinaryPersistenceAuthority,
	createOrdinaryTaskPersistenceAuthority,
	isPersistenceContentionError,
	isStickyPersistenceRefusal,
	OrdinaryPersistenceAuthorityError,
	withOrdinaryTaskPersistence,
} from "../targetPersistenceBoundary"
import {
	ParentHandoffFence,
	ParentHandoffFenceOwnershipError,
	ParentHandoffFenceUnavailableError,
} from "../parentHandoffFence"
import { TaskHistoryStore } from "../TaskHistoryStore"

/**
 * Production waits 30 s; a compressed bound keeps the same ordering. It must reach the fence's
 * 1 s minimum observation window, or an unrecoverable lock could only ever report "timeout".
 */
const COMPRESSED_FENCE_WAIT_MS = 1_200

const item = (id: string, overrides: Partial<HistoryItem> = {}): HistoryItem => ({
	id,
	number: 1,
	ts: 1,
	task: id,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	status: "active",
	childIds: [],
	...overrides,
})

const timeout = () => new ParentHandoffFenceUnavailableError("task", "timeout")
const wrap = (originalError: unknown) => Object.assign(new Error("final publication failed"), { originalError })

let storage: string
let store: TaskHistoryStore
const file = (id: string) => path.join(storage, "tasks", id, "history_item.json")

beforeEach(async () => {
	storage = await fs.mkdtemp(path.join(os.tmpdir(), "persistence-contention-"))
	store = new TaskHistoryStore(storage)
	await store.initialize()
	store.dispose() // No watcher may race the explicit disk assertions below.
	const acquire = ParentHandoffFence.prototype.acquire
	vi.spyOn(ParentHandoffFence.prototype, "acquire").mockImplementation(function (
		this: ParentHandoffFence,
		id,
		options = {},
	) {
		const timeoutMs = options.timeoutMs ? Math.min(options.timeoutMs, COMPRESSED_FENCE_WAIT_MS) : options.timeoutMs
		return acquire.call(this, id, { ...options, timeoutMs })
	})
})
afterEach(async () => {
	vi.restoreAllMocks()
	store.dispose()
	await fs.rm(storage, { recursive: true, force: true })
})

describe("persistence error classification", () => {
	it("treats a fence timeout, also when wrapped, as contention: non-sticky only before the effect starts", () => {
		for (const error of [timeout(), wrap(timeout()), wrap(wrap(timeout()))]) {
			expect(isPersistenceContentionError(error)).toBe(true)
			expect(isStickyPersistenceRefusal(error, false)).toBe(false)
			expect(isStickyPersistenceRefusal(error, true)).toBe(true)
		}
	})

	it.each([
		["filesystem refusal", new ParentHandoffFenceUnavailableError("task", "filesystem", "EIO")],
		["wrapped filesystem refusal", wrap(new ParentHandoffFenceUnavailableError("task", "filesystem", "EIO"))],
		["ownership loss", new ParentHandoffFenceOwnershipError("task")],
		[
			"an unrecoverable lock",
			new ParentHandoffFenceUnavailableError("task", "unrecoverable", undefined, "LEGACY_OWNER"),
		],
		["stale revision or lineage", new OrdinaryPersistenceAuthorityError("stale instance revision or lineage")],
		[
			"an explicit refusal that wraps a timeout",
			new OrdinaryPersistenceAuthorityError("Provider start ownership evidence lost", timeout()),
		],
	])("keeps %s sticky", (_name, error) => {
		expect(isPersistenceContentionError(error)).toBe(false)
		expect(isStickyPersistenceRefusal(error, false)).toBe(true)
		expect(isStickyPersistenceRefusal(error, true)).toBe(true)
	})

	it("classifies ordinary I/O as neither contention nor refusal", () => {
		const error = Object.assign(new Error("disk full"), { code: "ENOSPC" })
		expect(isPersistenceContentionError(error)).toBe(false)
		expect(isStickyPersistenceRefusal(error, false)).toBe(false)
		expect(isStickyPersistenceRefusal(error, true)).toBe(false)
	})
})

describe("withOrdinaryTaskPersistence contention", () => {
	it("refuses a contended attempt without publishing, keeps authority, and a later save succeeds", async () => {
		await store.upsert(item("task"))
		const authority = createOrdinaryTaskPersistenceAuthority(store.get("task")!)
		const before = await fs.readFile(file("task"))
		const effect = vi.fn(async () => {
			await store.upsert({ ...item("task"), tokensOut: 5 })
			return "saved"
		})

		const holder = await new ParentHandoffFence(storage).acquire("task")
		try {
			await expect(withOrdinaryTaskPersistence(storage, authority, effect)).rejects.toMatchObject({
				name: ParentHandoffFenceUnavailableError.name,
				reason: "timeout",
			})
		} finally {
			await holder.release()
		}

		expect(effect).not.toHaveBeenCalled()
		expect(authority.refused).toBe(false)
		expect(await fs.readFile(file("task"))).toEqual(before)

		await expect(withOrdinaryTaskPersistence(storage, authority, effect)).resolves.toBe("saved")
		expect(authority.refused).toBe(false)
		expect(JSON.parse(await fs.readFile(file("task"), "utf8")).tokensOut).toBe(5)
	})

	it("keeps a timeout raised inside a started effect sticky: the effect may already have written", async () => {
		await store.upsert(item("task"))
		const authority = createOrdinaryTaskPersistenceAuthority(store.get("task")!)
		const error = wrap(timeout())

		await expect(
			withOrdinaryTaskPersistence(storage, authority, async () => {
				throw error
			}),
		).rejects.toBe(error)
		expect(authority.refused).toBe(true)
		const later = vi.fn(async () => {})
		await expect(withOrdinaryTaskPersistence(storage, authority, later)).rejects.toThrow(
			"instance was previously refused",
		)
		expect(later).not.toHaveBeenCalled()
	})

	it("keeps a wrapped timeout during exclusion acquisition non-sticky", async () => {
		await store.upsert(item("task"))
		const authority = createOrdinaryTaskPersistenceAuthority(store.get("task")!)
		const error = wrap(timeout())
		vi.mocked(ParentHandoffFence.prototype.acquire).mockRejectedValueOnce(error)
		const effect = vi.fn(async () => "saved")

		await expect(withOrdinaryTaskPersistence(storage, authority, effect)).rejects.toBe(error)
		expect(effect).not.toHaveBeenCalled()
		expect(authority.refused).toBe(false)
		await expect(withOrdinaryTaskPersistence(storage, authority, effect)).resolves.toBe("saved")
	})

	it("makes an unrecoverable legacy lock sticky, so the next attempt fails fast without waiting", async () => {
		await store.upsert(item("task"))
		const authority = createOrdinaryTaskPersistenceAuthority(store.get("task")!)
		const before = await fs.readFile(file("task"))
		// A pre-holder (legacy) owner left by an old extension version: no waiter can ever acquire it.
		const lock = path.join(
			await fs.realpath(storage),
			".handoff-fences",
			`${crypto.createHash("sha256").update("task").digest("hex")}.lock`,
		)
		await fs.mkdir(lock, { recursive: true })
		await fs.writeFile(
			path.join(lock, "owner.json"),
			JSON.stringify({
				schemaVersion: 1,
				parentTaskId: "task",
				ownerToken: "legacy",
				generation: 3,
				acquiredAt: 1,
			}),
		)
		const effect = vi.fn(async () => {})

		await expect(withOrdinaryTaskPersistence(storage, authority, effect)).rejects.toMatchObject({
			name: ParentHandoffFenceUnavailableError.name,
			reason: "unrecoverable",
			diagnostic: "LEGACY_OWNER",
		})
		expect(authority.refused).toBe(true)

		const started = Date.now()
		await expect(withOrdinaryTaskPersistence(storage, authority, effect)).rejects.toThrow(
			"instance was previously refused",
		)
		expect(Date.now() - started).toBeLessThan(COMPRESSED_FENCE_WAIT_MS / 2)
		expect(effect).not.toHaveBeenCalled()
		expect(await fs.readFile(file("task"))).toEqual(before)
	})

	it.each([
		["filesystem refusal", () => new ParentHandoffFenceUnavailableError("task", "filesystem", "EIO")],
		["ownership loss", () => new ParentHandoffFenceOwnershipError("task")],
		["wrapped ownership loss", () => wrap(new ParentHandoffFenceOwnershipError("task"))],
	])("keeps %s sticky and blocks every later attempt", async (_name, create) => {
		await store.upsert(item("task"))
		const authority = createOrdinaryTaskPersistenceAuthority(store.get("task")!)
		const error = create()

		await expect(
			withOrdinaryTaskPersistence(storage, authority, async () => {
				throw error
			}),
		).rejects.toBe(error)
		expect(authority.refused).toBe(true)

		const later = vi.fn(async () => {})
		await expect(withOrdinaryTaskPersistence(storage, authority, later)).rejects.toThrow(
			"instance was previously refused",
		)
		expect(later).not.toHaveBeenCalled()
	})

	it("keeps a stale revision sticky without publishing", async () => {
		await store.upsert(item("task"))
		const authority = createOrdinaryTaskPersistenceAuthority(store.get("task")!)
		await store.atomicReadAndUpdate("task", (current) => advanceOrdinaryPersistenceAuthority(current))
		const before = await fs.readFile(file("task"))
		const effect = vi.fn(async () => {})

		await expect(withOrdinaryTaskPersistence(storage, authority, effect)).rejects.toThrow(
			"stale instance revision or lineage",
		)
		expect(effect).not.toHaveBeenCalled()
		expect(authority.refused).toBe(true)
		expect(await fs.readFile(file("task"))).toEqual(before)
	})

	it("keeps a stale lineage sticky without publishing", async () => {
		await store.upsert(item("child", { parentTaskId: "parent", rootTaskId: "parent" }))
		const authority = createOrdinaryTaskPersistenceAuthority(store.get("child")!)
		// Detach the child outside this instance's authority, keeping the legacy (unset) revision.
		await store.atomicReadAndUpdate(
			"child",
			({ parentTaskId: _parent, rootTaskId: _root, ...detached }) => detached,
		)
		expect(JSON.parse(await fs.readFile(file("child"), "utf8"))).not.toHaveProperty("parentTaskId")
		const before = await fs.readFile(file("child"))
		const effect = vi.fn(async () => {})

		await expect(withOrdinaryTaskPersistence(storage, authority, effect)).rejects.toThrow(
			"stale instance revision or lineage",
		)
		expect(effect).not.toHaveBeenCalled()
		expect(authority.refused).toBe(true)
		expect(await fs.readFile(file("child"))).toEqual(before)
	})
})
