import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { safeWriteJson } from "../../../utils/safeWriteJson"
import { observeManualSupersedeB1Readback } from "../manualSupersedeB1Readback"
import { b1Fixture } from "./manualSupersedeB1.fixture"

const faults = vi.hoisted(() => ({ rename: vi.fn(), readFile: vi.fn() }))
vi.mock("fs/promises", async (importOriginal) => ({
	...(await importOriginal<typeof import("fs/promises")>()),
	rename: faults.rename,
	readFile: faults.readFile,
}))

describe("B1 read-only strict temporary-disk fault/restart prerequisite", () => {
	let storage: string
	beforeEach(async () => {
		const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
		faults.rename.mockReset().mockImplementation(actual.rename)
		faults.readFile.mockReset().mockImplementation(actual.readFile)
		storage = await fs.mkdtemp(path.join(os.tmpdir(), "b1-readback-"))
	})
	afterEach(async () => {
		await fs.rm(storage, { recursive: true, force: true })
	})

	it.each(["success", "commit_then_error", "no_commit"])(
		"observes %s without retry or readiness",
		async (scenario) => {
			const { input, history } = b1Fixture()
			const file = path.join(storage, "api.json")
			await fs.writeFile(file, JSON.stringify(history.slice(0, 2)))
			const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
			faults.rename.mockImplementation(async (from: string, to: string) => {
				if (to === file && from.includes(".new_")) {
					if (scenario === "no_commit") throw new Error("before commit")
					await actual.rename(from, to)
					if (scenario === "commit_then_error") throw new Error("after actual rename")
					return
				}
				return actual.rename(from, to)
			})
			// This is the ordinary real writer establishing fault evidence, NOT a B1 conditional append.
			const write = safeWriteJson(file, history)
			if (scenario === "success") await write
			else await expect(write).rejects.toThrow(scenario === "no_commit" ? "before commit" : "after actual rename")
			const observation = await observeManualSupersedeB1Readback(file, input)
			expect(observation).toMatchObject({
				disposition: "unknown",
				ready: false,
				writeAuthorized: false,
				retryAuthorized: false,
			})
			// Ordinary safeWriteJson restores its backup even when the injected rename actually committed.
			expect(observation.record).toBe(scenario === "success" ? "one_matching_proposed_result" : "no_result")
			const restarted = await observeManualSupersedeB1Readback(file, input)
			expect(restarted.record).toBe(observation.record)
			expect(
				JSON.stringify(await actual.readFile(file, "utf8")).match(/zoo.manual_supersede.B1.v1:/g)?.length ?? 0,
			).toBe(scenario === "success" ? 1 : 0)
		},
	)

	it("actual disk rename then exception remains committed for strict restart observation", async () => {
		const { input, history } = b1Fixture()
		const file = path.join(storage, "api.json")
		const temporary = path.join(storage, "candidate.json")
		await fs.writeFile(file, JSON.stringify(history.slice(0, 2)))
		await fs.writeFile(temporary, JSON.stringify(history))
		const renameThenThrow = async () => {
			await fs.rename(temporary, file)
			throw new Error("committed then error")
		}
		await expect(renameThenThrow()).rejects.toThrow("committed then error")
		expect(await observeManualSupersedeB1Readback(file, input)).toMatchObject({
			disposition: "unknown",
			record: "one_matching_proposed_result",
			retryAuthorized: false,
			ready: false,
		})
		expect(await observeManualSupersedeB1Readback(file, input)).toMatchObject({
			record: "one_matching_proposed_result",
			ready: false,
		})
	})

	it("failed first reread blocks even if later restart sees the record", async () => {
		const { input, history } = b1Fixture()
		const file = path.join(storage, "api.json")
		await safeWriteJson(file, history)
		faults.readFile.mockRejectedValueOnce(new Error("failed first reread"))
		const first = await observeManualSupersedeB1Readback(file, input)
		expect(first).toMatchObject({ disposition: "blocked", retryAuthorized: false, ready: false })
		expect((await observeManualSupersedeB1Readback(file, input)).record).toBe("one_matching_proposed_result")
		expect(first.disposition).toBe("blocked")
	})

	it.each(["missing", "corrupt", "duplicate", "symlink"])("fails closed for %s", async (scenario) => {
		const { input, history } = b1Fixture()
		const file = path.join(storage, "api.json")
		if (scenario === "corrupt") await fs.writeFile(file, "not JSON")
		if (scenario === "duplicate") await safeWriteJson(file, [...history, history[2]])
		if (scenario === "symlink") {
			const other = path.join(storage, "other.json")
			await fs.writeFile(other, JSON.stringify(history))
			await fs.symlink(other, file)
		}
		expect(await observeManualSupersedeB1Readback(file, input)).toMatchObject({
			disposition: "blocked",
			retryAuthorized: false,
			ready: false,
		})
	})
})
