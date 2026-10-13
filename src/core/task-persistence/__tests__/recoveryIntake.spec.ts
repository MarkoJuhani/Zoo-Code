import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
	RECOVERY_INTAKE_KIND,
	type AcceptedRecoverySubmission,
	type RecoveryBinding,
	type RecoverySubmission,
} from "../../../shared/recoveryIntake"
import { MessageQueueService } from "../../message-queue/MessageQueueService"
import {
	acceptRecoverySubmission,
	adoptQueuedRecoverySubmission,
	rehydrateRecoveryIntake,
	type RecoveryIntakeStore,
} from "../recoveryIntake"

const binding: RecoveryBinding = {
	parentTaskId: "parent",
	rootTaskId: "root",
	parentLineage: ["root"],
	actionId: "call",
	actionGeneration: 1,
}
const image = "data:image/png;base64,AAECAw=="
function submission(text = "private message", images: string[] = []): RecoverySubmission {
	return {
		binding: structuredClone(binding),
		submissionId: "submission",
		origin: "direct",
		timestamp: 123,
		payload: { text, images },
	}
}

/** TEST ONLY: inline single-record disk fixture, not secure blobs, sync or an interprocess fence. */
function diskFixture(directory: string) {
	const file = join(directory, "accepted.json")
	const events: string[] = []
	const read = async (): Promise<AcceptedRecoverySubmission | undefined> => {
		try {
			return JSON.parse(await readFile(file, "utf8"))
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
			throw error
		}
	}
	const store: RecoveryIntakeStore = {
		withParentFence: async (_binding, operation) => {
			events.push("fence")
			return operation()
		},
		classify: async () => {
			events.push("classify")
			return { kind: RECOVERY_INTAKE_KIND, pendingQuestion: false }
		},
		writeOnce: async (record) => {
			events.push("write")
			const existing = await read()
			if (existing && JSON.stringify(existing) !== JSON.stringify(record)) throw new Error("conflict")
			if (!existing) await writeFile(file, JSON.stringify(record), { flag: "wx", mode: 0o600 })
		},
		read: async () => {
			events.push("read")
			return read()
		},
		list: async () => {
			const record = await read()
			return record ? [record] : []
		},
	}
	return { store, events, file }
}

let directory: string
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "zoo-p3-intake-"))
})
afterEach(async () => {
	await rm(directory, { recursive: true, force: true })
})

