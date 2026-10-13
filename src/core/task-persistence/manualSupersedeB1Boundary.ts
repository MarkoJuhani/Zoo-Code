import { getEffectiveApiHistory } from "../condense"
import { sanitizeOpenAiCallId } from "../../utils/tool-id"
import type { ApiMessage } from "./apiMessages"
import {
	classifyManualSupersedeResultIdentity,
	type ManualSupersedeResultIdentityInput,
	type ManualSupersedeResultObservation,
} from "./manualSupersedeResultIdentity"

export interface ManualSupersedeB1BoundaryObservation {
	disposition: "blocked" | "unknown"
	wire: "matching_named_fixture" | "unverified"
	runtimeSelection: "unknown"
	writeAuthorized: false
	ready: false
	blocked: string[]
	identity: ManualSupersedeResultObservation
}

/**
 * Unwired, read-only prerequisite. A captured body is comparison input, NOT trusted adapter,
 * runtime selection, root, owner or exclusion evidence. No write/eligibility token is returned.
 * Only the bounded plain text/native-tool shape tested offline is supported; other shapes refuse.
 */
export function observeManualSupersedeB1NativeBoundary(
	input: Omit<ManualSupersedeResultIdentityInput, "effectiveHistory">,
	capturedBody: unknown,
): ManualSupersedeB1BoundaryObservation {
	let identity = classifyManualSupersedeResultIdentity({ ...input, effectiveHistory: input.rawHistory })
	const blocked: string[] = []
	const report = (matching = false): ManualSupersedeB1BoundaryObservation => ({
		disposition: blocked.length || identity.disposition === "blocked" ? "blocked" : "unknown",
		wire: matching ? "matching_named_fixture" : "unverified",
		runtimeSelection: "unknown",
		writeAuthorized: false,
		ready: false,
		blocked,
		identity,
	})
	if (!identity.identity || input.rawHistory.kind !== "parsed") return report()
	try {
		// Classifier validation precedes the typed snapshot; callers cannot supply an effective projection.
		const history = JSON.parse(JSON.stringify(input.rawHistory.value)) as ApiMessage[]
		identity = classifyManualSupersedeResultIdentity({
			...input,
			rawHistory: { kind: "parsed", value: history },
			effectiveHistory: { kind: "parsed", value: getEffectiveApiHistory(history) },
		})
		if (!identity.identity || identity.classification !== "one_matching_proposed_result") return report()
		const normalized = new Map<string, string>()
		const expected: Record<string, unknown>[] = []
		for (const message of history) {
			const content: { type: string; text: string }[] = []
			const tools: Record<string, unknown>[] = []
			const blocks =
				typeof message.content === "string"
					? [{ type: "text" as const, text: message.content }]
					: message.content
			for (const block of blocks) {
				if (block.type === "text") {
					content.push({ type: message.role === "user" ? "input_text" : "output_text", text: block.text })
				} else if (block.type === "tool_use") {
					const callId = sanitizeOpenAiCallId(block.id)
					const previous = normalized.get(callId)
					if (previous !== undefined && previous !== block.id) blocked.push("normalized_id_collision")
					normalized.set(callId, block.id)
					tools.push({
						type: "function_call",
						call_id: callId,
						name: block.name,
						arguments: JSON.stringify(block.input),
					})
				} else if (block.type === "tool_result" && typeof block.content === "string") {
					tools.push({
						type: "function_call_output",
						call_id: sanitizeOpenAiCallId(block.tool_use_id),
						output: block.content,
					})
				} else {
					blocked.push("unsupported_wire_shape")
				}
			}
			if (content.length) expected.push({ role: message.role, content })
			expected.push(...tools)
		}
		if (!capturedBody || typeof capturedBody !== "object" || Array.isArray(capturedBody)) {
			blocked.push("request_body_unreadable")
			return report()
		}
		const serialized = JSON.stringify(capturedBody)
		if (Buffer.byteLength(serialized, "utf8") > 2 * 1024 * 1024) {
			blocked.push("request_size_cap")
			return report()
		}
		const body = JSON.parse(serialized) as Record<string, unknown>
		// Compare every ordered input item, not a digest or terminal-only projection. JSON property order
		// is irrelevant in envelopes; arguments/output strings remain byte-exact.
		let visited = 0
		const canonical = (value: unknown, depth = 0): string => {
			if (++visited > 100_000 || depth > 64) throw new Error("Request comparison cap")
			if (Array.isArray(value)) return `[${value.map((item) => canonical(item, depth + 1)).join(",")}]`
			if (value !== null && typeof value === "object") {
				const record = value as Record<string, unknown>
				return `{${Object.keys(record)
					.sort()
					.map((key) => `${JSON.stringify(key)}:${canonical(record[key], depth + 1)}`)
					.join(",")}}`
			}
			const encoded = JSON.stringify(value)
			if (encoded === undefined) throw new Error("Non-JSON capture")
			return encoded
		}
		if (body.model !== "gpt-4o" || canonical(body.input) !== canonical(expected))
			blocked.push("serialized_input_changed")
		return report(blocked.length === 0)
	} catch {
		blocked.push("request_boundary_unknown")
		return report()
	}
}
