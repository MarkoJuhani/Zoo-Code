import type { ApiStreamTransportDiagnostics } from "../../api"
import type { ApiStreamChunk } from "../../api/transform/stream"
import type { RequestPrepSnapshot } from "./RequestPrepTimeline"

/** Quiet periods after which a stall line is logged; the last value then repeats. */
export const STREAM_STALL_THRESHOLDS_MS = [30_000, 60_000, 120_000] as const
/** Interval of progress lines for a long request that keeps receiving chunks. */
export const STREAM_PROGRESS_INTERVAL_MS = 60_000

/**
 * Heuristic limits behind a line's level. Healthy Codex requests measured on 2026-11-05 had a
 * first chunk within 14 s, gaps under 9 s, processing under 1 s, and sent within 3 s.
 */
export const STREAM_ATTENTION_LIMITS = {
	/** Zoo plus handler time before the request is sent, excluding deliberate waits. */
	sendDelayWarnMs: 5_000,
	sendDelayErrorMs: 15_000,
	firstChunkWarnMs: 20_000,
	midStreamGapWarnMs: 15_000,
	processWarnMs: 2_000,
	/** Tool arguments this large suggest a runaway stream rather than a real file write. */
	toolArgErrorBytes: 100_000,
} as const

/**
 * Level word after each line's tag. VS Code's Log highlighting colors ERROR and WARN, so lines
 * that need a fix stand out; grep with `\[stream-[a-z]+\] (WARN|ERROR)`.
 */
export type StreamLogLevel = "INFO" | "WARN" | "ERROR"

export interface StreamStallMonitorOptions {
	log: (line: string) => void
	/** Stable identifiers only; never request or response content. */
	context: { taskId: string; instanceId: string; provider?: string; model: string; retryAttempt: number }
	getTransport?: () => Readonly<ApiStreamTransportDiagnostics> | undefined
	/** Zoo's own preparation of the current request, if it has started. */
	getPrep?: () => RequestPrepSnapshot | undefined
	now?: () => number
	thresholdsMs?: readonly number[]
	progressIntervalMs?: number
}

type MonitorState = "waiting" | "processing" | "finished"

/**
 * Observes one API request stream and logs when it goes quiet, plus one summary line per
 * request. "waiting" covers time inside `iterator.next()` (provider side); "processing" covers
 * time Zoo spends between receiving a chunk and asking for the next one. Logging only: it never
 * changes, delays, or aborts the stream.
 *
 * The first wait also drives Zoo's pre-request work (rate limiting, context condensing, approval
 * limits, first-chunk retries and their prompts), so it is reported as "before_first_chunk". Use
 * the transport fields to tell those phases apart: `not_started`/`pending` means no provider
 * request is in flight yet.
 *
 * A stream can also be busy without visible progress, e.g. a model streaming an endless tool
 * argument. Stall lines never fire then, so a long request also logs a "[stream-progress]" line
 * every interval in which chunks arrived.
 */
export class StreamStallMonitor {
	private readonly log: (line: string) => void
	private readonly context: StreamStallMonitorOptions["context"]
	private readonly getTransport?: StreamStallMonitorOptions["getTransport"]
	private readonly getPrep?: StreamStallMonitorOptions["getPrep"]
	private readonly now: () => number
	private readonly thresholdsMs: readonly number[]

	private readonly startedAt: number
	private state: MonitorState = "processing"
	private stateSince: number
	private timer: ReturnType<typeof setTimeout> | undefined
	private thresholdIndex = 0
	private loggedStallInState = false
	private readonly progressTimer: ReturnType<typeof setInterval> | undefined
	private chunksAtLastProgress = 0
	private readonly startSequence: number | undefined

	private chunkCount = 0
	private firstChunkAt: number | undefined
	private lastChunkType: string | undefined
	private maxWaitMs = 0
	private maxMidStreamWaitMs = 0
	private maxProcessMs = 0
	private stallCount = 0
	private sawDone = false
	private maxToolArgBytes = 0
	// Tool calls by stream index: name and argument size, never argument content.
	private readonly toolCalls = new Map<number, { name?: string; argBytes: number }>()
	private lastToolIndex: number | undefined

