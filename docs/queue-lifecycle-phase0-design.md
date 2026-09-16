# Queue lifecycle Phase 0 — Gate 0 design proposal

**Status:** PROPOSED — no runtime implementation or public-wire change is authorized before Gate 0 approval.

## Scope and authority

This proposal turns the queue bridge into a transport/projection adapter over one workspace-scoped execution coordinator. It does **not** authorize changing the existing v1 IPC schemas, launcher, task provider, scheduler, terminal registry, backlog, journal, or production state.

The authoritative execution ledger owns queue admission, request deduplication, cancellation, instance lineage, stop proof, result acceptance and release. Task history and UI are replayable projections. A visible task, an abort notification, an empty task registry, or a history status never grants execution authority or proves release.

## Immutable identity and fencing

Each record has:

- `workspaceId`, `queueId`, private `ownerCredential`, `generation`, and `requestId`;
- immutable `inputFingerprint` (canonical mode/text/todos plus approved stable input fields);
- `executionId`, `executionEpoch`, `fencingEpoch`, `rootTaskId?`, and current `taskInstanceId?`;
- monotonic `recordVersion`, event `sequence`, and per-parent `transition` counters.

All asynchronous effects carry `{ executionId, executionEpoch, fencingEpoch, instanceId?, transition? }`. The coordinator revalidates that tuple after every await and before every durable mutation, schedule activation, child allocation, resume, result acceptance, process operation, and release. Credentials are never emitted in public events, status, history, logs, or stop receipts.

## Pure reducer and legal transitions

The coordinator calls a pure reducer with an expected record version, then commits the resulting durable intent before doing slow work. Effects return observations which are reduced only if their fencing tuple is current.

| Event                | Preconditions                                       | Durable transition                                  | Effect / rejection                              |
| -------------------- | --------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------- |
| `reserve`            | no same request; valid bounded input                | `reserved`, request mapping and input fingerprint   | allocate credential-bound reservation           |
| `admit`              | owned current reservation; not cancelled            | `starting`, admission intent                        | create root paused                              |
| `rootAllocated`      | matching admission intent                           | root lineage and instance identity                  | persist history projection intent               |
| `delegateReserved`   | running parent/current tuple                        | pending ordered edge; parent transition +1          | flush then request parent stop                  |
| `childAllocated`     | matching edge; not cancelled                        | child instance identity, edge still pending         | persist parent/child lineage projection         |
| `childRegistered`    | durable edge and lineage projection committed       | edge active, parent delegating                      | schedule child activation                       |
| `cancelAccepted`     | current request/owned target                        | cancellation tombstone; epoch increment; `stopping` | stop owned instances/processes/effects          |
| `resultObserved`     | root only; current epoch; not cancelled             | completion pending, exact bounded result            | independently validate result and prompt target |
| `completionAccepted` | matching root pending prompt/result                 | acceptance receipt                                  | finalization only after stop proof              |
| `stopObserved`       | matching owned handle and process identity          | append stop receipt / blockers                      | no release until all critical handles settle    |
| `settleTerminal`     | matching outcome and all owned work settled         | completed/aborted/failed                            | write terminal projection intent                |
| `release`            | terminal + complete stop proof + no pending effects | idempotent release receipt                          | relinquish lease after commit                   |
| `reconcile`          | restart/uncertainty                                 | `unreconciled` if proof missing/invalid             | read-only status or explicit operator workflow  |

Cancellation linearizes when `cancelAccepted` commits. If it commits before `settleTerminal`, every later completion, child, resume, finalizer and scheduler callback is fenced out. A repeated cancellation joins the same stop operation. Cancellation after a settled terminal outcome returns the existing receipt and cannot rewrite history.

Reducer invariants:

1. A request maps to at most one execution and one immutable input fingerprint.
2. An active instance/process/pending activation requires a current owned record and non-released lease.
3. A child may activate only after its exact active lineage edge was committed.
4. `released` requires a terminal outcome and valid stop receipts for every safety-critical owned handle.
5. Only an accepted root completion may be `completed`; descendant output, a task event, or an abort label cannot imply completion or backlog success.
6. Any malformed, version-unknown, oversized, corrupt, or ownership-ambiguous record is `unreconciled`, not empty or idle.

## Durable versioned record

`QueueExecutionStore` stores a bounded versioned envelope using atomic replacement, file fsync and parent-directory fsync where the platform supports them. A failed or unverified commit blocks admission/mutation; it never replaces state with an empty ledger.

```ts
interface QueueExecutionLedgerV1 {
	schemaVersion: 1
	workspaceId: string
	fencingEpoch: number
	lock: { ownerInstanceId: string; leaseNonce: string; acquiredAt: number }
	records: Record<string, QueueExecutionRecordV1>
	replayWatermarks: Record<string, ReplayWatermark>
}

interface QueueExecutionRecordV1 {
	executionId: string
	queueId: string
	generation: number
	requestId: string
	inputFingerprint: string
	ownerCredentialRef: string
	executionEpoch: number
	recordVersion: number
	sequence: number
	stage:
		| "reserved"
		| "starting"
		| "running"
		| "delegating"
		| "resuming"
		| "completion_pending"
		| "stopping"
		| "completed"
		| "aborted"
		| "failed"
		| "unreconciled"
	root?: InstanceRef
	instances: Record<string, InstanceRef>
	edges: Record<string, TransitionEdge>
	cancellation?: CancellationTombstone
	result?: PendingResult
	processHandles: Record<string, OwnedProcess>
	stopReceipts: Record<string, StopReceipt>
	release?: ReleaseReceipt
	pendingEffects: PendingEffect[]
	boundedFailure?: BoundedFailure
}
```

