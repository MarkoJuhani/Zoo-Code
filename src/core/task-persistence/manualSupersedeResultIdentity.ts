import { createHash } from "node:crypto"
import { posix } from "node:path"

export const MANUAL_SUPERSEDE_B1_VERSION = "manual_supersede_B1/v1" as const
export const MANUAL_SUPERSEDE_B1_TRUTH =
	"operator superseded this handoff; earlier child outcome unknown; this resolution did not start a child"

export type SyntheticHistoryRead = { kind: "parsed"; value: unknown } | { kind: "missing" | "corrupt" | "read_error" }

/** Synthetic comparisons only: no path resolution, owner discovery or provider completeness assertion. */
export interface ManualSupersedeResultIdentityInput {
	storageRoot: { requestedPath: string; canonicalRealPath: string }
	target: { parentId: string; rootTaskId: string; oldAction: unknown }
	root: unknown
	parent: unknown
	lineage: string[]
	/** Original display-mode evidence, not a guessed current label; its provenance remains unverified. */
	approvalMode: { slug: string; displayName: string }
	rawHistory: SyntheticHistoryRead
	effectiveHistory: SyntheticHistoryRead
	proposedIdentity?: { version: string; digest: string; content: string }
}

export type ManualSupersedeIdentityBlock =
	| "input_corrupt"
	| "storage_root_alias"
	| "parent_root_mismatch"
	| "status_changed"
	| "pending_question"
	| "known_child_owner"
	| "action_corrupt"
	| "action_changed"
	| "approval_derivation_mismatch"
	| "raw_history_missing"
	| "raw_history_corrupt"
	| "effective_history_missing"
	| "effective_history_corrupt"
	| "history_visibility_changed"
	| "effective_projection_changed"
	| "call_missing"
	| "call_duplicate"
	| "call_changed"
	| "call_not_terminal"
	| "unresolved_sibling"
	| "orphan_or_duplicate_result"
	| "result_conflict"
	| "later_turn"
	| "proposed_identity_mismatch"

export interface ManualSupersedeV1Identity {
	version: typeof MANUAL_SUPERSEDE_B1_VERSION
	canonicalTuple: string
	digest: string
	marker: string
	content: string
	/** Review candidate only, never an append instruction or write-capable token. */
	proposedMessage: {
		role: "user"
		content: [{ type: "tool_result"; tool_use_id: string; is_error: true; content: string }]
	}
}

export type ManualSupersedeIdentityUnknown =
	| "historical_child_outcome_unknown"
	| "provider_effective_history_unverified"
	| "host_writer_exclusion_unverified"
	| "canonical_storage_root_unverified"
	| "owner_inventory_unverified"
	| "approval_mode_evidence_unverified"

export interface ManualSupersedeResultObservation {
	kind: "unwired_result_identity_observation"
	disposition: "blocked" | "unknown"
	classification: "no_result" | "one_matching_proposed_result" | "conflict_or_unknown"
	writeAuthorized: false
	historicalChildOutcome: "unknown"
	blocked: ManualSupersedeIdentityBlock[]
	unknown: readonly ManualSupersedeIdentityUnknown[]
	identity: ManualSupersedeV1Identity | null
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type RecordValue = Record<string, unknown>
interface Call {
	messageIndex: number
	blockIndex: number
	id: string
	name: string
	input: RecordValue
}
interface Scan {
	messages: RecordValue[]
	call: Call | null
	result: RecordValue | null
}
const object = (value: unknown): value is RecordValue =>
	value !== null && typeof value === "object" && !Array.isArray(value)
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0
const id = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,256}$/.test(value)
const keys = (value: RecordValue, required: string[], optional: string[] = []): boolean =>
	required.every((key) => Object.hasOwn(value, key)) &&
	Object.keys(value).every((key) => required.includes(key) || optional.includes(key))

/** Serialize sorted keys directly: constructing a sorted object would reorder integer-like keys again.
 * Reject non-JSON values, accessors, sparse arrays, cycles and excessive input rather than silently coercing.
 * Limits are refusal caps, not truncation: 64 levels, 100,000 values, 2 MiB serialized UTF-8 input.
 */
