import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { HistoryItem } from "@roo-code/types"

import {
	abandonDelegatedChild,
	advanceOrdinaryPersistenceRevision,
	matchesOrdinaryPersistenceAuthority,
	matchesOrdinaryHistorySnapshot,
	ordinaryPersistenceIdentity,
	type OrdinaryAuthorityHistoryItem,
	blockDelegatedChildProtocol,
	completeDelegatedChild,
	delegateTaskToChild,
	type HistoryItemStatus,
	interruptDelegatedChild,
	LifecycleTransitionError,
	resumeInterruptedTask,
	VALID_TASK_STATUS_TRANSITIONS,
} from "../taskLifecycle"
import { TaskHistoryStore } from "../TaskHistoryStore"
import {
	advanceOrdinaryPersistenceAuthority,
	createOrdinaryTaskPersistenceAuthority,
	isPersistenceAuthorityError,
	withOrdinaryTaskPersistence,
} from "../targetPersistenceBoundary"

function item(id: string, overrides: Partial<HistoryItem> = {}): HistoryItem {
	return {
		id,
		number: 1,
		ts: 1,
		task: id,
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		status: "active",
		...overrides,
	}
}

describe("task lifecycle transitions", () => {
	it("delegates an active parent and retains child history", () => {
		const parent = delegateTaskToChild(item("parent", { childIds: ["older"] }), "child")

		expect(parent).toMatchObject({
			status: "delegated",
			awaitingChildId: "child",
			delegatedToId: "child",
			childIds: ["older", "child"],
		})
	})

	it("treats a legacy unset status as active when delegating", () => {
		expect(delegateTaskToChild(item("parent", { status: undefined }), "child")).toMatchObject({
			status: "delegated",
			awaitingChildId: "child",
			delegatedToId: "child",
		})
	})

	it("allows re-delegation only after the previous child is interrupted", () => {
		const parent = item("parent", {
			status: "delegated",
			awaitingChildId: "old-child",
			delegatedToId: "old-child",
			childIds: ["old-child"],
		})

		expect(() => delegateTaskToChild(parent, "new-child", "active")).toThrow(/not interrupted/)
		expect(delegateTaskToChild(parent, "new-child", "interrupted")).toMatchObject({
			status: "delegated",
			awaitingChildId: "new-child",
			childIds: ["old-child", "new-child"],
		})
	})

	it("blocks a correlated child protocol error while retaining the parent delegation", () => {
		const parent = item("parent", { status: "delegated", awaitingChildId: "child", delegatedToId: "child" })
		const child = item("child", { status: "active", parentTaskId: "parent" })
		const blocked = blockDelegatedChildProtocol(parent, child)

		expect(blocked.child).toMatchObject({
			status: "blocked_protocol_error",
			protocolErrorCode: "missing_attempt_completion",
		})
		expect(blocked.parent).toMatchObject({
			status: "blocked_protocol_error",
			awaitingChildId: "child",
			protocolErrorCode: "missing_attempt_completion",
			protocolErrorChildId: "child",
		})
	})

	it("allows a blocked child to recover through native completion", () => {
		const parent = item("parent", {
			status: "delegated",
			awaitingChildId: "child",
			protocolErrorCode: "missing_attempt_completion",
			protocolErrorChildId: "child",
		})
		const child = item("child", {
			status: "blocked_protocol_error",
			parentTaskId: "parent",
			protocolErrorCode: "missing_attempt_completion",
		})
		const completed = completeDelegatedChild(parent, child, "handoff")

		expect(completed.child).toMatchObject({ status: "completed", protocolErrorCode: undefined })
		expect(completed.parent).toMatchObject({
			status: "active",
			protocolErrorCode: undefined,
			protocolErrorChildId: undefined,
		})
	})

	it("interrupts a child without clearing the parent's ownership", () => {
		const parent = item("parent", { status: "delegated", awaitingChildId: "child", delegatedToId: "child" })
		const child = item("child", { parentTaskId: "parent" })

		expect(interruptDelegatedChild(parent, child)).toMatchObject({ status: "interrupted", parentTaskId: "parent" })
	})

	it("interrupts a blocked child without clearing the parent's ownership", () => {
		const parent = item("parent", {
			status: "blocked_protocol_error",
			awaitingChildId: "child",
			delegatedToId: "child",
		})
		const child = item("child", { status: "blocked_protocol_error", parentTaskId: "parent" })

		expect(interruptDelegatedChild(parent, child)).toMatchObject({ status: "interrupted", parentTaskId: "parent" })
	})

	it("completes only the child the parent still awaits", () => {
		const parent = item("parent", { status: "delegated", awaitingChildId: "new-child", delegatedToId: "new-child" })
		const staleChild = item("old-child", { status: "interrupted", parentTaskId: "parent" })

		expect(() => completeDelegatedChild(parent, staleChild, "stale result")).toThrow(/not delegated to child/)

		const child = item("new-child", { parentTaskId: "parent" })
		const completed = completeDelegatedChild(parent, child, "result")
		expect(completed.child.status).toBe("completed")
		expect(completed.parent).toMatchObject({
			status: "active",
			completedByChildId: "new-child",
			awaitingChildId: undefined,
		})
	})

	it("repairs an active parent that still awaits the returning child", () => {
		const parent = item("parent", { status: "active", awaitingChildId: "child", delegatedToId: "child" })
		const child = item("child", { status: "interrupted", parentTaskId: "parent" })

		expect(completeDelegatedChild(parent, child, "result").parent).toMatchObject({
			status: "active",
			completedByChildId: "child",
			awaitingChildId: undefined,
		})
	})

	it("abandons only an interrupted child and clears both sides of the live link", () => {
		const parent = item("parent", { status: "delegated", awaitingChildId: "child", delegatedToId: "child" })
		const activeChild = item("child", { parentTaskId: "parent", rootTaskId: "parent" })

		expect(() => abandonDelegatedChild(parent, activeChild)).toThrow(/status active/)

		const abandoned = abandonDelegatedChild(parent, { ...activeChild, status: "interrupted" })
		expect(abandoned.parent).toMatchObject({ status: "active", awaitingChildId: undefined })
		expect(abandoned.child).toMatchObject({ parentTaskId: undefined, rootTaskId: undefined })
	})
})

