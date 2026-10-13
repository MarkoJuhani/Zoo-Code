import * as crypto from "crypto"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { providerIdentifiers, type HistoryItem } from "@roo-code/types"
import { TaskHistoryStore } from "../../task-persistence/TaskHistoryStore"
import { bindTargetPersistence, withProviderStartExclusion } from "../../task-persistence/targetPersistenceBoundary"
import { TaskRegistry } from "../../task/TaskRegistry"
import { Task } from "../../task/Task"
import { TaskScheduler } from "../../task/TaskScheduler"
import { ClineProvider, DelegationRecoverableError } from "../ClineProvider"
import {
	OrdinaryPersistenceAuthorityError,
	createOrdinaryTaskPersistenceAuthority,
} from "../../task-persistence/targetPersistenceBoundary"
import { GuardedPublicationError } from "../../../utils/safeWriteJson"

const diskGate = vi.hoisted(() => ({
	beforeRename: undefined as undefined | ((from: string, to: string) => Promise<void>),
	afterRename: undefined as undefined | ((from: string, to: string) => Promise<void>),
	afterCopy: undefined as undefined | ((from: string, to: string) => Promise<void>),
	afterRead: undefined as undefined | ((file: string) => Promise<void>),
}))
vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>()
	return {
		...actual,
		readFile: async (...args: Parameters<typeof actual.readFile>) => {
			const result = await actual.readFile(...args)
			await diskGate.afterRead?.(String(args[0]))
			return result
		},
		copyFile: async (from: string, to: string, mode?: number) => {
			await actual.copyFile(from, to, mode)
			await diskGate.afterCopy?.(String(from), String(to))
		},
		rename: async (from: string, to: string) => {
			await diskGate.beforeRename?.(String(from), String(to))
			await actual.rename(from, to)
			await diskGate.afterRename?.(String(from), String(to))
		},
	}
})

const action = {
	kind: "create_subtask" as const,
	actionId: "old",
	mode: "code",
	message: "old",
	todos: [],
	approvalText: "old",
}
const record = (id: string, changes: Partial<HistoryItem> = {}): HistoryItem => ({
	id,
	number: 1,
	ts: 1,
	task: id,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	status: "active",
	childIds: [],
	pendingAction: id === "parent" ? action : undefined,
	...changes,
})
const signal = () => {
	let release!: () => void
	const promise = new Promise<void>((resolve) => {
		release = resolve
	})
	return { promise, release }
}
const params = {
	parentTaskId: "parent",
	message: "old",
	initialTodos: [],
	mode: "code" as const,
	pendingActionId: "old",
}

async function expectRecoverable(
	promise: Promise<Task>,
	cause: Error | { type: abstract new (...args: never[]) => Error; message: RegExp },
) {
	const failure: unknown = await promise.then(
		() => {
			throw new Error("Expected a recoverable delegation refusal")
		},
		(error: unknown) => error,
	)
	expect(failure).toBeInstanceOf(DelegationRecoverableError)
	if (!(failure instanceof DelegationRecoverableError)) throw failure
	expect(failure.disposition).toBe("evidence_retained")
	if (cause instanceof Error) expect(failure.originalError).toBe(cause)
	else {
		expect(failure.originalError).toBeInstanceOf(cause.type)
		expect(failure.originalError).toHaveProperty("message", expect.stringMatching(cause.message))
	}
	return failure
}

