# B1 provider final effects — PARTIAL_IMPLEMENTATION

STATUS=PARTIAL_IMPLEMENTATION; WRITER=UNWIRED; ADAPTER=UNKNOWN; B1=BLOCKED.

Isolated temporary-disk evidence only. No live saved-state/host/queue operation, child/model loop launch, remote request, deployment, staging, reset, B2 metadata repair, conditional API append or Odoo runtime. Two real stores and canonical-root aliases are used; task doubles and actual-instance loop seams are non-running. Network is disabled by the test setup.

## Changed versus preserved

- New changes to [provider](../../src/core/webview/ClineProvider.ts:627): task/parent stack-publication guards; current-target exclusion before top-level creation and eviction; fatal eviction admission; awaited current/parent disposal; history-parent exclusion and final in-place replacement checks; conservative rollback retains child evidence; post-commit and pre-enqueue generation checks.
- New changes to [task](../../src/core/task/Task.ts:2540): own/parent lease checks immediately before actual fresh and resumed task-loop admission, after asynchronous initialization.
- New changes to [boundary](../../src/core/task-persistence/targetPersistenceBoundary.ts:78): ancestor-lease final checks and synchronous inherited-generation checks in existing locked persistence predicates, including child output parent ownership. No lease acquisition under a store mutex or file lock.
- Added [provider final-effect suite](../../src/core/webview/__tests__/manualSupersedeB1.providerFinalEffects.spec.ts:1): 20 tests, including an explicitly unsafe rename witness. Added [actual-instance start suite](../../src/core/task/__tests__/manualSupersedeB1.actualInstanceStart.spec.ts:1): six tests. Preserved [provider-start fixture](../../src/core/webview/__tests__/manualSupersedeB1.providerStart.spec.ts:98) gains the real store reference; assertions unchanged.
- Existing staged, unstaged and untracked work/reports remain; the scheduler, store, startup tests, resume-race fixture, adapter and UI were not edited by this task. The staged diff remains 51 paths, 7,414 insertions and 158 deletions. ESLint pruning rewrote suppression-file indentation only; semantic comparison was equal and its original index bytes were restored, with no final diff and no increased suppression count.

## Effects: entry → last effect → guard → actual-path test

