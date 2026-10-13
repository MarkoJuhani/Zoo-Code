import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import type { HistoryItem } from "@roo-code/types"
import { ParentHandoffFence } from "../parentHandoffFence"
import { TaskHistoryStore } from "../TaskHistoryStore"
import { readApiMessages, saveApiMessages, type ApiMessage } from "../apiMessages"
import { registerPendingQuestion } from "../taskLifecycle"
import { b1Fixture } from "./manualSupersedeB1.fixture"

function pause() {
	let arrived!: () => void
	let release!: () => void
	const reached = new Promise<void>((resolve) => {
		arrived = resolve
	})
	const resumed = new Promise<void>((resolve) => {
		release = resolve
	})
	return {
		reached,
		release,
		wait: async () => {
			arrived()
			await resumed
		},
	}
}
const item = (id: string): HistoryItem => ({
	id,
	number: 1,
	ts: 1,
	task: id,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	status: "interrupted",
	childIds: [],
})

describe("B1 actual bypass witnesses: integration MUST remain unwired", () => {
	it("a paused stale API save overwrites a result despite a real parent fence", async () => {
		const storage = await fs.mkdtemp(path.join(os.tmpdir(), "b1-api-bypass-"))
		const barrier = pause()
		try {
			const { history } = b1Fixture()
			await saveApiMessages({ globalStoragePath: storage, taskId: "parent", messages: history })
			const stale = history.slice(0, 2)
			const pending = (async () => {
				await barrier.wait()
				return saveApiMessages({ globalStoragePath: storage, taskId: "parent", messages: stale })
			})()
			await barrier.reached
			const lease = await new ParentHandoffFence(storage).acquire("parent")
			try {
				await lease.assertOwned()
				await saveApiMessages({
					globalStoragePath: storage,
					taskId: "other",
					messages: [{ role: "user", content: "unrelated" }],
				})
				barrier.release()
				await pending
				const saved: ApiMessage[] = await readApiMessages({ globalStoragePath: storage, taskId: "parent" })
				expect(saved).toHaveLength(2)
				expect(JSON.stringify(saved)).not.toContain("zoo.manual_supersede.B1.v1:")
				await lease.assertOwned() // Owning this scaffold does not fence the actual writer.
			} finally {
				await lease.release()
			}
		} finally {
			barrier.release()
			await fs.rm(storage, { recursive: true, force: true })
		}
	})

	it("paused task prepare/commit and question/deletion effects bypass the parent fence", async () => {
		const storage = await fs.mkdtemp(path.join(os.tmpdir(), "b1-task-bypass-"))
		const store = new TaskHistoryStore(storage)
		const barrier = pause()
		let pending: Promise<unknown> | undefined
		try {
			await store.initialize()
			await store.upsert(item("parent"))
			await store.upsert(item("other"))
			const original = store["writeTaskFile"].bind(store)
			Reflect.set(store, "writeTaskFile", async (value: HistoryItem, delta?: Partial<HistoryItem>) => {
				await barrier.wait()
				return original(value, delta)
			})
			pending = store.atomicReadAndUpdate("parent", (current) => ({
				...current,
				pendingAction: {
					kind: "create_subtask",
					actionId: "late",
					mode: "code",
					message: "late",
					todos: [],
					approvalText: "late",
				},
			}))
			await barrier.reached
			const lease = await new ParentHandoffFence(storage).acquire("parent")
			try {
				barrier.release()
				await pending
				Reflect.set(store, "writeTaskFile", original)
				expect(await store.readAuthoritative("parent")).toMatchObject({
					kind: "found",
					item: { pendingAction: { actionId: "late" } },
				})
				for (const taskId of ["other", "parent"]) {
					await store.updateQuestion(taskId, (current) =>
						registerPendingQuestion(current, {
							id: "question",
							taskId,
							toolCallId: "question-call",
							text: "ordinary question",
						}),
					)
					expect(await store.readAuthoritative(taskId)).toMatchObject({
						kind: "found",
						item: { pendingQuestion: { id: "question" } },
					})
				}
				await store.delete("parent")
				expect(await store.readAuthoritative("parent")).toMatchObject({ kind: "missing" })
				await lease.assertOwned()
			} finally {
				await lease.release()
			}
		} finally {
			barrier.release()
			await pending?.catch(() => {})
			store.dispose()
			await fs.rm(storage, { recursive: true, force: true })
		}
	})

	it("lost fence generation refuses ownership, but cannot retroactively guard nonparticipants", async () => {
		const storage = await fs.mkdtemp(path.join(os.tmpdir(), "b1-lost-fence-"))
		try {
			const lease = await new ParentHandoffFence(storage).acquire("parent")
			const entries = await fs.readdir(path.join(storage, ".handoff-fences"))
			const lock = entries.find((entry) => entry.includes("lock"))
			if (!lock) throw new Error("Fixture fence lock directory not found")
			const lockPath = path.join(storage, ".handoff-fences", lock)
			const ownerFile = (await fs.readdir(lockPath)).find((entry) => entry.includes("owner"))
			if (!ownerFile) throw new Error("Fixture owner file not found")
			const ownerPath = path.join(lockPath, ownerFile)
			const owner = JSON.parse(await fs.readFile(ownerPath, "utf8")) as { generation: number }
			await fs.writeFile(ownerPath, JSON.stringify({ ...owner, generation: owner.generation + 1 }))
			await expect(lease.assertOwned()).rejects.toThrow("ownership was lost")
			await expect(lease.release()).rejects.toThrow("ownership was lost")
		} finally {
			await fs.rm(storage, { recursive: true, force: true })
		}
	})
})
