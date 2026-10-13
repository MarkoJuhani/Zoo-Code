import * as crypto from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { inspectManualSupersedePreflight } from "../manualSupersedePreflight"

let base: string
const file = (id: string, name: string) => path.join(base, "tasks", id, name)
const save = async (id: string, name: string, value: unknown) => {
	await fs.mkdir(path.dirname(file(id, name)), { recursive: true })
	await fs.writeFile(file(id, name), JSON.stringify(value))
}
const action = {
	kind: "create_subtask" as const,
	actionId: "old",
	mode: "code",
	message: "work",
	todos: [],
	approvalText: JSON.stringify({ tool: "newTask", mode: "Code", content: "work", todos: [] }),
}
const root = { id: "root", rootTaskId: "root", status: "active" }
const parent = { id: "parent", parentTaskId: "root", rootTaskId: "root", status: "interrupted", pendingAction: action }
const call = {
	role: "assistant",
	content: [{ type: "tool_use", id: "old", name: "new_task", input: { mode: "code", message: "work" } }],
}
const run = () => inspectManualSupersedePreflight(base, "parent", "root", action)
const history = (messages: unknown[]) => save("parent", "api_conversation_history.json", messages)
const child = (id: string, status: string, extra: object = {}) =>
	save(id, "history_item.json", {
		id,
		parentTaskId: "parent",
		rootTaskId: "root",
		status,
		...extra,
	})

beforeEach(async () => {
	base = await fs.mkdtemp(path.join(os.tmpdir(), "i0-supersede-"))
	await save("root", "history_item.json", root)
	await save("parent", "history_item.json", parent)
	await history([call])
})
afterEach(async () => fs.rm(base, { recursive: true, force: true }))

it("reports only read-only facts and UNKNOWN historical outcome, without writing any disk entry", async () => {
	const before = await fs.readdir(path.join(base, "tasks", "parent"))
	const bytes = await Promise.all(before.map((name) => fs.readFile(file("parent", name))))
	const result = await run()
	expect(result).toMatchObject({
		kind: "read_only_facts",
		blocked: [],
		facts: {
			parentRead: "found",
			apiRead: "found",
			apiMessageCount: 1,
			oldCall: "single",
			oldResult: "none",
			historicalChildOutcome: "unknown",
		},
	})
	expect(result.unknown).toEqual([
		"historical_child_outcome_unknown",
		"provider_effective_history_unverified",
		"host_writer_exclusion_unverified",
	])
	expect(await fs.readdir(path.join(base, "tasks", "parent"))).toEqual(before)
	expect(await Promise.all(before.map((name) => fs.readFile(file("parent", name))))).toEqual(bytes)
	expect(await fs.readdir(base)).toEqual(["tasks"])
})

it("distinguishes missing, corrupt, and present-but-empty API history", async () => {
	await fs.rm(file("parent", "api_conversation_history.json"))
	expect(await run()).toMatchObject({
		blocked: ["api_missing"],
		facts: { apiRead: "missing", apiMessageCount: null },
	})
	await fs.writeFile(file("parent", "api_conversation_history.json"), "{")
	expect((await run()).blocked).toContain("api_corrupt")
	await history([])
	expect(await run()).toMatchObject({ blocked: ["call_missing"], facts: { apiRead: "found", apiMessageCount: 0 } })
	await history([{ role: "assistant", content: [{ type: "tool_use", id: "old", name: "new_task" }] }])
	expect((await run()).blocked).toContain("api_corrupt")
})

it("distinguishes missing or corrupt parent and mismatched root/action/status", async () => {
	await fs.rm(file("parent", "history_item.json"))
	expect((await run()).blocked).toContain("parent_missing")
	await fs.writeFile(file("parent", "history_item.json"), "null")
	expect((await run()).blocked).toContain("parent_corrupt")
	await save("parent", "history_item.json", {
		...parent,
		pendingAction: { ...action, message: "changed" },
		status: "active",
	})
	expect((await run()).blocked).toEqual(expect.arrayContaining(["action_changed", "status_changed"]))
	await save("parent", "history_item.json", { ...parent, rootTaskId: "other" })
	expect((await run()).blocked).toContain("root_mismatch")
	await save("parent", "history_item.json", { ...parent, pendingAction: { ...action, message: "changed" } })
	const forged = { ...action, hostExited: true, writerInventoryComplete: true, childRegistryComplete: true }
	expect((await inspectManualSupersedePreflight(base, "parent", "root", forged)).blocked).toContain("action_corrupt")
})

it("blocks pending question, awaited/delegated ownership and matching or active children", async () => {
	await save("parent", "history_item.json", { ...parent, pendingQuestion: { id: "q" }, awaitingChildId: "child" })
	expect((await run()).blocked).toEqual(expect.arrayContaining(["pending_question", "active_child_owner"]))
	await save("parent", "history_item.json", { ...parent, delegatedToId: "child" })
	expect((await run()).blocked).toContain("active_child_owner")
	await save("parent", "history_item.json", parent)
	await child("child", "active")
	expect((await run()).blocked).toContain("active_child_owner")
	const parentBytes = await fs.readFile(file("parent", "history_item.json"))
	const apiBytes = await fs.readFile(file("parent", "api_conversation_history.json"))
	const entries = await fs.readdir(path.join(base, "tasks"))
	await run()
	expect(await fs.readFile(file("parent", "history_item.json"))).toEqual(parentBytes)
	expect(await fs.readFile(file("parent", "api_conversation_history.json"))).toEqual(apiBytes)
	expect(await fs.readdir(path.join(base, "tasks"))).toEqual(entries)
})

