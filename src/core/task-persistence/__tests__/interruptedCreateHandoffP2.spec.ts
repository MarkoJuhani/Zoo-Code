import * as crypto from "crypto"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { HistoryItem } from "@roo-code/types"

// Keep real disposable-disk operations, with configurable exports for path-scoped faults.
vi.mock("fs/promises", async (importOriginal) => ({ ...(await importOriginal<typeof fs>()) }))

import {
	evaluateInterruptedCreateHandoffEligibility,
	type InterruptedCreateHandoffEvidence,
} from "../interruptedCreateHandoffEligibility"
import {
	ParentHandoffFence,
	ParentHandoffFenceOwnershipError,
	ParentHandoffFenceUnavailableError,
} from "../parentHandoffFence"

const parentTaskId = "parent"
const rootTaskId = "root"
const actionId = "action"

function historyItem(overrides: Partial<HistoryItem>): HistoryItem {
	return {
		id: "task",
		number: 1,
		ts: 1,
		task: "task",
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		...overrides,
	}
}

function fixture(): InterruptedCreateHandoffEvidence {
	return {
		parentTaskId,
		rootTaskId,
		actionId,
		parent: {
			kind: "found",
			value: historyItem({
				id: parentTaskId,
				rootTaskId,
				parentTaskId: rootTaskId,
				status: "interrupted",
				childIds: ["earlier-child"],
				pendingAction: {
					kind: "create_subtask",
					actionId,
					approvalText: "new task",
					mode: "ask",
					message: "child",
					todos: [],
				},
			}),
		},
		root: { kind: "found", value: historyItem({ id: rootTaskId, rootTaskId, status: "active" }) },
		apiMessages: {
			kind: "found",
			value: [
				{
					role: "assistant",
					content: [{ type: "tool_use", id: actionId, name: "new_task", input: {} }],
				},
			],
		},
		children: [
			{
				metadata: historyItem({
					id: "earlier-child",
					rootTaskId,
					parentTaskId,
					status: "completed",
				}),
				attribution: "historical_other_action",
			},
		],
		transientChildren: [],
		childRegistryComplete: true,
		writerInventoryComplete: true,
		liveOwner: "absent",
	}
}

describe("interrupted create-subtask P2 eligibility", () => {
	it("accepts an exact terminal call with a separately attributed earlier child", () => {
		expect(evaluateInterruptedCreateHandoffEligibility(fixture())).toEqual({ kind: "eligible", resume: "fresh" })
	})

	it.each([
		["writer inventory", { writerInventoryComplete: false }, "writer_inventory_incomplete"],
		["live owner", { liveOwner: "present" }, "live_owner_present"],
		["unknown owner", { liveOwner: "unknown" }, "live_owner_unknown"],
		["incomplete children", { childRegistryComplete: false }, "child_registry_incomplete"],
	] as const)("fails closed for %s", (_label, change, reason) => {
		expect(evaluateInterruptedCreateHandoffEligibility({ ...fixture(), ...change })).toEqual({
			kind: "blocked",
			reason,
		})
	})

	it("does not mutate metadata when a transient directory has no readable metadata", () => {
		const evidence = fixture()
		evidence.transientChildren.push({
			taskId: "transient",
			metadata: { kind: "missing" },
			attribution: "ambiguous",
		})
		const before = JSON.stringify(evidence)
		expect(evaluateInterruptedCreateHandoffEligibility(evidence)).toEqual({
			kind: "blocked",
			reason: "transient_child_ambiguous",
		})
		expect(JSON.stringify(evidence)).toBe(before)
	})

	it("blocks a child attributed to the pending action", () => {
		const evidence = fixture()
		evidence.children.push({
			metadata: historyItem({ id: "new-child", rootTaskId, parentTaskId, status: "active" }),
			attribution: "matching_action",
		})
		expect(evaluateInterruptedCreateHandoffEligibility(evidence)).toEqual({
			kind: "blocked",
			reason: "child_for_action_exists",
		})
	})

	it("blocks stale evidence after the authoritative action was superseded", () => {
		const evidence = fixture()
		if (evidence.parent.kind !== "found") throw new Error("fixture parent missing")
		evidence.parent.value.pendingAction = {
			...evidence.parent.value.pendingAction!,
			actionId: "replacement-action",
		}
		expect(evaluateInterruptedCreateHandoffEligibility(evidence)).toEqual({
			kind: "blocked",
			reason: "pending_action_mismatch",
		})
	})

	it("distinguishes an uncorrelated persisted error from an eligible fresh call", () => {
		const evidence = fixture()
		evidence.apiMessages = {
			kind: "found",
			value: [
				...(evidence.apiMessages.kind === "found" ? evidence.apiMessages.value : []),
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: actionId, is_error: true, content: "failed" }],
				},
			],
		}
		expect(evaluateInterruptedCreateHandoffEligibility(evidence)).toEqual({
			kind: "blocked",
			reason: "matching_error_uncorrelated",
		})
		evidence.matchingErrorCorrelated = true
		expect(evaluateInterruptedCreateHandoffEligibility(evidence)).toEqual({
			kind: "eligible",
			resume: "matching_error",
		})
	})

	it("blocks a matching success result", () => {
		const evidence = fixture()
		evidence.apiMessages = {
			kind: "found",
			value: [
				...(evidence.apiMessages.kind === "found" ? evidence.apiMessages.value : []),
				{ role: "user", content: [{ type: "tool_result", tool_use_id: actionId, content: "ok" }] },
			],
		}
		expect(evaluateInterruptedCreateHandoffEligibility(evidence)).toEqual({
			kind: "blocked",
			reason: "matching_success_result",
		})
	})
})

