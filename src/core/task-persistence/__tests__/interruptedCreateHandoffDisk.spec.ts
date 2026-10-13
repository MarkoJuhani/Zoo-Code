import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { once } from "node:events"

import {
	collectInterruptedCreateHandoff,
	issueSyntheticActionBinding,
	rejectUnfencedRecoveryMutation,
} from "../interruptedCreateHandoffDisk"
import { ParentHandoffFence, ParentHandoffFenceUnavailableError } from "../parentHandoffFence"

let base: string
const task = (id: string) => path.join(base, "tasks", id)
const save = async (id: string, name: string, value: unknown) => {
	await fs.mkdir(task(id), { recursive: true })
	await fs.writeFile(path.join(task(id), name), JSON.stringify(value))
}
const root = { id: "root", number: 1, ts: 1, task: "root", status: "active" }
const parent = {
	id: "parent",
	parentTaskId: "root",
	rootTaskId: "root",
	number: 2,
	ts: 2,
	task: "parent",
	status: "interrupted",
	pendingAction: { kind: "create_subtask", actionId: "action", message: "child" },
}
const history = [{ role: "assistant", content: [{ type: "tool_use", id: "action", name: "new_task", input: {} }] }]

beforeEach(async () => {
	base = await fs.mkdtemp(path.join(os.tmpdir(), "p2-disk-"))
	await save("root", "history_item.json", root)
	await save("parent", "history_item.json", parent)
	await save("parent", "api_conversation_history.json", history)
})
afterEach(async () => {
	await fs.rm(base, { recursive: true, force: true })
})

