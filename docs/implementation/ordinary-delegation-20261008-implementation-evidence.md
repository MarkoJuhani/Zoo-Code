# Ordinary delegation — consolidated implementation evidence

Contract: ZOO-ORDINARY-DELEGATION-20261008. Date: 2026-10-08. OFFLINE_ONLY.

**OFFLINE_ORDINARY_VIABLE_WITH_LIMITS** applies only to the tested participating ordinary runtime paths. Production readiness is NOT established: the complete root run remains red, the final continuation/fixture changes have no second full-root run, and loaded-build/real-host parity is UNKNOWN.

## 1. Delivered implementation and acceptance boundary

- D1: actual scheduler + constructed Task + native presenter/tool + provider + disposable disk store reproduced expired inherited ownership before the fix. Joined capable descendants now retain the owner through final abort/disposal and publication, even after the original loop settles.
- D2: ordinary startup/history orchestration and fresh/saved-question idle waits are phase-separated. External answer durability and continuation reacquire exact immutable revision/lineage/question authority. Arbitrary supplied callbacks retain last-effect protection and refuse protected idle waits.
- Recovery: pre-child teardown failure restores a stopped, focused parent only under exact authoritative action/question/lineage/revision and live generation. Restoration includes the last state effect. Unknown or moved authority retains evidence; durable child bytes are not deleted.
- D3: one bounded provider/tool/scheduler diagnostic attempt routes to Zoo output; IDs, hashed owner correlation, generation, active state, elapsed phase and allow-listed typed failures are safe. Enqueue/provider return do not imply admitted/started/success. Throwing observers do not affect outcome/permits.
- Separate current completion: reproduced old transcript/result publication against a newer native delegation call before eventual ownership-moved refusal. Cooperative parent/child ancestry ownership now precedes authoritative admission and transcript effects, remaining through final parent publication. Finite current-path proof, not universal #1469 closure.
- Additional actual ordinary blocker found during parent review: post-child custom-runner continuation still held a fence through its model loop. The new prepared-resume contract retains transition/ownership through exact synchronous invocation, then waits for the Task-owned loop outside the capable scope. Real external question answers, cancellation gaps and permit release are tested.

Detailed units (including their retained interim failures):

- [ordinary-completion-20261008-refinement-evidence.md](ordinary-completion-20261008-refinement-evidence.md:1)
- [ordinary-delegation-20261008-fixture-evidence.md](ordinary-delegation-20261008-fixture-evidence.md:1)
- [ordinary-delegation-20261008-phase-evidence.md](ordinary-delegation-20261008-phase-evidence.md:1)
- [ordinary-delegation-20261008-provider-evidence.md](ordinary-delegation-20261008-provider-evidence.md:1)
- [ordinary-delegation-20261008-root-followup-evidence.md](ordinary-delegation-20261008-root-followup-evidence.md:1)
- [ordinary-delegation-20261008-continuation-evidence.md](ordinary-delegation-20261008-continuation-evidence.md:1)
- [`ordinary-delegation-20261008-parent-fence-timeout-evidence.md`](ordinary-delegation-20261008-parent-fence-timeout-evidence.md:1)

## 2. Pre-fix failures are proof obligations, not exclusions

“Failed against unchanged production before the fix” means the newly added regression exposed an actual existing defect, then passed after the specific repair. It does not waive that defect or classify it as pre-existing/acceptable. Every selected failed case stays in its evidence unit. Narrow passing results do not erase the complete root failure register.

D1 corrected pre-fix composition: 3 failed / 0 passed, exit 1; one recovery-status fixture mismatch is separately disclosed. Provider integration pre-fix: 7 failed / 29 passed, exit 1. Separate completion initially: 4 passed / 1 failed, with two unsuppressed transcript safety assertions. Post-child actual pre-fix: 1 selected failed / 21 selection-skips, exit 1; removing the adjacent synchronous live-instance check in a disposable negative control also fails its intended regression.

