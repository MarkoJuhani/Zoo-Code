import { createHash, webcrypto } from "node:crypto"

import { serializeRecoverySubmission, type RecoveryBinding, type RecoveryIntakeReceipt } from "@roo/recoveryIntake"
import { acknowledgeRecoveryDraft, prepareRecoverySubmission, type RecoveryDraft } from "../recoverySubmission"

const binding: RecoveryBinding = {
	parentTaskId: "parent",
	rootTaskId: "root",
	parentLineage: ["root"],
	actionId: "call",
	actionGeneration: 1,
}
const image = "data:image/png;base64,AAECAw=="
beforeEach(() => {
	vi.stubGlobal("crypto", webcrypto)
})
afterEach(() => {
	vi.unstubAllGlobals()
})

it.each([
	["text", []],
	["", [image]],
	["mixed", [image]],
])("clears only after matching receipt: %s", async (text, images) => {
	const draft: RecoveryDraft = { text, images, revision: 4 }
	const pending = await prepareRecoverySubmission(binding, draft)
	const receipt: RecoveryIntakeReceipt = {
		type: "recoveryIntakeAccepted",
		submissionId: pending.submission.submissionId,
		parentTaskId: "parent",
		actionId: "call",
		payloadDigest: pending.payloadDigest,
		acceptedVersion: 1,
	}
	expect(draft).toEqual({ text, images, revision: 4 })
	expect(acknowledgeRecoveryDraft(draft, pending, receipt)).toEqual({ text: "", images: [], revision: 5 })
	// A persisted pending snapshot reuses its original ID across post/reload/retry.
	const restored = JSON.parse(JSON.stringify(pending))
	expect(restored.submission.submissionId).toBe(pending.submission.submissionId)
	expect(acknowledgeRecoveryDraft(draft, restored, receipt)).toEqual({ text: "", images: [], revision: 5 })
})

it.each(["submissionId", "parentTaskId", "actionId", "payloadDigest", "acceptedVersion", "type"])(
	"ignores mismatched receipt %s",
	async (field) => {
		const draft: RecoveryDraft = { text: "private", images: [image], revision: 1 }
		const pending = await prepareRecoverySubmission(binding, draft)
		const receipt: RecoveryIntakeReceipt = {
			type: "recoveryIntakeAccepted",
			submissionId: pending.submission.submissionId,
			parentTaskId: "parent",
			actionId: "call",
			payloadDigest: pending.payloadDigest,
			acceptedVersion: 1,
		}
		Object.assign(receipt, { [field]: field === "acceptedVersion" ? 2 : "wrong" })
		expect(acknowledgeRecoveryDraft(draft, pending, receipt)).toBe(draft)
	},
)

it.each(["text", "image", "cancel", "edit-back", "duplicate"])(
	"preserves draft after %s while acceptance was pending",
	async (edit) => {
		const draft: RecoveryDraft = { text: "private", images: [image], revision: 1 }
		const pending = await prepareRecoverySubmission(binding, draft)
		const receipt: RecoveryIntakeReceipt = {
			type: "recoveryIntakeAccepted",
			submissionId: pending.submission.submissionId,
			parentTaskId: "parent",
			actionId: "call",
			payloadDigest: pending.payloadDigest,
			acceptedVersion: 1,
		}
		const current = { ...draft, revision: 2 }
		if (edit === "text") current.text = "new input"
		if (edit === "image") current.images = []
		if (edit === "cancel") {
			current.text = ""
			current.images = []
		}
		expect(acknowledgeRecoveryDraft(current, pending, receipt)).toBe(current)
		expect(acknowledgeRecoveryDraft(current, undefined, receipt)).toBe(current)
	},
)

it("uses the same digest as the host and snapshots input before asynchronous hashing", async () => {
	const draft: RecoveryDraft = { text: "original", images: [image], revision: 1 }
	const preparing = prepareRecoverySubmission(binding, draft)
	draft.text = "edited"
	draft.images = []
	draft.revision++
	const pending = await preparing
	expect(pending.submission.payload).toEqual({ text: "original", images: [image] })
	expect(pending.payloadDigest).toBe(
		createHash("sha256").update(serializeRecoverySubmission(pending.submission)).digest("hex"),
	)
	expect(pending.draftRevision).toBe(1)
})

it("ignores a repeated receipt after clearing and preserves subsequent input", async () => {
	const draft: RecoveryDraft = { text: "submitted", images: [image], revision: 1 }
	const pending = await prepareRecoverySubmission(binding, draft)
	const receipt: RecoveryIntakeReceipt = {
		type: "recoveryIntakeAccepted",
		submissionId: pending.submission.submissionId,
		parentTaskId: "parent",
		actionId: "call",
		payloadDigest: pending.payloadDigest,
		acceptedVersion: 1,
	}
	const cleared = acknowledgeRecoveryDraft(draft, pending, receipt)
	expect(acknowledgeRecoveryDraft(cleared, pending, receipt)).toBe(cleared)
	const newer: RecoveryDraft = { text: "new message", images: [image], revision: 3 }
	expect(acknowledgeRecoveryDraft(newer, pending, receipt)).toBe(newer)
})
