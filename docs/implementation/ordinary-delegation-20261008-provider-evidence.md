# Ordinary delegation provider integration, D3 and separate completion repair — 2026-10-08

Contract: ZOO-ORDINARY-DELEGATION-20261008. Additive implementation evidence, not whole-dirty-tree acceptance.

## 1. Scope, instructions and provenance

Read the [AGENTS.md](../../AGENTS.md:48), [task-lifecycle-model.md](../architecture/task-lifecycle-model.md:84), [ordinary-persistence-1021-implementation-evidence.md](ordinary-persistence-1021-implementation-evidence.md:1), [ordinary-delegation-20261008-phase-evidence.md](ordinary-delegation-20261008-phase-evidence.md:1), [ordinary-delegation-20261008-fixture-evidence.md](ordinary-delegation-20261008-fixture-evidence.md:1), [ordinary-completion-20261008-refinement-evidence.md](ordinary-completion-20261008-refinement-evidence.md:1), and the [zoo-code-ordinary-delegation-20261008-code-prompt.md](../../../../.roo/skills/audit-architecture/references/zoo-code-ordinary-delegation-20261008-code-prompt.md:90) before changes. The narrower parent assignment authorizes only provider production changes, necessary delegation-tool diagnostics and a minimal boundary diagnostics accessor. No Task, scheduler, store, reducer, checker, model budget, dependency, build configuration, changeset or changelog edits.

Revision e18f931de70282a05c02fc5592e61b71c339a91f; branch weak_model_runtime_hardening. Own starting inventory: **51 staged / 37 unstaged / 24 untracked / 105 distinct dirty paths**, overlapping counts. Semantic index entries remain byte-for-byte equal to [index-before.txt](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/index-before.txt); starting status: [status-before.txt](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/status-before.txt). Parent before-snapshot mapping: [provider-parent-baseline-map.json](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-parent-baseline-map.json). Production provider/tool before hashes match the parent snapshot; the boundary starts from the already-applied phase repair rather than reverting to the original parent boundary.

Final inventory including this evidence document: **51 staged / 38 unstaged / 25 untracked / 107 distinct dirty paths**, overlapping counts. Initial document validation preceded final-ledger creation and correctly flagged that pending link; final validation requires every link to resolve.

Reviewed and modified paths, with **incremental** before/after hashes (not cumulative HEAD diffs):

| Path                                                                                                         | Before SHA-256                                                   | Final SHA-256                                                    | Incremental lines |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------- |
| [ClineProvider.ts](../../src/core/webview/ClineProvider.ts)                                                  | 62d438b98de7264ecfabc38b1cffe6dce569cd7593476774408db8c2c8fb91b8 | f64e70ba16092a2408a4fec9b13fcb4f68e74753578a654c7c71c0388da8ee75 | +978/-744         |
| [NewTaskTool.ts](../../src/core/tools/NewTaskTool.ts)                                                        | 22292d0bb1d2b4e4e8674c691bbce63b087f9a91fdb8b46afb1122419bb8e510 | 228edb31c00c36ab32efee25595ac1ae6608317dcef79389e5b6e65951b08b45 | +14/-9            |
| [targetPersistenceBoundary.ts](../../src/core/task-persistence/targetPersistenceBoundary.ts)                 | bf919c031e4c67009a15a0d6db07851ed147d3bc98f66c4e4608f6ae82c5be45 | d46b0d6be2ce6b6c1e6b18e832856c59e656c9ba85f73e5bcc8c80fff27e8367 | +27/-0            |
| [ordinaryDelegationComposition.spec.ts](../../src/core/task/__tests__/ordinaryDelegationComposition.spec.ts) | 36f3a9784699cc9b119cf7c07e59b202527ef535d33d6b89967dc58aba3c604c | 0854c2203f962bc1275eb15ac01266c7d5c4b4687afd07fe4e9dc2f542d103ee | +428/-2           |
| [ClineProvider.delegation.spec.ts](../../src/__tests__/ClineProvider.delegation.spec.ts)                     | cd704032d3fdf98a42df0ee70d7863d5a5605b2e3b24099b62a3f588c091fc6e | 6234d2378581bdc3104ce7b8a62b05277d3b8d8c085662da0ede6f86403f2378 | +56/-11           |
| [ordinaryCompletionOwnership.spec.ts](../../src/core/webview/__tests__/ordinaryCompletionOwnership.spec.ts)  | 3dcb423943c28b450c28f956d18f0f81b84e3bfcd9068fb2f821fcd4937179ab | 3c2af1ff3a5804dac9b2f09c513b274ee08826624d49da099486ea4e851a03ba | +10/-0            |

