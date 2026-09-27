import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import type { HistoryItem, PendingQuestion } from "@roo-code/types"
import { TaskHistoryStore } from "../TaskHistoryStore"
import { registerPendingQuestion, answerPendingQuestion, clearPendingQuestion } from "../taskLifecycle"

const item: HistoryItem = { id: "task", number: 1, ts: 1, task: "question", tokensIn: 0, tokensOut: 0, totalCost: 0 }
const question: PendingQuestion = { id: "q1", taskId: "task", toolCallId: "call", text: "Choose?" }

describe("pending questions through real atomic persistence", () => {
	let directory: string
	let first: TaskHistoryStore
	let second: TaskHistoryStore
	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-question-"))
		first = new TaskHistoryStore(directory)
		second = new TaskHistoryStore(directory)
		await first.initialize()
		await first.upsert(item)
		await second.initialize()
	})
	afterEach(async () => {
		first.dispose()
		second.dispose()
		await fs.rm(directory, { recursive: true, force: true })
	})

	it("reloads waiting and accepted answers, preserving identity and explicit empty input", async () => {
		await first.updateQuestion("task", (current) => registerPendingQuestion(current, question))
		await second.invalidate("task")
		expect(second.get("task")?.pendingQuestion).toEqual(question)
		await second.updateQuestion("task", (current) =>
			answerPendingQuestion(current, "q1", { text: "", images: ["image"] }),
		)
		await first.invalidate("task")
		expect(first.get("task")?.pendingQuestion?.answer).toEqual({ text: "", images: ["image"] })
		await first.updateQuestion("task", (current) => clearPendingQuestion(current, "q1", "durable_result"))
		await second.invalidate("task")
		expect(second.get("task")?.pendingQuestion).toBeUndefined()
	})

	it("evaluates duplicate and stale ownership against disk, not the caller's cached task", async () => {
		await first.updateQuestion("task", (current) => registerPendingQuestion(current, question))
		await expect(
			second.updateQuestion("task", (current) => registerPendingQuestion(current, { ...question, id: "q2" })),
		).rejects.toThrow()
		await second.updateQuestion("task", (current) => answerPendingQuestion(current, "q1", { text: "first" }))
		await first.updateQuestion("task", (current) => answerPendingQuestion(current, "q1", { text: "duplicate" }))
		expect(first.get("task")?.pendingQuestion?.answer?.text).toBe("first")
		await second.updateQuestion("task", (current) => clearPendingQuestion(current, "q1", "replace"))
		await second.updateQuestion("task", (current) => registerPendingQuestion(current, { ...question, id: "q2" }))
		await first.updateQuestion("task", (current) => clearPendingQuestion(current, "q1", "durable_result"))
		expect(first.get("task")?.pendingQuestion?.id).toBe("q2")
	})

	it("preserves question state through unrelated stale metadata updates", async () => {
		await first.updateQuestion("task", (current) => registerPendingQuestion(current, question))
		await second.upsert({ ...item, totalCost: 7 })
		await first.invalidate("task")
		expect(first.get("task")).toMatchObject({ totalCost: 7, pendingQuestion: question })
	})
})
