# P3 — independent approved-interface review

**Date:** 2026-10-04 UTC. **Overall verdict: DISAGREE with production interface agreement. P3 exit remains BLOCKED.**

This report records the preceding independent read-only review of the approved P1 interface, P3 report and current P3 scaffold. P1 is approved for bounded development, but implementation-owner agreement and phase exits remain pending ([approval record](../architecture/interrupted-create-handoff-recovery-p1-contract.md:53)). The verdicts below assess current P3 conformance, not whether the P1 design is approved.

The review made no implementation edits and ran no tests. Existing test results were treated as reported evidence, not freshly verified acceptance. No live state inspection/repair, extension-host reload, child launch, model request or Odoo execution occurred. Creating this report is a subsequent documentation-only action authorized by the user.

## Verdict summary

| Item                           | Verdict      | Boundary                                                                                          |
| ------------------------------ | ------------ | ------------------------------------------------------------------------------------------------- |
| Binding handshake              | **DISAGREE** | Host issuance and explicit fenced-mutation contract absent.                                       |
| Canonical digest               | **AGREE**    | Shared preimage and host/webview hashing match P1; storage reconstruction not certified.          |
| Attachment acceptance boundary | **DISAGREE** | Canonical base64 checks do not prove image validity or exact original-attachment resolution.      |
| Protected journal/blob adapter | **DISAGREE** | Storage port and disposable fixture are not a production adapter.                                 |
| Receipt and replay contract    | **DISAGREE** | Initial receipt primitives exist; later-state replay and client persistence are missing.          |
| Queue adoption                 | **DISAGREE** | Snapshot primitive agrees, but production acceptance-before-claim and mutation guards are absent. |
| Pending-question priority      | **DISAGREE** | Exclusion primitive agrees; ownership and asynchronous integration are unproven.                  |

## 1. Binding handshake — DISAGREE

P1 requires host-issued, durably recorded action-incarnation generation verified under the parent fence, distinct from lease generation ([binding issuance](../architecture/interrupted-create-handoff-recovery-p1-contract.md:10), [separate epochs](../architecture/interrupted-create-handoff-recovery-p1-contract.md:24)).

The [webview preparation helper](../../webview-ui/src/utils/recoverySubmission.ts:21) accepts a caller-provided binding. The [host port](../../src/core/task-persistence/recoveryIntake.ts:13) exposes neither issuance nor an explicit ownership token passed to conditional writes. Positive-integer validation does not establish authoritative issuance.

**Precise alternative:** introduce a host binding request/response before new intake. Persist and read back the immutable action fingerprint, lineage and incarnation generation; repeated requests return the same binding only while that evidence matches. Pass separate lease generation and owner token into atomic conditional storage mutations. Never use lock reacquisition to change submission identity.

## 2. Canonical digest — AGREE

The [shared serializer](../../src/shared/recoveryIntake.ts:44) uses P1's exact fixed field order, including ordered lineage/images, origin and timestamp. [Host hashing](../../src/core/task-persistence/recoveryIntake.ts:33) and [webview hashing](../../webview-ui/src/utils/recoverySubmission.ts:33) produce lowercase hexadecimal SHA-256 over that serialization, matching the [canonical interface](../architecture/interrupted-create-handoff-recovery-p1-contract.md:16).

**Prescribed boundary:** retain this as an identity digest, not merely a decoded-payload hash. Preserve the preimage across lease changes and journal progression. Serialization changes require versioning and migration/rejection. This agreement does not certify attachment resolution or durable reconstruction.

## 3. Attachment acceptance boundary — DISAGREE

