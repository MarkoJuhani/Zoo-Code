import type { ToolName } from "@roo-code/types"

/**
 * Argument size at which a guarded tool call is treated as a runaway stream. Normal calls of
 * these tools stay under 1 KB; observed runaways kept growing past 300 KB until the output cap.
 */
export const RUNAWAY_TOOL_ARGUMENT_LIMIT_BYTES = 32 * 1024

/**
 * Number of argument pieces (stream deltas) at which a guarded tool call is treated as a runaway.
 * Normal calls of these tools arrive in under 100 pieces; a slow runaway added one character per
 * piece and would take minutes to reach the byte limit.
 */
export const RUNAWAY_TOOL_ARGUMENT_LIMIT_DELTAS = 900

/**
 * Tools whose arguments are small by design. Writes, edits, and free-text tools are left out:
 * their arguments carry file content or prose and can legitimately be large.
 */
const guardedTools: readonly ToolName[] = [
	"read_file",
	"list_files",
	"search_files",
	"codebase_search",
	"read_command_output",
	"access_mcp_resource",
	"switch_mode",
	"skill",
	"run_slash_command",
	"update_todo_list",
]
export const RUNAWAY_GUARDED_TOOLS: ReadonlySet<string> = new Set(guardedTools)

export class RunawayToolArgumentsError extends Error {
	constructor(
		readonly toolName: string,
		readonly argBytes: number,
		readonly limitBytes: number,
		readonly argDeltas = 0,
		readonly limitDeltas = RUNAWAY_TOOL_ARGUMENT_LIMIT_DELTAS,
	) {
		super(
			argBytes >= limitBytes
				? `Stopped a runaway ${toolName} call: its arguments reached ${argBytes} bytes (limit ${limitBytes}).`
				: `Stopped a runaway ${toolName} call: its arguments arrived in ${argDeltas} pieces (limit ${limitDeltas}).`,
		)
		this.name = "RunawayToolArgumentsError"
	}

	/** Which limit stopped the call: total size, or the number of pieces. */
	get limit(): "size" | "pieces" {
		return this.argBytes >= this.limitBytes ? "size" : "pieces"
	}
}

/** Model-facing note added before the retry; it names the tool and limit, never the arguments. */
export function runawayToolArgumentsNote(error: RunawayToolArgumentsError): string {
	if (error.limit === "pieces") {
		return (
			`[ERROR] Your previous response was stopped: the arguments of your ${error.toolName} call kept growing ` +
			`without ending. Call ${error.toolName} again with only the arguments it needs.`
		)
	}
	return (
		`[ERROR] Your previous response was stopped: the arguments of your ${error.toolName} call grew past ` +
		`${error.limitBytes} bytes without ending. Call ${error.toolName} again with only the arguments it needs.`
	)
}

/**
 * Tracks the argument size and piece count of each streaming tool call in one response. Counts
 * characters as received; it keeps sizes only, never argument content.
 */
export class RunawayToolArgumentsGuard {
	private readonly calls = new Map<number, { id?: string; name?: string; argBytes: number; argDeltas: number }>()

	constructor(
		private readonly limitBytes: number = RUNAWAY_TOOL_ARGUMENT_LIMIT_BYTES,
		private readonly limitDeltas: number = RUNAWAY_TOOL_ARGUMENT_LIMIT_DELTAS,
	) {}

	/** Returns an error once a guarded tool's arguments reach either limit; otherwise undefined. */
	check(chunk: {
		index: number
		id?: string
		name?: string
		arguments?: string
		replaceArguments?: boolean
	}): RunawayToolArgumentsError | undefined {
		let call = this.calls.get(chunk.index) ?? { argBytes: 0, argDeltas: 0 }
		// A new id at a known index is a new call (some streams reuse index 0); never mix their sizes.
		if (chunk.id !== undefined && call.id !== undefined && chunk.id !== call.id)
			call = { argBytes: 0, argDeltas: 0 }
		call.id ??= chunk.id
		call.name = chunk.name ?? call.name
		const argBytes = chunk.arguments?.length ?? 0
		call.argBytes = chunk.replaceArguments ? argBytes : call.argBytes + argBytes
		if (argBytes > 0) call.argDeltas = chunk.replaceArguments ? 1 : call.argDeltas + 1
		this.calls.set(chunk.index, call)

		if (call.name === undefined || !RUNAWAY_GUARDED_TOOLS.has(call.name)) return undefined
		if (call.argBytes < this.limitBytes && call.argDeltas < this.limitDeltas) return undefined
		return new RunawayToolArgumentsError(
			call.name,
			call.argBytes,
			this.limitBytes,
			call.argDeltas,
			this.limitDeltas,
		)
	}
}
