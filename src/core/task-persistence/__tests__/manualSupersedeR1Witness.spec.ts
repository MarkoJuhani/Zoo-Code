import { describe, expect, it } from "vitest"

// R1 witness only: a deliberately small state model, NOT a production implementation or proof of exclusion.
type State = {
	call: "terminal" | "missing" | "sibling" | "later" | "corrupt"
	result: "none" | "ours" | "other" | "duplicate"
	action: "old" | "changed" | "cleared"
	status: "interrupted" | "active" | "delegated"
	owner: "none" | "matching" | "awaited" | "ambiguous"
	question: boolean
	apiReadable: boolean
	metadataReadable: boolean
	childIds: string[]
}
const initial = (): State => ({
	call: "terminal",
	result: "none",
	action: "old",
	status: "interrupted",
	owner: "none",
	question: false,
	apiReadable: true,
	metadataReadable: true,
	childIds: ["earlier"],
})
const eligible = (s: State): boolean =>
	s.apiReadable &&
	s.metadataReadable &&
	s.call === "terminal" &&
	s.action === "old" &&
	s.status === "interrupted" &&
	s.owner === "none" &&
	!s.question
// Hypothetical *write-time* predicates, called after the pause, not an in-memory pre-check.
const b1 = (s: State): "append" | "already" | "block" =>
	!eligible(s) ? "block" : s.result === "none" ? "append" : s.result === "ours" ? "already" : "block"
const b2 = (s: State): "repair" | "already" | "block" =>
	!s.apiReadable ||
	!s.metadataReadable ||
	s.call !== "terminal" ||
	s.result !== "ours" ||
	s.owner !== "none" ||
	s.question
		? "block"
		: s.action === "old" && s.status === "interrupted"
			? "repair"
			: s.action === "cleared" && s.status === "active"
				? "already"
				: "block"

describe("R1 unwired adversarial state witnesses (not an integration test)", () => {
	it.each([
		["missing API", { apiReadable: false }],
		["corrupt API", { call: "corrupt" }],
		["missing call", { call: "missing" }],
		["sibling", { call: "sibling" }],
		["later turn", { call: "later" }],
		["conflicting result", { result: "other" }],
		["duplicate result", { result: "duplicate" }],
		["matching child", { owner: "matching" }],
		["awaited child", { owner: "awaited" }],
		["ambiguous intent", { owner: "ambiguous" }],
		["pending question", { question: true }],
		["changed action", { action: "changed" }],
		["startup delegation", { status: "delegated" }],
		["stale metadata read", { metadataReadable: false }],
	] as const)("refuses B1 on %s", (_name, change) => {
		expect(b1({ ...initial(), ...change })).toBe("block")
	})
	it("paused prepare, ownership commit or start requires exclusion beyond the initial read", () => {
		for (const phase of ["prepare", "commit", "start"]) {
			const state = initial()
			expect(b1(state)).toBe("append") // stale pre-check is insufficient
			state.owner = phase === "prepare" ? "ambiguous" : "matching"
			expect(b1(state)).toBe("block")
		}
	})
	it("stale API writer after check changes the result boundary", () => {
		const state = initial()
		expect(b1(state)).toBe("append")
		state.result = "other"
		expect(b1(state)).toBe("block")
	})
	it("rename commit then exception: exact read-back converges, failed read-back remains blocked", () => {
		const state = initial()
		state.result = "ours" // simulated commit before error
		expect(b1(state)).toBe("already")
		state.apiReadable = false
		expect(b1(state)).toBe("block")
		state.apiReadable = true // simulated later restart read
		expect(b1(state)).toBe("already")
		expect(b2(state)).toBe("repair")
	})
	it("API committed, metadata not committed: restart repairs only, preserving earlier child", () => {
		const state = { ...initial(), result: "ours" as const }
		expect(b2(state)).toBe("repair")
		state.action = "cleared"
		state.status = "active"
		expect(b2(state)).toBe("already")
		expect(state.childIds).toEqual(["earlier"])
	})
	it("metadata partial commit or changed question/owner after pre-check never signals ready", () => {
		for (const change of [
			{ action: "cleared" as const },
			{ status: "active" as const },
			{ owner: "matching" as const },
			{ question: true },
			{ call: "later" as const },
			{ result: "other" as const },
			{ metadataReadable: false },
		]) {
			const state = { ...initial(), result: "ours" as const }
			expect(b2(state)).toBe("repair")
			expect(b2({ ...state, ...change })).toBe("block")
		}
	})
})
