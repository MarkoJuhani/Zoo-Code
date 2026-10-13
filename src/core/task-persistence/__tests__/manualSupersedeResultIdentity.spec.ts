import { createHash } from "node:crypto"

import {
	classifyManualSupersedeResultIdentity,
	MANUAL_SUPERSEDE_B1_TRUTH,
	MANUAL_SUPERSEDE_B1_VERSION,
	type ManualSupersedeResultIdentityInput,
	type ManualSupersedeResultObservation,
	type ManualSupersedeV1Identity,
} from "../manualSupersedeResultIdentity"

// In-memory synthetic evidence only: no production preparation/adapter, filesystem, host or writer.
const todoText = "- [ ] First\n- [-] Second\n- [x] Third"
const todos = [
	{ id: "8816966ad7d96e70402e478c15a25281", content: "First", status: "pending" },
	{ id: "714af93cb2107fbd45265ea2e8a20ec3", content: "Second", status: "in_progress" },
	{ id: "d3b306b5e56d4af48789c6f030060a58", content: "Third", status: "completed" },
]
const makeAction = (message = "work", items = todos) => ({
	kind: "create_subtask",
	actionId: "old",
	mode: "code",
	message: message.replace(/\\\\@/g, "\\@"),
	todos: items,
	approvalText: JSON.stringify({ tool: "newTask", mode: "Code", content: message, todos: items }),
})
function fixture(): ManualSupersedeResultIdentityInput {
	const action = makeAction()
	const messages = [
		{ role: "user", content: "initial instruction" },
		{
			role: "assistant",
			content: [
				{ type: "text", text: "handoff" },
				{
					type: "tool_use",
					id: "old",
					name: "new_task",
					input: { mode: "code", message: "work", todos: todoText },
				},
			],
		},
	]
	return structuredClone({
		storageRoot: { requestedPath: "/synthetic/canonical", canonicalRealPath: "/synthetic/canonical" },
		target: { parentId: "parent", rootTaskId: "root", oldAction: structuredClone(action) },
		root: { id: "root", rootTaskId: "root" },
		parent: {
			id: "parent",
			parentTaskId: "root",
			rootTaskId: "root",
			status: "interrupted",
			pendingAction: action,
			childIds: ["historical-child"],
		},
		lineage: ["root", "parent"],
		approvalMode: { slug: "code", displayName: "Code" },
		rawHistory: { kind: "parsed", value: messages },
		effectiveHistory: { kind: "parsed", value: structuredClone(messages) },
	})
}
type Message = { role: string; content: unknown }
const raw = (input: ManualSupersedeResultIdentityInput): Message[] => {
	if (input.rawHistory.kind !== "parsed") throw new Error("Fixture requires parsed history")
	return input.rawHistory.value as Message[]
}
const callBlock = (input: ManualSupersedeResultIdentityInput): Record<string, unknown> =>
	(raw(input)[1].content as Record<string, unknown>[])[1]
const callInput = (input: ManualSupersedeResultIdentityInput): Record<string, unknown> =>
	callBlock(input).input as Record<string, unknown>
const parent = (input: ManualSupersedeResultIdentityInput): Record<string, unknown> =>
	input.parent as Record<string, unknown>
const action = (input: ManualSupersedeResultIdentityInput): Record<string, unknown> =>
	parent(input).pendingAction as Record<string, unknown>
const syncProjection = (input: ManualSupersedeResultIdentityInput): void => {
	input.effectiveHistory = structuredClone(input.rawHistory)
}
const inspect = (input: unknown) => classifyManualSupersedeResultIdentity(input)
const identityOf = (input: ManualSupersedeResultIdentityInput): ManualSupersedeV1Identity => {
	const identity = inspect(input).identity
	if (!identity) throw new Error("Valid synthetic fixture needs an identity")
	return identity
}
function withResult(): ManualSupersedeResultIdentityInput {
	const input = fixture()
	raw(input).push(identityOf(input).proposedMessage)
	syncProjection(input)
	return input
}
const resultBlock = (input: ManualSupersedeResultIdentityInput): Record<string, unknown> =>
	(raw(input).at(-1)?.content as Record<string, unknown>[])[0]
