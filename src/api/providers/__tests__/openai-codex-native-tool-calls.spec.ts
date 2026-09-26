// cd src && npx vitest run api/providers/__tests__/openai-codex-native-tool-calls.spec.ts

import { beforeEach, describe, expect, it, vi } from "vitest"

import { OpenAiCodexHandler } from "../openai-codex"
import type { ApiHandlerOptions } from "../../../shared/api"
import { NativeToolCallParser } from "../../../core/assistant-message/NativeToolCallParser"
import { openAiCodexOAuthManager } from "../../../integrations/openai-codex/oauth"
import { Package } from "../../../shared/package"
import type { ApiStreamChunk } from "../../../api/transform/stream"
import { asyncStreamFrom, collectStream } from "../../../test-utils/stream"

describe("OpenAiCodexHandler native tool calls", () => {
	let handler: OpenAiCodexHandler
	let mockOptions: ApiHandlerOptions

	beforeEach(() => {
		vi.restoreAllMocks()

		mockOptions = {
			apiModelId: "gpt-5.2-2025-12-11",
			// minimal settings; OAuth is mocked below
		}
		handler = new OpenAiCodexHandler(mockOptions)
	})

	it("yields tool_call_partial chunks when API returns function_call-only response", async () => {
		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")

		// Mock OpenAI SDK streaming (preferred path).
		;(handler as any).client = {
			responses: {
				create: vi.fn().mockResolvedValue(
					asyncStreamFrom([
						{
							type: "response.output_item.added",
							item: {
								type: "function_call",
								call_id: "call_1",
								name: "attempt_completion",
								arguments: "",
							},
							output_index: 0,
						},
						{
							type: "response.function_call_arguments.delta",
							delta: '{"result":"hi"}',
							item_id: "fc_1",
							output_index: 0,
						},
						{
							type: "response.completed",
							response: {
								id: "resp_1",
								status: "completed",
								output: [
									{
										type: "function_call",
										call_id: "call_1",
										name: "attempt_completion",
										arguments: '{"result":"hi"}',
									},
								],
								usage: { input_tokens: 1, output_tokens: 1 },
							},
						},
					]),
				),
			},
		}

		const stream = handler.createMessage("system", [{ role: "user", content: "hello" } as any], {
			taskId: "t",
			tools: [],
		})

		const parserScope = NativeToolCallParser.createScope()
		const chunks: ApiStreamChunk[] = []
		for await (const chunk of stream) {
			chunks.push(chunk)
			if (chunk.type === "tool_call_partial") {
				// Simulate Task.ts behavior so finish_reason handling can emit tool_call_end elsewhere
				NativeToolCallParser.processRawChunk(
					{
						index: chunk.index,
						id: chunk.id,
						name: chunk.name,
						arguments: chunk.arguments,
					},
					parserScope,
				)
			}
		}

		const toolChunks = chunks.filter((c) => c.type === "tool_call_partial")
		expect(toolChunks.length).toBeGreaterThan(0)
		expect(toolChunks[0]).toMatchObject({
			type: "tool_call_partial",
			id: "call_1",
			name: "attempt_completion",
		})
	})

	it("yields text when Codex emits assistant message only in response.output_item.done", async () => {
		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")
		;(handler as any).client = {
			responses: {
				create: vi.fn().mockResolvedValue(
					asyncStreamFrom([
						{
							type: "response.output_item.done",
							item: {
								type: "message",
								role: "assistant",
								content: [{ type: "output_text", text: "hello from spark" }],
							},
							output_index: 0,
						},
						{
							type: "response.completed",
							response: {
								id: "resp_done_only",
								status: "completed",
								output: [
									{
										type: "message",
										role: "assistant",
										content: [{ type: "output_text", text: "hello from spark" }],
									},
								],
								usage: { input_tokens: 1, output_tokens: 2 },
							},
						},
					]),
				),
			},
		}

		const stream = handler.createMessage("system", [{ role: "user", content: "test" } as any], {
			taskId: "t",
			tools: [],
		})

		const chunks = await collectStream(stream)

		const textChunks = chunks.filter((c) => c.type === "text")
		expect(textChunks.length).toBeGreaterThan(0)
		expect(textChunks.map((c) => c.text).join("")).toContain("hello from spark")
	})

	it("yields text when Codex emits assistant message only in response.completed output", async () => {
		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")
		;(handler as any).client = {
			responses: {
				create: vi.fn().mockResolvedValue(
					asyncStreamFrom([
						{
							type: "response.completed",
							response: {
								id: "resp_completed_only",
								status: "completed",
								output: [
									{
										type: "message",
										role: "assistant",
										content: [{ type: "output_text", text: "final payload only" }],
									},
								],
								usage: { input_tokens: 1, output_tokens: 2 },
							},
						},
					]),
				),
			},
		}

		const stream = handler.createMessage("system", [{ role: "user", content: "test" } as any], {
			taskId: "t",
			tools: [],
		})

		const chunks = await collectStream(stream)

		const textChunks = chunks.filter((c) => c.type === "text")
		expect(textChunks.length).toBeGreaterThan(0)
		expect(textChunks.map((c) => c.text).join("")).toContain("final payload only")
	})

	it("yields text when Codex emits response.output_text.done without deltas", async () => {
		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")
		;(handler as any).client = {
			responses: {
				create: vi.fn().mockResolvedValue(
					asyncStreamFrom([
						{
							type: "response.output_text.done",
							text: "done-event text only",
						},
						{
							type: "response.completed",
							response: {
								id: "resp_done_text_only",
								status: "completed",
								output: [],
								usage: { input_tokens: 1, output_tokens: 2 },
							},
						},
					]),
				),
			},
		}

		const stream = handler.createMessage("system", [{ role: "user", content: "test" } as any], {
			taskId: "t",
			tools: [],
		})

		const chunks = await collectStream(stream)

		const textChunks = chunks.filter((c) => c.type === "text")
		expect(textChunks.length).toBeGreaterThan(0)
		expect(textChunks.map((c) => c.text).join("")).toContain("done-event text only")
	})

	it("yields a replaceable partial when Codex emits function_call only in response.output_item.done", async () => {
		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")
		;(handler as any).client = {
			responses: {
				create: vi.fn().mockResolvedValue(
					asyncStreamFrom([
						{
							type: "response.output_item.done",
							item: {
								type: "function_call",
								call_id: "call_done_only",
								name: "attempt_completion",
								arguments: '{"result":"ok"}',
							},
							output_index: 0,
						},
						{
							type: "response.completed",
							response: {
								id: "resp_done_tool_only",
								status: "completed",
								output: [],
								usage: { input_tokens: 1, output_tokens: 2 },
							},
						},
					]),
				),
			},
		}

		const stream = handler.createMessage("system", [{ role: "user", content: "test" } as any], {
			taskId: "t",
			tools: [],
		})

		const chunks = await collectStream(stream)

		const toolCalls = chunks.filter((c) => c.type === "tool_call_partial")
		expect(toolCalls.length).toBeGreaterThan(0)
		expect(toolCalls[0]).toMatchObject({
			type: "tool_call_partial",
			replaceArguments: true,
			id: "call_done_only",
			name: "attempt_completion",
		})
	})

	it("yields text when Codex emits response.content_part.added", async () => {
		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")
		;(handler as any).client = {
			responses: {
				create: vi.fn().mockResolvedValue(
					asyncStreamFrom([
						{
							type: "response.content_part.added",
							part: {
								type: "output_text",
								text: "content part text",
							},
							output_index: 0,
							content_index: 0,
						},
						{
							type: "response.completed",
							response: {
								id: "resp_content_part",
								status: "completed",
								output: [],
								usage: { input_tokens: 1, output_tokens: 2 },
							},
						},
					]),
				),
			},
		}

		const stream = handler.createMessage("system", [{ role: "user", content: "test" } as any], {
			taskId: "t",
			tools: [],
		})

		const chunks = await collectStream(stream)

		const textChunks = chunks.filter((c) => c.type === "text")
		expect(textChunks.length).toBeGreaterThan(0)
		expect(textChunks.map((c) => c.text).join("")).toContain("content part text")
	})

	it("does not duplicate text when Codex emits delta and output_text.done", async () => {
		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")
		;(handler as any).client = {
			responses: {
				create: vi.fn().mockResolvedValue(
					asyncStreamFrom([
						{ type: "response.output_text.delta", delta: "hello " },
						{ type: "response.output_text.delta", delta: "world" },
						{ type: "response.output_text.done", text: "hello world" },
						{
							type: "response.completed",
							response: {
								id: "resp_delta_done",
								status: "completed",
								output: [],
								usage: { input_tokens: 1, output_tokens: 2 },
							},
						},
					]),
				),
			},
		}

		const stream = handler.createMessage("system", [{ role: "user", content: "test" } as any], {
			taskId: "t",
			tools: [],
		})

		const chunks = await collectStream(stream)

		const textChunks = chunks.filter((c) => c.type === "text")
		expect(textChunks.map((c) => c.text).join("")).toBe("hello world")
	})

	it("does not duplicate text when Codex emits delta and content_part.added", async () => {
		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")
		;(handler as any).client = {
			responses: {
				create: vi.fn().mockResolvedValue(
					asyncStreamFrom([
						{ type: "response.output_text.delta", delta: "hello world" },
						{
							type: "response.content_part.added",
							part: { type: "output_text", text: "hello world" },
							output_index: 0,
							content_index: 0,
						},
						{
							type: "response.completed",
							response: {
								id: "resp_delta_content_part",
								status: "completed",
								output: [],
								usage: { input_tokens: 1, output_tokens: 2 },
							},
						},
					]),
				),
			},
		}

		const stream = handler.createMessage("system", [{ role: "user", content: "test" } as any], {
			taskId: "t",
			tools: [],
		})

		const chunks = await collectStream(stream)

		const textChunks = chunks.filter((c) => c.type === "text")
		expect(textChunks.map((c) => c.text).join("")).toBe("hello world")
	})

	it("identifies SDK requests as Zoo Code", async () => {
		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")

		const mockCreate = vi.fn().mockResolvedValue(
			asyncStreamFrom([
				{ type: "response.output_text.delta", delta: "ok" },
				{
					type: "response.completed",
					response: {
						id: "resp_sdk_headers",
						status: "completed",
						output: [],
						usage: { input_tokens: 1, output_tokens: 1 },
					},
				},
			]),
		)
		;(handler as any).client = { responses: { create: mockCreate } }

		const stream = handler.createMessage("system", [{ role: "user", content: "headers" } as any], {
			taskId: "task-123",
			tools: [],
		})
		await collectStream(stream)

		expect(mockCreate).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				headers: expect.objectContaining({
					originator: "zoo-code",
					session_id: "task-123",
					"ChatGPT-Account-Id": "acct_test",
					"User-Agent": expect.stringContaining(`zoo-code/${Package.version}`),
				}),
			}),
		)
	})

	it("identifies fetch fallback requests as Zoo Code", async () => {
		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")

		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(
						new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"fallback"}\n\n'),
					)
					controller.enqueue(
						new TextEncoder().encode(
							'data: {"type":"response.completed","response":{"id":"resp_fetch_headers","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
						),
					)
					controller.close()
				},
			}),
		})
		global.fetch = mockFetch as any
		;(handler as any).client = {
			responses: {
				create: vi.fn().mockRejectedValue(new Error("SDK unavailable")),
			},
		}

		const stream = handler.createMessage("system", [{ role: "user", content: "fallback" } as any], {
			taskId: "task-456",
			tools: [],
		})
		await collectStream(stream)

		expect(mockFetch).toHaveBeenCalledWith(
			expect.stringContaining("/responses"),
			expect.objectContaining({
				headers: expect.objectContaining({
					originator: "zoo-code",
					session_id: "task-456",
					"ChatGPT-Account-Id": "acct_test",
					"User-Agent": expect.stringContaining(`zoo-code/${Package.version}`),
				}),
			}),
		)
	})

	it("identifies completePrompt requests as Zoo Code", async () => {
		vi.spyOn(openAiCodexOAuthManager, "getAccessToken").mockResolvedValue("test-token")
		vi.spyOn(openAiCodexOAuthManager, "getAccountId").mockResolvedValue("acct_test")

		// Completions stream like everything else, so the SDK path is forced to fail and the
		// hand-built SSE request is what these assertions inspect.
		Reflect.set(handler, "client", {
			responses: { create: vi.fn().mockRejectedValue(new Error("SDK unavailable")) },
		})
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(
						new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"done"}\n\n'),
					)
					controller.close()
				},
			}),
		})
		global.fetch = mockFetch as any

		await expect(handler.completePrompt("Test prompt")).resolves.toBe("done")

		const fetchOptions = mockFetch.mock.calls[0][1]
		const body = JSON.parse(fetchOptions.body)
		expect(body.input).toEqual([
			{
				role: "user",
				content: [{ type: "input_text", text: "Test prompt" }],
			},
		])
		expect(body).not.toHaveProperty("prompt_cache_key")
		expect(body.reasoning?.context).toBeUndefined()
		expect(body.input).not.toContainEqual(expect.objectContaining({ type: "additional_tools" }))
		expect(body.input).not.toContainEqual(expect.objectContaining({ role: "developer" }))
		expect(fetchOptions.headers).not.toHaveProperty("session-id")
		expect(fetchOptions.headers).not.toHaveProperty("x-session-affinity")
		expect(fetchOptions.headers).not.toHaveProperty("version")
		expect(fetchOptions.headers).not.toHaveProperty("x-openai-internal-codex-responses-lite")
		expect(mockFetch).toHaveBeenCalledWith(
			expect.stringContaining("/responses"),
			expect.objectContaining({
				headers: expect.objectContaining({
					originator: "zoo-code",
					"ChatGPT-Account-Id": "acct_test",
					"User-Agent": expect.stringContaining(`zoo-code/${Package.version}`),
					session_id: expect.any(String),
				}),
			}),
		)
	})
})

