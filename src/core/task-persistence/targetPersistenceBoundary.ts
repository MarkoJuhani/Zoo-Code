import * as crypto from "crypto"
import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"
import { AsyncLocalStorage } from "async_hooks"
import deepEqual from "fast-deep-equal"
import type { HistoryItem } from "@roo-code/types"
import type { SafeWriteJsonOptions } from "../../utils/safeWriteJson"
import { getStorageBasePath } from "../../utils/storage"
import {
	advanceOrdinaryPersistenceRevision,
	matchesOrdinaryPersistenceAuthority,
	matchesOrdinaryHistorySnapshot,
	ordinaryPersistenceIdentity,
	type OrdinaryAuthorityHistoryItem,
	type OrdinaryPersistenceIdentity,
} from "./taskLifecycle"
export type { OrdinaryAuthorityHistoryItem } from "./taskLifecycle"
import {
	ParentHandoffFence,
	ParentHandoffFenceUnavailableError,
	ParentHandoffFenceOwnershipError,
	type ParentHandoffFenceLease,
} from "./parentHandoffFence"

const validId = (id: string) => /^[a-zA-Z0-9_-]{1,256}$/.test(id)
const keyFor = (id: string) => crypto.createHash("sha256").update(id).digest("hex")
export const targetPublicationIdentity = (item: HistoryItem) => ({
	id: item.id,
	parentTaskId: item.parentTaskId,
	rootTaskId: item.rootTaskId,
	status: item.status,
	pendingAction: item.pendingAction,
	pendingQuestion: item.pendingQuestion,
	awaitingChildId: item.awaitingChildId,
	delegatedToId: item.delegatedToId,
	completedByChildId: item.completedByChildId,
	childIds: item.childIds,
})
const fields = targetPublicationIdentity
type Identity = ReturnType<typeof fields>
type Binding = { schemaVersion: 1; root: string; parentId: string; identity: Identity; apiSnapshot: string | null }
type Context = { binding: Binding; bytes: string; lease: ParentHandoffFenceLease }
const context = new AsyncLocalStorage<Context>()
const storeMutex = new AsyncLocalStorage<boolean>()
// Not a task ID: serializes startup's whole effect window with binding publication.
const startupAdmissionId = "\u0000startup-admission"
const startupContext = new AsyncLocalStorage<{ root: string; lease: ParentHandoffFenceLease }>()
type ProviderStartContext = {
	root: string
	id: string
	lease: ParentHandoffFenceLease
	active: boolean
	effects: Set<Promise<unknown>>
	parent?: ProviderStartContext
}
const providerStartContext = new AsyncLocalStorage<ProviderStartContext>()

/** Read-only observation: never acquires, validates, joins, releases or exposes an owner token. */
export function providerStartExclusionDiagnostics(
	storage: string,
	id: string,
): {
	scope: "inherited" | "acquire"
	active: boolean
	generation: number | null
	ownerCorrelation: string | null
} {
	try {
		const root = fsSync.realpathSync(storage)
		for (let guard = providerStartContext.getStore(); guard; guard = guard.parent) {
			if (guard.root !== root || guard.id !== id) continue
			return {
				scope: "inherited",
				active: guard.active,
				generation: guard.lease.generation,
				ownerCorrelation: crypto.createHash("sha256").update(guard.lease.ownerToken).digest("hex").slice(0, 16),
			}
		}
	} catch {
		// Missing roots are diagnostic absence, never execution permission.
	}
	return { scope: "acquire", active: false, generation: null, ownerCorrelation: null }
}

export type OrdinaryTaskPersistenceAuthority = OrdinaryPersistenceIdentity & {
	observed: boolean
	refused: boolean
}
export class OrdinaryPersistenceAuthorityError extends Error {
	constructor(
		message: string,
		public readonly originalError?: unknown,
	) {
		super(`Ordinary persistence authority refused: ${message}`)
		this.name = "OrdinaryPersistenceAuthorityError"
	}
}
/** Refusal may be wrapped by a final-publication error; it is never retryable I/O. */
export function isPersistenceAuthorityError(error: unknown): boolean {
	if (
		error instanceof OrdinaryPersistenceAuthorityError ||
		error instanceof ParentHandoffFenceUnavailableError ||
		error instanceof ParentHandoffFenceOwnershipError
	)
		return true
	return (
		error instanceof Error &&
		"originalError" in error &&
		error.originalError !== error &&
		isPersistenceAuthorityError(error.originalError)
	)
}
/**
 * A bounded fence wait that expired while a live, completely recorded owner kept the lock
 * (reason `timeout`) is contention. Reasons `unrecoverable` and `filesystem` are not. Unwraps
 * like isPersistenceAuthorityError and stops at the first authority-class error, so an explicit
 * refusal that wraps a timeout stays a refusal.
 */
