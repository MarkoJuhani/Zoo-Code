import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"
import crypto from "crypto"
import * as lockfile from "proper-lockfile"

import deepEqual from "fast-deep-equal"
import type { HistoryItem } from "@roo-code/types"

import { GlobalFileNames } from "../../shared/globalFileNames"
import { LOCK_STALE_MS, safeWriteJson } from "../../utils/safeWriteJson"
import { getStorageBasePath } from "../../utils/storage"
import {
	assertValidTransition,
	type HistoryItemStatus,
	matchesOrdinaryPersistenceAuthority,
	type OrdinaryAuthorityHistoryItem,
	type OrdinaryPersistenceIdentity,
	resumeInterruptedTask,
} from "./taskLifecycle"
import { computeHistoryDelta, DeltaRejectedError, mergeHistoryDelta } from "./taskStoreConcurrency"
import {
	assertOrdinaryHistorySnapshot,
	OrdinaryPersistenceAuthorityError,
	targetPublicationGuard,
	targetPublicationIdentity,
	withPersistenceExclusions,
	assertPersistenceExclusion,
	assertTargetEffect,
	assertTargetTaskOutput,
	assertStartupAdmission,
	isTargetBound,
	underStoreMutex,
	withStartupAdmission,
	withTargetPersistence,
	withoutStartupAdmission,
	startupAdmissionLockDirectory,
} from "./targetPersistenceBoundary"
import { ParentHandoffFenceUnavailableError } from "./parentHandoffFence"
import { findLivePeerHosts, publishHostPresence, type HostPresence } from "./hostPresence"

export { assertValidTransition, type HistoryItemStatus } from "./taskLifecycle"
export { DeltaRejectedError } from "./taskStoreConcurrency"

/**
 * Startup admission was refused, so history was loaded by a read-only scan and every
 * admission-gated startup effect (intent replay, delegation repair, migration) was skipped.
 */
export class TaskHistoryStartupDegradedError extends Error {
	/** Fence folder holding the startup admission evidence. */
	public readonly fenceDirectory: string
	/** Generation file paired with the startup admission lock (`<key>.generation` beside `<key>.lock`). */
	public readonly generationPath: string

	constructor(
		public readonly admissionError: ParentHandoffFenceUnavailableError,
		/** Startup admission lock location, for recovery text only. */
		public readonly lockDirectory: string,
	) {
		super(
			`Task history was loaded, but startup repairs were skipped because startup admission is unavailable (${admissionError.message}). ` +
				"Intent replay, delegation repair and history migration did not run; ordinary task saves continue.",
		)
		this.name = "TaskHistoryStartupDegradedError"
		this.fenceDirectory = path.dirname(lockDirectory)
		this.generationPath = `${lockDirectory.replace(/\.lock$/, "")}.generation`
	}
}

/**
 * Build a `safeWriteJson` merge callback that applies only `delta` to the
 * current disk state, preserving fields written by another process.
 */
function mergeWithDisk(delta: Partial<HistoryItem>): (existing: unknown, incoming: unknown) => unknown {
	return (existing, incoming) => mergeHistoryDelta(existing, incoming as HistoryItem, delta)
}

/**
 * Durable intent for the one repair that spans an active delegated child and
 * its parent. Task files remain authoritative; this file only records the
 * guarded target transition that must be completed after a crash.
 */
interface DelegationRepairIntent {
	version: 1
	operationId: string
	parentTaskId: string
	childTaskId: string
	expected: {
		parent: {
			status: "delegated"
			awaitingChildId: string
			delegatedToId?: string
		}
		child: {
			status: "active"
			parentTaskId?: string
			rootTaskId?: string
		}
	}
	target: {
		childStatus: "interrupted"
		parentStatus: "active"
	}
}

/**
 * TaskHistoryStore encapsulates all task history persistence logic.
 *
 * Each task's HistoryItem is stored as an individual JSON file in its
 * existing task directory (`globalStorage/tasks/<taskId>/history_item.json`).
 * There is no shared index file. Reads scan the task directories.
 *
 * Cross-process safety for per-task files comes from `safeWriteJson`'s
 * `proper-lockfile` with a `merge` callback: each write reads the
 * current file under the advisory lock and merges incoming fields, so
 * a concurrent writer's changes are preserved rather than silently
 * dropped. Within a single extension host process, an in-process write
 * lock serializes mutations.
 */
/**
 * Options for TaskHistoryStore constructor.
 */
export interface TaskHistoryStoreOptions {
	/**
	 * Optional callback invoked inside the write lock after each mutation
	 * (upsert, delete, deleteMany). Used for serialized write-through to
	 * globalState during the transition period.
	 */
	onWrite?: (items: HistoryItem[]) => Promise<void>
}

export type AuthoritativeTaskHistoryRead =
	| { kind: "found"; item: HistoryItem }
	| { kind: "missing" }
	| { kind: "read_error"; error: unknown }

export class TaskHistoryStore {
	private readonly globalStoragePath: string
	private readonly onWrite?: (items: HistoryItem[]) => Promise<void>
	private cache: Map<string, HistoryItem> = new Map()
	private taskFileMtimes: Map<string, number> = new Map()
	private writeLock: Promise<void> = Promise.resolve()
	private fsWatcher: fsSync.FSWatcher | null = null
	private reconcileTimer: ReturnType<typeof setTimeout> | null = null
	private disposed = false
	private persistenceRoot?: string
	private readonly blockedRepairs = new Set<string>()
	private hostPresence?: HostPresence

	/**
	 * Promise that resolves when initialization is complete.
	 * Callers can await this to ensure the store is ready before reading.
	 */
	public readonly initialized: Promise<void>
	private resolveInitialized!: () => void

	/** Periodic reconciliation interval in milliseconds. */
	private static readonly RECONCILE_INTERVAL_MS = 5 * 60 * 1000

	constructor(globalStoragePath: string, options?: TaskHistoryStoreOptions) {
		this.globalStoragePath = globalStoragePath
		this.onWrite = options?.onWrite
		this.initialized = new Promise<void>((resolve) => {
			this.resolveInitialized = resolve
		})
	}

	// ────────────────────────────── Lifecycle ──────────────────────────────