This document is the only new active file. Per-file incremental patches, plus the independently enumerated completion-only mapping, are retained under the disposable root; final provenance: [provider-final-preservation.json](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-final-preservation.json). All unrelated original source hashes match except two generated distribution artifacts that changed while this assignment ran. This agent neither wrote nor restored those artifacts; their producer/semantic validity is UNKNOWN. Active lint-suppression bytes, phase source, all store/reducer/checker files, historical witnesses and index entries are preserved. No stage/reset/clean occurred.

## 2. Independent executable boundary

Disposable root: /tmp/zoo-provider-integration-20261008-toc5mqiu. Physically copied the phase template, then overlaid current dirty active source. Initial validation: **98,433 regular project/dependency files, 5,499 links, 7,367 source hashes, zero shared template/active file inodes, zero escaping project/dependency links, zero source mismatches**. [copy-validation.json](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/copy-validation.json) and [source-before.json](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/source-before.json) retain the validation. Existing pnpm distribution was physically copied too; no installation or Corepack download.

Every executable check uses installed Node **22.23.1**, disposable HOME/config/cache/TMPDIR/PNPM_HOME, CI/no-tracking settings and the [offline.cjs](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/offline.cjs:1) preload denying sockets/TLS/HTTP(S)/datagrams/fetch. IPC is allowed only below disposable TMPDIR. Exact environment: [verification-env.json](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/verification-env.json). Network-denial attempts in focused tests are retained in [network-denials.txt](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/network-denials.txt); denial is not network/live-host success. Only source/hash/Git provenance inspection and bounded document generation run from the active workspace. No active test, lint, typecheck, model or package-manager command was executed there.

## 3. Actual pre-fix evidence

The new copy's pre-fix run executed the unchanged phase suite, real-store provider fixtures and separate completion suite: **exit 1; 3 failed files; 7 failed / 29 passed tests; no reported unhandled-error section**. Exact command/output: [provider-prefix.command.json](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-prefix.command.json), [provider-prefix.output.txt](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-prefix.output.txt).

- Two unsuppressed provider blockers: ordinary default scheduling still supplies a protected runner, so the full-question waiter cannot open; teardown failure removes the current parent before the catch and leaves no focused recoverable task.
- Four old fixture failures: obsolete action wording, expected durable-child deletion, and disposal/deletion ordering in two failure cases. Their storage hooks already cross the real disposable boundary. Deleting real child evidence to make them green would be incorrect.
- One completion test has **two safety assertion failures**: after a newer host appends its native call and delegates, the admitted old completion publishes stale UI/API results and attaches the old result to the newer call. A detached return afterward does not erase those writes. This is one failed test, not two.

The phase child's earlier actual scheduler/presenter/abort reproduction remains in [ordinary-delegation-20261008-phase-evidence.md](ordinary-delegation-20261008-phase-evidence.md:33). This assignment starts atop that phase repair; it does not claim to have independently rediscovered the original guard-lifetime fault from today's host logs.

## 4. Separately enumerated implementation hunks

### P1 — ordinary scheduling integration

[scheduleTask()](../../src/core/webview/ClineProvider.ts:321) passes an **absent runner** to the actual scheduler for ordinary tasks. The no-scheduler fallback invokes the actual [Task.runScheduled()](../../src/core/task/Task.ts:2735) API in independent orchestration. Supplied arbitrary callbacks retain their existing capable-effect protection through the last awaited effect. The helper's boolean is **enqueue acceptance only**, not admission/start/settlement/success.

Observers are contained on both scheduler and fallback paths. A custom continuation failure before callback entry is observed; once its callback owns stage reporting, scheduler output is filtered to avoid duplicate start/settle/failure. Default callers without an observer use the same provider-output diagnostic sink rather than silently dropping failure.

### P2 — guarded teardown and truthful restoration

[Parent cleanup scope](../../src/core/webview/ClineProvider.ts:4311) now includes registry removal/abort and final disposal inside the recovery catch. Delegation abort failures are not swallowed as successful cleanup. Flush failure refuses before teardown instead of creating a child from undurable parent context.

