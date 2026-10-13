# P2 — approved P1 interface review against current report and scaffold

**Date:** 2026-10-04 UTC. **Scope:** read-only interface review, followed by separately requested documentation materialization. **Decision:** AGREE with the approved P1 target interface for all five items; DISAGREE that the current P2 scaffold supplies a conforming production boundary. These are implementation gaps, not rejection of the approved design. **P2 exit and production adapter conformance remain BLOCKED.**

No source or existing reports were changed. No tests, live-state access, extension-host reload, child launch, external model request or Odoo execution occurred. Creating this report does not authorize any implementation or live repair. Existing scaffolds are not proof of cross-host safety.

## Evidence and decision semantics

The review read the [approved P1 contract](../architecture/interrupted-create-handoff-recovery-p1-contract.md:3), [P2 report](interrupted-create-handoff-recovery-p2.md:1), [P2 fence](../../src/core/task-persistence/parentHandoffFence.ts:1), [P2 evaluator](../../src/core/task-persistence/interruptedCreateHandoffEligibility.ts:1), [P3 host port](../../src/core/task-persistence/recoveryIntake.ts:13) and [shared binding/receipt contract](../../src/shared/recoveryIntake.ts:1), plus bounded existing metadata/API/storage reader slices. Worktree inspection was read-only; no tracked-file differences were reported at that snapshot. Existing untracked P1/P2/P3 work was preserved.

**Target interface** decisions state agreement with the approved responsibilities and semantics. **Current delivery** decisions state whether the inspected scaffold actually provides that interface. Agreement on the target is not phase acceptance, implementation proof, or acceptance on behalf of the separate P3 owner.

| Item                                                     | Approved target interface | Current P2 delivery                                                              |
| -------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------- |
| Host issuance of immutable action binding                | **AGREE**                 | **DISAGREE** — no durable binding issuer.                                        |
| Outer-fence ownership in conditional journal/blob writes | **AGREE**                 | **DISAGREE** — no atomic ownership-checked writer capability.                    |
| Outer-before-inner lock order                            | **AGREE**                 | **DISAGREE** — no enforced coordinating wrapper.                                 |
| Fresh authoritative readers                              | **AGREE**                 | **DISAGREE** — evaluator consumes supplied assertions.                           |
| Exact P2-to-P3 boundary, including receipt replay        | **AGREE**                 | **DISAGREE** — candidate ports/projections do not deliver the complete boundary. |

## 1. Who issues the action binding

**Approved interface: AGREE. Current P2 delivery: DISAGREE.**

The **host/P2 coordinator** issues and durably records the immutable action incarnation under the outer parent fence, after fresh authoritative action and lineage validation. Repeated requests retain the same incarnation only while the action fingerprint and lineage match. The webview supplies submission identity, not binding authority. See [P1 binding issuance](../architecture/interrupted-create-handoff-recovery-p1-contract.md:10).

The scaffold has no binding issuer: its [lease](../../src/core/task-persistence/parentHandoffFence.ts:27) carries acquisition ownership only, and its [eligibility input](../../src/core/task-persistence/interruptedCreateHandoffEligibility.ts:19) contains no action incarnation or ordered lineage snapshot. P3's [binding shape](../../src/shared/recoveryIntake.ts:4) represents the required identity, but a shape does not establish its origin.

**Specific alternative:** P2 supplies a host binding handshake backed by the per-parent journal. It validates the current persisted action/lineage, durably allocates or retrieves the immutable incarnation, and reads it back before returning the binding. A reused action ID with a new incarnation cannot adopt an earlier acceptance. Queued submissions retain their original ID, timestamp and payload until binding succeeds, without being claimed or discarded.

## 2. Outer-fence ownership supplied to conditional journal/blob writes

**Approved interface: AGREE. Current P2 delivery: DISAGREE.**

P1 separates immutable action incarnation from acquisition ownership. Every conditional P3 write receives the [parent/action/fence generation and owner-token context](../architecture/interrupted-create-handoff-recovery-p1-contract.md:24). Ownership and immutable binding must be checked **atomically with the mutation**, under the appropriate inner lock. Reacquisition changes ownership/revision, not submission identity, digest or receipt.

The [current lease](../../src/core/task-persistence/parentHandoffFence.ts:27) exposes a generic acquisition generation and [owner read-back](../../src/core/task-persistence/parentHandoffFence.ts:113), but no conditional writer. P3's [storage port](../../src/core/task-persistence/recoveryIntake.ts:13) neither passes ownership into the callback nor requires it as an argument to writes. The P2 report acknowledges this gap at [atomic enforcement limits](interrupted-create-handoff-recovery-p2.md:42).

**Specific alternative:** P2 provides a scoped fenced-storage capability carrying both epochs and the owner token, and exposes only ownership-and-binding-checked journal/blob mutations. Each mutation validates current persisted ownership and expected journal revision, preserves the immutable acceptance projection, and performs authoritative read-back. The adapter must demonstrate that ownership cannot change between validation and commit; a separate lease assertion followed by an ordinary write is insufficient. If that property or writer participation cannot be guaranteed, the adapter returns a blocker and performs no acceptance mutation.

## 3. Lock order

**Approved interface: AGREE. Current P2 enforcement: DISAGREE.**

The order is **outer per-parent fence first**, then **one inner lock at a time**: journal/payload -> API -> journal -> authoritative task metadata -> journal. Never acquire the outer fence while holding an inner lock. P3 uses only the intake-related journal/blob stages; it must not perform later API or metadata stages. See [P1 lock order](../architecture/interrupted-create-handoff-recovery-p1-contract.md:22).

