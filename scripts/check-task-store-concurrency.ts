import type { HistoryItem } from "../packages/types/src/history"

import {
	abandonDelegatedChild,
	advanceOrdinaryPersistenceRevision,
	matchesOrdinaryPersistenceAuthority,
	matchesOrdinaryHistorySnapshot,
	ordinaryPersistenceIdentity,
	type OrdinaryAuthorityHistoryItem,
	type OrdinaryPersistenceIdentity,
	completeDelegatedChild,
	delegateTaskToChild,
	interruptDelegatedChild,
} from "../src/core/task-persistence/taskLifecycle"
import {
	computeHistoryDelta,
	DeltaRejectedError,
	mergeHistoryDelta,
} from "../src/core/task-persistence/taskStoreConcurrency"

const hosts = ["A", "B"] as const
type Host = (typeof hosts)[number]
type TaskId = "parent" | "child-a" | "child-b"
type OperationId =
	| "metadata-a"
	| "metadata-b"
	| "distinct-a"
	| "distinct-b"
	| "complete-a"
	| "redelegate-b"
	| "stale-save-a"
	| "abandon-b"
	| "reject-a"
type RecordMap = Partial<Record<TaskId, HistoryItem>>

interface PreparedWrite {
	taskId: TaskId
	incoming: HistoryItem
	delta: Partial<HistoryItem>
}

interface OperationState {
	phase: "idle" | "read" | "prepared" | "revalidated" | "done" | "rejected" | "failed"
	snapshot?: RecordMap
	writes?: PreparedWrite[]
	writeIndex: number
	candidate?: HistoryItem
}

interface CommitEntry {
	operationId: OperationId
	taskId: TaskId
	previous?: HistoryItem
	delta: Partial<HistoryItem>
	next: HistoryItem
}

interface ModelState {
	disk: RecordMap
	caches: Record<Host, RecordMap>
	hostMutexes: Partial<Record<Host, OperationId>>
	locks: Partial<Record<TaskId, OperationId>>
	operations: Partial<Record<OperationId, OperationState>>
	commits: CommitEntry[]
}

interface OperationSpec {
	id: OperationId
	host: Host
	externalSnapshot?: boolean
	allowRefreshAfterRead?: boolean
	publishCacheAtEnd?: boolean
	isEnabled?(snapshot: RecordMap): boolean
	buildWrites(snapshot: RecordMap): HistoryItem[]
}

interface Scenario {
	name: string
	operations: OperationSpec[]
	targetViolation?: { issue: "#1469" | "#1021"; message: string; expectedActions: string[] }
	check(state: ModelState): string[]
}

interface TraceStep {
	action: string
	state: ModelState
}

const MAX_DEPTH = 32
const MAX_STATES = 100_000
const commonInvariantNames = [
	"host mutex ownership",
	"file lock ownership",
	"disk field preservation",
	"childIds union",
	"pair write order",
	"whole-delta rejection",
] as const
const expectedPhases = ["read", "prepare", "revalidate", "commit", "refresh", "reject", "fail"] as const
const semanticLandmarks = {
	"stale-cache-newer-disk": (state: ModelState) =>
		state.commits.length > 0 &&
		hosts.some((host) =>
			(Object.keys(state.disk) as TaskId[]).some(
				(taskId) => canonical(state.caches[host][taskId]) !== canonical(state.disk[taskId]),
			),
		),
	"pair-first-commit-second-pending": (state: ModelState) =>
		(["complete-a", "abandon-b"] as OperationId[]).some((operationId) => {
			const operation = state.operations[operationId]
			return (
				operation?.writeIndex === 1 &&
				(operation.phase === "prepared" || operation.phase === "revalidated") &&
				state.commits.filter((entry) => entry.operationId === operationId).length === 1
			)
		}),
	"pair-first-commit-second-failed": (state: ModelState) =>
		state.operations["complete-a"]?.phase === "failed" &&
		state.commits.filter((entry) => entry.operationId === "complete-a").length === 1 &&
		state.caches.A["child-a"]?.status === "completed" &&
		state.caches.A.parent?.status === "delegated",
} satisfies Record<string, (state: ModelState) => boolean>

function item(id: TaskId, overrides: Partial<HistoryItem> = {}): HistoryItem {
	return {
		id,
		number: id === "parent" ? 0 : id === "child-a" ? 1 : 2,
		ts: id === "parent" ? 0 : id === "child-a" ? 1 : 2,
		task: id,
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		status: "active",
		childIds: [],
		...overrides,
	}
}

function baseRecords(): RecordMap {
	return {
		parent: item("parent", {
			status: "delegated",
			awaitingChildId: "child-a",
			delegatedToId: "child-a",
			childIds: ["child-a"],
		}),
		"child-a": item("child-a", { parentTaskId: "parent", rootTaskId: "parent" }),
	}
}

function clone<T>(value: T): T {
	return structuredClone(value)
}

function initialState(operationIds: OperationId[], disk = baseRecords()): ModelState {
	return {
		disk: clone(disk),
		caches: { A: clone(disk), B: clone(disk) },
		hostMutexes: {},
		locks: {},
		operations: Object.fromEntries(
			operationIds.map((id) => [id, { phase: "idle", writeIndex: 0 } satisfies OperationState]),
		),
		commits: [],
	}
}

function getRequired(records: RecordMap, taskId: TaskId): HistoryItem {
	const record = records[taskId]
	if (!record) throw new Error(`Model setup is missing ${taskId}`)
	return record
}

