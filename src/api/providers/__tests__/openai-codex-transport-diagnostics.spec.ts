// npx vitest run api/providers/__tests__/openai-codex-transport-diagnostics.spec.ts

vitest.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureException: vitest.fn(),
		},
	},
}))

import { OpenAiCodexHandler } from "../openai-codex"
import { openAiCodexOAuthManager } from "../../../integrations/openai-codex/oauth"
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"

const events = [
	{ type: "response.created", response: { id: "resp_1" } },
	{ type: "response.output_text.delta", delta: "Hi" },
	{
		type: "response.completed",
		response: { id: "resp_1", status: "completed", output: [], usage: { input_tokens: 1, output_tokens: 1 } },
	},
]

function createHandler() {
	const handler = new OpenAiCodexHandler({ apiModelId: "gpt-5.6-sol" })
	vitest.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
	vitest.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")
	return handler
}

describe("OpenAiCodexHandler stream transport diagnostics", () => {
	afterEach(() => {
		vitest.restoreAllMocks()
		vitest.unstubAllGlobals()
	})

	it("has no diagnostics before the first request", () => {
		expect(new OpenAiCodexHandler({ apiModelId: "gpt-5.6-sol" }).getStreamTransportDiagnostics()).toBeUndefined()
	})

	it("records SDK events and request identifiers exposed by withResponse", async () => {
		const handler = createHandler()
		const before = Date.now()
		const create = vitest.fn().mockReturnValue({
			withResponse: async () => ({
				data: asyncStreamFrom(events),
				response: { headers: new Headers({ "cf-ray": "ray-1" }) },
				request_id: "req_sdk",
			}),
		})
		Reflect.set(handler, "client", { responses: { create } })

		const chunks = await collectStream(handler.createMessage("System", []))

		expect(chunks).toContainEqual({ type: "text", text: "Hi" })
		const diagnostics = handler.getStreamTransportDiagnostics()
		expect(diagnostics).toMatchObject({
			transport: "sdk",
			eventCount: 3,
			lastEventType: "response.completed",
			responseId: "resp_1",
			requestId: "req_sdk",
			cfRay: "ray-1",
		})
		expect(diagnostics?.requestStartedAt).toBeGreaterThanOrEqual(before)
		expect(diagnostics?.lastEventAt).toBeGreaterThanOrEqual(diagnostics?.requestStartedAt ?? Infinity)
	})

	it("records the handler's preparation time and its access token part", async () => {
		const handler = createHandler()
		vitest.spyOn(openAiCodexOAuthManager, "getAccessToken").mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20))
			return "test-token"
		})
		Reflect.set(handler, "client", {
			responses: { create: vitest.fn().mockResolvedValue(asyncStreamFrom(events)) },
		})

		await collectStream(handler.createMessage("System", []))

		const diagnostics = handler.getStreamTransportDiagnostics()
		expect(diagnostics?.accessTokenMs).toBeGreaterThanOrEqual(15)
		expect(diagnostics?.prepareMs).toBeGreaterThanOrEqual(diagnostics?.accessTokenMs ?? Infinity)
		expect(diagnostics?.accountIdMs).toBeGreaterThanOrEqual(0)
	})

	it("still streams from an injected client without withResponse", async () => {
		const handler = createHandler()
		Reflect.set(handler, "client", {
			responses: { create: vitest.fn().mockResolvedValue(asyncStreamFrom(events)) },
		})

		const chunks = await collectStream(handler.createMessage("System", []))

		expect(chunks).toContainEqual({ type: "text", text: "Hi" })
		const diagnostics = handler.getStreamTransportDiagnostics()
		expect(diagnostics).toMatchObject({ transport: "sdk", eventCount: 3 })
		expect(diagnostics?.requestId).toBeUndefined()
		expect(diagnostics?.cfRay).toBeUndefined()
	})

	it("records SSE fallback reads, events, and response headers", async () => {
		const handler = createHandler()
		Reflect.set(handler, "client", {
			responses: { create: vitest.fn().mockRejectedValue(new Error("SDK unavailable")) },
		})
		const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
		vitest.stubGlobal(
			"fetch",
			vitest.fn().mockResolvedValue({
				ok: true,
				headers: new Headers({ "x-request-id": "req_sse" }),
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(body))
						controller.close()
					},
				}),
			}),
		)

		await collectStream(handler.createMessage("System", []))

		const diagnostics = handler.getStreamTransportDiagnostics()
		expect(diagnostics).toMatchObject({
			transport: "sse",
			eventCount: 3,
			lastEventType: "response.completed",
			responseId: "resp_1",
			requestId: "req_sse",
			cfRay: undefined,
		})
		expect(diagnostics?.lastReadAt).toBeGreaterThanOrEqual(diagnostics?.requestStartedAt ?? Infinity)
	})

	it("starts fresh diagnostics for each request", async () => {
		const handler = createHandler()
		const create = vitest
			.fn()
			.mockResolvedValueOnce(asyncStreamFrom(events))
			.mockResolvedValueOnce(asyncStreamFrom(events.slice(2)))
		Reflect.set(handler, "client", { responses: { create } })

		await collectStream(handler.createMessage("System", []))
		await collectStream(handler.createMessage("System", []))

		expect(handler.getStreamTransportDiagnostics()).toMatchObject({ requestSequence: 2, eventCount: 1 })
	})

	it("does not count a previous response's drained events against the next request", async () => {
		const handler = createHandler()
		let releaseTail: () => void = () => {}
		const tailReleased = new Promise<void>((resolve) => {
			releaseTail = resolve
		})
		async function* firstResponse() {
			yield events[0]
			yield events[1]
			await tailReleased
			yield { type: "response.output_text.delta", delta: " tail" }
			yield events[2]
		}
		const create = vitest
			.fn()
			.mockResolvedValueOnce(firstResponse())
			.mockResolvedValueOnce(asyncStreamFrom([events[0], events[2]]))
		Reflect.set(handler, "client", { responses: { create } })

		// The first response is still being drained (as Task's background usage collection does)
		// while the next request is in flight.
		const first = handler.createMessage("System", [])[Symbol.asyncIterator]()
		await first.next()
		const second = handler.createMessage("System", [])[Symbol.asyncIterator]()
		await second.next()
		releaseTail()
		while (!(await first.next()).done) {
			/* drain */
		}
		while (!(await second.next()).done) {
			/* finish */
		}

		expect(handler.getStreamTransportDiagnostics()).toMatchObject({
			requestSequence: 2,
			eventCount: 2,
			lastEventType: "response.completed",
		})
	})

	it("keeps draining a previous response after the next request ends", async () => {
		const handler = createHandler()
		let releaseTail: () => void = () => {}
		const tailReleased = new Promise<void>((resolve) => {
			releaseTail = resolve
		})
		async function* firstResponse() {
			yield events[0]
			yield events[1]
			await tailReleased
			yield { type: "response.output_text.delta", delta: " tail" }
			yield events[2]
		}
		const create = vitest.fn().mockResolvedValueOnce(firstResponse()).mockResolvedValueOnce(asyncStreamFrom(events))
		Reflect.set(handler, "client", { responses: { create } })

		const first = handler.createMessage("System", [])[Symbol.asyncIterator]()
		await first.next()
		// Before per-request controllers, the second request's cleanup cleared the shared
		// controller and the first stream threw a TypeError on its next event.
		await collectStream(handler.createMessage("System", []))
		releaseTail()
		const tail = []
		for (let item = await first.next(); !item.done; item = await first.next()) {
			tail.push(item.value)
		}

		expect(tail).toContainEqual({ type: "text", text: " tail" })
	})

	it("aborts only the request whose caller cancelled", async () => {
		const handler = createHandler()
		const signals: AbortSignal[] = []
		let releaseFirst: () => void = () => {}
		const firstReleased = new Promise<void>((resolve) => {
			releaseFirst = resolve
		})
		async function* firstResponse() {
			yield events[1]
			await firstReleased
			yield events[2]
		}
		const create = vitest.fn((_body: unknown, request: { signal: AbortSignal }) => {
			signals.push(request.signal)
			return Promise.resolve(signals.length === 1 ? firstResponse() : asyncStreamFrom(events))
		})
		Reflect.set(handler, "client", { responses: { create } })
		const firstCaller = new AbortController()

		const first = handler
			.createMessage("System", [], { taskId: "t", abortSignal: firstCaller.signal })
			[Symbol.asyncIterator]()
		await first.next()
		const second = handler.createMessage("System", [])[Symbol.asyncIterator]()
		await second.next()
		// With a shared controller, the first caller's cancel aborted the newer request instead.
		firstCaller.abort()

		expect(signals[0].aborted).toBe(true)
		expect(signals[1].aborted).toBe(false)
		releaseFirst()
		while (!(await first.next()).done) {
			/* drain */
		}
		while (!(await second.next()).done) {
			/* finish */
		}
	})

	it("keeps the newest response id and reasoning when an older response's tail arrives late", async () => {
		const handler = createHandler()
		const completed = (id: string, encrypted: string) => ({
			type: "response.completed",
			response: {
				id,
				status: "completed",
				output: [{ type: "reasoning", id: `rs_${id}`, encrypted_content: encrypted, summary: [] }],
				usage: { input_tokens: 1, output_tokens: 1 },
			},
		})
		let releaseTail: () => void = () => {}
		const tailReleased = new Promise<void>((resolve) => {
			releaseTail = resolve
		})
		async function* olderResponse() {
			yield { type: "response.output_text.delta", delta: "older" }
			await tailReleased
			yield completed("resp_old", "enc_old")
		}
		const create = vitest
			.fn()
			.mockResolvedValueOnce(olderResponse())
			.mockResolvedValueOnce(asyncStreamFrom([completed("resp_new", "enc_new")]))
		Reflect.set(handler, "client", { responses: { create } })

		const older = handler.createMessage("System", [])[Symbol.asyncIterator]()
		await older.next()
		await collectStream(handler.createMessage("System", []))
		releaseTail()
		while (!(await older.next()).done) {
			/* drain */
		}

		expect(handler.getResponseId()).toBe("resp_new")
		expect(handler.getEncryptedContent()?.encrypted_content).toBe("enc_new")
	})
})