	/**
	 * Scan task files, reconcile delegation state, start watchers.
	 */
	async initialize(): Promise<void> {
		let admitted = false
		try {
			// Publish before waiting for admission: a peer's startup repair must see this store
			// before it can own a running task, even if this store's own startup degrades.
			await this.publishPresence()
			await withStartupAdmission(this.globalStoragePath, async () => {
				admitted = true
				this.persistenceRoot = await fs.realpath(await getStorageBasePath(this.globalStoragePath))
				const tasksDir = await this.getTasksDir()
				await fs.mkdir(tasksDir, { recursive: true })

				// 1. Scan task directories to populate the cache
				await this.reconcile({ forceRefresh: true })
				// Capture which active tasks were present in persisted state before replay can
				// change any statuses. Reconciliation must not treat a replay-repaired parent
				// as an orphaned active child in the same startup pass.
				const persistedActiveIds = this.getPersistedActiveIds()

				// 2. Complete any two-record repair interrupted after its intent was durable.
				try {
					await this.replayDelegationRepairIntent()
				} catch (error) {
					console.error("[TaskHistoryStore] Failed to replay delegation repair intent:", error)
				}

				// 3. Repair delegation inconsistencies left by a previous crash
				await this.reconcileDelegationState(persistedActiveIds)

				// Register while startup owns admission, but future callbacks must not inherit its released lease.
				withoutStartupAdmission(() => {
					this.startWatcher()
					this.startPeriodicReconciliation()
				})
			})
		} catch (error) {
			// Only a refusal before admission degrades; failures inside admitted startup keep failing.
			if (admitted || !(error instanceof ParentHandoffFenceUnavailableError)) throw error
			// Show persisted history from a write-free scan. Intent replay, delegation repair and
			// migration require held admission and are skipped; watcher and periodic scans only read.
			const root = await fs.realpath(await getStorageBasePath(this.globalStoragePath))
			this.persistenceRoot = root
			await this.reconcile({ forceRefresh: true })
			this.startWatcher()
			this.startPeriodicReconciliation()
			throw new TaskHistoryStartupDegradedError(error, startupAdmissionLockDirectory(root))
		} finally {
			// Mark initialization as complete so callers awaiting `initialized` can proceed
			this.resolveInitialized()
		}
	}

	/** Best-effort: a store that cannot publish behaves as before, invisible to peers' startup repair. */
	private async publishPresence(): Promise<void> {
		try {
			const base = await getStorageBasePath(this.globalStoragePath)
			await fs.mkdir(base, { recursive: true })
			const presence = await publishHostPresence(await fs.realpath(base))
			if (this.disposed) presence.release()
			else this.hostPresence = presence
		} catch (error) {
			console.error("[TaskHistoryStore] Failed to publish host presence:", error)
		}
	}

	/**
	 * Flush pending writes, clear watchers, release resources.
	 */
	dispose(): void {
		this.disposed = true
		this.hostPresence?.release()
		this.hostPresence = undefined

		if (this.reconcileTimer) {
			clearTimeout(this.reconcileTimer)
			this.reconcileTimer = null
		}

		if (this.fsWatcher) {
			this.fsWatcher.close()
			this.fsWatcher = null
		}
	}

	// ────────────────────────────── Reads ──────────────────────────────

	/**
	 * Get a single history item by task ID.
	 */
	get(taskId: string): HistoryItem | undefined {
		return this.cache.get(taskId)
	}

	/** Read one metadata record from disk under the store lock without legacy fallback. */
	async readAuthoritative(taskId: string): Promise<AuthoritativeTaskHistoryRead> {
		await this.initialized
		return this.withLock(async () => {
			const result = await this.readTaskFileAuthoritative(taskId)
			if (result.kind === "found") {
				this.cache.set(taskId, result.item)
			} else if (result.kind === "missing") {
				this.cache.delete(taskId)
			}
			return result
		})
	}

	/**
	 * Get all history items, sorted by timestamp descending (newest first).
	 */
	getAll(): HistoryItem[] {
		return Array.from(this.cache.values()).sort((a, b) => b.ts - a.ts)
	}

	/**
	 * Get history items filtered by workspace path.
	 */
	getByWorkspace(workspace: string): HistoryItem[] {
		return this.getAll().filter((item) => item.workspace === workspace)
	}

	// ────────────────────────────── Mutations ──────────────────────────────

	/**
	 * Insert or update a history item.
	 *
	 * Writes the per-task file immediately (source of truth)
	 * and updates the in-memory cache.
	 */
	async upsert(item: HistoryItem): Promise<HistoryItem[]> {
		return this.withTargetIds(
			[item.id, ...[item.parentTaskId, item.rootTaskId].filter((id): id is string => !!id)],
			() => this.withLock(() => this.upsertCore(item)),
		)
	}

	/**
	 * Core upsert logic — must only be called from within `withLock`.
	 *
	 * Enforces state-machine transition rules when `item.status` changes.
	 * Pass `skipTransitionCheck: true` only for administrative repairs (reconciliation,
	 * migration) that need to write corrected state outside the normal task lifecycle.
	 */
	private async upsertCore(
		item: HistoryItem,
		options: { skipTransitionCheck?: boolean } = {},
	): Promise<HistoryItem[]> {
		const existing = this.cache.get(item.id)

		// Enforce transition validity at the write boundary so that any caller
		// (including fire-and-forget saves) cannot silently stomp a terminal status.
		// Skip when there is no existing record — first insert has no prior state to transition from.
		// Normalize existing.status (undefined = legacy "active") before comparing so that writing
		// status: "active" onto a legacy item without a status field is not treated as a transition.
		if (!options.skipTransitionCheck && existing && item.status !== undefined) {
			const normalizedExisting: HistoryItemStatus = existing.status ?? "active"
			if (item.status !== normalizedExisting) {
				try {
					assertValidTransition(existing.status, item.status)
				} catch (cacheError) {
					// Cache may be stale from a peer write. Re-read disk
					// under the store lock before rejecting the transition.
					const diskItem = await this.readTaskFile(item.id)
					if (!diskItem) {
						throw cacheError
					}
					assertValidTransition(diskItem.status, item.status)
				}
			}
		}

		// Merge: preserve existing metadata unless explicitly overwritten
		const merged = existing ? { ...existing, ...item } : item

		const delta = existing ? this.buildDelta(item.id, existing, item) : { ...item }
		let written: HistoryItem
		try {
			written = await this.writeTaskFile(merged, delta, (disk) => assertOrdinaryHistorySnapshot(item, disk))
		} catch (error) {
			if (error instanceof DeltaRejectedError) {
				const diskItem = await this.readTaskFile(item.id)
				if (diskItem) {
					this.cache.set(item.id, diskItem)
				}
				throw error
			}
			throw error
		}

		// Update in-memory cache with what was actually persisted
		this.cache.set(written.id, written)

		const all = this.getAll()

		// Call onWrite callback inside the lock for serialized write-through
		if (this.onWrite) {
			await this.onWrite(all)
		}

		return all
	}

	/**
	 * Delete a single task's history item.
	 */
	async delete(taskId: string): Promise<void> {
		return withTargetPersistence(this.globalStoragePath, taskId, () =>
			this.withLock(async () => {
				assertTargetEffect(await getStorageBasePath(this.globalStoragePath), taskId)
				if (await isTargetBound(this.globalStoragePath, taskId))
					throw new Error("Bound target deletion refused")
				await this.unlinkTaskFile(taskId)
				this.cache.delete(taskId)
				this.taskFileMtimes.delete(taskId)

				// Call onWrite callback inside the lock for serialized write-through
				if (this.onWrite) {
					await this.onWrite(this.getAll())
				}
			}),
		)
	}