describe("resuming an interrupted task", () => {
	const delegatedParent = (awaited: string, status: HistoryItemStatus = "delegated") =>
		item("parent", { status, awaitingChildId: awaited, delegatedToId: awaited, childIds: [awaited] })

	it.each(["delegated", "blocked_protocol_error"] as const)(
		"restores the child a %s parent still awaits without touching its link",
		(parentStatus) => {
			const child = item("child", { status: "interrupted", parentTaskId: "parent", rootTaskId: "parent" })
			const resumed = resumeInterruptedTask(child, delegatedParent("child", parentStatus))

			expect(resumed).toEqual({ ...child, status: "active" })
			expect(child.status).toBe("interrupted")
		},
	)

	it("lets a resumed child delegate again", () => {
		const child = item("child", { status: "interrupted", parentTaskId: "parent" })
		const resumed = resumeInterruptedTask(child, delegatedParent("child"))

		expect(delegateTaskToChild(resumed, "grandchild")).toMatchObject({
			status: "delegated",
			awaitingChildId: "grandchild",
		})
	})

	it("restores an unlinked or abandoned task without a parent", () => {
		expect(resumeInterruptedTask(item("root", { status: "interrupted" })).status).toBe("active")

		const abandoned = abandonDelegatedChild(
			delegatedParent("child"),
			item("child", { status: "interrupted", parentTaskId: "parent", rootTaskId: "parent" }),
		).child
		expect(resumeInterruptedTask(abandoned)).toMatchObject({ status: "active", parentTaskId: undefined })
	})

	it("refuses a child superseded by re-delegation to another child", () => {
		const staleChild = item("old-child", { status: "interrupted", parentTaskId: "parent" })
		const redelegated = delegateTaskToChild(delegatedParent("old-child"), "new-child", "interrupted")

		expect(() => resumeInterruptedTask(staleChild, redelegated)).toThrow(LifecycleTransitionError)
		expect(() => resumeInterruptedTask(staleChild, redelegated)).toThrow(/no longer awaits/)
	})

	it.each([
		["a parent that awaits no child", item("parent", { status: "active" })],
		["a completed parent", item("parent", { status: "completed" })],
		["a missing parent", undefined],
		["another task's record", { ...delegatedParent("child"), id: "other-parent" }],
	] satisfies Array<[string, HistoryItem | undefined]>)("refuses a linked child with %s", (_label, parent) => {
		const child = item("child", { status: "interrupted", parentTaskId: "parent" })

		expect(() => resumeInterruptedTask(child, parent)).toThrow(LifecycleTransitionError)
	})

	it.each(["active", "delegated", "completed", "blocked_protocol_error", undefined] as const)(
		"refuses to resume a task whose status is %s",
		(status) => {
			const child = item("child", { status, parentTaskId: "parent" })

			expect(() => resumeInterruptedTask(child, delegatedParent("child"))).toThrow(/Cannot resume/)
		},
	)

	it("keeps interrupted → active out of the ordinary transition table", () => {
		expect(VALID_TASK_STATUS_TRANSITIONS.interrupted).not.toContain("active")
		expect(VALID_TASK_STATUS_TRANSITIONS.interrupted).not.toContain("delegated")
	})

	describe("TaskHistoryStore.resumeInterruptedTask", () => {
		let storage: string
		let store: TaskHistoryStore
		const file = (id: string) => path.join(storage, "tasks", id, "history_item.json")

		beforeEach(async () => {
			storage = await fs.mkdtemp(path.join(os.tmpdir(), "resume-interrupted-store-"))
			store = new TaskHistoryStore(storage)
			await store.initialize()
			store.dispose() // No watcher may race the explicit reads below.
		})

		afterEach(async () => {
			store.dispose()
			await fs.rm(storage, { recursive: true, force: true })
		})

		it("persists active through the reducer while ordinary upserts still cannot", async () => {
			const child = item("child", { status: "interrupted", parentTaskId: "parent", rootTaskId: "parent" })
			await store.upsert(delegatedParent("child"))
			await store.upsert(child)
			await expect(store.upsert({ ...child, status: "active" })).rejects.toThrow(/interrupted → active/)

			const resumed = await store.resumeInterruptedTask("child", ordinaryPersistenceIdentity(child))

			expect(resumed).toMatchObject({ status: "active", parentTaskId: "parent", rootTaskId: "parent" })
			expect(JSON.parse(await fs.readFile(file("child"), "utf8"))).toMatchObject({ status: "active" })
			expect(store.get("child")?.status).toBe("active")
			expect(JSON.parse(await fs.readFile(file("parent"), "utf8"))).toMatchObject({
				status: "delegated",
				awaitingChildId: "child",
			})
		})

		it("writes nothing when the parent now awaits another child", async () => {
			const child = item("child", { status: "interrupted", parentTaskId: "parent" })
			await store.upsert(delegatedParent("other-child"))
			await store.upsert(child)
			const before = await fs.readFile(file("child"))

			await expect(store.resumeInterruptedTask("child", ordinaryPersistenceIdentity(child))).rejects.toThrow(
				LifecycleTransitionError,
			)
			expect(await fs.readFile(file("child"))).toEqual(before)
		})

		it("refuses a stale instance authority and writes nothing", async () => {
			const child = item("child", { status: "interrupted" })
			await store.upsert(child)
			await store.atomicReadAndUpdate("child", (current) => advanceOrdinaryPersistenceAuthority(current))
			const before = await fs.readFile(file("child"))

			await expect(store.resumeInterruptedTask("child", ordinaryPersistenceIdentity(child))).rejects.toSatisfy(
				isPersistenceAuthorityError,
			)
			expect(await fs.readFile(file("child"))).toEqual(before)
		})
	})
})

