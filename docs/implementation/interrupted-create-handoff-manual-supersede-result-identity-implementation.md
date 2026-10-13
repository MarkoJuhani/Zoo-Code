# Unwired B1 result-identity classifier — implementation report

Date: 2026-10-05 UTC. Scope: isolated first ticket only.

## Disposition and authority

**PASS for the isolated, non-writing first ticket only; B1/B2 production effects remain BLOCKED and deferred.** The classifier and its in-memory fixtures are implemented, focused tests pass, and the existing worktree was preserved. This is not integrated B implementation PASS, owner acceptance, a readiness signal, deployment approval or live-repair authorization. The operator's validation intent is not either named owner's ACCEPT.

The implementation followed the [closure contract's first ticket](interrupted-create-handoff-manual-supersede-b-closure-contract.md:37), with the [active plan](../../../../.roo/interrupted-create-handoff-manual-supersede-proposal.md:3), [R1](interrupted-create-handoff-manual-supersede-r1-decision.md:3), [R2a](interrupted-create-handoff-manual-supersede-r2a-decision.md:3) and [B design](interrupted-create-handoff-manual-supersede-b1-b2-design.md:13) read before implementation. Historical statements about unrecorded decisions in those documents were not interpreted as current signatures or as production authority. The contract's recorded design decisions do not bypass its remaining integration and promotion gates.

This report is a separately requested documentation follow-up. The original implementation authorized only the two source/test additions below; it did not authorize this report or modification of existing documentation. The later operator request authorizes this new project-owned report only. No existing contract, plan, policy or scaffold is edited.

## Changed paths and preservation

Original implementation additions:

- [projects/Zoo-Code/src/core/task-persistence/manualSupersedeResultIdentity.ts](../../src/core/task-persistence/manualSupersedeResultIdentity.ts:1)
- [projects/Zoo-Code/src/core/task-persistence/**tests**/manualSupersedeResultIdentity.spec.ts](../../src/core/task-persistence/__tests__/manualSupersedeResultIdentity.spec.ts:1)

Documentation follow-up addition:

- [projects/Zoo-Code/docs/implementation/interrupted-create-handoff-manual-supersede-result-identity-implementation.md](interrupted-create-handoff-manual-supersede-result-identity-implementation.md:1)

The original baseline had 32 pre-existing untracked paths, with empty tracked and staged diffs. The implementation's final state had the same 32 paths plus exactly the two authorized additions. SHA-256 and path-inventory comparison confirmed **all 2,912 pre-existing project files unchanged**. A bounded source-reference check found no pre-existing source importing or referencing the classifier. The [read-only preflight](../../src/core/task-persistence/manualSupersedePreflight.ts:153) was not changed or weakened. Nothing was staged.

At report entry, 34 paths were untracked and tracked/staged diffs were still empty. A fresh preservation baseline covers 2,914 existing project files, including both implementation additions. The documentation follow-up must preserve them all and add only this report.

## Implemented behavior

The [classifier](../../src/core/task-persistence/manualSupersedeResultIdentity.ts:185) accepts only a strict synthetic envelope: requested/canonical storage-root strings, target parent/root/full old action, root/parent metadata, ordered lineage, original approval display-mode evidence, explicitly supplied raw and effective history read states, and an optional proposed identity comparison. These are fixture inputs, not discoveries or trusted eligibility assertions.

- [Canonical serialization](../../src/core/task-persistence/manualSupersedeResultIdentity.ts:108) recursively sorts object keys lexicographically, preserves array order and JSON escaping, and refuses undefined/non-JSON values, non-finite numbers, negative zero, accessors, symbols, non-plain objects, sparse/extended arrays and cycles. Refusal caps are 64 levels, 100,000 values and 2 MiB serialized UTF-8; no truncation is used to obtain a pass.
- [Version and fixed truth](../../src/core/task-persistence/manualSupersedeResultIdentity.ts:4) follow the persisted v1 proposal. [Tuple construction](../../src/core/task-persistence/manualSupersedeResultIdentity.ts:476) binds version, canonical-root string, parent ID, full saved action, terminal call ID/name/input, raw assistant-message/block indices and fixed truthful UNKNOWN-history text. SHA-256 is over the canonical tuple's UTF-8 bytes.
- The proposed result is exactly one user-role error result block with the old action ID and exact versioned marker/digest plus fixed truth text, as required by the [contract](interrupted-create-handoff-manual-supersede-b-closure-contract.md:27). It is a review candidate, not an append operation or authorization token.
- [Action derivation](../../src/core/task-persistence/manualSupersedeResultIdentity.ts:162) retains ordered todo IDs/content/status, the one-level message unescape and exact approval-string derivation using supplied original display-mode evidence. It conservatively rejects checklist junk rather than silently ignoring it.
- The [history scanner](../../src/core/task-persistence/manualSupersedeResultIdentity.ts:307) checks supported shapes, roles, order, call uniqueness, terminal position, unresolved siblings, orphan/duplicate results and later turns. Missing/corrupt/unreadable histories do not become empty histories. Summary/truncation evidence blocks comparison.
- The entire supported raw history must equal the supplied effective projection, not merely the terminal call or digest. Filtering, reordering, remapping, changed metadata, tool-result-to-text conversion and unknown shapes fail closed. This is intentionally conservative and does not implement the later proposed provider-envelope clarification.

The [typed observation](../../src/core/task-persistence/manualSupersedeResultIdentity.ts:71) distinguishes no result, exactly one matching proposed result, and conflict/unknown. A clean synthetic comparison still has UNKNOWN disposition, never write eligibility. Every outcome explicitly denies write authorization and retains UNKNOWN historical child outcome, unverified provider-effective history, host/writer exclusion, canonical storage root, owner inventory and approval-mode provenance. A blocked observation exposes no constructed identity. Caller completeness/approval flags cannot close those gaps.

## Current-source evidence rechecked

The review rechecked [NewTaskTool's saved action and approval derivation](../../src/core/tools/NewTaskTool.ts:87), [checklist ID derivation](../../src/core/tools/UpdateTodoListTool.ts:183), [ID sanitization](../../src/utils/tool-id.ts:13), [preflight limits](../../src/core/task-persistence/manualSupersedePreflight.ts:153), [strict-reader limits](../../src/core/task-persistence/interruptedCreateHandoffDisk.ts:17), [ordinary API migration/save](../../src/core/task-persistence/apiMessages.ts:94), [effective-summary filtering](../../src/core/condense/index.ts:546), [ordinary tool-result-to-text conversion](../../src/core/task/apiConversationHistory.ts:111), [result validation](../../src/core/task/validateToolResultIds.ts:87), [rename commit point](../../src/utils/safeWriteJson.ts:140) and [ordinary lifecycle transition restrictions](../../src/core/task-persistence/taskLifecycle.ts:6). These are source observations, not proof of loaded host behavior, guard participation or provider wire output. No production dependencies from these paths were added to the classifier.

## Isolated fixtures and test evidence

The suite uses only in-memory synthetic fixtures. It exercises pinned digest/tuple construction, key-order determinism, preserved todo order, immutable-input/no-mutation behavior, root/parent/raw-index binding, escaping and approval derivation, absent/empty/malformed histories, canonical-root aliases, changed full action, owner/question metadata, missing/duplicate/hidden/nonterminal calls, wrong roles/order, unresolved siblings, orphan/duplicate/later results, wrong version/hash/content/error flag, malformed or changed projection and unsupported/non-JSON inputs.

Specific evidence:

- [Pinned v1 identity fixture](../../src/core/task-persistence/__tests__/manualSupersedeResultIdentity.spec.ts:117).
- [Matching proposed result remains UNKNOWN](../../src/core/task-persistence/__tests__/manualSupersedeResultIdentity.spec.ts:150).
- [Summary-hidden call rejection](../../src/core/task-persistence/__tests__/manualSupersedeResultIdentity.spec.ts:738).
- [Tool-result-to-text conversion rejection](../../src/core/task-persistence/__tests__/manualSupersedeResultIdentity.spec.ts:752).
- [Model-only commit-then-error/read-back witness](../../src/core/task-persistence/__tests__/manualSupersedeResultIdentity.spec.ts:817): explicitly not filesystem fault injection, rename behavior, a real B writer, authoritative reread or writer-participation proof.

The first focused run exited 1 with **103 passed / 8 failed**. A shared-reference fixture mistake caused saved-action mutations to also modify the expected action. The fixture was corrected to independently clone expected action and effective projection; rejection assertions were not weakened. The final exact focused run exited 0 with **111/111 tests passed**. This initial failure is retained in the record, not silently omitted.

## Exact implementation verification commands and exits

All commands below were run from the workspace root exactly as listed in the [first ticket](interrupted-create-handoff-manual-supersede-b-closure-contract.md:43). Exit annotations describe each command, not merely the surrounding shell's final exit.

| Command                                                                                                                                                                                                                                                              | Observed outcome                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [git -C projects/Zoo-Code status --short --untracked-files=all](interrupted-create-handoff-manual-supersede-b-closure-contract.md:43)                                                                                                                                | Before/after exit 0; 32 baseline untracked paths, then 34 including the two additions.                    |
| [git -C projects/Zoo-Code diff --quiet](interrupted-create-handoff-manual-supersede-b-closure-contract.md:43)                                                                                                                                                        | Before/after exit 0; no tracked changes.                                                                  |
| [git -C projects/Zoo-Code diff --cached --quiet](interrupted-create-handoff-manual-supersede-b-closure-contract.md:43)                                                                                                                                               | Before/after exit 0; no staged changes.                                                                   |
| [pnpm --dir projects/Zoo-Code/src exec vitest run core/task-persistence/**tests**/manualSupersedeResultIdentity.spec.ts](interrupted-create-handoff-manual-supersede-b-closure-contract.md:43)                                                                       | Initial exit 1, 103 passed / 8 failed; after fixture correction exit 0, 111/111 passed.                   |
| [pnpm --dir projects/Zoo-Code/src exec tsc --noEmit --pretty false](interrupted-create-handoff-manual-supersede-b-closure-contract.md:43)                                                                                                                            | Initial and final runs exit 0.                                                                            |
| [(cd projects/Zoo-Code/src && pnpm exec eslint core/task-persistence/manualSupersedeResultIdentity.ts core/task-persistence/**tests**/manualSupersedeResultIdentity.spec.ts --max-warnings=0)](interrupted-create-handoff-manual-supersede-b-closure-contract.md:43) | Initial and final runs exit 0; no suppressions added.                                                     |
| [pnpm --dir projects/Zoo-Code exec prettier --check src/core/task-persistence/manualSupersedeResultIdentity.ts src/core/task-persistence/**tests**/manualSupersedeResultIdentity.spec.ts](interrupted-create-handoff-manual-supersede-b-closure-contract.md:43)      | Initial and final runs exit 0. Existing configuration emits an unknown-option warning; formatting passes. |

A bounded Python preservation/reference/whitespace check exited 0 after implementation: 2,912 original file hashes unchanged, exactly the two allowed additions, no pre-existing classifier references and no trailing whitespace. The source and test were not changed during this documentation follow-up. These historical verification results are not claimed as freshly rerun tests for the report.

## Remaining proof gaps and deferred work

**Provider proof remains UNKNOWN.** Caller-supplied projection equality cannot prove actual provider-effective serialization, adapter normalization, final request-body output or configured profile applicability. The proposed adapter clarification still needs its specified applicability/reapproval and separately authorized real-adapter offline proof. Unknown or transformed effective shapes remain blocked.

**Storage/owner/host proof remains UNKNOWN.** The module checks syntactic POSIX normalization and equality of synthetic root strings; it does not resolve symlinks or establish a real canonical root, actual host/build identity, predecessor process exit/start identity, drain accounting, complete child/intent/registry ownership or queue attribution. Supplied original display-mode evidence is compared, not authenticated.

**Writer proof remains absent.** No same-parent exclusion, guard, final-effect generation validation, conditional API append, task-file compare-and-swap, dedicated lifecycle repair, lock ordering/loss enforcement, authoritative disk read-back, startup/hydration convergence or writer-interleaving tests were implemented. The v1 digest is not a whole-history hash, authentication token, lease or writer barrier. Rename/read-back cannot be claimed as power-loss durability or exactly-once remote execution.

Production integration tests, actual provider request capture, real-writer disk-fault injection, lifecycle mutation/model checks, broader regression/build runs, live saved-state/host/queue inspection, child launch, model/request invocation, deployment and live repair: **[N/A] — not performed in this isolated scope**. No UI/hydration hook, provider adapter, API/task writer, guard installation, queue operation or readiness signal was added. The classifier imports only standard-library crypto/path facilities and is referenced only by its new test.

**Closure:** deterministic fail-closed isolated classifier checks pass; worktree preservation and unwired scope are established for this ticket. Independent review and all provider/writer/integration/promotion gates remain open. B1/B2 production writes and wiring remain explicitly deferred and BLOCKED; UNKNOWN historical child outcome is preserved without asserting that no child existed.