Final parent union initially found one obsolete restart scheduler-capture assumption after the prepared entry changed: 469 passed / 1 failed, exit 1, no unhandled errors. The fixture treated the typed prepared entry as a function. Parent changed only its capture adapter to execute the actual scheduler; real loop/persistence/result/next-delegation assertions remained. The final same selection then passed 470/470. Both command/output records are retained.

## 3. Exact current verification and source provenance

All project executable verification ran in physically independent disposable source/dependency copies, Node 22.23.1, isolated HOME/config/cache/temp/pnpm directories, installed dependencies/pnpm reused without installation and network denial. Source reads/edits, Git inspection and document generation ran at the active workspace. No real tasks/profiles/queues, model/API requests, host launch/restart, lock repair/delete, B1/B2, release or deployment.

Parent copy validation: 98,434 regular files / 5,499 links / 2,954 source hashes; no shared active/template inodes, escaping links or source mismatches. [copy-validation.json](../../../../../../../tmp/zoo-ordinary-final-20261008-tqm1mn2l/copy-validation.json:1). The continuation final copy has its separate validation in the linked continuation report. Exact environment: [verification-env.json](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/verification-env.json:1).

| Lane                                                                 | Result                                                        | Provenance                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Latest parent combined focused selection                             | **470 tests / 20 files passed; exit 0; no unhandled section** | [parent-final-union-repaired.command.json](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/parent-final-union-repaired.command.json:1); [parent-final-union-repaired.output.txt](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/parent-final-union-repaired.output.txt:1) |
| Latest source types after final restart adapter                      | Exit 0, no diagnostics                                        | [parent-restart-types.command.json](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/parent-restart-types.command.json:1)                                                                                                                                                                        |
| Latest restart adapter lint / format                                 | Each exit 0                                                   | [parent-restart-lint.command.json](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/parent-restart-lint.command.json:1); [parent-restart-format.command.json](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/parent-restart-format.command.json:1)                         |
| Latest continuation source/public types, touched lint/format         | All exit 0                                                    | [continuation-accepted-ledger.json](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/continuation-accepted-ledger.json:1)                                                                                                                                                                        |
| All eight declared model stages after continuation                   | All exit 0, original bounds/witnesses unchanged               | [continuation-accepted-ledger.json](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/continuation-accepted-ledger.json:1)                                                                                                                                                                        |
| Complete parent root attempt before localized follow-up/continuation | Exit 1; finished in 740.83 s, below 1,800 s bound             | [root-test.command.json](../../../../../../../tmp/zoo-ordinary-final-20261008-tqm1mn2l/root-test.command.json:1)                                                                                                                                                                                                     |

Counts overlap; 340, 458, 390 and 470 passing selections are NOT additive. Final parent selection is the union of the relevant focused lanes. Final source hashes: [parent-union-source.json](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/parent-union-source.json:1).

Exact final focused command; cwd /tmp/zoo-ordinary-continuation-20261008-yucnn1hj/Zoo-Code/src:

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-ordinary-continuation-20261008-yucnn1hj/Zoo-Code/src/node_modules/vitest/vitest.mjs run core/task/__tests__/ordinaryDelegationComposition.spec.ts core/task/__tests__/TaskScheduler.spec.ts core/task/__tests__/Task.spec.ts core/task/__tests__/providerHandoff.spec.ts core/task/__tests__/pending-question.spec.ts core/task/__tests__/ordinaryPersistenceOwnership.spec.ts core/task/__tests__/manualSupersedeB1.startGuard.spec.ts core/task/__tests__/manualSupersedeB1.actualInstanceStart.spec.ts core/webview/__tests__/ordinaryCompletionOwnership.spec.ts __tests__/ClineProvider.delegation.spec.ts __tests__/ClineProvider.history-resume-delegation.spec.ts __tests__/delegation-concurrent.spec.ts __tests__/nested-delegation-resume.spec.ts __tests__/delegation-handoff-robustness.spec.ts core/tools/__tests__/newTaskTool.spec.ts core/webview/__tests__/ordinaryAbandonmentPersistence.spec.ts core/task-persistence/__tests__/taskLifecycle.spec.ts core/webview/__tests__/manualSupersedeB1.providerStart.spec.ts core/webview/__tests__/manualSupersedeB1.providerFinalEffects.spec.ts __tests__/delegation-restart-persistence.integration.spec.ts --maxWorkers=1 --reporter=default
```

Exact source-type command at the same cwd:

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-ordinary-continuation-20261008-yucnn1hj/Zoo-Code/node_modules/typescript/bin/tsc --noEmit --pretty false
```