[Validation](../../src/core/task-persistence/recoveryIntake.ts:57) checks allowed MIME labels, canonical base64 and size limits, but not actual image/MIME validity or whether every original attachment survived resolution. The [fixture's alleged PNG](../../src/core/task-persistence/__tests__/recoveryIntake.spec.ts:27) represents arbitrary bytes, illustrating that limitation.

The ordinary resolver [skips failures](../../src/core/mentions/resolveImageMentions.ts:125) and [deduplicates/truncates](../../src/core/mentions/resolveImageMentions.ts:143), contrary to [P1's exact attachment boundary](../architecture/interrupted-create-handoff-recovery-p1-contract.md:16).

**Precise alternative:** use a recovery-specific all-or-nothing resolver that validates each original attachment's bytes and MIME, preserves order and multiplicity, and rejects the entire submission on omission, unsupported content or truncation. Freeze resolved bytes before hashing. On read-back, reconstruct canonical strings from verified ordered blobs and recompute the identity digest.

## 4. Protected journal/blob adapter — DISAGREE

The [storage port](../../src/core/task-persistence/recoveryIntake.ts:12) is an abstraction, **not a production adapter**. The [test fixture](../../src/core/task-persistence/__tests__/recoveryIntake.spec.ts:38) stores inline JSON and substitutes a callback for fencing. The [accepted-record shape](../../src/shared/recoveryIntake.ts:26) lacks the durable progress revision, protected blob references and ownership fields required by [P1](../architecture/interrupted-create-handoff-recovery-p1-contract.md:15).

**Precise alternative:** implement a separately versioned durable journal with immutable acceptance projection, monotone progress revision, and protected text/image blobs carrying MIME, byte length and byte digest. Enforce permissions, path/symlink safety, sync/atomic publication, retention and authoritative read-back. Conditional writes must atomically validate current fence ownership and binding. Unsupported storage must block intake. Do not reinterpret the current inline fixture as this adapter.

## 5. Receipt and replay contract — DISAGREE

The initial receipt ordering and [matching-draft clearing](../../webview-ui/src/utils/recoverySubmission.ts:45) are sound primitives. However, [intake classifies before reading acceptance](../../src/core/task-persistence/recoveryIntake.ts:97), and [matching requires the initial accepted state](../../src/core/task-persistence/recoveryIntake.ts:70). A lost receipt after metadata repair cannot follow P1's required replay path. Client persistence and transport remain [unimplemented](interrupted-create-handoff-recovery-p3.md:32).

**Precise alternative:** distinguish exact receipt replay from new intake. Under the fence, consult and validate the retained immutable acceptance projection before new-intake classification, including stage-specific ownership evidence where required. Return the original receipt at later states without accepting a new owner, appending history or scheduling work. Persist the pending client snapshot before posting and reuse its ID/payload after reload; never rerun preparation for a retry. See [P1 replay requirements](../architecture/interrupted-create-handoff-recovery-p1-contract.md:11).

## 6. Queue adoption — DISAGREE with production conformance

[Adoption](../../src/core/task-persistence/recoveryIntake.ts:125) correctly snapshots the original ID, timestamp and payload without claiming/removing the item; the [test](../../src/core/task-persistence/__tests__/recoveryIntake.spec.ts:170) demonstrates this limited behavior. It does not enforce acceptance-before-claim integration or prevent accepted-item edits/cancellation. The existing [edit path remains mutable](../../src/core/message-queue/MessageQueueService.ts:68).

**Precise alternative:** coordinate host binding, versioned queue snapshot and durable acceptance before recovery claim. Reject stale edit/cancel versions and freeze accepted items. Rehydrate by original identity/order without duplicating existing entries. Intake acceptance must not remove the queue item; removal requires the later durable local-delivery gate ([P1](../architecture/interrupted-create-handoff-recovery-p1-contract.md:18)).

## 7. Pending-question priority — DISAGREE with end-to-end confirmation

The [intake exclusion](../../src/core/task-persistence/recoveryIntake.ts:98) and [classification test](../../src/core/task-persistence/__tests__/recoveryIntake.spec.ts:137) agree with the policy. But a Boolean exclusion does not prove exact question-ID/answer ownership or priority through asynchronous binding, attachment resolution, queue adoption and acceptance. Existing [queued question routing](../../src/core/task/Task.ts:1156) carries that ownership; P3 has not integrated with it.

**Precise alternative:** preserve the exact task/question-ID and explicit-answer route. Recheck authoritative question ownership at the acceptance mutation boundary; a newly pending question prevents new recovery intake. A receipt replay acknowledges only the earlier accepted submission and must never answer or consume a new question. Add isolated direct/queued early/late-arrival and question-race integration tests.

## Report reconciliation and disposition

The [P3 report's unapproved-P1 statement](interrupted-create-handoff-recovery-p3.md:7) is now stale. Its [production blockers](interrupted-create-handoff-recovery-p3.md:66) remain accurate. The correct distinction is: **P1 design approval is satisfied; implementation-owner agreement and production evidence are not.** The original P3 report was not edited during this review or report creation.

P3 exit remains **BLOCKED**. Agreement with the digest and useful scaffold primitives does not establish a protected production adapter, crash-safe intake, later-state receipt replay or queue/question integration. P4 acceptance still requires completed P2 and P3 gates. Live repair requires separate explicit approval and fresh authoritative eligibility.

## Review checks and scope

- Read the approved P1 contract, P3 report, current shared/host/webview helpers, relevant scaffold tests, and bounded queue/question/image-resolution/P2-fence source slices.
- Read-only worktree checks used `git status --short` at review start/end; no tracked changes were shown. Existing untracked architecture, implementation and P2/P3 files were preserved.
- Tests, lint, type checks, model checks, build/bundle and runtime operations: **[N/A]** for the independent read-only review. Historical passing tests were not represented as fresh verification.
- The subsequent documentation action creates only this new report and runs its formatting and whitespace checks; it does not revise any interface, source or existing report.