function assertNoAuthority(observation: ManualSupersedeResultObservation): void {
	expect(observation.writeAuthorized).toBe(false)
	expect(observation.historicalChildOutcome).toBe("unknown")
	expect(observation.unknown).toEqual(
		expect.arrayContaining([
			"historical_child_outcome_unknown",
			"provider_effective_history_unverified",
			"host_writer_exclusion_unverified",
			"canonical_storage_root_unverified",
			"owner_inventory_unverified",
			"approval_mode_evidence_unverified",
		]),
	)
	expect(observation).not.toHaveProperty("eligible")
	expect(observation).not.toHaveProperty("ready")
}
function assertBlocked(input: unknown, reason?: string): void {
	const observation = inspect(input)
	assertNoAuthority(observation)
	expect(observation.disposition).toBe("blocked")
	expect(observation.classification).toBe("conflict_or_unknown")
	expect(observation.identity).toBeNull()
	if (reason) expect(observation.blocked).toContain(reason)
}

it("constructs the fixed ordered v1 tuple and a pinned SHA-256 without authority", () => {
	const observation = inspect(fixture())
	assertNoAuthority(observation)
	expect(observation).toMatchObject({ disposition: "unknown", classification: "no_result", blocked: [] })
	const identity = observation.identity!
	expect(identity.version).toBe(MANUAL_SUPERSEDE_B1_VERSION)
	expect(identity.digest).toBe("d66371213ffeb601bf4db59fafc3878f0cd7bff5fcb92c856d6a02a3f08e5c50")
	expect(createHash("sha256").update(identity.canonicalTuple, "utf8").digest("hex")).toBe(identity.digest)
	expect(JSON.parse(identity.canonicalTuple)).toEqual([
		MANUAL_SUPERSEDE_B1_VERSION,
		"/synthetic/canonical",
		"parent",
		makeAction(),
		"old",
		"new_task",
		{ mode: "code", message: "work", todos: todoText },
		1,
		1,
		MANUAL_SUPERSEDE_B1_TRUTH,
	])
	expect(identity.proposedMessage).toEqual({
		role: "user",
		content: [
			{
				type: "tool_result",
				tool_use_id: "old",
				is_error: true,
				content: `zoo.manual_supersede.B1.v1:${identity.digest}\n${MANUAL_SUPERSEDE_B1_TRUTH}`,
			},
		],
	})
})

it("recognizes exactly one matching proposed result, still UNKNOWN and never already-done authorization", () => {
	const observation = inspect(withResult())
	assertNoAuthority(observation)
	expect(observation).toMatchObject({
		disposition: "unknown",
		classification: "one_matching_proposed_result",
		blocked: [],
	})
	expect(observation.identity?.digest).toBe(identityOf(fixture()).digest)
})

it("is deterministic under key permutations, preserves array order and never mutates frozen input", () => {
	const input = fixture()
	const reorder = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(reorder)
		if (value !== null && typeof value === "object")
			return Object.fromEntries(
				Object.entries(value)
					.reverse()
					.map(([key, child]) => [key, reorder(child)]),
			)
		return value
	}
	const freeze = (value: unknown): void => {
		if (value !== null && typeof value === "object") {
			Object.values(value).forEach(freeze)
			Object.freeze(value)
		}
	}
	const before = JSON.stringify(input)
	freeze(input)
	expect(inspect(input)).toEqual(inspect(reorder(input)))
	expect(inspect(input)).toEqual(inspect(input))
	expect(JSON.stringify(input)).toBe(before)
	const changed = fixture()
	action(changed).todos = [...todos].reverse()
	assertBlocked(changed, "action_changed")
})

