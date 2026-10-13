# Shutdown disposal and real-storage provider follow-up evidence

Date: 2026-10-06. STATUS=BLOCKED. WRITER=UNWIRED; ADAPTER=UNKNOWN; B1=BLOCKED; HOST=UNKNOWN.

The shutdown defect and all 21 previously reported provider failures are repaired/classified below. This is not an offline-stability acceptance: the repository full test run fails, the first full run crashed, and unsafe model/external-theft witnesses remain explicit. No B1/B2 enablement, selected-adapter proof, live-host operation, saved-state inspection/repair, staging, release or deployment was performed.

## Changed versus preserved scope

Existing paths changed by this follow-up:

- [Provider](../../src/core/webview/ClineProvider.ts:741): eviction owns each shutdown disposal; ordinary eviction still propagates disposal rejection by default. Shutdown continues only after resource cleanup rejection, revalidates ownership and persists delegated interruption before advancing. Typed fence refusal/ownership errors from abort or disposal remain fatal. Shutdown interruption-persistence errors propagate.
- [Provider regressions and disk-bearing fixtures](../../src/core/webview/__tests__/ClineProvider.spec.ts:1239): retained original rejection tests; added two delegated-child rejection cases, acquisition refusal, actual generation loss, two typed ownership cases, and interruption-write rejection. Settings-bearing MCP/telemetry/router roots and selected import/export YAML use fresh temporary storage, awaited initialization/disposal/removal. Inert extension identifiers were not indiscriminately rewritten. Missing/corrupt API tests seed authoritative per-task history; corrupt JSON is a real file.
- [History ordering and ordinary persistence](../../src/core/webview/__tests__/ClineProvider.taskHistory.spec.ts:415): non-running create/resume, history and task-message/API persistence, owned question set/clear, unrelated progress and deletion/readback. [Same-item ordering](../../src/core/webview/__tests__/ClineProvider.taskHistory.spec.ts:934) gates the first real writer entry before starting the second, retaining 222 in both cache and persisted file.
- [Real-store cancellation scenario](../../src/core/webview/__tests__/ClineProvider.flicker-free-cancel.spec.ts:578): installs an actual isolated store for this scenario only, preserving existing interaction tests. Parent remains delegated, child interrupted, lineage and unanswered question retained, user-cancel reason/abandonment truthful; no new task or scheduler call. Rehydration is a non-running seam.
- [Cleanup model](../../scripts/check-task-cleanup-protocol.ts:115) and [model documentation](../architecture/task-cleanup-protocol-model.md): count provider calls separately from memoized starts; represent post-disposal interruption, ownership loss and failed interruption persistence. Bounds unchanged: two tasks, depth 20, budget 100,000. Final: 96,174 reachable states, 20/20 actions, 11/11 landmarks.

New path: this evidence report. No other source/test/model path edited. [Task-level disposal controls](../../src/core/task/__tests__/Task.dispose.test.ts) remain byte-identical and pass 14/14; the boundary implicated was provider orchestration, not task memoization. No persisted lifecycle reducer change. The prior [stability evidence](./interrupted-create-handoff-manual-supersede-b1-normal-development-stability-evidence.md) is preserved byte-for-byte.

## Reproduction and concrete correction

Before edits, the exact provider group returned exit 1: 20 failed, 180 passed (200 total). Both real-root shutdown regressions failed:

1. Cleanup rejection escaped eviction before the outer cleanup handler, preventing remaining drain.
2. Abort rejection was logged but shutdown disposed the evicted first task again: expected one call, received two.

The prior report's 21st failure, unordered concurrent 111/222 history writes, did not fail in this fresh run. Concurrent invocation does not specify asynchronous exclusion/writer-entry order. The repaired test keeps both operations concurrently pending, first establishes the 111 writer-entry event, submits 222 while the first holds that entry, releases the gate, awaits both, and asserts persisted/cache 222. No production history ordering contract was changed and no last-write assertion was weakened.

Shutdown now uses one eviction per registry entry. Each eviction waits for abort, invokes provider disposal once, revalidates exclusion, and preserves delegated interruption. Resource cleanup rejection is logged and draining continues; acquisition/ownership or interruption-persistence failure rejects, does not drain later tasks, and is not reported as successful cleanup. Real-temp tests prove order, one call, parent/child readback and no construction/scheduler effects. No automatic retry or stale metadata restore occurs.

### All 21 prior failures, individually classified

