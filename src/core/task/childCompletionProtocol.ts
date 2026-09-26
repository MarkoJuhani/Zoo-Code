import type { ApiMessage } from "../task-persistence"

export type DelegationHandoffFailureReason =
	| "provider_unavailable"
	| "completion_display_failed"
	| "child_metadata_missing"
	| "parent_metadata_missing"
	| "metadata_read_failed"
	| "ownership_moved"
	| "parent_state_mismatch"
	| "pending_action_write_failed"
	| "approval_failed"
	| "durability_failed"
	| "unexpected_provider_rejection"
	| "unexpected_child_status"
	| "history_read_failed"
	| "history_write_failed"
	| "lifecycle_commit_failed"
	| "parent_creation_failed"
	| "pending_action_mismatch"

export type DelegationFailureStage =
	| "provider_access"
	| "completion_display"
	| "child_metadata_read"
	| "parent_metadata_read"
	| "ownership_validation"
	| "child_status_validation"
	| "pending_action_write"
	| "approval"
	| "preapproval_durability"
	| "postapproval_durability"
	| "provider_handoff"
	| "provider_outcome"

export type DelegationFailureDiagnostic = {
	phase: "precommit"
	stage: DelegationFailureStage
	reason: DelegationHandoffFailureReason
	parentTaskId: string
	childTaskId: string
	actionId?: string
	name?: string
	code?: string
}

export const DELEGATED_COMPLETION_RECOVERY =
	"Delegated completion is stopped; the handoff has not been confirmed committed. " +
	"Any saved finish action has been retained. Repair the task storage or delegation ownership, " +
	"then reopen the child from task history to retry the saved approval. " +
	"If no finish action was saved, restart the child from its parent. Do not retry through the model."

export type DelegationResumeState = "queued" | "not_queued" | "cancelled" | "started" | "settled" | "failed"

export type DelegationCommitPhase = "precommit" | "committed"

export type DelegationHandoffOutcome =
	| { kind: "committed"; phase: "committed"; resumeState: DelegationResumeState; correlationId: string }
	| {
			kind: "detached"
			phase: "precommit"
			reason: "cancelled" | "ownership_moved" | "historical_replay"
	  }
	| { kind: "pending"; phase: "precommit"; reason: "approval" | "durability" }
	| { kind: "recoverable_failure"; phase: "precommit"; reason: DelegationHandoffFailureReason }

export function normalizeDelegationHandoffOutcome(
	outcome: DelegationHandoffOutcome | boolean,
): DelegationHandoffOutcome {
	if (typeof outcome !== "boolean") return outcome
	return outcome
		? { kind: "committed", phase: "committed", resumeState: "queued", correlationId: "legacy" }
		: { kind: "detached", phase: "precommit", reason: "ownership_moved" }
}

export const DELEGATED_CHILD_COMPLETION_REPAIR =
	"You are a delegated child. Call attempt_completion now with the handoff. Do not address the end user."

export function isRecognizableWorkerEnvelope(text: string): boolean {
	const firstLine = text.trimStart().split(/\r?\n/, 1)[0]?.trimEnd()
	return firstLine === "STATUS=SUCCESS" || firstLine === "STATUS=NEEDS_PARENT"
}

export function hasPersistedCompletionRepair(messages: readonly ApiMessage[]): boolean {
	return messages.some(
		(message) =>
			message.role === "user" &&
			Array.isArray(message.content) &&
			message.content.some((block) => block.type === "text" && block.text === DELEGATED_CHILD_COMPLETION_REPAIR),
	)
}
