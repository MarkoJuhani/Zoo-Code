import * as crypto from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"

import type { HistoryItem } from "@roo-code/types"
import type { RecoveryBinding } from "../../shared/recoveryIntake"
import type { ApiMessage } from "./apiMessages"
import type { AuthoritativeRead, InterruptedCreateHandoffEvidence } from "./interruptedCreateHandoffEligibility"
import { ParentHandoffFence, type ParentHandoffFenceLease } from "./parentHandoffFence"

const validId = (id: string) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,256}$/.test(id)
const isObject = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value)
const code = (error: unknown) => (isObject(error) ? error.code : undefined)

/** The caller must pass the already resolved, canonical storage base. Never uses the creating/fallback storage resolver. */
export async function readStrictJson<T>(
	file: string,
	validate: (value: unknown) => value is T,
): Promise<AuthoritativeRead<T>> {
	try {
		const stat = await fs.lstat(file)
		if (!stat.isFile() || stat.isSymbolicLink()) return { kind: "read_error" }
		const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"))
		return validate(parsed) ? { kind: "found", value: parsed } : { kind: "read_error" }
	} catch (error) {
		return { kind: code(error) === "ENOENT" ? "missing" : "read_error" }
	}
}

const history = (value: unknown): value is HistoryItem =>
	isObject(value) &&
	validId(value.id as string) &&
	(value.parentTaskId === undefined || validId(value.parentTaskId as string)) &&
	(value.rootTaskId === undefined || validId(value.rootTaskId as string)) &&
	(value.childIds === undefined || (Array.isArray(value.childIds) && value.childIds.every(validId))) &&
	(value.pendingAction === undefined ||
		(isObject(value.pendingAction) &&
			typeof value.pendingAction.kind === "string" &&
			validId(value.pendingAction.actionId as string)))

const apiHistory = (value: unknown): value is ApiMessage[] =>
	Array.isArray(value) &&
	value.every(
		(message) =>
			isObject(message) &&
			(message.role === "assistant" || message.role === "user") &&
			(typeof message.content === "string" ||
				(Array.isArray(message.content) &&
					message.content.every(
						(block: unknown) =>
							isObject(block) &&
							typeof block.type === "string" &&
							(block.type !== "tool_use" ||
								(validId(block.id as string) && typeof block.name === "string")) &&
							(block.type !== "tool_result" || validId(block.tool_use_id as string)),
					))),
	)

export interface DiskHandoffSnapshot {
	evidence: InterruptedCreateHandoffEvidence
	/** Ordered root -> ... -> parent, derived from disk rather than a client assertion. */
	parentLineage: string[]
}

/** Strict read-only collector. Incomplete registries or an unproven live owner remain blockers. */
export async function collectInterruptedCreateHandoff(
	storageBase: string,
	parentTaskId: string,
	actionId: string,
): Promise<DiskHandoffSnapshot> {
	if (!validId(parentTaskId) || !validId(actionId)) throw new Error("invalid handoff identity")
	const base = await fs.realpath(storageBase)
	const tasks = path.join(base, "tasks")
	const tasksStat = await fs.lstat(tasks)
	if (!tasksStat.isDirectory() || tasksStat.isSymbolicLink()) throw new Error("invalid tasks directory")
	const readTask = async (id: string): Promise<AuthoritativeRead<HistoryItem>> => {
		try {
			const stat = await fs.lstat(path.join(tasks, id))
			if (!stat.isDirectory() || stat.isSymbolicLink()) return { kind: "read_error" }
		} catch (error) {
			return { kind: code(error) === "ENOENT" ? "missing" : "read_error" }
		}
		const read = await readStrictJson(path.join(tasks, id, "history_item.json"), history)
		return read.kind === "found" && read.value.id !== id ? { kind: "read_error" } : read
	}
	const parent = await readTask(parentTaskId)
	const lineage: string[] = []
	let expectedId = parentTaskId
	let cursor = parent
	const visited = new Set<string>()
	while (cursor.kind === "found") {
		const item = cursor.value
		if (visited.has(item.id) || lineage.length > 64 || item.id !== expectedId) {
			cursor = { kind: "read_error" }
			break
		}
		visited.add(item.id)
		lineage.unshift(item.id)
		if (!item.parentTaskId) break
		expectedId = item.parentTaskId
		cursor = await readTask(expectedId)
	}
	const root: AuthoritativeRead<HistoryItem> =
		cursor.kind === "found" && !cursor.value.parentTaskId ? cursor : { kind: "read_error" }
	const rootTaskId = root.kind === "found" ? root.value.id : ""
	const evidence: InterruptedCreateHandoffEvidence = {
		parentTaskId,
		rootTaskId,
		actionId,
		parent,
		root,
		apiMessages: await readStrictJson(path.join(tasks, parentTaskId, "api_conversation_history.json"), apiHistory),
		children: [],
		transientChildren: [],
		childRegistryComplete: true,
		writerInventoryComplete: false,
		liveOwner: "unknown",
	}
	let entries: string[]
	try {
		entries = await fs.readdir(tasks)
	} catch {
		evidence.childRegistryComplete = false
		return { evidence, parentLineage: lineage }
	}
	for (const id of entries) {
		if (!validId(id)) {
			evidence.childRegistryComplete = false
			continue
		}
		const directory = path.join(tasks, id)
		try {
			if (!(await fs.lstat(directory)).isDirectory()) {
				evidence.childRegistryComplete = false
				continue
			}
		} catch {
			evidence.childRegistryComplete = false
			continue
		}
		const intent = await readStrictJson(path.join(directory, "_delegation_repair_intent.json"), isObject)
		if (intent.kind === "read_error" || intent.kind === "found") evidence.childRegistryComplete = false
		if (id === parentTaskId || lineage.includes(id)) continue
		const item = await readTask(id)
		if (item.kind !== "found") {
			evidence.transientChildren.push({ taskId: id, metadata: item, attribution: "ambiguous" })
			continue
		}
		// Without a proven registry/intent attribution, even a metadata-bearing peer
		// could be a partially committed child. Never infer a negative from its name.
		evidence.children.push({ metadata: item.value, attribution: "ambiguous" })
	}
	if (
		parent.kind === "found" &&
		parent.value.childIds?.some((id) => !evidence.children.some((child) => child.metadata.id === id))
	)
		evidence.childRegistryComplete = false
	if (
		root.kind === "found" &&
		parent.kind === "found" &&
		(parent.value.rootTaskId !== root.value.id ||
			(root.value.rootTaskId !== undefined && root.value.rootTaskId !== root.value.id) ||
			(parentTaskId !== root.value.id && lineage.length < 2))
	)
		evidence.root = { kind: "read_error" }
	if (evidence.root.kind === "found") {
		for (const id of lineage.slice(1, -1)) {
			const ancestor = await readTask(id)
			if (ancestor.kind !== "found" || ancestor.value.rootTaskId !== evidence.root.value.id) {
				evidence.root = { kind: "read_error" }
				break
			}
		}
	}
	return { evidence, parentLineage: lineage }
}