async function fixture() {
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), "b1-final-effects-"))
	const alias = `${storage}-alias`
	await fs.symlink(storage, alias)
	const store = new TaskHistoryStore(storage)
	const competitor = new TaskHistoryStore(alias)
	await store.initialize()
	await competitor.initialize()
	await store.upsert(record("parent"))
	await store.upsert(record("other"))
	const registry = new TaskRegistry()
	// Structural non-running tasks: the actual provider transition, registry and disk store execute.
	const parent = {
		taskId: "parent",
		instanceId: "parent-instance",
		apiConfiguration: { apiProvider: providerIdentifiers.anthropic },
		userMessageContent: [],
		getTaskApiConfigName: async () => "fixture",
		getTaskMode: async () => "code",
		flushPendingToolResultsToHistory: vi.fn(async () => true),
		retrySaveApiConversationHistory: vi.fn(async () => true),
		emit: vi.fn(),
		abortTask: vi.fn(async () => {}),
		dispose: vi.fn(async () => {}),
	} as unknown as Task
	const child = {
		taskId: "child",
		instanceId: "child-instance",
		parentTaskId: "parent",
		rootTaskId: "parent",
		taskNumber: 2,
		cwd: storage,
		getTaskMode: async () => "code",
		getTaskApiConfigName: async () => "fixture",
		emit: vi.fn(),
		abortTask: vi.fn(async () => {}),
		dispose: vi.fn(async () => {}),
		// A scheduler spy captures enqueue without ever executing the child.
	} as unknown as Task
	registry.push(parent)
	const scheduler = { schedule: vi.fn(async () => {}) }
	const provider = {
		contextProxy: { globalStorageUri: { fsPath: alias } },
		context: { workspaceState: { get: () => false } },
		taskHistoryStore: store,
		taskRegistry: registry,
		taskEventListeners: new Map(),
		taskScheduler: scheduler,
		getCurrentTask: () => registry.current,
		log: vi.fn(),
		emit: vi.fn(),
		getState: async () => ({ mode: "code" }),
		performPreparationTasks: vi.fn(async () => {}),
		runDelegationTransition: (_id: string, effect: () => Promise<Task>) => effect(),
		removeClineFromStack: ClineProvider.prototype.removeClineFromStack,
		providerSettingsManager: { getModeConfigId: async () => undefined },
		handleModeSwitch: async () => {},
		createTask: vi.fn(async () => {
			await ClineProvider.prototype.addClineToStack.call(provider, child)
			return child
		}),
		updateTaskHistory: async (item: HistoryItem) => {
			await store.upsert(item)
		},
		createTaskWithHistoryItem: vi.fn(async () => parent),
	} as unknown as ClineProvider
	return {
		storage,
		alias,
		store,
		competitor,
		parent,
		child,
		registry,
		scheduler,
		provider,
		read: async (id: string): Promise<HistoryItem> =>
			JSON.parse(await fs.readFile(path.join(storage, "tasks", id, "history_item.json"), "utf8")),
		close: async () => {
			diskGate.beforeRename = undefined
			diskGate.afterRename = undefined
			diskGate.afterCopy = undefined
			diskGate.afterRead = undefined
			store.dispose()
			competitor.dispose()
			await fs.rm(alias, { force: true })
			await fs.rm(storage, { recursive: true, force: true })
		},
	}
}

for (const stage of ["flush", "parent-disposal", "stack", "child-disk", "parent-commit"] as const) {
	it(`real delegation excludes competing alias binding throughout ${stage}`, async () => {
		const f = await fixture()
		const entered = signal(),
			finish = signal()
		const pause = async () => {
			entered.release()
			await finish.promise
		}
		if (stage === "flush")
			vi.mocked(f.parent.flushPendingToolResultsToHistory).mockImplementation(async () => {
				await pause()
				return true
			})
		if (stage === "parent-disposal") vi.mocked(f.parent.dispose).mockImplementation(pause)
		if (stage === "stack") vi.mocked(f.provider.performPreparationTasks).mockImplementation(pause)
		if (stage === "child-disk" || stage === "parent-commit") {
			const id = stage === "child-disk" ? "child" : "parent"
			diskGate.beforeRename = async (_from, to) => {
				if (to === path.join(f.storage, "tasks", id, "history_item.json")) await pause()
			}
		}
		try {
			const running = ClineProvider.prototype.delegateParentAndOpenChild.call(f.provider, params)
			await entered.promise
			await f.competitor.readAuthoritative("other")
			await expect(bindTargetPersistence(f.alias, "parent", action)).rejects.toThrow(/parent/i)
			await expect(withProviderStartExclusion(f.storage, "other", async () => "progress")).resolves.toBe(
				"progress",
			)
			finish.release()
			await expect(running).resolves.toBe(f.child)
			expect((await f.read("parent")).awaitingChildId).toBe("child")
			expect((await f.read("child")).parentTaskId).toBe("parent")
			expect(f.scheduler.schedule).toHaveBeenCalledOnce()
		} finally {
			finish.release()
			await f.close()
		}
	})
}