describe("question ownership on delegated abandonment", () => {
	it("clears the interrupted child's question without fabricating an answer", () => {
		const parent = item("parent", { status: "delegated", awaitingChildId: "child", delegatedToId: "child" })
		const child = item("child", {
			status: "interrupted",
			parentTaskId: "parent",
			pendingQuestion: { id: "q", taskId: "child", toolCallId: "call", text: "Choose?" },
		})
		expect(abandonDelegatedChild(parent, child).child.pendingQuestion).toBeUndefined()
		expect(child.pendingQuestion?.answer).toBeUndefined()
	})
})

describe("ordinary persistence identity", () => {
	it.each([
		["legacy", undefined],
		["revision-bearing", "revision-0"],
	] as const)("captures immutable %s authority rather than refreshed cache fields", (_label, revision) => {
		const record: OrdinaryAuthorityHistoryItem = {
			...item("child", { parentTaskId: "parent", rootTaskId: "root" }),
			ordinaryPersistenceRevision: revision,
		}
		const authority = ordinaryPersistenceIdentity(record)
		expect(matchesOrdinaryPersistenceAuthority(authority, record)).toBe(true)
		record.parentTaskId = undefined
		record.rootTaskId = undefined
		record.ordinaryPersistenceRevision = "revision-1"
		expect(authority).toEqual({ id: "child", parentTaskId: "parent", rootTaskId: "root", revision })
		expect(matchesOrdinaryPersistenceAuthority(authority, record)).toBe(false)
	})

	it.each([
		["id", { id: "other" }],
		["parent", { parentTaskId: "other" }],
		["root", { rootTaskId: "other" }],
		["revision", { ordinaryPersistenceRevision: "new-revision" }],
	] satisfies Array<[string, Partial<OrdinaryAuthorityHistoryItem>]>)(
		"rejects an independent %s mismatch",
		(_label, change) => {
			const original: OrdinaryAuthorityHistoryItem = {
				...item("child", { parentTaskId: "parent", rootTaskId: "root" }),
				ordinaryPersistenceRevision: "old-revision",
			}
			expect(
				matchesOrdinaryPersistenceAuthority(ordinaryPersistenceIdentity(original), { ...original, ...change }),
			).toBe(false)
		},
	)

	it("advances both abandonment publications without mutating either input", () => {
		const parent = item("parent", { status: "delegated", awaitingChildId: "child", delegatedToId: "child" })
		const child = item("child", { status: "interrupted", parentTaskId: "parent", rootTaskId: "parent" })
		const before = JSON.stringify({ parent, child })
		const abandoned = abandonDelegatedChild(parent, child)
		const nextChild = advanceOrdinaryPersistenceRevision(abandoned.child, "child-next")
		const nextParent = advanceOrdinaryPersistenceRevision(abandoned.parent, "parent-next")
		expect(nextChild).toMatchObject({
			ordinaryPersistenceRevision: "child-next",
			parentTaskId: undefined,
			rootTaskId: undefined,
		})
		expect(nextParent).toMatchObject({ ordinaryPersistenceRevision: "parent-next", awaitingChildId: undefined })
		expect(matchesOrdinaryPersistenceAuthority(ordinaryPersistenceIdentity(child), nextChild)).toBe(false)
		expect(matchesOrdinaryPersistenceAuthority(ordinaryPersistenceIdentity(parent), nextParent)).toBe(false)
		expect(JSON.stringify({ parent, child })).toBe(before)
	})

	it("checks explicit legacy snapshots but leaves generic upserts outside instance authority", () => {
		const legacy = item("child", { parentTaskId: "parent", rootTaskId: "root" })
		const explicit: OrdinaryAuthorityHistoryItem = { ...legacy, ordinaryPersistenceRevision: undefined }
		const changed = advanceOrdinaryPersistenceRevision(legacy, "new")
		expect(matchesOrdinaryHistorySnapshot(explicit, legacy)).toBe(true)
		expect(matchesOrdinaryHistorySnapshot(explicit, changed)).toBe(false)
		expect(matchesOrdinaryHistorySnapshot(explicit, { ...legacy, rootTaskId: "other" })).toBe(false)
		expect(matchesOrdinaryHistorySnapshot(legacy, changed)).toBe(true)
	})

	it("round-trips the internal revision through publication, fresh-store rehydration and another save", async () => {
		const storage = await fs.mkdtemp(path.join(os.tmpdir(), "ordinary-lifecycle-roundtrip-"))
		const writer = new TaskHistoryStore(storage)
		const reader = new TaskHistoryStore(storage)
		try {
			await writer.initialize()
			writer.dispose() // No watcher may race deterministic explicit rehydration below.
			await writer.upsert(item("child", { status: "interrupted" }))
			await writer.atomicReadAndUpdate("child", (current) => advanceOrdinaryPersistenceAuthority(current))
			const file = path.join(storage, "tasks", "child", "history_item.json")
			const published: OrdinaryAuthorityHistoryItem = JSON.parse(await fs.readFile(file, "utf8"))
			expect(published.ordinaryPersistenceRevision).toMatch(/^[0-9a-f-]{36}$/)
			await reader.initialize()
			reader.dispose()
			const rehydrated = reader.get("child") as OrdinaryAuthorityHistoryItem | undefined
			expect(rehydrated).toEqual(published)
			if (!rehydrated) throw new Error("fresh store dropped the record")
			const authority = createOrdinaryTaskPersistenceAuthority(rehydrated)
			expect(authority.revision).toBe(published.ordinaryPersistenceRevision)
			await withOrdinaryTaskPersistence(storage, authority, () => reader.upsert({ ...rehydrated, tokensOut: 5 }))
			expect(JSON.parse(await fs.readFile(file, "utf8"))).toMatchObject({
				ordinaryPersistenceRevision: published.ordinaryPersistenceRevision,
				tokensOut: 5,
			})
			const retained = await fs.readFile(file)
			const stale: OrdinaryAuthorityHistoryItem = {
				...rehydrated,
				ordinaryPersistenceRevision: undefined,
				tokensOut: 99,
			}
			await expect(reader.upsert(stale)).rejects.toSatisfy(isPersistenceAuthorityError)
			expect(await fs.readFile(file)).toEqual(retained)
		} finally {
			writer.dispose()
			reader.dispose()
			await fs.rm(storage, { recursive: true, force: true })
		}
	})
})