[Restoration](../../src/core/webview/ClineProvider.ts:4398) requires a live inherited generation plus exact captured authoritative publication identity **and ordinary revision**. Identity includes action/question/lineage/awaited child. Revalidate before cleanup, reconstruction and after the last focus/state effect. Reconstruct with **start disabled**, focus the new instance and post state under that same ownership. Existing interrupted-child lineage may be restored only when unchanged; new/moved action, revision or owner refuses.

[DelegationRecoverableError](../../src/core/webview/ClineProvider.ts:285) retains the original failure and typed disposition (stopped parent restored versus evidence retained). No durable child bytes are deleted. A writer may have committed before throwing: moved identity or uncertain cleanup retains evidence, not an invented atomic rollback. Successful child publication still precedes exact parent handoff commit and enqueue.

### D3 — one bounded safe correlated output sink

[DelegationDiagnostics](../../src/core/webview/ClineProvider.ts:193) routes through [ClineProvider.log()](../../src/core/webview/ClineProvider.ts:3522), which appends to Zoo output (and the existing host-console mirror). The same attempt object is shared by delegation-tool/provider/scheduler reporting. Parent continuation is a separate correlated completion attempt. No new log backend or durable ownership protocol.

Bound: **128 records per attempt**, fixed phase/stage vocabulary, IDs capped to safe identifier form (otherwise hashed), 16-hex SHA-256 owner correlation, finite clamped elapsed times and allow-listed failure category/code only. The [read-only diagnostics accessor](../../src/core/task-persistence/targetPersistenceBoundary.ts:60) exposes inherited/acquire, active, generation and hashed owner correlation; it never validates, acquires, joins, releases, renews, or changes a guard. Its 27-line addition is the boundary's only incremental change.

Records cover transition/fence acquisition before acquisition can fail; parent flush/abort/final disposal; child preparation; durable child and parent publication; enqueue; scheduler admission/start/settlement/failure; recovery and parent continuation. No prompts, message/error text, transcript, credentials, profile names, owner tokens or raw objects are passed to this sink. Tool/provider return is explicitly not execution success. Scheduler admitted means **semaphore admission**, started means **execution-entry invocation** (ordinary authority preflight can still refuse); actual Task/model-loop progress is separately asserted in the composition suite.

Diagnostic proof:

- [Gated actual scheduler/presenter proof](../../src/core/task/__tests__/ordinaryDelegationComposition.spec.ts:239): original loop settles while final cleanup is gated; diagnostics show active matching generation/owner through cleanup, no scope-end/provider-return before that gate; a real zero-wait competitor cannot acquire. Child durable save precedes parent commit, enqueue and eventual actual child settlement.
- [Output and asynchronous-start failure proof](../../src/core/task/__tests__/ordinaryDelegationComposition.spec.ts:536): invokes the real provider logging method and asserts Zoo output receives exactly the same records. Enqueue/provider-return occur before the injected asynchronous child-start rejection; later failure is logged, never a false settlement or durable rollback. Raw secret-bearing injected error text is absent.
- [Last restoration-effect proof](../../src/core/task/__tests__/ordinaryDelegationComposition.spec.ts:648): focused-state post remains gated; real parent fence is unavailable until it finishes. Typed refusal retains exact original cleanup error.
- [Refusal/redaction/bound proof](../../src/core/task/__tests__/ordinaryDelegationComposition.spec.ts:599): acquisition failure is visible before parent effects, raw owner token is absent, invalid action ID is hashed, unknown code omitted, 160 emissions stop at 128.
- Real ordinary and custom fallbacks plus throwing sink/observers prove no observer outcome/permit changes. Revision/action/owner restoration refusals preserve exact authoritative bytes.

Sanitized illustrative ordering (values are synthetic, not live IDs or owner tokens):

```text
correlation=attempt-a task=parent instance=instance-a action=call transition=1
transition_acquire begin -> end; fence_acquire begin -> end
ownership=inherited guard.active=true generation=7 ownerCorrelation=0123456789abcdef
parent_flush begin -> end; parent_disposal begin; parent_abort begin
[last cleanup held: no fence_scope/end or provider_return/end]
parent_abort end; parent_disposal end; child_prepare begin -> end
child=child-a durable_child begin -> end; durable_parent begin -> end
enqueue begin -> end; provider_return end != child success
scheduler admitted -> started -> failed; failure.type=effect_failed code=EIO
```