it("rollback retains parent exclusion until awaited child disposal and preserves prepared evidence", async () => {
	const f = await fixture()
	const entered = signal(),
		finish = signal()
	const commitError = new Error("commit refused")
	vi.spyOn(f.store, "atomicReadAndUpdate").mockRejectedValue(commitError)
	vi.mocked(f.child.dispose).mockImplementation(async () => {
		entered.release()
		await finish.promise
	})
	try {
		const running = ClineProvider.prototype.delegateParentAndOpenChild.call(f.provider, params)
		const rejected = expectRecoverable(running, commitError)
		await entered.promise
		await expect(bindTargetPersistence(f.alias, "parent", action)).rejects.toThrow(/parent/i)
		finish.release()
		await rejected
		expect((await f.read("child")).parentTaskId).toBe("parent")
		expect((await f.read("parent")).awaitingChildId).toBeUndefined()
		expect(f.scheduler.schedule).not.toHaveBeenCalled()
	} finally {
		finish.release()
		await f.close()
	}
})

it("commit-then-error never deletes the durable owned child or restores the parent", async () => {
	const f = await fixture()
	const commitError = new Error("commit then error")
	const commit = f.store.atomicReadAndUpdate.bind(f.store)
	vi.spyOn(f.store, "atomicReadAndUpdate").mockImplementation(async (id, updater) => {
		await commit(id, updater)
		throw commitError
	})
	try {
		await expectRecoverable(
			ClineProvider.prototype.delegateParentAndOpenChild.call(f.provider, params),
			commitError,
		)
		expect((await f.read("parent")).awaitingChildId).toBe("child")
		expect((await f.read("child")).parentTaskId).toBe("parent")
		expect(f.provider.createTaskWithHistoryItem).not.toHaveBeenCalled()
		expect(f.scheduler.schedule).not.toHaveBeenCalled()
	} finally {
		await f.close()
	}
})

it("failed rollback disposal preserves child evidence and does not restore or enqueue", async () => {
	const f = await fixture()
	const commitError = new Error("commit refused")
	vi.spyOn(f.store, "atomicReadAndUpdate").mockRejectedValue(commitError)
	vi.mocked(f.child.dispose).mockRejectedValue(new Error("cleanup uncertain"))
	try {
		await expectRecoverable(
			ClineProvider.prototype.delegateParentAndOpenChild.call(f.provider, params),
			commitError,
		)
		expect((await f.read("child")).parentTaskId).toBe("parent")
		expect(f.provider.createTaskWithHistoryItem).not.toHaveBeenCalled()
		expect(f.scheduler.schedule).not.toHaveBeenCalled()
	} finally {
		await f.close()
	}
})

it("generation loss after flush rejects teardown, child creation and enqueue", async () => {
	const f = await fixture()
	vi.mocked(f.parent.flushPendingToolResultsToHistory).mockImplementation(async () => {
		const key = crypto.createHash("sha256").update("parent").digest("hex")
		await fs.writeFile(path.join(f.storage, ".handoff-fences", `${key}.generation`), "999")
		return true
	})
	try {
		await expect(ClineProvider.prototype.delegateParentAndOpenChild.call(f.provider, params)).rejects.toThrow(
			/ownership|generation/i,
		)
		expect(f.registry.current).toBe(f.parent)
		expect(f.parent.abortTask).not.toHaveBeenCalled()
		expect(f.provider.createTask).not.toHaveBeenCalled()
		expect(f.scheduler.schedule).not.toHaveBeenCalled()
	} finally {
		await f.close()
	}
})