const operationSpecs: Record<OperationId, OperationSpec> = {
	"metadata-a": {
		id: "metadata-a",
		host: "A",
		buildWrites: (snapshot) => [{ ...getRequired(snapshot, "parent"), mode: "architect" }],
	},
	"metadata-b": {
		id: "metadata-b",
		host: "B",
		buildWrites: (snapshot) => [{ ...getRequired(snapshot, "parent"), totalCost: 42 }],
	},
	"distinct-a": {
		id: "distinct-a",
		host: "A",
		buildWrites: (snapshot) => [{ ...getRequired(snapshot, "parent"), mode: "architect" }],
	},
	"distinct-b": {
		id: "distinct-b",
		host: "B",
		buildWrites: (snapshot) => [{ ...getRequired(snapshot, "child-a"), totalCost: 42 }],
	},
	"complete-a": {
		id: "complete-a",
		host: "A",
		externalSnapshot: true,
		publishCacheAtEnd: true,
		isEnabled: (snapshot) => {
			const parent = snapshot.parent
			const child = snapshot["child-a"]
			return (
				(parent?.status === "delegated" || parent?.status === "active") &&
				parent.awaitingChildId === "child-a" &&
				(child?.status === "active" || child?.status === "interrupted")
			)
		},
		buildWrites: (snapshot) => {
			const completed = completeDelegatedChild(
				getRequired(snapshot, "parent"),
				getRequired(snapshot, "child-a"),
				"child-a result",
			)
			return [completed.child, completed.parent]
		},
	},
	"redelegate-b": {
		id: "redelegate-b",
		host: "B",
		isEnabled: (snapshot) =>
			snapshot.parent?.status === "delegated" &&
			snapshot.parent.awaitingChildId === "child-a" &&
			snapshot["child-a"]?.status === "active",
		buildWrites: (snapshot) => {
			const parent = getRequired(snapshot, "parent")
			const interrupted = interruptDelegatedChild(parent, getRequired(snapshot, "child-a"))
			const delegated = delegateTaskToChild(parent, "child-b", "interrupted")
			return [interrupted, item("child-b", { parentTaskId: "parent", rootTaskId: "parent" }), delegated]
		},
	},
	"stale-save-a": {
		id: "stale-save-a",
		host: "A",
		externalSnapshot: true,
		allowRefreshAfterRead: true,
		buildWrites: (snapshot) => {
			const stale = getRequired(snapshot, "child-a")
			return [{ ...stale, tokensOut: stale.tokensOut + 1 }]
		},
	},
	"abandon-b": {
		id: "abandon-b",
		host: "B",
		publishCacheAtEnd: true,
		isEnabled: (snapshot) =>
			snapshot.parent?.status === "delegated" &&
			snapshot.parent.awaitingChildId === "child-a" &&
			snapshot["child-a"]?.status === "active",
		buildWrites: (snapshot) => {
			const parent = getRequired(snapshot, "parent")
			const interrupted = interruptDelegatedChild(parent, getRequired(snapshot, "child-a"))
			const abandoned = abandonDelegatedChild(parent, interrupted)
			return [abandoned.child, abandoned.parent]
		},
	},
	"reject-a": {
		id: "reject-a",
		host: "A",
		buildWrites: (snapshot) => [
			{ ...getRequired(snapshot, "parent"), status: "interrupted", mode: "must-not-commit" },
		],
	},
}

function prepareWrites(state: ModelState, spec: OperationSpec, operation: OperationState): PreparedWrite[] {
	return spec.buildWrites(operation.snapshot!).map((built) => {
		const taskId = built.id as TaskId
		const cached = state.caches[spec.host][taskId]
		// Task.saveClineMessages rebuilds lineage from the live Task but preserves the
		// store's current status before upsert, so stale lineage is not accompanied by
		// a stale status transition.
		const incoming = spec.id === "stale-save-a" && cached?.status ? { ...built, status: cached.status } : built
		return {
			taskId,
			incoming,
			delta: cached ? { id: taskId, ...computeHistoryDelta(cached, incoming) } : { ...incoming },
		}
	})
}

function transition(state: ModelState, action: string, mutate: (next: ModelState) => void): TraceStep {
	const next = clone(state)
	mutate(next)
	return { action, state: next }
}

function nextSteps(state: ModelState, scenario: Scenario): TraceStep[] {
	const result: TraceStep[] = []
	for (const spec of scenario.operations) {
		const operation = state.operations[spec.id]!
		if (
			operation.phase === "idle" &&
			!state.hostMutexes[spec.host] &&
			(spec.isEnabled?.(state.caches[spec.host]) ?? true)
		) {
			result.push(
				transition(state, `${spec.id}.read`, (next) => {
					const target = next.operations[spec.id]!
					if (!spec.externalSnapshot) next.hostMutexes[spec.host] = spec.id
					target.phase = "read"
					target.snapshot = clone(next.caches[spec.host])
				}),
			)
		} else if (
			operation.phase === "read" &&
			(spec.externalSnapshot ? !state.hostMutexes[spec.host] : state.hostMutexes[spec.host] === spec.id)
		) {
			result.push(
				transition(state, `${spec.id}.prepare`, (next) => {
					const target = next.operations[spec.id]!
					if (spec.externalSnapshot) next.hostMutexes[spec.host] = spec.id
					target.writes = prepareWrites(next, spec, target)
					target.phase = "prepared"
				}),
			)
		} else if (operation.phase === "prepared") {
			const write = operation.writes![operation.writeIndex]!
			if (!state.locks[write.taskId]) {
				result.push(
					transition(state, `${spec.id}.revalidate(${write.taskId})`, (next) => {
						const target = next.operations[spec.id]!
						const targetWrite = target.writes![target.writeIndex]!
						next.locks[targetWrite.taskId] = spec.id
						try {
							target.candidate = mergeHistoryDelta(
								next.disk[targetWrite.taskId],
								targetWrite.incoming,
								targetWrite.delta,
							)
							target.phase = "revalidated"
						} catch (error) {
							if (!(error instanceof DeltaRejectedError)) throw error
							target.phase = "rejected"
							delete next.locks[targetWrite.taskId]
							delete next.hostMutexes[spec.host]
						}
					}),
				)
			}
		} else if (operation.phase === "revalidated") {
			const write = operation.writes![operation.writeIndex]!
			result.push(
				transition(state, `${spec.id}.commit(${write.taskId})`, (next) => {
					const target = next.operations[spec.id]!
					const targetWrite = target.writes![target.writeIndex]!
					if (next.locks[targetWrite.taskId] !== spec.id || !target.candidate) {
						throw new Error(`${spec.id} committed without owning ${targetWrite.taskId}`)
					}
					const previous = next.disk[targetWrite.taskId]
					next.disk[targetWrite.taskId] = target.candidate
					if (!spec.publishCacheAtEnd) next.caches[spec.host][targetWrite.taskId] = target.candidate
					next.commits.push({
						operationId: spec.id,
						taskId: targetWrite.taskId,
						previous,
						delta: targetWrite.delta,
						next: target.candidate,
					})
					delete next.locks[targetWrite.taskId]
					target.candidate = undefined
					target.writeIndex++
					target.phase = target.writeIndex === target.writes!.length ? "done" : "prepared"
					if (target.phase === "done") {
						if (spec.publishCacheAtEnd) {
							for (const commit of next.commits.filter((entry) => entry.operationId === spec.id)) {
								next.caches[spec.host][commit.taskId] = commit.next
							}
						}
						delete next.hostMutexes[spec.host]
					}
				}),
			)
			if (spec.publishCacheAtEnd && operation.writeIndex > 0) {
				result.push(
					transition(state, `${spec.id}.fail(${write.taskId})`, (next) => {
						const target = next.operations[spec.id]!
						const targetWrite = target.writes![target.writeIndex]!
						if (next.locks[targetWrite.taskId] !== spec.id) {
							throw new Error(`${spec.id} failed without owning ${targetWrite.taskId}`)
						}
						for (const commit of next.commits.filter((entry) => entry.operationId === spec.id)) {
							next.caches[spec.host][commit.taskId] = commit.next
						}
						target.candidate = undefined
						target.phase = "failed"
						delete next.locks[targetWrite.taskId]
						delete next.hostMutexes[spec.host]
					}),
				)
			}
		}
	}

	for (const host of hosts) {
		const hostHasPreparedWork =
			Boolean(state.hostMutexes[host]) ||
			scenario.operations.some((spec) => {
				const operation = state.operations[spec.id]!
				return (
					spec.host === host &&
					(["prepared", "revalidated"].includes(operation.phase) ||
						(operation.phase === "read" && !spec.allowRefreshAfterRead))
				)
			})
		if (!hostHasPreparedWork && canonical(state.caches[host]) !== canonical(state.disk)) {
			result.push(
				transition(state, `${host}.refresh`, (next) => {
					next.caches[host] = clone(next.disk)
				}),
			)
		}
	}
	return result
}