### C1 — separate reproduced completion-ownership repair

Mapped the supplied [recommended-completion-ownership.patch.txt](../../../../../../../tmp/zoo-completion-refinement-20261008-2drd9ll2/recommended-completion-ownership.patch.txt) to [reopenParentFromDelegation() ownership](../../src/core/webview/ClineProvider.ts:4563). Cooperative ancestry-planned **parent and child exclusions now precede authoritative admission and transcript I/O**, rather than first arriving around pair metadata commit. The same scope continues through final parent publication/recreation/prepare effects. Independently enumerated ownership-only mapping: [completion-ownership-only.incremental.patch.txt](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/completion-ownership-only.incremental.patch.txt). Provider method reindentation is a scope wrapper, not a store/reducer rewrite; D3 continuation fields are separately diagnostic.

The existing [ordinaryCompletionOwnership.spec.ts](../../src/core/webview/__tests__/ordinaryCompletionOwnership.spec.ts:287) now passes **5/5** with original safety assertions retained and stronger refused-branch byte/correlation assertions. A competing ordinary host is typed-refused before its newer native-call append; old completion produces only the saved result against its original call. After release the newer delegate progresses, old replay is refused without byte changes. Exact child-before-parent publication exclusion, no duplicate result/event, wrong-child rejection and failed-parent-publication committed child/transcript prefix remain tested. Typed outcome/reason/partial-commit behavior is unchanged.

### T1 — legitimate fixture refinements only

The [ClineProvider.delegation.spec.ts](../../src/__tests__/ClineProvider.delegation.spec.ts:1) structural children expose the scheduler's actual ordinary API; restoration doubles return and focus a real-shaped stopped task. Removed a dispose-hook that fabricated metadata in a side map. Old deletion expectations are replaced by **strict real authoritative retained-child assertions**, no deletion, disposal-before-restoration and no child execution after failure. Typed wrapper assertions preserve original errors and exact refusal cause. Profile-fallback logging asserts safe correlated failure rather than a raw profile ID.

The original [ordinaryDelegationComposition.spec.ts](../../src/core/task/__tests__/ordinaryDelegationComposition.spec.ts:519) waiter assertion remains. An added bounded wait observes actual detached-presenter wait registration: pending-question metadata precedes capable ask preparation, so mere model-loop settlement is not that registration barrier. The old protected-runner behavior would still fail this bounded waiter assertion; no production authority check is bypassed.

## 5. Verification results and retained deviations

**Final accepted source:** exit 0, **13 passed files / 340 passed tests / zero skipped tests / no reported unhandled errors**, [provider-accepted-focused.output.txt](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-accepted-focused.output.txt). Actual composition **21/21** (including both blockers and eleven added diagnostic/recovery/scheduling cases); current completion **5/5**; provider fixtures **21/21**; remaining file breakdown is retained in the output. These are bounded offline tests, not real extension-host/API smoke.

Source typecheck, public-types typecheck, exact scoped package-manager lint with suppression pruning, and six-file formatter check: **all exit 0**. Active suppression bytes are unchanged; copied lint drops one obsolete tool suppression and increases no file count. Public-types/model scripts are unchanged between their checked copy and final copy; these checks do not execute provider orchestration.

All eight declared model stages exit 0: lifecycle **89** states; historical store **625** states and current ordinary authority **24,540** states (8 scenarios, 7 invariants, 11/11 phases, 10/10 landmarks); provider/scheduler **104** states with 6/6 retained legacy counterexamples; cleanup **96,174** states; parser **924/924** interleavings; completion **88** states; delegated readers **4** divergent pairs / 5/5 modes; pending-question **7** states. No reducer/checker/budget/witness edits.

Retained historical output (not a current safe-protocol claim):