it("bound current target refuses top-level creation and eviction before teardown", async () => {
	const f = await fixture()
	try {
		await bindTargetPersistence(f.alias, "parent", action)
		await expect(
			ClineProvider.prototype.createTask.call(f.provider, "new", undefined, undefined, { startTask: false }),
		).rejects.toThrow(/Bound parent/)
		await expect(ClineProvider.prototype.evictCurrentTask.call(f.provider)).rejects.toThrow(/Bound parent/)
		expect(f.registry.current).toBe(f.parent)
		expect(f.parent.abortTask).not.toHaveBeenCalled()
	} finally {
		await f.close()
	}
})

it("actual eviction retains exclusion throughout awaited teardown", async () => {
	const f = await fixture()
	const entered = signal(),
		finish = signal()
	vi.mocked(f.parent.abortTask).mockImplementation(async () => {
		entered.release()
		await finish.promise
	})
	try {
		const running = ClineProvider.prototype.evictCurrentTask.call(f.provider)
		await entered.promise
		await expect(bindTargetPersistence(f.alias, "parent", action)).rejects.toThrow(/parent/i)
		finish.release()
		await running
		await bindTargetPersistence(f.alias, "parent", action)
		expect(f.registry.current).toBeUndefined()
	} finally {
		finish.release()
		await f.close()
	}
})

it("direct stack publication rejects a child of a bound parent", async () => {
	const f = await fixture()
	try {
		await bindTargetPersistence(f.alias, "parent", action)
		await expect(ClineProvider.prototype.addClineToStack.call(f.provider, f.child)).rejects.toThrow(/Bound parent/)
		expect(f.registry.current).toBe(f.parent)
		expect(f.provider.performPreparationTasks).not.toHaveBeenCalled()
	} finally {
		await f.close()
	}
})

it("history restoration refuses a persisted child of a bound parent before eviction", async () => {
	const f = await fixture()
	try {
		await f.store.upsert(record("child", { parentTaskId: "parent" }))
		await bindTargetPersistence(f.alias, "parent", action)
		await expect(
			ClineProvider.prototype.createTaskWithHistoryItem.call(
				f.provider,
				record("child", { parentTaskId: "parent" }),
				{ startTask: false },
			),
		).rejects.toThrow(/Bound parent/)
		expect(f.parent.abortTask).not.toHaveBeenCalled()
		expect(f.registry.current).toBe(f.parent)
	} finally {
		await f.close()
	}
})

for (const id of ["child", "parent"] as const) {
	it(`lost generation inside ${id} file lock rejects the final history merge and retains prior evidence`, async () => {
		const f = await fixture()
		let lost = false
		// Ensure child has an existing file so safeWriteJson performs its locked read.
		await f.store.upsert(record("child", { parentTaskId: "parent", task: "prepared evidence" }))
		const entered = signal(),
			finish = signal()
		if (id === "child") {
			vi.mocked(f.provider.createTask).mockImplementation(async () => {
				await ClineProvider.prototype.addClineToStack.call(f.provider, f.child)
				diskGate.afterRead = loseAtRead
				return f.child
			})
		} else {
			const publish = f.provider.updateTaskHistory.bind(f.provider)
			vi.spyOn(f.provider, "updateTaskHistory").mockImplementation(async (...args) => {
				const result = await publish(...args)
				diskGate.afterRead = loseAtRead
				return result
			})
		}
		async function loseAtRead(file: string) {
			if (lost || file !== path.join(f.storage, "tasks", id, "history_item.json")) return
			lost = true
			entered.release()
			await finish.promise
			const key = crypto.createHash("sha256").update("parent").digest("hex")
			await fs.writeFile(path.join(f.storage, ".handoff-fences", `${key}.generation`), "999")
		}
		try {
			const running = ClineProvider.prototype.delegateParentAndOpenChild.call(f.provider, params)
			const rejected = expect(running).rejects.toThrow(/ownership|generation/i)
			await entered.promise
			await expect(bindTargetPersistence(f.alias, "parent", action)).rejects.toThrow(/parent/i)
			finish.release()
			await rejected
			expect(lost).toBe(true)
			diskGate.afterRead = undefined
			expect((await f.read("parent")).awaitingChildId).toBeUndefined()
			expect((await f.read("child")).parentTaskId).toBe("parent")
			if (id === "child") expect((await f.read("child")).task).toBe("prepared evidence")
			expect(f.scheduler.schedule).not.toHaveBeenCalled()
			expect(f.child.dispose).not.toHaveBeenCalled()
		} finally {
			finish.release()
			await f.close()
		}
	})
}