it("binds root, parent, raw message/block indices and full action instead of hashing the entire history", () => {
	const original = identityOf(fixture())
	const shifted = fixture()
	raw(shifted).unshift({ role: "user", content: "prefix" })
	syncProjection(shifted)
	expect(identityOf(shifted).digest).not.toBe(original.digest)
	const otherBlock = fixture()
	;(raw(otherBlock)[1].content as unknown[]).unshift({ type: "text", text: "more" })
	syncProjection(otherBlock)
	expect(identityOf(otherBlock).digest).not.toBe(original.digest)
	const rootChanged = fixture()
	rootChanged.storageRoot = { requestedPath: "/synthetic/other", canonicalRealPath: "/synthetic/other" }
	expect(identityOf(rootChanged).digest).not.toBe(original.digest)
	const parentChanged = fixture()
	parentChanged.target.parentId = "other-parent"
	parent(parentChanged).id = "other-parent"
	parentChanged.lineage[1] = "other-parent"
	expect(identityOf(parentChanged).digest).not.toBe(original.digest)
	const prefixChanged = fixture()
	raw(prefixChanged)[0].content = "different prefix"
	syncProjection(prefixChanged)
	expect(identityOf(prefixChanged).digest).toBe(original.digest)
	// Digest alone is not a whole-history comparison, authentication token or barrier.
})

it("uses exact original message/display-name approval derivation, JSON escaping and one-level unescaping", () => {
	const input = fixture()
	const message = 'quote " Unicode ☃\nbackslashes \\\\@ and \\@'
	const saved = makeAction(message)
	parent(input).pendingAction = saved
	input.target.oldAction = structuredClone(saved)
	callInput(input).message = message
	syncProjection(input)
	const observation = inspect(input)
	expect(observation.blocked).toEqual([])
	expect(JSON.parse(observation.identity!.canonicalTuple)[3].message).toBe(saved.message)
	assertNoAuthority(observation)
})

it.each([
	undefined,
	null,
	"{",
	{},
	{ kind: "parsed", value: null },
	{ kind: "parsed", value: {} },
	{ kind: "corrupt" },
	{ kind: "read_error" },
])("rejects malformed raw history %j rather than treating it as empty", (read) => {
	assertBlocked({ ...fixture(), rawHistory: read })
})
it.each([
	undefined,
	null,
	"{",
	{},
	{ kind: "parsed", value: null },
	{ kind: "parsed", value: {} },
	{ kind: "corrupt" },
	{ kind: "read_error" },
])("rejects failed or malformed effective projection %j", (read) => {
	assertBlocked({ ...fixture(), effectiveHistory: read })
})
it("distinguishes explicitly missing raw/effective histories from present empty histories", () => {
	assertBlocked({ ...fixture(), rawHistory: { kind: "missing" } }, "raw_history_missing")
	assertBlocked({ ...fixture(), effectiveHistory: { kind: "missing" } }, "effective_history_missing")
	assertBlocked(
		{ ...fixture(), rawHistory: { kind: "parsed", value: [] }, effectiveHistory: { kind: "parsed", value: [] } },
		"call_missing",
	)
})

it.each([
	"relative",
	"/synthetic/../canonical",
	"/synthetic//canonical",
	"/synthetic/./canonical",
	"/synthetic/canonical/",
	"/synthetic\\canonical",
	"/synthetic/\0canonical",
])("rejects noncanonical synthetic root %j", (root) => {
	const input = fixture()
	input.storageRoot = { requestedPath: root, canonicalRealPath: root }
	assertBlocked(input, "storage_root_alias")
})
it("rejects an explicit alias even when the supplied real path is normalized; never realpaths live storage", () => {
	const input = fixture()
	input.storageRoot.requestedPath = "/synthetic/link"
	assertBlocked(input, "storage_root_alias")
})

