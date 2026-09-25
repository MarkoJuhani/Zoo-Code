import type { ApiMessage } from "../../task-persistence"

import {
	DELEGATED_CHILD_COMPLETION_REPAIR,
	hasPersistedCompletionRepair,
	isRecognizableWorkerEnvelope,
} from "../childCompletionProtocol"

describe("delegated child completion protocol", () => {
	it.each(["STATUS=SUCCESS\nFACTS=done", "  STATUS=NEEDS_PARENT\r\nBLOCKER=missing evidence"])(
		"recognizes a canonical worker envelope: %s",
		(text) => {
			expect(isRecognizableWorkerEnvelope(text)).toBe(true)
		},
	)

	it.each(["Done", "prefix STATUS=SUCCESS", "STATUS=SUCCESSFUL", ""])("rejects non-envelope text: %s", (text) => {
		expect(isRecognizableWorkerEnvelope(text)).toBe(false)
	})

	it("detects only the exact persisted repair user block", () => {
		const messages = [
			{
				role: "user",
				content: [
					{ type: "text", text: DELEGATED_CHILD_COMPLETION_REPAIR },
					{ type: "text", text: "<environment_details>ignored</environment_details>" },
				],
			},
		] as ApiMessage[]

		expect(hasPersistedCompletionRepair(messages)).toBe(true)
		expect(
			hasPersistedCompletionRepair([
				{ role: "assistant", content: [{ type: "text", text: DELEGATED_CHILD_COMPLETION_REPAIR }] },
			] as ApiMessage[]),
		).toBe(false)
	})
})