```text
Known unsafe #1469: stale child completion cleared a newer parent handoff
  complete-a.read -> complete-a.prepare -> redelegate-b.read -> redelegate-b.prepare -> redelegate-b.revalidate(child-a) -> redelegate-b.commit(child-a) -> complete-a.revalidate(child-a) -> complete-a.commit(child-a) -> redelegate-b.revalidate(child-b) -> redelegate-b.commit(child-b) -> redelegate-b.revalidate(parent) -> redelegate-b.commit(parent) -> complete-a.revalidate(parent) -> complete-a.commit(parent)
Known unsafe #1021: stale live-task save reattached abandoned lineage
  stale-save-a.read -> abandon-b.read -> abandon-b.prepare -> abandon-b.revalidate(child-a) -> abandon-b.commit(child-a) -> abandon-b.revalidate(parent) -> abandon-b.commit(parent) -> A.refresh -> stale-save-a.prepare -> stale-save-a.revalidate(child-a) -> stale-save-a.commit(child-a)
```

Retained intermediate failures: first launcher-preparation command exits 1 before verification (wrong copied distribution directory); no install/network fallback. Initial typecheck exits 2 (five new child-narrowing errors), corrected with a stable prepared-child reference. Second focused run exits 1 (**6 failed / 51 passed**) while diagnosing implicit-disposal gate ordering and obsolete fixture contracts. Third focused run exits 1 (**1 failed / 56 passed**), the remaining obsolete deletion assertion. Later release typecheck exits 2 (one private pending-action access), corrected by typed read-only bracket access. The 337-test, 339-test and 241-test passes overlap the final 340-test selection and **must not be summed**. A nonexistent provider-test argument in the earlier 337-test invocation selected no file; the final invocation enumerates exactly 13 existing suites. Existing Vite file-URL warnings and formatter unknown-option warnings remain, not hidden as production faults.

No SIGSEGV/signal-11/exit-139 or final unhandled rejection was captured. Prior Bash signal-11 attribution remains UNKNOWN. Earlier ordinary/phase root failures, explicit root verification bounds and historical negative findings remain in their linked reports and are not relabeled pre-existing or cleared by these checks.

All exact argv/cwd/exits/durations, including interim failures: [provider-command-ledger.json](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-command-ledger.json).

| Command record                                                                                                                                                                                    | Exit | Seconds |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------- |
| [provider-accepted-focused](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-accepted-focused.command.json)                                                           | 0    | 92.23   |
| [provider-accepted-format-check](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-accepted-format-check.command.json)                                                 | 0    | 2.73    |
| [provider-accepted-format](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-accepted-format.command.json)                                                             | 0    | 1.97    |
| [provider-accepted-lint](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-accepted-lint.command.json)                                                                 | 0    | 17.34   |
| [provider-accepted-source-types](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-accepted-source-types.command.json)                                                 | 0    | 44.09   |
| [provider-final-focused](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-final-focused.command.json)                                                                 | 0    | 83.28   |
| [provider-final-format](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-final-format.command.json)                                                                   | 0    | 1.72    |
| [provider-final-lint](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-final-lint.command.json)                                                                       | 0    | 15.53   |
| [provider-final-public-types](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-final-public-types.command.json)                                                       | 0    | 15.03   |
| [provider-final-source-types](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-final-source-types.command.json)                                                       | 0    | 45.50   |
| [provider-first-format](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-first-format.command.json)                                                                   | 0    | 2.67    |
| [provider-first-lint](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-first-lint.command.json)                                                                       | 0    | 15.38   |
| [provider-first-types](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-first-types.command.json)                                                                     | 2    | 66.55   |
| [provider-matched-focused](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-matched-focused.command.json)                                                             | 0    | 49.10   |
| [provider-matched-format](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-matched-format.command.json)                                                               | 0    | 1.87    |
| [provider-matched-lint](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-matched-lint.command.json)                                                                   | 0    | 14.68   |
| [provider-matched-source-types](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-matched-source-types.command.json)                                                   | 0    | 53.34   |
| [provider-model-check-completion-persistence.ts](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-model-check-completion-persistence.ts.command.json)                 | 0    | 0.57    |
| [provider-model-check-delegated-mode-readers.ts](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-model-check-delegated-mode-readers.ts.command.json)                 | 0    | 0.62    |
| [provider-model-check-pending-question.ts](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-model-check-pending-question.ts.command.json)                             | 0    | 0.57    |
| [provider-model-check-provider-handoff-scheduler.ts](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-model-check-provider-handoff-scheduler.ts.command.json)         | 0    | 0.67    |
| [provider-model-check-task-cleanup-protocol.ts](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-model-check-task-cleanup-protocol.ts.command.json)                   | 0    | 6.74    |
| [provider-model-check-task-lifecycle.ts](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-model-check-task-lifecycle.ts.command.json)                                 | 0    | 0.92    |
| [provider-model-check-task-store-concurrency.ts](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-model-check-task-store-concurrency.ts.command.json)                 | 0    | 9.45    |
| [provider-model-run-native-tool-call-parser-scoping.mjs](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-model-run-native-tool-call-parser-scoping.mjs.command.json) | 0    | 0.72    |
| [provider-prefix](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-prefix.command.json)                                                                               | 1    | 42.74   |
| [provider-release-focused](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-release-focused.command.json)                                                             | 0    | 89.46   |
| [provider-release-format-check](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-release-format-check.command.json)                                                   | 0    | 2.07    |
| [provider-release-format](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-release-format.command.json)                                                               | 0    | 1.87    |
| [provider-release-lint](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-release-lint.command.json)                                                                   | 0    | 16.18   |
| [provider-release-source-types](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-release-source-types.command.json)                                                   | 2    | 56.04   |
| [provider-second-focused](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-second-focused.command.json)                                                               | 1    | 41.05   |
| [provider-second-format](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-second-format.command.json)                                                                 | 0    | 1.87    |
| [provider-second-types](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-second-types.command.json)                                                                   | 0    | 47.46   |
| [provider-third-focused](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-third-focused.command.json)                                                                 | 1    | 33.80   |
| [provider-third-format](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-third-format.command.json)                                                                   | 0    | 1.72    |