const metadataCases: [string, (input: ManualSupersedeResultIdentityInput) => void, string][] = [
	[
		"root mismatch",
		(i) => {
			i.root = { id: "other", rootTaskId: "other" }
		},
		"parent_root_mismatch",
	],
	[
		"parent mismatch",
		(i) => {
			parent(i).id = "other"
		},
		"parent_root_mismatch",
	],
	[
		"lineage mismatch",
		(i) => {
			i.lineage = ["root", "other", "parent"]
		},
		"parent_root_mismatch",
	],
	[
		"duplicate lineage",
		(i) => {
			i.lineage = ["root", "root", "parent"]
		},
		"parent_root_mismatch",
	],
	[
		"changed status",
		(i) => {
			parent(i).status = "active"
		},
		"status_changed",
	],
	[
		"pending question",
		(i) => {
			parent(i).pendingQuestion = { id: "question" }
		},
		"pending_question",
	],
	[
		"malformed question",
		(i) => {
			parent(i).pendingQuestion = null
		},
		"pending_question",
	],
	[
		"awaited owner",
		(i) => {
			parent(i).awaitingChildId = "child"
		},
		"known_child_owner",
	],
	[
		"delegated owner",
		(i) => {
			parent(i).delegatedToId = "child"
		},
		"known_child_owner",
	],
	[
		"malformed owner",
		(i) => {
			parent(i).awaitingChildId = null
		},
		"known_child_owner",
	],
	[
		"missing action",
		(i) => {
			delete parent(i).pendingAction
		},
		"parent_root_mismatch",
	],
	[
		"extra action field",
		(i) => {
			action(i).hostExited = true
		},
		"action_corrupt",
	],
	[
		"changed action ID",
		(i) => {
			action(i).actionId = "different"
		},
		"action_changed",
	],
	[
		"changed mode",
		(i) => {
			action(i).mode = "ask"
		},
		"action_changed",
	],
	[
		"changed message",
		(i) => {
			action(i).message = "different"
		},
		"action_changed",
	],
	[
		"changed approval",
		(i) => {
			action(i).approvalText = "{}"
		},
		"action_changed",
	],
	[
		"changed todo ID",
		(i) => {
			action(i).todos = [{ ...todos[0], id: "changed" }, ...todos.slice(1)]
		},
		"action_changed",
	],
	[
		"changed todo status",
		(i) => {
			action(i).todos = [{ ...todos[0], status: "completed" }, ...todos.slice(1)]
		},
		"action_changed",
	],
	[
		"changed todo content",
		(i) => {
			action(i).todos = [{ ...todos[0], content: "changed" }, ...todos.slice(1)]
		},
		"action_changed",
	],
	[
		"unavailable original mode",
		(i) => {
			i.approvalMode.displayName = ""
		},
		"approval_derivation_mismatch",
	],
	[
		"different original label",
		(i) => {
			i.approvalMode.displayName = "Other"
		},
		"approval_derivation_mismatch",
	],
]
it.each(metadataCases)("blocks %s", (_name, mutate, reason) => {
	const input = fixture()
	mutate(input)
	assertBlocked(input, reason)
})

it.each(["mode", "message", "todos"])("rejects changed terminal input %s even with unchanged saved action", (field) => {
	const input = fixture()
	callInput(input)[field] = "changed"
	syncProjection(input)
	assertBlocked(input, "call_changed")
})
it("rejects approval that parses equivalently but was not the original exact derived string", () => {
	const input = fixture()
	action(input).approvalText = JSON.stringify(JSON.parse(String(action(input).approvalText)), null, 2)
	input.target.oldAction = structuredClone(action(input))
	assertBlocked(input, "approval_derivation_mismatch")
})
it.each([undefined, "", null, [], "ignored junk\n- [ ] First"])(
	"refuses absent, malformed or derivation-mismatched todos %j",
	(changed) => {
		const input = fixture()
		if (changed === undefined) delete callInput(input).todos
		else callInput(input).todos = changed
		syncProjection(input)
		assertBlocked(input, "call_changed")
	},
)
it("accepts absent/empty checklist only when the full action and approval both derive empty todos", () => {
	for (const checklist of [undefined, "", "\n"]) {
		const input = fixture()
		const saved = makeAction("work", [])
		parent(input).pendingAction = saved
		input.target.oldAction = structuredClone(saved)
		if (checklist === undefined) delete callInput(input).todos
		else callInput(input).todos = checklist
		syncProjection(input)
		expect(inspect(input).classification).toBe("no_result")
	}
})

