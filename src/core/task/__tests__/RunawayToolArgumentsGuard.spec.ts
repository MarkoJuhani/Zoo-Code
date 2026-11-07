// npx vitest run core/task/__tests__/RunawayToolArgumentsGuard.spec.ts

import {
	RUNAWAY_TOOL_ARGUMENT_LIMIT_BYTES,
	RUNAWAY_TOOL_ARGUMENT_LIMIT_DELTAS,
	RunawayToolArgumentsError,
	RunawayToolArgumentsGuard,
	runawayToolArgumentsNote,
} from "../RunawayToolArgumentsGuard"

describe("RunawayToolArgumentsGuard", () => {
	it("uses a 32 KB limit by default", () => {
		expect(RUNAWAY_TOOL_ARGUMENT_LIMIT_BYTES).toBe(32 * 1024)
	})

	it("uses a 900-piece limit by default", () => {
		expect(RUNAWAY_TOOL_ARGUMENT_LIMIT_DELTAS).toBe(900)
	})

	it("stops a guarded tool whose small arguments keep arriving one character at a time", () => {
		const guard = new RunawayToolArgumentsGuard()

		expect(guard.check({ index: 0, name: "read_file", arguments: "{" })).toBeUndefined()
		for (let piece = 2; piece < RUNAWAY_TOOL_ARGUMENT_LIMIT_DELTAS; piece++) {
			expect(guard.check({ index: 0, arguments: " " })).toBeUndefined()
		}
		// A chunk without argument text is not a piece.
		expect(guard.check({ index: 0, name: "read_file" })).toBeUndefined()
		const error = guard.check({ index: 0, arguments: " " })

		expect(error).toMatchObject({
			toolName: "read_file",
			argBytes: RUNAWAY_TOOL_ARGUMENT_LIMIT_DELTAS,
			argDeltas: RUNAWAY_TOOL_ARGUMENT_LIMIT_DELTAS,
			limitDeltas: RUNAWAY_TOOL_ARGUMENT_LIMIT_DELTAS,
			limit: "pieces",
		})
		expect(error?.message).toContain("900 pieces")
	})

	it("never stops write tools that arrive in many pieces", () => {
		const guard = new RunawayToolArgumentsGuard()

		guard.check({ index: 0, name: "apply_diff", arguments: "{" })
		for (let piece = 0; piece < RUNAWAY_TOOL_ARGUMENT_LIMIT_DELTAS * 2; piece++) {
			expect(guard.check({ index: 0, arguments: "x" })).toBeUndefined()
		}
	})

	it("counts replaced arguments as one piece", () => {
		const guard = new RunawayToolArgumentsGuard(Infinity, 3)

		guard.check({ index: 0, name: "read_file", arguments: "{" })
		guard.check({ index: 0, arguments: "a" })
		expect(guard.check({ index: 0, arguments: "{}", replaceArguments: true })).toBeUndefined()
		expect(guard.check({ index: 0, arguments: "b" })).toBeUndefined()
		expect(guard.check({ index: 0, arguments: "c" })).toMatchObject({ argDeltas: 3, limit: "pieces" })
	})

	it("stops a guarded tool once its arguments reach the limit", () => {
		const guard = new RunawayToolArgumentsGuard(10)

		expect(guard.check({ index: 0, name: "read_file", arguments: "{" })).toBeUndefined()
		expect(guard.check({ index: 0, arguments: "12345678" })).toBeUndefined()
		const error = guard.check({ index: 0, arguments: "9" })

		expect(error).toBeInstanceOf(RunawayToolArgumentsError)
		expect(error).toMatchObject({ toolName: "read_file", argBytes: 10, limitBytes: 10 })
	})

	it("never stops write, edit, or free-text tools", () => {
		const guard = new RunawayToolArgumentsGuard(10)

		for (const [index, name] of ["write_to_file", "apply_diff", "execute_command", "new_task"].entries()) {
			expect(guard.check({ index, name, arguments: "x".repeat(1_000) })).toBeUndefined()
		}
	})

	it("counts replaced arguments by their new size and tracks calls separately", () => {
		const guard = new RunawayToolArgumentsGuard(10)

		guard.check({ index: 0, name: "read_file", arguments: "123456789" })
		expect(guard.check({ index: 0, arguments: "{}", replaceArguments: true })).toBeUndefined()
		expect(guard.check({ index: 1, name: "list_files", arguments: "123456789" })).toBeUndefined()
		expect(guard.check({ index: 0, arguments: "1234567" })).toBeUndefined()
	})

	it("starts a new count when a new call reuses an index", () => {
		const guard = new RunawayToolArgumentsGuard(10)

		guard.check({ index: 0, id: "call_1", name: "read_file", arguments: "123456789" })
		expect(
			guard.check({ index: 0, id: "call_2", name: "write_to_file", arguments: "x".repeat(100) }),
		).toBeUndefined()
		expect(guard.check({ index: 0, id: "call_3", name: "read_file", arguments: "123456789" })).toBeUndefined()
	})

	it("waits for the tool name before judging the size", () => {
		const guard = new RunawayToolArgumentsGuard(10)

		expect(guard.check({ index: 0, arguments: "x".repeat(20) })).toBeUndefined()
		expect(guard.check({ index: 0, name: "read_file" })).toBeInstanceOf(RunawayToolArgumentsError)
	})

	it("writes a note that names the tool and limit but no argument content", () => {
		const note = runawayToolArgumentsNote(new RunawayToolArgumentsError("read_file", 40_000, 32_768))

		expect(note).toContain("read_file")
		expect(note).toContain("32768")
		expect(note).not.toContain("40000")
	})

	it("writes a size-free note when the piece limit stopped the call", () => {
		const note = runawayToolArgumentsNote(new RunawayToolArgumentsError("read_file", 900, 32_768, 900, 900))

		expect(note).toContain("read_file")
		expect(note).toContain("kept growing")
		expect(note).not.toContain("32768")
	})
})