## 6. Exact selected verification commands

The environment linked in section 2 is applied to **every** command below. Finite subprocess bounds are retained in command records; no timeout detached verification into active state.

### provider-prefix

Cwd: /tmp/zoo-provider-integration-20261008-toc5mqiu/Zoo-Code/src. Node 22.23.1. Exit **1**. Bounded process duration 42.74s.

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-provider-integration-20261008-toc5mqiu/Zoo-Code/src/node_modules/vitest/vitest.mjs run core/task/__tests__/ordinaryDelegationComposition.spec.ts core/webview/__tests__/ordinaryCompletionOwnership.spec.ts __tests__/ClineProvider.delegation.spec.ts --maxWorkers=1 --reporter=default
```

Exact record: [provider-prefix.command.json](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-prefix.command.json); output: [provider-prefix.output.txt](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-prefix.output.txt).

### provider-accepted-focused

Cwd: /tmp/zoo-provider-integration-20261008-toc5mqiu/Zoo-Code/src. Node 22.23.1. Exit **0**. Bounded process duration 92.23s.

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-provider-integration-20261008-toc5mqiu/Zoo-Code/src/node_modules/vitest/vitest.mjs run core/task/__tests__/ordinaryDelegationComposition.spec.ts core/webview/__tests__/ordinaryCompletionOwnership.spec.ts __tests__/ClineProvider.delegation.spec.ts core/tools/__tests__/newTaskTool.spec.ts core/task/__tests__/TaskScheduler.spec.ts core/task/__tests__/manualSupersedeB1.startGuard.spec.ts core/task/__tests__/manualSupersedeB1.actualInstanceStart.spec.ts core/task/__tests__/pending-question.spec.ts core/task/__tests__/ordinaryPersistenceOwnership.spec.ts core/task/__tests__/Task.spec.ts core/task/__tests__/providerHandoff.spec.ts core/webview/__tests__/ordinaryAbandonmentPersistence.spec.ts core/task-persistence/__tests__/taskLifecycle.spec.ts --maxWorkers=1 --reporter=default
```

Exact record: [provider-accepted-focused.command.json](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-accepted-focused.command.json); output: [provider-accepted-focused.output.txt](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-accepted-focused.output.txt).

### provider-accepted-source-types

Cwd: /tmp/zoo-provider-integration-20261008-toc5mqiu/Zoo-Code/src. Node 22.23.1. Exit **0**. Bounded process duration 44.09s.

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-provider-integration-20261008-toc5mqiu/Zoo-Code/node_modules/typescript/bin/tsc --noEmit --pretty false
```

Exact record: [provider-accepted-source-types.command.json](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-accepted-source-types.command.json); output: [provider-accepted-source-types.output.txt](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-accepted-source-types.output.txt).

### provider-final-public-types

Cwd: /tmp/zoo-provider-integration-20261008-toc5mqiu/Zoo-Code/packages/types. Node 22.23.1. Exit **0**. Bounded process duration 15.03s.

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-provider-integration-20261008-toc5mqiu/Zoo-Code/node_modules/typescript/bin/tsc --noEmit --pretty false
```