for (const pathKind of ["scheduler", "fallback"] as const) {
	it(`real provider ${pathKind} enqueue reaches fresh callback protection after the delegation lease releases`, async () => {
		const f = await fixture()
		const entered = signal(),
			finish = signal(),
			settled = signal()
		const effect = vi.fn(async () => {})
		vi.mocked(f.provider.log).mockImplementation((message) => {
			if (!message.startsWith("[ordinary_delegation] ")) return
			const record = JSON.parse(message.slice("[ordinary_delegation] ".length))
			if (record.phase === "scheduler" && record.stage === "failed") settled.release()
		})
		// Private field access is confined to installing the non-running execution seam.
		const child = f.child as unknown as {
			globalStoragePath: string
			withStartExclusion: Task["runWithStartExclusion"]
			run: () => Promise<void>
			runScheduled: () => Promise<void>
			persistenceAuthority: ReturnType<typeof createOrdinaryTaskPersistenceAuthority>
		}
		child.globalStoragePath = f.storage
		child.persistenceAuthority = createOrdinaryTaskPersistenceAuthority({
			id: "child",
			parentTaskId: "parent",
			rootTaskId: "parent",
		})
		child.withStartExclusion = (
			Task.prototype as unknown as { withStartExclusion: Task["runWithStartExclusion"] }
		).withStartExclusion
		child.runScheduled = async () => {
			entered.release()
			await finish.promise
			await Task.prototype.runScheduled.call(f.child)
		}
		child.run = effect
		const provider = f.provider as unknown as { taskScheduler: TaskScheduler | undefined }
		provider.taskScheduler = pathKind === "scheduler" ? new TaskScheduler() : undefined
		try {
			// Keep the full action as disk identity while committing known child ownership.
			await ClineProvider.prototype.delegateParentAndOpenChild.call(f.provider, {
				...params,
				pendingActionId: undefined,
			})
			await entered.promise
			await bindTargetPersistence(f.alias, "parent", action)
			finish.release()
			await settled.promise
			expect(f.provider.log).toHaveBeenCalledWith(expect.stringContaining('"phase":"scheduler","stage":"failed"'))
			expect(effect).not.toHaveBeenCalled()
			expect((await f.read("parent")).awaitingChildId).toBe("child")
			expect((await f.read("child")).parentTaskId).toBe("parent")
		} finally {
			finish.release()
			await f.close()
		}
	})
}

it("failed parent disposal refuses child construction, publication and enqueue", async () => {
	const f = await fixture()
	const cleanupError = new Error("parent cleanup uncertain")
	vi.mocked(f.parent.dispose).mockRejectedValue(cleanupError)
	try {
		await expectRecoverable(
			ClineProvider.prototype.delegateParentAndOpenChild.call(f.provider, params),
			cleanupError,
		)
		expect(f.provider.createTask).not.toHaveBeenCalled()
		expect(f.scheduler.schedule).not.toHaveBeenCalled()
		expect((await f.read("parent")).awaitingChildId).toBeUndefined()
		await expect(fs.access(path.join(f.storage, "tasks", "child", "history_item.json"))).rejects.toThrow()
	} finally {
		await f.close()
	}
})