function commonViolations(state: ModelState, scenario: Scenario): string[] {
	const violations: string[] = []
	for (const [host, owner] of Object.entries(state.hostMutexes) as Array<[Host, OperationId]>) {
		const operation = state.operations[owner]
		if (!operation || !["read", "prepared", "revalidated"].includes(operation.phase)) {
			violations.push(`${owner} holds host ${host} mutex outside its write phase`)
		}
	}
	for (const [taskId, owner] of Object.entries(state.locks) as Array<[TaskId, OperationId]>) {
		const operation = state.operations[owner]
		if (operation?.phase !== "revalidated" || operation.writes?.[operation.writeIndex]?.taskId !== taskId) {
			violations.push(`${owner} holds ${taskId} without a revalidated write`)
		}
	}
	for (const commit of state.commits) {
		if (commit.previous) {
			for (const [key, value] of Object.entries(commit.previous)) {
				if (!(key in commit.delta) && !deepEqual(value, commit.next[key as keyof HistoryItem])) {
					violations.push(`${commit.operationId} lost disk field ${key} absent from its delta`)
				}
			}
			if (commit.delta.childIds && commit.previous.childIds) {
				const expected = new Set([...commit.previous.childIds, ...commit.delta.childIds])
				if ([...expected].some((id) => !commit.next.childIds?.includes(id))) {
					violations.push(`${commit.operationId} lost a concurrent childIds entry`)
				}
			}
		}
	}
	for (const spec of scenario.operations) {
		const operation = state.operations[spec.id]!
		const committed = state.commits.filter((entry) => entry.operationId === spec.id)
		const expectedOrder = operation.writes?.slice(0, committed.length).map((write) => write.taskId) ?? []
		if (committed.some((entry, index) => entry.taskId !== expectedOrder[index])) {
			violations.push(`${spec.id} committed pair records out of production order`)
		}
		if (operation.phase === "rejected" && committed.length > operation.writeIndex) {
			violations.push(`${spec.id} committed a rejected file delta`)
		}
	}
	return violations
}

function deepEqual(left: unknown, right: unknown): boolean {
	return canonical(left) === canonical(right)
}

function canonical(value: unknown): string {
	return JSON.stringify(value)
}

function phaseName(action: string): string {
	if (action.endsWith(".read")) return "read"
	if (action.endsWith(".prepare")) return "prepare"
	if (action.includes(".revalidate(")) return "revalidate"
	if (action.includes(".commit(")) return "commit"
	if (action.includes(".fail(")) return "fail"
	if (action.endsWith(".refresh")) return "refresh"
	return "reject"
}

function formatTrace(scenario: Scenario, message: string, trace: TraceStep[]): string {
	return [
		`Shared-store model violation in ${scenario.name}: ${message}`,
		`Bounds: depth=${MAX_DEPTH}, states=${MAX_STATES}`,
		...trace.map((step, index) => `${index}. ${step.action}\n${JSON.stringify(step.state, null, 2)}`),
	].join("\n")
}

function targetViolation(state: ModelState, scenario: Scenario): string | undefined {
	if (scenario.targetViolation?.issue === "#1469") {
		const completionDone = state.operations["complete-a"]?.phase === "done"
		const redelegationDone = state.operations["redelegate-b"]?.phase === "done"
		const redelegationParentCommit = state.commits.findIndex(
			(entry) => entry.operationId === "redelegate-b" && entry.taskId === "parent",
		)
		const completionParentCommit = state.commits.findIndex(
			(entry) => entry.operationId === "complete-a" && entry.taskId === "parent",
		)
		const parent = state.disk.parent
		const child = state.disk["child-b"]
		if (
			completionDone &&
			redelegationDone &&
			redelegationParentCommit >= 0 &&
			redelegationParentCommit < completionParentCommit &&
			child?.status === "active" &&
			child.parentTaskId === "parent"
		) {
			if (parent?.status !== "delegated" || parent.awaitingChildId !== "child-b") {
				return scenario.targetViolation.message
			}
		}
	}
	if (scenario.targetViolation?.issue === "#1021") {
		const abandonDone = state.operations["abandon-b"]?.phase === "done"
		const staleSaveDone = state.operations["stale-save-a"]?.phase === "done"
		const detachCommit = state.commits.findIndex(
			(entry) =>
				entry.operationId === "abandon-b" &&
				entry.taskId === "child-a" &&
				entry.next.parentTaskId === undefined &&
				entry.next.rootTaskId === undefined,
		)
		const reattachCommit = state.commits.findIndex(
			(entry) =>
				entry.operationId === "stale-save-a" &&
				entry.taskId === "child-a" &&
				entry.previous?.parentTaskId === undefined &&
				entry.next.parentTaskId === "parent",
		)
		if (abandonDone && staleSaveDone && detachCommit >= 0 && detachCommit < reattachCommit) {
			return scenario.targetViolation.message
		}
	}
	return undefined
}

