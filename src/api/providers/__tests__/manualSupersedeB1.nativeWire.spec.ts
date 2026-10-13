import OpenAI from "openai"
import type { Anthropic } from "@anthropic-ai/sdk"
import { providerIdentifiers } from "@roo-code/types"
import { buildApiHandler } from "../../index"
import { OpenAiNativeHandler } from "../openai-native"
import { getEffectiveApiHistory, getMessagesSinceLastSummary } from "../../../core/condense"
import { Task } from "../../../core/task/Task"
import { mergeConsecutiveApiMessages } from "../../../core/task/mergeConsecutiveApiMessages"
import { prepareApiConversationMessage } from "../../../core/task/apiConversationHistory"
import { maybeRemoveImageBlocks } from "../../transform/image-cleaning"
import { b1Fixture } from "../../../core/task-persistence/__tests__/manualSupersedeB1.fixture"
import { observeManualSupersedeB1NativeBoundary } from "../../../core/task-persistence/manualSupersedeB1Boundary"
import { classifyManualSupersedeResultIdentity } from "../../../core/task-persistence/manualSupersedeResultIdentity"
import type { ApiMessage } from "../../../core/task-persistence/apiMessages"
import { collectStream } from "../../../test-utils/stream"

const configuration = {
	apiProvider: providerIdentifiers.openaiNative,
	apiModelId: "gpt-4o",
	openAiNativeApiKey: "offline-test-key",
}

async function capture(history: ApiMessage[]) {
	const handler = buildApiHandler(configuration)
	expect(handler).toBeInstanceOf(OpenAiNativeHandler)
	if (!(handler instanceof OpenAiNativeHandler)) throw new Error("Offline adapter dispatch changed")
	const bodies: string[] = []
	const offlineFetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
		if (typeof init?.body !== "string") throw new Error("Expected SDK serialized JSON body")
		bodies.push(init.body)
		return new Response(
			'data: {"type":"response.completed","response":{"output":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
			{
				status: 200,
				headers: { "content-type": "text/event-stream" },
			},
		)
	})
	// Real SDK serialization, but its only transport is this local in-memory fetch.
	handler["client"] = new OpenAI({
		apiKey: "offline-test-key",
		baseURL: "https://offline.invalid/v1",
		fetch: offlineFetch,
		maxRetries: 0,
	})
	const effective = getEffectiveApiHistory(history)
	const sinceSummary = getMessagesSinceLastSummary(effective)
	const merged = mergeConsecutiveApiMessages(sinceSummary, { roles: ["user"] })
	const withoutImages = maybeRemoveImageBlocks(merged, handler)
	// The cleaner uses only its arguments; borrowing the prototype avoids constructing/starting a Task.
	const clean = Task.prototype["buildCleanConversationHistory"].call(
		Task.prototype,
		withoutImages as ApiMessage[],
		handler.getModel().info,
	)
	const plain = clean.filter((message): message is Anthropic.MessageParam => "role" in message)
	expect(plain).toHaveLength(clean.length)
	await collectStream(handler.createMessage("offline system", plain))
	expect(offlineFetch).toHaveBeenCalledTimes(1)
	expect(bodies).toHaveLength(1)
	return { handler, body: JSON.parse(bodies[0]) as unknown }
}

