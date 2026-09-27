import assert from "node:assert/strict"
import type { HistoryItem, PendingQuestion } from "../packages/types/src/history"
import {
	registerPendingQuestion,
	answerPendingQuestion,
	clearPendingQuestion,
} from "../src/core/task-persistence/taskLifecycle"

const initial: HistoryItem = {
	id: "task",
	number: 1,
	ts: 1,
	task: "question model",
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
}
const questions: PendingQuestion[] = ["q1", "q2"].map((id) => ({ id, taskId: "task", toolCallId: id, text: "Choose?" }))
const queue = [{ item: initial, depth: 0, trace: [] as string[] }]
const seen = new Set<string>()
const landmarks = new Set<string>()
const MAX_DEPTH = 8
const MAX_STATES = 100
for (let cursor = 0; cursor < queue.length; cursor++) {
	const { item, depth, trace } = queue[cursor]
	const key = JSON.stringify(item)
	if (seen.has(key)) continue
	seen.add(key)
	assert(seen.size <= MAX_STATES, `Question model budget exceeded: ${trace}`)
	const pending = item.pendingQuestion
	if (pending) {
		assert.equal(pending.taskId, item.id)
		assert.deepEqual(answerPendingQuestion(item, "stale", { text: "wrong" }), item)
		assert.deepEqual(clearPendingQuestion(item, "stale", "replace"), item)
		assert.throws(() => registerPendingQuestion(item, questions[0]))
		const interrupted = structuredClone(item)
		assert.deepEqual(interrupted.pendingQuestion, pending)
		landmarks.add("interruption-retains-question")
		if (pending.answer) {
			assert.deepEqual(answerPendingQuestion(item, pending.id, { text: "duplicate" }), item)
			landmarks.add("duplicate-answer-rejected")
		} else {
			assert.throws(() => clearPendingQuestion(item, pending.id, "durable_result"))
			landmarks.add("synthetic-result-not-answer")
		}
	}
	if (depth === MAX_DEPTH) continue
	const add = (name: string, next: HistoryItem) => {
		landmarks.add(name)
		queue.push({ item: next, depth: depth + 1, trace: [...trace, name] })
	}
	if (!pending) for (const question of questions) add("register", registerPendingQuestion(item, question))
	else {
		if (!pending.answer) {
			add("explicit-empty-answer", answerPendingQuestion(item, pending.id, { text: "" }))
			add("image-answer", answerPendingQuestion(item, pending.id, { text: "", images: ["image"] }))
		} else add("durable-result", clearPendingQuestion(item, pending.id, "durable_result"))
		add("abandon", clearPendingQuestion(item, pending.id, "abandon"))
		add("replace", clearPendingQuestion(item, pending.id, "replace"))
	}
}
for (const landmark of [
	"register",
	"explicit-empty-answer",
	"image-answer",
	"durable-result",
	"abandon",
	"replace",
	"interruption-retains-question",
	"duplicate-answer-rejected",
	"synthetic-result-not-answer",
])
	assert(landmarks.has(landmark), `Missing ${landmark}`)
console.log(`Pending-question model passed: ${seen.size} states, depth ${MAX_DEPTH}, budget ${MAX_STATES}`)