function runScenario(scenario: Scenario): {
	states: number
	witness?: TraceStep[]
	phases: Set<string>
	landmarks: Set<string>
} {
	const startDisk =
		scenario.name === "status rejection"
			? { parent: item("parent", { status: "completed", mode: "stable" }) }
			: baseRecords()
	const start = initialState(
		scenario.operations.map((operation) => operation.id),
		startDisk,
	)
	const queue: Array<{ state: ModelState; trace: TraceStep[] }> = [
		{ state: start, trace: [{ action: "initial", state: start }] },
	]
	const visited = new Set([canonical(start)])
	const frontier: ModelState[] = []
	const phases = new Set<string>()
	const landmarks = new Set<string>()
	let witness: TraceStep[] | undefined

	for (let index = 0; index < queue.length; index++) {
		const node = queue[index]!
		for (const [name, predicate] of Object.entries(semanticLandmarks)) {
			if (predicate(node.state)) landmarks.add(name)
		}
		const violations = [...commonViolations(node.state, scenario), ...scenario.check(node.state)]
		if (violations.length) throw new Error(formatTrace(scenario, violations.join("; "), node.trace))
		const expectedViolation = targetViolation(node.state, scenario)
		if (expectedViolation && !witness) witness = node.trace
		if (node.trace.length - 1 === MAX_DEPTH) {
			frontier.push(node.state)
			continue
		}

		for (const step of nextSteps(node.state, scenario)) {
			phases.add(phaseName(step.action))
			if (step.state.operations["reject-a"]?.phase === "rejected") phases.add("reject")
			const key = canonical(step.state)
			if (visited.has(key)) continue
			visited.add(key)
			queue.push({ state: step.state, trace: [...node.trace, step] })
			if (visited.size > MAX_STATES) throw new Error(`${scenario.name} exceeded ${MAX_STATES} states`)
		}
	}

	if (scenario.targetViolation && !witness) {
		throw new Error(
			`${scenario.name} no longer reproduces ${scenario.targetViolation.issue}; promote it to an invariant`,
		)
	}
	const unseen = frontier
		.flatMap((state) => nextSteps(state, scenario))
		.find((step) => !visited.has(canonical(step.state)))
	if (unseen) throw new Error(`${scenario.name} truncated before unseen action ${unseen.action}`)
	return { states: visited.size, witness, phases, landmarks }
}

const scenarios: Scenario[] = [
	{
		name: "peer field merge",
		operations: [operationSpecs["metadata-a"], operationSpecs["metadata-b"]],
		check: (state) => {
			if (state.operations["metadata-a"]?.phase !== "done" || state.operations["metadata-b"]?.phase !== "done") {
				return []
			}
			return state.disk.parent?.mode === "architect" && state.disk.parent.totalCost === 42
				? []
				: ["concurrent writes to different fields lost an update"]
		},
	},
	{
		name: "status rejection",
		operations: [operationSpecs["reject-a"]],
		check: (state) => {
			if (state.operations["reject-a"]?.phase !== "rejected") return []
			return state.disk.parent?.status === "completed" && state.disk.parent.mode === "stable"
				? []
				: ["rejected status delta applied companion fields"]
		},
	},
	{
		name: "pair second-write failure",
		operations: [operationSpecs["complete-a"]],
		check: (state) => {
			if (state.operations["complete-a"]?.phase !== "failed") return []
			return state.disk["child-a"]?.status === "completed" &&
				state.disk.parent?.status === "delegated" &&
				state.caches.A["child-a"]?.status === "completed" &&
				state.caches.A.parent?.status === "delegated"
				? []
				: ["pair failure cache did not reflect the committed first-record prefix"]
		},
	},
	{
		name: "distinct task writes (#920)",
		operations: [operationSpecs["distinct-a"], operationSpecs["distinct-b"]],
		check: (state) => {
			if (state.operations["distinct-a"]?.phase !== "done" || state.operations["distinct-b"]?.phase !== "done") {
				return []
			}
			return state.disk.parent?.mode === "architect" && state.disk["child-a"]?.totalCost === 42
				? []
				: ["#920 distinct task writes lost an entry"]
		},
	},
	{
		name: "stale completion ownership",
		operations: [operationSpecs["complete-a"], operationSpecs["redelegate-b"]],
		targetViolation: {
			issue: "#1469",
			message: "stale child completion cleared a newer parent handoff",
			expectedActions: [
				"complete-a.read",
				"complete-a.prepare",
				"redelegate-b.read",
				"redelegate-b.prepare",
				"redelegate-b.revalidate(child-a)",
				"redelegate-b.commit(child-a)",
				"complete-a.revalidate(child-a)",
				"complete-a.commit(child-a)",
				"redelegate-b.revalidate(child-b)",
				"redelegate-b.commit(child-b)",
				"redelegate-b.revalidate(parent)",
				"redelegate-b.commit(parent)",
				"complete-a.revalidate(parent)",
				"complete-a.commit(parent)",
			],
		},
		check: () => [],
	},
	{
		name: "stale save detachment",
		operations: [operationSpecs["stale-save-a"], operationSpecs["abandon-b"]],
		targetViolation: {
			issue: "#1021",
			message: "stale live-task save reattached abandoned lineage",
			expectedActions: [
				"stale-save-a.read",
				"abandon-b.read",
				"abandon-b.prepare",
				"abandon-b.revalidate(child-a)",
				"abandon-b.commit(child-a)",
				"abandon-b.revalidate(parent)",
				"abandon-b.commit(parent)",
				"A.refresh",
				"stale-save-a.prepare",
				"stale-save-a.revalidate(child-a)",
				"stale-save-a.commit(child-a)",
			],
		},
		check: () => [],
	},
]

let totalStates = 0
const reachedPhases = new Set<string>()
const reachedLandmarks = new Set<string>()
for (const scenario of scenarios) {
	const result = runScenario(scenario)
	totalStates += result.states
	for (const phase of result.phases) reachedPhases.add(phase)
	for (const landmark of result.landmarks) reachedLandmarks.add(landmark)
	if (scenario.targetViolation) {
		const actions = result.witness!.slice(1).map((step) => step.action)
		if (canonical(actions) !== canonical(scenario.targetViolation.expectedActions)) {
			throw new Error(
				formatTrace(
					scenario,
					`${scenario.targetViolation.issue} shortest causal witness changed`,
					result.witness!,
				),
			)
		}
		console.log(
			`Known unsafe ${scenario.targetViolation.issue}: ${scenario.targetViolation.message}\n  ${result
				.witness!.slice(1)
				.map((step) => step.action)
				.join(" -> ")}`,
		)
	}
}

const missingPhases = expectedPhases.filter((phase) => !reachedPhases.has(phase))
if (missingPhases.length) throw new Error(`Shared-store model has unreachable phases: ${missingPhases.join(", ")}`)
const missingLandmarks = Object.keys(semanticLandmarks).filter((name) => !reachedLandmarks.has(name))
if (missingLandmarks.length) {
	throw new Error(`Shared-store model has unreachable semantic landmarks: ${missingLandmarks.join(", ")}`)
}

console.log(
	`Shared-store model check passed: ${totalStates} states, ${scenarios.length} scenarios, ${commonInvariantNames.length} invariants, ${expectedPhases.length}/${expectedPhases.length} phases reachable, ${Object.keys(semanticLandmarks).length}/${Object.keys(semanticLandmarks).length} landmarks reached`,
)

