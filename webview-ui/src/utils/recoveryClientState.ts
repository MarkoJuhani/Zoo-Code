import {
	serializeRecoverySubmission,
	type RecoveryBinding,
	type RecoveryIntakeReceipt,
	type RecoverySubmission,
} from "@roo/recoveryIntake"
import { acknowledgeRecoveryDraft, type PendingRecoverySubmission, type RecoveryDraft } from "./recoverySubmission"

/** A caller-supplied durable store; no browser/session-memory implementation is a production adapter. */
export interface RecoveryClientStore {
	load(): Promise<RecoveryClientState | undefined>
	save(state: RecoveryClientState): Promise<void>
}
export interface RecoveryQueueSnapshot {
	id: string
	timestamp: number
	order: number
	text: string
	images: readonly string[]
	version: number
}
export interface RecoveryQuestionOwner {
	parentTaskId: string
	questionId: string
}
export interface RecoveryUnboundDirect {
	submissionId: string
	timestamp: number
	draft: RecoveryDraft
}
export interface RecoveryClientState {
	unboundDirect?: RecoveryUnboundDirect
	draft: RecoveryDraft
	pending?: PendingRecoverySubmission
	queue?: RecoveryQueueSnapshot
	accepted: boolean
	posted: boolean
}

/** An exact question owns its answer; never classify an answer as new recovery intake. */
export function recoveryRoute(
	taskId: string,
	answerToQuestionId: string | undefined,
	owner: RecoveryQuestionOwner | undefined,
): "question" | "new_submission" | "blocked" {
	if (owner) return owner.parentTaskId === taskId && owner.questionId === answerToQuestionId ? "question" : "blocked"
	return answerToQuestionId ? "blocked" : "new_submission"
}

