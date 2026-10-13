// Startup with unavailable admission must still show persisted history, read-only, and say so.
import { createHash } from "crypto"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"

import type { HistoryItem } from "@roo-code/types"

import { TaskHistoryStartupDegradedError, TaskHistoryStore } from "../TaskHistoryStore"
import {
	ParentHandoffFence,
	ParentHandoffFenceUnavailableError,
	type AcquireParentHandoffFenceOptions,
} from "../parentHandoffFence"
import { HOST_PRESENCE_DIRECTORY } from "../hostPresence"
import { GlobalFileNames } from "../../../shared/globalFileNames"
import { ClineProvider } from "../../webview/ClineProvider"

// Echo key and interpolation so each message's evidence is observable (test i18n returns bare keys).
vi.mock("../../../i18n", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../i18n")>()),
	t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
}))

vi.mock("../../../utils/storage", () => ({
	getStorageBasePath: vi.fn().mockImplementation((defaultPath: string) => defaultPath),
}))

function item(overrides: Partial<HistoryItem> & { id: string }): HistoryItem {
	return { number: 1, ts: 1, task: overrides.id, tokensIn: 0, tokensOut: 0, totalCost: 0, ...overrides }
}

async function writeTask(storage: string, value: HistoryItem) {
	const directory = path.join(storage, "tasks", value.id)
	await fs.mkdir(directory, { recursive: true })
	await fs.writeFile(path.join(directory, GlobalFileNames.historyItem), JSON.stringify(value))
}

async function snapshot(directory: string): Promise<Record<string, string>> {
	const result: Record<string, string> = {}
	for (const entry of await fs.readdir(directory, { recursive: true, withFileTypes: true })) {
		const full = path.join(entry.parentPath, entry.name)
		result[path.relative(directory, full)] = entry.isFile() ? await fs.readFile(full, "utf8") : "<dir>"
	}
	return result
}

/**
 * Storage without host presence. A degraded store still runs tasks, so it publishes presence for
 * peers' startup repair; presence is not task state. Tests assert it separately.
 */
async function taskStateSnapshot(directory: string): Promise<Record<string, string>> {
	return Object.fromEntries(
		Object.entries(await snapshot(directory)).filter(
			([name]) => name !== HOST_PRESENCE_DIRECTORY && !name.startsWith(HOST_PRESENCE_DIRECTORY + path.sep),
		),
	)
}

async function expectOnlyOwnPresence(storage: string, store: TaskHistoryStore) {
	const token = store["hostPresence"]?.token
	expect(token).toBeDefined()
	expect(await fs.readdir(path.join(storage, HOST_PRESENCE_DIRECTORY))).toEqual([`${token}.json`])
}

async function readStatus(storage: string, id: string) {
	return JSON.parse(await fs.readFile(path.join(storage, "tasks", id, GlobalFileNames.historyItem), "utf8")).status
}