// ORDINARY-PERSISTENCE-1021-20261007: independent current-protocol refinement.
// The historical explorer above intentionally retains both old-protocol witnesses.
type OrdinarySaveId = "save" | "peer"
type OrdinaryOwner = OrdinarySaveId | "abandon"
type OrdinaryRecords = Partial<Record<TaskId, OrdinaryAuthorityHistoryItem>>
interface OrdinarySaveState {
	phase: "idle" | "read" | "acquired" | "checked" | "prepared" | "revalidated" | "done" | "rejected" | "failed"
	snapshot?: OrdinaryAuthorityHistoryItem
	authority?: OrdinaryPersistenceIdentity
	incoming?: OrdinaryAuthorityHistoryItem
	delta?: Partial<OrdinaryAuthorityHistoryItem>
	candidate?: OrdinaryAuthorityHistoryItem
	generation?: number
	refreshedBeforeAcquire?: boolean
	refused: boolean
	lateAttempt: boolean
	postRefreshAttempt?: boolean
	reason?: "fence" | "authority" | "snapshot" | "delta" | "contention"
	/** Attempt number of the current try (unset = 1). A contention refusal ends one attempt. */
	attempt?: number
	/** The attempt refused by one bounded fence-wait timeout: unpublished and not sticky. */
	contendedAttempt?: number
}
interface OrdinaryProtocolState {
	disk: OrdinaryRecords
	caches: Record<Host, OrdinaryRecords>
	saves: Record<OrdinarySaveId, OrdinarySaveState>
	exclusions: Partial<Record<TaskId, OrdinaryOwner>>
	generations: Partial<Record<TaskId, number>>
	mutexes: Partial<Record<Host, OrdinaryOwner>>
	fileLocks: Partial<Record<TaskId, OrdinaryOwner>>
	abandon: {
		phase: "idle" | "acquired" | "read" | "prepared" | "revalidated" | "done" | "failed"
		index: number
		snapshot?: OrdinaryRecords
		writes?: OrdinaryAuthorityHistoryItem[]
		candidate?: OrdinaryAuthorityHistoryItem
	}
	commits: Array<{
		owner: OrdinaryOwner
		taskId: TaskId
		previous: OrdinaryAuthorityHistoryItem
		next: OrdinaryAuthorityHistoryItem
		delta: Partial<OrdinaryAuthorityHistoryItem>
		authority?: OrdinaryPersistenceIdentity
		incoming: OrdinaryAuthorityHistoryItem
		parentExcludedBy?: OrdinaryOwner
		attempt?: number
	}>
}
interface OrdinaryScenario {
	name: string
	kind: "child-instance" | "parent-instance" | "explicit-snapshot" | "fresh-instance"
	revision: "legacy" | "versioned"
}
const ordinaryInvariantNames = [
	"immutable captured authority",
	"current authority and explicit snapshot at publication",
	"monotonic detached lineage",
	"both abandonment revisions advance in file order",
	"sticky typed refusal and non-sticky contention without publication",
	"exclusion before mutex/file ownership",
	"delta preservation and failure prefix",
] as const
const ordinaryPhases = [
	"read",
	"acquire",
	"check",
	"prepare",
	"revalidate",
	"commit",
	"refresh",
	"reject",
	"fail",
	"sticky-reject",
	"post-refresh-reject",
]
const ordinaryLandmarkNames = [
	"old-snapshot-survives-cache-refresh",
	"old-child-refused-after-fresh-lease",
	"old-parent-refused-by-revision-alone",
	"explicit-snapshot-refused-at-publication",
	"sticky-refusal-blocks-late-attempt",
	"child-prefix-survives-parent-failure",
	"fresh-rehydrated-child-progress",
	"unrelated-progress-while-parent-excluded",
	"matching-old-instance-progress-before-abandonment",
	"save-failure-preserves-metadata",
	"contention-refusal-then-later-save-succeeds",
] as const