describe("strict persisted P2 evidence", () => {
	it("issues and reads back a stable host binding without trusting a cached caller", async () => {
		const binding = await issueSyntheticActionBinding(base, "parent", "action")
		expect(binding).toMatchObject({ parentLineage: ["root", "parent"], actionGeneration: 1 })
		expect(await issueSyntheticActionBinding(base, "parent", "action")).toEqual(binding)
		const snapshot = await collectInterruptedCreateHandoff(base, "parent", "action")
		expect(snapshot.evidence.writerInventoryComplete).toBe(false)
		expect(snapshot.evidence.liveOwner).toBe("unknown")
		await save("parent", "history_item.json", {
			...parent,
			pendingAction: { ...parent.pendingAction, message: "changed" },
		})
		await expect(issueSyntheticActionBinding(base, "parent", "action")).rejects.toThrow("binding conflict")
	})
	it("rejects missing or corrupt API files without inventing empty history", async () => {
		await fs.rm(path.join(task("parent"), "api_conversation_history.json"))
		expect((await collectInterruptedCreateHandoff(base, "parent", "action")).evidence.apiMessages.kind).toBe(
			"missing",
		)
		await expect(issueSyntheticActionBinding(base, "parent", "action")).rejects.toThrow(
			"binding evidence unavailable",
		)
		await fs.writeFile(path.join(task("parent"), "api_conversation_history.json"), "invalid")
		expect((await collectInterruptedCreateHandoff(base, "parent", "action")).evidence.apiMessages.kind).toBe(
			"read_error",
		)
	})
	it("blocks missing child metadata, child registry mismatch, and an intent", async () => {
		await fs.mkdir(task("transient"))
		let evidence = (await collectInterruptedCreateHandoff(base, "parent", "action")).evidence
		expect(evidence.transientChildren).toMatchObject([{ taskId: "transient", attribution: "ambiguous" }])
		await expect(issueSyntheticActionBinding(base, "parent", "action")).rejects.toThrow(
			"binding evidence unavailable",
		)
		await fs.rm(task("transient"), { recursive: true })
		await save("parent", "history_item.json", { ...parent, childIds: ["missing-child"] })
		evidence = (await collectInterruptedCreateHandoff(base, "parent", "action")).evidence
		expect(evidence.childRegistryComplete).toBe(false)
		await save("parent", "history_item.json", parent)
		await save("root", "_delegation_repair_intent.json", { version: 1, parentTaskId: "parent" })
		expect((await collectInterruptedCreateHandoff(base, "parent", "action")).evidence.childRegistryComplete).toBe(
			false,
		)
	})
	it("reads the full lineage and fails closed on stale cache or a changed disk action", async () => {
		const cached = structuredClone(parent)
		await save("parent", "history_item.json", {
			...parent,
			pendingAction: { ...parent.pendingAction, actionId: "other" },
		})
		expect(cached.pendingAction.actionId).toBe("action")
		await expect(issueSyntheticActionBinding(base, "parent", "action")).rejects.toThrow(
			"binding evidence unavailable",
		)
		await save("parent", "history_item.json", { ...parent, rootTaskId: "wrong" })
		expect((await collectInterruptedCreateHandoff(base, "parent", "action")).evidence.root.kind).toBe("read_error")
	})
	it("validates a persisted intermediate ancestor against the resolved root", async () => {
		await save("middle", "history_item.json", {
			id: "middle",
			parentTaskId: "root",
			rootTaskId: "wrong",
			status: "active",
		})
		await save("parent", "history_item.json", { ...parent, parentTaskId: "middle" })
		const snapshot = await collectInterruptedCreateHandoff(base, "parent", "action")
		expect(snapshot.parentLineage).toEqual(["root", "middle", "parent"])
		expect(snapshot.evidence.root.kind).toBe("read_error")
		await expect(issueSyntheticActionBinding(base, "parent", "action")).rejects.toThrow(
			"binding evidence unavailable",
		)
	})
	it("blocks a committed child with no provable action attribution", async () => {
		await save("child", "history_item.json", {
			id: "child",
			parentTaskId: "parent",
			rootTaskId: "root",
			status: "active",
		})
		const evidence = (await collectInterruptedCreateHandoff(base, "parent", "action")).evidence
		expect(evidence.children).toMatchObject([{ attribution: "ambiguous" }])
		await expect(issueSyntheticActionBinding(base, "parent", "action")).rejects.toThrow(
			"binding evidence unavailable",
		)
	})
	it("rejects unfenced recovery mutation and a symlinked task directory", async () => {
		await expect(rejectUnfencedRecoveryMutation()).rejects.toThrow("atomic_fenced_writer_unavailable")
		await fs.symlink(task("parent"), task("symlink"))
		const evidence = (await collectInterruptedCreateHandoff(base, "parent", "action")).evidence
		expect(evidence.childRegistryComplete).toBe(false)
		await expect(issueSyntheticActionBinding(base, "parent", "action")).rejects.toThrow(
			"binding evidence unavailable",
		)
	})
	it("detects a replaced owner without deleting the replacement on stale release", async () => {
		const first = await new ParentHandoffFence(base).acquire("parent")
		const key = (await import("node:crypto")).createHash("sha256").update("parent").digest("hex")
		await fs.rm(path.join(base, ".handoff-fences", `${key}.lock`), { recursive: true })
		const second = await new ParentHandoffFence(base).acquire("parent")
		await expect(first.assertOwned()).rejects.toThrow()
		await expect(first.release()).rejects.toThrow()
		await second.assertOwned()
		await second.release()
	})
	it("leaves an invalid generation and ownership lock blocked for explicit reconciliation", async () => {
		const first = await new ParentHandoffFence(base).acquire("parent")
		await first.release()
		const key = (await import("node:crypto")).createHash("sha256").update("parent").digest("hex")
		const generationPath = path.join(base, ".handoff-fences", `${key}.generation`)
		await fs.writeFile(generationPath, "")
		await expect(new ParentHandoffFence(base).acquire("parent")).rejects.toMatchObject({
			name: "ParentHandoffFenceUnavailableError",
			reason: "filesystem",
			diagnostic: "INVALID_GENERATION",
		})
		await expect(new ParentHandoffFence(base).acquire("parent", { timeoutMs: 5 })).rejects.toMatchObject({
			reason: "timeout",
		})
		expect(await fs.readFile(generationPath, "utf8")).toBe("")
		expect(await fs.readdir(path.join(base, ".handoff-fences", `${key}.lock`))).toEqual([])
	})
	it("does not allow another owner to issue a binding while a peer holds the parent fence", async () => {
		const first = await new ParentHandoffFence(base).acquire("parent")
		await expect(new ParentHandoffFence(base).acquire("parent", { timeoutMs: 5 })).rejects.toBeInstanceOf(
			ParentHandoffFenceUnavailableError,
		)
		await first.release()
	})
})