Each row passes in the final exact 209-test provider run. Rows 1–20 were individually reproduced before edits; row 21 was intermittent in the previous evidence, passed the fresh baseline, and now has deterministic ordering plus disk assertion.

| #   | Test (suite when needed)                                                 | Classification / correction                                                                                                                                         |
| --- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | dispose continues draining tasks after cleanup rejects                   | Production shutdown failure window; eviction-owned cleanup handling and continued drain.                                                                            |
| 2   | dispose continues draining tasks after abort rejects                     | Production duplicate provider disposal; one eviction/disposal per entry.                                                                                            |
| 3   | covers all changed export-mode response paths                            | Fixture selected YAML reached actual disk at nonexistent virtual root; disposable selected file path.                                                               |
| 4   | covers all changed import-mode response paths                            | Fixture selected YAML absent on actual disk; seeded real YAML, all success/cancel/error assertions retained.                                                        |
| 5   | handles openProjectMcpSettings message                                   | Fixture settings/workspace paths reached disk; real root/workspace and existing mkdir/write/open assertions retained.                                               |
| 6   | handles openProjectMcpSettings when workspace is not open                | Fixture constructor settings root failed before scenario; real root and awaited initialization/cleanup.                                                             |
| 7   | handles openProjectMcpSettings file creation error                       | Same constructor fixture failure; real root, original injected mkdir rejection retained.                                                                            |
| 8   | includes basic properties in telemetry                                   | Fixture constructor attempted virtual settings root; isolated real root.                                                                                            |
| 9   | includes cloud authentication property when user is authenticated        | Same disk-bearing telemetry setup root; original property assertion retained.                                                                                       |
| 10  | includes cloud authentication property when user is not authenticated    | Same setup root; original negative property assertion retained.                                                                                                     |
| 11  | handles CloudService errors gracefully                                   | Same setup root; scoped throwing mock restored before newly awaited provider teardown.                                                                              |
| 12  | handles CloudService method errors gracefully                            | Same setup root; original method-error assertion retained.                                                                                                          |
| 13  | handles requestRouterModels with successful responses                    | Fixture constructor settings root; real root, mocked fetchers only, existing response assertions retained.                                                          |
| 14  | handles requestRouterModels with individual provider failures            | Same setup root; original per-provider rejection preserved.                                                                                                         |
| 15  | handles requestRouterModels with LiteLLM values from message             | Same setup root; message-value assertions retained.                                                                                                                 |
| 16  | skips LiteLLM when neither config nor message values are provided        | Same setup root; no-call assertion retained.                                                                                                                        |
| 17  | handles requestLmStudioModels with proper response                       | Same setup root; mocked model response, no actual request.                                                                                                          |
| 18  | includes model ID from current Cline instance if available               | Fixture realpath authority refused virtual storage; real temp root, current-task model assertion retained.                                                          |
| 19  | returns empty apiConversationHistory when file is missing                | Fixture seeded already-migrated legacy history instead of authoritative store; real persisted history seeded, missing API retained, no deletion assertion retained. |
| 20  | returns empty apiConversationHistory when file contains invalid JSON     | Same authority seeding problem; real corrupt API file, original empty-history/no-deletion assertions retained.                                                      |
| 21  | serializes concurrent updates to the same item preserving the last write | Unspecified fixture completion order, not a demonstrated production last-write defect; deterministic writer entry and persisted 222.                                |

No virtual disk-authority fallback, disabled assertions, timeout inflation, sleeps or skipped ordinary test was introduced. Existing temporary roots and assertions remain. Two temporary teardown failures during implementation were fixed by awaiting actual initialization and restoring the scenario-specific cloud mock; retries were not used to disguise incomplete initialization.

## Ordinary scenario coverage and limits

