// Real disposable-disk and real child-process tests for exited-owner takeover (option b: pid proof, never age).
import { spawn, type ChildProcess } from "child_process"
import * as crypto from "crypto"
import { readFileSync } from "fs"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { pathToFileURL } from "url"

// Keep real disk operations, with configurable exports so one test can pause a claim publication.
vi.mock("fs/promises", async (importOriginal) => ({ ...(await importOriginal<typeof fs>()) }))

import {
	ParentHandoffFence,
	ParentHandoffFenceOwnershipError,
	ParentHandoffFenceUnavailableError,
} from "../parentHandoffFence"

const fenceModule = pathToFileURL(path.resolve(__dirname, "../parentHandoffFence.ts")).href
const keyFor = (id: string) => crypto.createHash("sha256").update(id).digest("hex")
const machineIdReadable = (() => {
	try {
		return readFileSync("/etc/machine-id", "utf8").trim().length > 0
	} catch {
		return false
	}
})()

type ChildLease = { token: string; generation: number; pid: number }

let root: string
let fences: string
let script: string
const children = new Set<ChildProcess>()

beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "fence-takeover-")))
	fences = path.join(root, ".handoff-fences")
	script = path.join(root, "fence-child.mts")
	await fs.writeFile(
		script,
		[
			`import { ParentHandoffFence } from ${JSON.stringify(fenceModule)}`,
			`const [storage, rawId, mode, timeoutMs] = process.argv.slice(2)`,
			`const id = JSON.parse(rawId)`,
			`const lease = await new ParentHandoffFence(storage).acquire(id, { timeoutMs: Number(timeoutMs) })`,
			`process.stdout.write(JSON.stringify({ token: lease.ownerToken, generation: lease.generation, pid: process.pid }) + "\\n")`,
			`if (mode === "exit") process.exit(0)`,
			`if (mode === "hold") process.stdin.resume()`,
			`if (mode === "race") {`,
			`  await new Promise((resolve) => setTimeout(resolve, 50))`,
			`  await lease.assertOwned()`,
			`  await lease.release()`,
			`  process.stdout.write("released\\n")`,
			`}`,
		].join("\n"),
	)
})

afterEach(async () => {
	vi.restoreAllMocks()
	for (const child of children) child.kill("SIGKILL")
	await Promise.all([...children].map(exited))
	children.clear()
	await fs.rm(root, { recursive: true, force: true })
})

function exited(child: ChildProcess): Promise<number | null> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode)
	return new Promise((resolve) => child.once("exit", (code) => resolve(code)))
}

function startChild(id: string, mode: "exit" | "hold" | "race", timeoutMs = 0) {
	const child = spawn(
		process.execPath,
		["--experimental-transform-types", "--no-warnings", script, root, JSON.stringify(id), mode, String(timeoutMs)],
		{ env: { ...process.env, NODE_OPTIONS: "" }, stdio: ["pipe", "pipe", "pipe"] },
	)
	children.add(child)
	let stdout = ""
	let stderr = ""
	child.stdout?.on("data", (chunk) => (stdout += String(chunk)))
	child.stderr?.on("data", (chunk) => (stderr += String(chunk)))
	const lease = new Promise<ChildLease>((resolve, reject) => {
		child.stdout?.on("data", () => {
			const line = stdout.split("\n")[0]
			if (stdout.includes("\n")) resolve(JSON.parse(line) as ChildLease)
		})
		child.once("exit", (code) => reject(new Error(`child exited ${code} before acquiring: ${stderr}`)))
	})
	return { child, lease, output: () => ({ stdout, stderr }) }
}

/** A pid that certainly belonged to a process which has now exited and been reaped. */
async function exitedPid(): Promise<number> {
	const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" })
	await exited(child)
	return child.pid!
}

async function listFences(): Promise<string[]> {
	return (await fs.readdir(fences)).sort()
}

async function readOwner(directory: string) {
	return JSON.parse(await fs.readFile(path.join(directory, "owner.json"), "utf8"))
}

/** Replace only the recorded pid; keeps token, generation, host and namespace exactly as acquired. */
async function forgeHolderPid(id: string, pid: number) {
	const ownerPath = path.join(fences, `${keyFor(id)}.lock`, "owner.json")
	const owner = JSON.parse(await fs.readFile(ownerPath, "utf8"))
	const forged = { ...owner, holder: { ...owner.holder, pid } }
	await fs.writeFile(ownerPath, JSON.stringify(forged))
	return forged
}