it("eviction owns exclusion until disposal, not merely until abort resolves", async () => {
	const f = await fixture()
	const entered = signal(),
		finish = signal()
	vi.mocked(f.parent.dispose).mockImplementation(async () => {
		entered.release()
		await finish.promise
	})
	try {
		const running = ClineProvider.prototype.evictCurrentTask.call(f.provider)
		await entered.promise
		expect(f.parent.abortTask).toHaveBeenCalledOnce()
		await expect(bindTargetPersistence(f.alias, "parent", action)).rejects.toThrow(/parent/i)
		finish.release()
		await running
		await bindTargetPersistence(f.alias, "parent", action)
	} finally {
		finish.release()
		await f.close()
	}
})

it("EXTERNAL LIMIT (not safety acceptance): forced theft inside replacement syscall may commit; retain evidence and refuse enqueue", async () => {
	const f = await fixture()
	let lost = false
	diskGate.beforeRename = async (_from, to) => {
		if (lost || to !== path.join(f.storage, "tasks", "parent", "history_item.json")) return
		lost = true
		const key = crypto.createHash("sha256").update("parent").digest("hex")
		await fs.writeFile(path.join(f.storage, ".handoff-fences", `${key}.generation`), "999")
	}
	try {
		await expect(ClineProvider.prototype.delegateParentAndOpenChild.call(f.provider, params)).rejects.toThrow(
			/ownership|generation/i,
		)
		// This is an unsafe effect witness, NOT an accepted safety observation.
		// Direct generation-file mutation is outside cooperative exclusion; UNKNOWN, never no-commit.
		expect(lost).toBe(true)
		expect((await f.read("parent")).awaitingChildId).toBe("child")
		expect((await f.read("child")).parentTaskId).toBe("parent")
		expect(f.scheduler.schedule).not.toHaveBeenCalled()
		expect(f.child.dispose).not.toHaveBeenCalled()
		expect(f.provider.createTaskWithHistoryItem).not.toHaveBeenCalled()
	} finally {
		await f.close()
	}
})

it("cooperative final replacement exclusion refuses binding and competing lease acquisition; unrelated parent progresses", async () => {
	const f = await fixture()
	const entered = signal(),
		finish = signal()
	diskGate.beforeRename = async (_from, to) => {
		if (to !== path.join(f.storage, "tasks", "parent", "history_item.json")) return
		entered.release()
		await finish.promise
	}
	try {
		const running = ClineProvider.prototype.delegateParentAndOpenChild.call(f.provider, params)
		await entered.promise
		await expect(bindTargetPersistence(f.alias, "parent", action)).rejects.toThrow(/parent/i)
		await expect(withProviderStartExclusion(f.alias, "parent", async () => {})).rejects.toThrow(/parent/i)
		await f.competitor.upsert(record("other", { tokensOut: 99 }))
		finish.release()
		await running
		expect((await f.read("parent")).awaitingChildId).toBe("child")
		expect((await f.read("child")).parentTaskId).toBe("parent")
		expect((await f.read("other")).tokensOut).toBe(99)
		expect(f.scheduler.schedule).toHaveBeenCalledOnce()
	} finally {
		finish.release()
		await f.close()
	}
})