- Create/resume: actual provider entry points with non-running Task constructor doubles, start disabled; no scheduler call. Store initialization and canonical real-root exclusions are real. History, task messages and API messages are physically written/read back, then provider deletion removes the task directory (including task/API files) and authoritative store entry.
- Delegation: existing real-disk final-effects controls at [five handoff stages](../../src/core/webview/__tests__/manualSupersedeB1.providerFinalEffects.spec.ts:168) plus current provider parent/child shutdown interruption tests. Handoff controls use non-running structural tasks and scheduler spies. They prove persisted delegation/publication guard behavior, not executing a model child.
- Cancel: new real-store scenario asserts interruption/lineage/parent ownership/question retention and truthful cancellation; existing flicker-free interaction/error assertions still run.
- Questions: production register/clear reducers through the owned store question writer, disk assertions, another parent/question progressing concurrently with unrelated history metrics. Generic interruption intentionally retains unanswered question evidence, per [pending-question contract](../architecture/task-lifecycle-model.md:222). An initial new assertion expecting cancel to clear it failed; direct reducer/documentation evidence established retention is required, so the test was corrected to assert exact retained question and no fabricated answer, not to hide a defect. Explicit owned clear removes the question; task deletion removes the target files without disturbing the unrelated task.
- No actual Task run, model request, queue execution, network request or live-state access in the new ordinary scenarios. Non-running doubles and disabled scheduler paths delimit coverage; this is not loaded-extension-host proof. Existing required offline boundary/start controls exercise bounded guarded callbacks, not an operator/live queue.
- Final exact ordinary groups: persistence 48/48; providers 209/209 (168 provider + 14 cancel + 27 history). Focused task boundary control: 14/14 unchanged task-disposal tests. Expanded provider/task-disposal invocation: 223/223. Startup/persistence boundary group: 99/99. Scheduler/start/provider guard group: 83/83. These totals are per invocation, not additive unique-test claims across overlapping runs.

## Exact verification commands, exits and counts

Commands below were executed from workspace root. Captured logs are disposable /tmp artifacts, not live saved state. Underlying exits are recorded independently of enclosing shell success.

```sh
git -C projects/Zoo-Code status --short --untracked-files=all
```

Exit/result: 0 initial/final; inventory below.

```sh
git -C projects/Zoo-Code diff --stat
```

Exit/result: 0 initial/final; contains preserved earlier work as well as this follow-up.

```sh
git -C projects/Zoo-Code diff --cached --stat
```

Exit/result: 0 initial/final; identical 51 staged paths, 7,414 insertions / 158 deletions.

```sh
pnpm --dir projects/Zoo-Code/src exec vitest run core/task-persistence/__tests__/TaskHistoryStore.realConcurrency.spec.ts core/task-persistence/__tests__/TaskHistoryStore.spec.ts core/task-persistence/__tests__/apiMessages.spec.ts --reporter=default
```

Exit/result: 0 initial and final; 48 passed / 3 suites.

```sh
pnpm --dir projects/Zoo-Code/src exec vitest run core/webview/__tests__/ClineProvider.spec.ts core/webview/__tests__/ClineProvider.flicker-free-cancel.spec.ts core/webview/__tests__/ClineProvider.taskHistory.spec.ts --reporter=default
```

Exit/result: 1 baseline: 20 failed / 180 passed; 1 intermediate: 2 failed / 202 passed; 1 intermediate: 2 failed / 204 passed; 0 later: 206 passed; 0 final exact: 209 passed / 3 suites.

```sh
pnpm --dir projects/Zoo-Code/src exec tsc --noEmit --pretty false
```

Exit/result: 0 baseline; 2 intermediate for two newly seeded incomplete fixture records; 0 after correction and final.

```sh
pnpm --dir projects/Zoo-Code/src exec vitest run core/task-persistence/__tests__/manualSupersedeB1.startupEffects.spec.ts core/task-persistence/__tests__/manualSupersedeB1.startupQuarantine.spec.ts core/task-persistence/__tests__/targetPersistenceBoundary.spec.ts core/task-persistence/__tests__/taskLifecycle.spec.ts utils/__tests__/safeWriteJson.test.ts --reporter=default
```

Exit/result: 0; 99 passed / 5 suites.

```sh
pnpm --dir projects/Zoo-Code/src exec vitest run core/task/__tests__/TaskScheduler.spec.ts core/task/__tests__/manualSupersedeB1.schedulerBypass.spec.ts core/task/__tests__/manualSupersedeB1.startGuard.spec.ts core/task/__tests__/manualSupersedeB1.actualInstanceStart.spec.ts core/task/__tests__/Task.resume-eviction-race.spec.ts core/task/__tests__/apiConversationHistory.spec.ts core/webview/__tests__/manualSupersedeB1.providerStart.spec.ts core/webview/__tests__/manualSupersedeB1.providerFinalEffects.spec.ts core/webview/__tests__/ClineProvider.pending-action.spec.ts core/webview/__tests__/ClineProvider.lockApiConfig.spec.ts core/webview/__tests__/webviewMessageHandler.abandonSubtask.spec.ts --reporter=default
```