| Entry / final effect                                                                                                                                                    | Production protection and actual-path evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Limit                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [Delegation](../../src/core/webview/ClineProvider.ts:3977) → real flush, parent teardown/disposal, registry publication, physical child rename, parent ownership rename | Existing outer parent lease now drains [parent disposal](../../src/core/webview/ClineProvider.ts:4106); [five independent pauses](../../src/core/webview/__tests__/manualSupersedeB1.providerFinalEffects.spec.ts:158) make alias binding refuse while unrelated parent work progresses.                                                                                                                                                                                                             | Flush body is a non-running seam; physical writes are real. Rename-generation gap below remains.                |
| [Commit failure → rollback/disposal](../../src/core/webview/ClineProvider.ts:4191)                                                                                      | Parent lease remains held during [paused child disposal](../../src/core/webview/__tests__/manualSupersedeB1.providerFinalEffects.spec.ts:200). [Commit-then-error](../../src/core/webview/__tests__/manualSupersedeB1.providerFinalEffects.spec.ts:225) after real successful store commit and [cleanup failure](../../src/core/webview/__tests__/manualSupersedeB1.providerFinalEffects.spec.ts:245) retain child evidence and never enqueue. No child deletion claims uncertain ownership removal. | Lost generation deliberately refuses further rollback/disposal/publication and retains evidence.                |
| [Top-level create](../../src/core/webview/ClineProvider.ts:3509) → current-target eviction                                                                              | Incoming creation first fences current task plus persisted parent. [Bound target](../../src/core/webview/__tests__/manualSupersedeB1.providerFinalEffects.spec.ts:281) cannot be torn down. [Eviction](../../src/core/webview/ClineProvider.ts:733) retains exclusion through awaited abort and disposal; tests pause both.                                                                                                                                                                          | Other bare removal callers remain outside this coverage.                                                        |
| [Direct registry publication](../../src/core/webview/ClineProvider.ts:637), [history restoration](../../src/core/webview/ClineProvider.ts:1301) → push/replacement      | Task plus parent exclusion; checks before push/replacement. Bound-child [stack](../../src/core/webview/__tests__/manualSupersedeB1.providerFinalEffects.spec.ts:318) and [history](../../src/core/webview/__tests__/manualSupersedeB1.providerFinalEffects.spec.ts:330) refusal; delegation pauses actual preparation after registry push.                                                                                                                                                           | Unbound actual history constructor/replacement synchronized test remains missing.                               |
| [Constructor](../../src/core/task/Task.ts:843), [static factory](../../src/core/task/Task.ts:1174) → actual task-loop admission                                         | Real instances and real start bodies pause in provider initialization; [six tests](../../src/core/task/__tests__/manualSupersedeB1.actualInstanceStart.spec.ts:109) prove held exclusion, bound refusal and lost-generation loop refusal. Loop and controller side effects are mocked.                                                                                                                                                                                                               | Full history-instance resume initialization is not synchronized here.                                           |
| [Real provider enqueue](../../src/core/webview/ClineProvider.ts:4242) → scheduler permit / fallback callback                                                            | [Actual enqueue tests](../../src/core/webview/__tests__/manualSupersedeB1.providerFinalEffects.spec.ts:400) use real scheduler or fallback and actual task fresh-exclusion method. Binding after outer lease release prevents callback; known child ownership remains truthful. Existing scheduler/start suites cover permit and executing callback.                                                                                                                                                 | Scheduler implementation preserved, not newly edited. Binding is test-only exclusion, not recovery eligibility. |
| [Locked persistence predicates](../../src/core/task-persistence/targetPersistenceBoundary.ts:307) → merge/output                                                        | Inherited task/parent generation checked synchronously without acquiring under lock; [physical locked-read races](../../src/core/webview/__tests__/manualSupersedeB1.providerFinalEffects.spec.ts:350) reject child and parent merge after loss, preserving prior child evidence.                                                                                                                                                                                                                    | Predicate is before streaming/rename, not atomic with physical commit.                                          |

## Remaining — smallest next implementation

1. [Physical write](../../src/utils/safeWriteJson.ts:142): after the [merge predicate](../../src/utils/safeWriteJson.ts:110), async temporary streaming and backup/commit renames can cross lost generation. The final provider suite's **UNCLOSED rename interval** test changes parent generation immediately before actual parent commit rename: ownership STILL reaches disk, provider then rejects, no callback is enqueued and no child evidence is erased. This is a demonstrated UNSAFE effect, NOT passing safety acceptance. Smallest next edit: explicitly authorize the shared guarded-write primitive plus store/API final-effect plumbing and tests, ensuring loss is rejected at physical publication without acquiring parent exclusion under a file/store lock. These paths are outside this prompt's production edit allowlist and were not modified. Do not infer closure from the post-commit check.
2. [Parent commit updater](../../src/core/webview/ClineProvider.ts:4173) still compares action ID, not full action/message/mode/todos/approval, pending question and authoritative ownership. Ordinary other-store writers without a binding do not necessarily participate in provider exclusion. Smallest next implementation: authoritative expected-parent identity comparison at final commit and participating changed-action/question/known-prepared-child writers. Add synchronized field-change races; do not claim current tests cover them.
3. [History replacement](../../src/core/webview/ClineProvider.ts:1504) has final checks but lacks an unbound actual-constructor/replacement pause against binding. Add a non-running real history restoration fixture (including outgoing current task and persisted parent) and history-instance resumed initialization races. Direct creation currently uses a structural child seam in real delegation tests, not a full provider actual constructor test.
4. [Actual initialization](../../src/core/task/Task.ts:2555) has checks at entry and loop admission; intermediate say/state/telemetry effects and checkpoints/stale writers are not all guarded at their final effects. Complete the deferred completion/checkpoint/stale-writer and strict conditional-append/read-back task; B1 stays unreachable.
5. Ordinary virtual-storage suites remain verification debt: final broad run 142 passed / 70 failed across seven suites. [Provider suite](../../src/core/webview/__tests__/ClineProvider.spec.ts:1): 37 failures, including newly reached guarded stack/eviction calls lacking mocked storage resolution; [cancel suite](../../src/core/webview/__tests__/ClineProvider.flicker-free-cancel.spec.ts:1): 12 failures; [history suite](../../src/core/webview/__tests__/ClineProvider.taskHistory.spec.ts:1): 21 failures. Missing storage-base/realpath mocks and nonexistent mocked storage cannot satisfy disk exclusion. No assertions weakened, no fail-open production fallback added. Not all 70 are asserted pre-existing: broader entry guarding expands mock debt relative to the earlier report. Convert fixtures to temporary storage separately.