	/**
	 * Delete multiple tasks' history items in a batch.
	 */
	async deleteMany(taskIds: string[]): Promise<void> {
		return this.withTargetIds(taskIds, async () => {
			for (const id of taskIds)
				if (await isTargetBound(this.globalStoragePath, id)) throw new Error("Bound target deletion refused")
			return this.withLock(async () => {
				const base = await getStorageBasePath(this.globalStoragePath)
				for (const taskId of taskIds) assertTargetEffect(base, taskId)
				for (const taskId of taskIds) {
					await this.unlinkTaskFile(taskId)
					this.cache.delete(taskId)
					this.taskFileMtimes.delete(taskId)
				}

				// Call onWrite callback inside the lock for serialized write-through
				if (this.onWrite) {
					await this.onWrite(this.getAll())
				}
			})
		})
	}

	/** File lock is below the store mutex; parent exclusion is acquired by the caller before either. */
	private async unlinkTaskFile(taskId: string): Promise<void> {
		const filePath = await this.getTaskFilePath(taskId)
		try {
			await fs.access(path.dirname(filePath))
		} catch (error) {
			if (this.isFileNotFoundError(error) && !(await isTargetBound(this.globalStoragePath, taskId))) return
			throw error
		}
		const release = await lockfile.lock(filePath, { realpath: false, retries: 5 })
		try {
			assertTargetEffect(path.dirname(path.dirname(path.dirname(filePath))), taskId)
			try {
				await fs.unlink(filePath)
			} catch (error) {
				if (!this.isFileNotFoundError(error)) throw error
			}
		} finally {
			await release()
		}
	}

	// ────────────────────────────── Reconciliation ──────────────────────────────

	/**
	 * Scan task directories and fix any drift between disk and cache.
	 *
	 * - Tasks on disk but missing from cache: read and add
	 * - Tasks in cache but missing from disk: remove
	 */
	async reconcile(options: { forceRefresh?: boolean } = {}): Promise<void> {
		// Run through the write lock to prevent interleaving with upsert/delete
		return this.withLock(async () => {
			const tasksDir = await this.getTasksDir()

			let dirEntries: string[]
			try {
				dirEntries = await fs.readdir(tasksDir)
			} catch {
				return // tasks dir doesn't exist yet
			}

			// Filter out hidden and reserved names
			const taskDirNames = dirEntries.filter((name) => !name.startsWith("_") && !name.startsWith("."))

			const onDiskIds = new Set(taskDirNames)
			const cacheIds = new Set(this.cache.keys())
			const liveIds = new Set<string>()

			for (const taskId of onDiskIds) {
				try {
					const taskFilePath = await this.getTaskFilePath(taskId)
					const { mtimeMs } = await fs.stat(taskFilePath)
					liveIds.add(taskId)
					if (
						!options.forceRefresh &&
						this.cache.has(taskId) &&
						this.taskFileMtimes.get(taskId) === mtimeMs
					) {
						continue
					}

					const item = await this.readTaskFile(taskId)
					if (item?.id === taskId) {
						const previous = this.cache.get(taskId)
						this.taskFileMtimes.set(taskId, mtimeMs)
						if (!deepEqual(previous, item)) {
							this.cache.set(taskId, item)
						}
					}
				} catch {
					// File may be temporarily absent during a peer's atomic
					// rename window in safeWriteJson. The advisory lock is
					// held for the entire write, so its presence means a
					// write is in progress — keep the task live.
					try {
						const lockPath = (await this.getTaskFilePath(taskId)) + ".lock"
						const lockStat = await fs.stat(lockPath)
						if (Date.now() - lockStat.mtimeMs < LOCK_STALE_MS) {
							liveIds.add(taskId)
						}
					} catch {
						// No lock file — file is genuinely absent
					}
				}
			}

			// Evict tasks whose history_item.json no longer exists
			for (const taskId of cacheIds) {
				if (!liveIds.has(taskId)) {
					this.cache.delete(taskId)
					this.taskFileMtimes.delete(taskId)
				}
			}
		})
	}

	/**
	 * Repair delegation inconsistencies left by a crash mid-transition.
	 *
	 * Called once from `initialize()` after `reconcile()`. Plans parent/child exclusions before `withLock` to
	 * prevent interleaving with watcher-triggered reconcile() calls. Iterates until
	 * convergence so that one-level chained delegations visible at startup are resolved.
	 *
	 * Must NOT be called from within `withLock` — `withLock` is non-reentrant (promise
	 * chain); calling `upsert` (which acquires the lock) from inside would deadlock.
	 * Administrative repairs use full disk comparisons under the acquired parent
	 * exclusions; ordinary lifecycle transitions are unchanged.
	 *
	 * Cases repaired per pass:
	 * - Parent `delegated` with no `awaitingChildId` → parent → `active` (invalid state)
	 * - Parent `delegated`, child not found → parent → `active` (orphaned delegation)
	 * - Parent `delegated`, child `completed` → parent → `active` (interrupted handoff)
	 * - Parent `delegated`, child `active` → child → `interrupted`, parent → `active`
	 *
	 * A parent awaiting an `interrupted` or `delegated` child is left as-is — the child is
	 * resumable. An `active` child is treated as orphaned only when every other host presence
	 * record is provably exited; otherwise another live host may be running it, and the pair
	 * is left unchanged for a later startup (see `hostPresence.ts`).
	 */
	private async reconcileDelegationState(persistedActiveIds: ReadonlySet<string>): Promise<void> {
		// Read once per call, only when an active child is found. A peer that started before this
		// pass published its record first. A peer that gives up waiting for admission during a long
		// pass (degraded startup) and resumes the same child in that time is not seen: a narrow gap.
		let livePeers: Promise<string[]> | undefined
		const findLivePeers = async () =>
			findLivePeerHosts(
				this.persistenceRoot ?? (await fs.realpath(await getStorageBasePath(this.globalStoragePath))),
				this.hostPresence?.token,
			)
		let repaired: boolean
		do {
			repaired = false
			for (const candidate of this.getAll()) {
				if (candidate.status !== "delegated" || this.blockedRepairs.has(candidate.id)) continue
				try {
					const ids = [candidate.id, ...(candidate.awaitingChildId ? [candidate.awaitingChildId] : [])]
					await withPersistenceExclusions(
						this.globalStoragePath,
						ids,
						() =>
							this.withLock(async () => {
								const item = await this.readTaskFile(candidate.id)
								if (!item || item.status !== "delegated") return
								if (item.awaitingChildId !== candidate.awaitingChildId)
									throw new Error("Repair lineage changed")
								const childRead = item.awaitingChildId
									? await this.readTaskFileAuthoritative(item.awaitingChildId)
									: { kind: "missing" as const }
								if (childRead.kind === "read_error") throw childRead.error
								const child = childRead.kind === "found" ? childRead.item : null
								const check = this.repairEffectCheck(item, child)
								check()
								if (
									child &&
									(child.status ?? "active") === "active" &&
									persistedActiveIds.has(child.id)
								) {
									// The child is orphaned only if no other live store may be running it.
									livePeers ??= findLivePeers()
									const peers = await livePeers
									if (peers.length > 0) {
										console.warn(
											`[TaskHistoryStore] Left delegated parent ${item.id} and active child ${child.id} unchanged: ` +
												`${peers.length} other Zoo Code host(s) may be running it (${peers.join(", ")}).`,
										)
										return
									}
									await this.repairActiveDelegation(item, child)
								} else if (!item.awaitingChildId || !child || child.status === "completed") {
									const output: HistoryItem = {
										...item,
										status: "active",
										awaitingChildId: undefined,
										delegatedToId: undefined,
									}
									if (child) {
										output.completedByChildId = child.id
										output.completionResultSummary =
											child.completionResultSummary ??
											"Task completed (recovered after interruption)"
									}
									await this.writeTaskFile(
										output,
										undefined,
										this.repairEffectCheck(item, child, output),
									)
									this.cache.set(output.id, output)
									if (this.onWrite) await this.onWrite(this.getAll())
								} else return
								repaired = true
							}),
						{ failFast: true },
					)
				} catch (error) {
					this.blockedRepairs.add(candidate.id)
					console.error(`[TaskHistoryStore] Failed to reconcile delegation for task ${candidate.id}:`, error)
				}
			}
		} while (repaired)
	}