Exact record: [provider-final-public-types.command.json](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-final-public-types.command.json); output: [provider-final-public-types.output.txt](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-final-public-types.output.txt).

### provider-accepted-lint

Cwd: /tmp/zoo-provider-integration-20261008-toc5mqiu/Zoo-Code. Node 22.23.1. Exit **0**. Bounded process duration 17.34s.

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-provider-integration-20261008-toc5mqiu/pnpm/bin/pnpm.cjs --dir src exec eslint --prune-suppressions --max-warnings=0 core/webview/ClineProvider.ts core/tools/NewTaskTool.ts core/task-persistence/targetPersistenceBoundary.ts core/task/__tests__/ordinaryDelegationComposition.spec.ts __tests__/ClineProvider.delegation.spec.ts core/webview/__tests__/ordinaryCompletionOwnership.spec.ts
```

Exact record: [provider-accepted-lint.command.json](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-accepted-lint.command.json); output: [provider-accepted-lint.output.txt](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-accepted-lint.output.txt).

### provider-accepted-format-check

Cwd: /tmp/zoo-provider-integration-20261008-toc5mqiu/Zoo-Code. Node 22.23.1. Exit **0**. Bounded process duration 2.73s.

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-provider-integration-20261008-toc5mqiu/Zoo-Code/node_modules/prettier/bin/prettier.cjs --check src/core/webview/ClineProvider.ts src/core/tools/NewTaskTool.ts src/core/task-persistence/targetPersistenceBoundary.ts src/core/task/__tests__/ordinaryDelegationComposition.spec.ts src/__tests__/ClineProvider.delegation.spec.ts src/core/webview/__tests__/ordinaryCompletionOwnership.spec.ts
```

Exact record: [provider-accepted-format-check.command.json](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-accepted-format-check.command.json); output: [provider-accepted-format-check.output.txt](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-accepted-format-check.output.txt).

### provider-model-check-task-lifecycle.ts

Cwd: /tmp/zoo-provider-integration-20261008-toc5mqiu/Zoo-Code. Node 22.23.1. Exit **0**. Bounded process duration 0.92s.

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-provider-integration-20261008-toc5mqiu/Zoo-Code/node_modules/tsx/dist/cli.mjs scripts/check-task-lifecycle.ts
```

Exact record: [provider-model-check-task-lifecycle.ts.command.json](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-model-check-task-lifecycle.ts.command.json); output: [provider-model-check-task-lifecycle.ts.output.txt](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-model-check-task-lifecycle.ts.output.txt).

### provider-model-check-task-store-concurrency.ts

Cwd: /tmp/zoo-provider-integration-20261008-toc5mqiu/Zoo-Code. Node 22.23.1. Exit **0**. Bounded process duration 9.45s.

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-provider-integration-20261008-toc5mqiu/Zoo-Code/node_modules/tsx/dist/cli.mjs scripts/check-task-store-concurrency.ts
```

Exact record: [provider-model-check-task-store-concurrency.ts.command.json](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-model-check-task-store-concurrency.ts.command.json); output: [provider-model-check-task-store-concurrency.ts.output.txt](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-model-check-task-store-concurrency.ts.output.txt).

### provider-model-check-provider-handoff-scheduler.ts

Cwd: /tmp/zoo-provider-integration-20261008-toc5mqiu/Zoo-Code. Node 22.23.1. Exit **0**. Bounded process duration 0.67s.

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-provider-integration-20261008-toc5mqiu/Zoo-Code/node_modules/tsx/dist/cli.mjs scripts/check-provider-handoff-scheduler.ts
```

Exact record: [provider-model-check-provider-handoff-scheduler.ts.command.json](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-model-check-provider-handoff-scheduler.ts.command.json); output: [provider-model-check-provider-handoff-scheduler.ts.output.txt](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-model-check-provider-handoff-scheduler.ts.output.txt).

### provider-model-check-task-cleanup-protocol.ts

Cwd: /tmp/zoo-provider-integration-20261008-toc5mqiu/Zoo-Code. Node 22.23.1. Exit **0**. Bounded process duration 6.74s.

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-provider-integration-20261008-toc5mqiu/Zoo-Code/node_modules/tsx/dist/cli.mjs scripts/check-task-cleanup-protocol.ts
```