## Exact verification

All expanded commands below execute from workspace root. Final success checks do not erase earlier failed attempts. Initial inventory completed before edits; final inventory/whitespace rerun after this note.

```sh
git -C projects/Zoo-Code status --short --untracked-files=all
```

Exit/count: 0; initial inventory, all existing work preserved.

```sh
git -C projects/Zoo-Code diff --stat
```

Exit/count: 0; initial unstaged inventory.

```sh
git -C projects/Zoo-Code diff --cached --stat
```

Exit/count: 0; initial/final staged inventory: 51 paths, 7414 insertions, 158 deletions.

```sh
pnpm --dir projects/Zoo-Code/src exec vitest run core/task-persistence/__tests__/manualSupersedeB1.startupQuarantine.spec.ts core/task-persistence/__tests__/targetPersistenceBoundary.spec.ts core/task/__tests__/TaskScheduler.spec.ts core/task/__tests__/manualSupersedeB1.schedulerBypass.spec.ts core/task/__tests__/manualSupersedeB1.startGuard.spec.ts core/task/__tests__/Task.resume-eviction-race.spec.ts core/webview/__tests__/ClineProvider.pending-action.spec.ts core/webview/__tests__/manualSupersedeB1.providerStart.spec.ts --reporter=dot
```

Exit/count: 0; before edits: 8 suites / 64 tests.

```sh
pnpm --dir projects/Zoo-Code/src exec tsc --noEmit --pretty false
```

Exit/count: 0 before edits; final 0; intermediate 2 for fixture/wrapper types, corrected.

```sh
pnpm --dir projects/Zoo-Code/src exec vitest run core/task-persistence/__tests__/manualSupersedeB1.startupQuarantine.spec.ts core/task-persistence/__tests__/targetPersistenceBoundary.spec.ts core/task/__tests__/TaskScheduler.spec.ts core/task/__tests__/manualSupersedeB1.schedulerBypass.spec.ts core/task/__tests__/manualSupersedeB1.startGuard.spec.ts core/task/__tests__/Task.resume-eviction-race.spec.ts core/webview/__tests__/ClineProvider.pending-action.spec.ts core/webview/__tests__/manualSupersedeB1.providerStart.spec.ts core/webview/__tests__/manualSupersedeB1.providerFinalEffects.spec.ts core/task/__tests__/manualSupersedeB1.actualInstanceStart.spec.ts --reporter=dot
```

Exit/count: 0 final; 10 suites / 90 tests, including 1 explicit unsafe physical-rename witness; intermediate focused 1: 81 passed / 1 fixture failure, corrected.

```sh
pnpm --dir projects/Zoo-Code/src exec vitest run core/webview/__tests__/ClineProvider.lockApiConfig.spec.ts core/webview/__tests__/webviewMessageHandler.abandonSubtask.spec.ts core/task/__tests__/apiConversationHistory.spec.ts core/task/__tests__/Task.resume-eviction-race.spec.ts --reporter=default
```

