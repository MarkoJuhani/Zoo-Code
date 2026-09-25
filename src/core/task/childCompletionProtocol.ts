import type { ApiMessage } from "../task-persistence"

export type DelegationHandoffFailureReason =
	| "provider_unavailable"
	| "history_lookup_failed"
	| "unexpected_child_status"
	| "history_read_failed"
	| "history_write_failed"
	| "lifecycle_commit_failed"
	| "parent_creation_failed"
	| "pending_action_mismatch"

export type DelegationResumeState = "queued" | "not_queued" | "cancelled" | "started" | "settled" | "failed"

export type DelegationHandoffOutcome =
	| { kind: "committed"; resumeState: DelegationResumeState; correlationId: string }
	| { kind: "detached"; reason: "cancelled" | "ownership_moved" | "historical_replay" }
	| { kind: "pending"; reason: "approval" | "durability" }
	| { kind: "recoverable_failure"; reason: DelegationHandoffFailureReason }

export function normalizeDelegationHandoffOutcome(
	outcome: DelegationHandoffOutcome | boolean,
): DelegationHandoffOutcome {
	if (typeof outcome !== "boolean") return outcome
	return outcome
		? { kind: "committed", resumeState: "queued", correlationId: "legacy" }
		: { kind: "detached", reason: "ownership_moved" }
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
