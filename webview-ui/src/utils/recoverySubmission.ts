import {
	serializeRecoverySubmission,
	type RecoveryBinding,
	type RecoveryIntakeReceipt,
	type RecoveryPayload,
	type RecoverySubmission,
} from "@roo/recoveryIntake"

export interface RecoveryDraft extends RecoveryPayload {
	/** Increment on every edit/cancel, including edit-away-and-back. */
	revision: number
}

export interface PendingRecoverySubmission {
	submission: RecoverySubmission
	draftRevision: number
	payloadDigest: string
}

/** Candidate helper only; caller must persist this snapshot before posting and reuse it after reload. */
export async function prepareRecoverySubmission(
	binding: RecoveryBinding,
	draft: RecoveryDraft,
): Promise<PendingRecoverySubmission> {
	const submission: RecoverySubmission = structuredClone({
		binding,
		submissionId: crypto.randomUUID(),
		origin: "direct",
		timestamp: Date.now(),
		payload: { text: draft.text, images: draft.images },
	})
	const draftRevision = draft.revision
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(serializeRecoverySubmission(submission)),
	)
	return {
		submission,
		draftRevision,
		payloadDigest: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
	}
}

/** Clear only an exact, unchanged draft. Failure/stale/duplicate receipts leave newer input untouched. */
export function acknowledgeRecoveryDraft(
	draft: RecoveryDraft,
	pending: PendingRecoverySubmission | undefined,
	receipt: RecoveryIntakeReceipt,
): RecoveryDraft {
	if (!pending) return draft
	const { submission } = pending
	if (
		receipt.type !== "recoveryIntakeAccepted" ||
		receipt.acceptedVersion !== 1 ||
		receipt.submissionId !== submission.submissionId ||
		receipt.parentTaskId !== submission.binding.parentTaskId ||
		receipt.actionId !== submission.binding.actionId ||
		receipt.payloadDigest !== pending.payloadDigest ||
		draft.revision !== pending.draftRevision ||
		draft.text !== submission.payload.text ||
		JSON.stringify(draft.images) !== JSON.stringify(submission.payload.images)
	)
		return draft
	return { text: "", images: [], revision: draft.revision + 1 }
}