function ordinaryTarget(scenario: OrdinaryScenario, save: OrdinarySaveId): TaskId {
	return save === "peer" ? "child-b" : scenario.kind === "parent-instance" ? "parent" : "child-a"
}
function ordinaryHost(save: OrdinarySaveId): Host {
	return save === "save" ? "A" : "B"
}
function ordinaryScope(state: OrdinaryProtocolState, save: OrdinarySaveId): TaskId[] {
	const identity = state.saves[save].authority!
	const current = state.disk[identity.id as TaskId]!
	return [
		...new Set(
			[identity.id, identity.parentTaskId, identity.rootTaskId, current.parentTaskId, current.rootTaskId].filter(
				(id): id is TaskId => !!id,
			),
		),
	].sort()
}
function releaseOrdinaryOwner(state: OrdinaryProtocolState, owner: OrdinaryOwner): void {
	for (const key of Object.keys(state.exclusions) as TaskId[])
		if (state.exclusions[key] === owner) delete state.exclusions[key]
	for (const key of Object.keys(state.fileLocks) as TaskId[])
		if (state.fileLocks[key] === owner) delete state.fileLocks[key]
	for (const host of hosts) if (state.mutexes[host] === owner) delete state.mutexes[host]
}
function ordinaryNext(
	state: OrdinaryProtocolState,
	scenario: OrdinaryScenario,
): Array<{ action: string; state: OrdinaryProtocolState }> {
	const steps: Array<{ action: string; state: OrdinaryProtocolState }> = []
	const step = (action: string, mutate: (next: OrdinaryProtocolState) => void) => {
		const next = clone(state)
		mutate(next)
		steps.push({ action, state: next })
	}
	for (const save of ["save", "peer"] as const) {
		const operation = state.saves[save],
			taskId = ordinaryTarget(scenario, save),
			host = ordinaryHost(save)
		const instanceBoundary = save === "peer" || scenario.kind !== "explicit-snapshot"
		if (
			operation.phase === "idle" &&
			(save !== "save" ||
				scenario.kind !== "fresh-instance" ||
				(state.abandon.index > 0 && ["done", "failed"].includes(state.abandon.phase)))
		) {
			step(`${save}.read`, (next) => {
				const record =
					save === "save" && scenario.kind === "fresh-instance"
						? next.disk[taskId]!
						: next.caches[host][taskId]!
				next.saves[save] = {
					...next.saves[save],
					phase: "read",
					snapshot: clone(record),
					authority: ordinaryPersistenceIdentity(record),
				}
			})
		} else if (operation.phase === "read") {
			const scope = ordinaryScope(state, save)
			if (scope.every((id) => !state.exclusions[id]))
				step(`${save}.acquire`, (next) => {
					for (const id of scope) {
						next.exclusions[id] = save
						next.generations[id] = (next.generations[id] ?? 0) + 1
					}
					next.saves[save].refreshedBeforeAcquire = deepEqual(next.caches[host][taskId], next.disk[taskId])
					next.saves[save].generation = next.generations[taskId]
					next.saves[save].phase = "acquired"
				})
			// Contention: the bounded wait expires while another owner holds part of the scope.
			// The attempt publishes nothing and the instance stays unrefused; the same captured
			// authority may try again later. One timeout per save bounds the graph; no retry
			// loop, age theft or longer wait is modeled.
			if (
				operation.contendedAttempt === undefined &&
				scope.some((id) => state.exclusions[id] && state.exclusions[id] !== save)
			)
				step(`${save}.reject(contention)`, (next) => {
					const target = next.saves[save]
					target.contendedAttempt = target.attempt ?? 1
					target.attempt = target.contendedAttempt + 1
					target.reason = "contention"
				})
			// Bounded environment refusal stays sticky: a typed filesystem/bootstrap failure, or an
			// unrecoverable lock (no usable owner for the whole wait, e.g. a legacy holderless owner).
			step(`${save}.reject(fence)`, (next) => {
				next.saves[save].phase = "rejected"
				next.saves[save].reason = "fence"
				next.saves[save].refused = instanceBoundary
			})
		} else if (operation.phase === "acquired") {
			const allowed =
				!instanceBoundary || matchesOrdinaryPersistenceAuthority(operation.authority!, state.disk[taskId]!)
			step(`${save}.${allowed ? "check" : "reject(authority)"}`, (next) => {
				if (allowed) next.saves[save].phase = "checked"
				else {
					next.saves[save].phase = "rejected"
					next.saves[save].reason = "authority"
					next.saves[save].refused = true
					releaseOrdinaryOwner(next, save)
				}
			})
		} else if (operation.phase === "checked" && !state.mutexes[host]) {
			step(`${save}.prepare`, (next) => {
				const target = next.saves[save],
					cached = next.caches[host][taskId]!
				next.mutexes[host] = save
				target.incoming = {
					...target.snapshot!,
					status: cached.status,
					tokensOut: target.snapshot!.tokensOut + 1,
					ordinaryPersistenceRevision: target.authority!.revision,
				}
				target.delta = { id: taskId, ...computeHistoryDelta(cached, target.incoming) }
				target.phase = "prepared"
			})
		} else if (operation.phase === "prepared" && !state.fileLocks[taskId]) {
			const allowed = matchesOrdinaryHistorySnapshot(operation.incoming!, state.disk[taskId]!)
			step(`${save}.${allowed ? "revalidate" : "reject(snapshot)"}`, (next) => {
				const target = next.saves[save]
				if (!allowed) {
					target.phase = "rejected"
					target.reason = "snapshot"
					target.refused = instanceBoundary
					releaseOrdinaryOwner(next, save)
					return
				}
				try {
					target.candidate = mergeHistoryDelta(next.disk[taskId], target.incoming!, target.delta!)
					next.fileLocks[taskId] = save
					target.phase = "revalidated"
				} catch (error) {
					if (!(error instanceof DeltaRejectedError)) throw error
					target.phase = "rejected"
					target.reason = "delta"
					releaseOrdinaryOwner(next, save)
				}
			})
		} else if (operation.phase === "revalidated") {
			step(`${save}.commit`, (next) => {
				const target = next.saves[save]
				next.commits.push({
					owner: save,
					taskId,
					previous: next.disk[taskId]!,
					next: target.candidate!,
					delta: target.delta!,
					authority: target.authority,
					incoming: target.incoming!,
					parentExcludedBy: next.exclusions.parent,
					attempt: target.attempt ?? 1,
				})
				next.disk[taskId] = target.candidate!
				next.caches[host][taskId] = target.candidate!
				target.candidate = undefined
				target.phase = "done"
				releaseOrdinaryOwner(next, save)
			})
			step(`${save}.fail`, (next) => {
				next.saves[save].candidate = undefined
				next.saves[save].phase = "failed"
				releaseOrdinaryOwner(next, save)
			})
		}
		if (operation.refused && !operation.lateAttempt)
			step(`${save}.sticky-reject`, (next) => {
				next.saves[save].lateAttempt = true
			})
		if (
			operation.refused &&
			!operation.postRefreshAttempt &&
			["done", "failed"].includes(state.abandon.phase) &&
			!matchesOrdinaryPersistenceAuthority(operation.authority!, state.disk[taskId]!) &&
			deepEqual(state.caches[host][taskId], state.disk[taskId])
		) {
			step(`${save}.post-refresh-reject`, (next) => {
				next.saves[save].postRefreshAttempt = true
			})
		}
	}
	const abandon = state.abandon
	if (abandon.phase === "idle" && !state.exclusions.parent && !state.exclusions["child-a"])
		step("abandon.acquire", (next) => {
			for (const id of ["parent", "child-a"] as const) {
				next.exclusions[id] = "abandon"
				next.generations[id] = (next.generations[id] ?? 0) + 1
			}
			next.abandon.phase = "acquired"
		})
	else if (abandon.phase === "acquired" && !state.mutexes.B)
		step("abandon.read", (next) => {
			next.mutexes.B = "abandon"
			next.abandon.snapshot = clone(next.disk)
			next.abandon.phase = "read"
		})
	else if (abandon.phase === "read")
		step("abandon.prepare", (next) => {
			const result = abandonDelegatedChild(next.abandon.snapshot!.parent!, next.abandon.snapshot!["child-a"]!)
			// UUID equality abstraction: one distinct token for each actual file publication, not a transaction revision.
			next.abandon.writes = [
				advanceOrdinaryPersistenceRevision(result.child, "child-next"),
				advanceOrdinaryPersistenceRevision(result.parent, "parent-next"),
			]
			next.abandon.phase = "prepared"
		})
	else if (abandon.phase === "prepared") {
		const id = abandon.writes![abandon.index]!.id as TaskId
		if (!state.fileLocks[id])
			step(`abandon.revalidate(${id})`, (next) => {
				const incoming = next.abandon.writes![next.abandon.index]!
				const delta = { id, ...computeHistoryDelta(next.abandon.snapshot![id]!, incoming) }
				next.abandon.candidate = mergeHistoryDelta(next.disk[id], incoming, delta)
				next.fileLocks[id] = "abandon"
				next.abandon.phase = "revalidated"
			})
	} else if (abandon.phase === "revalidated") {
		const id = abandon.writes![abandon.index]!.id as TaskId
		step(`abandon.commit(${id})`, (next) => {
			const target = next.abandon,
				incoming = target.writes![target.index]!
			next.commits.push({
				owner: "abandon",
				taskId: id,
				previous: next.disk[id]!,
				next: target.candidate!,
				incoming,
				delta: { id, ...computeHistoryDelta(target.snapshot![id]!, incoming) },
			})
			next.disk[id] = target.candidate!
			delete next.fileLocks[id]
			target.candidate = undefined
			target.index++
			target.phase = target.index === 2 ? "done" : "prepared"
			if (target.phase === "done") {
				for (const commit of next.commits.filter((entry) => entry.owner === "abandon"))
					next.caches.B[commit.taskId] = commit.next
				releaseOrdinaryOwner(next, "abandon")
			}
		})
		if (abandon.index === 1)
			step(`abandon.fail(${id})`, (next) => {
				for (const commit of next.commits.filter((entry) => entry.owner === "abandon"))
					next.caches.B[commit.taskId] = commit.next
				next.abandon.candidate = undefined
				next.abandon.phase = "failed"
				releaseOrdinaryOwner(next, "abandon")
			})
	}
	for (const host of hosts)
		if (!state.mutexes[host] && canonical(state.caches[host]) !== canonical(state.disk))
			step(`${host}.refresh`, (next) => {
				next.caches[host] = clone(next.disk)
			})
	return steps
}