async function snapshot(directory: string): Promise<Record<string, string>> {
	const result: Record<string, string> = {}
	for (const entry of await fs.readdir(directory, { recursive: true, withFileTypes: true })) {
		const full = path.join(entry.parentPath, entry.name)
		result[path.relative(directory, full)] = entry.isFile() ? await fs.readFile(full, "utf8") : "<dir>"
	}
	return result
}

describe("ParentHandoffFence exited-owner takeover", () => {
	it.each(["exit", "SIGKILL"] as const)(
		"takes over a lock whose real holder process ended by %s, retaining it as evidence",
		async (ending) => {
			const id = "\u0000startup-admission"
			const key = keyFor(id)
			const holder = startChild(id, ending === "exit" ? "exit" : "hold")
			const dead = await holder.lease
			if (ending === "SIGKILL") holder.child.kill("SIGKILL")
			await exited(holder.child)
			expect((await readOwner(path.join(fences, `${key}.lock`))).holder.pid).toBe(dead.pid)

			const lease = await new ParentHandoffFence(root).acquire(id, { timeoutMs: 0 })

			expect(lease.generation).toBeGreaterThan(dead.generation + 1)
			expect(await fs.readFile(path.join(fences, `${key}.generation`), "utf8")).toBe(String(lease.generation))
			expect((await readOwner(path.join(fences, `${key}.lock`))).ownerToken).toBe(lease.ownerToken)
			const quarantined = (await listFences()).filter((name) => name.startsWith(`${key}.lock.exited-`))
			expect(quarantined).toHaveLength(1)
			expect(quarantined[0]).toMatch(new RegExp(`^${key}\\.lock\\.exited-${dead.generation}-`))
			expect((await readOwner(path.join(fences, quarantined[0]))).ownerToken).toBe(dead.token)
			await lease.assertOwned()
			await lease.release()
		},
	)

	it("refuses a live holder process and leaves its lock untouched", async () => {
		const id = "parent-live"
		const holder = startChild(id, "hold")
		const live = await holder.lease
		const before = await snapshot(fences)

		await expect(new ParentHandoffFence(root).acquire(id, { timeoutMs: 150 })).rejects.toMatchObject({
			name: "ParentHandoffFenceUnavailableError",
			reason: "timeout",
		})

		expect(await snapshot(fences)).toEqual(before)
		expect((await readOwner(path.join(fences, `${keyFor(id)}.lock`))).ownerToken).toBe(live.token)
	})

	it("refuses an in-process live holder (same pid) without takeover", async () => {
		const fence = new ParentHandoffFence(root)
		const lease = await fence.acquire("same-process")
		const before = await snapshot(fences)
		await expect(fence.acquire("same-process", { timeoutMs: 0 })).rejects.toBeInstanceOf(
			ParentHandoffFenceUnavailableError,
		)
		expect(await snapshot(fences)).toEqual(before)
		await lease.assertOwned()
		await lease.release()
	})

	const unprovable: Array<[string, (owner: Record<string, unknown>) => Record<string, unknown>]> = [
		["legacy owner without holder", (owner) => ({ ...owner, holder: undefined })],
		["holder on another host", (owner) => withHolder(owner, { hostname: "other-host" })],
		["holder on another platform", (owner) => withHolder(owner, { platform: "other" })],
		["holder with invalid pid", (owner) => withHolder(owner, { pid: 0 })],
		["holder with negative pid", (owner) => withHolder(owner, { pid: -1 })],
	]
	if (process.platform === "linux")
		unprovable.push(
			["holder in another pid namespace", (owner) => withHolder(owner, { pidNamespace: "pid:[1]" })],
			["Linux holder without pid namespace", (owner) => withHolder(owner, { pidNamespace: undefined })],
		)
	it.each(unprovable)("refuses a dead-pid %s (no provable exit)", async (_name, mutate) => {
		const id = "parent-unprovable"
		const lease = await new ParentHandoffFence(root).acquire(id)
		const owner = await forgeHolderPid(id, await exitedPid())
		const ownerPath = path.join(fences, `${keyFor(id)}.lock`, "owner.json")
		await fs.writeFile(ownerPath, JSON.stringify(mutate(owner)))
		const before = await snapshot(fences)

		await expect(new ParentHandoffFence(root).acquire(id, { timeoutMs: 0 })).rejects.toMatchObject({
			reason: "timeout",
		})

		expect(await snapshot(fences)).toEqual(before)
		void lease
	})

	it("refuses a holder pid that exists but cannot be signalled (EPERM counts as alive)", async () => {
		const id = "parent-eperm"
		await new ParentHandoffFence(root).acquire(id)
		const owner = await forgeHolderPid(id, 1)
		// Without a start time, a root test runner also sees pid 1 as alive; non-root sees EPERM.
		const ownerPath = path.join(fences, `${keyFor(id)}.lock`, "owner.json")
		await fs.writeFile(ownerPath, JSON.stringify(withHolder(owner, { pid: 1, startTime: undefined })))
		const before = await snapshot(fences)

		await expect(new ParentHandoffFence(root).acquire(id, { timeoutMs: 0 })).rejects.toMatchObject({
			reason: "timeout",
		})
		expect(await snapshot(fences)).toEqual(before)
	})

	it.runIf(process.platform === "linux")(
		"Linux: a live pid with a different start time in the same boot is a reused pid (owner exited)",
		async () => {
			const id = "parent-reused-pid"
			const previous = await new ParentHandoffFence(root).acquire(id)
			const owner = await forgeHolderPid(id, process.pid)
			const ownerPath = path.join(fences, `${keyFor(id)}.lock`, "owner.json")
			await fs.writeFile(ownerPath, JSON.stringify(withHolder(owner, { startTime: "1" })))

			const next = await new ParentHandoffFence(root).acquire(id, { timeoutMs: 0 })
			await expect(previous.assertOwned()).rejects.toBeInstanceOf(ParentHandoffFenceOwnershipError)
			await next.release()
		},
	)

	it.runIf(process.platform === "linux")(
		"Linux: a live pid recorded in another boot cannot be compared and is refused",
		async () => {
			const id = "parent-other-boot"
			await new ParentHandoffFence(root).acquire(id)
			const owner = await forgeHolderPid(id, process.pid)
			const ownerPath = path.join(fences, `${keyFor(id)}.lock`, "owner.json")
			await fs.writeFile(ownerPath, JSON.stringify(withHolder(owner, { startTime: "1", bootId: "other-boot" })))
			const before = await snapshot(fences)

			await expect(new ParentHandoffFence(root).acquire(id, { timeoutMs: 0 })).rejects.toMatchObject({
				reason: "timeout",
			})
			expect(await snapshot(fences)).toEqual(before)
		},
	)

	it("positive control: the same forged record with only a dead pid IS taken over", async () => {
		const id = "parent-control"
		await new ParentHandoffFence(root).acquire(id)
		await forgeHolderPid(id, await exitedPid())
		const lease = await new ParentHandoffFence(root).acquire(id, { timeoutMs: 0 })
		await lease.assertOwned()
	})

	it.each([
		["partial lock directory (crash before owner write)", async () => undefined],
		["truncated owner.json", async (ownerPath: string) => fs.writeFile(ownerPath, '{"schemaVersion":1,')],
	])("refuses a %s", async (_name, damage) => {
		const id = "parent-partial"
		const lockDirectory = path.join(fences, `${keyFor(id)}.lock`)
		await fs.mkdir(lockDirectory, { recursive: true })
		await fs.writeFile(path.join(fences, `${keyFor(id)}.generation`), "3")
		await damage(path.join(lockDirectory, "owner.json"))
		const before = await snapshot(fences)

		await expect(new ParentHandoffFence(root).acquire(id, { timeoutMs: 0 })).rejects.toMatchObject({
			reason: "timeout",
		})
		expect(await snapshot(fences)).toEqual(before)
	})

	it("fences the previous lease: after takeover its assertOwned and release fail and the new lock survives", async () => {
		const id = "parent-wrongly-proven"
		const previous = await new ParentHandoffFence(root).acquire(id)
		// Simulate a holder whose exit proof was wrong (e.g. a broken pid assumption): it is still running here.
		await forgeHolderPid(id, await exitedPid())

		const next = await new ParentHandoffFence(root).acquire(id, { timeoutMs: 0 })

		expect(next.generation).toBeGreaterThan(previous.generation)
		await expect(previous.assertOwned()).rejects.toBeInstanceOf(ParentHandoffFenceOwnershipError)
		await expect(previous.release()).rejects.toBeInstanceOf(ParentHandoffFenceOwnershipError)
		await next.assertOwned()
		expect((await readOwner(path.join(fences, `${keyFor(id)}.lock`))).ownerToken).toBe(next.ownerToken)
		await next.release()
	})

	it("in-process contenders racing on one dead lock: exactly one wins and nothing else moves", async () => {
		const id = "parent-in-process-race"
		const key = keyFor(id)
		await new ParentHandoffFence(root).acquire(id)
		await forgeHolderPid(id, await exitedPid())

		const results = await Promise.allSettled(
			Array.from({ length: 8 }, () => new ParentHandoffFence(root).acquire(id, { timeoutMs: 0 })),
		)

		const winners = results.filter((result) => result.status === "fulfilled")
		expect(winners).toHaveLength(1)
		for (const result of results)
			if (result.status === "rejected") expect(result.reason).toBeInstanceOf(ParentHandoffFenceUnavailableError)
		expect((await listFences()).filter((name) => name.startsWith(`${key}.lock.exited-`))).toHaveLength(1)
		const winner = (winners[0] as PromiseFulfilledResult<Awaited<ReturnType<ParentHandoffFence["acquire"]>>>).value
		await winner.assertOwned()
		await winner.release()
	})

	it("cross-process contenders racing on one dead lock: one takeover, every fresh lease survives", async () => {
		const id = "parent-process-race"
		const key = keyFor(id)
		const holder = startChild(id, "hold")
		const dead = await holder.lease
		holder.child.kill("SIGKILL")
		await exited(holder.child)

		const racers = Array.from({ length: 6 }, () => startChild(id, "race", 20_000))
		const codes = await Promise.all(racers.map((racer) => exited(racer.child)))

		for (const [index, racer] of racers.entries()) {
			expect({ code: codes[index], ...racer.output() }).toMatchObject({
				code: 0,
				stdout: expect.stringContaining("released"),
			})
		}
		const quarantined = (await listFences()).filter((name) => name.startsWith(`${key}.lock.exited-`))
		expect(quarantined).toHaveLength(1)
		expect((await readOwner(path.join(fences, quarantined[0]))).ownerToken).toBe(dead.token)
		const generations = await Promise.all(racers.map((racer) => racer.lease.then((lease) => lease.generation)))
		expect(new Set(generations).size).toBe(generations.length)
	}, 30_000)

	it("a stale observer that wins only a nested claim re-reads the token and never moves a successor lock", async () => {
		const id = "parent-stale-observer"
		const key = keyFor(id)
		const lockDirectory = path.join(fences, `${key}.lock`)
		await new ParentHandoffFence(root).acquire(id)
		const deadOwner = await forgeHolderPid(id, await exitedPid())
		const deadPid = await exitedPid()
		let fresh: Awaited<ReturnType<ParentHandoffFence["acquire"]>> | undefined

		const realRename = fs.rename
		vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
			if (!fresh && String(source).includes(".claim-") && String(source).endsWith(".tmp")) {
				// The stale contender has observed the dead owner T and is about to publish its claim.
				// Meanwhile a contender published claim-T and crashed, T was moved aside manually (the
				// documented recovery; no generation advance), and a successor lock was installed whose
				// holder has ALSO exited. Only the token re-read can stop the stale observer now: the
				// successor is provably exited and the generation file is g+1, which a resume accepts.
				const firstClaim = path.join(fences, `${key}.takeover-${digest(deadOwner.ownerToken)}`)
				await fs.mkdir(firstClaim)
				await fs.writeFile(
					path.join(firstClaim, "claim.json"),
					JSON.stringify({
						schemaVersion: 1,
						claimToken: "crashed-claimant",
						deadOwnerToken: deadOwner.ownerToken,
						holder: { ...deadOwner.holder, pid: deadPid },
					}),
				)
				await realRename(lockDirectory, path.join(fences, `${key}.lock.exited-manual`))
				fresh = await new ParentHandoffFence(root).acquire(id, { timeoutMs: 0 })
				await forgeHolderPid(id, deadPid)
			}
			return realRename(source, target)
		})

		await expect(new ParentHandoffFence(root).acquire(id, { timeoutMs: 0 })).rejects.toMatchObject({
			reason: "timeout",
		})

		expect(fresh).toBeDefined()
		await fresh!.assertOwned()
		expect((await readOwner(lockDirectory)).ownerToken).toBe(fresh!.ownerToken)
		const names = await listFences()
		expect(names.filter((name) => name.startsWith(`${key}.lock.exited-`))).toEqual([`${key}.lock.exited-manual`])
		expect(await fs.readFile(path.join(fences, `${key}.generation`), "utf8")).toBe(String(fresh!.generation))
		// The stale contender did win the nested claim, so it reached (and failed) the re-read check.
		expect(
			names.filter((name) =>
				name.startsWith(`${key}.takeover-${digest(deadOwner.ownerToken)}-${digest("crashed-claimant")}`),
			),
		).toHaveLength(1)
		await fresh!.release()
	})

	it.each([1, 3])(
		"a claimant whose quarantine rename fails %i time(s) resumes its own claim instead of stranding the lock",
		async (failures) => {
			const id = "parent-transient-takeover"
			const key = keyFor(id)
			const holder = startChild(id, "hold")
			const dead = await holder.lease
			holder.child.kill("SIGKILL")
			await exited(holder.child)
			const realRename = fs.rename
			let remaining = failures
			vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
				if (remaining > 0 && String(target).includes(".lock.exited-")) {
					remaining--
					throw Object.assign(new Error("injected EPERM"), { code: "EPERM" })
				}
				return realRename(source, target)
			})
			const fence = new ParentHandoffFence(root)

			if (failures >= 3) {
				// The bounded in-call retry is exhausted: typed refusal, with the claim kept resumable.
				await expect(fence.acquire(id, { timeoutMs: 0 })).rejects.toMatchObject({
					reason: "filesystem",
					filesystemCode: "EPERM",
				})
				expect(await fs.readFile(path.join(fences, `${key}.generation`), "utf8")).toBe(
					String(dead.generation + 1),
				)
				expect((await readOwner(path.join(fences, `${key}.lock`))).ownerToken).toBe(dead.token)
			}
			const lease = await fence.acquire(id, { timeoutMs: 0 })

			expect(lease.generation).toBe(dead.generation + 2)
			const names = await listFences()
			expect(names.filter((name) => name.startsWith(`${key}.lock.exited-`))).toHaveLength(1)
			// One claim only: the retry/resume reused it rather than nesting or stranding.
			expect(names.filter((name) => name.startsWith(`${key}.takeover-`))).toEqual([
				`${key}.takeover-${digest(dead.token)}`,
			])
			await lease.assertOwned()
			await lease.release()
			// A later contender in this process is not blocked by the finished claim.
			const again = await fence.acquire(id, { timeoutMs: 0 })
			await again.release()
		},
	)

	it("takes over a holder from another boot only when its pid no longer exists", async () => {
		const id = "parent-previous-boot"
		await new ParentHandoffFence(root).acquire(id)
		const owner = await forgeHolderPid(id, await exitedPid())
		const ownerPath = path.join(fences, `${keyFor(id)}.lock`, "owner.json")
		await fs.writeFile(ownerPath, JSON.stringify(withHolder(owner, { bootId: "previous-boot", startTime: "1" })))
		const lease = await new ParentHandoffFence(root).acquire(id, { timeoutMs: 0 })
		await lease.release()
	})

	it.runIf(machineIdReadable)("refuses a dead-pid holder recorded on another machine id", async () => {
		const id = "parent-other-machine"
		await new ParentHandoffFence(root).acquire(id)
		const owner = await forgeHolderPid(id, await exitedPid())
		expect(owner.holder.machineId).toEqual(expect.any(String))
		const ownerPath = path.join(fences, `${keyFor(id)}.lock`, "owner.json")
		await fs.writeFile(ownerPath, JSON.stringify(withHolder(owner, { machineId: "other-machine" })))
		const before = await snapshot(fences)
		await expect(new ParentHandoffFence(root).acquire(id, { timeoutMs: 0 })).rejects.toMatchObject({
			reason: "timeout",
		})
		expect(await snapshot(fences)).toEqual(before)
	})

	it("release never deletes or reinstalls a replacement that appeared after its ownership check", async () => {
		const id = "parent-release-race"
		const key = keyFor(id)
		const lockDirectory = path.join(fences, `${key}.lock`)
		const stale = await new ParentHandoffFence(root).acquire(id)
		let replacement: Awaited<ReturnType<ParentHandoffFence["acquire"]>> | undefined
		const realRename = fs.rename
		vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
			if (!replacement && String(target).includes(".lock.released-")) {
				// Between assertOwned() and the move, the stale lease's lock is replaced.
				await realRename(lockDirectory, path.join(fences, `${key}.lock.exited-manual`))
				replacement = await new ParentHandoffFence(root).acquire(id, { timeoutMs: 0 })
			}
			return realRename(source, target)
		})

		await expect(stale.release()).rejects.toBeInstanceOf(ParentHandoffFenceOwnershipError)

		// The replacement's lock is retained aside (not deleted, not moved back); it now refuses itself.
		const released = (await listFences()).filter((name) => name.includes(".lock.released-"))
		expect(released).toHaveLength(1)
		expect((await readOwner(path.join(fences, released[0]))).ownerToken).toBe(replacement!.ownerToken)
		await expect(replacement!.assertOwned()).rejects.toBeInstanceOf(ParentHandoffFenceOwnershipError)
		await expect(fs.stat(lockDirectory)).rejects.toMatchObject({ code: "ENOENT" })
		// The lock path is free, not stranded.
		vi.restoreAllMocks()
		const next = await new ParentHandoffFence(root).acquire(id, { timeoutMs: 0 })
		await next.release()
	})

	it("release that moves a competitor's directory mid-bootstrap does not strand the lock", async () => {
		const id = "parent-release-midbootstrap"
		const key = keyFor(id)
		const lockDirectory = path.join(fences, `${key}.lock`)
		const stale = await new ParentHandoffFence(root).acquire(id)
		const realRename = fs.rename
		let injected = false
		vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
			if (!injected && String(target).includes(".lock.released-")) {
				injected = true
				// Our lock disappears (e.g. a wrong exit proof) and a competitor has only run mkdir.
				await realRename(lockDirectory, path.join(fences, `${key}.lock.exited-manual`))
				await fs.mkdir(lockDirectory)
			}
			return realRename(source, target)
		})

		await expect(stale.release()).rejects.toBeInstanceOf(ParentHandoffFenceOwnershipError)

		await expect(fs.stat(lockDirectory)).rejects.toMatchObject({ code: "ENOENT" })
		const released = (await listFences()).filter((name) => name.includes(".lock.released-"))
		expect(await fs.readdir(path.join(fences, released[0]))).toEqual([])
		// The competitor's owner write would now fail (its directory is gone), and the path is free.
		vi.restoreAllMocks()
		const next = await new ParentHandoffFence(root).acquire(id, { timeoutMs: 0 })
		await next.release()
	})

	describe("release cleanup failure", () => {
		const warn = () => vi.spyOn(console, "warn").mockImplementation(() => undefined)

		it("a partial delete never reinstalls an ownerless lock directory", async () => {
			const id = "parent-partial-rm"
			const key = keyFor(id)
			const lockDirectory = path.join(fences, `${key}.lock`)
			const lease = await new ParentHandoffFence(root).acquire(id)
			await fs.mkdir(path.join(lockDirectory, "sub"))
			warn()
			vi.spyOn(fs, "rm").mockImplementationOnce(async (target) => {
				// Parallel removal took owner.json before one undeletable entry failed.
				await fs.unlink(path.join(String(target), "owner.json"))
				throw Object.assign(new Error("injected EBUSY"), { code: "EBUSY" })
			})

			const result = await lease.release()

			expect(result).toMatchObject({ cleanup: "retained", code: "EBUSY" })
			await expect(fs.stat(lockDirectory)).rejects.toMatchObject({ code: "ENOENT" })
			if (result.cleanup !== "retained") throw new Error("expected retained cleanup")
			expect(await fs.readdir(path.join(fences, result.retainedName))).toEqual(["sub"])
			const next = await new ParentHandoffFence(root).acquire(id, { timeoutMs: 0 })
			expect(next.generation).toBe(lease.generation + 1)
			await next.release()
		})

		it("a delete failure never replaces a competitor's freshly created empty lock directory", async () => {
			const id = "parent-rm-competitor"
			const key = keyFor(id)
			const lockDirectory = path.join(fences, `${key}.lock`)
			const lease = await new ParentHandoffFence(root).acquire(id)
			warn()
			vi.spyOn(fs, "rm").mockImplementationOnce(async () => {
				// Our lock is already moved aside; a competitor has just run mkdir on the free path.
				await fs.mkdir(lockDirectory)
				throw Object.assign(new Error("injected EIO"), { code: "EIO" })
			})

			const result = await lease.release()

			expect(result).toMatchObject({ cleanup: "retained", code: "EIO" })
			expect(await fs.readdir(lockDirectory)).toEqual([])
			if (result.cleanup !== "retained") throw new Error("expected retained cleanup")
			expect((await readOwner(path.join(fences, result.retainedName))).ownerToken).toBe(lease.ownerToken)
		})

		it.each([
			[1, "complete"],
			[3, "retained"],
		] as const)(
			"an own record unreadable %i time(s) is not ownership loss (cleanup %s)",
			async (failures, cleanup) => {
				const id = `parent-unreadable-${failures}`
				const key = keyFor(id)
				const lockDirectory = path.join(fences, `${key}.lock`)
				const lease = await new ParentHandoffFence(root).acquire(id)
				warn()
				const realReadFile = fs.readFile
				let remaining = failures
				vi.spyOn(fs, "readFile").mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
					if (remaining > 0 && String(args[0]).includes(".lock.released-")) {
						remaining--
						throw Object.assign(new Error("injected EMFILE"), { code: "EMFILE" })
					}
					return realReadFile(...args)
				})

				const result = await lease.release()

				expect(result.cleanup).toBe(cleanup)
				if (result.cleanup === "retained") {
					expect(result.code).toBe("EMFILE")
					expect((await readOwner(path.join(fences, result.retainedName))).ownerToken).toBe(lease.ownerToken)
				}
				await expect(fs.stat(lockDirectory)).rejects.toMatchObject({ code: "ENOENT" })
				vi.restoreAllMocks()
				const next = await new ParentHandoffFence(root).acquire(id, { timeoutMs: 0 })
				await next.release()
			},
		)
	})

	it("supersedes a crashed claimant only by proof, tolerating its generation advance", async () => {
		const id = "parent-crashed-claimant"
		const key = keyFor(id)
		await new ParentHandoffFence(root).acquire(id)
		const deadOwner = await forgeHolderPid(id, await exitedPid())
		const claim = path.join(fences, `${key}.takeover-${digest(deadOwner.ownerToken)}`)
		await fs.mkdir(claim)
		const writeClaim = (pid: number) =>
			fs.writeFile(
				path.join(claim, "claim.json"),
				JSON.stringify({
					schemaVersion: 1,
					claimToken: "claimant",
					deadOwnerToken: deadOwner.ownerToken,
					holder: { ...deadOwner.holder, pid },
				}),
			)

		// A live claimant (this process) keeps the takeover refused.
		await writeClaim(process.pid)
		await expect(new ParentHandoffFence(root).acquire(id, { timeoutMs: 0 })).rejects.toMatchObject({
			reason: "timeout",
		})

		// It crashed after advancing the generation but before moving the lock.
		await writeClaim(await exitedPid())
		await fs.writeFile(path.join(fences, `${key}.generation`), String(deadOwner.generation + 1))
		const lease = await new ParentHandoffFence(root).acquire(id, { timeoutMs: 0 })
		expect(lease.generation).toBe(deadOwner.generation + 2)
		await lease.assertOwned()
		await lease.release()
	})

	it("refuses takeover when generation evidence is inconsistent with the dead owner", async () => {
		const id = "parent-generation-mismatch"
		const key = keyFor(id)
		await new ParentHandoffFence(root).acquire(id)
		const deadOwner = await forgeHolderPid(id, await exitedPid())
		await fs.writeFile(path.join(fences, `${key}.generation`), String(deadOwner.generation + 5))
		const lockBefore = await snapshot(path.join(fences, `${key}.lock`))

		await expect(new ParentHandoffFence(root).acquire(id, { timeoutMs: 0 })).rejects.toMatchObject({
			reason: "timeout",
		})
		expect(await snapshot(path.join(fences, `${key}.lock`))).toEqual(lockBefore)
		expect(await fs.readFile(path.join(fences, `${key}.generation`), "utf8")).toBe(String(deadOwner.generation + 5))
	})
})

function digest(value: string) {
	return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16)
}

function withHolder(owner: Record<string, unknown>, patch: Record<string, unknown>) {
	const holder = owner.holder && typeof owner.holder === "object" ? owner.holder : {}
	return { ...owner, holder: { ...holder, ...patch } }
}
