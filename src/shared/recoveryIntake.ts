/** P3 candidate only: not wired into the production webview protocol. */
export const RECOVERY_INTAKE_KIND = "interrupted_create_subtask_recovery_v1" as const

export interface RecoveryBinding {
	parentTaskId: string
	rootTaskId: string
	parentLineage: readonly string[]
	actionId: string
	actionGeneration: number
}

export interface RecoveryPayload {
	text: string
	/** Exact resolved data URIs; a production adapter must persist protected immutable blobs. */
	images: readonly string[]
}

export interface RecoverySubmission {
	binding: RecoveryBinding
	submissionId: string
	origin: "direct" | "queued"
	timestamp: number
	payload: RecoveryPayload
}

export interface AcceptedRecoverySubmission {
	schemaVersion: 1
	state: "accepted"
	acceptedVersion: 1
	submission: RecoverySubmission
	payloadDigest: string
}

export interface RecoveryIntakeReceipt {
	type: "recoveryIntakeAccepted"
	submissionId: string
	parentTaskId: string
	actionId: string
	payloadDigest: string
	acceptedVersion: 1
}

/** Fixed key ordering is shared by host and webview; hashes are never diagnostics. */
export function serializeRecoverySubmission(submission: RecoverySubmission): string {
	const { binding, payload } = submission
	return JSON.stringify({
		binding: {
			parentTaskId: binding.parentTaskId,
			rootTaskId: binding.rootTaskId,
			parentLineage: binding.parentLineage,
			actionId: binding.actionId,
			actionGeneration: binding.actionGeneration,
		},
		submissionId: submission.submissionId,
		origin: submission.origin,
		timestamp: submission.timestamp,
		payload: { text: payload.text, images: payload.images },
	})
}