describe("TaskHistoryStore degraded startup", () => {
	let storage: string
	let store: TaskHistoryStore

	beforeEach(async () => {
		storage = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "history-degraded-")))
		await writeTask(storage, item({ id: "task-a", ts: 1000, status: "active" }))
		// Under admission this orphaned delegation is repaired to "active"; it is the write probe.
		await writeTask(storage, item({ id: "parent-d", ts: 2000, status: "delegated", awaitingChildId: "gone" }))
		store = new TaskHistoryStore(storage)
	})

	afterEach(async () => {
		store.dispose()
		await fs.rm(storage, { recursive: true, force: true })
	})

	it("control: with admission, startup repairs the orphaned delegation", async () => {
		await store.initialize()
		expect(await readStatus(storage, "parent-d")).toBe("active")
	})

	it("without admission, loads history read-only, skips repairs, and reports degraded state", async () => {
		// A regular file where the fence directory belongs makes admission refuse immediately (typed refusal).
		await fs.writeFile(path.join(storage, ".handoff-fences"), "blocker")
		const before = await taskStateSnapshot(storage)

		const failure = await store.initialize().then(
			() => undefined,
			(error: unknown) => error,
		)

		expect(failure).toBeInstanceOf(TaskHistoryStartupDegradedError)
		expect((failure as TaskHistoryStartupDegradedError).admissionError).toBeInstanceOf(
			ParentHandoffFenceUnavailableError,
		)
		await store.initialized
		expect(store.getAll().map((entry) => [entry.id, entry.status])).toEqual([
			["parent-d", "delegated"],
			["task-a", "active"],
		])
		expect(await taskStateSnapshot(storage)).toEqual(before)
		await expectOnlyOwnPresence(storage, store)
		await vi.waitFor(() => expect(store["fsWatcher"]).not.toBeNull())
		expect(store["reconcileTimer"]).not.toBeNull()

		// Read-only refresh still observes another writer.
		await writeTask(storage, item({ id: "task-b", ts: 3000 }))
		await store.reconcile()
		expect(store.get("task-b")).toBeDefined()
		expect(await readStatus(storage, "parent-d")).toBe("delegated")
	})

	it("degrades on a real startup-admission timeout held by a live owner, naming the lock", async () => {
		// A live holder in this process: never taken over, so admission times out.
		const holder = await new ParentHandoffFence(storage).acquire("\u0000startup-admission")
		// Test seam only: shorten the 30 s production wait; the fence logic itself is unchanged.
		const acquire = ParentHandoffFence.prototype.acquire
		vi.spyOn(ParentHandoffFence.prototype, "acquire").mockImplementation(function (
			this: ParentHandoffFence,
			id: string,
			options: AcquireParentHandoffFenceOptions = {},
		) {
			return acquire.call(this, id, { ...options, timeoutMs: Math.min(options.timeoutMs ?? 1_000, 50) })
		})
		const before = await taskStateSnapshot(storage)

		const failure = await store.initialize().then(
			() => undefined,
			(error: unknown) => error,
		)

		expect(failure).toBeInstanceOf(TaskHistoryStartupDegradedError)
		const degraded = failure as TaskHistoryStartupDegradedError
		expect(degraded.admissionError).toMatchObject({ reason: "timeout" })
		expect(degraded.fenceDirectory).toBe(path.join(storage, ".handoff-fences"))
		expect(degraded.generationPath).toBe(degraded.lockDirectory.replace(/\.lock$/, ".generation"))
		expect(degraded.lockDirectory).toBe(
			path.join(
				storage,
				".handoff-fences",
				`${createHash("sha256").update("\u0000startup-admission").digest("hex")}.lock`,
			),
		)
		expect(store.getAll().map((entry) => entry.id)).toEqual(["parent-d", "task-a"])
		expect(await taskStateSnapshot(storage)).toEqual(before)
		await expectOnlyOwnPresence(storage, store)
		await holder.assertOwned()
		vi.restoreAllMocks()
		await holder.release()
	})

	it("a fence refusal INSIDE admitted startup is not converted to degraded mode", async () => {
		const inner = new ParentHandoffFenceUnavailableError("parent-d", "timeout")
		vi.spyOn(store, "reconcile").mockRejectedValueOnce(inner)
		const failure = await store.initialize().then(
			() => undefined,
			(error: unknown) => error,
		)
		expect(failure).toBe(inner)
		expect(failure).not.toBeInstanceOf(TaskHistoryStartupDegradedError)
		expect(store["fsWatcher"]).toBeNull()
	})

	it("non-admission failures inside admitted startup are not converted to degraded mode", async () => {
		const reconcile = vi.spyOn(store, "reconcile").mockRejectedValueOnce(new Error("scan failed"))
		await expect(store.initialize()).rejects.toThrow("scan failed")
		expect(reconcile).toHaveBeenCalledTimes(1)
	})
})

