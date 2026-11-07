// npx vitest run core/task/__tests__/StreamStallMonitor.spec.ts

import type { ApiStreamTransportDiagnostics } from "../../../api"
import { RequestPrepTimeline } from "../RequestPrepTimeline"
import { StreamStallMonitor } from "../StreamStallMonitor"

const context = {
	taskId: "task-1",
	instanceId: "inst-1",
	provider: "test-provider",
	model: "gpt-6.1-sol",
	retryAttempt: 0,
}

function createMonitor(getTransport?: () => Readonly<ApiStreamTransportDiagnostics> | undefined) {
	const lines: string[] = []
	const monitor = new StreamStallMonitor({ log: (line) => lines.push(line), context, getTransport })
	return { monitor, lines }
}

const stallLines = (lines: string[]) => lines.filter((line) => line.startsWith("[stream-stall]"))
const summaryLines = (lines: string[]) => lines.filter((line) => line.startsWith("[stream-summary]"))

describe("StreamStallMonitor", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-11-05T20:27:08Z"))
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("logs only a summary for a stream without quiet periods", () => {
		const { monitor, lines } = createMonitor()

		monitor.waitStarted()
		vi.advanceTimersByTime(1_000)
		monitor.chunkReceived({ type: "text", text: "hi" }, false)
		vi.advanceTimersByTime(200)
		monitor.waitStarted()
		vi.advanceTimersByTime(500)
		monitor.chunkReceived(undefined, true)
		monitor.finish("stopped_early")

		expect(stallLines(lines)).toEqual([])
		expect(summaryLines(lines)).toHaveLength(1)
		expect(lines[0]).toContain("outcome=completed")
		expect(lines[0]).toContain("firstChunkMs=1000")
		expect(lines[0]).toContain("chunks=1")
		expect(lines[0]).toContain("maxWaitMs=1000")
		expect(lines[0]).toContain("maxMidStreamWaitMs=500")
		expect(lines[0]).toContain("maxProcessMs=200")
		expect(lines[0]).toContain("stalls=0")
		expect(lines[0]).toContain("transport=n/a")
	})

	it("logs a waiting stall at each threshold, then once when the stream resumes", () => {
		const { monitor, lines } = createMonitor()

		monitor.waitStarted()
		vi.advanceTimersByTime(29_999)
		expect(stallLines(lines)).toEqual([])

		vi.advanceTimersByTime(1)
		vi.advanceTimersByTime(30_000)
		vi.advanceTimersByTime(60_000)
		vi.advanceTimersByTime(120_000)
		const stalls = stallLines(lines)
		expect(stalls.map((line) => line.match(/quiet=(\S+)/)?.[1])).toEqual(["30.0s", "60.0s", "120.0s", "240.0s"])
		expect(stalls[0]).toContain("state=before_first_chunk")
		expect(stalls[0]).toContain("lastChunk=none")

		monitor.chunkReceived({ type: "text", text: "late" }, false)
		expect(stallLines(lines).at(-1)).toContain("resumed state=before_first_chunk after=240.0s")
		monitor.waitStarted()
		vi.advanceTimersByTime(30_000)
		expect(stallLines(lines).at(-1)).toContain("state=waiting")

		monitor.finish("stopped_early")
		expect(summaryLines(lines)[0]).toContain("stalls=2")
		expect(summaryLines(lines)[0]).toContain("maxWaitMs=240000")
		expect(summaryLines(lines)[0]).toContain("maxMidStreamWaitMs=30000")
	})

	it("names the open tool call and its argument size without logging argument content", () => {
		const { monitor, lines } = createMonitor()

		monitor.waitStarted()
		monitor.chunkReceived({ type: "tool_call_partial", index: 0, id: "call_1", name: "read_file" }, false)
		monitor.waitStarted()
		monitor.chunkReceived({ type: "tool_call_partial", index: 0, arguments: '{"path":"V19' }, false)
		monitor.waitStarted()
		vi.advanceTimersByTime(30_000)

		const [stall] = stallLines(lines)
		expect(stall).toContain("lastChunk=tool_call_partial")
		expect(stall).toContain("tool=read_file")
		expect(stall).toContain("toolArgBytes=12")
		expect(lines.join("\n")).not.toContain("V19")
		monitor.finish("aborted")
	})

	it("counts replaced tool arguments by their final size", () => {
		const { monitor, lines } = createMonitor()

		monitor.waitStarted()
		monitor.chunkReceived({ type: "tool_call_partial", index: 0, name: "read_file", arguments: "{" }, false)
		monitor.waitStarted()
		monitor.chunkReceived({ type: "tool_call_partial", index: 0, arguments: "{}", replaceArguments: true }, false)
		monitor.waitStarted()
		vi.advanceTimersByTime(30_000)

		expect(stallLines(lines)[0]).toContain("toolArgBytes=2")
		monitor.finish("aborted")
	})

	it("reports a stall while Zoo is processing between chunks", () => {
		const { monitor, lines } = createMonitor()

		monitor.waitStarted()
		monitor.chunkReceived({ type: "reasoning", text: "thinking" }, false)
		vi.advanceTimersByTime(30_000)

		expect(stallLines(lines)[0]).toContain("state=processing")
		monitor.waitStarted()
		expect(stallLines(lines).at(-1)).toContain("resumed state=processing after=30.0s")
		monitor.finish("aborted")
		expect(summaryLines(lines)[0]).toContain("maxProcessMs=30000")
	})

	it("stops logging after finish and writes the summary once", () => {
		const { monitor, lines } = createMonitor()

		monitor.waitStarted()
		monitor.finish("error", new Error("terminated\nby upstream"))
		monitor.finish("stopped_early")
		monitor.waitStarted()
		monitor.chunkReceived({ type: "text", text: "x" }, false)
		vi.advanceTimersByTime(600_000)

		expect(lines).toHaveLength(1)
		expect(lines[0]).toContain("outcome=error")
		expect(lines[0]).toContain("error=Error errorMessageLength=22")
		expect(lines[0]).not.toContain("terminated")
		expect(vi.getTimerCount()).toBe(0)
	})

	it("summarizes an error whose description throws without throwing itself", () => {
		const { monitor, lines } = createMonitor()

		// String() of a null-prototype object throws a TypeError.
		expect(() => monitor.finish("error", Object.create(null))).not.toThrow()

		expect(lines[0]).toContain("error=undescribable")
	})

	it("logs status and code of an error without its message", () => {
		const { monitor, lines } = createMonitor()
		const error = Object.assign(new TypeError("ENOENT /home/someone/tasks/x/ui_messages.json"), {
			status: 502,
			code: "ECONNRESET",
		})

		monitor.finish("error", error)

		expect(lines[0]).toContain("error=TypeError errorStatus=502 errorCode=ECONNRESET")
		expect(lines[0]).not.toContain("/home/")
	})

	it("never throws when the log sink throws", () => {
		const monitor = new StreamStallMonitor({
			log: () => {
				throw new Error("channel disposed")
			},
			context,
		})

		expect(() => {
			monitor.waitStarted()
			vi.advanceTimersByTime(30_000)
			monitor.chunkReceived({ type: "text", text: "x" }, false)
			monitor.finish("error", new Error("terminated"))
		}).not.toThrow()
		expect(vi.getTimerCount()).toBe(0)
	})

	it("keeps stopped_early when the loop left before the stream ended", () => {
		const { monitor, lines } = createMonitor()

		monitor.waitStarted()
		monitor.chunkReceived({ type: "text", text: "x" }, false)
		monitor.finish("stopped_early")

		expect(lines[0]).toContain("outcome=stopped_early")
	})

	it("includes transport timing and identifiers from the provider", () => {
		const startedAt = Date.now()
		const provider: { transport?: ApiStreamTransportDiagnostics } = {}
		const { monitor, lines } = createMonitor(() => provider.transport)
		provider.transport = {
			transport: "sse",
			requestSequence: 1,
			requestStartedAt: startedAt + 50,
			eventCount: 7,
			lastEventAt: startedAt + 1_000,
			lastEventType: "response.function_call_arguments.delta",
			lastReadAt: startedAt + 20_000,
			responseId: "resp_1",
			requestId: "req_1",
		}

		monitor.waitStarted()
		vi.advanceTimersByTime(30_000)

		const [stall] = stallLines(lines)
		expect(stall).toContain("transport=sse")
		expect(stall).toContain("requestSeq=1")
		expect(stall).toContain("providerStartMs=50")
		expect(stall).toContain("events=7")
		expect(stall).toContain("lastEvent=response.function_call_arguments.delta")
		expect(stall).toContain("lastEventAgo=29.0s")
		expect(stall).toContain("lastReadAgo=10.0s")
		expect(stall).toContain("responseId=resp_1")
		expect(stall).toContain("requestId=req_1")
		expect(stall).toContain("cfRay=none")
		monitor.finish("aborted")
	})

	it("marks transport data from an earlier request as not started, regardless of clock", () => {
		// A later start time must not matter: only a new request sequence means this request started.
		const transport: ApiStreamTransportDiagnostics = {
			requestSequence: 3,
			requestStartedAt: Date.now() + 60_000,
			eventCount: 3,
		}
		const { monitor, lines } = createMonitor(() => transport)

		monitor.finish("aborted")

		expect(lines[0]).toContain("transport=not_started")
	})

	it("reports a request started after the monitor even if the clock went backwards", () => {
		let transport: ApiStreamTransportDiagnostics = {
			requestSequence: 3,
			requestStartedAt: Date.now(),
			eventCount: 3,
		}
		const { monitor, lines } = createMonitor(() => transport)
		transport = { requestSequence: 4, transport: "sdk", requestStartedAt: Date.now() - 5_000, eventCount: 1 }

		monitor.finish("aborted")

		expect(lines[0]).toContain("transport=sdk")
		expect(lines[0]).toContain("providerStartMs=-5000")
	})

	it("logs progress for a long request that keeps streaming without going quiet", () => {
		const { monitor, lines } = createMonitor()

		monitor.waitStarted()
		monitor.chunkReceived({ type: "tool_call_partial", index: 0, name: "read_file", arguments: "{" }, false)
		for (let second = 0; second < 120; second++) {
			monitor.waitStarted()
			vi.advanceTimersByTime(1_000)
			monitor.chunkReceived({ type: "tool_call_partial", index: 0, arguments: "  " }, false)
		}

		const progress = lines.filter((line) => line.startsWith("[stream-progress]"))
		expect(stallLines(lines)).toEqual([])
		expect(progress).toHaveLength(2)
		expect(progress[0]).toContain("sinceRequest=60.0s")
		expect(progress[0]).toContain("chunksPerSec=1.0")
		expect(progress[0]).toContain("lastChunk=tool_call_partial")
		expect(progress[0]).toContain("tool=read_file")
		expect(progress[1]).toContain("toolArgBytes=239")
		monitor.finish("aborted")
		vi.advanceTimersByTime(600_000)
		expect(lines.filter((line) => line.startsWith("[stream-progress]"))).toHaveLength(2)
	})

	it("skips progress lines for intervals without new chunks", () => {
		const { monitor, lines } = createMonitor()

		monitor.waitStarted()
		vi.advanceTimersByTime(120_000)

		expect(lines.filter((line) => line.startsWith("[stream-progress]"))).toEqual([])
		monitor.finish("aborted")
	})

	describe("levels", () => {
		const level = (line: string | undefined) => line?.match(/^\[stream-[a-z]+\] (INFO|WARN|ERROR)/)?.[1]

		it("marks a healthy request INFO without reasons", () => {
			const { monitor, lines } = createMonitor()

			monitor.waitStarted()
			vi.advanceTimersByTime(5_000)
			monitor.chunkReceived(undefined, true)
			monitor.finish("stopped_early")

			expect(level(lines[0])).toBe("INFO")
			expect(lines[0]).not.toContain("reasons=")
		})

		it("marks stall lines ERROR, the resume WARN, and the summary ERROR with its reasons", () => {
			const { monitor, lines } = createMonitor()

			monitor.waitStarted()
			vi.advanceTimersByTime(30_000)
			monitor.chunkReceived({ type: "text", text: "x" }, false)
			monitor.finish("error", new Error("terminated"))

			expect(lines[0]).toMatch(/^\[stream-stall\] ERROR reasons=quiet task=/)
			expect(lines[1]).toMatch(/^\[stream-stall\] WARN reasons=resumed task=.* resumed state=before_first_chunk/)
			expect(lines[2]).toMatch(/^\[stream-summary\] ERROR reasons=streamError,stalled,slowFirstChunk task=/)
		})

		it("warns about a slow mid-stream gap and slow processing", () => {
			const { monitor, lines } = createMonitor()

			monitor.waitStarted()
			monitor.chunkReceived({ type: "text", text: "x" }, false)
			vi.advanceTimersByTime(2_000)
			monitor.waitStarted()
			vi.advanceTimersByTime(15_000)
			monitor.chunkReceived(undefined, true)
			monitor.finish("stopped_early")

			expect(summaryLines(lines)[0]).toMatch(/^\[stream-summary\] WARN reasons=midStreamGap,slowProcessing /)
		})

		it("marks progress WARN, and ERROR once the open tool's arguments grow past the limit", () => {
			const { monitor, lines } = createMonitor()

			monitor.waitStarted()
			monitor.chunkReceived({ type: "tool_call_partial", index: 0, name: "read_file", arguments: "{" }, false)
			monitor.waitStarted()
			vi.advanceTimersByTime(59_000)
			monitor.chunkReceived({ type: "tool_call_partial", index: 0, arguments: " " }, false)
			monitor.waitStarted()
			vi.advanceTimersByTime(1_000)
			monitor.chunkReceived({ type: "tool_call_partial", index: 0, arguments: " ".repeat(100_000) }, false)
			// Chunks keep arriving within 30 s, so only progress lines fire.
			for (const gapMs of [29_000, 20_000]) {
				monitor.waitStarted()
				vi.advanceTimersByTime(gapMs)
				monitor.chunkReceived({ type: "tool_call_partial", index: 0, arguments: " " }, false)
			}
			monitor.waitStarted()
			vi.advanceTimersByTime(11_000)

			const progress = lines.filter((line) => line.startsWith("[stream-progress]"))
			expect(progress[0]).toMatch(/^\[stream-progress\] WARN reasons=longStream /)
			expect(progress[1]).toMatch(/^\[stream-progress\] ERROR reasons=longStream,largeToolArgs /)
			monitor.finish("aborted")
			expect(summaryLines(lines)[0]).toMatch(/^\[stream-summary\] ERROR reasons=\S*largeToolArgs /)
			expect(summaryLines(lines)[0]).toContain("maxToolArgBytes=100004")
		})
	})

	describe("request preparation", () => {
		it("logs preparation phases and warns when Zoo took too long to send", () => {
			const prep = new RequestPrepTimeline()
			const lines: string[] = []
			const monitor = new StreamStallMonitor({
				log: (line) => lines.push(line),
				context,
				getPrep: () => prep.snapshot(),
			})

			monitor.waitStarted()
			prep.phase("state")
			vi.advanceTimersByTime(10)
			prep.phase("systemPrompt")
			vi.advanceTimersByTime(9_000)
			prep.phase("tools")
			vi.advanceTimersByTime(40)
			prep.finish()
			monitor.chunkReceived(undefined, true)
			monitor.finish("stopped_early")

			expect(lines[0]).toMatch(/^\[stream-summary\] WARN reasons=slowPrep /)
			expect(lines[0]).toContain("prepMs=9050 prepUserWaitMs=0 prep=state:10,systemPrompt:9000,tools:40")
			expect(lines[0]).not.toContain("prepPhase=")
		})

		it("names the running phase in a stall line and turns a very slow preparation red", () => {
			const prep = new RequestPrepTimeline()
			const lines: string[] = []
			const monitor = new StreamStallMonitor({
				log: (line) => lines.push(line),
				context,
				getPrep: () => prep.snapshot(),
			})

			monitor.waitStarted()
			prep.phase("modelInfo")
			vi.advanceTimersByTime(5)
			prep.phase("systemPrompt")
			vi.advanceTimersByTime(29_995)

			expect(stallLines(lines)[0]).toMatch(/^\[stream-stall\] ERROR reasons=quiet,slowPrep /)
			expect(stallLines(lines)[0]).toContain("prep=modelInfo:5 prepPhase=systemPrompt prepPhaseMs=29995")
			monitor.finish("aborted")
		})

		it("does not count deliberate waits as slow preparation", () => {
			const prep = new RequestPrepTimeline()
			const lines: string[] = []
			const monitor = new StreamStallMonitor({
				log: (line) => lines.push(line),
				context,
				getPrep: () => prep.snapshot(),
			})

			monitor.waitStarted()
			prep.phase("approvalLimit", { userWait: true })
			vi.advanceTimersByTime(20_000)
			prep.finish()
			monitor.chunkReceived(undefined, true)
			monitor.finish("stopped_early")

			expect(lines[0]).toMatch(/^\[stream-summary\] INFO /)
			expect(lines[0]).toContain("prepUserWaitMs=20000")
		})

		it("adds the handler's preparation to the send delay and logs its parts", () => {
			const transport: { current?: ApiStreamTransportDiagnostics } = {}
			const prep = new RequestPrepTimeline()
			const lines: string[] = []
			const monitor = new StreamStallMonitor({
				log: (line) => lines.push(line),
				context,
				getPrep: () => prep.snapshot(),
				getTransport: () => transport.current,
			})

			monitor.waitStarted()
			prep.phase("tools")
			vi.advanceTimersByTime(1_000)
			prep.finish()
			vi.advanceTimersByTime(4_000)
			transport.current = {
				transport: "sdk",
				requestSequence: 1,
				requestStartedAt: Date.now(),
				prepareMs: 4_000,
				accessTokenMs: 3_900,
				accountIdMs: 2,
				eventCount: 0,
			}
			monitor.finish("aborted")

			expect(lines[0]).toMatch(/^\[stream-summary\] WARN reasons=slowPrep /)
			expect(lines[0]).toContain("handlerPrepMs=4000 accessTokenMs=3900 accountIdMs=2")
		})

		it("logs prep=n/a when the request never started preparing", () => {
			const { monitor, lines } = createMonitor()

			monitor.finish("stopped_early")

			expect(lines[0]).toContain("prep=n/a")
		})
	})

	it("survives a transport reader that throws", () => {
		const { monitor, lines } = createMonitor(() => {
			throw new Error("boom")
		})

		monitor.waitStarted()
		vi.advanceTimersByTime(30_000)
		monitor.finish("aborted")

		expect(stallLines(lines)[0]).toContain("transport=n/a")
		expect(summaryLines(lines)[0]).toContain("transport=n/a")
	})
})