export function isPersistenceContentionError(error: unknown): boolean {
	if (error instanceof ParentHandoffFenceUnavailableError) return error.reason === "timeout"
	if (error instanceof OrdinaryPersistenceAuthorityError || error instanceof ParentHandoffFenceOwnershipError)
		return false
	return (
		error instanceof Error &&
		"originalError" in error &&
		error.originalError !== error &&
		isPersistenceContentionError(error.originalError)
	)
}
/**
 * Authority loss is sticky for the instance. Contention is refused only for this attempt, and
 * only when it happened while acquiring exclusion, before the effect started: then nothing was
 * published. A timeout that escapes a started effect (which may already have written) stays sticky.
 */
export function isStickyPersistenceRefusal(error: unknown, effectStarted: boolean): boolean {
	return isPersistenceAuthorityError(error) && (effectStarted || !isPersistenceContentionError(error))
}
export function createOrdinaryTaskPersistenceAuthority(
	item: Pick<OrdinaryAuthorityHistoryItem, "id" | "parentTaskId" | "rootTaskId" | "ordinaryPersistenceRevision">,
): OrdinaryTaskPersistenceAuthority {
	return {
		...ordinaryPersistenceIdentity(item),
		observed: false,
		refused: false,
	}
}
/** Advance both sides of abandonment inside their actual per-file publications, not a sidecar transaction. */
export function advanceOrdinaryPersistenceAuthority(item: HistoryItem): OrdinaryAuthorityHistoryItem {
	return advanceOrdinaryPersistenceRevision(item, crypto.randomUUID())
}
const ordinaryContext = new AsyncLocalStorage<{ root: string; authority: OrdinaryTaskPersistenceAuthority }>()

/** Explicit instance revision is comparison evidence, never permission to advance authority. */
export function assertOrdinaryHistorySnapshot(item: HistoryItem, existing: unknown): void {
	if (!matchesOrdinaryHistorySnapshot(item, existing as OrdinaryAuthorityHistoryItem | null))
		throw new OrdinaryPersistenceAuthorityError("stale metadata snapshot revision or lineage")
}

/** Fresh lease acquisition cannot renew an old Task's authority. No acquisition under file/store locks. */
export function assertOrdinaryTaskPersistenceAuthority(storage: string, id: string): void {
	const current = ordinaryContext.getStore()
	if (!current || current.authority.id !== id) return
	const { authority } = current
	const refuse = (message: string): never => {
		authority.refused = true
		throw new OrdinaryPersistenceAuthorityError(message)
	}
	if (authority.refused) refuse("instance was previously refused")
	if (fsSync.realpathSync(storage) !== current.root) refuse("storage root changed")
	for (const ancestor of [authority.parentTaskId, authority.rootTaskId]) {
		if (ancestor && ancestor !== id) assertPersistenceExclusion(current.root, ancestor)
	}
	let item: OrdinaryAuthorityHistoryItem
	try {
		const file = path.join(current.root, "tasks", id, "history_item.json")
		assertRegular(file)
		item = JSON.parse(fsSync.readFileSync(file, "utf8"))
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" && !authority.observed) return
		refuse(`metadata unavailable: ${String(error)}`)
	}
	if (!matchesOrdinaryPersistenceAuthority(authority, item!)) refuse("stale instance revision or lineage")
	authority.observed = true
}
export async function withOrdinaryTaskPersistence<T>(
	storage: string,
	authority: OrdinaryTaskPersistenceAuthority,
	effect: () => Promise<T>,
): Promise<T> {
	if (authority.refused) throw new OrdinaryPersistenceAuthorityError("instance was previously refused")
	// Set once every exclusion is held; any later failure may follow a partial write.
	let effectStarted = false
	try {
		return await withPersistenceExclusions(
			storage,
			[authority.id, ...[authority.parentTaskId, authority.rootTaskId].filter((id): id is string => !!id)],
			async () => {
				effectStarted = true
				const root = await resolveRoot(storage)
				return ordinaryContext.run({ root, authority }, async () => {
					assertOrdinaryTaskPersistenceAuthority(root, authority.id)
					if (await lookup(root, authority.id)) throw new OrdinaryPersistenceAuthorityError("bound target")
					const value = await effect()
					assertOrdinaryTaskPersistenceAuthority(root, authority.id)
					return value
				})
			},
		)
	} catch (error) {
		if (isStickyPersistenceRefusal(error, effectStarted)) authority.refused = true
		throw error
	}
}

