// Case 19 follow-up: at the deadline the fence separates contention with a live, completely recorded
// owner ("timeout", non-sticky for callers) from a lock that no waiter can ever acquire
// ("unrecoverable", sticky): a legacy holderless owner, or a missing/incomplete/unreadable owner.json
// that stayed the same for the whole observation window. Real disposable disk, no mocks.
import * as crypto from "crypto"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import { ParentHandoffFence } from "../parentHandoffFence"

/** Long enough for the unrecoverable window (1 s minimum); the production wait is 30 s. */
const WAIT_MS = 1_200
const id = "task-under-test"
const keyFor = (value: string) => crypto.createHash("sha256").update(value).digest("hex")
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let root: string
let lock: string

beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "fence-unrecoverable-")))
	lock = path.join(root, ".handoff-fences", `${keyFor(id)}.lock`)
	await fs.mkdir(lock, { recursive: true })
})
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true })
})

const owner = (extra: Record<string, unknown> = {}) =>
	JSON.stringify({ schemaVersion: 1, parentTaskId: id, ownerToken: crypto.randomUUID(), generation: 1, ...extra })
const outcome = (timeoutMs = WAIT_MS) =>
	new ParentHandoffFence(root).acquire(id, { timeoutMs }).then(
		async (lease) => {
			await lease.release()
			return { acquired: true }
		},
		(error: { name: string; reason?: string; diagnostic?: string }) => ({
			name: error.name,
			reason: error.reason,
			diagnostic: error.diagnostic,
		}),
	)

describe("ParentHandoffFence deadline classification", () => {
	it("reports a legacy holderless owner as unrecoverable after the observation window", async () => {
		await fs.writeFile(path.join(lock, "owner.json"), owner({ acquiredAt: 1 }))

		expect(await outcome()).toEqual({
			name: "ParentHandoffFenceUnavailableError",
			reason: "unrecoverable",
			diagnostic: "LEGACY_OWNER",
		})
		// A zero or short wait cannot observe a whole window: it stays plain contention.
		expect(await outcome(0)).toMatchObject({ reason: "timeout", diagnostic: undefined })
	})

	it.each([
		["a missing owner.json (bootstrap stopped after mkdir)", undefined, "INCOMPLETE_OWNER"],
		["a truncated owner.json", '{"schemaVersion":1,"parent', "UNREADABLE_OWNER"],
		["an owner.json without a token", JSON.stringify({ schemaVersion: 1, parentTaskId: id }), "INCOMPLETE_OWNER"],
	])("reports %s that persists until the deadline as unrecoverable", async (_name, bytes, diagnostic) => {
		if (bytes !== undefined) await fs.writeFile(path.join(lock, "owner.json"), bytes)

		expect(await outcome()).toEqual({
			name: "ParentHandoffFenceUnavailableError",
			reason: "unrecoverable",
			diagnostic,
		})
	})

	it("keeps a live, completely recorded owner as timeout", async () => {
		await fs.rm(lock, { recursive: true })
		const holder = await new ParentHandoffFence(root).acquire(id)
		try {
			expect(await outcome()).toEqual({
				name: "ParentHandoffFenceUnavailableError",
				reason: "timeout",
				diagnostic: undefined,
			})
		} finally {
			await holder.release()
		}
	})

	it("keeps a complete owner on another host as timeout (it may be alive and release)", async () => {
		await fs.writeFile(
			path.join(lock, "owner.json"),
			owner({ holder: { pid: 1, hostname: `not-${os.hostname()}`, platform: process.platform } }),
		)

		expect(await outcome()).toMatchObject({ reason: "timeout", diagnostic: undefined })
	})

	it("does not misclassify a competitor that completes its bootstrap during the wait", async () => {
		// Between mkdir and its owner write at the start of the wait, then complete and alive.
		const competitor = delay(WAIT_MS / 3).then(() =>
			fs.writeFile(
				path.join(lock, "owner.json"),
				owner({ holder: { pid: process.pid, hostname: os.hostname(), platform: process.platform } }),
			),
		)

		const result = await outcome()
		await competitor
		expect(result).toMatchObject({ reason: "timeout", diagnostic: undefined })
	})

	it("restarts the window when an incomplete lock is replaced by a new incomplete instance", async () => {
		// The first instance alone is observed for longer than the 1 s window; the replacement, a second
		// competitor in its own bootstrap gap, is a different instance observed for only ~0.5 s.
		// Created now, so it is a distinct directory; renaming it onto the empty lock directory replaces
		// it atomically (POSIX), leaving the waiter no free lock path to win in between.
		const next = `${lock}.next-instance`
		await fs.mkdir(next)
		const replaced = delay(1_500).then(() => fs.rename(next, lock))

		const result = await outcome(2_000)
		await replaced
		expect(result).toMatchObject({ reason: "timeout", diagnostic: undefined })
	})
})