Exit/result: 0; 83 passed / 11 suites, including explicit unsafe external-theft witness.

```sh
pnpm --dir projects/Zoo-Code/src exec vitest run core/webview/__tests__/ClineProvider.taskHistory.spec.ts core/webview/__tests__/ClineProvider.flicker-free-cancel.spec.ts -t 'ordinary non-running|real-disk cancel' --reporter=default
```

Exit/result: 1 intermediate: 1 passed / 1 failed / 39 filtered tests; failed expectation was inconsistent with required question retention; full unfiltered final group passes.

```sh
pnpm --dir projects/Zoo-Code/src exec vitest run core/webview/__tests__/ClineProvider.spec.ts core/webview/__tests__/ClineProvider.flicker-free-cancel.spec.ts core/webview/__tests__/ClineProvider.taskHistory.spec.ts core/task/__tests__/Task.dispose.test.ts --reporter=default
```

Exit/result: 0; 223 passed / 4 suites.

```sh
pnpm --dir projects/Zoo-Code/src exec eslint core/task-persistence/__tests__/TaskHistoryStore.realConcurrency.spec.ts core/webview/ClineProvider.ts core/webview/__tests__/ClineProvider.spec.ts core/webview/__tests__/ClineProvider.flicker-free-cancel.spec.ts core/webview/__tests__/ClineProvider.taskHistory.spec.ts --max-warnings=0
```

Exit/result: 0.

```sh
pnpm --dir projects/Zoo-Code exec eslint scripts/check-task-cleanup-protocol.ts --max-warnings=0
```

Exit/result: 2; no root ESLint config.

```sh
pnpm --dir projects/Zoo-Code/src exec eslint ../scripts/check-task-cleanup-protocol.ts --no-warn-ignored --max-warnings=0
```

Exit/result: 0 but not relied on as script lint proof; explicit config check follows.

```sh
pnpm --dir projects/Zoo-Code exec eslint --config src/eslint.config.mjs scripts/check-task-cleanup-protocol.ts --max-warnings=0
```

Exit/result: 0; actual explicit-config script lint.

```sh
pnpm --dir projects/Zoo-Code cleanup-protocol:model-check
```

Exit/result: 0 intermediate: 91,764 states / 19 actions / 10 landmarks; 0 final: 96,174 states / 20 actions / 11 landmarks.

```sh
pnpm --dir projects/Zoo-Code lifecycle:model-check
```

Exit/result: 0 twice; final cleanup child model 96,174 states; other model counts below; unsafe witnesses retained.

```sh
pnpm --dir projects/Zoo-Code build
```

Exit/result: 0 twice; 4 successful tasks / 4 cached; exact prescribed Turbo build, not extension-host loading or extension bundle proof.

```sh
pnpm --dir projects/Zoo-Code test
```

Exit/result: 139 first run: two types tests failed and segmentation fault; 1 final run: types 2 failed / 436 passed / 30 suites; Turbo 8 successful / 13 total, 7 cached, aborts on types failure; no complete full-suite count claimed.

```sh
git -C projects/Zoo-Code diff --check
```

Exit/result: 0 repeatedly, final after report.

```sh
git -C projects/Zoo-Code diff --cached --check
```

Exit/result: 0, final after report.

```sh
git -C projects/Zoo-Code ls-files --stage
```

Exit/result: 0; semantic entries preserved.

```sh
git -C projects/Zoo-Code diff HEAD -- src/eslint-suppressions.json
```

Exit/result: 0 empty; no suppression count increase.

Exact final expanded formatting check (exit 0, unknown-option warnings only):

```sh
pnpm --dir projects/Zoo-Code exec prettier --check src/core/task-persistence/__tests__/TaskHistoryStore.realConcurrency.spec.ts src/core/webview/ClineProvider.ts src/core/webview/__tests__/ClineProvider.spec.ts src/core/webview/__tests__/ClineProvider.flicker-free-cancel.spec.ts src/core/webview/__tests__/ClineProvider.taskHistory.spec.ts scripts/check-task-cleanup-protocol.ts docs/architecture/task-cleanup-protocol-model.md docs/implementation/interrupted-create-handoff-manual-supersede-b1-shutdown-provider-follow-up-evidence.md
```

