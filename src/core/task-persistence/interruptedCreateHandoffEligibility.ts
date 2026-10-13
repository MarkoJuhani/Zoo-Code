import type { HistoryItem } from "@roo-code/types"
import type { ApiMessage } from "./apiMessages"

export type AuthoritativeRead<T> = { kind: "found"; value: T } | { kind: "missing" } | { kind: "read_error" }

export type ChildAttribution = "historical_other_action" | "matching_action" | "unrelated" | "ambiguous"

export interface AttributedChildEvidence {
	metadata: HistoryItem
	attribution: ChildAttribution
}

export interface TransientChildEvidence {
	taskId: string
	metadata: AuthoritativeRead<HistoryItem>
	attribution: ChildAttribution
}

export interface InterruptedCreateHandoffEvidence {
	parentTaskId: string
	rootTaskId: string
	actionId: string
	parent: AuthoritativeRead<HistoryItem>
	root: AuthoritativeRead<HistoryItem>
	apiMessages: AuthoritativeRead<ApiMessage[]>
	children: AttributedChildEvidence[]
	transientChildren: TransientChildEvidence[]
	childRegistryComplete: boolean
	writerInventoryComplete: boolean
	liveOwner: "absent" | "present" | "unknown"
	matchingErrorCorrelated?: boolean
}

export type InterruptedCreateHandoffBlocker =
	| "writer_inventory_incomplete"
	| "parent_unavailable"
	| "root_unavailable"
	| "lineage_mismatch"
	| "parent_not_interrupted"
	| "pending_question"
	| "awaited_child"
	| "pending_action_mismatch"
	| "live_owner_present"
	| "live_owner_unknown"
	| "child_registry_incomplete"
	| "child_lineage_mismatch"
	| "child_for_action_exists"
	| "child_attribution_ambiguous"
	| "transient_child_ambiguous"
	| "api_history_unavailable"
	| "matching_call_missing"
	| "matching_call_duplicated"
	| "matching_call_not_terminal"
	| "other_unresolved_call"
	| "orphan_tool_result"
	| "matching_success_result"
	| "matching_result_conflict"
	| "matching_error_uncorrelated"

export type InterruptedCreateHandoffEligibility =
	| { kind: "eligible"; resume: "fresh" | "matching_error" }
	| { kind: "blocked"; reason: InterruptedCreateHandoffBlocker }

const blocked = (reason: InterruptedCreateHandoffBlocker): InterruptedCreateHandoffEligibility => ({
	kind: "blocked",
	reason,
})

interface ToolUseOccurrence {
	id: string
	name: string
	messageIndex: number
}

interface ToolResultOccurrence {
	id: string
	isError: boolean
}

function inspectToolBoundary(messages: ApiMessage[]): { uses: ToolUseOccurrence[]; results: ToolResultOccurrence[] } {
	const uses: ToolUseOccurrence[] = []
	const results: ToolResultOccurrence[] = []
	messages.forEach((message, messageIndex) => {
		if (!Array.isArray(message.content)) return
		for (const block of message.content) {
			if (block.type === "tool_use") uses.push({ id: block.id, name: block.name, messageIndex })
			if (block.type === "tool_result") {
				results.push({ id: block.tool_use_id, isError: block.is_error === true })
			}
		}
	})
	return { uses, results }
}

export function evaluateInterruptedCreateHandoffEligibility(
	evidence: InterruptedCreateHandoffEvidence,
): InterruptedCreateHandoffEligibility {
	if (!evidence.writerInventoryComplete) return blocked("writer_inventory_incomplete")
	if (evidence.parent.kind !== "found") return blocked("parent_unavailable")
	if (evidence.root.kind !== "found") return blocked("root_unavailable")
	const parent = evidence.parent.value
	const root = evidence.root.value
	if (
		parent.id !== evidence.parentTaskId ||
		parent.rootTaskId !== evidence.rootTaskId ||
		root.id !== evidence.rootTaskId ||
		root.parentTaskId !== undefined
	) {
		return blocked("lineage_mismatch")
	}
	if (parent.status !== "interrupted") return blocked("parent_not_interrupted")
	if (parent.pendingQuestion) return blocked("pending_question")
	if (parent.awaitingChildId || parent.delegatedToId) return blocked("awaited_child")
	if (parent.pendingAction?.kind !== "create_subtask" || parent.pendingAction.actionId !== evidence.actionId) {
		return blocked("pending_action_mismatch")
	}
	if (evidence.liveOwner === "present") return blocked("live_owner_present")
	if (evidence.liveOwner === "unknown") return blocked("live_owner_unknown")
	if (!evidence.childRegistryComplete) return blocked("child_registry_incomplete")
	for (const child of evidence.children) {
		if (child.attribution === "unrelated") continue
		if (
			child.metadata.parentTaskId !== evidence.parentTaskId ||
			child.metadata.rootTaskId !== evidence.rootTaskId
		) {
			return blocked("child_lineage_mismatch")
		}
		if (child.attribution === "matching_action") return blocked("child_for_action_exists")
		if (child.attribution === "ambiguous") return blocked("child_attribution_ambiguous")
	}
	for (const transient of evidence.transientChildren) {
		if (transient.metadata.kind !== "found" || transient.attribution === "ambiguous") {
			return blocked("transient_child_ambiguous")
		}
		if (transient.attribution === "matching_action") return blocked("child_for_action_exists")
	}
	if (evidence.apiMessages.kind !== "found") return blocked("api_history_unavailable")
	const messages = evidence.apiMessages.value
	const { uses, results } = inspectToolBoundary(messages)
	const matchingUses = uses.filter((entry) => entry.id === evidence.actionId && entry.name === "new_task")
	if (matchingUses.length === 0) return blocked("matching_call_missing")
	if (matchingUses.length > 1) return blocked("matching_call_duplicated")
	const matchingResults = results.filter((entry) => entry.id === evidence.actionId)
	if (matchingResults.some((entry) => !entry.isError)) return blocked("matching_success_result")
	if (matchingResults.length > 1) return blocked("matching_result_conflict")
	const useIds = new Set(uses.map((entry) => entry.id))
	if (results.some((entry) => !useIds.has(entry.id))) return blocked("orphan_tool_result")
	const resultIds = new Set(results.map((entry) => entry.id))
	if (uses.some((entry) => entry.id !== evidence.actionId && !resultIds.has(entry.id))) {
		return blocked("other_unresolved_call")
	}
	if (matchingResults.length === 1) {
		return evidence.matchingErrorCorrelated
			? { kind: "eligible", resume: "matching_error" }
			: blocked("matching_error_uncorrelated")
	}
	if (matchingUses[0].messageIndex !== messages.length - 1) return blocked("matching_call_not_terminal")
	return { kind: "eligible", resume: "fresh" }
}