describe("separate-process parent fence", () => {
	it("refuses synthetic binding and recovery mutation outside the test runner without touching the parent", async () => {
		const { spawnSync } = await import("node:child_process")
		const { fileURLToPath } = await import("node:url")
		const modulePath = fileURLToPath(new URL("../interruptedCreateHandoffDisk.ts", import.meta.url))
		const original = await fs.readFile(path.join(task("parent"), "history_item.json"))
		const script = `import disk from ${JSON.stringify(modulePath)}; for (const call of [() => disk.issueSyntheticActionBinding(process.argv[1], 'parent', 'action'), () => disk.rejectUnfencedRecoveryMutation()]) { try { await call(); process.exitCode = 1; } catch (error) { process.stdout.write(error.message + '\\n'); } }`
		const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, base], {
			cwd: path.resolve(__dirname, "../../../"),
			env: { ...process.env, VITEST: "" },
			encoding: "utf8",
		})
		expect(child.status).toBe(0)
		expect(child.stdout.trim().split("\n")).toEqual([
			"fixture_binding_disabled_outside_tests",
			"atomic_fenced_writer_unavailable",
		])
		expect(await fs.readFile(path.join(task("parent"), "history_item.json"))).toEqual(original)
		await expect(fs.stat(path.join(task("parent"), "_recovery_binding_v1.json"))).rejects.toMatchObject({
			code: "ENOENT",
		})
	})
	it("admits only one of two simultaneous processes", async () => {
		const { spawn } = await import("node:child_process")
		const { fileURLToPath } = await import("node:url")
		const modulePath = fileURLToPath(new URL("../parentHandoffFence.ts", import.meta.url))
		const script = `import handoff from ${JSON.stringify(modulePath)}; try { const lease = await new handoff.ParentHandoffFence(process.argv[1]).acquire('parent', {timeoutMs: 150, retryIntervalMs: 5}); process.stdout.write('winner'); await new Promise(resolve => setTimeout(resolve, 400)); await lease.release(); } catch { process.stdout.write('blocked'); }`
		const run = () =>
			new Promise<string>((resolve, reject) => {
				const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, base], {
					cwd: path.resolve(__dirname, "../../../"),
					stdio: ["ignore", "pipe", "pipe"],
				})
				let result = ""
				child.stdout!.on("data", (data: Buffer) => {
					result += data.toString()
				})
				child.on("error", reject)
				child.on("exit", (status) => (status === 0 ? resolve(result) : reject(new Error("child failed"))))
			})
		expect((await Promise.all([run(), run()])).sort()).toEqual(["blocked", "winner"])
	})
	it("takes over a lock whose holder process exited, advancing the generation and moving the lock aside", async () => {
		const { spawn } = await import("node:child_process")
		const { fileURLToPath } = await import("node:url")
		const modulePath = fileURLToPath(new URL("../parentHandoffFence.ts", import.meta.url))
		const script = `import handoff from ${JSON.stringify(modulePath)}; const lease = await new handoff.ParentHandoffFence(process.argv[1]).acquire('parent'); process.stdout.write(JSON.stringify({ token: lease.ownerToken, generation: lease.generation }) + '\\n');`
		const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, base], {
			cwd: path.resolve(__dirname, "../../../"),
			stdio: ["ignore", "pipe", "pipe"],
		})
		try {
			const [data] = (await Promise.race([
				once(child.stdout!, "data"),
				once(child, "exit").then(([exit]) => {
					throw new Error(`child exited ${exit}`)
				}),
				new Promise((_, reject) => setTimeout(() => reject(new Error("process did not acquire")), 10_000)),
			])) as [Buffer]
			const dead = JSON.parse(data.toString().split("\n")[0]) as { token: string; generation: number }
			await once(child, "exit")
			const key = (await import("node:crypto")).createHash("sha256").update("parent").digest("hex")
			const fences = path.join(base, ".handoff-fences")
			expect(
				JSON.parse(await fs.readFile(path.join(fences, `${key}.lock`, "owner.json"), "utf8")).holder,
			).toMatchObject({ pid: child.pid })

			const lease = await new ParentHandoffFence(base).acquire("parent", { timeoutMs: 10 })

			expect(lease.generation).toBe(dead.generation + 2)
			const moved = (await fs.readdir(fences)).filter((name) => name.startsWith(`${key}.lock.exited-`))
			expect(moved).toHaveLength(1)
			expect(JSON.parse(await fs.readFile(path.join(fences, moved[0], "owner.json"), "utf8"))).toMatchObject({
				ownerToken: dead.token,
				generation: dead.generation,
			})
			await lease.release()
		} finally {
			child.kill()
		}
	})
})