const historyCases: [string, (input: ManualSupersedeResultIdentityInput) => void][] = [
	[
		"missing call",
		(i) => {
			raw(i).pop()
		},
	],
	[
		"wrong name",
		(i) => {
			callBlock(i).name = "other_tool"
		},
	],
	[
		"wrong ID",
		(i) => {
			callBlock(i).id = "other"
		},
	],
	[
		"unsanitized ID",
		(i) => {
			callBlock(i).id = "old!"
		},
	],
	[
		"wrong call role",
		(i) => {
			raw(i)[1].role = "user"
		},
	],
	[
		"duplicate call",
		(i) => {
			raw(i).push(structuredClone(raw(i)[1]))
		},
	],
	[
		"nonterminal block",
		(i) => {
			;(raw(i)[1].content as unknown[]).push({ type: "text", text: "later" })
		},
	],
	[
		"later user",
		(i) => {
			raw(i).push({ role: "user", content: "later" })
		},
	],
	[
		"later assistant",
		(i) => {
			raw(i).push({ role: "assistant", content: "later" })
		},
	],
	[
		"unresolved sibling",
		(i) => {
			;(raw(i)[1].content as unknown[]).unshift({ type: "tool_use", id: "sibling", name: "read_file", input: {} })
		},
	],
	[
		"orphan result",
		(i) => {
			raw(i).unshift({
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "orphan", content: "orphan" }],
			})
		},
	],
	[
		"unknown block",
		(i) => {
			;(raw(i)[1].content as unknown[]).unshift({ type: "unknown" })
		},
	],
	[
		"malformed text",
		(i) => {
			;(raw(i)[1].content as unknown[])[0] = { type: "text", text: null }
		},
	],
	[
		"unknown role",
		(i) => {
			raw(i)[0].role = "system"
		},
	],
	[
		"missing input",
		(i) => {
			delete callBlock(i).input
		},
	],
	[
		"extra input",
		(i) => {
			callInput(i).approved = true
		},
	],
]
it.each(historyCases)("fails closed on %s in the full ordered history", (_name, mutate) => {
	const input = fixture()
	mutate(input)
	syncProjection(input)
	assertBlocked(input)
})

it("accepts an earlier resolved ordinary pair but rejects duplicate, delayed and unresolved prior results", () => {
	const input = fixture()
	const use = {
		role: "assistant",
		content: [{ type: "tool_use", id: "earlier", name: "read_file", input: { path: "synthetic" } }],
	}
	const result = { role: "user", content: [{ type: "tool_result", tool_use_id: "earlier", content: "read" }] }
	raw(input).unshift(use, result)
	syncProjection(input)
	expect(inspect(input).classification).toBe("no_result")
	const duplicate = structuredClone(input)
	raw(duplicate).splice(2, 0, result)
	syncProjection(duplicate)
	assertBlocked(duplicate, "orphan_or_duplicate_result")
	const delayed = structuredClone(input)
	raw(delayed).splice(1, 0, { role: "user", content: "intervening" })
	syncProjection(delayed)
	assertBlocked(delayed, "orphan_or_duplicate_result")
	const unresolved = structuredClone(input)
	raw(unresolved).splice(1, 1)
	syncProjection(unresolved)
	assertBlocked(unresolved, "unresolved_sibling")
})

