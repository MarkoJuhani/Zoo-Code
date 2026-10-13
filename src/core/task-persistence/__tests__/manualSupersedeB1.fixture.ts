import type { ApiMessage } from "../apiMessages"
import {
	classifyManualSupersedeResultIdentity,
	type ManualSupersedeResultIdentityInput,
} from "../manualSupersedeResultIdentity"

export function b1Fixture(actionId = "old"): {
	input: Omit<ManualSupersedeResultIdentityInput, "effectiveHistory">
	history: ApiMessage[]
} {
	const action = {
		kind: "create_subtask",
		actionId,
		mode: "code",
		message: "work",
		todos: [],
		approvalText: JSON.stringify({ tool: "newTask", mode: "Code", content: "work", todos: [] }),
	}
	const history: ApiMessage[] = [
		{ role: "user", content: "initial instruction" },
		{
			role: "assistant",
			content: [
				{ type: "text", text: "handoff" },
				{ type: "tool_use", id: actionId, name: "new_task", input: { mode: "code", message: "work" } },
			],
		},
	]
	const input = {
		storageRoot: { requestedPath: "/synthetic/canonical", canonicalRealPath: "/synthetic/canonical" },
		target: { parentId: "parent", rootTaskId: "root", oldAction: structuredClone(action) },
		root: { id: "root", rootTaskId: "root" },
		parent: {
			id: "parent",
			parentTaskId: "root",
			rootTaskId: "root",
			status: "interrupted",
			pendingAction: action,
		},
		lineage: ["root", "parent"],
		approvalMode: { slug: "code", displayName: "Code" },
		rawHistory: { kind: "parsed" as const, value: history },
	}
	const observation = classifyManualSupersedeResultIdentity({
		...input,
		effectiveHistory: { kind: "parsed", value: structuredClone(history) },
	})
	if (!observation.identity) throw new Error("Invalid B1 test fixture")
	history.push(observation.identity.proposedMessage)
	return { input, history }
}