	constructor(options: StreamStallMonitorOptions) {
		this.log = (line) => {
			try {
				options.log(line)
			} catch {
				/* A failing output channel must never surface into the stream loop. */
			}
		}
		this.context = options.context
		this.getTransport = options.getTransport
		this.getPrep = options.getPrep
		this.now = options.now ?? Date.now
		this.thresholdsMs = options.thresholdsMs ?? STREAM_STALL_THRESHOLDS_MS
		this.startedAt = this.now()
		this.stateSince = this.startedAt
		this.startSequence = this.readTransport()?.requestSequence
		const progressIntervalMs = options.progressIntervalMs ?? STREAM_PROGRESS_INTERVAL_MS
		this.progressTimer = setInterval(() => this.onProgress(progressIntervalMs), progressIntervalMs)
		this.progressTimer.unref?.()
	}

	/** Call immediately before awaiting the next chunk. */
	waitStarted(): void {
		if (this.state === "finished") return
		this.maxProcessMs = Math.max(this.maxProcessMs, this.now() - this.stateSince)
		this.enter("waiting", this.stateLabel())
	}

	/** Call when `iterator.next()` resolves; `done` marks the natural end of the stream. */
	chunkReceived(chunk: ApiStreamChunk | undefined, done: boolean): void {
		if (this.state === "finished") return
		const now = this.now()
		const previousLabel = this.stateLabel()
		this.maxWaitMs = Math.max(this.maxWaitMs, now - this.stateSince)
		if (this.chunkCount > 0) this.maxMidStreamWaitMs = Math.max(this.maxMidStreamWaitMs, now - this.stateSince)
		if (done) {
			this.sawDone = true
		} else if (chunk) {
			this.chunkCount++
			this.firstChunkAt ??= now
			this.lastChunkType = chunk.type
			if (chunk.type === "tool_call_partial") {
				const call = this.toolCalls.get(chunk.index) ?? { argBytes: 0 }
				call.name ??= chunk.name
				const argBytes = chunk.arguments?.length ?? 0
				call.argBytes = chunk.replaceArguments ? argBytes : call.argBytes + argBytes
				this.maxToolArgBytes = Math.max(this.maxToolArgBytes, call.argBytes)
				this.toolCalls.set(chunk.index, call)
				this.lastToolIndex = chunk.index
			}
		}
		this.enter("processing", previousLabel)
	}

	/** Idempotent. Writes the per-request summary and clears the timer. */
	finish(outcome: "completed" | "stopped_early" | "aborted" | "error", error?: unknown): void {
		if (this.state === "finished") return
		if (outcome === "stopped_early" && this.sawDone) outcome = "completed"
		const now = this.now()
		if (this.state === "waiting") {
			this.maxWaitMs = Math.max(this.maxWaitMs, now - this.stateSince)
			if (this.chunkCount > 0) this.maxMidStreamWaitMs = Math.max(this.maxMidStreamWaitMs, now - this.stateSince)
		} else {
			this.maxProcessMs = Math.max(this.maxProcessMs, now - this.stateSince)
		}
		this.clearTimer()
		clearInterval(this.progressTimer)
		this.state = "finished"
		const fields = [
			`outcome=${outcome}`,
			`durationMs=${now - this.startedAt}`,
			`firstChunkMs=${this.firstChunkAt === undefined ? "none" : this.firstChunkAt - this.startedAt}`,
			`chunks=${this.chunkCount}`,
			`maxWaitMs=${this.maxWaitMs}`,
			`maxMidStreamWaitMs=${this.maxMidStreamWaitMs}`,
			`maxProcessMs=${this.maxProcessMs}`,
			`stalls=${this.stallCount}`,
		]
		if (error !== undefined) {
			try {
				fields.push(describeError(error))
			} catch {
				// An exotic thrown value must not replace the real stream error in Task's catch.
				fields.push("error=undescribable")
			}
		}
		const attention = new Attention()
		if (outcome === "error") attention.error("streamError")
		if (this.stallCount > 0) attention.error("stalled")
		this.checkSendDelay(attention)
		const limits = STREAM_ATTENTION_LIMITS
		if (this.firstChunkAt !== undefined && this.firstChunkAt - this.startedAt >= limits.firstChunkWarnMs) {
			attention.warn("slowFirstChunk")
		}
		if (this.maxMidStreamWaitMs >= limits.midStreamGapWarnMs) attention.warn("midStreamGap")
		if (this.maxProcessMs >= limits.processWarnMs) attention.warn("slowProcessing")
		if (this.maxToolArgBytes >= limits.toolArgErrorBytes) attention.error("largeToolArgs")
		if (this.maxToolArgBytes > 0) fields.push(`maxToolArgBytes=${this.maxToolArgBytes}`)
		this.emit("summary", attention, [...fields, ...this.prepFields(), this.transportFields(now)])
	}