// Exercise the provider/parser contract used by Task, without executing any tools.
describe("Codex authoritative tool arguments", () => {
	const added = (id = "a", output_index = 2) => ({
		type: "response.output_item.added",
		output_index,
		item: { type: "function_call", id: `fc_${id}`, call_id: id, name: "read_file", arguments: "" },
	})
	const delta = (value: string, id = "a") => ({
		type: "response.function_call_arguments.delta",
		item_id: `fc_${id}`,
		delta: value,
	})
	const done = (value: unknown, id = "a") => ({
		type: "response.function_call_arguments.done",
		item_id: `fc_${id}`,
		arguments: value,
	})
	const itemDone = (value: unknown, id = "a", output_index = 2) => ({
		...added(id, output_index),
		type: "response.output_item.done",
		item: { ...added(id, output_index).item, arguments: value },
	})
	async function consume(events: object[]) {
		const handler = new OpenAiCodexHandler({})
		const scope = NativeToolCallParser.createScope()
		const starts: string[] = []
		const chunks: ApiStreamChunk[] = []
		for (const input of events) {
			for await (const chunk of handler["processEvent"](input, handler.getModel())) {
				chunks.push(chunk)
				expect(chunk.type).toBe("tool_call_partial")
				if (chunk.type !== "tool_call_partial") continue
				for (const event of NativeToolCallParser.processRawChunk(chunk, scope)) {
					if (event.type === "tool_call_start") {
						starts.push(event.id)
						NativeToolCallParser.startStreamingToolCall(event.id, event.name, scope)
					} else if (event.type === "tool_call_delta") {
						const partial = NativeToolCallParser.processStreamingChunk(event.id, event.delta, scope)
						if (partial) expect(partial.partial).toBe(true)
					}
				}
			}
		}
		const ends = NativeToolCallParser.finalizeRawChunks(scope)
		const results = ends.map((event) => NativeToolCallParser.finalizeStreamingToolCall(event.id, scope))
		expect(NativeToolCallParser.finalizeRawChunks(scope)).toEqual([])
		for (const event of ends) expect(NativeToolCallParser.finalizeStreamingToolCall(event.id, scope)).toBeNull()
		return { starts, ends, results, chunks }
	}
	it.each(["arguments", "item", "both"])("repairs incomplete deltas using %s completion", async (kind) => {
		const events: object[] = [added(), delta('{"path":"old')]
		if (kind !== "item") events.push(done('{"path":"fixed"}'))
		if (kind !== "arguments") events.push(itemDone('{"path":"fixed"}'))
		const result = await consume(events)
		expect(result.starts).toEqual(["a"])
		expect(result.ends).toHaveLength(1)
		expect(result.results).toEqual([expect.objectContaining({ nativeArgs: { path: "fixed" }, partial: false })])
	})
	it("keeps valid streaming and both done events exactly once, ignoring late deltas", async () => {
		const result = await consume([
			added(),
			delta('{"path":"ok"}'),
			done('{"path":"ok"}'),
			itemDone('{"path":"ok"}'),
			delta("garbage"),
			itemDone('{"path":"ok"}'),
		])
		expect(result.starts).toEqual(["a"])
		expect(result.results).toHaveLength(1)
		expect(result.results[0]).toMatchObject({ nativeArgs: { path: "ok" } })
	})
	it.each(["arguments", "item"])("supports %s done-only fallback", async (kind) => {
		const event =
			kind === "item"
				? itemDone({ path: "ok" })
				: {
						type: "response.tool_call_arguments.done",
						call_id: "a",
						name: "read_file",
						arguments: '{"path":"ok"}',
					}
		const result = await consume([event, event])
		expect(result.starts).toEqual(["a"])
		expect(result.results).toEqual([expect.objectContaining({ nativeArgs: { path: "ok" } })])
	})
	it.each(['{"path":"broken', "", "null", "[]", "42", undefined])(
		"rejects malformed completed payload %j",
		async (value) => {
			const result = await consume([added(), delta('{"path":"previous-valid"}'), done(value)])
			expect(result.results).toEqual([null])
		},
	)
	it("allows a later authoritative item to repair malformed argument-done", async () => {
		const result = await consume([added(), done("{"), itemDone('{"path":"fixed"}')])
		expect(result.results[0]).toMatchObject({ nativeArgs: { path: "fixed" } })
	})
	it("preserves truncation rejection when no completion arrives", async () => {
		const result = await consume([added(), delta('{"path":"cut')])
		expect(result.results).toEqual([null])
	})
	it("routes interleaved item IDs and output indexes independently", async () => {
		const result = await consume([
			added("a", 7),
			added("b", 3),
			delta('{"path":"a', "a"),
			delta('{"path":"b', "b"),
			done('{"path":"A"}', "a"),
			{ type: "response.tool_call_arguments.done", output_index: 3, arguments: '{"path":"B"}' },
			itemDone('{"path":"A"}', "a", 7),
			itemDone('{"path":"B"}', "b", 3),
		])
		expect(result.starts).toEqual(["a", "b"])
		expect(result.results).toEqual([
			expect.objectContaining({ nativeArgs: { path: "A" } }),
			expect.objectContaining({ nativeArgs: { path: "B" } }),
		])
	})
	it("normalizes item aliases and supports explicit IDs without output indexes", async () => {
		const result = await consume([
			added(),
			{ type: "response.function_call_arguments.delta", id: "fc_a", delta: '{"path":"old' },
			{ type: "response.function_call_arguments.done", call_id: "a", arguments: '{"path":"fixed"}' },
			{ type: "response.tool_call_arguments.done", call_id: "b", name: "read_file", arguments: '{"path":"B"}' },
		])
		expect(result.starts).toEqual(["a", "b"])
		expect(result.results).toEqual([
			expect.objectContaining({ nativeArgs: { path: "fixed" } }),
			expect.objectContaining({ nativeArgs: { path: "B" } }),
		])
	})
	it("does not assign unknown or ambiguous events to the last call", async () => {
		const result = await consume([
			added(),
			added("b", 3),
			{ type: "response.function_call_arguments.done", arguments: '{"path":"wrong"}' },
			done('{"path":"wrong"}', "unknown"),
		])
		expect(result.starts).toEqual([])
	})
})