function ordinaryViolations(state: OrdinaryProtocolState, scenario: OrdinaryScenario): string[] {
	const errors: string[] = []
	for (const save of ["save", "peer"] as const) {
		const operation = state.saves[save],
			id = ordinaryTarget(scenario, save)
		if (operation.authority && !deepEqual(operation.authority, ordinaryPersistenceIdentity(operation.snapshot!)))
			errors.push("captured authority changed")
		if (
			operation.refused &&
			(operation.phase !== "rejected" || state.commits.some((commit) => commit.owner === save))
		)
			errors.push("refused instance published metadata")
		// Evaluated on outcomes in every phase: a sticky refusal must carry a non-contention reason,
		// and no commit may belong to the attempt that contention refused.
		if (operation.refused && operation.reason === "contention") errors.push("contention refusal became sticky")
		if (
			operation.contendedAttempt !== undefined &&
			state.commits.some(
				(commit) => commit.owner === save && (commit.attempt ?? 1) === operation.contendedAttempt,
			)
		)
			errors.push("contended attempt published metadata")
		if (["acquired", "checked", "prepared", "revalidated"].includes(operation.phase)) {
			if (ordinaryScope(state, save).some((key) => state.exclusions[key] !== save))
				errors.push("save lost ancestry exclusion")
		}
		if (operation.phase === "revalidated" && state.fileLocks[id] !== save) errors.push("save lost file lock")
	}
	for (const [host, owner] of Object.entries(state.mutexes) as Array<[Host, OrdinaryOwner]>) {
		if (
			owner === "abandon"
				? !["read", "prepared", "revalidated"].includes(state.abandon.phase)
				: !["prepared", "revalidated"].includes(state.saves[owner].phase) || ordinaryHost(owner) !== host
		)
			errors.push("mutex outside write phase")
	}
	for (const [id, owner] of Object.entries(state.fileLocks) as Array<[TaskId, OrdinaryOwner]>) {
		if (state.exclusions[id] !== owner || state.mutexes[owner === "abandon" ? "B" : ordinaryHost(owner)] !== owner)
			errors.push("file lock without exclusion and mutex")
	}
	if (
		["acquired", "read", "prepared", "revalidated"].includes(state.abandon.phase) &&
		(state.exclusions.parent !== "abandon" || state.exclusions["child-a"] !== "abandon")
	)
		errors.push("abandonment lost pair exclusion")
	const abandonmentCommits = state.commits.filter((commit) => commit.owner === "abandon")
	if (
		abandonmentCommits.some(
			(commit, index) =>
				commit.taskId !== (["child-a", "parent"] as const)[index] ||
				commit.next.ordinaryPersistenceRevision === commit.previous.ordinaryPersistenceRevision ||
				commit.next.ordinaryPersistenceRevision !== (index === 0 ? "child-next" : "parent-next"),
		)
	)
		errors.push("abandonment revision/file order changed")
	for (const commit of state.commits) {
		if (
			commit.owner !== "abandon" &&
			(!matchesOrdinaryPersistenceAuthority(commit.authority!, commit.previous) ||
				!matchesOrdinaryHistorySnapshot(commit.incoming, commit.previous))
		)
			errors.push("old snapshot published after authority changed")
		if (
			commit.taskId === "child-a" &&
			!commit.previous.parentTaskId &&
			(commit.next.parentTaskId || commit.next.rootTaskId)
		)
			errors.push("abandoned lineage restored")
		for (const [key, value] of Object.entries(commit.previous))
			if (!(key in commit.delta) && !deepEqual(value, commit.next[key as keyof OrdinaryAuthorityHistoryItem]))
				errors.push(`disk field lost: ${key}`)
	}
	if (
		state.abandon.phase === "failed" &&
		(abandonmentCommits.length !== 1 ||
			state.disk["child-a"]!.parentTaskId ||
			state.disk.parent!.awaitingChildId !== "child-a" ||
			state.caches.B["child-a"]!.ordinaryPersistenceRevision !== "child-next")
	)
		errors.push("failed pair lost committed child prefix")
	return errors
}

function ordinaryLandmarks(state: OrdinaryProtocolState, scenario: OrdinaryScenario): string[] {
	const reached: string[] = [],
		save = state.saves.save,
		id = ordinaryTarget(scenario, "save")
	const stale = !!save.authority && !matchesOrdinaryPersistenceAuthority(save.authority, state.disk[id]!)
	if (stale && save.phase === "read" && deepEqual(state.caches.A[id], state.disk[id]))
		reached.push("old-snapshot-survives-cache-refresh")
	if (save.reason === "authority" && id === "child-a" && save.refreshedBeforeAcquire && (save.generation ?? 0) > 1)
		reached.push("old-child-refused-after-fresh-lease")
	if (
		save.reason === "authority" &&
		id === "parent" &&
		save.refreshedBeforeAcquire &&
		save.authority!.parentTaskId === state.disk.parent!.parentTaskId &&
		save.authority!.rootTaskId === state.disk.parent!.rootTaskId
	)
		reached.push("old-parent-refused-by-revision-alone")
	if (save.reason === "snapshot" && scenario.kind === "explicit-snapshot")
		reached.push("explicit-snapshot-refused-at-publication")
	if (save.refused && save.postRefreshAttempt && stale) reached.push("sticky-refusal-blocks-late-attempt")
	if (state.abandon.phase === "failed") reached.push("child-prefix-survives-parent-failure")
	if (scenario.kind === "fresh-instance" && save.phase === "done") reached.push("fresh-rehydrated-child-progress")
	if (state.commits.some((commit) => commit.owner === "peer" && commit.parentExcludedBy === "abandon"))
		reached.push("unrelated-progress-while-parent-excluded")
	if (scenario.kind !== "fresh-instance" && save.phase === "done" && state.abandon.phase === "done")
		reached.push("matching-old-instance-progress-before-abandonment")
	if (save.phase === "failed" && !state.commits.some((commit) => commit.owner === "save"))
		reached.push("save-failure-preserves-metadata")
	if (
		save.contendedAttempt !== undefined &&
		save.phase === "done" &&
		!save.refused &&
		state.commits.filter((commit) => commit.owner === "save").length === 1
	)
		reached.push("contention-refusal-then-later-save-succeeds")
	return reached
}