describe("ClineProvider.initializeTaskHistoryStore degraded reporting", () => {
	function fakeProvider(initializeError: Error) {
		return {
			taskHistoryStore: {
				initialize: vi.fn().mockRejectedValue(initializeError),
				migrateFromGlobalState: vi.fn(),
			},
			context: { globalState: { get: vi.fn().mockReturnValue(false), update: vi.fn() } },
			log: vi.fn(),
			taskHistoryStoreInitialized: false,
		}
	}

	afterEach(() => vi.restoreAllMocks())

	const lockPath = "/storage/.handoff-fences/startup.lock"
	it.each([
		[
			"held lock (timeout)",
			new ParentHandoffFenceUnavailableError("\u0000startup-admission", "timeout"),
			"common:errors.task_history_startup_lock_held",
			{ lockPath },
		],
		[
			"invalid generation",
			new ParentHandoffFenceUnavailableError(
				"\u0000startup-admission",
				"filesystem",
				undefined,
				"INVALID_GENERATION",
			),
			"common:errors.task_history_startup_generation_invalid",
			{ generationPath: "/storage/.handoff-fences/startup.generation", lockPath },
		],
		[
			"unusable fence folder",
			new ParentHandoffFenceUnavailableError("\u0000startup-admission", "filesystem", "EACCES"),
			"common:errors.task_history_startup_fence_unusable",
			{ fencePath: "/storage/.handoff-fences", code: "EACCES" },
		],
		[
			"unusable fence folder without a code",
			new ParentHandoffFenceUnavailableError("\u0000startup-admission", "filesystem"),
			"common:errors.task_history_startup_fence_unusable",
			{ fencePath: "/storage/.handoff-fences", code: "UNKNOWN" },
		],
	] as const)("names the right evidence for a %s and skips migration", async (_name, admission, key, params) => {
		const showError = vi.spyOn(vscode.window, "showErrorMessage")
		const provider = fakeProvider(new TaskHistoryStartupDegradedError(admission, lockPath))

		await ClineProvider.prototype["initializeTaskHistoryStore"].call(provider)

		expect(showError).toHaveBeenCalledTimes(1)
		expect(showError).toHaveBeenCalledWith(`${key} ${JSON.stringify(params)}`)
		expect(provider.taskHistoryStore.migrateFromGlobalState).not.toHaveBeenCalled()
		expect(provider.context.globalState.update).not.toHaveBeenCalled()
		expect(provider.taskHistoryStoreInitialized).toBe(false)
	})

	it("ships English texts that interpolate their evidence and do not claim read-only", async () => {
		const english = JSON.parse(
			await fs.readFile(path.join(__dirname, "../../../i18n/locales/en/common.json"), "utf8"),
		)
		const { errors } = english
		expect(errors.task_history_startup_lock_held).toContain("{{lockPath}}")
		expect(errors.task_history_startup_lock_held).toContain("no other Zoo Code window")
		expect(errors.task_history_startup_generation_invalid).toContain("{{generationPath}}")
		expect(errors.task_history_startup_fence_unusable).toContain("{{fencePath}}")
		expect(errors.task_history_startup_fence_unusable).toContain("{{code}}")
		for (const text of [
			errors.task_history_startup_lock_held,
			errors.task_history_startup_generation_invalid,
			errors.task_history_startup_fence_unusable,
		]) {
			expect(text).toContain("startup repairs were skipped")
			expect(text).not.toContain("read-only")
		}
		expect(errors.task_history_read_only).toBeUndefined()
	})

	it("keeps other startup failures log-only", async () => {
		const showError = vi.spyOn(vscode.window, "showErrorMessage")
		const provider = fakeProvider(new Error("other failure"))

		await ClineProvider.prototype["initializeTaskHistoryStore"].call(provider)

		expect(showError).not.toHaveBeenCalled()
		expect(provider.log).toHaveBeenCalledWith("[initializeTaskHistoryStore] Error: other failure")
		expect(provider.taskHistoryStoreInitialized).toBe(false)
	})
})