Exact root wrapper; cwd /tmp/zoo-ordinary-final-20261008-tqm1mn2l/Zoo-Code:

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-ordinary-final-20261008-tqm1mn2l/pnpm/bin/pnpm.cjs test --force --continue=dependencies-successful --concurrency=2
```

The root script already supplies its output-log option; no duplicate option was passed. Force, dependency-successful continuation and concurrency two were explicit. Root output remained disposable. [root-test.output.txt](../../../../../../../tmp/zoo-ordinary-final-20261008-tqm1mn2l/root-test.output.txt:1).

Exact public-type/lint/format/model invocations and cwd/runtime/exits are enumerated in [continuation verification](ordinary-delegation-20261008-continuation-evidence.md:54) and [parent-verification-ledger.json](../../../../../../../tmp/zoo-ordinary-final-20261008-tqm1mn2l/parent-verification-ledger.json:1). No unqualified broad/default-concurrency claim follows.

## 4. Complete root failure disposition — retained

| Root lane    | Files                              | Tests                                  |
| ------------ | ---------------------------------- | -------------------------------------- |
| Extension    | 20 failed / 499 passed / 4 skipped | 108 failed / 9,657 passed / 39 skipped |
| Webview      | 164 passed                         | 1,895 passed                           |
| Core         | 15 passed                          | 149 passed                             |
| Types        | 30 passed                          | 441 passed                             |
| CLI          | 38 passed / 1 skipped              | 565 passed / 1 skipped                 |
| Cloud        | 11 passed                          | 247 passed                             |
| Telemetry    | 4 passed                           | 49 passed                              |
| VS Code shim | 22 passed                          | 407 passed                             |

Outer Turbo: 12 successful / 13, zero cached / 13, extension failed, exit 1. Prerequisites completed; no failed-dependency block or termination at the bound. No reported unhandled-error section or SIGSEGV/signal-11/exit-139 marker. Prior Bash signal-11 attribution remains UNKNOWN; this is not live-host crash-safety proof.

All 108 original failed identities remain in [root-failures.json](../../../../../../../tmp/zoo-ordinary-final-20261008-tqm1mn2l/root-failures.json:1) and are materialized in [root follow-up evidence](ordinary-delegation-20261008-root-followup-evidence.md:196). Follow-up specifically repaired 32 of those cases (two short polling seams and 30 obsolete delegation fixtures/error expectations). The arithmetic remainder is 76 failures across 13 unaddressed files, NOT a measured final full-root result. No blanket pre-existing classification is made.

Unaddressed root files (inventoried, not accepted):

- [**tests**/queue-lifecycle-composed.spec.ts](../../src/__tests__/queue-lifecycle-composed.spec.ts:1): 4 retained root failures.
- [**tests**/removeClineFromStack-delegation.spec.ts](../../src/__tests__/removeClineFromStack-delegation.spec.ts:1): 3 retained root failures.
- [**tests**/single-open-invariant.spec.ts](../../src/__tests__/single-open-invariant.spec.ts:1): 6 retained root failures.
- [core/assistant-message/**tests**/presentAssistantMessage-images.spec.ts](../../src/core/assistant-message/__tests__/presentAssistantMessage-images.spec.ts:1): 1 retained root failures.
- [core/task/**tests**/Task.pending-action.spec.ts](../../src/core/task/__tests__/Task.pending-action.spec.ts:1): 2 retained root failures.
- [core/task/**tests**/Task.throttle.test.ts](../../src/core/task/__tests__/Task.throttle.test.ts:1): 6 retained root failures.
- [core/task-persistence/**tests**/TaskHistoryStore.reconciliation.spec.ts](../../src/core/task-persistence/__tests__/TaskHistoryStore.reconciliation.spec.ts:1): 7 retained root failures.
- [core/task-persistence/**tests**/interruptedCreateHandoffDisk.spec.ts](../../src/core/task-persistence/__tests__/interruptedCreateHandoffDisk.spec.ts:1): 1 retained root failures.
- [core/task-persistence/**tests**/manualSupersedeB1.bypass.spec.ts](../../src/core/task-persistence/__tests__/manualSupersedeB1.bypass.spec.ts:1): 2 retained root failures.
- [core/webview/**tests**/ClineProvider.apiHandlerRebuild.spec.ts](../../src/core/webview/__tests__/ClineProvider.apiHandlerRebuild.spec.ts:1): 9 retained root failures.
- [core/webview/**tests**/ClineProvider.sticky-mode.spec.ts](../../src/core/webview/__tests__/ClineProvider.sticky-mode.spec.ts:1): 19 retained root failures.
- [core/webview/**tests**/ClineProvider.sticky-profile.spec.ts](../../src/core/webview/__tests__/ClineProvider.sticky-profile.spec.ts:1): 15 retained root failures.
- [api/providers/fetchers/**tests**/openrouter.spec.ts](../../src/api/providers/fetchers/__tests__/openrouter.spec.ts:1): 1 retained root failures.

Second full-root run: **[N/A]**. The requested one complete attempt is preserved; localized repairs and the later continuation change were verified with bounded focused/static/model checks instead of rerunning until green. The earlier phase child also attempted a root run that hit its 480-second bound and was terminated; that incomplete execution/deviation remains in the phase evidence and does not count as a complete root result.

## 5. Preservation, reviewed paths and uncovered work

Original HEAD e18f931de70282a05c02fc5592e61b71c339a91f; branch weak_model_runtime_hardening. Initial 51 staged / 35 unstaged / 19 untracked / 98 distinct paths. Final 51 staged / 42 unstaged / 28 untracked / 114 distinct paths (overlapping counts). Original dirty working bytes—not HEAD replacements—were the implementation baseline. Baseline snapshot: [baseline.json](../../../../../../../tmp/zoo-ordinary-delegation-20261008-atop1b3v/baseline.json:1). Original 2,948 regular source hashes and six link targets were captured before edits.

Semantic index mode/object/stage bytes remain exact; SHA-256 56ec157367711932aaf1a7b16d3693940944ce64a75245d6965c0ad7086cda91. No stage/reset/clean/restore. The earlier ordinary evidence report is unchanged. Suppression ledger bytes remain exact. All baseline files outside the enumerated 14 authorized changed paths retain their hashes; no baseline path is missing. New files are two corresponding tests and seven additive implementation documents including this report. All unrelated dirty paths are provenance-checked, not semantically accepted.

| Authorized existing path                                                                                                                                       | Baseline SHA-256                                                 | Final SHA-256                                                    | Incremental + / − |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------- |
| [docs/architecture/task-lifecycle-model.md](../architecture/task-lifecycle-model.md:1)                                                                         | 4558b00da20fb280874045982bc6ca5ed84b04bb25583594b5b3db8939eaed4f | 9cd0cb95bca317e9ded01e5e01dfe9e883fc9620e33aa646cac0b3a334f0ad98 | 10 / 0            |
| [src/**tests**/ClineProvider.delegation.spec.ts](../../src/__tests__/ClineProvider.delegation.spec.ts:1)                                                       | 9f816ca2b7900c4e79a9668a9dade46343e58b08ebec0642acde80f55f0cfb5a | 6234d2378581bdc3104ce7b8a62b05277d3b8d8c085662da0ede6f86403f2378 | 152 / 45          |
| [src/**tests**/ClineProvider.history-resume-delegation.spec.ts](../../src/__tests__/ClineProvider.history-resume-delegation.spec.ts:1)                         | 59d488c6ecf8e88341b4c94d064aae0452d7aa8b8111ff180562aa2f74165744 | 6619b7498c605b4c18e7e6d162cb8ca4f79ef409a64dace4800a4779bd13174c | 40 / 18           |
| [src/**tests**/delegation-concurrent.spec.ts](../../src/__tests__/delegation-concurrent.spec.ts:1)                                                             | e5679bb0b281e1c8befbf8eb2964793ee8c883ccc4a5bcd20c716b7a676f996e | f77904e34b63a80e7440b8c2f66486c9d0493569d5927bf49030833e203f6847 | 26 / 42           |
| [src/**tests**/delegation-handoff-robustness.spec.ts](../../src/__tests__/delegation-handoff-robustness.spec.ts:1)                                             | 7ec4f28417e83df2e770b3cd11c36127123159ebf04a79d7f6c33afcbe68fee2 | d71da11f17f024117cd54c219d699f37e1cc2c3298f6ace32b510d4de0fa4311 | 14 / 1            |
| [src/**tests**/delegation-restart-persistence.integration.spec.ts](../../src/__tests__/delegation-restart-persistence.integration.spec.ts:1)                   | e4f71f913b1109f0e78f95b84abd34a1605c0f30d9f23e59637ad63b9c7d9b94 | ba5c97f9d3f5d4a2f63c9d057125119d3bafbd2eec3b50fa4dfca9ba1632ea34 | 31 / 12           |
| [src/core/task-persistence/targetPersistenceBoundary.ts](../../src/core/task-persistence/targetPersistenceBoundary.ts:1)                                       | 02ff3b9ce61da358d45a9a97512398faa2156bb0bcedbd58aa4bcadabbeb6805 | d46b0d6be2ce6b6c1e6b18e832856c59e656c9ba85f73e5bcc8c80fff27e8367 | 74 / 9            |
| [src/core/task/Task.ts](../../src/core/task/Task.ts:1)                                                                                                         | 9cc8e867314c5c6843e0db8d08f58192ea69606f542bc0948aa6f4cb292ef55f | d53c5a290eee0a1d0fb9b370f732a56c010d6b8fbbee6482bcde542b756f06e0 | 142 / 45          |
| [src/core/task/TaskScheduler.ts](../../src/core/task/TaskScheduler.ts:1)                                                                                       | 6a6b5051d69d124f473e125b48db6e3cd7484a1a88e2271df97cc59849121fd6 | dee317580e90e1065d4ebbc45411ceaf78f52aff3d01c84b17201a43f9fcbf9f | 35 / 3            |
| [src/core/task/**tests**/Task.spec.ts](../../src/core/task/__tests__/Task.spec.ts:1)                                                                           | f93ed6e3cc25208caa6375b63d08fe9943c273fdc5bf111d2f93fb735a9f630c | 740cfc880147582702c70b8b503c427b7996e34420cf9fd63c3b79dcab628803 | 56 / 2            |
| [src/core/tools/NewTaskTool.ts](../../src/core/tools/NewTaskTool.ts:1)                                                                                         | 22292d0bb1d2b4e4e8674c691bbce63b087f9a91fdb8b46afb1122419bb8e510 | 228edb31c00c36ab32efee25595ac1ae6608317dcef79389e5b6e65951b08b45 | 14 / 9            |
| [src/core/webview/ClineProvider.ts](../../src/core/webview/ClineProvider.ts:1)                                                                                 | 62d438b98de7264ecfabc38b1cffe6dce569cd7593476774408db8c2c8fb91b8 | 8f3272329e3460c50922dfa53c7706d57a9efd33cb077dfae7c7707bf6133a7e | 1044 / 746        |
| [src/core/webview/**tests**/manualSupersedeB1.providerFinalEffects.spec.ts](../../src/core/webview/__tests__/manualSupersedeB1.providerFinalEffects.spec.ts:1) | 2c9d24f8d7c12c0dc4f1abb94b13e269e797af101055a88f2dbc88041fb18bdd | a6cab971cd4a1891c57b5e1cb5d7f8c01e68ff8f7e3b39383dccf1c2c1ebfc97 | 87 / 29           |
| [src/core/webview/**tests**/manualSupersedeB1.providerStart.spec.ts](../../src/core/webview/__tests__/manualSupersedeB1.providerStart.spec.ts:1)               | e510e89cd448139245445565b15408fe4c01c3b355638f3033ed6ceaa8b3be90 | 88105abddc9f2aa47658df65dfc3bd92a921b5fdcd64c4ff278b812818234d8f | 1 / 0             |

Each incremental patch is retained under [incremental-final](../../../../../../../tmp/zoo-ordinary-delegation-20261008-atop1b3v/incremental-final:1); hashes and final inventory are in [parent-final-preservation.json](../../../../../../../tmp/zoo-ordinary-delegation-20261008-atop1b3v/parent-final-preservation.json:1). Provider wrapper reindentation accounts for many completion diff lines; the separate ownership mapping in the provider evidence distinguishes completion from ordinary delegation diagnostics. Store/reducers/checkers, API/providers/types, webview production and remaining recovery/B1 utilities were not rewritten.

Two ignored generated distribution artifacts changed during child work; the agents did not write or restore them. Their producer and loaded/current-source parity remain UNKNOWN. Tracked/untracked source and semantic-index preservation is independently verified; ignored installation/build artifact immutability is not claimed.

## 6. Historical witnesses and partial effects

Retained exact unsafe historical #1469 witness:

> complete-a.read → complete-a.prepare → redelegate-b.read → redelegate-b.prepare → redelegate-b.revalidate(child-a) → redelegate-b.commit(child-a) → complete-a.revalidate(child-a) → complete-a.commit(child-a) → redelegate-b.revalidate(child-b) → redelegate-b.commit(child-b) → redelegate-b.revalidate(parent) → redelegate-b.commit(parent) → complete-a.revalidate(parent) → complete-a.commit(parent)

Retained exact unsafe historical #1021 witness:

> stale-save-a.read → abandon-b.read → abandon-b.prepare → abandon-b.revalidate(child-a) → abandon-b.commit(child-a) → abandon-b.revalidate(parent) → abandon-b.commit(parent) → A.refresh → stale-save-a.prepare → stale-save-a.revalidate(child-a) → stale-save-a.commit(child-a)

Historical model exit zero ratchets unsafe examples; it does not prove their safety. Current finite participating completion/save regressions are separate. No pair atomicity: committed child, transcript or parent prefixes survive later failure; no automatic rollback, lock theft, age-based recovery or uncertain evidence deletion.

## 7. Manual validation recommendation — not a deployment assertion

The user proposes live manual testing. Recommended next gate is a confirmed build from the final source in an isolated test profile with disposable tasks and a scratch workspace, not valuable production task histories. Preserve a backup before expanding use. Confirm loaded build/revision rather than assuming a dirty checkout or unchanged extension version identifies the installed bytes.

Manual sequence (not executed by this task):

1. Fresh Orchestrator chat: one delegation; observe actual child admission/start rather than enqueue alone.
2. Child completion: correct parent/result once; parent resumes; a new follow-up can be answered and continued.
3. Fresh question and reopened saved-question: answer progresses without a capable fence spanning idle wait.
4. Two sequential delegations; then one nested delegation; verify mode/context and correctly scoped results.
5. Stop/cancel a disposable child, reopen/retry the parent; verify a recoverable focused task rather than an empty/stuck UI.
6. Close/reopen a disposable history; verify saved messages, lineage and absence of duplicate results.

Stop at the first hang, wrong-owner result, duplicate result, unexpected refusal or empty task view. Record timestamp/timezone, exact loaded build, task/instance/action/child correlation IDs, Zoo output phase records and relevant host errors. Do not publish prompts, transcripts, tokens, profiles or headers. Those observations should become deterministic regression/fix work; manual success supplements but does not replace remaining root failure triage.

**[N/A]** executed live-host smoke/restart, final build/install/deploy, real profile/task inspection/repair, model/network requests, B1/B2, power-loss/crash recovery, default-concurrency safety and whole-repository stability. Root failures, ignored artifact parity and host behavior remain limits, not waived prerequisites for a production claim.

**Conditional offline verdict: OFFLINE_ORDINARY_VIABLE_WITH_LIMITS.**