	/** Pre-request delay: Zoo's preparation plus the handler's, without deliberate waits. */
	private checkSendDelay(attention: Attention): void {
		const prep = this.readPrep()
		if (!prep) return
		const transport = this.readTransport()
		const handlerMs = transport && transport.requestSequence !== this.startSequence ? (transport.prepareMs ?? 0) : 0
		const sendDelayMs = prep.totalMs - prep.userWaitMs + handlerMs
		if (sendDelayMs >= STREAM_ATTENTION_LIMITS.sendDelayErrorMs) attention.error("slowPrep")
		else if (sendDelayMs >= STREAM_ATTENTION_LIMITS.sendDelayWarnMs) attention.warn("slowPrep")
	}

	private emit(kind: "summary" | "stall" | "progress", attention: Attention, fields: string[]): void {
		const reasons = attention.reasons.length > 0 ? ` reasons=${attention.reasons.join(",")}` : ""
		this.log(`[stream-${kind}] ${attention.level}${reasons} ${this.prefix()} ${fields.join(" ")}`)
	}

	private enter(state: Exclude<MonitorState, "finished">, previousLabel: string): void {
		const now = this.now()
		if (this.loggedStallInState) {
			const attention = new Attention()
			attention.warn("resumed")
			this.emit("stall", attention, [
				`resumed state=${previousLabel}`,
				`after=${formatSeconds(now - this.stateSince)}`,
			])
		}
		this.state = state
		this.stateSince = now
		this.thresholdIndex = 0
		this.loggedStallInState = false
		this.armTimer()
	}

	private armTimer(): void {
		this.clearTimer()
		const elapsed = this.now() - this.stateSince
		const delay = Math.max(0, this.nextThreshold() - elapsed)
		this.timer = setTimeout(() => this.onTimer(), delay)
		// Diagnostics must never keep the extension host process alive.
		this.timer.unref?.()
	}

	private nextThreshold(): number {
		const last = this.thresholdsMs.length - 1
		if (this.thresholdIndex <= last) return this.thresholdsMs[this.thresholdIndex]
		return this.thresholdsMs[last] * (this.thresholdIndex - last + 1)
	}

	private onTimer(): void {
		this.timer = undefined
		if (this.state === "finished") return
		try {
			const now = this.now()
			if (!this.loggedStallInState) this.stallCount++
			this.loggedStallInState = true
			const fields = [
				`state=${this.stateLabel()}`,
				`quiet=${formatSeconds(now - this.stateSince)}`,
				`sinceRequest=${formatSeconds(now - this.startedAt)}`,
				`chunks=${this.chunkCount}`,
				`lastChunk=${this.lastChunkType ?? "none"}`,
			]
			const tool = this.openToolCall()
			if (tool) fields.push(`tool=${tool.name ?? "unknown"}`, `toolArgBytes=${tool.argBytes}`)
			const attention = new Attention()
			attention.error("quiet")
			this.checkSendDelay(attention)
			this.emit("stall", attention, [...fields, ...this.prepFields(), this.transportFields(now)])
		} catch {
			/* Diagnostics never affect the request. */
		}
		this.thresholdIndex++
		this.armTimer()
	}

	private onProgress(intervalMs: number): void {
		if (this.state === "finished") return
		try {
			const newChunks = this.chunkCount - this.chunksAtLastProgress
			this.chunksAtLastProgress = this.chunkCount
			// A quiet interval is already covered by stall lines.
			if (newChunks === 0) return
			const now = this.now()
			const fields = [
				`state=${this.stateLabel()}`,
				`sinceRequest=${formatSeconds(now - this.startedAt)}`,
				`chunks=${this.chunkCount}`,
				`chunksPerSec=${(newChunks / (intervalMs / 1000)).toFixed(1)}`,
				`lastChunk=${this.lastChunkType ?? "none"}`,
			]
			const tool = this.openToolCall()
			if (tool) fields.push(`tool=${tool.name ?? "unknown"}`, `toolArgBytes=${tool.argBytes}`)
			// Healthy requests finish well within one interval, so reaching it is itself unusual.
			const attention = new Attention()
			attention.warn("longStream")
			if (tool && tool.argBytes >= STREAM_ATTENTION_LIMITS.toolArgErrorBytes) attention.error("largeToolArgs")
			this.emit("progress", attention, [...fields, this.transportFields(now)])
		} catch {
			/* Diagnostics never affect the request. */
		}
	}