/** Exclude binding from the first capable provider effect through cleanup. Never called under a store/file lock. */
export function withProviderStartExclusion<T>(
	storage: string,
	id: string,
	effect: () => Promise<T>,
	options: { fresh?: boolean; persistence?: boolean; failFast?: boolean } = {},
): Promise<T> {
	// Join synchronously, before root resolution can let the inherited owner settle.
	// A late timer still observes an inactive guard and refuses; no context is renewed.
	const owners: ProviderStartContext[] = []
	for (let guard = providerStartContext.getStore(); guard; guard = guard.parent) {
		if (guard.active) owners.push(guard)
	}
	const operation = withProviderStartExclusionPhase(storage, id, effect, options)
	for (const owner of owners) owner.effects.add(operation)
	const settled = () => {
		for (const owner of owners) owner.effects.delete(operation)
	}
	void operation.then(settled, settled)
	return operation
}

async function withProviderStartExclusionPhase<T>(
	storage: string,
	id: string,
	effect: () => Promise<T>,
	options: { fresh?: boolean; persistence?: boolean; failFast?: boolean },
): Promise<T> {
	if (!validId(id) || storeMutex.getStore()) throw new Error("Provider start exclusion unavailable")
	const root = await resolveRoot(storage)
	const inherited = providerStartContext.getStore()
	for (let current = inherited; current; current = current.parent) {
		if (current.root !== root || current.id !== id) continue
		if (options.fresh) {
			if (current.active)
				throw new OrdinaryPersistenceAuthorityError(
					"Fresh exclusion cannot reacquire an inherited capable scope",
				)
			// Explicit queued callbacks may acquire a NEW lease, never reuse this one.
			continue
		}
		if (!current.active) throw new OrdinaryPersistenceAuthorityError("Provider start exclusion expired")
		await current.lease.assertOwned()
		return effect()
	}
	// A queued callback must not inherit a lease that its enqueuer will release.
	const lease = await new ParentHandoffFence(root).acquire(id, {
		timeoutMs: options.failFast ? 0 : options.fresh || options.persistence ? 30_000 : 0,
	})
	const guard: ProviderStartContext = { root, id, lease, active: true, effects: new Set(), parent: inherited }
	try {
		return await providerStartContext.run(guard, async () => {
			await lease.assertOwned()
			if (await lookup(root, id))
				throw new OrdinaryPersistenceAuthorityError("Bound parent cannot start or delegate")
			const result = await effect()
			while (guard.effects.size) await Promise.allSettled([...guard.effects])
			await lease.assertOwned()
			return result
		})
	} finally {
		// Detached capable descendants may outlive the original model loop. Drain
		// every joined effect (including additions while draining) before release.
		while (guard.effects.size) await Promise.allSettled([...guard.effects])
		guard.active = false
		await lease.release()
	}
}

/** A queued ordinary run is independent of its enqueuer, never a lease surrender. */
export function inIndependentTaskOrchestration<T>(effect: () => T): T {
	if (storeMutex.getStore()) throw new OrdinaryPersistenceAuthorityError("Orchestration cannot escape a store mutex")
	return providerStartContext.exit(() => ordinaryContext.exit(() => context.exit(() => startupContext.exit(effect))))
}