	/** Fresh full boundary identity at every physical effect; only this effect's exact output is permitted. */
	private repairEffectCheck(parent: HistoryItem, child: HistoryItem | null, output?: HistoryItem): () => void {
		const root = fsSync.realpathSync(path.dirname(path.dirname(path.dirname(this.taskPath(parent.id)))))
		return () => {
			assertStartupAdmission(root, true)
			for (const original of [parent, child]) {
				if (!original) continue
				assertPersistenceExclusion(root, original.id)
				const current: HistoryItem = JSON.parse(
					fsSync.readFileSync(path.join(root, "tasks", original.id, GlobalFileNames.historyItem), "utf8"),
				)
				const identity = targetPublicationIdentity(current)
				if (
					!deepEqual(identity, targetPublicationIdentity(original)) &&
					!(output?.id === original.id && deepEqual(identity, targetPublicationIdentity(output)))
				)
					throw new Error("Repair action, owner, question or lineage changed")
				for (const ancestor of [current.parentTaskId, current.rootTaskId])
					if (ancestor && ancestor !== current.id) assertPersistenceExclusion(root, ancestor)
			}
			if (!child && parent.awaitingChildId) {
				assertPersistenceExclusion(root, parent.awaitingChildId)
				if (fsSync.existsSync(path.join(root, "tasks", parent.awaitingChildId, GlobalFileNames.historyItem)))
					throw new Error("Repair child appeared")
			}
		}
	}

	private taskPath(id: string): string {
		return path.join(this.persistenceRoot ?? this.globalStoragePath, "tasks", id, GlobalFileNames.historyItem)
	}

	private getPersistedActiveIds(): ReadonlySet<string> {
		return new Set(
			Array.from(this.cache.values())
				.filter((item) => (item.status ?? "active") === "active")
				.map((item) => item.id),
		)
	}

	/**
	 * Replay the durable active-child repair intent, if one was left by a crash.
	 * The expected fields are guards: an intent may update only the missing side
	 * when the other side is already at its target, or when both records still
	 * describe the original delegated handoff.
	 *
	 * This method acquires the store's non-reentrant promise-chain lock. It must be
	 * called outside an existing `withLock` callback; locked callers must use the
	 * corresponding core methods directly instead of awaiting this method.
	 */
	private async replayDelegationRepairIntent(): Promise<void> {
		const candidate = await this.readDelegationRepairIntent()
		if (!candidate) return
		this.blockedRepairs.add(candidate.parentTaskId)
		return withPersistenceExclusions(
			this.globalStoragePath,
			[candidate.parentTaskId, candidate.childTaskId],
			() =>
				this.withLock(async () => {
					const intent = await this.readDelegationRepairIntent()
					if (!deepEqual(candidate, intent) || !intent)
						throw new Error("Repair intent changed during planning")
					const parent = await this.readTaskFile(intent.parentTaskId)
					const child = await this.readTaskFile(intent.childTaskId)
					if (!child || !parent) throw new Error("Repair intent authoritative parent/child missing")
					if (
						child.parentTaskId !== intent.expected.child.parentTaskId ||
						child.rootTaskId !== intent.expected.child.rootTaskId ||
						(child.parentTaskId && child.parentTaskId !== parent.id)
					)
						throw new Error("Ambiguous repair lineage retained")
					const check = this.repairEffectCheck(parent, child)
					check()
					const childAtTarget = child.status === intent.target.childStatus
					const parentAtTarget =
						parent.status === intent.target.parentStatus &&
						parent.awaitingChildId === undefined &&
						parent.delegatedToId === undefined
					if (
						(!childAtTarget && !this.matchesDelegationRepairChildPreconditions(intent, child)) ||
						(!parentAtTarget && !this.matchesDelegationRepairParentPreconditions(intent, parent))
					) {
						await this.quarantineDelegationRepairIntent(
							intent,
							"task state no longer matches its guards",
							check,
						)
						return
					}
					await this.applyDelegationRepairIntent(intent, child, parent)
				}),
			{ failFast: true },
		)
	}

	/**
	 * Start and complete a guarded active-child repair while already holding the
	 * store lock. The intent is durable before either task file is touched.
	 */
	private async repairActiveDelegation(parent: HistoryItem, child: HistoryItem): Promise<void> {
		assertStartupAdmission(await getStorageBasePath(this.globalStoragePath), true)
		// This path is already under the store mutex: refuse before publishing the
		// intent or touching the child, rather than acquiring exclusion out of order.
		if (
			(await isTargetBound(this.globalStoragePath, parent.id)) ||
			(await isTargetBound(this.globalStoragePath, child.id))
		)
			throw new Error("Bound target active-child repair requires independent reconciliation")
		const intent: DelegationRepairIntent = {
			version: 1,
			operationId: crypto.randomUUID(),
			parentTaskId: parent.id,
			childTaskId: child.id,
			expected: {
				parent: {
					status: "delegated",
					awaitingChildId: child.id,
					delegatedToId: parent.delegatedToId,
				},
				child: {
					status: "active",
					parentTaskId: child.parentTaskId,
					rootTaskId: child.rootTaskId,
				},
			},
			target: { childStatus: "interrupted", parentStatus: "active" },
		}

		await this.writeDelegationRepairIntent(intent, this.repairEffectCheck(parent, child))
		await this.applyDelegationRepairIntent(intent, child, parent)
	}