const resultCases: [string, (input: ManualSupersedeResultIdentityInput) => void][] = [
	[
		"wrong role",
		(i) => {
			raw(i).at(-1)!.role = "assistant"
		},
	],
	[
		"wrong result ID",
		(i) => {
			resultBlock(i).tool_use_id = "other"
		},
	],
	[
		"success result",
		(i) => {
			resultBlock(i).is_error = false
		},
	],
	[
		"missing error flag",
		(i) => {
			delete resultBlock(i).is_error
		},
	],
	[
		"error without marker",
		(i) => {
			resultBlock(i).content = MANUAL_SUPERSEDE_B1_TRUTH
		},
	],
	[
		"wrong version",
		(i) => {
			resultBlock(i).content = String(resultBlock(i).content).replace("B1.v1:", "B1.v2:")
		},
	],
	[
		"wrong digest",
		(i) => {
			resultBlock(i).content = `zoo.manual_supersede.B1.v1:${"0".repeat(64)}\n${MANUAL_SUPERSEDE_B1_TRUTH}`
		},
	],
	[
		"uppercase digest",
		(i) => {
			resultBlock(i).content = String(resultBlock(i).content).replace(/[a-f0-9]{64}/, (hash) =>
				hash.toUpperCase(),
			)
		},
	],
	[
		"malformed digest",
		(i) => {
			resultBlock(i).content = `zoo.manual_supersede.B1.v1:bad\n${MANUAL_SUPERSEDE_B1_TRUTH}`
		},
	],
	[
		"wrong truth",
		(i) => {
			resultBlock(i).content = String(resultBlock(i).content).replace("unknown", "absent")
		},
	],
	[
		"extra newline",
		(i) => {
			resultBlock(i).content = String(resultBlock(i).content) + "\n"
		},
	],
	[
		"CRLF marker",
		(i) => {
			resultBlock(i).content = String(resultBlock(i).content).replace("\n", "\r\n")
		},
	],
	[
		"structured content",
		(i) => {
			resultBlock(i).content = [{ type: "text", text: String(resultBlock(i).content) }]
		},
	],
	[
		"extra block field",
		(i) => {
			resultBlock(i).cached = true
		},
	],
	[
		"duplicate result block",
		(i) => {
			;(raw(i).at(-1)!.content as unknown[]).push(structuredClone(resultBlock(i)))
		},
	],
	[
		"duplicate result message",
		(i) => {
			raw(i).push(structuredClone(raw(i).at(-1)!))
		},
	],
	[
		"sibling result",
		(i) => {
			;(raw(i).at(-1)!.content as unknown[]).push({
				type: "tool_result",
				tool_use_id: "sibling",
				content: "other",
			})
		},
	],
	[
		"additional text",
		(i) => {
			;(raw(i).at(-1)!.content as unknown[]).push({ type: "text", text: "instruction" })
		},
	],
	[
		"later assistant turn",
		(i) => {
			raw(i).push({ role: "assistant", content: "later" })
		},
	],
	[
		"result before call",
		(i) => {
			const result = raw(i).pop()!
			raw(i).unshift(result)
		},
	],
]
it.each(resultCases)("rejects %s rather than treating same ID/error as already done", (_name, mutate) => {
	const input = withResult()
	mutate(input)
	syncProjection(input)
	assertBlocked(input)
})

it("rejects a summary-hidden call and summary projection without importing the real provider pipeline", () => {
	const input = withResult()
	const summary = { role: "user", content: "summary", isSummary: true, summaryId: "summary" }
	raw(input).push(summary)
	input.effectiveHistory = { kind: "parsed", value: [summary] }
	assertBlocked(input, "history_visibility_changed")
	expect(inspect(input).blocked).toContain("call_missing")
})
it("rejects truncation tags even when caller projects the hidden call as visible", () => {
	const input = fixture()
	Object.assign(raw(input)[1], { truncationParent: "hidden" })
	syncProjection(input)
	assertBlocked(input, "history_visibility_changed")
})
it("rejects tool-result-to-text conversion in the explicitly supplied projection", () => {
	const input = withResult()
	const projection = structuredClone(raw(input))
	projection.at(-1)!.content = [{ type: "text", text: `Tool result:\n${String(resultBlock(input).content)}` }]
	input.effectiveHistory = { kind: "parsed", value: projection }
	assertBlocked(input, "effective_projection_changed")
})
it.each(["prefix", "input", "role", "call ID", "result", "metadata"])(
	"rejects changed effective %s independently of candidate digest",
	(part) => {
		const input = withResult()
		const projection = structuredClone(raw(input))
		if (part === "prefix") projection[0].content = "changed prefix"
		if (part === "input")
			(projection[1].content as Record<string, unknown>[])[1].input = { mode: "code", message: "changed" }
		if (part === "role") projection[0].role = "assistant"
		if (part === "call ID") (projection[1].content as Record<string, unknown>[])[1].id = "remapped"
		if (part === "result") projection.pop()
		if (part === "metadata") Object.assign(projection[0], { ts: 123 })
		input.effectiveHistory = { kind: "parsed", value: projection }
		assertBlocked(input, "effective_projection_changed")
	},
)