/** Idle orchestration cannot surrender an arbitrary caller's capable effect window. */
export async function assertUnprotectedQuestionWait(storage: string): Promise<void> {
	const root = await resolveRoot(storage)
	for (let guard = providerStartContext.getStore(); guard; guard = guard.parent) {
		if (guard.root === root)
			throw new OrdinaryPersistenceAuthorityError("Question wait requires an independent orchestration context")
	}
	if (ordinaryContext.getStore()?.root === root || context.getStore()?.binding.root === root || storeMutex.getStore())
		throw new OrdinaryPersistenceAuthorityError("Question wait cannot hold a persistence effect scope")
}

/** Validate the still-live lease at a provider publication/commit boundary. */
export async function assertProviderStartExclusion(storage: string, id: string): Promise<void> {
	const root = await resolveRoot(storage)
	for (let guard = providerStartContext.getStore(); guard; guard = guard.parent) {
		if (guard.root !== root || guard.id !== id) continue
		if (!guard.active) throw new OrdinaryPersistenceAuthorityError("Provider start exclusion expired")
		await guard.lease.assertOwned()
		if (await lookup(root, id)) throw new OrdinaryPersistenceAuthorityError("Bound parent cannot start or delegate")
		return
	}
	throw new Error("Provider start exclusion unavailable")
}

/** Final locked writer check only validates inherited ownership; it never acquires a lease. */
function assertInheritedProviderGeneration(root: string, id: string, required = false): void {
	for (let guard = providerStartContext.getStore(); guard; guard = guard.parent) {
		if (guard.root !== root || guard.id !== id) continue
		if (!guard.active) throw new OrdinaryPersistenceAuthorityError("Provider start exclusion expired")
		const fence = path.join(root, ".handoff-fences")
		const key = keyFor(id)
		let owner: { ownerToken: string; generation: number }, generation: string
		try {
			owner = JSON.parse(fsSync.readFileSync(path.join(fence, `${key}.lock`, "owner.json"), "utf8"))
			generation = fsSync.readFileSync(path.join(fence, `${key}.generation`), "utf8")
		} catch (error) {
			throw new OrdinaryPersistenceAuthorityError("Provider start ownership evidence lost", error)
		}
		if (
			owner.ownerToken !== guard.lease.ownerToken ||
			owner.generation !== guard.lease.generation ||
			generation !== String(guard.lease.generation)
		)
			throw new OrdinaryPersistenceAuthorityError("Provider start generation lost")
		return
	}
	if (required) throw new Error("Parent persistence exclusion unavailable")
}

/** Timers/watchers must not inherit an admission lease that startup later releases. */
export function withoutStartupAdmission<T>(effect: () => T): T {
	return startupContext.exit(effect)
}

export function assertStartupAdmission(storage: string, required = false): void {
	const current = startupContext.getStore()
	if (!current) {
		if (required) throw new Error("Startup admission is required before repair")
		return
	}
	const root = fsSync.realpathSync(storage)
	if (current.root !== root) throw new Error("Startup admission root changed")
	const key = keyFor(startupAdmissionId)
	const fence = path.join(root, ".handoff-fences")
	const owner = JSON.parse(fsSync.readFileSync(path.join(fence, `${key}.lock`, "owner.json"), "utf8"))
	const generation = fsSync.readFileSync(path.join(fence, `${key}.generation`), "utf8")
	if (
		owner.ownerToken !== current.lease.ownerToken ||
		owner.generation !== current.lease.generation ||
		generation !== String(current.lease.generation)
	)
		throw new Error("Startup admission generation lost")
}

/** Diagnostic location of the startup admission lock for user-facing recovery text; never an ownership check. */
export function startupAdmissionLockDirectory(root: string): string {
	return path.join(root, ".handoff-fences", `${keyFor(startupAdmissionId)}.lock`)
}

export async function withStartupAdmission<T>(storage: string, effect: () => Promise<T>): Promise<T> {
	await fs.mkdir(await getStorageBasePath(storage), { recursive: true })
	const root = await resolveRoot(storage)
	if (startupContext.getStore()) {
		assertStartupAdmission(root)
		return effect()
	}
	if (storeMutex.getStore()) throw new Error("Startup admission cannot be acquired inside store mutex")
	const lease = await new ParentHandoffFence(root).acquire(startupAdmissionId, { timeoutMs: 30_000 })
	try {
		await lease.assertOwned()
		return await startupContext.run({ root, lease }, async () => {
			const value = await effect()
			await lease.assertOwned()
			return value
		})
	} finally {
		await lease.release()
	}
}