`ownerCredentialRef` references protected local secret storage; the raw credential is not serialized in public data. Record count, string sizes, edge count (maximum 256), final result (maximum 8 KiB), IPC frame (maximum 2 MiB), receipt list, retained event list and diagnostic text are all bounded. Compaction retains request/replay tombstones and release receipts long enough to reject delayed calls; unresolved records are never compacted.

## Cross-process ownership mechanism

Admission requires both a host-wide in-memory gate and a workspace-specific durable lock. The lock is created with exclusive create semantics in the ledger directory and stores `{ workspaceId, ownerInstanceId, leaseNonce, fencingEpoch, processIdentity, artifactFingerprint }`. The owner commits a strictly increasing fencing epoch before it creates a root or performs any lifecycle mutation.

A second process never steals based on elapsed time. It may only enter reconciliation after a separate local operator authorization, verified old-owner liveness/identity evidence, and a new durable fencing epoch. Every coordinator callback/effect includes the recorded epoch; lower epochs fail closed even if a stale process resumes. Failure to verify lock atomicity, file/directory durability, process identity, or lock provenance is an `unreconciled` blocker.

## Queue protocol revision 2 proposal

Negotiation precedes lease acquisition, task creation, prompt acceptance, cancellation, or history mutation. Revision 2 adds gated capabilities:

- `durable-dispatch-v2`
- `request-cancel-v2`
- `stop-receipts-v2`
- `lifecycle-status-v2`

The negotiation response exposes only public fields: revision, supported capabilities, workspace/build identity, and bounded status. It never exposes owner credentials, lease nonces, process identifiers beyond approved redaction, or raw internal errors.

New v2 commands carry `requestId`, `generation`, public execution identity, expected fencing epoch where applicable, and a correlation ID. Cancellation returns `pending`, `already_terminal`, `not_found`, or a stable stop/release receipt—not a fabricated terminal outcome. Completion acceptance targets an exact owned root pending completion only; it cannot accept permission prompts.

## Compatibility matrix

| Client                    | Server                                    | Before mutation behavior                        | Outcome                                            |
| ------------------------- | ----------------------------------------- | ----------------------------------------------- | -------------------------------------------------- |
| v1                        | v1                                        | existing explicitly scoped v1 behavior          | supported legacy only                              |
| v2-capable                | v2 with all required capabilities         | negotiate, validate revision/capabilities       | permitted after durable reservation implementation |
| v2-capable                | v1                                        | v2 client detects missing revision/capabilities | reject before lease/task creation                  |
| v1                        | v2 deployment requiring durable semantics | server sees no required v2 negotiation          | reject before lease/task creation                  |
| v2 partial capability set | v2                                        | missing any required operation capability       | reject before mutation                             |
| newer unresolved ledger   | older runtime                             | schema/fencing cannot be proven                 | read-only `unreconciled`; no downgrade/reset       |

There is no silent v1 fallback for durable dispatch, cancellation, stop proof, restart reconciliation, or lifecycle status. v1 remains disabled for v2-required deployments until an architecture-approved adapter demonstrates every invariant.

## Stop-receipt definition

A stop receipt is durable evidence that one **identified owned handle** is no longer able to produce work for this execution. It is not an abort event, a UI removal, a registry lookup, a PID-only kill request, or a cleanup promise initiation.

```ts
interface StopReceipt {
	receiptId: string
	executionId: string
	executionEpoch: number
	fencingEpoch: number
	ownerHandleId: string
	handleKind: "task-instance" | "api-stream" | "terminal-process" | "spawn" | "resume" | "finalizer"
	observedAt: number
	outcome: "stopped" | "not_started" | "already_settled" | "failed"
	proof: { instanceId?: string; processBirthIdentity?: string; exitCode?: number }
	boundedFailure?: BoundedFailure
}
```

A `stopped` terminal receipt requires matching execution/fencing identity and a verified handle-level terminal observation: task-loop settlement for a task instance, abort-controller settlement for a stream, or exit observation tied to a launch-captured process birth identity for a process. An inability to identify a detached process yields `failed`/`unreconciled`, never `stopped`. Release requires terminal receipts for all safety-critical handles plus no pending allocation, admission, resume or finalizer intents.

## Phase 0 evidence and Gate 0 decision

The current source has a partial in-memory bridge fix: it suppresses the abort terminal projection for `delegation_disposal` and schedules a child after history lineage registration. It remains non-durable and cannot prove cleanup, cross-process exclusivity, cancellation fencing, result acceptance ordering, or safe release. The composed regression and source-derived fixture are evidence only; they do not approve this proposal.

**NEEDS_PARENT — Gate 0:** approve or amend this reducer, schema, ownership/fencing mechanism, v2 compatibility decision, and stop-receipt definition before any public contract implementation or Phase 1 work.