Formatting writes were restricted to the six authorized changed paths and this report. The unchanged real-concurrency fixture was checked, not reformatted. Suppression pruning: [N/A], repository instruction would permit rewriting an out-of-scope suppression file; no additional suppression edit authorized. Existing suppression file remains identical to HEAD (SHA-256 77d9775e328842cdb87885bd2eefb8e497d9e7133b3be7fe84d4eb4ddf1a461c). No suppression count increase.

## Inventory preservation

Initial fresh project inventory: 51 staged paths, 16 unstaged tracked paths, 14 untracked paths. Final: 51 staged paths, 18 unstaged tracked paths (two model paths added), 15 untracked paths (this report added). The four provider paths were already unstaged; earlier changes there were retained and extended. Every inventoried preexisting file outside those four paths is byte-identical to the initial SHA-256 snapshot, including the prior evidence report and all earlier persistence/scaffold work. Only the two previously clean authorized model paths and this new report were added to that existing dirty inventory.

Index byte hash was initially 3b9d5ae1069561aa0cefe6965239c71a932d6012950a36a19096e88b95332797 and remained identical after code/test/build execution before final Git refresh. Later Git status refresh changed stat-cache bytes (44ad5b9e6bc4e51d40e0bda449225a86ccf6609de755df46cae0ccb1a05f3fe1), not staged content. Semantic stage-entry SHA-256 a018021bf6bba7ca3d0f61aebb43346a517bd40996687a07398f60382afefc12 is unchanged across final checks; staged diff/stat are unchanged. No staging/reset/checkout/restoration operation executed.

Workspace root itself is not a Git repository (initial exploratory root status returned fatal/128); all actual inventory/checks used the project repository. This is not a provider/test failure.

## Model and remaining blockers

The umbrella passes mechanically but is not production safety acceptance:

- Persisted lifecycle: 89 states, 5/5 actions, 4/4 landmarks.
- Shared store: 625 states, 6 scenarios, 6 invariants, 7/7 phases, 3/3 landmarks. **Unsafe #1469**: stale child completion clears a newer parent handoff. **Unsafe #1021**: stale live-task save reattaches abandoned lineage. Both remain unmodified and are not reclassified as safe by exit zero.
- Provider/scheduler: 104 states, 10/10 actions, 12/12 landmarks, 6/6 legacy counterexamples; these retained witnesses are not current universal production proof.
- Cleanup: 96,174 states, 20/20 actions, 11/11 landmarks; no depth/budget inflation.
- Parser: 924/924 schedules, 6/6 actions, 8/8 landmarks; completion persistence 88 states, 12/12 actions, 7/7 landmarks; delegated-mode reader 4 divergent pairs and 5 built-in modes; pending questions 7 states.
- [External-theft negative witness](../../src/core/webview/__tests__/manualSupersedeB1.providerFinalEffects.spec.ts:498) passes because it observes possible unsafe syscall-time commit and refuses enqueue. It is UNKNOWN/BLOCKED, never B1 acceptance. Cooperative exclusion does not fence arbitrary external actors.

The two full-test failures are [types-package model metadata assertions](../../packages/types/src/__tests__/openai-models.test.ts:50) and [subscription contract assertions](../../packages/types/src/__tests__/openai-models.test.ts:166), comparing static descriptions/context against [native metadata](../../packages/types/src/providers/openai.ts:61) and [subscription metadata](../../packages/types/src/providers/openai-codex.ts:40). No provider/storage cleanup call path is exercised by these assertions. They are concretely separate from the repaired provider failures, but the full script still fails and the first run crashed; no claim of a completed green repository test. No out-of-scope metadata edits made. Resolve expected-versus-production model contract with the owner before requesting exact repair scope; do not blindly change assertions.

REMAINING=full test failures/incomplete repository proof, unresolved unsafe #1469/#1021 and external-theft safety limits, unknown loaded host and selected adapter. No remaining failure in the affected ordinary groups, no persisted reducer change required for this shutdown fix. The task-level boundary is unchanged. A broad ordinary safety claim remains BLOCKED rather than hiding known safety witnesses or treating cached build as host proof.

NEXT=parent independently review the bounded provider/model fix; separately determine and authorize exact metadata repair and any persisted reducer/concurrency-model work needed for #1469/#1021 (the current task did not grant those paths), then rerun full tests and the offline gate. Preserve the external-theft witness and keep B1 writer unwired. Host smoke, selected live adapter, saved state, B2, queue/child/model/network operation, staging, release and deployment: [N/A], not authorized; do not infer readiness or live safety.