it("compares a supplied v1 candidate without trusting it as evidence", () => {
	const input = fixture()
	const identity = identityOf(input)
	input.proposedIdentity = { version: identity.version, digest: identity.digest, content: identity.content }
	assertNoAuthority(inspect(input))
	expect(inspect(input).classification).toBe("no_result")
	input.proposedIdentity.digest = "0".repeat(64)
	assertBlocked(input, "proposed_identity_mismatch")
	input.proposedIdentity = { version: "manual_supersede_B1/v2", digest: identity.digest, content: identity.content }
	assertBlocked(input, "proposed_identity_mismatch")
})
it("rejects caller completeness/approval flags rather than granting authority", () => {
	assertBlocked({ ...fixture(), providerEffectiveHistoryVerified: true }, "input_corrupt")
	assertBlocked({ ...fixture(), hostExited: true, approved: true }, "input_corrupt")
	assertBlocked(
		{ ...fixture(), effectiveHistory: { ...fixture().effectiveHistory, complete: true } },
		"effective_history_corrupt",
	)
})

it("fails closed on non-JSON values, cycles, sparse arrays and accessors without invoking a getter", () => {
	const cycle: Record<string, unknown> = {}
	cycle.self = cycle
	const sparse = Array(2)
	const getter = vi.fn(() => "work")
	const accessed = fixture()
	Object.defineProperty(callInput(accessed), "message", { get: getter, enumerable: true })
	for (const malformed of [undefined, NaN, Infinity, -0, 1n, () => true, new Date(), cycle, sparse, accessed])
		assertBlocked(malformed, "input_corrupt")
	expect(getter).not.toHaveBeenCalled()
	const tooDeep: unknown[] = []
	let cursor = tooDeep
	for (let depth = 0; depth < 70; depth++) {
		const next: unknown[] = []
		cursor.push(next)
		cursor = next
	}
	assertBlocked(tooDeep, "input_corrupt")
	assertBlocked({ ...fixture(), root: "x".repeat(2 * 1024 * 1024) }, "input_corrupt")
})

it("model-only commit-then-error/read-back witness: no disk-fault, rename or writer-participation proof", () => {
	const before = fixture()
	const committedModel = withResult()
	const simulatedOutcome = { exception: "simulated after model commit", observation: committedModel }
	expect(simulatedOutcome.exception).toBeTruthy()
	expect(inspect(simulatedOutcome.observation).classification).toBe("one_matching_proposed_result")
	assertNoAuthority(inspect(simulatedOutcome.observation))
	assertBlocked({ ...committedModel, rawHistory: { kind: "read_error" } }, "raw_history_corrupt")
	assertBlocked({ ...committedModel, effectiveHistory: { kind: "read_error" } }, "effective_history_corrupt")
	expect(inspect(before).classification).toBe("no_result")
	const restartObservation = inspect(structuredClone(committedModel))
	expect(restartObservation.classification).toBe("one_matching_proposed_result")
	assertNoAuthority(restartObservation)
	expect(raw(committedModel)).toHaveLength(3)
})
