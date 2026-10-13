import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as crypto from "crypto"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { HistoryItem } from "@roo-code/types"
import { TaskHistoryStore } from "../TaskHistoryStore"
import { ParentHandoffFence } from "../parentHandoffFence"
import { bindTargetPersistence, withStartupAdmission } from "../targetPersistenceBoundary"
import { readApiMessages } from "../apiMessages"

function canonical(file: string): string {
	return file.replace(/(b1-startup-effects-[^/]+)-alias(?=\/)/, "$1")
}

const hooks = vi.hoisted(() => ({
	before: undefined as ((kind: string, file: string, destination?: string) => Promise<void>) | undefined,
	after: undefined as ((kind: string, file: string, destination?: string) => Promise<void>) | undefined,
	stream: undefined as ((file: string) => void) | undefined,
	watch: [] as Array<() => void>,
}))
vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	return {
		...actual,
		readFile: async (...args: Parameters<typeof actual.readFile>) => {
			await hooks.before?.("read", canonical(String(args[0])))
			const result = await actual.readFile(...args)
			await hooks.after?.("read", canonical(String(args[0])))
			return result
		},
		access: async (...args: Parameters<typeof actual.access>) => {
			await hooks.before?.("access", canonical(String(args[0])))
			return actual.access(...args)
		},
		rename: async (...args: Parameters<typeof actual.rename>) => {
			await hooks.before?.("rename", canonical(String(args[0])), canonical(String(args[1])))
			await actual.rename(...args)
			await hooks.after?.("rename", canonical(String(args[0])), canonical(String(args[1])))
		},
		copyFile: async (...args: Parameters<typeof actual.copyFile>) => {
			await actual.copyFile(...args)
			await hooks.after?.("copy", canonical(String(args[0])), canonical(String(args[1])))
		},
		unlink: async (...args: Parameters<typeof actual.unlink>) => {
			await hooks.before?.("unlink", canonical(String(args[0])))
			await actual.unlink(...args)
			await hooks.after?.("unlink", canonical(String(args[0])))
		},
	}
})
vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs")>()
	return {
		...actual,
		createWriteStream: (...args: Parameters<typeof actual.createWriteStream>) => {
			const stream = actual.createWriteStream(...args)
			hooks.stream?.(canonical(String(args[0])))
			return stream
		},
		watch: (...args: Parameters<typeof actual.watch>) => {
			const callback = args[args.length - 1]
			if (typeof callback === "function") hooks.watch.push(() => callback("rename", "parent"))
			return actual.watch(...args)
		},
	}
})

const action: NonNullable<HistoryItem["pendingAction"]> = {
	kind: "create_subtask",
	actionId: "old",
	mode: "code",
	message: "work",
	todos: [],
	approvalText: "approved",
}
const record = (id: string, extra: Partial<HistoryItem> = {}): HistoryItem => ({
	id,
	number: 1,
	ts: 1,
	task: id,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	status: "active",
	...extra,
})
const deferred = () => {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}
const parentRecord = () =>
	record("parent", { status: "delegated", awaitingChildId: "child", childIds: ["child"], pendingAction: action })