function canonicalJson(value: unknown): string {
	let count = 0
	const ancestors = new Set<object>()
	const encode = (item: unknown, depth: number): string => {
		if (++count > 100_000 || depth > 64) throw new Error("Unsupported synthetic JSON")
		if (item === null || typeof item === "string" || typeof item === "boolean") return JSON.stringify(item)
		if (typeof item === "number" && Number.isFinite(item) && !Object.is(item, -0)) return JSON.stringify(item)
		if (typeof item !== "object" || item === null || ancestors.has(item)) throw new Error("Non-JSON value")
		if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype)
			throw new Error("Non-plain object")
		const descriptors = Object.getOwnPropertyDescriptors(item)
		if (Object.getOwnPropertySymbols(item).length) throw new Error("Symbol keys")
		const names = Object.keys(descriptors).filter((key) => !(Array.isArray(item) && key === "length"))
		if (names.some((key) => !descriptors[key].enumerable || !("value" in descriptors[key])))
			throw new Error("Non-data property")
		ancestors.add(item)
		let result: string
		if (Array.isArray(item)) {
			if (names.length !== item.length || names.some((key, index) => key !== String(index)))
				throw new Error("Sparse or extended array")
			result = `[${names.map((key) => encode(descriptors[key].value, depth + 1)).join(",")}]`
		} else {
			result = `{${names
				.sort()
				.map((key) => `${JSON.stringify(key)}:${encode(descriptors[key].value, depth + 1)}`)
				.join(",")}}`
		}
		ancestors.delete(item)
		return result
	}
	const encoded = encode(value, 0)
	if (Buffer.byteLength(encoded, "utf8") > 2 * 1024 * 1024) throw new Error("Synthetic JSON size cap")
	return encoded
}
const equal = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right)
const validAction = (value: unknown): value is RecordValue =>
	object(value) &&
	keys(value, ["kind", "actionId", "mode", "message", "todos", "approvalText"]) &&
	value.kind === "create_subtask" &&
	id(value.actionId) &&
	nonempty(value.mode) &&
	nonempty(value.message) &&
	nonempty(value.approvalText) &&
	Array.isArray(value.todos) &&
	value.todos.every(
		(todo: unknown) =>
			object(todo) &&
			keys(todo, ["id", "content", "status"]) &&
			nonempty(todo.id) &&
			nonempty(todo.content) &&
			["pending", "in_progress", "completed"].includes(String(todo.status)),
	)

// Matches NewTaskTool/parseMarkdownChecklist derivation for accepted lines, but refuses ignored junk.
function deriveTodos(raw: unknown): Json[] | null {
	if (raw === undefined || raw === "") return []
	if (typeof raw !== "string") return null
	const todos: Json[] = []
	for (const line of raw
		.split(/\r?\n/)
		.map((part) => part.trim())
		.filter(Boolean)) {
		const match = line.match(/^(?:-\s*)?\[\s*([ xX\-~])\s*\]\s+(.+)$/)
		if (!match) return null
		const status = /[xX]/.test(match[1]) ? "completed" : /[-~]/.test(match[1]) ? "in_progress" : "pending"
		todos.push({
			id: createHash("md5")
				.update(match[2] + status)
				.digest("hex"),
			content: match[2],
			status,
		})
	}
	return todos
}

