import { createHash } from "node:crypto"

import {
	RECOVERY_INTAKE_KIND,
	serializeRecoverySubmission,
	type AcceptedRecoverySubmission,
	type RecoveryBinding,
	type RecoveryIntakeReceipt,
	type RecoverySubmission,
} from "../../shared/recoveryIntake"

/** Deliberately no production adapter: P1 review and P2 fence agreement are prerequisites. */
export interface RecoveryIntakeStore {
	/** Outer parent fence; adapter must revalidate ownership for every conditional write. */
	withParentFence<T>(binding: RecoveryBinding, operation: () => Promise<T>): Promise<T>
	/** Fresh authoritative classification, not a webview flag or cached task. */
	classify(binding: RecoveryBinding): Promise<{
		kind: typeof RECOVERY_INTAKE_KIND | "ordinary" | "blocked"
		pendingQuestion: boolean
	}>
	/** Enforces immutable IDs across actions/parents and one accepted submission per action. */
	writeOnce(record: AcceptedRecoverySubmission): Promise<void>
	/** Must verify protected blobs, versions, permissions, references and digests from disk. */
	read(binding: RecoveryBinding, submissionId: string): Promise<AcceptedRecoverySubmission | undefined>
	list(binding: RecoveryBinding): Promise<AcceptedRecoverySubmission[]>
}

export type RecoveryIntakeResult =
	| { kind: "accepted"; receipt: RecoveryIntakeReceipt }
	| { kind: "not_recovery" }
	| { kind: "blocked"; reason: "intake_invalid" | "intake_unavailable" | "intake_conflict" }

export function recoverySubmissionDigest(submission: RecoverySubmission): string {
	return createHash("sha256").update(serializeRecoverySubmission(submission)).digest("hex")
}

function validSubmission(submission: RecoverySubmission): boolean {
	const { binding, payload } = submission
	if (
		![binding.parentTaskId, binding.rootTaskId, binding.actionId, submission.submissionId].every(
			(id) => typeof id === "string" && id.length > 0 && id.length <= 256,
		) ||
		!Array.isArray(binding.parentLineage) ||
		!binding.parentLineage.every((id) => typeof id === "string" && id.length > 0 && id.length <= 256) ||
		!Number.isSafeInteger(binding.actionGeneration) ||
		binding.actionGeneration < 1 ||
		!Number.isSafeInteger(submission.timestamp) ||
		submission.timestamp < 0 ||
		!["direct", "queued"].includes(submission.origin) ||
		typeof payload.text !== "string" ||
		!Array.isArray(payload.images) ||
		(!payload.text && !payload.images.length) ||
		payload.images.length > 10 ||
		Buffer.byteLength(payload.text, "utf8") > 1024 * 1024
	)
		return false
	let imageBytes = 0
	for (const image of payload.images) {
		if (typeof image !== "string" || image.length > 16 * 1024 * 1024) return false
		const match = /^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image)
		if (!match) return false
		const bytes = Buffer.from(match[1], "base64")
		if (!bytes.length || bytes.toString("base64") !== match[1]) return false
		imageBytes += bytes.length
		if (imageBytes > 8 * 1024 * 1024) return false
	}
	return Buffer.byteLength(serializeRecoverySubmission(submission), "utf8") <= 16 * 1024 * 1024
}

function sameAccepted(record: AcceptedRecoverySubmission | undefined, expected: AcceptedRecoverySubmission): boolean {
	return (
		!!record &&
		record.schemaVersion === 1 &&
		record.state === "accepted" &&
		record.acceptedVersion === 1 &&
		record.payloadDigest === expected.payloadDigest &&
		serializeRecoverySubmission(record.submission) === serializeRecoverySubmission(expected.submission)
	)
}

/** Intake only. Never claims/removes queue items, changes metadata, appends API turns or schedules work. */
export async function acceptRecoverySubmission(
	store: RecoveryIntakeStore,
	submission: RecoverySubmission,
): Promise<RecoveryIntakeResult> {
	try {
		// Snapshot before the first await so later queue edits cannot change the persisted payload.
		const snapshot: RecoverySubmission = structuredClone(submission)
		if (!validSubmission(snapshot)) return { kind: "blocked", reason: "intake_invalid" }
		const expected: AcceptedRecoverySubmission = {
			schemaVersion: 1,
			state: "accepted",
			acceptedVersion: 1,
			submission: snapshot,
			payloadDigest: recoverySubmissionDigest(snapshot),
		}
		return await store.withParentFence(snapshot.binding, async () => {
			const classification = await store.classify(snapshot.binding)
			if (classification.pendingQuestion || classification.kind === "ordinary") return { kind: "not_recovery" }
			if (classification.kind !== RECOVERY_INTAKE_KIND) return { kind: "blocked", reason: "intake_conflict" }
			const existing = await store.read(snapshot.binding, snapshot.submissionId)
			if (existing && !sameAccepted(existing, expected)) return { kind: "blocked", reason: "intake_conflict" }
			if (!existing) await store.writeOnce(expected)
			// Even duplicate submissions require a fresh complete read-back before any receipt.
			const persisted = await store.read(snapshot.binding, snapshot.submissionId)
			if (!sameAccepted(persisted, expected)) return { kind: "blocked", reason: "intake_conflict" }
			return {
				kind: "accepted",
				receipt: {
					type: "recoveryIntakeAccepted",
					submissionId: snapshot.submissionId,
					parentTaskId: snapshot.binding.parentTaskId,
					actionId: snapshot.binding.actionId,
					payloadDigest: expected.payloadDigest,
					acceptedVersion: 1,
				},
			}
		})
	} catch {
		// Never expose raw storage errors, text, images, paths or hashes.
		return { kind: "blocked", reason: "intake_unavailable" }
	}
}

/** Adopt the original queue ID/order without claiming or removing the mutable queue entry. */
export function adoptQueuedRecoverySubmission(
	binding: RecoveryBinding,
	message: { id: string; timestamp: number; text: string; images?: readonly string[] },
): RecoverySubmission {
	return structuredClone({
		binding,
		submissionId: message.id,
		origin: "queued",
		timestamp: message.timestamp,
		payload: { text: message.text, images: message.images ?? [] },
	})
}

/** Accepted records remain pending; this is not a delivery acknowledgement or a queue drain. */
export async function rehydrateRecoveryIntake(
	store: RecoveryIntakeStore,
	binding: RecoveryBinding,
): Promise<RecoverySubmission[]> {
	try {
		return await store.withParentFence(binding, async () => {
			const records = await store.list(binding)
			// P1 permits only one accepted owner of an action; unknown/corrupt records block all intake.
			if (records.length > 1) throw new Error("intake_conflict")
			for (const record of records) {
				if (
					!validSubmission(record.submission) ||
					serializeRecoverySubmission(record.submission) !==
						serializeRecoverySubmission({ ...record.submission, binding }) ||
					!sameAccepted(record, {
						...record,
						schemaVersion: 1,
						state: "accepted",
						acceptedVersion: 1,
						payloadDigest: recoverySubmissionDigest(record.submission),
					})
				)
					throw new Error("intake_conflict")
			}
			return structuredClone(records.map((record) => record.submission).sort((a, b) => a.timestamp - b.timestamp))
		})
	} catch {
		throw new Error("intake_conflict")
	}
}
