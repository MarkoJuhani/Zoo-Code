import * as crypto from "node:crypto"
import * as path from "node:path"

import type { PendingTaskAction } from "@roo-code/types"
import { collectInterruptedCreateHandoff, readStrictJson } from "./interruptedCreateHandoffDisk"

type OldAction = Extract<PendingTaskAction, { kind: "create_subtask" }>
export type PreflightBlock =
	| "storage_unavailable"
	| "parent_missing"
	| "parent_corrupt"
	| "root_corrupt"
	| "root_mismatch"
	| "status_changed"
	| "action_changed"
	| "action_corrupt"
	| "pending_question"
	| "active_child_owner"
	| "possible_child_owner"
	| "registry_or_intent_ambiguous"
	| "api_missing"
	| "api_corrupt"
	| "call_missing"
	| "call_duplicate"
	| "call_changed"
	| "call_not_terminal"
	| "unresolved_sibling"
	| "orphan_or_duplicate_result"
	| "conflicting_result"
	| "later_turn"
export type PreflightUnknown =
	| "historical_child_outcome_unknown"
	| "provider_effective_history_unverified"
	| "host_writer_exclusion_unverified"
export interface SupersedePreflightFacts {
	parentRead: "found" | "missing" | "read_error"
	apiRead: "found" | "missing" | "read_error"
	apiMessageCount: number | null
	oldCall: "missing" | "single" | "duplicate" | "unverified"
	oldResult: "none" | "present" | "unverified"
	historicalChildOutcome: "unknown"
	recordedChildIds: string[]
}
/** Diagnostic only. This is not a lease, authorization, or assertion that the old host has exited. */
export interface SupersedePreflight {
	kind: "read_only_facts"
	facts: SupersedePreflightFacts
	blocked: PreflightBlock[]
	unknown: PreflightUnknown[]
}
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v)
const id = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9_-]{1,256}$/.test(v)
const equal = (a: unknown, b: unknown): boolean => {
	if (Array.isArray(a) || Array.isArray(b))
		return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => equal(v, b[i]))
	if (object(a) || object(b))
		return (
			object(a) &&
			object(b) &&
			Object.keys(a).length === Object.keys(b).length &&
			Object.keys(a).every((k) => k in b && equal(a[k], b[k]))
		)
	return a === b
}
const validAction = (v: unknown): v is OldAction =>
	object(v) &&
	Object.keys(v).length === 6 &&
	["kind", "actionId", "mode", "message", "approvalText", "todos"].every((key) => key in v) &&
	v.kind === "create_subtask" &&
	id(v.actionId) &&
	typeof v.mode === "string" &&
	!!v.mode &&
	typeof v.message === "string" &&
	!!v.message &&
	typeof v.approvalText === "string" &&
	Array.isArray(v.todos) &&
	v.todos.every(
		(t: unknown) =>
			object(t) &&
			Object.keys(t).length === 3 &&
			typeof t.id === "string" &&
			typeof t.content === "string" &&
			["pending", "in_progress", "completed"].includes(t.status as string),
	)
const checklist = (raw: unknown): unknown[] | null => {
	if (raw === undefined || raw === "") return []
	if (typeof raw !== "string") return null
	const lines = raw
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
	if (lines.some((line) => !/^(?:-\s*)?\[\s*([ xX\-~])\s*\]\s+(.+)$/.test(line))) return null
	return lines.flatMap((line) => {
		const match = line.match(/^(?:-\s*)?\[\s*([ xX\-~])\s*\]\s+(.+)$/)
		if (!match) return []
		const status = /[xX]/.test(match[1]) ? "completed" : /[-~]/.test(match[1]) ? "in_progress" : "pending"
		return [
			{
				id: crypto
					.createHash("md5")
					.update(match[2] + status)
					.digest("hex"),
				content: match[2],
				status,
			},
		]
	})
}
const sameActionInput = (input: unknown, action: OldAction): boolean =>
	object(input) &&
	Object.keys(input).every((key) => ["mode", "message", "todos"].includes(key)) &&
	input.mode === action.mode &&
	typeof input.message === "string" &&
	input.message.replace(/\\\\@/g, "\\@") === action.message &&
	equal(checklist(input.todos), action.todos)