it("never accepts a completed child tied only to the old call, even if listed on the parent", async () => {
	await save("parent", "history_item.json", { ...parent, childIds: ["matching"] })
	await child("matching", "completed")
	await history([
		call,
		{
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "old", content: "Delegated to child task matching" }],
		},
	])
	expect((await run()).blocked).toEqual(expect.arrayContaining(["conflicting_result", "possible_child_owner"]))
})

it("keeps earlier completed child historical and UNKNOWN, but blocks missing/masked ownership", async () => {
	await save("parent", "history_item.json", { ...parent, childIds: ["earlier"] })
	await child("earlier", "completed")
	expect((await run()).blocked).toContain("possible_child_owner")
	await history([
		{ role: "assistant", content: [{ type: "tool_use", id: "prior", name: "new_task", input: {} }] },
		{
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "prior", content: "Delegated to child task earlier" }],
		},
		call,
	])
	expect(await run()).toMatchObject({
		blocked: [],
		facts: { recordedChildIds: ["earlier"], historicalChildOutcome: "unknown" },
	})
	await history([
		{ role: "assistant", content: [{ type: "tool_use", id: "prior", name: "new_task", input: {} }] },
		{
			role: "assistant",
			content: [{ type: "tool_result", tool_use_id: "prior", content: "Delegated to child task earlier" }],
		},
		call,
	])
	expect((await run()).blocked).toEqual(
		expect.arrayContaining(["orphan_or_duplicate_result", "possible_child_owner"]),
	)
	await history([
		{ role: "assistant", content: [{ type: "tool_use", id: "prior", name: "new_task", input: {} }] },
		{
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "prior", content: "Delegated to child task earlier" }],
		},
		{
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "prior", content: "Delegated to child task earlier" }],
		},
		call,
	])
	expect((await run()).blocked).toContain("orphan_or_duplicate_result")
	await fs.mkdir(path.join(base, "tasks", "transient"))
	expect((await run()).blocked).toContain("registry_or_intent_ambiguous")
	await fs.rm(path.join(base, "tasks", "transient"), { recursive: true })
	await fs.rm(file("earlier", "history_item.json"))
	expect((await run()).blocked).toEqual(
		expect.arrayContaining(["possible_child_owner", "registry_or_intent_ambiguous"]),
	)
	await save("earlier", "_delegation_repair_intent.json", { parentTaskId: "parent" })
	expect((await run()).blocked).toContain("registry_or_intent_ambiguous")
})

it("checks full saved action, approval, raw tool input and parsed todos", async () => {
	const todos = [
		{
			id: crypto.createHash("md5").update("testpending").digest("hex"),
			content: "test",
			status: "pending" as const,
		},
	]
	await save("parent", "history_item.json", {
		...parent,
		pendingAction: {
			...action,
			todos,
			approvalText: JSON.stringify({ tool: "newTask", mode: "Code", content: "work", todos }),
		},
	})
	await history([
		{
			role: "assistant",
			content: [{ ...call.content[0], input: { mode: "code", message: "work", todos: "- [ ] test" } }],
		},
	])
	expect(
		(
			await inspectManualSupersedePreflight(base, "parent", "root", {
				...action,
				todos,
				approvalText: JSON.stringify({ tool: "newTask", mode: "Code", content: "work", todos }),
			})
		).blocked,
	).toEqual([])
	await history([
		{
			role: "assistant",
			content: [{ ...call.content[0], input: { mode: "code", message: "work", todos: "unparsed\n- [ ] test" } }],
		},
	])
	expect(
		(
			await inspectManualSupersedePreflight(base, "parent", "root", {
				...action,
				todos,
				approvalText: JSON.stringify({ tool: "newTask", mode: "Code", content: "work", todos }),
			})
		).blocked,
	).toContain("call_changed")
	await history([
		{
			role: "assistant",
			content: [{ ...call.content[0], input: { mode: "code", message: "other", todos: "- [ ] test" } }],
		},
	])
	expect((await run()).blocked).toEqual(expect.arrayContaining(["action_changed", "call_changed"]))
})

it("blocks duplicates, wrong role, siblings, later turns, conflicting results and orphans", async () => {
	const result = { type: "tool_result", tool_use_id: "old", content: "failed", is_error: true }
	await history([call, call])
	expect((await run()).blocked).toContain("call_duplicate")
	await history([{ role: "user", content: call.content }])
	expect((await run()).blocked).toContain("api_corrupt")
	await history([
		{
			role: "assistant",
			content: [call.content[0], { type: "tool_use", id: "sibling", name: "other", input: {} }],
		},
	])
	expect((await run()).blocked).toEqual(expect.arrayContaining(["unresolved_sibling", "call_not_terminal"]))
	await history([call, { role: "user", content: "later" }])
	expect((await run()).blocked).toEqual(expect.arrayContaining(["later_turn", "call_not_terminal"]))
	await history([call, { role: "user", content: [result] }])
	expect((await run()).blocked).toContain("conflicting_result")
	await history([call, { role: "user", content: [{ ...result, tool_use_id: "orphan" }] }])
	expect((await run()).blocked).toContain("orphan_or_duplicate_result")
	await history([call, { role: "user", content: [{ ...result, is_error: false }, result] }])
	expect((await run()).blocked).toEqual(expect.arrayContaining(["conflicting_result", "orphan_or_duplicate_result"]))
	await history([call, { role: "user", content: [{ ...result, content: [{ type: "image", source: {} }] }] }])
	expect((await run()).blocked).toEqual(expect.arrayContaining(["conflicting_result", "api_corrupt"]))
})
