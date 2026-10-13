import * as crypto from "crypto"
import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as os from "os"
import * as path from "path"

/** Why an existing lock was judged unrecoverable at the deadline; never a path. */
export type ParentHandoffFenceLockDiagnostic =
	| "LEGACY_OWNER"
	| "INCOMPLETE_OWNER"
	| "UNREADABLE_OWNER"
	| "EXITED_OWNER_REFUSED"

/**
 * - `timeout`: contention. At the deadline the lock held a complete owner whose holder is not
 *   provably exited (including a live owner on another host); it may still be released.
 * - `unrecoverable`: the same lock instance showed no usable owner (legacy/holderless, missing,
 *   incomplete or unreadable owner.json, or a provably exited owner whose takeover was refused)
 *   for the whole observation window up to the deadline. Waiting again cannot help.
 * - `filesystem`: the fence itself could not be used.
 */
export type ParentHandoffFenceUnavailableReason = "timeout" | "unrecoverable" | "filesystem"

export class ParentHandoffFenceUnavailableError extends Error {
	constructor(
		parentTaskId: string,
		public readonly reason: ParentHandoffFenceUnavailableReason = "timeout",
		public readonly filesystemCode?: string,
		/** Sanitized fence-evidence diagnostic (never a path), e.g. `INVALID_GENERATION`. */
		public readonly diagnostic?: "INVALID_GENERATION" | ParentHandoffFenceLockDiagnostic,
	) {
		super(
			`Parent handoff fence is unavailable for ${parentTaskId} (${reason}${filesystemCode ? `: ${filesystemCode}` : ""}${diagnostic ? `; ${diagnostic}` : ""})`,
		)
		this.name = "ParentHandoffFenceUnavailableError"
	}
}

class InvalidGenerationEvidence extends Error {
	constructor() {
		super("invalid generation")
	}
}

export class ParentHandoffFenceOwnershipError extends Error {
	constructor(parentTaskId: string) {
		super(`Parent handoff fence ownership was lost for ${parentTaskId}`)
		this.name = "ParentHandoffFenceOwnershipError"
	}
}

/**
 * Process identity recorded only so a later contender can PROVE that the holder exited.
 * Missing or mismatched fields always mean "cannot prove", which keeps the lock refused.
 */
export interface FenceHolder {
	pid: number
	hostname: string
	platform: string
	/** `/etc/machine-id` where readable; must match when both sides recorded it. */
	machineId?: string
	/** Linux only: `/proc/self/ns/pid`; pids are comparable only inside one namespace. */
	pidNamespace?: string
	/** Linux only: boot id; start times are comparable only inside one boot. */
	bootId?: string
	/** Linux only: `/proc/<pid>/stat` start time in clock ticks since boot. */
	startTime?: string
}

interface PersistedFenceOwner {
	schemaVersion: 1
	parentTaskId: string
	ownerToken: string
	generation: number
	acquiredAt: number
	/** Absent in legacy records; such owners are never taken over. */
	holder?: FenceHolder
}

interface PersistedTakeoverClaim {
	schemaVersion: 1
	claimToken: string
	deadOwnerToken: string
	holder: FenceHolder
}

/** Bounds nested claims after crashed claimants (and the claim path length). */
const MAX_TAKEOVER_CLAIM_DEPTH = 8
/** Bounds immediate mkdir retries after successful takeovers within one acquire call. */
const MAX_TAKEOVERS_PER_ACQUIRE = 8
/** Bounded in-call retries of a takeover whose claim is already published (transient I/O). */
const MAX_TAKEOVER_FINISH_ATTEMPTS = 3
/** Bounded re-reads of our own moved owner record during release (transient EMFILE/EIO). */
const MAX_OWN_RECORD_READS = 3
/**
 * An existing lock is reported `unrecoverable` only after the SAME lock instance showed no usable
 * owner continuously for at least max(this, half the wait) up to the deadline. A competitor that is
 * briefly between mkdir and its owner write changes the observation and restarts the window, and
 * zero or short waits always report `timeout`.
 */
const UNRECOVERABLE_MIN_OBSERVATION_MS = 1_000

