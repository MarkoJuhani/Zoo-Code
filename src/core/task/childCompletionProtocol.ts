import type { ApiMessage } from "../task-persistence"

export const DELEGATED_CHILD_COMPLETION_REPAIR =
	"You are a delegated child. Call attempt_completion now with the handoff. Do not address the end user."

export function isRecognizableWorkerEnvelope(text: string): boolean {
	const firstLine = text.trimStart().split(/\r?\n/, 1)[0]?.trimEnd()
	return firstLine === "STATUS=SUCCESS" || firstLine === "STATUS=NEEDS_PARENT"
}

export function hasPersistedCompletionRepair(messages: readonly ApiMessage[]): boolean {
	return messages.some(
		(message) =>
			message.role === "user" &&
			Array.isArray(message.content) &&
			message.content.some((block) => block.type === "text" && block.text === DELEGATED_CHILD_COMPLETION_REPAIR),
	)
}