The current [fence acquisition](../../src/core/task-persistence/parentHandoffFence.ts:65) does not enforce nesting or coordinate file locks. The [P2 report](interrupted-create-handoff-recovery-p2.md:42) correctly states that no transaction wrapper exists.

**Specific alternative:** Route all participating operations through a P2 outer-fence coordinator. Its scoped storage capability serializes the permitted inner stages, prohibits nested inner locks and rejects acquisition from an already inner-locked context. Delegation, child preparation/commit/start, parent reopen, startup intent replay and recovery ownership writers must participate before integration is accepted.

## 4. Authoritative readers

**Approved interface: AGREE. Current P2 readers: DISAGREE.**

P1 requires fresh, stage-specific persisted evidence: parent/root and full lineage, exact action incarnation, question/child/owner state, effective API boundary, all child registries/metadata/intents, transient attribution, and journal/blob correlation. Missing or corrupt evidence blocks progression. See [P1 eligibility](../architecture/interrupted-create-handoff-recovery-p1-contract.md:25).

The [P2 evaluator](../../src/core/task-persistence/interruptedCreateHandoffEligibility.ts:95) is pure and consumes caller-supplied completeness/correlation assertions; it is not an evidence collector. The [P2 report explicitly confirms this](interrupted-create-handoff-recovery-p2.md:44).

Existing helpers are not a complete substitute:

- [`TaskHistoryStore.readAuthoritative()`](../../src/core/task-persistence/TaskHistoryStore.ts:178) supplies one fresh metadata record, not the whole predicate or cross-host transaction.
- [`readApiMessages()`](../../src/core/task-persistence/apiMessages.ts:94) can return empty history for missing files and migrate/delete legacy history.
- [`TaskHistoryStore.initialize()`](../../src/core/task-persistence/TaskHistoryStore.ts:118) performs reconciliation and intent replay, so it is not a read-only diagnostic collector.
- [`getTaskDirectoryPath()`](../../src/utils/storage.ts:53) creates directories and uses a storage resolver with fallback behavior; it is not a strict side-effect-free recovery evidence path resolver.

**Specific alternative:** P2 implements strict, validated, side-effect-free readers against one resolved authoritative storage scope. They distinguish missing/invalid/I/O failure, inspect the full lineage and registry/intent inventory, and reconstruct journal/blob identity from disk. Initial eligibility and later receipt replay use different stage predicates. Unknown peer participation remains a blocker. Provider-effective history must be proven with P4 before API commit acceptance; until then dependent cases fail closed.

## 5. Exact boundary handed to P3

**Approved interface: AGREE. Current P2-to-P3 handoff: DISAGREE.**

The agreed boundary consists of:

1. A host-issued, immutable [action binding](../architecture/interrupted-create-handoff-recovery-p1-contract.md:10).
2. The ownership-checked conditional storage capability described in [separate epochs](../architecture/interrupted-create-handoff-recovery-p1-contract.md:24).
3. Fresh new-intake classification and a **distinct receipt-replay path**.
4. Protected immutable blobs and a versioned journal retaining the canonical acceptance projection, with exact read-back before receipt.

P3 owns stable submission identity, immutable input snapshots, exact attachment resolution, queue adoption and matching-receipt UI acknowledgment. The [canonical identity serialization](../../src/shared/recoveryIntake.ts:44) aligns with [P1's canonical interface](../architecture/interrupted-create-handoff-recovery-p1-contract.md:16), but its current [accepted-record shape](../../src/shared/recoveryIntake.ts:26) is a projection, not the durable blob/journal schema.

The current [intake path](../../src/core/task-persistence/recoveryIntake.ts:97) classifies before reading an existing acceptance, and [record matching](../../src/core/task-persistence/recoveryIntake.ts:70) accepts only the initial accepted state. That cannot replay a lost receipt after action clear, as [P1 expressly requires](../architecture/interrupted-create-handoff-recovery-p1-contract.md:11).

**Specific alternative:** P2 hands P3 the binding handshake plus the scoped storage/replay capability, not a raw lease and Boolean eligibility result. Exact replay first validates the retained immutable acceptance and stage-specific ownership, then returns the original receipt without new intake, API append, action repair or scheduling. New intake separately applies the interrupted-parent predicate, conditionally persists protected blobs/journal and reads them back before receipt. P3 never clears the action, removes a queue item as a delivery acknowledgment, launches a child or starts the model loop.

## Predecessor-status correction

**DISAGREE with the report's current P1-blocked wording.** The [P2 report](interrupted-create-handoff-recovery-p2.md:8) records the earlier review state; P1 now records [independent design PASS and architecture approval](../architecture/interrupted-create-handoff-recovery-p1-contract.md:53).

**Specific alternative:** Treat the earlier statement as historical. The P1 design-review gate is satisfied; P2/P3 owner agreement and their implementation exits remain separate gates. This review agrees the target responsibilities, but does not establish acceptance by the separate P3 owner or delivery of a conforming adapter. The existing P2 report was not edited.

## Verification and conclusion

Review verification consisted of bounded source/document reads and the read-only command `git -C projects/Zoo-Code status --short && git -C projects/Zoo-Code diff --name-only`. No tests, types, lint, model checks, build or runtime checks were executed for this review; historical scaffold results are not promoted to fresh passes.

The separately authorized documentation write creates only [this report](interrupted-create-handoff-recovery-p2-interface-review.md:1), refuses overwrite, and checks formatting and untracked whitespace. These documentation checks are not protocol or cross-host verification.

**Conclusion:** Approved design responsibilities are agreed. Production adapter conformance and P2 exit remain **BLOCKED**. Existing scaffolds establish neither cross-host commit safety nor live recovery eligibility. Live repair continues to require separate explicit approval and fresh authoritative evidence.