	private async applyDelegationRepairIntent(
		intent: DelegationRepairIntent,
		child: HistoryItem,
		parent: HistoryItem,
	): Promise<void> {
		const repairedChild = { ...child, status: intent.target.childStatus }
		const repairedParent = {
			...parent,
			status: intent.target.parentStatus,
			awaitingChildId: undefined,
			delegatedToId: undefined,
		}
		const checkIntent = () => {
			const current: unknown = JSON.parse(fsSync.readFileSync(this.taskIntentPath(), "utf8"))
			if (!deepEqual(current, JSON.parse(JSON.stringify(intent)))) throw new Error("Repair intent changed")
		}
		await this.writeTaskFile(repairedChild, undefined, () => {
			checkIntent()
			this.repairEffectCheck(parent, child, repairedChild)()
		})
		this.cache.set(repairedChild.id, repairedChild)
		await this.writeTaskFile(repairedParent, undefined, () => {
			checkIntent()
			this.repairEffectCheck(parent, repairedChild, repairedParent)()
		})
		this.cache.set(repairedParent.id, repairedParent)
		if (this.onWrite) await this.onWrite(this.getAll())
		await this.removeDelegationRepairIntent(intent, this.repairEffectCheck(repairedParent, repairedChild))
	}

	private taskIntentPath(): string {
		return path.join(path.dirname(path.dirname(this.taskPath("unused"))), GlobalFileNames.delegationRepairIntent)
	}

	private matchesDelegationRepairParentPreconditions(intent: DelegationRepairIntent, parent: HistoryItem): boolean {
		return (
			parent.status === intent.expected.parent.status &&
			parent.awaitingChildId === intent.expected.parent.awaitingChildId &&
			parent.delegatedToId === intent.expected.parent.delegatedToId
		)
	}

	private matchesDelegationRepairChildPreconditions(intent: DelegationRepairIntent, child: HistoryItem): boolean {
		return (
			(child.status ?? "active") === intent.expected.child.status &&
			child.parentTaskId === intent.expected.child.parentTaskId &&
			child.rootTaskId === intent.expected.child.rootTaskId
		)
	}

	/** Malformed intent has no reliable parent ID; the cache is not binding authority. */
	private async refuseAmbiguousBoundIntent(): Promise<void> {
		const root = await fs.realpath(await getStorageBasePath(this.globalStoragePath))
		let entries: string[]
		try {
			entries = await fs.readdir(path.join(root, ".handoff-fences"))
		} catch (error) {
			if (this.isFileNotFoundError(error)) return
			throw error
		}
		if (entries.some((name) => name.endsWith(".target.json")))
			throw new Error("Ambiguous delegation intent requires independent target reconciliation")
	}

	private async readDelegationRepairIntent(): Promise<DelegationRepairIntent | null> {
		const intentPath = await this.getDelegationRepairIntentPath()
		let parsed: unknown
		try {
			parsed = JSON.parse(await fs.readFile(intentPath, "utf8")) as unknown
		} catch (error) {
			if (this.isFileNotFoundError(error)) {
				return null
			}
			await this.refuseAmbiguousBoundIntent()
			throw new Error("Ambiguous malformed repair intent retained")
		}

		if (!this.isDelegationRepairIntent(parsed)) {
			await this.refuseAmbiguousBoundIntent()
			throw new Error("Ambiguous repair intent retained")
		}
		return parsed
	}

	private isDelegationRepairIntent(value: unknown): value is DelegationRepairIntent {
		if (!value || typeof value !== "object") {
			return false
		}
		const candidate = value as Record<string, unknown>
		const expected = candidate.expected
		const expectedRecord = expected && typeof expected === "object" ? (expected as Record<string, unknown>) : null
		const expectedParent =
			expectedRecord?.parent && typeof expectedRecord.parent === "object"
				? (expectedRecord.parent as Record<string, unknown>)
				: null
		const expectedChild =
			expectedRecord?.child && typeof expectedRecord.child === "object"
				? (expectedRecord.child as Record<string, unknown>)
				: null
		const target = candidate.target
		const targetRecord = target && typeof target === "object" ? (target as Record<string, unknown>) : null
		return (
			candidate.version === 1 &&
			typeof candidate.operationId === "string" &&
			this.isSafeTaskId(candidate.parentTaskId) &&
			this.isSafeTaskId(candidate.childTaskId) &&
			candidate.parentTaskId !== candidate.childTaskId &&
			!!expectedParent &&
			expectedParent.status === "delegated" &&
			typeof expectedParent.awaitingChildId === "string" &&
			expectedParent.awaitingChildId === candidate.childTaskId &&
			(expectedParent.delegatedToId === undefined || typeof expectedParent.delegatedToId === "string") &&
			!!expectedChild &&
			expectedChild.status === "active" &&
			(expectedChild.parentTaskId === undefined || typeof expectedChild.parentTaskId === "string") &&
			(expectedChild.rootTaskId === undefined || typeof expectedChild.rootTaskId === "string") &&
			!!targetRecord &&
			targetRecord.childStatus === "interrupted" &&
			targetRecord.parentStatus === "active"
		)
	}

	private async writeDelegationRepairIntent(intent: DelegationRepairIntent, check: () => void): Promise<void> {
		assertStartupAdmission(await getStorageBasePath(this.globalStoragePath), true)
		await safeWriteJson(await this.getDelegationRepairIntentPath(), intent, {
			publicationGuard: {
				check: (existing, output) => {
					check()
					if (existing !== null && !deepEqual(existing, JSON.parse(JSON.stringify(intent))))
						throw new Error("Unresolved repair intent retained")
					if (!deepEqual(JSON.parse(JSON.stringify(output)), JSON.parse(JSON.stringify(intent))))
						throw new Error("Repair intent output changed")
				},
			},
		})
	}

	private async removeDelegationRepairIntent(intent: DelegationRepairIntent, check: () => void): Promise<void> {
		const file = await this.getDelegationRepairIntentPath()
		const release = await lockfile.lock(file, { realpath: false, retries: 5 })
		try {
			check()
			if (!deepEqual(JSON.parse(await fs.readFile(file, "utf8")), JSON.parse(JSON.stringify(intent))))
				throw new Error("Repair intent cleanup identity changed")
			check()
			await fs.unlink(file)
			check()
		} finally {
			await release()
		}
	}

	private async quarantineDelegationRepairIntent(
		intent: DelegationRepairIntent,
		reason: string,
		check: () => void,
	): Promise<void> {
		const file = await this.getDelegationRepairIntentPath()
		const release = await lockfile.lock(file, { realpath: false, retries: 5 })
		try {
			check()
			if (!deepEqual(JSON.parse(await fs.readFile(file, "utf8")), JSON.parse(JSON.stringify(intent))))
				throw new Error("Repair intent quarantine identity changed")
			check()
			await fs.rename(file, `${file}.quarantine-${Date.now()}-${crypto.randomUUID()}`)
			check()
		} finally {
			await release()
		}
		console.warn(`[TaskHistoryStore] Retained stale repair intent: ${reason}`)
	}

	private isSafeTaskId(value: unknown): value is string {
		return (
			typeof value === "string" &&
			value.length > 0 &&
			value !== "." &&
			value !== ".." &&
			!value.includes("/") &&
			!value.includes("\\")
		)
	}