interface BindingLedger {
	schemaVersion: 1
	parentTaskId: string
	revision: number
	binding: RecoveryBinding
	fingerprint: string
}
const ledgerValid = (value: unknown): value is BindingLedger =>
	isObject(value) &&
	value.schemaVersion === 1 &&
	validId(value.parentTaskId as string) &&
	Number.isSafeInteger(value.revision) &&
	(value.revision as number) > 0 &&
	typeof value.fingerprint === "string" &&
	isObject(value.binding) &&
	Number.isSafeInteger(value.binding.actionGeneration) &&
	(value.binding.actionGeneration as number) > 0 &&
	Array.isArray(value.binding.parentLineage) &&
	value.binding.parentLineage.every(validId)

/** Fixture-only issuance: no production writer participation or atomic replacement-proof commit is claimed. */
export async function issueSyntheticActionBinding(
	storageBase: string,
	parentTaskId: string,
	actionId: string,
): Promise<RecoveryBinding> {
	// This helper writes an unfenced synthetic ledger. It must never issue a
	// production binding, even when a caller supplies plausible disk evidence.
	if (process.env.VITEST !== "true") throw new Error("fixture_binding_disabled_outside_tests")
	const base = await fs.realpath(storageBase)
	const lease = await new ParentHandoffFence(base).acquire(parentTaskId)
	try {
		const { evidence, parentLineage } = await collectInterruptedCreateHandoff(base, parentTaskId, actionId)
		if (
			evidence.parent.kind !== "found" ||
			evidence.root.kind !== "found" ||
			evidence.parent.value.status !== "interrupted" ||
			evidence.parent.value.pendingAction?.kind !== "create_subtask" ||
			evidence.parent.value.pendingAction.actionId !== actionId ||
			evidence.parent.value.pendingQuestion ||
			evidence.parent.value.awaitingChildId ||
			evidence.parent.value.delegatedToId ||
			!evidence.childRegistryComplete ||
			evidence.children.length ||
			evidence.transientChildren.length ||
			evidence.apiMessages.kind !== "found"
		)
			throw new Error("binding evidence unavailable")
		const fingerprint = crypto
			.createHash("sha256")
			.update(JSON.stringify(evidence.parent.value.pendingAction))
			.digest("hex")
		const file = path.join(base, "tasks", parentTaskId, "_recovery_binding_v1.json")
		const stored = await readStrictJson(file, ledgerValid)
		if (stored.kind === "read_error") throw new Error("binding ledger invalid")
		if (stored.kind === "found") {
			const { binding } = stored.value
			if (
				stored.value.parentTaskId !== parentTaskId ||
				stored.value.fingerprint !== fingerprint ||
				binding.parentTaskId !== parentTaskId ||
				binding.actionId !== actionId ||
				binding.rootTaskId !== evidence.rootTaskId ||
				JSON.stringify(binding.parentLineage) !== JSON.stringify(parentLineage)
			)
				throw new Error("binding conflict")
			return binding
		}
		const binding: RecoveryBinding = {
			parentTaskId,
			rootTaskId: evidence.rootTaskId,
			parentLineage,
			actionId,
			actionGeneration: 1,
		}
		await writeNewLedger(file, { schemaVersion: 1, revision: 1, parentTaskId, binding, fingerprint }, lease)
		const readBack = await readStrictJson(file, ledgerValid)
		if (readBack.kind !== "found" || JSON.stringify(readBack.value.binding) !== JSON.stringify(binding))
			throw new Error("binding read-back failed")
		return binding
	} finally {
		await lease.release()
	}
}

async function writeNewLedger(file: string, record: BindingLedger, lease: ParentHandoffFenceLease): Promise<void> {
	await lease.assertOwned()
	const handle = await fs.open(file, "wx", 0o600)
	try {
		await handle.writeFile(JSON.stringify(record))
		await handle.sync()
	} finally {
		await handle.close()
	}
	const dir = await fs.open(path.dirname(file), "r")
	try {
		await dir.sync()
	} finally {
		await dir.close()
	}
}

/** No production CAS adapter exists for the task/API/journal writers. Do not turn
 * an owner read-back before an ordinary write into a claimed atomic commit. */
export async function rejectUnfencedRecoveryMutation(): Promise<never> {
	throw new Error("atomic_fenced_writer_unavailable")
}