for (const change of ["mode", "message", "todos", "approval", "question", "owner"] as const) {
	it(`fresh parent commit refuses same action ID with changed ${change}`, async () => {
		const f = await fixture()
		const orderedTodos = [
			{ id: "a", content: "first", status: "pending" as const },
			{ id: "b", content: "second", status: "pending" as const },
		]
		if (change === "todos")
			await f.store.upsert(record("parent", { pendingAction: { ...action, todos: orderedTodos } }))
		const originalUpdate = f.provider.updateTaskHistory.bind(f.provider)
		vi.spyOn(f.provider, "updateTaskHistory").mockImplementation(async (item, options) => {
			await originalUpdate(item, options)
			if (item.id !== "child") return []
			const current = await f.read("parent")
			const changed = structuredClone(current)
			if (changed.pendingAction?.kind !== "create_subtask") throw new Error("fixture action missing")
			if (change === "mode") changed.pendingAction!.mode = "ask"
			if (change === "message") changed.pendingAction!.message = "changed"
			if (change === "todos")
				changed.pendingAction!.todos = [
					{ id: "b", content: "second", status: "pending" },
					{ id: "a", content: "first", status: "pending" },
				]
			if (change === "approval") changed.pendingAction!.approvalText = "changed"
			if (change === "question")
				changed.pendingQuestion = { id: "changed", taskId: "parent", toolCallId: "call", text: "changed" }
			if (change === "owner") changed.awaitingChildId = "known-owner"
			await fs.writeFile(path.join(f.storage, "tasks", "parent", "history_item.json"), JSON.stringify(changed))
			return []
		})
		try {
			const failure = await expectRecoverable(
				ClineProvider.prototype.delegateParentAndOpenChild.call(f.provider, {
					...params,
					initialTodos: change === "todos" ? orderedTodos : [],
				}),
				{
					type: GuardedPublicationError,
					message: /UNKNOWN\/BLOCKED/,
				},
			)
			expect(failure.originalError).toHaveProperty("outcome", "UNKNOWN/BLOCKED")
			if (!(failure.originalError instanceof GuardedPublicationError)) throw failure
			expect(failure.originalError.originalError).toBeInstanceOf(OrdinaryPersistenceAuthorityError)
			expect(failure.originalError.originalError).toHaveProperty(
				"message",
				"Ordinary persistence authority refused: Pending action, owner, revision or question changed before commit",
			)
			expect((await f.read("parent")).awaitingChildId).toBe(change === "owner" ? "known-owner" : undefined)
			expect((await f.read("child")).parentTaskId).toBe("parent")
			expect(f.scheduler.schedule).not.toHaveBeenCalled()
			expect(f.provider.createTask).toHaveBeenCalledOnce()
		} finally {
			await f.close()
		}
	})
}

it("parent replacement commit-then-error keeps exact committed ownership and child evidence without enqueue or retry", async () => {
	const f = await fixture()
	const replacementError = new Error("commit-then-error")
	let commits = 0
	diskGate.afterRename = async (_from, to) => {
		if (to !== path.join(f.storage, "tasks", "parent", "history_item.json")) return
		commits++
		throw replacementError
	}
	try {
		const failure = await expectRecoverable(
			ClineProvider.prototype.delegateParentAndOpenChild.call(f.provider, params),
			{
				type: GuardedPublicationError,
				message: /UNKNOWN\/BLOCKED/,
			},
		)
		expect(failure.originalError).toHaveProperty("outcome", "UNKNOWN/BLOCKED")
		expect(failure.originalError).toHaveProperty("originalError", replacementError)
		expect(commits).toBe(1)
		expect((await f.read("parent")).awaitingChildId).toBe("child")
		expect((await f.read("parent")).pendingAction).toBeUndefined()
		expect((await f.read("child")).parentTaskId).toBe("parent")
		expect(f.child.dispose).not.toHaveBeenCalled()
		expect(f.scheduler.schedule).not.toHaveBeenCalled()
	} finally {
		await f.close()
	}
})

it("actual generation loss after backup copy refuses parent replacement and preserves exact old action plus prepared child", async () => {
	const f = await fixture()
	const before = await f.read("parent")
	let replacement = 0
	diskGate.beforeRename = async (_from, to) => {
		if (to === path.join(f.storage, "tasks", "parent", "history_item.json")) replacement++
	}
	diskGate.afterCopy = async (from) => {
		if (from !== path.join(f.storage, "tasks", "parent", "history_item.json")) return
		const key = crypto.createHash("sha256").update("parent").digest("hex")
		await fs.writeFile(path.join(f.storage, ".handoff-fences", `${key}.generation`), "999")
	}
	try {
		await expect(ClineProvider.prototype.delegateParentAndOpenChild.call(f.provider, params)).rejects.toThrow(
			/generation|ownership/i,
		)
		expect(await f.read("parent")).toEqual(before)
		expect((await f.read("child")).parentTaskId).toBe("parent")
		expect(replacement).toBe(0)
		expect(f.scheduler.schedule).not.toHaveBeenCalled()
		expect(f.child.dispose).not.toHaveBeenCalled()
	} finally {
		await f.close()
	}
})