	private isFileNotFoundError(error: unknown): boolean {
		return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
	}

	private async getDelegationRepairIntentPath(): Promise<string> {
		const tasksDir = await this.getTasksDir()
		return path.join(tasksDir, GlobalFileNames.delegationRepairIntent)
	}

	// ────────────────────────────── Cache invalidation ──────────────────────────────

	/**
	 * Invalidate a single task's cache entry (re-read from disk on next access).
	 */
	async invalidate(taskId: string): Promise<void> {
		return this.withLock(async () => {
			try {
				const item = await this.readTaskFile(taskId)
				if (item) {
					this.cache.set(taskId, item)
				} else {
					this.cache.delete(taskId)
				}
				this.taskFileMtimes.delete(taskId)
			} catch {
				this.cache.delete(taskId)
			}
		})
	}

	/**
	 * Clear all in-memory cache entries; a subsequent `reconcile()` repopulates them from task files.
	 */
	async invalidateAll(): Promise<void> {
		return this.withLock(async () => {
			this.cache.clear()
		})
	}

	// ────────────────────────────── Migration ──────────────────────────────

	/**
	 * Migrate from globalState taskHistory array to per-task files.
	 *
	 * For each entry in the globalState array, writes a `history_item.json`
	 * file if one doesn't already exist. This is idempotent and safe to re-run.
	 */
	async migrateFromGlobalState(taskHistoryEntries: HistoryItem[]): Promise<void> {
		if (!taskHistoryEntries || taskHistoryEntries.length === 0) {
			return
		}

		await withStartupAdmission(this.globalStoragePath, async () => {
			this.persistenceRoot = await fs.realpath(await getStorageBasePath(this.globalStoragePath))
			for (const item of taskHistoryEntries) {
				if (!item.id) continue
				try {
					await this.withTargetIds(
						[item.id, ...[item.parentTaskId, item.rootTaskId].filter((id): id is string => !!id)],
						() =>
							this.withLock(async () => {
								const file = await this.getTaskFilePath(item.id)
								try {
									await fs.access(file)
									return
								} catch (error) {
									if (!this.isFileNotFoundError(error)) throw error
								}
								await fs.access(path.dirname(file))
								const root = path.dirname(path.dirname(path.dirname(file)))
								const ancestors = await Promise.all(
									[item.parentTaskId, item.rootTaskId]
										.filter((id): id is string => !!id && id !== item.id)
										.map((id) => this.readTaskFileAuthoritative(id)),
								)
								const ancestorIds = [item.parentTaskId, item.rootTaskId].filter(
									(id): id is string => !!id && id !== item.id,
								)
								if (ancestors.some((read) => read.kind !== "found"))
									throw new Error("Migration ancestor authority missing")
								const check = () => {
									assertStartupAdmission(root, true)
									for (let index = 0; index < ancestors.length; index++) {
										const prior = ancestors[index]
										const current: HistoryItem = JSON.parse(
											fsSync.readFileSync(
												path.join(
													root,
													"tasks",
													ancestorIds[index],
													GlobalFileNames.historyItem,
												),
												"utf8",
											),
										)
										if (
											prior.kind !== "found" ||
											!deepEqual(
												targetPublicationIdentity(prior.item),
												targetPublicationIdentity(current),
											)
										)
											throw new Error("Migration ancestor identity changed")
									}
									for (const id of [item.id, item.parentTaskId, item.rootTaskId])
										if (id) assertPersistenceExclusion(root, id)
								}
								await safeWriteJson(file, item, {
									publicationGuard: {
										check: (existing, output) => {
											check()
											if (existing !== null) throw new Error("Migration authority appeared")
											assertTargetTaskOutput(root, item.id, output as HistoryItem)
										},
									},
									merge: (existing) => {
										check()
										if (existing !== null) throw new Error("Migration authority appeared")
										return item
									},
								})
								this.cache.set(item.id, item)
							}),
					)
				} catch (error) {
					if (!this.isFileNotFoundError(error)) throw error
				}
			}
			await this.reconcileDelegationState(this.getPersistedActiveIds())
		})
	}

	// ────────────────────────────── Private: Per-task file I/O ──────────────────────────────

	/**
	 * Return only the fields in `incoming` that differ from `cached`.
	 */
	private computeDelta(cached: HistoryItem, incoming: Partial<HistoryItem>): Partial<HistoryItem> {
		return computeHistoryDelta(cached, incoming)
	}

	private buildDelta(id: string, cached: HistoryItem, incoming: Partial<HistoryItem>): Partial<HistoryItem> {
		return { id, ...this.computeDelta(cached, incoming) }
	}

	/**
	 * Write a HistoryItem to its per-task `history_item.json` file.
	 *
	 * When `delta` is provided, the merge callback applies only the
	 * delta to the current disk state, so fields written by another
	 * process are preserved. Without a delta the full item is written
	 * as-is (used by administrative repair paths that are authoritative).
	 */
	private async writeTaskFile(
		item: HistoryItem,
		delta?: Partial<HistoryItem>,
		check?: (existing: unknown) => void,
	): Promise<HistoryItem> {
		const filePath = await this.getTaskFilePath(item.id)
		const guard = targetPublicationGuard(path.dirname(path.dirname(path.dirname(filePath))), item.id)!
		const publicationGuard = {
			check: (existing: unknown, output: unknown) => {
				check?.(existing)
				guard.check(existing, output)
			},
		}
		if (delta) {
			let written: HistoryItem = item
			const mergeFn = mergeWithDisk(delta)
			await safeWriteJson(filePath, item, {
				publicationGuard,
				merge: (existing, incoming) => {
					assertStartupAdmission(path.dirname(path.dirname(path.dirname(filePath))))
					assertTargetEffect(path.dirname(path.dirname(path.dirname(filePath))), item.id, existing)
					const result = mergeFn(existing, incoming)
					written = result as HistoryItem
					assertTargetTaskOutput(path.dirname(path.dirname(path.dirname(filePath))), item.id, written)
					return result
				},
			})
			return written
		} else {
			await safeWriteJson(filePath, item, {
				publicationGuard,
				merge: (existing) => {
					assertStartupAdmission(path.dirname(path.dirname(path.dirname(filePath))))
					assertTargetEffect(path.dirname(path.dirname(path.dirname(filePath))), item.id, existing)
					assertTargetTaskOutput(path.dirname(path.dirname(path.dirname(filePath))), item.id, item)
					return item
				},
			})
			return item
		}
	}

	/**
	 * Read a HistoryItem from its per-task `history_item.json` file.
	 */
	private async readTaskFile(taskId: string): Promise<HistoryItem | null> {
		const result = await this.readTaskFileAuthoritative(taskId)
		return result.kind === "found" ? result.item : null
	}