const childRecord = () => record("child", { parentTaskId: "parent", rootTaskId: "parent" })
const intentRecord = () => ({
	version: 1,
	operationId: "repair",
	parentTaskId: "parent",
	childTaskId: "child",
	expected: {
		parent: { status: "delegated", awaitingChildId: "child" },
		child: { status: "active", parentTaskId: "parent", rootTaskId: "parent" },
	},
	target: { childStatus: "interrupted", parentStatus: "active" },
})
async function fixture(replay = false) {
	vi.spyOn(console, "error").mockImplementation((...args) => process.stderr.write(args.map(String).join(" ") + "\n"))
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "b1-startup-effects-"))
	const alias = `${root}-alias`
	await fs.symlink(root, alias, "dir")
	const first = new TaskHistoryStore(root)
	const second = new TaskHistoryStore(alias)
	const file = (id: string) => path.join(root, "tasks", id, "history_item.json")
	const put = async (item: HistoryItem) => {
		await fs.mkdir(path.dirname(file(item.id)), { recursive: true })
		await fs.writeFile(file(item.id), JSON.stringify(item))
	}
	await first.initialize()
	first.dispose()
	await put(parentRecord())
	await put(childRecord())
	await put(
		record("other", {
			status: "delegated",
			awaitingChildId: "missing",
			pendingQuestion: { id: "other-question", text: "keep", taskId: "other", toolCallId: "question" },
		}),
	)
	const intent = path.join(root, "tasks", "_delegation_repair_intent.json")
	if (replay) await fs.writeFile(intent, JSON.stringify(intentRecord()))
	const read = async (id: string): Promise<HistoryItem> => JSON.parse(await fs.readFile(file(id), "utf8"))
	const generation = path.join(
		root,
		".handoff-fences",
		`${crypto.createHash("sha256").update("parent").digest("hex")}.generation`,
	)
	return {
		root,
		alias,
		first,
		second,
		file,
		put,
		intent,
		read,
		generation,
		close: async () => {
			hooks.before = undefined
			hooks.after = undefined
			hooks.stream = undefined
			first.dispose()
			second.dispose()
			await fs.unlink(alias)
			await fs.rm(root, { recursive: true, force: true })
		},
	}
}
afterEach(() => {
	hooks.before = undefined
	hooks.after = undefined
	hooks.stream = undefined
	hooks.watch = []
	vi.restoreAllMocks()
})