/** Store callbacks cannot acquire parent exclusion below the store mutex. */
export function underStoreMutex<T>(effect: () => Promise<T>): Promise<T> {
	return storeMutex.run(true, effect)
}

function boundPath(root: string, id: string) {
	return path.join(root, ".handoff-fences", `${keyFor(id)}.target.json`)
}
function assertRegular(file: string) {
	const stat = fsSync.lstatSync(file)
	if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Target evidence is not a regular file")
}
function parseBinding(bytes: string, root: string, id: string): Binding {
	const value: Binding = JSON.parse(bytes)
	if (
		value.schemaVersion !== 1 ||
		value.root !== root ||
		value.parentId !== id ||
		!value.identity ||
		value.identity.id !== id ||
		!(value.apiSnapshot === null || typeof value.apiSnapshot === "string")
	)
		throw new Error("Uncertain target binding")
	return value
}
async function resolveRoot(storage: string) {
	return fs.realpath(await getStorageBasePath(storage))
}
function diskIdentity(root: string, id: string): Identity {
	const taskDir = path.join(root, "tasks", id)
	const tasksDir = path.join(root, "tasks")
	for (const directory of [tasksDir, path.join(tasksDir, id)]) {
		const stat = fsSync.lstatSync(directory)
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Uncertain target directory")
	}
	const file = path.join(taskDir, "history_item.json")
	assertRegular(file)
	const item: HistoryItem = JSON.parse(fsSync.readFileSync(file, "utf8"))
	if (item.id !== id) throw new Error("Uncertain target metadata")
	return JSON.parse(JSON.stringify(fields(item))) as Identity
}
/** Opt-in isolated target binding; never a B1 write or an eligibility token. */
export async function bindTargetPersistence(
	storage: string,
	parentId: string,
	action: HistoryItem["pendingAction"],
): Promise<void> {
	if (!validId(parentId) || !action) throw new Error("Invalid target identity")
	const root = await resolveRoot(storage)
	if (storeMutex.getStore()) throw new Error("Target admission cannot be acquired inside store mutex")
	const admission = await new ParentHandoffFence(root).acquire(startupAdmissionId, { timeoutMs: 0 })
	try {
		const lease = await new ParentHandoffFence(root).acquire(parentId, { timeoutMs: 0 })
		try {
			await admission.assertOwned()
			await lease.assertOwned()
			const tasks = path.join(root, "tasks")
			if (
				(await fs.readdir(tasks)).some((entry) =>
					entry.startsWith("_delegation_repair_intent.json.quarantine-"),
				)
			)
				throw new Error("Ambiguous startup intent evidence")
			const intent = path.join(tasks, "_delegation_repair_intent.json")
			try {
				await fs.access(intent)
				throw new Error("Startup intent is unresolved")
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			}
			const identity = diskIdentity(root, parentId)
			if (!deepEqual(identity.pendingAction, action)) throw new Error("Changed target action")
			const apiFile = path.join(root, "tasks", parentId, "api_conversation_history.json")
			let apiSnapshot: string | null = null
			try {
				assertRegular(apiFile)
				apiSnapshot = JSON.stringify(JSON.parse(await fs.readFile(apiFile, "utf8")))
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			}
			const directory = path.join(root, ".handoff-fences")
			await fs.mkdir(directory, { recursive: true, mode: 0o700 })
			await admission.assertOwned()
			await lease.assertOwned()
			await fs.writeFile(
				boundPath(root, parentId),
				JSON.stringify({ schemaVersion: 1, root, parentId, identity, apiSnapshot } satisfies Binding),
				{ flag: "wx", mode: 0o600 },
			)
			await admission.assertOwned()
			await lease.assertOwned()
		} finally {
			await lease.release()
		}
	} finally {
		await admission.release()
	}
}

async function lookup(
	storage: string,
	id: string,
): Promise<{ root: string; binding: Binding; bytes: string } | undefined> {
	if (!validId(id)) throw new Error("Invalid task identity")
	let root: string
	try {
		root = await resolveRoot(storage)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
		throw error
	}
	const file = boundPath(root, id)
	let bytes: string
	try {
		assertRegular(file)
		bytes = await fs.readFile(file, "utf8")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
		throw error
	}
	return { root, bytes, binding: parseBinding(bytes, root, id) }
}

