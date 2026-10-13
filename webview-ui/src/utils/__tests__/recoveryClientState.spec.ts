import { webcrypto } from "node:crypto"
import type { RecoveryBinding, RecoveryIntakeReceipt } from "@roo/recoveryIntake"
import {
	RecoveryClientStateOwner,
	recoveryRoute,
	type RecoveryClientState,
	type RecoveryClientStore,
} from "../recoveryClientState"

const binding: RecoveryBinding = {
	parentTaskId: "parent",
	rootTaskId: "root",
	parentLineage: ["root"],
	actionId: "call",
	actionGeneration: 2,
}
const image = "data:image/png;base64,AAECAw=="
let saved: RecoveryClientState | undefined
let fail = false
const store: RecoveryClientStore = {
	load: async () => saved && structuredClone(saved),
	save: async (state) => {
		if (fail) throw new Error("disk failure")
		saved = structuredClone(state)
	},
}
const receipt = (pending: NonNullable<RecoveryClientState["pending"]>): RecoveryIntakeReceipt => ({
	type: "recoveryIntakeAccepted",
	parentTaskId: "parent",
	actionId: "call",
	submissionId: pending.submission.submissionId,
	payloadDigest: pending.payloadDigest,
	acceptedVersion: 1,
})
beforeEach(() => {
	saved = undefined
	fail = false
	vi.stubGlobal("crypto", webcrypto)
})
afterEach(() => vi.unstubAllGlobals())

it.each(["early", "late"])("retains direct text/image/mixed snapshot after %s reload and lost receipt", async () => {
	for (const draft of [
		{ text: "text", images: [], revision: 1 },
		{ text: "", images: [image], revision: 2 },
		{ text: "mixed", images: [image], revision: 3 },
	]) {
		saved = undefined
		const owner = new RecoveryClientStateOwner(store)
		const unbound = await owner.snapshotDirect(draft)
		expect((await store.load())?.unboundDirect?.submissionId).toBe(unbound.submissionId)
		const pending = await new RecoveryClientStateOwner(store).bindDirect(binding)
		const retried = await new RecoveryClientStateOwner(store).markPosted()
		expect(retried).toEqual(pending)
		expect(await new RecoveryClientStateOwner(store).receipt(receipt(pending))).toBe(true)
		expect(await store.load()).toMatchObject({ draft: { text: "", images: [], revision: draft.revision + 1 } })
	}
})
it("does not post or regenerate identity after failed persistence; failure preserves prior queue", async () => {
	const owner = new RecoveryClientStateOwner(store)
	fail = true
	await expect(owner.snapshotDirect({ text: "keep", images: [], revision: 0 })).rejects.toThrow()
	expect(saved).toBeUndefined()
	fail = false
	await owner.adoptQueue({ id: "original", timestamp: 10, order: 4, text: "queued", images: [image], version: 0 })
	fail = true
	await expect(owner.bindQueue(binding)).rejects.toThrow()
	expect(saved?.pending).toBeUndefined()
})
it.each(["early", "late"])(
	"adopts original queue before binding at %s timing, rejects edits and cancellation after post/receipt",
	async () => {
		const owner = new RecoveryClientStateOwner(store)
		await owner.adoptQueue({ id: "original", timestamp: 10, order: 4, text: "queued", images: [image], version: 0 })
		await owner.changeQueue(0, {
			id: "original",
			timestamp: 11,
			order: 4,
			text: "edited",
			images: [image],
			version: 1,
		})
		await expect(owner.changeQueue(0)).rejects.toThrow("intake_conflict")
		const pending = await owner.bindQueue(binding)
		expect(pending.submission).toMatchObject({
			submissionId: "original",
			timestamp: 11,
			origin: "queued",
			payload: { text: "edited", images: [image] },
		})
		await owner.changeQueue(1, {
			id: "original",
			timestamp: 12,
			order: 4,
			text: "new",
			images: [image],
			version: 2,
		})
		expect(saved?.pending).toBeUndefined()
		const rebound = await owner.bindQueue(binding)
		expect(rebound.submission.payload.text).toBe("new")
		expect(await new RecoveryClientStateOwner(store).markPosted()).toEqual(rebound)
		expect(await new RecoveryClientStateOwner(store).receipt({ ...receipt(rebound), payloadDigest: "other" })).toBe(
			false,
		)
		expect(saved?.accepted).toBe(false)
		expect(await new RecoveryClientStateOwner(store).receipt(receipt(rebound))).toBe(true)
		expect(saved?.queue?.id).toBe("original")
		await expect(new RecoveryClientStateOwner(store).changeQueue(1)).rejects.toThrow("intake_conflict")
	},
)
it("allows versioned cancel before binding; pending question owns only exact answer", async () => {
	const owner = new RecoveryClientStateOwner(store)
	await owner.adoptQueue({ id: "original", timestamp: 10, order: 0, text: "q", images: [], version: 0 })
	await owner.changeQueue(0)
	expect(saved?.queue).toBeUndefined()
	expect(recoveryRoute("parent", "question", { parentTaskId: "parent", questionId: "question" })).toBe("question")
	expect(recoveryRoute("parent", undefined, { parentTaskId: "parent", questionId: "question" })).toBe("blocked")
	expect(recoveryRoute("other", "question", { parentTaskId: "parent", questionId: "question" })).toBe("blocked")
	expect(recoveryRoute("parent", "stale", undefined)).toBe("blocked")
})

it("preserves a newer persisted draft through a late matching receipt and retains the replay identity", async () => {
	const owner = new RecoveryClientStateOwner(store)
	await owner.snapshotDirect({ text: "original", images: [image], revision: 4 })
	const pending = await owner.bindDirect(binding)
	await owner.markPosted()
	await new RecoveryClientStateOwner(store).editDraft(4, "newer", [])
	await expect(owner.editDraft(4, "stale", [])).rejects.toThrow("intake_conflict")
	expect(await new RecoveryClientStateOwner(store).receipt(receipt(pending))).toBe(true)
	expect(await store.load()).toMatchObject({
		draft: { text: "newer", images: [], revision: 5 },
		pending: { submission: { submissionId: pending.submission.submissionId } },
	})
})

it("failed binding keeps original direct ID and unchanged snapshot retryable", async () => {
	const owner = new RecoveryClientStateOwner(store)
	const unbound = await owner.snapshotDirect({ text: "before binding", images: [image], revision: 0 })
	fail = true
	await expect(owner.bindDirect(binding)).rejects.toThrow()
	fail = false
	const pending = await new RecoveryClientStateOwner(store).bindDirect(binding)
	expect(pending.submission.submissionId).toBe(unbound.submissionId)
	expect(pending.submission.payload).toEqual({ text: "before binding", images: [image] })
})