describe("startup final effects on actual disk", () => {
	it.each([
		"scan",
		"intent-decision",
		"intent-publication",
		"child-publication",
		"parent-publication",
		"intent-unlink",
		"stale-intent-quarantine",
	])("excludes alias binding at %s and repairs an unrelated question", async (stage) => {
		const f = await fixture(
			stage === "intent-decision" || stage === "intent-unlink" || stage === "stale-intent-quarantine",
		)
		const reached = deferred(),
			resume = deferred()
		let paused = false
		let startup: Promise<void> | undefined
		try {
			if (stage === "stale-intent-quarantine")
				await f.put(record("child", { status: "completed", parentTaskId: "parent", rootTaskId: "parent" }))
			const stop = async (kind: string, file: string, destination?: string) => {
				const match =
					stage === "scan"
						? kind === "read" && file === f.file("parent")
						: stage === "intent-decision"
							? kind === "read" && file === f.intent
							: stage === "intent-publication"
								? kind === "rename" && destination === f.intent
								: stage === "child-publication"
									? kind === "rename" && destination === f.file("child")
									: stage === "parent-publication"
										? kind === "rename" && destination === f.file("parent")
										: stage === "intent-unlink"
											? kind === "unlink" && file === f.intent
											: kind === "rename" &&
												file === f.intent &&
												!!destination?.includes(".quarantine-")
				if (!paused && match) {
					paused = true
					reached.resolve()
					await resume.promise
				}
			}
			hooks.before = stop
			startup = f.second.initialize()
			await reached.promise
			await expect(bindTargetPersistence(f.alias, "parent", action)).rejects.toThrow()
			if (stage !== "scan" && stage !== "intent-decision")
				await expect(new ParentHandoffFence(f.alias).acquire("parent", { timeoutMs: 0 })).rejects.toThrow()
			// A different parent remains writable even while the repair's task/file exclusion is held.
			await f.first.upsert(record("unrelated", { task: "progress" }))
			expect((await f.read("unrelated")).task).toBe("progress")
			resume.resolve()
			await startup
			expect(paused).toBe(true)
			expect((await f.read("other")).status).toBe("active")
			expect((await f.read("other")).pendingQuestion?.id).toBe("other-question")
			if (stage !== "stale-intent-quarantine") expect((await f.read("child")).status).toBe("interrupted")
		} finally {
			resume.resolve()
			await startup
			await f.close()
		}
	})

	it("holds the parent lease between child and parent commits, and keeps partial evidence on failure", async () => {
		const f = await fixture()
		const reached = deferred(),
			resume = deferred()
		let startup: Promise<void> | undefined
		try {
			hooks.after = async (kind, _file, destination) => {
				if (kind === "rename" && destination === f.file("child")) {
					reached.resolve()
					await resume.promise
				}
			}
			startup = f.second.initialize()
			await reached.promise
			await expect(bindTargetPersistence(f.alias, "parent", action)).rejects.toThrow()
			await f.put({ ...parentRecord(), pendingAction: { ...action, message: "new" } })
			resume.resolve()
			await startup
			expect((await f.read("child")).status).toBe("interrupted")
			expect((await f.read("parent")).pendingAction).toMatchObject({ message: "new" })
			expect((await f.read("parent")).status).toBe("delegated")
			expect(JSON.parse(await fs.readFile(f.intent, "utf8")).operationId).toBeTypeOf("string")
		} finally {
			resume.resolve()
			await startup
			await f.close()
		}
	})

	it.each(["owner", "action", "question", "lineage"])(
		"refuses changed %s between intent decision and child effect",
		async (change) => {
			const f = await fixture(true)
			let changed = false
			try {
				hooks.after = async (kind, file) => {
					if (!changed && kind === "read" && file === f.file("child") && fsSync.existsSync(f.intent)) {
						// Only mutate once the parent lease exists, after outside-mutex identity planning.
						const lock = path.join(
							f.root,
							".handoff-fences",
							`${crypto.createHash("sha256").update("parent").digest("hex")}.lock`,
							"owner.json",
						)
						if (!fsSync.existsSync(lock)) return
						changed = true
						const parent = parentRecord()
						if (change === "owner") parent.delegatedToId = "new-owner"
						if (change === "action") parent.pendingAction = { ...action, message: "changed" }
						if (change === "question")
							parent.pendingQuestion = {
								id: "new",
								text: "keep",
								taskId: "parent",
								toolCallId: "question",
							}
						if (change === "lineage") parent.parentTaskId = "unplanned"
						await f.put(parent)
					}
				}
				await f.second.initialize()
				expect(changed).toBe(true)
				// Replay may observe a new authoritative state, but must not overwrite its changed identity.
				const parent = await f.read("parent")
				if (change === "owner") expect(parent.delegatedToId).toBe("new-owner")
				if (change === "action") expect(parent.pendingAction).toMatchObject({ message: "changed" })
				if (change === "question") expect(parent.pendingQuestion?.id).toBe("new")
				if (change === "lineage") expect(parent.parentTaskId).toBe("unplanned")
				expect((await f.read("other")).status).toBe("active")
			} finally {
				await f.close()
			}
		},
	)

	it.each(["stream", "backup"])(
		"refuses actual generation loss during %s and retains exact authority",
		async (stage) => {
			const f = await fixture(true)
			let lost = false
			try {
				const lose = () => {
					if (!lost) {
						lost = true
						fsSync.writeFileSync(f.generation, "999")
					}
				}
				if (stage === "stream")
					hooks.stream = (file) => {
						if (file.startsWith(f.file("child") + ".guarded-new")) lose()
					}
				else
					hooks.after = async (kind, file) => {
						if (kind === "copy" && file === f.file("child")) lose()
					}
				await f.second.initialize()
				expect(lost).toBe(true)
				expect(await f.read("parent")).toEqual(parentRecord())
				expect(await f.read("child")).toEqual(childRecord())
				expect(JSON.parse(await fs.readFile(f.intent, "utf8"))).toEqual(intentRecord())
				expect((await f.read("other")).status).toBe("active")
			} finally {
				await f.close()
			}
		},
	)

	it.each(["commit-error", "readback-error"])(
		"preserves committed child and intent after %s without blind retry",
		async (fault) => {
			const f = await fixture(true)
			let committed = false,
				reads = 0
			try {
				hooks.after = async (kind, _file, destination) => {
					if (!committed && kind === "rename" && destination === f.file("child")) {
						committed = true
						if (fault === "commit-error") throw new Error("injected after commit")
					}
				}
				hooks.before = async (kind, file) => {
					if (committed && kind === "read" && file === f.file("child")) {
						reads++
						throw new Error("injected readback failure")
					}
				}
				await f.second.initialize()
				hooks.before = undefined
				expect(committed).toBe(true)
				expect((await f.read("child")).status).toBe("interrupted")
				expect((await f.read("parent")).status).toBe("delegated")
				expect(JSON.parse(await fs.readFile(f.intent, "utf8"))).toEqual(intentRecord())
				expect(reads).toBeGreaterThan(0)
				expect((await f.read("other")).status).toBe("active")
			} finally {
				await f.close()
			}
		},
	)

	it("replays from authoritative disk with the parent absent from cache", async () => {
		const f = await fixture(true)
		try {
			const replay = Reflect.get(f.first, "replayDelegationRepairIntent")
			if (typeof replay !== "function") throw new Error("Replay unavailable")
			expect(f.first.get("parent")).toBeUndefined()
			await withStartupAdmission(f.alias, () => replay.call(f.first))
			expect((await f.read("parent")).status).toBe("active")
			expect((await f.read("child")).status).toBe("interrupted")
			await expect(fs.access(f.intent)).rejects.toThrow()
		} finally {
			await f.close()
		}
	})

	it.each(["before-file-lock", "replacement"])("task migration excludes alias binding at %s", async (stage) => {
		const f = await fixture()
		const reached = deferred(),
			resume = deferred()
		let migration: Promise<void> | undefined,
			paused = false
		try {
			await fs.mkdir(path.join(f.root, "tasks", "legacy"))
			hooks.before = async (kind, file, destination) => {
				const match =
					stage === "before-file-lock"
						? kind === "access" && file === f.file("legacy")
						: kind === "rename" && destination === f.file("legacy")
				if (!paused && match) {
					paused = true
					reached.resolve()
					await resume.promise
				}
			}
			migration = f.first.migrateFromGlobalState([
				record("legacy", { parentTaskId: "parent", rootTaskId: "parent" }),
			])
			await reached.promise
			await expect(bindTargetPersistence(f.alias, "parent", action)).rejects.toThrow()
			await expect(new ParentHandoffFence(f.alias).acquire("parent", { timeoutMs: 0 })).rejects.toThrow()
			await f.second.upsert(record("control"))
			resume.resolve()
			await migration
			expect((await f.read("legacy")).parentTaskId).toBe("parent")
			expect((await f.read("control")).id).toBe("control")
		} finally {
			resume.resolve()
			await migration
			await f.close()
		}
	})

	it("a successful binding prevents later child task/API migration", async () => {
		const f = await fixture()
		try {
			await f.put(record("parent", { status: "interrupted", pendingAction: action }))
			await bindTargetPersistence(f.alias, "parent", action)
			await fs.mkdir(path.join(f.root, "tasks", "legacy"))
			await expect(
				f.first.migrateFromGlobalState([record("legacy", { parentTaskId: "parent" })]),
			).rejects.toThrow()
			await expect(fs.access(f.file("legacy"))).rejects.toThrow()
			await fs.writeFile(path.join(f.root, "tasks", "child", "api_conversation_history.json"), "[]")
			// Existing API read is non-mutating; legacy replacement is the capable path.
			await fs.unlink(path.join(f.root, "tasks", "child", "api_conversation_history.json"))
			await fs.writeFile(path.join(f.root, "tasks", "child", "claude_messages.json"), "[]")
			await expect(readApiMessages({ taskId: "child", globalStoragePath: f.alias })).rejects.toThrow()
		} finally {
			await f.close()
		}
	})
	it.each(["before-file-lock", "replacement", "legacy-unlink"])(
		"API migration excludes binding at %s and unrelated work progresses",
		async (stage) => {
			const f = await fixture()
			const api = path.join(f.root, "tasks", "parent", "api_conversation_history.json")
			const legacy = path.join(f.root, "tasks", "parent", "claude_messages.json")
			const reached = deferred(),
				resume = deferred()
			let work: Promise<unknown> | undefined,
				paused = false
			try {
				await f.put(record("parent", { status: "interrupted", pendingAction: action }))
				await fs.writeFile(legacy, JSON.stringify([{ role: "user", content: "legacy" }]))
				hooks.before = async (kind, file, destination) => {
					const match =
						stage === "before-file-lock"
							? kind === "read" &&
								file.endsWith("/owner.json") &&
								file.includes(crypto.createHash("sha256").update("parent").digest("hex"))
							: stage === "replacement"
								? kind === "rename" && destination === api
								: kind === "unlink" && file === legacy
					if (!paused && match) {
						paused = true
						reached.resolve()
						await resume.promise
					}
				}
				work = readApiMessages({ taskId: "parent", globalStoragePath: f.alias })
				await reached.promise
				await expect(bindTargetPersistence(f.root, "parent", action)).rejects.toThrow()
				await expect(new ParentHandoffFence(f.alias).acquire("parent", { timeoutMs: 0 })).rejects.toThrow()
				await f.first.upsert(record("control"))
				resume.resolve()
				await work
				expect(JSON.parse(await fs.readFile(api, "utf8"))).toEqual([{ role: "user", content: "legacy" }])
				await expect(fs.access(legacy)).rejects.toThrow()
				expect((await f.read("control")).id).toBe("control")
			} finally {
				resume.resolve()
				await work
				await f.close()
			}
		},
	)

	it.each(["watch", "periodic"])(
		"%s entry after released startup admission is read-only across successful binding",
		async (entry) => {
			const f = await fixture()
			const reached = deferred(),
				resume = deferred()
			let work: Promise<unknown> | undefined,
				paused = false,
				effects = 0
			const timers: Array<() => unknown> = []
			try {
				await f.put(record("parent", { status: "interrupted", pendingAction: action }))
				const actualTimer = globalThis.setTimeout
				vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, timeout, ...args) => {
					if (timeout === 300_000 || timeout === 500) {
						timers.push(() => callback(...args))
						return actualTimer(() => {}, 2_000_000)
					}
					return actualTimer(callback, timeout, ...args)
				})
				await f.second.initialize()
				await vi.waitFor(() => expect(hooks.watch.length).toBeGreaterThan(0))
				await f.second.invalidateAll()
				hooks.before = async (kind, file) => {
					if (!paused && kind === "read" && file === f.file("parent")) {
						paused = true
						reached.resolve()
						await resume.promise
					}
					if ((kind === "rename" || kind === "unlink") && file.startsWith(path.join(f.root, "tasks")))
						effects++
				}
				if (entry === "watch") {
					hooks.watch[hooks.watch.length - 1]()
					work = Promise.resolve(timers[timers.length - 1]())
				} else work = Promise.resolve(timers[0]())
				await reached.promise
				await bindTargetPersistence(f.alias, "parent", action)
				resume.resolve()
				await work
				await vi.waitFor(() => expect(f.second.get("parent")).toBeDefined())
				expect(effects).toBe(0)
				// Binding's own generation renames are excluded; task/intent mutation count must be zero.
				expect(await f.read("parent")).toEqual(
					record("parent", { status: "interrupted", pendingAction: action }),
				)
				await f.first.upsert(record("control"))
				expect((await f.read("control")).id).toBe("control")
			} finally {
				resume.resolve()
				await work
				await f.close()
			}
		},
	)
	it.each(["generation", "owner", "action", "question"])(
		"migration refuses %s loss after streaming before replacement",
		async (fault) => {
			const f = await fixture()
			let changed = false
			try {
				await fs.mkdir(path.join(f.root, "tasks", "legacy"))
				hooks.stream = (file) => {
					if (!changed && file.startsWith(f.file("legacy") + ".guarded-new")) {
						changed = true
						if (fault === "generation") fsSync.writeFileSync(f.generation, "999")
						else {
							const parent = parentRecord()
							if (fault === "owner") parent.delegatedToId = "new-owner"
							if (fault === "action") parent.pendingAction = { ...action, message: "new-action" }
							if (fault === "question")
								parent.pendingQuestion = {
									id: "new-question",
									text: "keep",
									taskId: "parent",
									toolCallId: "question",
								}
							fsSync.writeFileSync(f.file("parent"), JSON.stringify(parent))
						}
					}
				}
				await expect(
					f.first.migrateFromGlobalState([record("legacy", { parentTaskId: "parent" })]),
				).rejects.toThrow()
				expect(changed).toBe(true)
				await expect(fs.access(f.file("legacy"))).rejects.toThrow()
				await f.second.upsert(record("control"))
				expect((await f.read("control")).id).toBe("control")
			} finally {
				await f.close()
			}
		},
	)

	it("unknown cooperative writer prevents target binding and repair without blocking another parent", async () => {
		const f = await fixture()
		try {
			const key = crypto.createHash("sha256").update("parent").digest("hex")
			await fs.mkdir(path.join(f.root, ".handoff-fences", `${key}.lock`))
			await expect(bindTargetPersistence(f.alias, "parent", action)).rejects.toThrow()
			await f.first.upsert(record("control"))
			expect((await f.read("control")).id).toBe("control")
			await f.second.initialize()
			expect(await f.read("parent")).toEqual(parentRecord())
			expect((await f.read("other")).status).toBe("active")
		} finally {
			await f.close()
		}
	})

	it("ambiguous changed child lineage is retained rather than quarantined", async () => {
		const f = await fixture(true)
		try {
			await f.put(record("child", { parentTaskId: "different", rootTaskId: "different" }))
			await f.put(record("different"))
			await f.second.initialize()
			expect(JSON.parse(await fs.readFile(f.intent, "utf8"))).toEqual(intentRecord())
			expect((await fs.readdir(path.join(f.root, "tasks"))).some((name) => name.includes("quarantine"))).toBe(
				false,
			)
			expect((await f.read("parent")).status).toBe("delegated")
			expect((await f.read("other")).status).toBe("active")
		} finally {
			await f.close()
		}
	})
	it("intent publication refuses actual parent generation loss during streaming", async () => {
		const f = await fixture()
		let lost = false
		try {
			hooks.stream = (file) => {
				if (!lost && file.startsWith(f.intent + ".guarded-new")) {
					lost = true
					fsSync.writeFileSync(f.generation, "999")
				}
			}
			await f.second.initialize()
			expect(lost).toBe(true)
			expect(await f.read("parent")).toEqual(parentRecord())
			expect(await f.read("child")).toEqual(childRecord())
			await expect(fs.access(f.intent)).rejects.toThrow()
			expect((await f.read("other")).status).toBe("active")
		} finally {
			await f.close()
		}
	})

	it("intent cleanup refuses generation loss before unlink and retains both committed records", async () => {
		const f = await fixture(true)
		let lost = false
		try {
			hooks.after = async (kind, file) => {
				if (!lost && kind === "read" && file === f.intent && fsSync.existsSync(f.file("parent"))) {
					const parent: HistoryItem = JSON.parse(fsSync.readFileSync(f.file("parent"), "utf8"))
					if (parent.status === "active") {
						lost = true
						fsSync.writeFileSync(f.generation, "999")
					}
				}
			}
			await f.second.initialize()
			expect(lost).toBe(true)
			expect((await f.read("parent")).status).toBe("active")
			expect((await f.read("child")).status).toBe("interrupted")
			expect(JSON.parse(await fs.readFile(f.intent, "utf8"))).toEqual(intentRecord())
		} finally {
			await f.close()
		}
	})
})