	private async readTaskFileAuthoritative(taskId: string): Promise<AuthoritativeTaskHistoryRead> {
		try {
			const raw = await fs.readFile(await this.getTaskFilePath(taskId), "utf8")
			const item: HistoryItem = JSON.parse(raw)
			if (!item.id || item.id !== taskId) {
				return { kind: "read_error", error: new Error("Invalid task metadata identity") }
			}
			return { kind: "found", item }
		} catch (error) {
			return this.isFileNotFoundError(error) ? { kind: "missing" } : { kind: "read_error", error }
		}
	}

	// ────────────────────────────── Private: fs.watch ──────────────────────────────

	/**
	 * Watch the tasks directory for changes from other instances.
	 */
	private startWatcher(): void {
		if (this.disposed) {
			return
		}

		// Use a debounced handler to avoid excessive reconciliation
		let watchDebounce: ReturnType<typeof setTimeout> | null = null

		this.getTasksDir()
			.then((tasksDir) => {
				if (this.disposed) {
					return
				}

				try {
					this.fsWatcher = fsSync.watch(tasksDir, { recursive: false }, (_eventType, _filename) => {
						if (this.disposed) {
							return
						}

						// Debounce the reconciliation triggered by fs.watch
						if (watchDebounce) {
							clearTimeout(watchDebounce)
						}
						watchDebounce = setTimeout(() => {
							this.reconcile().catch((err) => {
								console.error("[TaskHistoryStore] Reconciliation after fs.watch failed:", err)
							})
						}, 500)
					})

					this.fsWatcher.on("error", (err) => {
						console.error("[TaskHistoryStore] fs.watch error:", err)
						// fs.watch is unreliable on some platforms; periodic reconciliation
						// serves as the fallback.
					})
				} catch (err) {
					console.error("[TaskHistoryStore] Failed to start fs.watch:", err)
				}
			})
			.catch((err) => {
				console.error("[TaskHistoryStore] Failed to get tasks dir for watcher:", err)
			})
	}

	/**
	 * Start periodic reconciliation as a defensive fallback for platforms
	 * where fs.watch is unreliable.
	 */
	private startPeriodicReconciliation(): void {
		if (this.disposed) {
			return
		}

		this.reconcileTimer = setTimeout(async () => {
			if (this.disposed) {
				return
			}
			try {
				await this.reconcile()
			} catch (err) {
				console.error("[TaskHistoryStore] Periodic reconciliation failed:", err)
			}
			this.startPeriodicReconciliation()
		}, TaskHistoryStore.RECONCILE_INTERVAL_MS)
	}

	// ────────────────────────────── Atomic read-modify-write ──────────────────────────────

	/**
	 * Read a HistoryItem from the in-memory cache and write back an updated version,
	 * all within a single lock acquisition so no concurrent writer can interleave
	 * between the read and the write.
	 *
	 * The `updater` receives the current cached item and must return the new item
	 * synchronously. It must not perform I/O or acquire any other lock.
	 *
	 * @throws If the task ID is not present in the cache.
	 */
	/** Evaluate a question reducer against disk under safeWriteJson's advisory lock. */
	public updateQuestion(taskId: string, update: (current: HistoryItem) => HistoryItem): Promise<HistoryItem> {
		return withTargetPersistence(this.globalStoragePath, taskId, () =>
			this.withLock(async () => {
				const cached = this.cache.get(taskId)
				if (!cached) throw new Error(`Question task ${taskId} is not persisted`)
				let written = cached
				const filePath = await this.getTaskFilePath(taskId)
				await safeWriteJson(filePath, cached, {
					publicationGuard: targetPublicationGuard(
						path.dirname(path.dirname(path.dirname(filePath))),
						taskId,
					),
					merge: (existing) => {
						assertTargetEffect(path.dirname(path.dirname(path.dirname(filePath))), taskId, existing)
						if (
							!existing ||
							typeof existing !== "object" ||
							!("id" in existing) ||
							existing.id !== taskId
						) {
							throw new Error("Question task ownership changed")
						}
						const current = existing as HistoryItem
						const updated = update(structuredClone(current))
						written = { ...current, pendingQuestion: updated.pendingQuestion }
						assertTargetTaskOutput(path.dirname(path.dirname(path.dirname(filePath))), taskId, written)
						return written
					},
				})
				this.cache.set(taskId, written)
				if (this.onWrite) await this.onWrite(this.getAll())
				return written
			}),
		)
	}

	public atomicReadAndUpdate(taskId: string, updater: (current: HistoryItem) => HistoryItem): Promise<HistoryItem[]> {
		return withTargetPersistence(this.globalStoragePath, taskId, () =>
			this.withLock(async () => {
				const cached = this.cache.get(taskId)
				if (!cached)
					throw new Error(`[TaskHistoryStore] atomicReadAndUpdate: task ${taskId} not found in cache`)
				const filePath = await this.getTaskFilePath(taskId)
				const root = path.dirname(path.dirname(path.dirname(filePath)))
				let written = cached
				await safeWriteJson(filePath, cached, {
					publicationGuard: targetPublicationGuard(root, taskId),
					merge: (existing) => {
						assertTargetEffect(root, taskId, existing)
						if (!existing || typeof existing !== "object" || !("id" in existing) || existing.id !== taskId)
							throw new Error("Authoritative task identity changed")
						const current = existing as HistoryItem
						written = updater(structuredClone(current))
						if (written.id !== taskId) throw new Error("atomicReadAndUpdate: updater changed task id")
						if (written.status !== current.status)
							assertValidTransition(current.status, written.status ?? "active")
						assertTargetTaskOutput(root, taskId, written)
						return written
					},
				})
				this.cache.set(taskId, written)
				const all = this.getAll()
				if (this.onWrite) await this.onWrite(all)
				return all
			}),
		)
	}