function formatOrdinaryTrace(
	scenario: OrdinaryScenario,
	message: string,
	actions: string[],
	start: OrdinaryProtocolState,
): string {
	let state = start
	const details = actions.map((action, index) => {
		if (index > 0) {
			const next = ordinaryNext(state, scenario).find((step) => step.action === action)
			if (!next) throw new Error(`Current ordinary trace cannot replay ${action}`)
			state = next.state
		}
		return `${index}. ${action}\n${JSON.stringify(state, null, 2)}`
	})
	return [
		`Current ordinary model ${scenario.name}: ${message}`,
		`Bounds: depth=${MAX_DEPTH}, states=${MAX_STATES}`,
		...details,
	].join("\n")
}

function runOrdinaryScenario(scenario: OrdinaryScenario) {
	const disk: OrdinaryRecords = {
		...baseRecords(),
		"child-b": item("child-b"),
		"child-a": item("child-a", { status: "interrupted", parentTaskId: "parent", rootTaskId: "parent" }),
	}
	if (scenario.revision === "versioned")
		for (const id of Object.keys(disk) as TaskId[])
			disk[id] = advanceOrdinaryPersistenceRevision(disk[id]!, `${id}-initial`)
	const start: OrdinaryProtocolState = {
		disk,
		caches: { A: clone(disk), B: clone(disk) },
		saves: {
			save: { phase: "idle", refused: false, lateAttempt: false },
			peer: { phase: "idle", refused: false, lateAttempt: false },
		},
		exclusions: {},
		generations: {},
		mutexes: {},
		fileLocks: {},
		abandon: { phase: "idle", index: 0 },
		commits: [],
	}
	const queue = [{ state: start, trace: ["initial"] }],
		visited = new Set([canonical(start)])
	const phases = new Set<string>(),
		landmarks = new Map<string, string[]>(),
		actions = new Set<string>(),
		frontier: OrdinaryProtocolState[] = []
	for (let index = 0; index < queue.length; index++) {
		const node = queue[index]!,
			violations = ordinaryViolations(node.state, scenario)
		if (violations.length) throw new Error(formatOrdinaryTrace(scenario, violations.join("; "), node.trace, start))
		for (const landmark of ordinaryLandmarks(node.state, scenario))
			if (!landmarks.has(landmark)) landmarks.set(landmark, node.trace.slice(1))
		if (node.trace.length - 1 === MAX_DEPTH) {
			frontier.push(node.state)
			continue
		}
		for (const step of ordinaryNext(node.state, scenario)) {
			actions.add(step.action)
			phases.add(step.action.endsWith(".refresh") ? "refresh" : step.action.split(".")[1]!.split("(")[0]!)
			const key = canonical(step.state)
			if (visited.has(key)) continue
			visited.add(key)
			queue.push({ state: step.state, trace: [...node.trace, step.action] })
			if (visited.size > MAX_STATES)
				throw new Error(`Current ordinary scenario ${scenario.name} exceeded ${MAX_STATES} states`)
		}
	}
	if (frontier.some((state) => ordinaryNext(state, scenario).some((step) => !visited.has(canonical(step.state)))))
		throw new Error(`Current ordinary scenario ${scenario.name} truncated at depth ${MAX_DEPTH}`)
	const required = [
		"save.read",
		"save.acquire",
		"save.reject(fence)",
		"save.check",
		"save.prepare",
		"save.revalidate",
		"save.commit",
		"save.fail",
		"peer.read",
		"peer.acquire",
		"peer.reject(fence)",
		"peer.check",
		"peer.prepare",
		"peer.revalidate",
		"peer.commit",
		"peer.fail",
		"peer.sticky-reject",
		"abandon.acquire",
		"abandon.read",
		"abandon.prepare",
		"abandon.revalidate(child-a)",
		"abandon.commit(child-a)",
		"abandon.revalidate(parent)",
		"abandon.commit(parent)",
		"abandon.fail(parent)",
		"A.refresh",
		"B.refresh",
	]
	if (scenario.kind !== "explicit-snapshot") required.push("save.sticky-reject")
	// A fresh instance reads only after abandonment releases its scope, so it never contends.
	if (scenario.kind !== "fresh-instance") required.push("save.reject(contention)")
	if (scenario.kind === "explicit-snapshot") required.push("save.reject(snapshot)")
	if (scenario.kind === "child-instance" || scenario.kind === "parent-instance")
		required.push("save.reject(authority)", "save.post-refresh-reject")
	const missing = required.filter((action) => !actions.has(action))
	if (missing.length) throw new Error(`${scenario.name} has unreachable actions: ${missing.join(", ")}`)
	return { states: visited.size, phases, landmarks, actions: actions.size }
}

let ordinaryStates = 0
const ordinaryReachedPhases = new Set<string>(),
	ordinaryReachedLandmarks = new Map<string, string[]>()
let ordinaryScenarioCount = 0
for (const revision of ["legacy", "versioned"] as const)
	for (const kind of ["child-instance", "parent-instance", "explicit-snapshot", "fresh-instance"] as const) {
		const scenario = { name: `${kind}/${revision}`, kind, revision },
			result = runOrdinaryScenario(scenario)
		ordinaryScenarioCount++
		ordinaryStates += result.states
		for (const phase of result.phases) ordinaryReachedPhases.add(phase)
		for (const [landmark, trace] of result.landmarks)
			if (!ordinaryReachedLandmarks.has(landmark)) ordinaryReachedLandmarks.set(landmark, trace)
		console.log(`Current ordinary scenario ${scenario.name}: ${result.states} states, ${result.actions} actions`)
	}
const ordinaryMissing = [
	...ordinaryPhases.filter((phase) => !ordinaryReachedPhases.has(phase)),
	...ordinaryLandmarkNames.filter((landmark) => !ordinaryReachedLandmarks.has(landmark)),
]
if (ordinaryMissing.length) throw new Error(`Current ordinary coverage missing: ${ordinaryMissing.join(", ")}`)
for (const [name, trace] of ordinaryReachedLandmarks)
	console.log(`Current ordinary landmark ${name}: ${trace.join(" -> ")}`)
console.log(
	`Current ordinary authority model check passed: ${ordinaryStates} states, ${ordinaryScenarioCount} scenarios, ${ordinaryInvariantNames.length} invariants, ${ordinaryPhases.length}/${ordinaryPhases.length} phases, ${ordinaryLandmarkNames.length}/${ordinaryLandmarkNames.length} landmarks; bounds depth=${MAX_DEPTH}, states=${MAX_STATES} per scenario`,
)