/** Never imports preflight, production preparation/adapter, persistence, locks, host or queue code. */
export function classifyManualSupersedeResultIdentity(input: unknown): ManualSupersedeResultObservation {
	const blocked: ManualSupersedeIdentityBlock[] = []
	const add = (reason: ManualSupersedeIdentityBlock): void => {
		if (!blocked.includes(reason)) blocked.push(reason)
	}
	const report = (
		identity: ManualSupersedeV1Identity | null,
		matching = false,
	): ManualSupersedeResultObservation => ({
		kind: "unwired_result_identity_observation",
		disposition: blocked.length ? "blocked" : "unknown",
		classification: blocked.length
			? "conflict_or_unknown"
			: matching
				? "one_matching_proposed_result"
				: "no_result",
		writeAuthorized: false,
		historicalChildOutcome: "unknown",
		blocked,
		unknown: [
			"historical_child_outcome_unknown",
			"provider_effective_history_unverified",
			"host_writer_exclusion_unverified",
			"canonical_storage_root_unverified",
			"owner_inventory_unverified",
			"approval_mode_evidence_unverified",
		],
		identity: blocked.length ? null : identity,
	})
	try {
		// Snapshot validated JSON: caller mutation/accessors cannot alter the comparison mid-observation.
		const value: unknown = JSON.parse(canonicalJson(input))
		if (
			!object(value) ||
			!keys(
				value,
				[
					"storageRoot",
					"target",
					"root",
					"parent",
					"lineage",
					"approvalMode",
					"rawHistory",
					"effectiveHistory",
				],
				["proposedIdentity"],
			)
		) {
			add("input_corrupt")
			return report(null)
		}
		const { storageRoot, target, root, parent, lineage, approvalMode } = value
		if (
			!object(storageRoot) ||
			!keys(storageRoot, ["requestedPath", "canonicalRealPath"]) ||
			!nonempty(storageRoot.requestedPath) ||
			!nonempty(storageRoot.canonicalRealPath)
		) {
			add("input_corrupt")
			return report(null)
		}
		const realRoot = storageRoot.canonicalRealPath
		if (
			storageRoot.requestedPath !== realRoot ||
			!posix.isAbsolute(realRoot) ||
			posix.normalize(realRoot) !== realRoot ||
			realRoot.includes("\\") ||
			realRoot.includes("\0") ||
			(realRoot !== "/" && realRoot.endsWith("/"))
		)
			add("storage_root_alias")
		if (
			!object(target) ||
			!keys(target, ["parentId", "rootTaskId", "oldAction"]) ||
			!id(target.parentId) ||
			!id(target.rootTaskId) ||
			!object(root) ||
			!keys(root, ["id", "rootTaskId"]) ||
			!object(parent) ||
			!keys(
				parent,
				["id", "rootTaskId", "status", "pendingAction"],
				["parentTaskId", "pendingQuestion", "awaitingChildId", "delegatedToId", "childIds"],
			)
		) {
			add("parent_root_mismatch")
			return report(null)
		}
		if (
			root.id !== target.rootTaskId ||
			root.rootTaskId !== root.id ||
			parent.id !== target.parentId ||
			parent.rootTaskId !== root.id ||
			!Array.isArray(lineage) ||
			!lineage.length ||
			!lineage.every(id) ||
			new Set(lineage).size !== lineage.length ||
			lineage[0] !== root.id ||
			lineage.at(-1) !== parent.id ||
			(lineage.length === 1 ? Object.hasOwn(parent, "parentTaskId") : parent.parentTaskId !== lineage.at(-2))
		)
			add("parent_root_mismatch")
		if (parent.childIds !== undefined && (!Array.isArray(parent.childIds) || !parent.childIds.every(id)))
			add("parent_root_mismatch")
		if (parent.status !== "interrupted") add("status_changed")
		if (Object.hasOwn(parent, "pendingQuestion")) add("pending_question")
		if (Object.hasOwn(parent, "awaitingChildId") || Object.hasOwn(parent, "delegatedToId")) add("known_child_owner")
		if (!validAction(parent.pendingAction) || !validAction(target.oldAction)) {
			add("action_corrupt")
			return report(null)
		}
		const action = parent.pendingAction
		if (!equal(action, target.oldAction)) add("action_changed")
		if (
			!object(approvalMode) ||
			!keys(approvalMode, ["slug", "displayName"]) ||
			approvalMode.slug !== action.mode ||
			!nonempty(approvalMode.displayName)
		)
			add("approval_derivation_mismatch")

		const scan = (read: unknown, source: "raw" | "effective"): Scan | null => {
			const corrupt = source === "raw" ? "raw_history_corrupt" : "effective_history_corrupt"
			if (!object(read)) {
				add(corrupt)
				return null
			}
			if (read.kind === "missing" && keys(read, ["kind"])) {
				add(source === "raw" ? "raw_history_missing" : "effective_history_missing")
				return null
			}
			if (read.kind !== "parsed" || !keys(read, ["kind", "value"]) || !Array.isArray(read.value)) {
				add(corrupt)
				return null
			}
			const messages: RecordValue[] = []
			const uses = new Map<string, Call>()
			const results = new Map<string, RecordValue>()
			let call: Call | null = null
			for (const [m, message] of read.value.entries()) {
				if (
					!object(message) ||
					!keys(
						message,
						["role", "content"],
						[
							"ts",
							"messageId",
							"isSummary",
							"summaryId",
							"condenseParent",
							"isTruncationMarker",
							"truncationId",
							"truncationParent",
						],
					) ||
					!["user", "assistant"].includes(String(message.role))
				) {
					add(corrupt)
					return null
				}
				if (
					(message.ts !== undefined && (typeof message.ts !== "number" || message.ts < 0)) ||
					(message.messageId !== undefined && !nonempty(message.messageId))
				) {
					add(corrupt)
					return null
				}
				for (const flag of ["isSummary", "isTruncationMarker"]) {
					if (message[flag] !== undefined && typeof message[flag] !== "boolean") add(corrupt)
					if (message[flag] === true) add("history_visibility_changed")
				}
				for (const tag of ["summaryId", "condenseParent", "truncationId", "truncationParent"])
					if (Object.hasOwn(message, tag)) add("history_visibility_changed")
				messages.push(message)
				if (typeof message.content === "string") continue
				if (!Array.isArray(message.content) || !message.content.length) {
					add(corrupt)
					return null
				}
				for (const [b, block] of message.content.entries()) {
					if (!object(block)) {
						add(corrupt)
						return null
					}
					if (block.type === "text") {
						if (!keys(block, ["type", "text"]) || typeof block.text !== "string") add(corrupt)
					} else if (block.type === "tool_use") {
						if (
							!keys(block, ["type", "id", "name", "input"]) ||
							message.role !== "assistant" ||
							!id(block.id) ||
							!nonempty(block.name) ||
							!object(block.input)
						) {
							add(corrupt)
							return null
						}
						if (uses.has(block.id)) add("call_duplicate")
						const found = {
							messageIndex: m,
							blockIndex: b,
							id: block.id,
							name: block.name,
							input: block.input,
						}
						uses.set(block.id, found)
						if (block.id === action.actionId) call = found
					} else if (block.type === "tool_result") {
						if (
							!keys(block, ["type", "tool_use_id", "content"], ["is_error"]) ||
							message.role !== "user" ||
							!id(block.tool_use_id) ||
							(block.is_error !== undefined && typeof block.is_error !== "boolean") ||
							!(
								typeof block.content === "string" ||
								(Array.isArray(block.content) &&
									block.content.every(
										(part: unknown) =>
											object(part) &&
											keys(part, ["type", "text"]) &&
											part.type === "text" &&
											typeof part.text === "string",
									))
							)
						) {
							add(corrupt)
							return null
						}
						const previous = uses.get(block.tool_use_id)
						if (!previous || previous.messageIndex !== m - 1 || results.has(block.tool_use_id))
							add("orphan_or_duplicate_result")
						results.set(block.tool_use_id, block)
					} else add(corrupt)
				}
			}
			if (!call) add("call_missing")
			for (const useId of uses.keys())
				if (useId !== action.actionId && !results.has(useId)) add("unresolved_sibling")
			const result = results.get(String(action.actionId)) ?? null
			if (call) {
				const content = messages[call.messageIndex].content
				if (
					!Array.isArray(content) ||
					call.blockIndex !== content.length - 1 ||
					content.filter((block: unknown) => object(block) && block.type === "tool_use").length !== 1
				)
					add("call_not_terminal")
				if (call.messageIndex !== messages.length - (result ? 2 : 1)) {
					add("call_not_terminal")
					add("later_turn")
				}
				if (result) {
					const last = messages.at(-1)
					if (
						!last ||
						last.role !== "user" ||
						!Array.isArray(last.content) ||
						last.content.length !== 1 ||
						!equal(last.content[0], result)
					)
						add("result_conflict")
				}
			}
			return { messages, call, result }
		}
		const raw = scan(value.rawHistory, "raw")
		const effective = scan(value.effectiveHistory, "effective")
		if (!raw || !effective) return report(null)
		if (!equal(raw.messages, effective.messages)) add("effective_projection_changed")
		if (!raw.call || !effective.call) return report(null)
		const call = raw.call
		const todos = deriveTodos(call.input.todos)
		if (
			call.name !== "new_task" ||
			!keys(call.input, ["mode", "message"], ["todos"]) ||
			call.input.mode !== action.mode ||
			!nonempty(call.input.message) ||
			call.input.message.replace(/\\\\@/g, "\\@") !== action.message ||
			todos === null ||
			!equal(todos, action.todos)
		)
			add("call_changed")
		if (
			!object(approvalMode) ||
			action.approvalText !==
				JSON.stringify({ tool: "newTask", mode: approvalMode.displayName, content: call.input.message, todos })
		)
			add("approval_derivation_mismatch")
		if (blocked.length) return report(null)
		const canonicalTuple = canonicalJson([
			MANUAL_SUPERSEDE_B1_VERSION,
			realRoot,
			parent.id,
			action,
			call.id,
			call.name,
			call.input,
			call.messageIndex,
			call.blockIndex,
			MANUAL_SUPERSEDE_B1_TRUTH,
		])
		const digest = createHash("sha256").update(canonicalTuple, "utf8").digest("hex")
		const marker = `zoo.manual_supersede.B1.v1:${digest}`
		const content = `${marker}\n${MANUAL_SUPERSEDE_B1_TRUTH}`
		const identity: ManualSupersedeV1Identity = {
			version: MANUAL_SUPERSEDE_B1_VERSION,
			canonicalTuple,
			digest,
			marker,
			content,
			proposedMessage: {
				role: "user",
				content: [{ type: "tool_result", tool_use_id: String(action.actionId), is_error: true, content }],
			},
		}
		if (
			Object.hasOwn(value, "proposedIdentity") &&
			!equal(value.proposedIdentity, { version: identity.version, digest, content })
		)
			add("proposed_identity_mismatch")
		if (raw.result && !equal(raw.result, identity.proposedMessage.content[0])) add("result_conflict")
		return report(identity, raw.result !== null)
	} catch {
		add("input_corrupt")
		return report(null)
	}
}