describe("ParentHandoffFence", () => {
	let temporaryDirectory: string

	beforeEach(async () => {
		temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "handoff-fence-"))
	})

	afterEach(async () => {
		await fs.rm(temporaryDirectory, { recursive: true, force: true })
	})

	function fencePaths(id: string) {
		const key = crypto.createHash("sha256").update(id).digest("hex")
		const root = path.join(temporaryDirectory, ".handoff-fences")
		return {
			generation: path.join(root, `${key}.generation`),
			lock: path.join(root, `${key}.lock`),
			owner: path.join(root, `${key}.lock`, "owner.json"),
		}
	}

	async function evidenceBytes(): Promise<Record<string, string>> {
		const root = path.join(temporaryDirectory, ".handoff-fences")
		const bytes: Record<string, string> = {}
		for (const entry of await fs.readdir(root, { withFileTypes: true })) {
			const file = path.join(root, entry.name)
			if (entry.isDirectory()) {
				bytes[entry.name] = "directory"
				for (const child of await fs.readdir(file)) {
					bytes[`${entry.name}/${child}`] = (await fs.readFile(path.join(file, child))).toString("hex")
				}
			} else bytes[entry.name] = (await fs.readFile(file)).toString("hex")
		}
		return bytes
	}

	async function expectFilesystemRefusal(attempt: Promise<unknown>, code?: string) {
		await expect(attempt).rejects.toBeInstanceOf(ParentHandoffFenceUnavailableError)
		await expect(attempt).rejects.toMatchObject({ reason: "filesystem", filesystemCode: code })
		await expect(attempt).rejects.not.toThrow(temporaryDirectory)
	}

	it.each(["generation-read", "generation-write", "owner-write"] as const)(
		"retains uncertain evidence after %s bootstrap failure",
		async (phase) => {
			const other = await new ParentHandoffFence(temporaryDirectory).acquire("unrelated")
			const otherOwner = await fs.readFile(fencePaths("unrelated").owner)
			const locations = fencePaths(parentTaskId)
			await fs.writeFile(locations.generation, "7")
			const error = Object.assign(new Error(`injected EIO at ${temporaryDirectory}`), { code: "EIO" })
			const rename = fs.rename
			const fault =
				phase === "generation-read"
					? vi.spyOn(fs, "readFile").mockRejectedValueOnce(error)
					: vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
							if (
								String(destination) ===
								(phase === "generation-write" ? locations.generation : locations.owner)
							) {
								throw error
							}
							await rename(source, destination)
						})
			try {
				await expectFilesystemRefusal(new ParentHandoffFence(temporaryDirectory).acquire(parentTaskId), "EIO")
			} finally {
				fault.mockRestore()
			}
			const retained = await evidenceBytes()
			expect((await fs.stat(locations.lock)).isDirectory()).toBe(true)
			expect(await fs.readFile(locations.generation, "utf8")).toBe(phase === "owner-write" ? "8" : "7")
			await expect(fs.readFile(locations.owner)).rejects.toMatchObject({ code: "ENOENT" })
			const temporaryFiles = Object.keys(retained).filter((name) => name.endsWith(".tmp"))
			expect(temporaryFiles).toHaveLength(phase === "generation-read" ? 0 : 1)
			if (phase === "generation-write")
				expect(Buffer.from(retained[temporaryFiles[0]], "hex").toString()).toBe("8")
			if (phase === "owner-write") {
				expect(JSON.parse(Buffer.from(retained[temporaryFiles[0]], "hex").toString())).toMatchObject({
					parentTaskId,
					generation: 8,
					schemaVersion: 1,
				})
			}
			await expect(
				new ParentHandoffFence(temporaryDirectory).acquire(parentTaskId, { timeoutMs: 0 }),
			).rejects.toMatchObject({ reason: "timeout" })
			expect(await evidenceBytes()).toEqual(retained)
			await other.assertOwned()
			expect(await fs.readFile(fencePaths("unrelated").owner)).toEqual(otherOwner)
			await other.release()
		},
	)

	it.each(["invalid", "-1", "1\n", String(Number.MAX_SAFE_INTEGER), "9007199254740992"])(
		"retains malformed or exhausted generation evidence (%s)",
		async (generation) => {
			const other = await new ParentHandoffFence(temporaryDirectory).acquire("unrelated")
			const locations = fencePaths(parentTaskId)
			await fs.writeFile(locations.generation, generation)
			await expectFilesystemRefusal(new ParentHandoffFence(temporaryDirectory).acquire(parentTaskId))
			const retained = await evidenceBytes()
			expect(await fs.readFile(locations.generation, "utf8")).toBe(generation)
			expect(await fs.readdir(locations.lock)).toEqual([])
			await expect(
				new ParentHandoffFence(temporaryDirectory).acquire(parentTaskId, { timeoutMs: 0 }),
			).rejects.toMatchObject({ reason: "timeout" })
			expect(await evidenceBytes()).toEqual(retained)
			await other.assertOwned()
			await other.release()
		},
	)

	it("releases, retaining owned evidence aside and another holder, after release cleanup failure", async () => {
		const lease = await new ParentHandoffFence(temporaryDirectory).acquire(parentTaskId)
		const other = await new ParentHandoffFence(temporaryDirectory).acquire("unrelated")
		const lockName = path.basename(fencePaths(parentTaskId).lock)
		const before = await evidenceBytes()
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
		const fault = vi
			.spyOn(fs, "rm")
			.mockRejectedValueOnce(Object.assign(new Error(`injected EIO at ${temporaryDirectory}`), { code: "EIO" }))
		let result: Awaited<ReturnType<typeof lease.release>>
		try {
			// Cleanup failure is a report, not a refusal: the lock is released (never reinstalled).
			result = await lease.release()
		} finally {
			fault.mockRestore()
		}
		expect(result).toMatchObject({ cleanup: "retained", code: "EIO" })
		if (result.cleanup !== "retained") throw new Error("expected retained cleanup")
		expect(JSON.stringify(result)).not.toContain(temporaryDirectory)
		expect(warn).toHaveBeenCalledTimes(1)
		const after = await evidenceBytes()
		// The owned instance is retained byte-for-byte under its released name; nothing else changed.
		const renamed = Object.fromEntries(
			Object.entries(before).map(([name, bytes]) => [
				name === lockName || name.startsWith(`${lockName}/`)
					? result.retainedName + name.slice(lockName.length)
					: name,
				bytes,
			]),
		)
		expect(after).toEqual(renamed)
		await expect(lease.assertOwned()).rejects.toBeInstanceOf(ParentHandoffFenceOwnershipError)
		await other.assertOwned()
		const next = await new ParentHandoffFence(temporaryDirectory).acquire(parentTaskId, { timeoutMs: 0 })
		expect(next.generation).toBe(lease.generation + 1)
		await next.release()
		expect((await evidenceBytes())[`${result.retainedName}/owner.json`]).toBe(before[`${lockName}/owner.json`])
		await other.assertOwned()
		await other.release()
	})

	it("allows only one host to own a parent and advances generation after release", async () => {
		const firstHost = new ParentHandoffFence(temporaryDirectory)
		const secondHost = new ParentHandoffFence(temporaryDirectory)
		const firstLease = await firstHost.acquire(parentTaskId)
		await expect(secondHost.acquire(parentTaskId, { timeoutMs: 20, retryIntervalMs: 2 })).rejects.toBeInstanceOf(
			ParentHandoffFenceUnavailableError,
		)
		await expect(secondHost.acquire(parentTaskId, { timeoutMs: 0 })).rejects.toMatchObject({ reason: "timeout" })
		await firstLease.assertOwned()
		await firstLease.release()
		const secondLease = await secondHost.acquire(parentTaskId)
		expect(secondLease.generation).toBe(firstLease.generation + 1)
		await secondLease.release()
	})

	it("selects exactly one owner when two hosts acquire concurrently", async () => {
		const options = { timeoutMs: 20, retryIntervalMs: 2 }
		const attempts = await Promise.allSettled([
			new ParentHandoffFence(temporaryDirectory).acquire(parentTaskId, options),
			new ParentHandoffFence(temporaryDirectory).acquire(parentTaskId, options),
		])
		const winners = attempts.filter((attempt) => attempt.status === "fulfilled")
		const blocked = attempts.filter((attempt) => attempt.status === "rejected")
		expect(winners).toHaveLength(1)
		expect(blocked).toHaveLength(1)
		expect((blocked[0] as PromiseRejectedResult).reason).toBeInstanceOf(ParentHandoffFenceUnavailableError)
		await (winners[0] as PromiseFulfilledResult<Awaited<ReturnType<ParentHandoffFence["acquire"]>>>).value.release()
	})

	it("does not steal an abandoned or long-held fence", async () => {
		const firstLease = await new ParentHandoffFence(temporaryDirectory).acquire(parentTaskId)
		await expect(
			new ParentHandoffFence(temporaryDirectory).acquire(parentTaskId, { timeoutMs: 20, retryIntervalMs: 2 }),
		).rejects.toBeInstanceOf(ParentHandoffFenceUnavailableError)
		await firstLease.release()
	})

	it("reports filesystem refusal without revealing its path or treating it as a stale lease", async () => {
		await fs.writeFile(path.join(temporaryDirectory, ".handoff-fences"), "not a directory")
		const fence = new ParentHandoffFence(temporaryDirectory)
		await expect(fence.acquire(parentTaskId, { timeoutMs: 0 })).rejects.toMatchObject({
			reason: "filesystem",
			filesystemCode: "EEXIST",
		})
		expect(await fs.readFile(path.join(temporaryDirectory, ".handoff-fences"), "utf8")).toBe("not a directory")
	})

	it("detects stale ownership and cannot release a replacement owner's fence", async () => {
		const firstFence = new ParentHandoffFence(temporaryDirectory)
		const firstLease = await firstFence.acquire(parentTaskId)
		await fs.rm(path.join(temporaryDirectory, ".handoff-fences"), { recursive: true, force: true })
		const replacementLease = await new ParentHandoffFence(temporaryDirectory).acquire(parentTaskId)
		await expect(firstLease.assertOwned()).rejects.toBeInstanceOf(ParentHandoffFenceOwnershipError)
		await expect(firstLease.release()).rejects.toBeInstanceOf(ParentHandoffFenceOwnershipError)
		await expect(
			new ParentHandoffFence(temporaryDirectory).acquire(parentTaskId, { timeoutMs: 20, retryIntervalMs: 2 }),
		).rejects.toBeInstanceOf(ParentHandoffFenceUnavailableError)
		await replacementLease.release()
	})
})