describe("P3 isolated intake candidate", () => {
	it.each([
		["text", []],
		["", [image]],
		["mixed", [image]],
	])("retains exact text/images across fixture restart: %s", async (text, images) => {
		const first = diskFixture(directory)
		const input = submission(text, images)
		const result = await acceptRecoverySubmission(first.store, input)
		expect(result.kind).toBe("accepted")
		expect(first.events).toEqual(["fence", "classify", "read", "write", "read"])
		const restarted = diskFixture(directory)
		expect(await rehydrateRecoveryIntake(restarted.store, binding)).toEqual([input])
		expect(await acceptRecoverySubmission(restarted.store, input)).toEqual(result)
		expect(restarted.events.filter((event) => event === "write")).toHaveLength(0)
	})

	it("reconciles a commit followed by an I/O error without a second acceptance", async () => {
		const fixture = diskFixture(directory)
		const original = fixture.store.writeOnce
		fixture.store.writeOnce = async (record) => {
			await original(record)
			throw new Error("private storage path")
		}
		expect(await acceptRecoverySubmission(fixture.store, submission())).toEqual({
			kind: "blocked",
			reason: "intake_unavailable",
		})
		const restarted = diskFixture(directory)
		expect((await acceptRecoverySubmission(restarted.store, submission())).kind).toBe("accepted")
		expect(restarted.events).not.toContain("write")
	})

	it.each(["write", "readback", "fence", "classify"])("emits no receipt on %s failure", async (stage) => {
		const fixture = diskFixture(directory)
		const fail = async (): Promise<never> => {
			throw new Error("private message " + image)
		}
		if (stage === "write") fixture.store.writeOnce = fail
		if (stage === "readback") {
			const read = fixture.store.read
			let count = 0
			fixture.store.read = async (...args) => (++count === 2 ? fail() : read(...args))
		}
		if (stage === "fence") fixture.store.withParentFence = fail
		if (stage === "classify") fixture.store.classify = fail
		expect(await acceptRecoverySubmission(fixture.store, submission())).toEqual({
			kind: "blocked",
			reason: "intake_unavailable",
		})
	})

	it.each(["ordinary", "question", "blocked"])("does not write or claim for %s classification", async (route) => {
		const fixture = diskFixture(directory)
		fixture.store.classify = async () => ({
			kind: route === "ordinary" ? "ordinary" : route === "blocked" ? "blocked" : RECOVERY_INTAKE_KIND,
			pendingQuestion: route === "question",
		})
		const result = await acceptRecoverySubmission(fixture.store, submission())
		expect(result.kind).toBe(route === "blocked" ? "blocked" : "not_recovery")
		expect(fixture.events).toEqual(["fence"])
	})

	it.each(["payload", "action", "parent", "root", "generation", "lineage", "origin", "timestamp", "id"])(
		"rejects changed %s ownership without overwriting",
		async (change) => {
			const fixture = diskFixture(directory)
			const input = submission("mixed", [image])
			await acceptRecoverySubmission(fixture.store, input)
			const original = await readFile(fixture.file, "utf8")
			const changed = structuredClone(input)
			if (change === "payload") changed.payload.text = "edited"
			if (change === "action") changed.binding.actionId = "superseding"
			if (change === "parent") changed.binding.parentTaskId = "other-parent"
			if (change === "root") changed.binding.rootTaskId = "other-root"
			if (change === "generation") changed.binding.actionGeneration++
			if (change === "lineage") changed.binding.parentLineage = ["other-parent"]
			if (change === "origin") changed.origin = "queued"
			if (change === "timestamp") changed.timestamp++
			if (change === "id") changed.submissionId = "second-owner"
			expect((await acceptRecoverySubmission(fixture.store, changed)).kind).toBe("blocked")
			expect(await readFile(fixture.file, "utf8")).toBe(original)
		},
	)

	it("adopts queue identity without claim/removal and leaves failures claimable", async () => {
		const queue = new MessageQueueService()
		const item = queue.addMessage("queued", [image])!
		const later = queue.addMessage("later")!
		const input = adoptQueuedRecoverySubmission(binding, item)
		const fixture = diskFixture(directory)
		fixture.store.writeOnce = async () => {
			throw new Error("disk")
		}
		expect((await acceptRecoverySubmission(fixture.store, input)).kind).toBe("blocked")
		expect(queue.messages).toEqual([item, later])
		expect(queue.claimNextMessage()?.id).toBe(item.id)
		queue.releaseMessage(item.id)
		const durable = diskFixture(directory)
		expect((await acceptRecoverySubmission(durable.store, input)).kind).toBe("accepted")
		expect(input.submissionId).toBe(item.id)
		expect(input.timestamp).toBe(item.timestamp)
		expect(queue.messages).toEqual([item, later])
		expect(await rehydrateRecoveryIntake(diskFixture(directory).store, binding)).toEqual([input])
		queue.dispose()
	})

	it("snapshots queued payload before asynchronous intake and catches later changed-ID reuse", async () => {
		const input = submission("original", [image])
		const fixture = diskFixture(directory)
		const accepted = acceptRecoverySubmission(fixture.store, input)
		input.payload.text = "edited"
		input.payload.images = []
		expect((await accepted).kind).toBe("accepted")
		expect((await rehydrateRecoveryIntake(fixture.store, binding))[0].payload).toEqual({
			text: "original",
			images: [image],
		})
		expect((await acceptRecoverySubmission(fixture.store, input)).kind).toBe("blocked")
	})

	it.each([
		"",
		"file:///private.png",
		"data:image/png;base64,???",
		"data:image/png;base64,AA",
		"data:image/svg+xml;base64,AA==",
	])("rejects empty or unresolved/invalid image %s", async (invalid) => {
		const fixture = diskFixture(directory)
		const input = invalid ? submission("", [invalid]) : submission("")
		expect(await acceptRecoverySubmission(fixture.store, input)).toEqual({
			kind: "blocked",
			reason: "intake_invalid",
		})
		expect(fixture.events).toEqual([])
	})

	it.each(["text", "count", "bytes", "encoded"])("enforces %s payload limits before storage", async (limit) => {
		const input = submission()
		if (limit === "text") input.payload.text = "ä".repeat(512 * 1024 + 1)
		if (limit === "count") input.payload.images = Array.from({ length: 11 }, () => image)
		if (limit === "bytes")
			input.payload.images = ["data:image/png;base64," + Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64")]
		if (limit === "encoded") {
			input.payload.text = "\0".repeat(1024 * 1024)
			input.payload.images = ["data:image/png;base64," + Buffer.alloc(8 * 1024 * 1024).toString("base64")]
		}
		const fixture = diskFixture(directory)
		expect(await acceptRecoverySubmission(fixture.store, input)).toEqual({
			kind: "blocked",
			reason: "intake_invalid",
		})
		expect(fixture.events).toEqual([])
	})

	it.each(["version", "digest", "blob", "multiple"])("fails closed rehydrating %s corruption", async (corruption) => {
		const fixture = diskFixture(directory)
		await acceptRecoverySubmission(fixture.store, submission("mixed", [image]))
		const record: AcceptedRecoverySubmission = JSON.parse(await readFile(fixture.file, "utf8"))
		if (corruption === "version") Object.assign(record, { schemaVersion: 2 })
		if (corruption === "digest") record.payloadDigest = createHash("sha256").update("wrong").digest("hex")
		if (corruption === "blob") record.submission.payload.images = []
		if (corruption === "multiple") fixture.store.list = async () => [record, record]
		else await writeFile(fixture.file, JSON.stringify(record))
		await expect(rehydrateRecoveryIntake(fixture.store, binding)).rejects.toThrow("intake_conflict")
	})
	it.each(["missing", "mismatch"])("never receipts %s authoritative read-back", async (failure) => {
		const fixture = diskFixture(directory)
		const original = fixture.store.read
		let count = 0
		fixture.store.read = async (...args) => {
			const record = await original(...args)
			if (++count < 2 || !record) return record
			if (failure === "missing") return undefined
			record.submission.payload.text = "changed on disk"
			return record
		}
		expect(await acceptRecoverySubmission(fixture.store, submission())).toEqual({
			kind: "blocked",
			reason: "intake_conflict",
		})
	})

	it("redacts corrupt storage and rehydration errors", async () => {
		const fixture = diskFixture(directory)
		await writeFile(fixture.file, "private payload invalid JSON")
		expect(await acceptRecoverySubmission(fixture.store, submission())).toEqual({
			kind: "blocked",
			reason: "intake_unavailable",
		})
		await expect(rehydrateRecoveryIntake(fixture.store, binding)).rejects.toThrow(/^intake_conflict$/)
	})
})