/**
 * Claims this process published whose takeover has not finished, by claim token. "busy" while an
 * attempt runs; "idle" claims may be resumed by any later attempt in this process. JavaScript runs
 * the check-and-set synchronously, so at most one in-process attempt resumes a given claim.
 */
const ownClaims = new Map<string, "busy" | "idle">()

/**
 * Outcome of a release that did NOT fail: the lock path is free either way. "retained" means the
 * released directory could not be fully removed and stays aside as `<key>.lock.released-<uuid>`.
 * It is a cleanup report, never a refusal: callers releasing in `finally` need not handle it.
 */
export type ParentHandoffFenceReleaseResult =
	| { cleanup: "complete" }
	| { cleanup: "retained"; code: string; retainedName: string }

export interface ParentHandoffFenceLease {
	readonly parentTaskId: string
	readonly ownerToken: string
	readonly generation: number
	assertOwned(): Promise<void>
	release(): Promise<ParentHandoffFenceReleaseResult>
}

export interface AcquireParentHandoffFenceOptions {
	timeoutMs?: number
	retryIntervalMs?: number
}

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function durableWrite(filePath: string, contents: string): Promise<void> {
	const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`
	const handle = await fs.open(temporaryPath, "wx", 0o600)
	try {
		await handle.writeFile(contents, "utf8")
		await handle.sync()
	} finally {
		await handle.close()
	}
	await fs.rename(temporaryPath, filePath)
	const directory = await fs.open(path.dirname(filePath), "r")
	try {
		await directory.sync()
	} finally {
		await directory.close()
	}
}

function errorCode(error: unknown): string | undefined {
	const code = error && typeof error === "object" && "code" in error ? error.code : undefined
	return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,31}$/.test(code) ? code : undefined
}

const digest = (value: string) => crypto.createHash("sha256").update(value).digest("hex").slice(0, 16)

/** Fields after the parenthesized command name of `/proc/<pid>/stat`: [0] is state, [19] is start time. */
function procStatFields(stat: string): string[] {
	return stat.slice(stat.lastIndexOf(")") + 2).split(" ")
}

function readProcStartTime(pid: number | "self"): string | undefined {
	try {
		const value = procStatFields(fsSync.readFileSync(`/proc/${pid}/stat`, "utf8"))[19]
		return value && /^[0-9]+$/.test(value) ? value : undefined
	} catch {
		return undefined
	}
}

let cachedHolder: FenceHolder | null | undefined
/**
 * True only when this process's /proc view is in its own pid namespace. A child pid namespace that
 * still sees the parent's /proc (e.g. `unshare -p` without `--mount-proc`) maps pids differently, so
 * /proc-based evidence would misidentify processes; then only `ESRCH` can prove an exit.
 */
let procTrusted = false

function readTrimmed(file: string): string | undefined {
	try {
		return fsSync.readFileSync(file, "utf8").trim() || undefined
	} catch {
		return undefined
	}
}

export function currentHolder(): FenceHolder | undefined {
	if (cachedHolder !== undefined) return cachedHolder ?? undefined
	cachedHolder = null
	try {
		const hostname = os.hostname()
		if (typeof hostname !== "string" || !hostname) return undefined
		const holder: FenceHolder = { pid: process.pid, hostname, platform: process.platform }
		const machineId = readTrimmed("/etc/machine-id")
		if (machineId) holder.machineId = machineId
		if (process.platform === "linux") {
			try {
				holder.pidNamespace = fsSync.readlinkSync("/proc/self/ns/pid")
			} catch {
				// Without a namespace, Linux contenders cannot prove this holder exited.
			}
			try {
				procTrusted = fsSync.readFileSync("/proc/self/stat", "utf8").startsWith(`${process.pid} (`)
			} catch {
				procTrusted = false
			}
			if (procTrusted) {
				// Optional: only enable the same-boot pid-reuse refinement.
				holder.bootId = readTrimmed("/proc/sys/kernel/random/boot_id")
				holder.startTime = readProcStartTime("self")
			}
		}
		cachedHolder = holder
	} catch {
		// Unknown identity: record no holder, so this owner can never be taken over.
	}
	return cachedHolder ?? undefined
}

export function isFenceHolder(value: unknown): value is FenceHolder {
	if (!value || typeof value !== "object") return false
	const holder: Partial<Record<keyof FenceHolder, unknown>> = value
	const optionalString = (field: unknown) => field === undefined || (typeof field === "string" && field.length > 0)
	return (
		typeof holder.pid === "number" &&
		Number.isSafeInteger(holder.pid) &&
		holder.pid > 0 &&
		typeof holder.hostname === "string" &&
		holder.hostname.length > 0 &&
		typeof holder.platform === "string" &&
		holder.platform.length > 0 &&
		optionalString(holder.machineId) &&
		optionalString(holder.pidNamespace) &&
		optionalString(holder.bootId) &&
		optionalString(holder.startTime)
	)
}

/**
 * True only when the recorded holder is provably gone on THIS host. Never decided by age.
 * Any doubt (other host/platform/pid namespace, EPERM, unreadable /proc) answers false.
 * Pid reuse can only make a dead owner look alive, which refuses: the safe direction.
 */
export function holderProvablyExited(recorded: FenceHolder): boolean {
	const self = currentHolder()
	if (!self || recorded.hostname !== self.hostname || recorded.platform !== self.platform) return false
	if (self.machineId && recorded.machineId && recorded.machineId !== self.machineId) return false
	if (self.platform === "linux" && (!self.pidNamespace || recorded.pidNamespace !== self.pidNamespace)) return false
	try {
		process.kill(recorded.pid, 0)
	} catch (error) {
		return errorCode(error) === "ESRCH"
	}
	// The pid exists. On Linux within the same boot and a trusted /proc view, a different start time
	// proves reuse and a matching zombie has already exited. Otherwise the owner may be alive.
	if (
		self.platform !== "linux" ||
		!procTrusted ||
		!self.bootId ||
		recorded.bootId !== self.bootId ||
		!recorded.startTime
	)
		return false
	let fields: string[]
	try {
		fields = procStatFields(fsSync.readFileSync(`/proc/${recorded.pid}/stat`, "utf8"))
	} catch (error) {
		return errorCode(error) === "ENOENT"
	}
	const startTime = fields[19]
	if (!startTime || !/^[0-9]+$/.test(startTime)) return false
	return startTime !== recorded.startTime || fields[0] === "Z"
}

function isOwnedRecord(value: unknown, parentTaskId: string, ownerToken: string, generation: number): boolean {
	if (!value || typeof value !== "object") return false
	const owner: Partial<Record<keyof PersistedFenceOwner, unknown>> = value
	return (
		owner.schemaVersion === 1 &&
		owner.parentTaskId === parentTaskId &&
		owner.ownerToken === ownerToken &&
		owner.generation === generation
	)
}

function isCompleteOwner(value: unknown, parentTaskId: string): value is PersistedFenceOwner & { holder: FenceHolder } {
	if (!value || typeof value !== "object") return false
	const owner: Partial<Record<keyof PersistedFenceOwner, unknown>> = value
	return (
		owner.schemaVersion === 1 &&
		owner.parentTaskId === parentTaskId &&
		typeof owner.ownerToken === "string" &&
		owner.ownerToken.length > 0 &&
		typeof owner.generation === "number" &&
		Number.isSafeInteger(owner.generation) &&
		owner.generation > 0 &&
		isFenceHolder(owner.holder)
	)
}

/** Our own durably written record: absent means not ours; other read/parse failures are retried. */
async function readOwnRecord(
	filePath: string,
): Promise<{ kind: "found"; value: unknown } | { kind: "absent" } | { kind: "unreadable"; code?: string }> {
	let code: string | undefined
	for (let attempt = 1; attempt <= MAX_OWN_RECORD_READS; attempt++) {
		try {
			return { kind: "found", value: JSON.parse(await fs.readFile(filePath, "utf8")) }
		} catch (error) {
			code = errorCode(error)
			if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" }
			if (attempt < MAX_OWN_RECORD_READS) await delay(5 * attempt)
		}
	}
	return { kind: "unreadable", code }
}

function retainedAfterRelease(parentTaskId: string, releasing: string, code: string): ParentHandoffFenceReleaseResult {
	const retainedName = path.basename(releasing)
	console.warn(
		`[ParentHandoffFence] Released ${JSON.stringify(parentTaskId)} but kept ${retainedName} aside (${code}); it is evidence, not a held lock.`,
	)
	return { cleanup: "retained", code, retainedName }
}

async function readJson(filePath: string): Promise<unknown> {
	try {
		return JSON.parse(await fs.readFile(filePath, "utf8"))
	} catch {
		return undefined
	}
}

function isCompleteClaim(value: unknown): value is PersistedTakeoverClaim {
	if (!value || typeof value !== "object") return false
	const claim: Partial<Record<keyof PersistedTakeoverClaim, unknown>> = value
	return (
		claim.schemaVersion === 1 &&
		typeof claim.claimToken === "string" &&
		claim.claimToken.length > 0 &&
		typeof claim.deadOwnerToken === "string" &&
		isFenceHolder(claim.holder)
	)
}

export class ParentHandoffFence {
	private readonly fenceRoot: string

	constructor(globalStoragePath: string) {
		this.fenceRoot = path.join(fsSync.realpathSync(globalStoragePath), ".handoff-fences")
	}

	async acquire(
		parentTaskId: string,
		options: AcquireParentHandoffFenceOptions = {},
	): Promise<ParentHandoffFenceLease> {
		if (!parentTaskId) throw new Error("parentTaskId is required")
		const timeoutMs = Math.max(0, options.timeoutMs ?? 1_000)
		const retryIntervalMs = Math.max(1, options.retryIntervalMs ?? 25)
		const key = crypto.createHash("sha256").update(parentTaskId).digest("hex")
		const lockDirectory = path.join(this.fenceRoot, `${key}.lock`)
		const generationPath = path.join(this.fenceRoot, `${key}.generation`)
		const ownerPath = path.join(lockDirectory, "owner.json")
		try {
			await fs.mkdir(this.fenceRoot, { recursive: true, mode: 0o700 })
		} catch (error) {
			throw new ParentHandoffFenceUnavailableError(parentTaskId, "filesystem", errorCode(error))
		}
		const deadline = Date.now() + timeoutMs
		const unrecoverableAfterMs = Math.max(UNRECOVERABLE_MIN_OBSERVATION_MS, timeoutMs / 2)
		let takeovers = 0
		// Continuous observation of one unusable lock instance; reset by any change.
		let unusable: { identity: string; since: number; diagnostic: ParentHandoffFenceLockDiagnostic } | undefined

		for (;;) {
			try {
				await fs.mkdir(lockDirectory, { mode: 0o700 })
				break
			} catch (error) {
				if (errorCode(error) !== "EEXIST") {
					throw new ParentHandoffFenceUnavailableError(parentTaskId, "filesystem", errorCode(error))
				}
				if (
					takeovers < MAX_TAKEOVERS_PER_ACQUIRE &&
					(await this.quarantineExitedOwner(parentTaskId, key, lockDirectory, generationPath))
				) {
					takeovers++
					continue
				}
				if (timeoutMs >= unrecoverableAfterMs) {
					const observation = await this.observeLock(parentTaskId, lockDirectory)
					const observedAt = Date.now()
					if (!observation?.diagnostic) unusable = undefined
					else if (unusable?.identity !== observation.identity)
						unusable = {
							identity: observation.identity,
							since: observedAt,
							diagnostic: observation.diagnostic,
						}
				}
				if (Date.now() >= deadline) {
					if (unusable && Date.now() - unusable.since >= unrecoverableAfterMs)
						throw new ParentHandoffFenceUnavailableError(
							parentTaskId,
							"unrecoverable",
							undefined,
							unusable.diagnostic,
						)
					throw new ParentHandoffFenceUnavailableError(parentTaskId, "timeout")
				}
				await delay(Math.min(retryIntervalMs, Math.max(1, deadline - Date.now())))
			}
		}

		const ownerToken = crypto.randomUUID()
		try {
			let previousGeneration = 0
			try {
				const raw = await fs.readFile(generationPath, "utf8")
				if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new InvalidGenerationEvidence()
				previousGeneration = Number(raw)
				if (
					!Number.isSafeInteger(previousGeneration) ||
					previousGeneration < 0 ||
					previousGeneration === Number.MAX_SAFE_INTEGER
				)
					throw new InvalidGenerationEvidence()
			} catch (error) {
				if (errorCode(error) !== "ENOENT") throw error
			}
			const generation = previousGeneration + 1
			await durableWrite(generationPath, String(generation))
			const holder = currentHolder()
			const owner: PersistedFenceOwner = {
				schemaVersion: 1,
				parentTaskId,
				ownerToken,
				generation,
				acquiredAt: Date.now(),
				...(holder ? { holder } : {}),
			}
			await durableWrite(ownerPath, JSON.stringify(owner))

			const assertOwned = async () => {
				let currentGeneration: string
				try {
					currentGeneration = await fs.readFile(generationPath, "utf8")
				} catch {
					throw new ParentHandoffFenceOwnershipError(parentTaskId)
				}
				if (currentGeneration !== String(generation)) throw new ParentHandoffFenceOwnershipError(parentTaskId)
				let current: PersistedFenceOwner
				try {
					current = JSON.parse(await fs.readFile(ownerPath, "utf8")) as PersistedFenceOwner
				} catch {
					throw new ParentHandoffFenceOwnershipError(parentTaskId)
				}
				if (
					current.schemaVersion !== 1 ||
					current.parentTaskId !== parentTaskId ||
					current.ownerToken !== ownerToken ||
					current.generation !== generation
				) {
					throw new ParentHandoffFenceOwnershipError(parentTaskId)
				}
			}
			return {
				parentTaskId,
				ownerToken,
				generation,
				assertOwned,
				release: async (): Promise<ParentHandoffFenceReleaseResult> => {
					await assertOwned()
					// Move the instance aside first and delete only a directory proven to be ours. Nothing is
					// ever renamed back onto the lock path: a moved instance never returns there.
					const releasing = path.join(this.fenceRoot, `${key}.lock.released-${crypto.randomUUID()}`)
					try {
						await fs.rename(lockDirectory, releasing)
					} catch (error) {
						throw new ParentHandoffFenceUnavailableError(parentTaskId, "filesystem", errorCode(error))
					}
					const moved = await readOwnRecord(path.join(releasing, "owner.json"))
					if (
						moved.kind === "absent" ||
						(moved.kind === "found" && !isOwnedRecord(moved.value, parentTaskId, ownerToken, generation))
					) {
						// Another instance (or a competitor's directory mid-bootstrap) was moved: retain it aside.
						throw new ParentHandoffFenceOwnershipError(parentTaskId)
					}
					if (moved.kind === "unreadable") {
						// assertOwned() and the move both succeeded, so the lock is released; keep the evidence.
						return retainedAfterRelease(parentTaskId, releasing, moved.code ?? "UNREADABLE_OWNER")
					}
					try {
						await fs.rm(releasing, { recursive: true })
					} catch (error) {
						// The lock is already released. A partial delete may have removed owner.json, so the
						// remainder stays aside as evidence and is never reinstalled at the lock path.
						return retainedAfterRelease(parentTaskId, releasing, errorCode(error) ?? "CLEANUP_FAILED")
					}
					return { cleanup: "complete" }
				},
			}
		} catch (error) {
			// Bootstrap may have published only a prefix. Retain all uncertain evidence; never unlock on failure.
			throw new ParentHandoffFenceUnavailableError(
				parentTaskId,
				"filesystem",
				errorCode(error),
				error instanceof InvalidGenerationEvidence ? "INVALID_GENERATION" : undefined,
			)
		}
	}

	/**
	 * Read-only snapshot of the lock at the lock path. `identity` changes when the directory is
	 * replaced or owner.json changes; `diagnostic` is set only when the owner is unusable, i.e. no
	 * waiter could ever acquire it: it can neither be released by a known live holder nor taken over.
	 * Undefined means the lock vanished (the next mkdir may succeed).
	 */
	private async observeLock(
		parentTaskId: string,
		lockDirectory: string,
	): Promise<{ identity: string; diagnostic?: ParentHandoffFenceLockDiagnostic } | undefined> {
		let directory: fsSync.Stats
		try {
			directory = await fs.stat(lockDirectory)
		} catch {
			return undefined
		}
		let raw: string | undefined
		let readCode: string | undefined
		try {
			raw = await fs.readFile(path.join(lockDirectory, "owner.json"), "utf8")
		} catch (error) {
			readCode = errorCode(error) ?? "UNKNOWN"
		}
		const identity = `${directory.dev}:${directory.ino}:${directory.birthtimeMs}:${
			raw === undefined ? `missing-${readCode}` : digest(raw)
		}`
		if (raw === undefined)
			return { identity, diagnostic: readCode === "ENOENT" ? "INCOMPLETE_OWNER" : "UNREADABLE_OWNER" }
		let owner: unknown
		try {
			owner = JSON.parse(raw)
		} catch {
			return { identity, diagnostic: "UNREADABLE_OWNER" }
		}
		if (isCompleteOwner(owner, parentTaskId)) {
			// A complete owner whose holder may be alive (here or on another host) is contention. A
			// provably exited one that is still at the lock path was not taken over: refused for good.
			return holderProvablyExited(owner.holder) ? { identity, diagnostic: "EXITED_OWNER_REFUSED" } : { identity }
		}
		const record: Partial<Record<keyof PersistedFenceOwner, unknown>> =
			owner && typeof owner === "object" ? owner : {}
		const legacy =
			record.schemaVersion === 1 &&
			record.parentTaskId === parentTaskId &&
			typeof record.ownerToken === "string" &&
			typeof record.generation === "number" &&
			record.holder === undefined
		return { identity, diagnostic: legacy ? "LEGACY_OWNER" : "INCOMPLETE_OWNER" }
	}

	/**
	 * Move a lock whose holder provably exited aside (never delete it). Returns true only after
	 * this call renamed that exact dead instance; false means "not provable now" (refusal).
	 *
	 * Race argument: owner tokens are unique and a moved instance never returns to the lock path,
	 * so reading token T at the lock path pins instance T until someone renames it. Only the holder
	 * of the deepest claim for T renames it. A claim is published by renaming a complete directory
	 * onto a fixed name derived from T, which at most one contender wins and which is never partial
	 * or removed. A crashed claimant is superseded only by a nested claim whose name derives from its
	 * claim token and only after the same exit proof, so two live contenders never both hold the
	 * deepest claim. A live claimant whose attempt failed resumes its own claim (in-process state),
	 * so a transient failure does not strand the lock while the claimant lives. The holder re-reads
	 * T AFTER publishing its claim; a contender that observed T before another contender moved it and
	 * installed a fresh lock therefore reads a different token and moves nothing.
	 */
	private async quarantineExitedOwner(
		parentTaskId: string,
		key: string,
		lockDirectory: string,
		generationPath: string,
	): Promise<boolean> {
		const ownerPath = path.join(lockDirectory, "owner.json")
		const observed = await readJson(ownerPath)
		if (!isCompleteOwner(observed, parentTaskId) || !holderProvablyExited(observed.holder)) return false
		const self = currentHolder()
		if (!self || observed.generation >= Number.MAX_SAFE_INTEGER - 1) return false

		const ownToken = crypto.randomUUID()
		const pending = path.join(this.fenceRoot, `${key}.claim-${ownToken}.tmp`)
		let claimPath = path.join(this.fenceRoot, `${key}.takeover-${digest(observed.ownerToken)}`)
		try {
			await fs.mkdir(pending, { mode: 0o700 })
			const claim: PersistedTakeoverClaim = {
				schemaVersion: 1,
				claimToken: ownToken,
				deadOwnerToken: observed.ownerToken,
				holder: self,
			}
			await durableWrite(path.join(pending, "claim.json"), JSON.stringify(claim))
		} catch (error) {
			await fs.rm(pending, { recursive: true, force: true }).catch(() => undefined)
			throw new ParentHandoffFenceUnavailableError(parentTaskId, "filesystem", errorCode(error))
		}

		let heldToken: string | undefined
		for (let depth = 0; depth < MAX_TAKEOVER_CLAIM_DEPTH && !heldToken; depth++) {
			try {
				// A published claim is never empty, so this rename cannot replace it on any platform.
				await fs.rename(pending, claimPath)
				ownClaims.set(ownToken, "busy")
				heldToken = ownToken
			} catch {
				const existing = await readJson(path.join(claimPath, "claim.json"))
				if (!isCompleteClaim(existing) || existing.deadOwnerToken !== observed.ownerToken) break
				if (ownClaims.get(existing.claimToken) === "idle") {
					// Our own earlier attempt failed after publishing; resume it (synchronous check-and-set).
					ownClaims.set(existing.claimToken, "busy")
					heldToken = existing.claimToken
				} else if (holderProvablyExited(existing.holder)) {
					claimPath = `${claimPath}-${digest(existing.claimToken)}`
				} else break
			}
		}
		if (heldToken !== ownToken) {
			// Our unpublished claim was never visible as authority; it is not lock evidence.
			await fs.rm(pending, { recursive: true, force: true }).catch(() => undefined)
		}
		if (!heldToken) return false

		let outcome: "moved" | "superseded" | "refused" = "refused"
		try {
			for (let attempt = 1; ; attempt++) {
				try {
					outcome = await this.finishTakeover(parentTaskId, key, lockDirectory, generationPath, observed)
					return outcome === "moved"
				} catch (error) {
					if (error instanceof ParentHandoffFenceUnavailableError) {
						outcome = "superseded"
						throw error
					}
					if (attempt >= MAX_TAKEOVER_FINISH_ATTEMPTS)
						throw new ParentHandoffFenceUnavailableError(parentTaskId, "filesystem", errorCode(error))
					await delay(10 * attempt)
				}
			}
		} finally {
			// A finished or irrelevant claim is dropped; otherwise a later attempt here may resume it.
			if (outcome === "refused") ownClaims.set(heldToken, "idle")
			else ownClaims.delete(heldToken)
		}
	}

	/** Runs only while holding the deepest claim for `observed`; throws raw I/O errors for bounded retry. */
	private async finishTakeover(
		parentTaskId: string,
		key: string,
		lockDirectory: string,
		generationPath: string,
		observed: PersistedFenceOwner & { holder: FenceHolder },
	): Promise<"moved" | "superseded" | "refused"> {
		const current = await readJson(path.join(lockDirectory, "owner.json"))
		// Unreadable may be transient: keep the claim resumable. A different complete owner means T is gone.
		if (!isCompleteOwner(current, parentTaskId)) return "refused"
		if (current.ownerToken !== observed.ownerToken || current.generation !== observed.generation)
			return "superseded"
		if (!holderProvablyExited(current.holder)) return "refused"

		// Advance the generation first so even a wrongly-proven holder fails assertOwned().
		// An earlier attempt (ours or a crashed claimant's) may already have advanced it by exactly one.
		const recorded = await fs.readFile(generationPath, "utf8")
		if (recorded === String(observed.generation)) {
			await durableWrite(generationPath, String(observed.generation + 1))
		} else if (recorded !== String(observed.generation + 1)) {
			return "refused"
		}

		const quarantine = path.join(this.fenceRoot, `${key}.lock.exited-${observed.generation}-${crypto.randomUUID()}`)
		await fs.rename(lockDirectory, quarantine)
		const moved = await readJson(path.join(quarantine, "owner.json"))
		if (!isCompleteOwner(moved, parentTaskId) || moved.ownerToken !== observed.ownerToken) {
			// Unreachable under the claim protocol. Retain the moved evidence and refuse.
			throw new ParentHandoffFenceUnavailableError(parentTaskId, "filesystem", "TAKEOVER_MISMATCH")
		}
		return "moved"
	}
}