	private stateLabel(): string {
		return this.state === "waiting" && this.chunkCount === 0 ? "before_first_chunk" : this.state
	}

	/** The tool call the stream was last writing, if the last chunk belonged to one. */
	private openToolCall(): { name?: string; argBytes: number } | undefined {
		if (this.lastChunkType !== "tool_call_partial" || this.lastToolIndex === undefined) return undefined
		return this.toolCalls.get(this.lastToolIndex)
	}

	private prefix(): string {
		const { taskId, instanceId, provider, model, retryAttempt } = this.context
		return `task=${taskId} instance=${instanceId} provider=${provider ?? "unknown"} model=${model} retryAttempt=${retryAttempt}`
	}

	private transportFields(now: number): string {
		const transport = this.readTransport()
		if (!transport) return "transport=n/a"
		// Until the provider sends, its view still describes the previous request.
		if (transport.requestSequence === this.startSequence) return "transport=not_started"
		const ago = (at: number | undefined) => (at === undefined ? "none" : formatSeconds(now - at))
		return [
			`transport=${transport.transport ?? "pending"}`,
			// Another request on the same handler (e.g. a condense call) shows up as a higher sequence.
			`requestSeq=${transport.requestSequence}`,
			`providerStartMs=${transport.requestStartedAt - this.startedAt}`,
			...(transport.prepareMs === undefined ? [] : [`handlerPrepMs=${transport.prepareMs}`]),
			...(transport.accessTokenMs === undefined ? [] : [`accessTokenMs=${transport.accessTokenMs}`]),
			...(transport.accountIdMs === undefined ? [] : [`accountIdMs=${transport.accountIdMs}`]),
			`events=${transport.eventCount}`,
			`lastEvent=${transport.lastEventType ?? "none"}`,
			`lastEventAgo=${ago(transport.lastEventAt)}`,
			...(transport.transport === "sse" ? [`lastReadAgo=${ago(transport.lastReadAt)}`] : []),
			`responseId=${transport.responseId ?? "none"}`,
			`requestId=${transport.requestId ?? "none"}`,
			`cfRay=${transport.cfRay ?? "none"}`,
		].join(" ")
	}

	/** Zoo's preparation steps before the provider call; `prepPhase` names a step still running. */
	private prepFields(): string[] {
		const prep = this.readPrep()
		if (!prep) return ["prep=n/a"]
		const fields = [
			`prepMs=${prep.totalMs}`,
			`prepUserWaitMs=${prep.userWaitMs}`,
			`prep=${prep.phases.map((phase) => `${phase.name}:${phase.ms}`).join(",") || "none"}`,
		]
		if (prep.current) fields.push(`prepPhase=${prep.current.name}`, `prepPhaseMs=${prep.current.ms}`)
		return fields
	}

	private readPrep(): RequestPrepSnapshot | undefined {
		try {
			return this.getPrep?.()
		} catch {
			return undefined
		}
	}

	private readTransport(): Readonly<ApiStreamTransportDiagnostics> | undefined {
		try {
			return this.getTransport?.()
		} catch {
			return undefined
		}
	}

	private clearTimer(): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer)
			this.timer = undefined
		}
	}
}

/** Collects why a line needs attention; the most severe reason sets the level. */
class Attention {
	level: StreamLogLevel = "INFO"
	readonly reasons: string[] = []

	warn(reason: string): void {
		this.reasons.push(reason)
		if (this.level === "INFO") this.level = "WARN"
	}

	error(reason: string): void {
		this.reasons.push(reason)
		this.level = "ERROR"
	}
}

function formatSeconds(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`
}

/**
 * Error shape only. Messages can carry file paths or provider-echoed request content, so only
 * their length is logged; the full text already reaches the chat and the console elsewhere.
 */
function describeError(error: unknown): string {
	const fields = [`error=${error instanceof Error ? error.name : typeof error}`]
	if (typeof error === "object" && error !== null) {
		const { status, code } = error as { status?: unknown; code?: unknown }
		if (typeof status === "number" || typeof status === "string") fields.push(`errorStatus=${status}`)
		if (typeof code === "number" || typeof code === "string") fields.push(`errorCode=${String(code).slice(0, 40)}`)
	}
	const message = error instanceof Error ? error.message : String(error)
	fields.push(`errorMessageLength=${message.length}`)
	return fields.join(" ")
}