Exit/count: 0; 4 suites / 12 tests.

```sh
pnpm --dir projects/Zoo-Code/src exec vitest run core/webview/__tests__/ClineProvider.lockApiConfig.spec.ts core/webview/__tests__/webviewMessageHandler.abandonSubtask.spec.ts core/task/__tests__/apiConversationHistory.spec.ts core/task/__tests__/Task.resume-eviction-race.spec.ts core/webview/__tests__/ClineProvider.spec.ts core/webview/__tests__/ClineProvider.flicker-free-cancel.spec.ts core/webview/__tests__/ClineProvider.taskHistory.spec.ts --reporter=default
```

Exit/count: 1; final 4 suites passed / 3 failed, 142 tests passed / 70 failed.

```sh
pnpm --dir projects/Zoo-Code/src exec eslint core/webview/ClineProvider.ts core/task/Task.ts core/task-persistence/targetPersistenceBoundary.ts core/webview/__tests__/manualSupersedeB1.providerStart.spec.ts core/webview/__tests__/manualSupersedeB1.providerFinalEffects.spec.ts core/task/__tests__/manualSupersedeB1.actualInstanceStart.spec.ts --prune-suppressions --max-warnings=0
```

Exit/count: initial 1 raw provider ID corrected; then 0; indentation-only generated suppression rewrite reverted.

```sh
pnpm --dir projects/Zoo-Code/src exec eslint core/webview/ClineProvider.ts core/task/Task.ts core/task-persistence/targetPersistenceBoundary.ts core/webview/__tests__/manualSupersedeB1.providerStart.spec.ts core/webview/__tests__/manualSupersedeB1.providerFinalEffects.spec.ts core/task/__tests__/manualSupersedeB1.actualInstanceStart.spec.ts --max-warnings=0
```

Exit/count: 0 final; no suppressions increased.

```sh
pnpm --dir projects/Zoo-Code exec prettier --check src/core/webview/ClineProvider.ts src/core/task/Task.ts src/core/task-persistence/targetPersistenceBoundary.ts src/core/webview/__tests__/manualSupersedeB1.providerStart.spec.ts src/core/webview/__tests__/manualSupersedeB1.providerFinalEffects.spec.ts src/core/task/__tests__/manualSupersedeB1.actualInstanceStart.spec.ts
```

Exit/count: 0 final; existing unknown-option warnings.

```sh
pnpm --dir projects/Zoo-Code lifecycle:model-check
```

Exit/count: 0 final; unsafe counterexamples below remain.

```sh
git -C projects/Zoo-Code diff --check
```

Exit/count: 0.

```sh
git -C projects/Zoo-Code diff --cached --check
```

Exit/count: 0.

```sh
git -C projects/Zoo-Code status --short --untracked-files=all
```

Exit/count: 0; final inventory, no staging.

Additional development runs: provider final-effect suite progressed from 11/12 (fault injected inside store rollback, corrected to after real store commit) to 12/12, 14/14, 16/16 and final 20/20 in the combined run. Actual-instance suite 6/6; preserved provider entry plus final-effect suite 18/18 at the earlier 14-test stage. Final focused total is baseline 64 plus 26 new tests, one of which intentionally asserts an unsafe counterexample rather than safety.

Model output retains unsafe #1469 stale child completion, #1021 stale live-task lineage save, and six legacy witnesses: start-before-commit, resume-before-permit-release, redelegate-before-permit-release, empty-publication, stale-concurrent-provider-commits, publication-releases-parent-transition. No B1 safety inference from model exit zero. Model code was not changed; this scoped implementation does not add a reducer transition or claim refinement for the disk fence.

Full monorepo tests/build, E2E, selected runtime adapter, conditional writer, B2, live-state/host/queue operation, deployment and Odoo runtime: [N/A], not run or enabled. Remaining ordinary mock failures and the unsafe physical-rename witness explicitly prevent PROVIDER_START_CLOSED.