	/**
	 * Persist a user resume of an interrupted task (`interrupted → active`).
	 *
	 * VALID_TASK_STATUS_TRANSITIONS deliberately rejects `interrupted → active` so stale
	 * ordinary saves cannot undo an interruption. This is the only write that bypasses that
	 * table, and only for the `resumeInterruptedTask` reducer's result. The reducer runs
	 * against the authoritative child (under its file lock) and parent records read under
	 * the store lock and the lineage's persistence exclusions. The resuming instance's
	 * ordinary identity must still own the record; its revision is not advanced.
	 *
	 * @throws LifecycleTransitionError when the record is not resumable (for example, its
	 *   parent now awaits another child); nothing is written.
	 */
	public async resumeInterruptedTask(taskId: string, authority: OrdinaryPersistenceIdentity): Promise<HistoryItem> {
		await this.initialized
		return this.withTargetIds([taskId], () =>
			this.withLock(async () => {
				const childRead = await this.readTaskFileAuthoritative(taskId)
				if (childRead.kind !== "found") {
					throw childRead.kind === "missing"
						? new Error(`[TaskHistoryStore] resumeInterruptedTask: ${taskId} not found`)
						: childRead.error
				}
				const parentTaskId = childRead.item.parentTaskId
				let parent: HistoryItem | undefined
				if (parentTaskId) {
					const parentRead = await this.readTaskFileAuthoritative(parentTaskId)
					if (parentRead.kind === "read_error") throw parentRead.error
					parent = parentRead.kind === "found" ? parentRead.item : undefined
				}
				// Decide on the fresh read first so a refusal surfaces unwrapped and nothing is written.
				// The file-lock merge below re-evaluates against the bytes it would replace.
				if (!matchesOrdinaryPersistenceAuthority(authority, childRead.item))
					throw new OrdinaryPersistenceAuthorityError("resume by a stale instance revision or lineage")
				resumeInterruptedTask(childRead.item, parent)
				const filePath = await this.getTaskFilePath(taskId)
				const root = path.dirname(path.dirname(path.dirname(filePath)))
				let written: HistoryItem = childRead.item
				await safeWriteJson(filePath, childRead.item, {
					publicationGuard: targetPublicationGuard(root, taskId),
					merge: (existing) => {
						assertTargetEffect(root, taskId, existing)
						if (!existing || typeof existing !== "object" || !("id" in existing) || existing.id !== taskId)
							throw new Error("Authoritative task identity changed")
						const current = existing as OrdinaryAuthorityHistoryItem
						if (!matchesOrdinaryPersistenceAuthority(authority, current))
							throw new OrdinaryPersistenceAuthorityError(
								"resume by a stale instance revision or lineage",
							)
						if (current.parentTaskId !== parentTaskId)
							throw new Error("Resumed task lineage changed while its parent was read")
						written = resumeInterruptedTask(structuredClone(current), parent)
						assertTargetTaskOutput(root, taskId, written)
						return written
					},
				})
				this.cache.set(taskId, written)
				if (parent) this.cache.set(parent.id, parent)
				if (this.onWrite) await this.onWrite(this.getAll())
				return written
			}),
		)
	}

	/**
	 * Update two distinct HistoryItems under this store instance's lock.
	 * Waits for startup repair, then reads both records fresh before running either
	 * synchronous updater. Locked reads on this instance cannot interleave, but
	 * cache reads and other stores/processes are not protected by this lock.
	 * Each file write has its own advisory lock: a second-write failure leaves the
	 * first committed. This is NOT a cross-record transaction or cross-host CAS;
	 * callers must handle partial commits and coordinate competing lifecycle work.
	 *
	 * @throws If either record is missing/unreadable or validation/writing fails.
	 */
	public async atomicUpdatePair(
		firstId: string,
		secondId: string,
		firstUpdater: (current: HistoryItem) => HistoryItem,
		secondUpdater: (current: HistoryItem) => HistoryItem,
	): Promise<HistoryItem[]> {
		await this.initialized
		if (firstId === secondId) {
			throw new Error("[TaskHistoryStore] atomicUpdatePair requires distinct task ids")
		}
		return this.withTargetIds([firstId, secondId], () =>
			this.withLock(async () => {
				const firstRead = await this.readTaskFileAuthoritative(firstId)
				const secondRead = await this.readTaskFileAuthoritative(secondId)
				if (firstRead.kind !== "found") {
					throw firstRead.kind === "missing"
						? new Error(`[TaskHistoryStore] atomicUpdatePair: ${firstId} not found`)
						: firstRead.error
				}
				if (secondRead.kind !== "found") {
					throw secondRead.kind === "missing"
						? new Error(`[TaskHistoryStore] atomicUpdatePair: ${secondId} not found`)
						: secondRead.error
				}
				const first = firstRead.item
				const second = secondRead.item
				this.cache.set(firstId, first)
				this.cache.set(secondId, second)

				const updatedFirst = firstUpdater(structuredClone(first))
				const updatedSecond = secondUpdater(structuredClone(second))

				if (updatedFirst.id !== firstId) {
					throw new Error(
						`[TaskHistoryStore] atomicUpdatePair: first updater changed id from ${firstId} to ${updatedFirst.id}`,
					)
				}
				if (updatedSecond.id !== secondId) {
					throw new Error(
						`[TaskHistoryStore] atomicUpdatePair: second updater changed id from ${secondId} to ${updatedSecond.id}`,
					)
				}

				// Validate status transitions before any disk write — mirrors upsertCore guard.
				for (const [existing, updated] of [
					[first, updatedFirst],
					[second, updatedSecond],
				] as const) {
					if (updated.status !== undefined) {
						const normalizedExisting: HistoryItemStatus = existing.status ?? "active"
						if (updated.status !== normalizedExisting) {
							assertValidTransition(existing.status, updated.status)
						}
					}
				}

				// Validate both target outputs before committing either side of a pair.
				// The individual file-lock callbacks still recheck the authoritative disk state.
				const base = await getStorageBasePath(this.globalStoragePath)
				assertTargetTaskOutput(base, firstId, updatedFirst)
				assertTargetTaskOutput(base, secondId, updatedSecond)

				// Merge with existing cache entries before writing, mirroring upsertCore.
				const mergedFirst = { ...first, ...updatedFirst }
				const mergedSecond = { ...second, ...updatedSecond }

				const writtenFirst = await this.writeTaskFile(
					mergedFirst,
					this.buildDelta(firstId, first, updatedFirst),
				)
				let writtenSecond: HistoryItem
				try {
					writtenSecond = await this.writeTaskFile(
						mergedSecond,
						this.buildDelta(secondId, second, updatedSecond),
					)
				} catch (error) {
					// First record is committed on disk. Update cache so it
					// reflects disk state before propagating the error.
					this.cache.set(firstId, writtenFirst)
					throw error
				}

				// Both disk writes succeeded — now update the cache.
				this.cache.set(firstId, writtenFirst)
				this.cache.set(secondId, writtenSecond)

				const all = this.getAll()
				if (this.onWrite) {
					await this.onWrite(all)
				}
				return all
			}),
		)
	}

	// ────────────────────────────── Private: Write lock ──────────────────────────────

	/**
	 * Serializes operations on this store instance, not peer stores or hosts.
	 */
	private withTargetIds<T>(ids: string[], effect: () => Promise<T>): Promise<T> {
		return withPersistenceExclusions(this.globalStoragePath, ids, effect)
	}

	private withLock<T>(fn: () => Promise<T>): Promise<T> {
		const locked = () => underStoreMutex(fn)
		const result = this.writeLock.then(locked, locked)
		this.writeLock = result.then(
			() => {},
			() => {},
		)
		return result
	}

	// ────────────────────────────── Private: Path helpers ──────────────────────────────

	/**
	 * Get the tasks base directory path, resolving custom storage paths.
	 */
	private async getTasksDir(): Promise<string> {
		const basePath = await getStorageBasePath(this.globalStoragePath)
		return path.join(basePath, "tasks")
	}

	/**
	 * Get the path to a task's `history_item.json` file.
	 */
	private async getTaskFilePath(taskId: string): Promise<string> {
		const tasksDir = await this.getTasksDir()
		return path.join(tasksDir, taskId, GlobalFileNames.historyItem)
	}
}