/** Resolve disk lineage before any lower-level lock; aliases share a canonical root. */
export async function withPersistenceExclusions<T>(
	storage: string,
	ids: string[],
	effect: () => Promise<T>,
	options: { failFast?: boolean } = {},
): Promise<T> {
	if (storeMutex.getStore()) throw new Error("Parent planning cannot acquire exclusion inside store mutex")
	await fs.mkdir(await getStorageBasePath(storage), { recursive: true })
	const root = await resolveRoot(storage)
	const planned = new Set<string>()
	const visit = async (id: string): Promise<void> => {
		if (!validId(id)) throw new Error("Invalid persistence lineage")
		if (planned.has(id)) return
		planned.add(id)
		if (planned.size > 256) throw new Error("Uncertain persistence lineage")
		let item: HistoryItem
		try {
			item = JSON.parse(await fs.readFile(path.join(root, "tasks", id, "history_item.json"), "utf8"))
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return
			throw error
		}
		if (item.id !== id) throw new Error("Changed persistence identity")
		if (item.parentTaskId) await visit(item.parentTaskId)
		if (item.rootTaskId && item.rootTaskId !== id) await visit(item.rootTaskId)
	}
	for (const id of ids) await visit(id)
	const ordered = [...planned].sort()
	const next = (index: number): Promise<T> =>
		index === ordered.length
			? effect()
			: withSingleTargetPersistence(root, ordered[index], () => next(index + 1), options)
	return next(0)
}

export function withTargetPersistence<T>(storage: string, id: string, effect: () => Promise<T>): Promise<T> {
	return withPersistenceExclusions(storage, [id], effect)
}

/** Check a planned parent lease without acquiring below a file/store lock. */
export function assertPersistenceExclusion(storage: string, id: string): void {
	const root = fsSync.realpathSync(storage)
	assertInheritedProviderGeneration(root, id, true)
	assertTargetEffect(root, id)
	if (fsSync.existsSync(boundPath(root, id))) throw new Error("Bound target repair refused")
}

/** Capture authoritative task ancestry while leases are held, then recheck at API migration effects. */
export function persistenceIdentityGuard(storage: string, id: string): () => void {
	const root = fsSync.realpathSync(storage)
	const snapshots = new Map<string, Identity | null>()
	const visit = (taskId: string, required = false): void => {
		if (snapshots.has(taskId)) return
		assertPersistenceExclusion(root, taskId)
		let identity: Identity
		try {
			identity = diskIdentity(root, taskId)
		} catch (error) {
			if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") {
				snapshots.set(taskId, null)
				return
			}
			throw error
		}
		snapshots.set(taskId, identity)
		if (identity.parentTaskId) visit(identity.parentTaskId, true)
		if (identity.rootTaskId && identity.rootTaskId !== taskId) visit(identity.rootTaskId, true)
	}
	visit(id)
	return () => {
		for (const [taskId, original] of snapshots) {
			assertPersistenceExclusion(root, taskId)
			if (original === null) {
				if (fsSync.existsSync(path.join(root, "tasks", taskId, "history_item.json")))
					throw new Error("Migration task authority appeared")
			} else if (!deepEqual(diskIdentity(root, taskId), original))
				throw new Error("Migration task action, owner, question or lineage changed")
		}
	}
}

/** Called BEFORE any store mutex or file lock. Missing/lost exclusion blocks only the bound parent. */
async function withSingleTargetPersistence<T>(
	storage: string,
	id: string,
	effect: () => Promise<T>,
	options: { failFast?: boolean },
): Promise<T> {
	const target = await lookup(storage, id)
	if (!target) {
		await fs.mkdir(await getStorageBasePath(storage), { recursive: true })
		return withProviderStartExclusion(storage, id, effect, { persistence: true, ...options })
	}
	const current = context.getStore()
	if (current?.binding.root === target.root && current.binding.parentId === id) return effect()
	if (storeMutex.getStore()) throw new Error("Target exclusion cannot be acquired inside store mutex")
	const lease = await new ParentHandoffFence(target.root).acquire(id, { timeoutMs: 0 })
	let outcome: { ok: true; value: T } | { ok: false; error: unknown }
	try {
		const guard: Context = { binding: target.binding, bytes: target.bytes, lease }
		const value = await context.run(guard, async () => {
			assertTargetEffect(target.root, id)
			return effect()
		})
		outcome = { ok: true, value }
	} catch (error) {
		outcome = { ok: false, error }
	}
	try {
		await lease.release()
	} catch (error) {
		if (outcome.ok) throw error
	}
	if (!outcome.ok) throw outcome.error
	return outcome.value
}

