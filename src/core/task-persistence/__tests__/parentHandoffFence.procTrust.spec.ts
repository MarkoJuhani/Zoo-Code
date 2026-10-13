// A /proc view from another pid namespace (e.g. `unshare -p` without `--mount-proc`) must not be used
// as exit evidence: only ESRCH may prove an exit there.
import * as crypto from "crypto"
import type * as fsModule from "fs"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

const proc = vi.hoisted(() => ({ mode: "enoent" as "enoent" | "other-start" }))

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof fsModule>()
	const readFileSync = (...args: Parameters<typeof actual.readFileSync>) => {
		const [file] = args
		if (file === "/proc/self/stat") {
			// This process's own pid is NOT first: the mounted /proc belongs to another pid namespace.
			return `${process.pid + 100_000} (node) S ${"0 ".repeat(18)}424242 0 0`
		}
		if (typeof file === "string" && /^\/proc\/[0-9]+\/stat$/.test(file)) {
			if (proc.mode === "enoent") throw Object.assign(new Error("no such pid in this /proc"), { code: "ENOENT" })
			return `${file.split("/")[2]} (other) S ${"0 ".repeat(18)}999 0 0`
		}
		return actual.readFileSync(...args)
	}
	return { ...actual, readFileSync, default: { ...actual, readFileSync } }
})

import { ParentHandoffFence } from "../parentHandoffFence"

const keyFor = (id: string) => crypto.createHash("sha256").update(id).digest("hex")
let root: string

beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "fence-proc-trust-")))
})

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true })
})

async function forgeHolder(id: string, patch: Record<string, unknown>) {
	const ownerPath = path.join(root, ".handoff-fences", `${keyFor(id)}.lock`, "owner.json")
	const owner = JSON.parse(await fs.readFile(ownerPath, "utf8"))
	await fs.writeFile(ownerPath, JSON.stringify({ ...owner, holder: { ...owner.holder, ...patch } }))
	return owner
}

describe.runIf(process.platform === "linux")("ParentHandoffFence with an untrusted /proc view", () => {
	it("records no /proc start time when /proc/self/stat is not this process", async () => {
		const id = "untrusted-record"
		await new ParentHandoffFence(root).acquire(id)
		const owner = JSON.parse(
			await fs.readFile(path.join(root, ".handoff-fences", `${keyFor(id)}.lock`, "owner.json"), "utf8"),
		)
		expect(owner.holder.pid).toBe(process.pid)
		expect(owner.holder.startTime).toBeUndefined()
		expect(owner.holder.bootId).toBeUndefined()
	})

	it.each(["enoent", "other-start"] as const)(
		"refuses a live pid even when the foreign /proc reports %s",
		async (mode) => {
			proc.mode = mode
			const id = `untrusted-${mode}`
			const lease = await new ParentHandoffFence(root).acquire(id)
			const self = (
				await forgeHolder(id, {
					bootId: (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
					startTime: "123",
				})
			).holder
			// This boot's real id and a start time, as a trusted holder would record them; this pid is alive (us).
			expect(self.pid).toBe(process.pid)
			await expect(new ParentHandoffFence(root).acquire(id, { timeoutMs: 0 })).rejects.toMatchObject({
				reason: "timeout",
			})
			await lease.assertOwned()
		},
	)

	it("still takes over on ESRCH", async () => {
		const id = "untrusted-esrch"
		await new ParentHandoffFence(root).acquire(id)
		const { spawn } = await import("child_process")
		const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" })
		await new Promise((resolve) => child.once("exit", resolve))
		await forgeHolder(id, { pid: child.pid })
		const lease = await new ParentHandoffFence(root).acquire(id, { timeoutMs: 0 })
		await lease.release()
	})
})