describe("unwired B1 named native adapter final serialized request", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => {
				throw new Error("Remote request forbidden")
			}),
		)
	})
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("captures real dispatch/effective/cleaner/SDK output without resolving runtime selection", async () => {
		const { input, history } = b1Fixture()
		const { body } = await capture(history)
		const observation = observeManualSupersedeB1NativeBoundary(input, body)
		expect(observation).toMatchObject({
			disposition: "unknown",
			wire: "matching_named_fixture",
			writeAuthorized: false,
			ready: false,
			runtimeSelection: "unknown",
		})
		expect(observation.identity.classification).toBe("one_matching_proposed_result")
		expect(observation.identity.unknown).toContain("host_writer_exclusion_unverified")
	})

	it("documents envelope omission and normalized long call IDs without allowing collisions", async () => {
		const { input, history } = b1Fixture("x".repeat(80))
		const { body } = await capture(history)
		expect(observeManualSupersedeB1NativeBoundary(input, body).wire).toBe("matching_named_fixture")
		const collision = b1Fixture("x".repeat(80))
		const callId = (body as { input: { type: string; call_id?: string }[] }).input.find(
			(item) => item.type === "function_call",
		)?.call_id
		if (!callId) throw new Error("Missing captured call ID")
		collision.history.unshift(
			{
				role: "assistant",
				content: [{ type: "tool_use", id: callId, name: "read_file", input: { path: "fixture" } }],
			},
			{ role: "user", content: [{ type: "tool_result", tool_use_id: callId, content: "prior" }] },
		)
		collision.history.pop()
		const identity = classifyManualSupersedeResultIdentity({
			...collision.input,
			effectiveHistory: { kind: "parsed", value: collision.history },
		}).identity
		if (!identity) throw new Error("Invalid collision fixture")
		collision.history.push(identity.proposedMessage)
		const captured = await capture(collision.history)
		expect(observeManualSupersedeB1NativeBoundary(collision.input, captured.body).blocked).toContain(
			"normalized_id_collision",
		)
	})

	it.each(["output", "name", "arguments", "call_id"])("rejects changed serialized %s", async (field) => {
		const { input, history } = b1Fixture()
		const { body } = await capture(history)
		const altered = structuredClone(body) as { input: Record<string, unknown>[] }
		const item = altered.input.find(
			(item) => item.type === (field === "output" ? "function_call_output" : "function_call"),
		)
		if (!item) throw new Error("Missing request item")
		item[field] = "changed"
		expect(observeManualSupersedeB1NativeBoundary(input, altered).disposition).toBe("blocked")
	})

	it.each(["duplicate", "orphan", "sibling", "later", "action", "question", "owner", "root"])(
		"refuses %s evidence despite adapter serialization",
		async (kind) => {
			const { input, history } = b1Fixture()
			if (kind === "duplicate") history.push(structuredClone(history[2]))
			if (kind === "orphan")
				history[2] = {
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "orphan", content: "result" }],
				}
			if (kind === "sibling" && Array.isArray(history[1].content))
				history[1].content.push({ type: "tool_use", id: "sibling", name: "new_task", input: {} })
			if (kind === "later") history.push({ role: "user", content: "later" })
			if (kind === "action")
				input.target.oldAction = { ...(input.target.oldAction as object), message: "changed" }
			if (kind === "question")
				input.parent = { ...(input.parent as object), pendingQuestion: { questionId: "q" } }
			if (kind === "owner")
				input.parent = { ...(input.parent as object), status: "delegated", awaitingChildId: "known" }
			if (kind === "root") input.storageRoot.requestedPath = "/synthetic/alias"
			const { body } = await capture(history)
			expect(observeManualSupersedeB1NativeBoundary(input, body).disposition).toBe("blocked")
		},
	)

	it("rejects malformed, cyclic and oversized captures without granting authority", () => {
		const { input } = b1Fixture()
		const cyclic: { self?: unknown } = {}
		cyclic.self = cyclic
		for (const body of [null, {}, cyclic, { input: "x".repeat(2 * 1024 * 1024 + 1) }]) {
			expect(observeManualSupersedeB1NativeBoundary(input, body)).toMatchObject({
				disposition: "blocked",
				writeAuthorized: false,
				ready: false,
			})
		}
	})

	it("rejects a summary-hidden call after real effective filtering", async () => {
		const { input, history } = b1Fixture()
		history.push({ role: "user", content: "summary", isSummary: true })
		const { body } = await capture(history)
		expect(observeManualSupersedeB1NativeBoundary(input, body).disposition).toBe("blocked")
	})

	it("rejects ordinary preparation converting the result to text", async () => {
		const { input, history } = b1Fixture()
		const { handler } = await capture(history)
		const result = history.pop()
		if (!result) throw new Error("Missing fixture result")
		history.push({ role: "user", content: "intervening turn" })
		history.push(
			prepareApiConversationMessage({
				message: result,
				api: handler,
				apiConfiguration: configuration,
				apiConversationHistory: history,
			}),
		)
		const { body } = await capture(history)
		expect(observeManualSupersedeB1NativeBoundary(input, body).disposition).toBe("blocked")
	})
})