/** Synchronous final-file-lock predicate: no waiting for parent exclusion under a store/file lock. */
export function assertTargetEffect(storage: string, id: string, existing?: unknown): void {
	const guard = context.getStore()
	const root = fsSync.realpathSync(storage)
	assertOrdinaryTaskPersistenceAuthority(root, id)
	assertInheritedProviderGeneration(root, id)
	const parentId = (existing as HistoryItem | undefined)?.parentTaskId
	if (parentId) assertInheritedProviderGeneration(root, parentId, !!providerStartContext.getStore())
	const file = boundPath(root, id)
	let bytes: string
	try {
		assertRegular(file)
		bytes = fsSync.readFileSync(file, "utf8")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" && guard?.binding.parentId !== id) return
		throw error
	}
	parseBinding(bytes, root, id)
	if (!guard || guard.binding.root !== root || guard.binding.parentId !== id || guard.bytes !== bytes)
		throw new Error("Target exclusion unavailable")
	const key = keyFor(id)
	const fence = path.join(root, ".handoff-fences")
	const owner = JSON.parse(fsSync.readFileSync(path.join(fence, `${key}.lock`, "owner.json"), "utf8"))
	const generation = fsSync.readFileSync(path.join(fence, `${key}.generation`), "utf8")
	if (
		owner.ownerToken !== guard.lease.ownerToken ||
		owner.generation !== guard.lease.generation ||
		generation !== String(guard.lease.generation)
	)
		throw new Error("Target generation lost")
	const identity =
		existing === undefined
			? diskIdentity(root, id)
			: (JSON.parse(JSON.stringify(fields(existing as HistoryItem))) as Identity)
	if (!deepEqual(identity, guard.binding.identity)) throw new Error("Target action, owner or question changed")
}

export async function isTargetBound(storage: string, id: string): Promise<boolean> {
	return !!(await lookup(storage, id))
}

export function assertTargetTaskOutput(storage: string, id: string, output: HistoryItem): void {
	const root = fsSync.realpathSync(storage)
	assertInheritedProviderGeneration(root, id)
	for (const ancestor of [output.parentTaskId, output.rootTaskId]) {
		if (ancestor && ancestor !== id) {
			assertInheritedProviderGeneration(root, ancestor, !!providerStartContext.getStore())
			if (fsSync.existsSync(boundPath(root, ancestor))) throw new Error("Bound ancestor publication refused")
		}
	}
	const guard = context.getStore()
	if (
		guard?.binding.parentId === id &&
		!deepEqual(JSON.parse(JSON.stringify(fields(output))), guard.binding.identity)
	)
		throw new Error("Target action, owner or question update refused")
}

/** Called inside the API file lock; the snapshot is comparison evidence, not append permission. */
export function assertTargetApiEffect(storage: string, id: string, existing: unknown): void {
	assertTargetEffect(storage, id)
	const guard = context.getStore()
	if (guard && JSON.stringify(existing) !== guard.binding.apiSnapshot) throw new Error("Target API history changed")
}

export function assertTargetApiOutput(storage: string, id: string, output: unknown): void {
	const guard = context.getStore()
	if (guard?.binding.parentId === id && JSON.stringify(output) !== guard.binding.apiSnapshot)
		throw new Error("Target ordinary API replacement refused")
}

/** No acquisition here: callers must enter exclusion before their store/file lock. */
export function targetPublicationGuard(
	storage: string,
	id: string,
	api = false,
): SafeWriteJsonOptions["publicationGuard"] {
	return {
		check: (existing, output) => {
			assertStartupAdmission(storage)
			if (api) {
				assertTargetApiEffect(storage, id, existing)
				assertTargetApiOutput(storage, id, output)
			} else {
				assertTargetEffect(storage, id, existing)
				assertTargetTaskOutput(storage, id, output as HistoryItem)
			}
		},
	}
}