export class RecoveryClientStateOwner {
	private busy = false
	constructor(private readonly store: RecoveryClientStore) {}
	/** Persist each edit/cancel with a new revision; keep pending for receipt replay. */
	async editDraft(expectedRevision: number, text: string, images: readonly string[]): Promise<void> {
		await this.change(async (state) => {
			if (
				state.draft.revision !== expectedRevision ||
				!Number.isSafeInteger(expectedRevision) ||
				expectedRevision < 0
			)
				throw new Error("intake_conflict")
			return {
				state: { ...state, draft: { text, images: [...images], revision: expectedRevision + 1 } },
				result: undefined,
			}
		})
	}
	private async change<T>(
		operation: (state: RecoveryClientState) => Promise<{ state: RecoveryClientState; result: T }>,
	): Promise<T> {
		if (this.busy) throw new Error("intake_conflict")
		this.busy = true
		try {
			const current = await this.store.load()
			const { state, result } = await operation(
				current
					? structuredClone(current)
					: { draft: { text: "", images: [], revision: 0 }, accepted: false, posted: false },
			)
			await this.store.save(structuredClone(state))
			return result
		} finally {
			this.busy = false
		}
	}
	/** Save a stable random ID before the host binding handshake; no send is permitted yet. */
	async snapshotDirect(draft: RecoveryDraft): Promise<RecoveryUnboundDirect> {
		return this.change(async (state) => {
			if (state.pending || state.queue || state.unboundDirect) throw new Error("intake_conflict")
			const unboundDirect = {
				submissionId: crypto.randomUUID(),
				timestamp: Date.now(),
				draft: structuredClone(draft),
			}
			return {
				state: { ...state, draft: structuredClone(draft), unboundDirect, accepted: false, posted: false },
				result: unboundDirect,
			}
		})
	}
	/** Preserve the pre-binding identity and payload after reload. Binding provenance belongs to P2. */
	async bindDirect(binding: RecoveryBinding): Promise<PendingRecoverySubmission> {
		return this.change(async (state) => {
			if (
				!state.unboundDirect ||
				state.pending ||
				state.posted ||
				!Number.isSafeInteger(binding.actionGeneration) ||
				binding.actionGeneration < 1
			)
				throw new Error("intake_conflict")
			const { submissionId, timestamp, draft } = state.unboundDirect
			const submission: RecoverySubmission = structuredClone({
				binding,
				submissionId,
				origin: "direct",
				timestamp,
				payload: { text: draft.text, images: draft.images },
			})
			const digest = await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(serializeRecoverySubmission(submission)),
			)
			const pending: PendingRecoverySubmission = {
				submission,
				draftRevision: draft.revision,
				payloadDigest: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
					"",
				),
			}
			return { state: { ...state, pending, unboundDirect: undefined }, result: pending }
		})
	}
	/** Adopt the original queue ID, timestamp and position before asking the host for a binding. */
	async adoptQueue(message: RecoveryQueueSnapshot): Promise<void> {
		await this.change(async (state) => {
			if (
				state.pending ||
				state.queue ||
				state.unboundDirect ||
				!message.id ||
				!Number.isSafeInteger(message.timestamp) ||
				!Number.isSafeInteger(message.order) ||
				!Number.isSafeInteger(message.version) ||
				message.version < 0
			)
				throw new Error("intake_conflict")
			return { state: { ...state, queue: structuredClone(message) }, result: undefined }
		})
	}
	/** Exact versioned ownership: after posting or durable acceptance, mutate via a new submission only. */
	async changeQueue(expectedVersion: number, next?: RecoveryQueueSnapshot): Promise<void> {
		await this.change(async (state) => {
			if (
				!state.queue ||
				state.queue.version !== expectedVersion ||
				state.posted ||
				state.accepted ||
				(next &&
					(next.id !== state.queue.id ||
						next.order !== state.queue.order ||
						next.version !== expectedVersion + 1))
			)
				throw new Error("intake_conflict")
			return {
				state: { ...state, queue: next ? structuredClone(next) : undefined, pending: undefined },
				result: undefined,
			}
		})
	}
	/** Only a host-issued binding may complete adoption. Do not invent actionGeneration. */
	async bindQueue(binding: RecoveryBinding): Promise<PendingRecoverySubmission> {
		return this.change(async (state) => {
			if (
				!state.queue ||
				state.pending ||
				state.posted ||
				!Number.isSafeInteger(binding.actionGeneration) ||
				binding.actionGeneration < 1
			)
				throw new Error("intake_conflict")
			const q = state.queue
			const submission: RecoverySubmission = structuredClone({
				binding,
				submissionId: q.id,
				origin: "queued",
				timestamp: q.timestamp,
				payload: { text: q.text, images: q.images },
			})
			const digest = await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(serializeRecoverySubmission(submission)),
			)
			const pending: PendingRecoverySubmission = {
				submission,
				draftRevision: state.draft.revision,
				payloadDigest: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
					"",
				),
			}
			return { state: { ...state, pending }, result: pending }
		})
	}
	/** Persist the posted marker first; on failure the unchanged snapshot remains retryable. */
	async markPosted(): Promise<PendingRecoverySubmission> {
		return this.change(async (state) => {
			if (!state.pending) throw new Error("intake_conflict")
			return { state: { ...state, posted: true }, result: state.pending }
		})
	}
	async receipt(receipt: RecoveryIntakeReceipt): Promise<boolean> {
		return this.change(async (state) => {
			if (
				!state.pending ||
				receipt.type !== "recoveryIntakeAccepted" ||
				receipt.acceptedVersion !== 1 ||
				receipt.submissionId !== state.pending.submission.submissionId ||
				receipt.parentTaskId !== state.pending.submission.binding.parentTaskId ||
				receipt.actionId !== state.pending.submission.binding.actionId ||
				receipt.payloadDigest !== state.pending.payloadDigest
			)
				return { state, result: false }
			const draft = state.queue ? state.draft : acknowledgeRecoveryDraft(state.draft, state.pending, receipt)
			return { state: { ...state, draft, accepted: true }, result: true }
		})
	}
}