const approvalMatches = (action: OldAction): boolean => {
	try {
		const approval: unknown = JSON.parse(action.approvalText)
		return (
			object(approval) &&
			Object.keys(approval).length === 4 &&
			approval.tool === "newTask" &&
			typeof approval.mode === "string" &&
			!!approval.mode &&
			typeof approval.content === "string" &&
			approval.content.replace(/\\\\@/g, "\\@") === action.message &&
			equal(approval.todos, action.todos)
		)
	} catch {
		return false
	}
}
/** Strict synthetic disk read; expectedAction is only a comparison target, never evidence of host/completeness. */
export async function inspectManualSupersedePreflight(
	storageBase: string,
	parentTaskId: string,
	rootTaskId: string,
	expectedAction: OldAction,
): Promise<SupersedePreflight> {
	const blocked: PreflightBlock[] = []
	const add = (reason: PreflightBlock) => {
		if (!blocked.includes(reason)) blocked.push(reason)
	}
	const facts: SupersedePreflightFacts = {
		parentRead: "read_error",
		apiRead: "read_error",
		apiMessageCount: null,
		oldCall: "unverified",
		oldResult: "unverified",
		historicalChildOutcome: "unknown",
		recordedChildIds: [],
	}
	const report = (): SupersedePreflight => ({
		kind: "read_only_facts",
		facts,
		blocked,
		unknown: [
			"historical_child_outcome_unknown",
			"provider_effective_history_unverified",
			"host_writer_exclusion_unverified",
		],
	})
	if (!id(parentTaskId) || !id(rootTaskId) || !validAction(expectedAction)) {
		add("action_corrupt")
		return report()
	}
	try {
		const { evidence, parentLineage } = await collectInterruptedCreateHandoff(
			storageBase,
			parentTaskId,
			expectedAction.actionId,
		)
		facts.parentRead = evidence.parent.kind
		facts.apiRead = evidence.apiMessages.kind
		if (evidence.parent.kind !== "found")
			add(evidence.parent.kind === "missing" ? "parent_missing" : "parent_corrupt")
		if (evidence.root.kind !== "found") add("root_corrupt")
		if (
			evidence.rootTaskId !== rootTaskId ||
			parentLineage[0] !== rootTaskId ||
			parentLineage.at(-1) !== parentTaskId ||
			evidence.root.kind !== "found" ||
			evidence.root.value.id !== rootTaskId
		)
			add("root_mismatch")
		if (evidence.parent.kind === "found") {
			const parent = evidence.parent.value
			// The collector checks only a subset of fields. Reject inconsistent reads and malformed owner fields.
			const raw = await readStrictJson(path.join(storageBase, "tasks", parentTaskId, "history_item.json"), object)
			if (
				raw.kind !== "found" ||
				!equal(raw.value, parent) ||
				(raw.value.pendingQuestion !== undefined &&
					(!object(raw.value.pendingQuestion) || !id(raw.value.pendingQuestion.id))) ||
				["awaitingChildId", "delegatedToId"].some((key) => raw.value[key] !== undefined && !id(raw.value[key]))
			)
				add("parent_corrupt")
			if (parent.status !== "interrupted") add("status_changed")
			if (parent.pendingQuestion !== undefined) add("pending_question")
			if (parent.awaitingChildId || parent.delegatedToId) add("active_child_owner")
			if (!validAction(parent.pendingAction)) add("action_corrupt")
			else if (!equal(parent.pendingAction, expectedAction) || !approvalMatches(parent.pendingAction))
				add("action_changed")
			facts.recordedChildIds = [...(parent.childIds ?? [])]
			for (const childId of parent.childIds ?? []) {
				const child = evidence.children.find((entry) => entry.metadata.id === childId)
				if (!child || child.metadata.parentTaskId !== parentTaskId || child.metadata.rootTaskId !== rootTaskId)
					add("possible_child_owner")
			}
		}
		if (!evidence.childRegistryComplete || evidence.transientChildren.length) add("registry_or_intent_ambiguous")
		for (const child of evidence.children) {
			const item = child.metadata
			if (item.parentTaskId === parentTaskId) {
				if (
					item.rootTaskId !== rootTaskId ||
					item.status !== "completed" ||
					!facts.recordedChildIds.includes(item.id)
				)
					add("active_child_owner")
			} else if (
				!item.parentTaskId ||
				(item.rootTaskId === rootTaskId && !parentLineage.includes(item.parentTaskId))
			)
				add("possible_child_owner")
		}
		if (evidence.apiMessages.kind !== "found") {
			add(evidence.apiMessages.kind === "missing" ? "api_missing" : "api_corrupt")
			return report()
		}
		const messages = evidence.apiMessages.value
		facts.apiMessageCount = messages.length
		const uses = new Map<string, { m: number; b: number; name: string; input: unknown }>()
		const results = new Set<string>()
		const earlierChildren = new Set<string>()
		let target: { m: number; b: number; input: unknown } | undefined
		let count = 0
		for (const [m, message] of messages.entries()) {
			if (!Array.isArray(message.content)) {
				if (message.role === "assistant" && m === messages.length - 1) add("call_not_terminal")
				continue
			}
			for (const [b, block] of message.content.entries()) {
				if (!object(block)) {
					add("api_corrupt")
					continue
				}
				if (block.type === "tool_use") {
					if (
						message.role !== "assistant" ||
						!id(block.id) ||
						typeof block.name !== "string" ||
						!object(block.input)
					) {
						add("api_corrupt")
						continue
					}
					if (uses.has(block.id)) add("call_duplicate")
					uses.set(block.id, { m, b, name: block.name, input: block.input })
					if (block.id === expectedAction.actionId) {
						count++
						target = { m, b, input: block.input }
						if (block.name !== "new_task") add("call_changed")
					}
				} else if (block.type === "tool_result") {
					if (
						Array.isArray(block.content) &&
						!block.content.every(
							(part: unknown) => object(part) && part.type === "text" && typeof part.text === "string",
						)
					)
						add("api_corrupt")
					if (
						message.role !== "user" ||
						!id(block.tool_use_id) ||
						(block.is_error !== undefined && typeof block.is_error !== "boolean") ||
						!(typeof block.content === "string" || Array.isArray(block.content)) ||
						results.has(block.tool_use_id) ||
						!uses.has(block.tool_use_id)
					)
						add("orphan_or_duplicate_result")
					const previous = uses.get(block.tool_use_id as string)
					if (
						previous &&
						previous.name === "new_task" &&
						previous.m < m &&
						message.role === "user" &&
						!results.has(block.tool_use_id as string) &&
						typeof block.content === "string"
					) {
						const match = block.content.match(/^Delegated to child task ([a-zA-Z0-9_-]{1,256})$/)
						if (match && block.tool_use_id !== expectedAction.actionId && block.is_error !== true)
							earlierChildren.add(match[1])
					}
					results.add(block.tool_use_id as string)
					if (block.tool_use_id === expectedAction.actionId) {
						facts.oldResult = "present"
						add("conflicting_result")
					}
				} else if (block.type === "text") {
					if (typeof block.text !== "string") add("api_corrupt")
				} else if (!["thinking", "redacted_thinking"].includes(block.type as string)) add("api_corrupt")
			}
		}
		facts.oldCall = count === 0 ? "missing" : count === 1 ? "single" : "duplicate"
		if (!count) add("call_missing")
		if (count > 1) add("call_duplicate")
		if (facts.oldResult !== "present") facts.oldResult = "none"
		if (target) {
			for (const child of evidence.children) {
				const item = child.metadata
				if (
					item.parentTaskId === parentTaskId &&
					item.status === "completed" &&
					facts.recordedChildIds.includes(item.id) &&
					!earlierChildren.has(item.id)
				)
					add("possible_child_owner")
			}
			if (!sameActionInput(target.input, expectedAction)) add("call_changed")
			if (
				target.m !== messages.length - 1 ||
				!Array.isArray(messages[target.m].content) ||
				target.b !== messages[target.m].content.length - 1
			) {
				add("call_not_terminal")
				if (target.m !== messages.length - 1) add("later_turn")
			}
			for (const [key, use] of uses)
				if (key !== expectedAction.actionId && !results.has(key)) add("unresolved_sibling")
		}
		return report()
	} catch {
		add("storage_unavailable")
		return report()
	}
}