Exact record: [provider-model-check-task-cleanup-protocol.ts.command.json](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-model-check-task-cleanup-protocol.ts.command.json); output: [provider-model-check-task-cleanup-protocol.ts.output.txt](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-model-check-task-cleanup-protocol.ts.output.txt).

### provider-model-run-native-tool-call-parser-scoping.mjs

Cwd: /tmp/zoo-provider-integration-20261008-toc5mqiu/Zoo-Code. Node 22.23.1. Exit **0**. Bounded process duration 0.72s.

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node scripts/run-native-tool-call-parser-scoping.mjs
```

Exact record: [provider-model-run-native-tool-call-parser-scoping.mjs.command.json](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-model-run-native-tool-call-parser-scoping.mjs.command.json); output: [provider-model-run-native-tool-call-parser-scoping.mjs.output.txt](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-model-run-native-tool-call-parser-scoping.mjs.output.txt).

### provider-model-check-completion-persistence.ts

Cwd: /tmp/zoo-provider-integration-20261008-toc5mqiu/Zoo-Code. Node 22.23.1. Exit **0**. Bounded process duration 0.57s.

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-provider-integration-20261008-toc5mqiu/Zoo-Code/node_modules/tsx/dist/cli.mjs scripts/check-completion-persistence.ts
```

Exact record: [provider-model-check-completion-persistence.ts.command.json](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-model-check-completion-persistence.ts.command.json); output: [provider-model-check-completion-persistence.ts.output.txt](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-model-check-completion-persistence.ts.output.txt).

### provider-model-check-delegated-mode-readers.ts

Cwd: /tmp/zoo-provider-integration-20261008-toc5mqiu/Zoo-Code. Node 22.23.1. Exit **0**. Bounded process duration 0.62s.

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-provider-integration-20261008-toc5mqiu/Zoo-Code/node_modules/tsx/dist/cli.mjs scripts/check-delegated-mode-readers.ts
```

Exact record: [provider-model-check-delegated-mode-readers.ts.command.json](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-model-check-delegated-mode-readers.ts.command.json); output: [provider-model-check-delegated-mode-readers.ts.output.txt](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-model-check-delegated-mode-readers.ts.output.txt).

### provider-model-check-pending-question.ts

Cwd: /tmp/zoo-provider-integration-20261008-toc5mqiu/Zoo-Code. Node 22.23.1. Exit **0**. Bounded process duration 0.57s.

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-provider-integration-20261008-toc5mqiu/Zoo-Code/node_modules/tsx/dist/cli.mjs scripts/check-pending-question.ts
```

Exact record: [provider-model-check-pending-question.ts.command.json](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-model-check-pending-question.ts.command.json); output: [provider-model-check-pending-question.ts.output.txt](../../../../../../../tmp/zoo-provider-integration-20261008-toc5mqiu/provider-model-check-pending-question.ts.output.txt).

## 7. Limits and next ownership boundary

No reproducible provider blocker remains in the authorized focused path. **[N/A] full root test run**: parent explicitly owns one bounded complete final-source root run; this agent did not run it. **[N/A]** broad root/app builds, whole-dirty-tree acceptance, live Insiders host/start/restart, profile/history/queue inspection or repair, real API/model/network smoke, installation, deployment/release, B1/B2 enablement, arbitrary noncooperative writers, arbitrary lineage/crash/power-loss/restart durability, same-child attempt identity and universal historical native-call correlation. Existing custom continuation callbacks stay protected; a full post-child parent loop reaching a new question is not this suite's end-to-end liveness proof. Broader continuation UX/real-host evidence remains parent-owned rather than silently widening Task/scheduler scope.

Conditional offline verdict: **OFFLINE_ORDINARY_VIABLE_WITH_LIMITS** — authorized provider blockers, D3 sink/last-effect/asynchronous failure behavior, and the separately reproduced cooperative completion fault have bounded real-path proof. This is not deployment, live-host safety or whole-repository stability acceptance.
