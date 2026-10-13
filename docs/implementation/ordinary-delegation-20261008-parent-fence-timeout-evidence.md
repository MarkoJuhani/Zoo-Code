# Ordinary delegation: parent handoff fence timeout repair

Date: 2026-10-08. OFFLINE_ONLY. Manual report: task 01a11bff-596b-71df-8cd7-2397b03ee3a2.

## 1. Observations and classification

- The supplied diagnostic export [`../zoo-diagnostics-01a11bff-1791471168671.json`](../../../../../../../tmp/zoo-diagnostics-01a11bff-1791471168671.json:1) is JSON preceded by two comments, not strict JSON. SHA-256: d47ff9e956daf12692d586767da150e6770f27aa428be041d87d9eed8146d7dd. It was inspected only as supplied evidence; no real task directory, profile, queue, lock or saved history was opened or repaired.
- Reported extension version: 3.82.2. Export error timestamp: 2026-10-08T14:52:48.665Z; user timezone Europe/Helsinki, UTC+03:00. The preceding reported error follows a native delegation at approximately 14:52:01Z. Parent ID is above; native action ID is call_fcf48d7f1c40413899549e870683764f. Expected: child opens and starts once. Actual: typed parent-fence timeout, with child start unconfirmed.
- The supplied stack names the project development bundle [`src/dist/extension.js`](../../src/dist/extension.js:582241) and acquisition phase. Local bundle SHA-256 observed before repair: 36c90b1d31cd6c14f763052dcb081d9ede038ead6331b7245b79f625c31c0a08. Its acquisition code matches the reported stack location and current policy. This is limited snippet parity, NOT a loaded-process revision or full bundle/source parity proof.
- At final preservation audit, the ignored local development bundle had changed to SHA-256 75a23c2a5c1433916c89408d113b0e58188df27611f0101dcfbfed2aa4dea061. No agent command built, installed, launched or replaced it. Its producer and loaded-host adoption are UNKNOWN; active generated-artifact immutability and current loaded-build parity are NOT claimed. Source/index preservation is verified separately.
- Workspace environment: Linux 6.18, shell /bin/sh. Editor edition/version, loaded revision/build identity, whether this chat was freshly created or reopened, complete prior sequential/nested lineage, lock owner/generation at the manual failure, and missing/duplicated/wrong-owner history are UNKNOWN. Phase labels in supplied text do not independently prove earlier child completion. No prompts, profiles, headers or conversation excerpts are included here.
- **Reported fault class: reproduced-and-fixed offline.** A deterministic actual Task/native-presenter/provider/scheduler/disposable-store schedule produces the same typed timeout when the current assistant save still owns the parent fence. Exact causation of the historical live occurrence remains evidence-limited; another process or uncertain retained lock can produce the same error and is deliberately not bypassed.

## 2. Actual path and narrow repair

Native stream finalization may dispatch a complete delegation tool while the current assistant history write is still in flight. Approval can finish before that write settles. The call path is native presenter → delegation tool → serialized provider transition → provider start exclusion → parent fence acquisition. That acquisition has an immediate, unchanged zero-wait policy for handoff. An independently running ordinary assistant save already holds the same parent fence. The provider's pending-result flush does not protect this ordering when the buffer is empty, and is too late if acquisition itself fails.

Runtime change: [`src/core/tools/NewTaskTool.ts`](../../src/core/tools/NewTaskTool.ts:134) awaits the existing current-turn assistant persistence boundary **after approval and before provider handoff**. False readiness, abort or abandonment prevents handoff. Errors use the existing tool-error path; pending action and parent evidence are retained. The wait does not create, release, renew or borrow a capable fence. No production timeout, retry count, immutable identity, sticky refusal, final-effect check, exact-child check or persistence reducer changed.

Tests: [`src/core/task/__tests__/ordinaryDelegationComposition.spec.ts`](../../src/core/task/__tests__/ordinaryDelegationComposition.spec.ts:360) holds the actual assistant save after real ordinary authority/fence acquisition, approves through the real native presenter, and gates ordering with events. It uses constructed Tasks, the real scheduler, real provider delegation transition, real store and disk publication. Only external activation/API/editor collection and the surrounding model loop are fixture seams; this is not a live model/network or extension-host test. Assertions require no early handoff/disposal, one persisted assistant call, one admitted child, no diagnostic failure, preserved lineage and no scheduler errors. Additional real-Task controls cover cancellation and terminal persistence failure with a freely acquirable parent fence during the wait, no child creation, and retained pending action.

Pre-fix new regression: 1 failed / 32 selection-skips, exit 1 against unchanged production. Post-fix exact selection: 1 passed / 32 selection-skips, exit 0. A disposable negative control removing only the runtime wait failed again: rejected transition name ParentHandoffFenceUnavailableError, reason timeout; phase order approval end → transition acquired → fence acquisition begin → refusal, no child ID or durable publication. See [`prefix-regression.command.json`](../../../../../../../tmp/zoo-handoff-unavailable-20261008-tvmgy80v/prefix-regression.command.json:1), [`postfix-regression.command.json`](../../../../../../../tmp/zoo-handoff-unavailable-20261008-tvmgy80v/postfix-regression.command.json:1), [`negative-control-typed.json`](../../../../../../../tmp/zoo-handoff-unavailable-20261008-tvmgy80v/negative-control-typed.json:1). The diagnostic mapper calls this authority_refused; it does not separately expose the timeout reason.

Fixture/static changes are separate:

- Two existing delegation-tool task doubles now supply the real readiness API. An initial 14 passed / 1 failed unit result identified the second missing fixture method; argument/result/legacy-path assertions were preserved.
- Two new terminal controls initially assumed an active status never seeded by the fixture (48 passed / 2 failed). An attempted atomic legacy-unset → active seed was rejected (471 passed / 2 failed); supported upsert now seeds active explicitly. No reducer or assertion was weakened.
- The root attempt found two old one-second polling failures in ordinary question tests. Readiness, native result delivery and continuation settlement now use real-path event gates, preserving original authority, result, once-only and durability assertions; no timeout increase.
- The touched model uses shared provider identifier constants and supplies the existing required task-number field. These repair lint/type fixture omissions, not lifecycle transitions.

## 3. Additive bounded readiness evidence

[`scripts/check-provider-handoff-scheduler.ts`](../../scripts/check-provider-handoff-scheduler.ts:505) adds an independent adapter submodel: approval, save start/durable/failure, cancellation and handoff. Fixed exploration: 17 states, 6/6 actions, 6/6 landmarks, depth 8, budget 100. It permits in-flight-save completion after cancellation, prohibits handoff until durable readiness and excludes cancelled handoff. Its legacy policy must reproduce the exact shortest witness approve → save-start → handoff. The existing provider graph remains 104 states, depth 15, budget 20,000, 10/10 actions, 12/12 landmarks, six exact negative witnesses. Historical store #1469/#1021 witnesses and all other declared budgets remain unchanged.

This readiness model abstracts the async Task/fence boundary; it does not execute the native presenter, lock syscalls or the readiness Promise. The actual runtime regression owns that refinement. It makes no fairness, arbitrary-load, process-crash, retained-lock-recovery or universal ordinary-workflow safety claim. All eight declared lifecycle stages passed after final model fixture changes.

## 4. Independent verification and exact outcomes

Disposable environment: /tmp/zoo-handoff-unavailable-20261008-tvmgy80v. Current working source, not HEAD, was overlaid onto independently copied installed dependencies; no install was run. Initial copy validation: 98,373 regular files, 5,499 links, 2,958 source hashes, no shared active/template inodes, escaping links or source mismatches. [`copy-validation.json`](../../../../../../../tmp/zoo-handoff-unavailable-20261008-tvmgy80v/copy-validation.json:1); [`verification-env.json`](../../../../../../../tmp/zoo-handoff-unavailable-20261008-tvmgy80v/verification-env.json:1). Node 22.23.1; pnpm 10.8.1; isolated home/config/cache/temp/pnpm-home; network-denial preload. Six HTTPS requests were denied during the root suite; no successful model/API/network request is claimed. The root run contains offline jsdom/provider network-denial stderr. Existing Vite file-URL and Prettier unknown-option warnings are retained, not hidden.

| Lane                              | Exact outcome                                                                                           | Command/output evidence                                                                                                                                                                                                                                                  |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Final focused safety selection    | 473 passed / 20 files, exit 0, no unhandled-error section, 164.48 s                                     | [`accepted-focused.command.json`](../../../../../../../tmp/zoo-handoff-unavailable-20261008-tvmgy80v/accepted-focused.command.json:1); [`accepted-focused.output.txt`](../../../../../../../tmp/zoo-handoff-unavailable-20261008-tvmgy80v/accepted-focused.output.txt:1) |
| Source types                      | Exit 0, 42.58 s                                                                                         | [`accepted-source-types.command.json`](../../../../../../../tmp/zoo-handoff-unavailable-20261008-tvmgy80v/accepted-source-types.command.json:1)                                                                                                                          |
| Public types                      | Exit 0, 16.94 s; public types unchanged thereafter                                                      | [`public-types.command.json`](../../../../../../../tmp/zoo-handoff-unavailable-20261008-tvmgy80v/public-types.command.json:1)                                                                                                                                            |
| Source touched-file lint, pruning | Exit 0, 14.22 s; no increased counts                                                                    | [`accepted-src-lint.command.json`](../../../../../../../tmp/zoo-handoff-unavailable-20261008-tvmgy80v/accepted-src-lint.command.json:1)                                                                                                                                  |
| Final model stdin lint            | Exit 0, 1.57 s; source config applied to model bytes                                                    | [`final-model-lint-accepted.command.json`](../../../../../../../tmp/zoo-handoff-unavailable-20261008-tvmgy80v/final-model-lint-accepted.command.json:1)                                                                                                                  |
| Final model strict types          | Exit 0, 8.70 s; disposable alias config, no active build/config edits                                   | [`final-model-types.command.json`](../../../../../../../tmp/zoo-handoff-unavailable-20261008-tvmgy80v/final-model-types.command.json:1); [`model-tsconfig.json`](../../../../../../../tmp/zoo-handoff-unavailable-20261008-tvmgy80v/model-tsconfig.json:1)               |
| Source/test formatting            | Exit 0, 1.17 s                                                                                          | [`accepted-format.command.json`](../../../../../../../tmp/zoo-handoff-unavailable-20261008-tvmgy80v/accepted-format.command.json:1)                                                                                                                                      |
| Final model formatting            | Exit 0, 0.47 s                                                                                          | [`final-model-format.command.json`](../../../../../../../tmp/zoo-handoff-unavailable-20261008-tvmgy80v/final-model-format.command.json:1)                                                                                                                                |
| Final eight lifecycle stages      | Exit 0, 17.08 s, no unhandled-error section                                                             | [`final-lifecycle-accepted.command.json`](../../../../../../../tmp/zoo-handoff-unavailable-20261008-tvmgy80v/final-lifecycle-accepted.command.json:1)                                                                                                                    |
| Single complete root attempt      | Exit 1, 729.23 s, within 1,800 s; 12/13 Turbo tasks successful; 0/13 cached; no unhandled-error section | [`root-test.command.json`](../../../../../../../tmp/zoo-handoff-unavailable-20261008-tvmgy80v/root-test.command.json:1); [`root-test.output.txt`](../../../../../../../tmp/zoo-handoff-unavailable-20261008-tvmgy80v/root-test.output.txt:1)                             |

The first root-script lint command lacked configuration, the next excluded root scripts, then stdin lint exposed two raw identifier literals. The extra standalone model type command lacked the workspace alias; after explicit disposable scoping, it exposed the missing model task number. All unsuccessful exact invocations are preserved in [`verification-ledger.json`](../../../../../../../tmp/zoo-handoff-unavailable-20261008-tvmgy80v/verification-ledger.json:1). Console capture in the first negative control was filtered; the phase capture expected the wrong diagnostic class; the final typed capture proves timeout. No failed artifact was replaced, no second complete root attempt was run, and negative-control mutations were restored byte-for-byte only in the disposable copy.

### Exact executable verification commands

Every command below ran with the isolated environment linked above and the shown cwd. Bounds/exits and the complete argument arrays are retained in their linked records. These are records, not instructions to execute against the active tree.

**prefix-regression** — cwd: /tmp/zoo-handoff-unavailable-20261008-tvmgy80v/Zoo-Code/src; exit 1; [`prefix-regression.command.json`](../../../../../../../tmp/zoo-handoff-unavailable-20261008-tvmgy80v/prefix-regression.command.json:1).

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-handoff-unavailable-20261008-tvmgy80v/Zoo-Code/src/node_modules/vitest/vitest.mjs run core/task/__tests__/ordinaryDelegationComposition.spec.ts -t 'native delegation waits outside the fence' --maxWorkers=1 --reporter=default
```

**postfix-regression** — cwd: /tmp/zoo-handoff-unavailable-20261008-tvmgy80v/Zoo-Code/src; exit 0; [`postfix-regression.command.json`](../../../../../../../tmp/zoo-handoff-unavailable-20261008-tvmgy80v/postfix-regression.command.json:1).

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-handoff-unavailable-20261008-tvmgy80v/Zoo-Code/src/node_modules/vitest/vitest.mjs run core/task/__tests__/ordinaryDelegationComposition.spec.ts -t 'native delegation waits outside the fence' --maxWorkers=1 --reporter=default
```

**accepted-focused** — cwd: /tmp/zoo-handoff-unavailable-20261008-tvmgy80v/Zoo-Code/src; exit 0; [`accepted-focused.command.json`](../../../../../../../tmp/zoo-handoff-unavailable-20261008-tvmgy80v/accepted-focused.command.json:1).

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-handoff-unavailable-20261008-tvmgy80v/Zoo-Code/src/node_modules/vitest/vitest.mjs run core/task/__tests__/ordinaryDelegationComposition.spec.ts core/task/__tests__/TaskScheduler.spec.ts core/task/__tests__/Task.spec.ts core/task/__tests__/providerHandoff.spec.ts core/task/__tests__/pending-question.spec.ts core/task/__tests__/ordinaryPersistenceOwnership.spec.ts core/task/__tests__/manualSupersedeB1.startGuard.spec.ts core/task/__tests__/manualSupersedeB1.actualInstanceStart.spec.ts core/webview/__tests__/ordinaryCompletionOwnership.spec.ts __tests__/ClineProvider.delegation.spec.ts __tests__/ClineProvider.history-resume-delegation.spec.ts __tests__/delegation-concurrent.spec.ts __tests__/nested-delegation-resume.spec.ts __tests__/delegation-handoff-robustness.spec.ts core/tools/__tests__/newTaskTool.spec.ts core/webview/__tests__/ordinaryAbandonmentPersistence.spec.ts core/task-persistence/__tests__/taskLifecycle.spec.ts core/webview/__tests__/manualSupersedeB1.providerStart.spec.ts core/webview/__tests__/manualSupersedeB1.providerFinalEffects.spec.ts __tests__/delegation-restart-persistence.integration.spec.ts --maxWorkers=1 --reporter=default
```

**accepted-source-types** — cwd: /tmp/zoo-handoff-unavailable-20261008-tvmgy80v/Zoo-Code/src; exit 0; [`accepted-source-types.command.json`](../../../../../../../tmp/zoo-handoff-unavailable-20261008-tvmgy80v/accepted-source-types.command.json:1).

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-handoff-unavailable-20261008-tvmgy80v/Zoo-Code/node_modules/typescript/bin/tsc --noEmit --pretty false
```

**public-types** — cwd: /tmp/zoo-handoff-unavailable-20261008-tvmgy80v/Zoo-Code/packages/types; exit 0; [`public-types.command.json`](../../../../../../../tmp/zoo-handoff-unavailable-20261008-tvmgy80v/public-types.command.json:1).

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-handoff-unavailable-20261008-tvmgy80v/Zoo-Code/node_modules/typescript/bin/tsc --noEmit --pretty false
```

**accepted-src-lint** — cwd: /tmp/zoo-handoff-unavailable-20261008-tvmgy80v/Zoo-Code/src; exit 0; [`accepted-src-lint.command.json`](../../../../../../../tmp/zoo-handoff-unavailable-20261008-tvmgy80v/accepted-src-lint.command.json:1).

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-handoff-unavailable-20261008-tvmgy80v/Zoo-Code/node_modules/eslint/bin/eslint.js --prune-suppressions --max-warnings=0 core/tools/NewTaskTool.ts core/tools/__tests__/newTaskTool.spec.ts core/task/__tests__/ordinaryDelegationComposition.spec.ts
```

**final-model-lint-accepted** — cwd: /tmp/zoo-handoff-unavailable-20261008-tvmgy80v/Zoo-Code/src; exit 0; [`final-model-lint-accepted.command.json`](../../../../../../../tmp/zoo-handoff-unavailable-20261008-tvmgy80v/final-model-lint-accepted.command.json:1).

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-handoff-unavailable-20261008-tvmgy80v/Zoo-Code/node_modules/eslint/bin/eslint.js --max-warnings=0 --stdin --stdin-filename scripts/check-provider-handoff-scheduler.ts < /tmp/zoo-handoff-unavailable-20261008-tvmgy80v/Zoo-Code/scripts/check-provider-handoff-scheduler.ts
```

**final-model-types** — cwd: /tmp/zoo-handoff-unavailable-20261008-tvmgy80v/Zoo-Code; exit 0; [`final-model-types.command.json`](../../../../../../../tmp/zoo-handoff-unavailable-20261008-tvmgy80v/final-model-types.command.json:1).

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-handoff-unavailable-20261008-tvmgy80v/Zoo-Code/node_modules/typescript/bin/tsc --noEmit --pretty false --project /tmp/zoo-handoff-unavailable-20261008-tvmgy80v/model-tsconfig.json
```

**accepted-format** — cwd: /tmp/zoo-handoff-unavailable-20261008-tvmgy80v/Zoo-Code; exit 0; [`accepted-format.command.json`](../../../../../../../tmp/zoo-handoff-unavailable-20261008-tvmgy80v/accepted-format.command.json:1).

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-handoff-unavailable-20261008-tvmgy80v/Zoo-Code/node_modules/prettier/bin/prettier.cjs --check src/core/tools/NewTaskTool.ts src/core/tools/__tests__/newTaskTool.spec.ts src/core/task/__tests__/ordinaryDelegationComposition.spec.ts scripts/check-provider-handoff-scheduler.ts
```

**final-model-format** — cwd: /tmp/zoo-handoff-unavailable-20261008-tvmgy80v/Zoo-Code; exit 0; [`final-model-format.command.json`](../../../../../../../tmp/zoo-handoff-unavailable-20261008-tvmgy80v/final-model-format.command.json:1).

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-handoff-unavailable-20261008-tvmgy80v/Zoo-Code/node_modules/prettier/bin/prettier.cjs --check scripts/check-provider-handoff-scheduler.ts
```

**final-lifecycle-accepted** — cwd: /tmp/zoo-handoff-unavailable-20261008-tvmgy80v/Zoo-Code; exit 0; [`final-lifecycle-accepted.command.json`](../../../../../../../tmp/zoo-handoff-unavailable-20261008-tvmgy80v/final-lifecycle-accepted.command.json:1).

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-handoff-unavailable-20261008-tvmgy80v/pnpm/bin/pnpm.cjs lifecycle:model-check
```

**root-test** — cwd: /tmp/zoo-handoff-unavailable-20261008-tvmgy80v/Zoo-Code; exit 1; [`root-test.command.json`](../../../../../../../tmp/zoo-handoff-unavailable-20261008-tvmgy80v/root-test.command.json:1).

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-handoff-unavailable-20261008-tvmgy80v/pnpm/bin/pnpm.cjs test --force --continue=dependencies-successful --concurrency=2
```

[N/A] live host launch/restart, build/install/deploy, saved-task/profile/queue repair or manual retry, real lock/history inspection, model/network use, second full-root attempt, power-loss/crash recovery and whole-repository stability.

## 5. Full-root failures retained, not waived

The complete root run measured extension: **78 failed / 9,701 passed / 39 skipped**, 14 failed / 505 passed / 4 skipped files. Other measured lanes passed: webview 1,895, core 149, types 441, CLI 565 (one skipped), cloud 247, telemetry 49, VS Code shim 407. These totals are separate package results, not additive with focused tests.

Two ordinary-question failures from that root attempt were subsequently repaired as event-gated fixture seams and passed in the final focused selection. The arithmetic remainder is 76 failures across 13 unaddressed files, **not a measured final full-root outcome**. The root result is non-final for those later fixture and model-static edits. Existing failures remain concrete obligations; they are not declared acceptable or unrelated because they existed before this repair. No final root-green claim follows.

| Retained root file                                                                                                                                                   | Failed identities | Disposition                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | --------------------------------------------------------- |
| [`src/__tests__/queue-lifecycle-composed.spec.ts`](../../src/__tests__/queue-lifecycle-composed.spec.ts:1)                                                           | 4                 | Retained, unaddressed; diagnosis/repair still required    |
| [`src/__tests__/removeClineFromStack-delegation.spec.ts`](../../src/__tests__/removeClineFromStack-delegation.spec.ts:1)                                             | 3                 | Retained, unaddressed; diagnosis/repair still required    |
| [`src/__tests__/single-open-invariant.spec.ts`](../../src/__tests__/single-open-invariant.spec.ts:1)                                                                 | 6                 | Retained, unaddressed; diagnosis/repair still required    |
| [`src/api/providers/fetchers/__tests__/openrouter.spec.ts`](../../src/api/providers/fetchers/__tests__/openrouter.spec.ts:1)                                         | 1                 | Retained, unaddressed; diagnosis/repair still required    |
| [`src/core/assistant-message/__tests__/presentAssistantMessage-images.spec.ts`](../../src/core/assistant-message/__tests__/presentAssistantMessage-images.spec.ts:1) | 1                 | Retained, unaddressed; diagnosis/repair still required    |
| [`src/core/task-persistence/__tests__/TaskHistoryStore.reconciliation.spec.ts`](../../src/core/task-persistence/__tests__/TaskHistoryStore.reconciliation.spec.ts:1) | 7                 | Retained, unaddressed; diagnosis/repair still required    |
| [`src/core/task-persistence/__tests__/interruptedCreateHandoffDisk.spec.ts`](../../src/core/task-persistence/__tests__/interruptedCreateHandoffDisk.spec.ts:1)       | 1                 | Retained, unaddressed; diagnosis/repair still required    |
| [`src/core/task-persistence/__tests__/manualSupersedeB1.bypass.spec.ts`](../../src/core/task-persistence/__tests__/manualSupersedeB1.bypass.spec.ts:1)               | 2                 | Retained, unaddressed; diagnosis/repair still required    |
| [`src/core/task/__tests__/Task.pending-action.spec.ts`](../../src/core/task/__tests__/Task.pending-action.spec.ts:1)                                                 | 2                 | Retained, unaddressed; diagnosis/repair still required    |
| [`src/core/task/__tests__/Task.throttle.test.ts`](../../src/core/task/__tests__/Task.throttle.test.ts:1)                                                             | 6                 | Retained, unaddressed; diagnosis/repair still required    |
| [`src/core/task/__tests__/ordinaryDelegationComposition.spec.ts`](../../src/core/task/__tests__/ordinaryDelegationComposition.spec.ts:1)                             | 2                 | Two polling seams repaired after root; focused proof only |
| [`src/core/webview/__tests__/ClineProvider.apiHandlerRebuild.spec.ts`](../../src/core/webview/__tests__/ClineProvider.apiHandlerRebuild.spec.ts:1)                   | 9                 | Retained, unaddressed; diagnosis/repair still required    |
| [`src/core/webview/__tests__/ClineProvider.sticky-mode.spec.ts`](../../src/core/webview/__tests__/ClineProvider.sticky-mode.spec.ts:1)                               | 19                | Retained, unaddressed; diagnosis/repair still required    |
| [`src/core/webview/__tests__/ClineProvider.sticky-profile.spec.ts`](../../src/core/webview/__tests__/ClineProvider.sticky-profile.spec.ts:1)                         | 15                | Retained, unaddressed; diagnosis/repair still required    |

All exact identities are retained in [`root-failures.json`](../../../../../../../tmp/zoo-handoff-unavailable-20261008-tvmgy80v/root-failures.json:1) and materialized below:

<details>
<summary>78 exact failed identities</summary>

- [`src/__tests__/queue-lifecycle-composed.spec.ts`](../../src/__tests__/queue-lifecycle-composed.spec.ts:1) — Phase 0 composed queue lifecycle > current partial fix: real internal disposal emits abort but bridge retains root ownership; lineage commits before scheduler activation
- [`src/__tests__/queue-lifecycle-composed.spec.ts`](../../src/__tests__/queue-lifecycle-composed.spec.ts:1) — Phase 0 composed queue lifecycle > nested return: production delegation and resumption preserve root → child → grandchild → child → root ordering
- [`src/__tests__/queue-lifecycle-composed.spec.ts`](../../src/__tests__/queue-lifecycle-composed.spec.ts:1) — Phase 0 composed queue lifecycle > original defect red proof: source-derived pre-filter projection terminalizes the same real abort emission
- [`src/__tests__/queue-lifecycle-composed.spec.ts`](../../src/__tests__/queue-lifecycle-composed.spec.ts:1) — Phase 0 composed queue lifecycle > remaining lifecycle failure: abort notification precedes cleanup, so it is not stop proof
- [`src/__tests__/removeClineFromStack-delegation.spec.ts`](../../src/__tests__/removeClineFromStack-delegation.spec.ts:1) — ClineProvider.evictCurrentTask() — active delegated child path > calls markDelegatedChildInterrupted when current task is an active delegated child
- [`src/__tests__/removeClineFromStack-delegation.spec.ts`](../../src/__tests__/removeClineFromStack-delegation.spec.ts:1) — ClineProvider.evictCurrentTask() — active delegated child path > does not call markDelegatedChildInterrupted for a task with no parentTaskId
- [`src/__tests__/removeClineFromStack-delegation.spec.ts`](../../src/__tests__/removeClineFromStack-delegation.spec.ts:1) — ClineProvider.evictCurrentTask() — active delegated child path > propagates markDelegatedChildInterrupted errors (method swallows internally, not caller)
- [`src/__tests__/single-open-invariant.spec.ts`](../../src/__tests__/single-open-invariant.spec.ts:1) — Single-open-task invariant > User-initiated create: closes existing before opening new
- [`src/__tests__/single-open-invariant.spec.ts`](../../src/__tests__/single-open-invariant.spec.ts:1) — Single-open-task invariant > Subtask create: keeps existing task open when parentTask is provided
- [`src/__tests__/single-open-invariant.spec.ts`](../../src/__tests__/single-open-invariant.spec.ts:1) — Single-open-task invariant > History resume path always closes current before rehydration (non-rehydrating case)
- [`src/__tests__/single-open-invariant.spec.ts`](../../src/__tests__/single-open-invariant.spec.ts:1) — Single-open-task invariant > History resume path wires scheduler in rehydrating (in-place) case
- [`src/__tests__/single-open-invariant.spec.ts`](../../src/__tests__/single-open-invariant.spec.ts:1) — Single-open-task invariant > serializes concurrent history resumes before mutating the task registry
- [`src/__tests__/single-open-invariant.spec.ts`](../../src/__tests__/single-open-invariant.spec.ts:1) — Single-open-task invariant > IPC StartNewTask path closes current before new task
- [`src/api/providers/fetchers/__tests__/openrouter.spec.ts`](../../src/api/providers/fetchers/__tests__/openrouter.spec.ts:1) — OpenRouter API > getOpenRouterModels > fetches models and validates schema
- [`src/core/assistant-message/__tests__/presentAssistantMessage-images.spec.ts`](../../src/core/assistant-message/__tests__/presentAssistantMessage-images.spec.ts:1) — presentAssistantMessage - Image Handling in Native Tool Calling > should preserve images in tool_result for native tool calling
- [`src/core/task-persistence/__tests__/TaskHistoryStore.reconciliation.spec.ts`](../../src/core/task-persistence/__tests__/TaskHistoryStore.reconciliation.spec.ts:1) — TaskHistoryStore reconcileDelegationState > replays a both-at-target intent without writing task files
- [`src/core/task-persistence/__tests__/TaskHistoryStore.reconciliation.spec.ts`](../../src/core/task-persistence/__tests__/TaskHistoryStore.reconciliation.spec.ts:1) — TaskHistoryStore reconcileDelegationState > removes the repair-intent file after successful replay
- [`src/core/task-persistence/__tests__/TaskHistoryStore.reconciliation.spec.ts`](../../src/core/task-persistence/__tests__/TaskHistoryStore.reconciliation.spec.ts:1) — TaskHistoryStore reconcileDelegationState > quarantines malformed and stale intents without blocking unrelated startup
- [`src/core/task-persistence/__tests__/TaskHistoryStore.reconciliation.spec.ts`](../../src/core/task-persistence/__tests__/TaskHistoryStore.reconciliation.spec.ts:1) — TaskHistoryStore reconcileDelegationState > quarantines an intent with a missing task record without changing unrelated startup
- [`src/core/task-persistence/__tests__/TaskHistoryStore.reconciliation.spec.ts`](../../src/core/task-persistence/__tests__/TaskHistoryStore.reconciliation.spec.ts:1) — TaskHistoryStore reconcileDelegationState > quarantines an intent when the child no longer matches its repair guard
- [`src/core/task-persistence/__tests__/TaskHistoryStore.reconciliation.spec.ts`](../../src/core/task-persistence/__tests__/TaskHistoryStore.reconciliation.spec.ts:1) — TaskHistoryStore reconcileDelegationState > logs repairs to console.warn
- [`src/core/task-persistence/__tests__/TaskHistoryStore.reconciliation.spec.ts`](../../src/core/task-persistence/__tests__/TaskHistoryStore.reconciliation.spec.ts:1) — TaskHistoryStore upsert transition guard > atomicReadAndUpdate enforces the upsertCore transition guard on status changes
- [`src/core/task-persistence/__tests__/interruptedCreateHandoffDisk.spec.ts`](../../src/core/task-persistence/__tests__/interruptedCreateHandoffDisk.spec.ts:1) — strict persisted P2 evidence > leaves an invalid generation and ownership lock blocked for explicit reconciliation
- [`src/core/task-persistence/__tests__/manualSupersedeB1.bypass.spec.ts`](../../src/core/task-persistence/__tests__/manualSupersedeB1.bypass.spec.ts:1) — B1 actual bypass witnesses: integration MUST remain unwired > a paused stale API save overwrites a result despite a real parent fence
- [`src/core/task-persistence/__tests__/manualSupersedeB1.bypass.spec.ts`](../../src/core/task-persistence/__tests__/manualSupersedeB1.bypass.spec.ts:1) — B1 actual bypass witnesses: integration MUST remain unwired > paused task prepare/commit and question/deletion effects bypass the parent fence
- [`src/core/task/__tests__/Task.pending-action.spec.ts`](../../src/core/task/__tests__/Task.pending-action.spec.ts:1) — Task pending action replay > falls back to a fresh completion ask when approved finish delegation is stale
- [`src/core/task/__tests__/Task.pending-action.spec.ts`](../../src/core/task/__tests__/Task.pending-action.spec.ts:1) — Task pending action replay > adopts and resumes a newer persisted action at the stale-action recursion boundary
- [`src/core/task/__tests__/Task.throttle.test.ts`](../../src/core/task/__tests__/Task.throttle.test.ts:1) — Task token usage throttling > should emit TaskTokenUsageUpdated immediately on first change
- [`src/core/task/__tests__/Task.throttle.test.ts`](../../src/core/task/__tests__/Task.throttle.test.ts:1) — Task token usage throttling > should throttle subsequent emissions within 2 seconds
- [`src/core/task/__tests__/Task.throttle.test.ts`](../../src/core/task/__tests__/Task.throttle.test.ts:1) — Task token usage throttling > should include toolUsage in emission payload
- [`src/core/task/__tests__/Task.throttle.test.ts`](../../src/core/task/__tests__/Task.throttle.test.ts:1) — Task token usage throttling > should update tokenUsageSnapshot when throttled emission occurs
- [`src/core/task/__tests__/Task.throttle.test.ts`](../../src/core/task/__tests__/Task.throttle.test.ts:1) — Task token usage throttling > should emit when tool usage changes even if token usage is the same
- [`src/core/task/__tests__/Task.throttle.test.ts`](../../src/core/task/__tests__/Task.throttle.test.ts:1) — Task token usage throttling > should update toolUsageSnapshot when emission occurs
- [`src/core/task/__tests__/ordinaryDelegationComposition.spec.ts`](../../src/core/task/__tests__/ordinaryDelegationComposition.spec.ts:1) — phase-scoped fresh scheduler run answers an externally owned question without retaining an idle lease
- [`src/core/task/__tests__/ordinaryDelegationComposition.spec.ts`](../../src/core/task/__tests__/ordinaryDelegationComposition.spec.ts:1) — actual post-child ordinary continuation fallback durably answers an external followup without an idle fence
- [`src/core/webview/__tests__/ClineProvider.apiHandlerRebuild.spec.ts`](../../src/core/webview/__tests__/ClineProvider.apiHandlerRebuild.spec.ts:1) — ClineProvider - API Handler Rebuild Guard > upsertProviderProfile > calls updateApiConfiguration when provider/model unchanged but profile settings changed (explicit save)
- [`src/core/webview/__tests__/ClineProvider.apiHandlerRebuild.spec.ts`](../../src/core/webview/__tests__/ClineProvider.apiHandlerRebuild.spec.ts:1) — ClineProvider - API Handler Rebuild Guard > upsertProviderProfile > calls updateApiConfiguration when provider changes
- [`src/core/webview/__tests__/ClineProvider.apiHandlerRebuild.spec.ts`](../../src/core/webview/__tests__/ClineProvider.apiHandlerRebuild.spec.ts:1) — ClineProvider - API Handler Rebuild Guard > upsertProviderProfile > calls updateApiConfiguration when model changes
- [`src/core/webview/__tests__/ClineProvider.apiHandlerRebuild.spec.ts`](../../src/core/webview/__tests__/ClineProvider.apiHandlerRebuild.spec.ts:1) — ClineProvider - API Handler Rebuild Guard > activateProviderProfile > mode switch preserves its default task when queued behind a profile mutation
- [`src/core/webview/__tests__/ClineProvider.apiHandlerRebuild.spec.ts`](../../src/core/webview/__tests__/ClineProvider.apiHandlerRebuild.spec.ts:1) — ClineProvider - API Handler Rebuild Guard > activateProviderProfile > fan-out preparation leaves the focused task untouched
- [`src/core/webview/__tests__/ClineProvider.apiHandlerRebuild.spec.ts`](../../src/core/webview/__tests__/ClineProvider.apiHandlerRebuild.spec.ts:1) — ClineProvider - API Handler Rebuild Guard > activateProviderProfile > calls updateApiConfiguration when provider/model unchanged but settings differ (explicit profile switch)
- [`src/core/webview/__tests__/ClineProvider.apiHandlerRebuild.spec.ts`](../../src/core/webview/__tests__/ClineProvider.apiHandlerRebuild.spec.ts:1) — ClineProvider - API Handler Rebuild Guard > activateProviderProfile > calls updateApiConfiguration when provider changes and syncs task.apiConfiguration
- [`src/core/webview/__tests__/ClineProvider.apiHandlerRebuild.spec.ts`](../../src/core/webview/__tests__/ClineProvider.apiHandlerRebuild.spec.ts:1) — ClineProvider - API Handler Rebuild Guard > activateProviderProfile > calls updateApiConfiguration when model changes and syncs task.apiConfiguration
- [`src/core/webview/__tests__/ClineProvider.apiHandlerRebuild.spec.ts`](../../src/core/webview/__tests__/ClineProvider.apiHandlerRebuild.spec.ts:1) — ClineProvider - API Handler Rebuild Guard > profile switching sequence > A -> B -> A updates task.apiConfiguration each time
- [`src/core/webview/__tests__/ClineProvider.sticky-mode.spec.ts`](../../src/core/webview/__tests__/ClineProvider.sticky-mode.spec.ts:1) — ClineProvider - Sticky Mode > handleModeSwitch > should save mode to task metadata when switching modes
- [`src/core/webview/__tests__/ClineProvider.sticky-mode.spec.ts`](../../src/core/webview/__tests__/ClineProvider.sticky-mode.spec.ts:1) — ClineProvider - Sticky Mode > handleModeSwitch > should update task's taskMode property when switching modes
- [`src/core/webview/__tests__/ClineProvider.sticky-mode.spec.ts`](../../src/core/webview/__tests__/ClineProvider.sticky-mode.spec.ts:1) — ClineProvider - Sticky Mode > handleModeSwitch > should update task history with new mode when active task exists
- [`src/core/webview/__tests__/ClineProvider.sticky-mode.spec.ts`](../../src/core/webview/__tests__/ClineProvider.sticky-mode.spec.ts:1) — ClineProvider - Sticky Mode > createTaskWithHistoryItem > should restore mode from history item when reopening task
- [`src/core/webview/__tests__/ClineProvider.sticky-mode.spec.ts`](../../src/core/webview/__tests__/ClineProvider.sticky-mode.spec.ts:1) — ClineProvider - Sticky Mode > createTaskWithHistoryItem > should use current mode if history item has no saved mode
- [`src/core/webview/__tests__/ClineProvider.sticky-mode.spec.ts`](../../src/core/webview/__tests__/ClineProvider.sticky-mode.spec.ts:1) — ClineProvider - Sticky Mode > Task initialization timing edge cases > should handle mode restoration during slow task initialization
- [`src/core/webview/__tests__/ClineProvider.sticky-mode.spec.ts`](../../src/core/webview/__tests__/ClineProvider.sticky-mode.spec.ts:1) — ClineProvider - Sticky Mode > Task metadata persistence > should include mode in task metadata when creating history items
- [`src/core/webview/__tests__/ClineProvider.sticky-mode.spec.ts`](../../src/core/webview/__tests__/ClineProvider.sticky-mode.spec.ts:1) — ClineProvider - Sticky Mode > Integration with new_task tool > should preserve parent task mode when creating subtasks
- [`src/core/webview/__tests__/ClineProvider.sticky-mode.spec.ts`](../../src/core/webview/__tests__/ClineProvider.sticky-mode.spec.ts:1) — ClineProvider - Sticky Mode > Error handling > should handle errors gracefully when saving mode fails
- [`src/core/webview/__tests__/ClineProvider.sticky-mode.spec.ts`](../../src/core/webview/__tests__/ClineProvider.sticky-mode.spec.ts:1) — ClineProvider - Sticky Mode > Error handling > should handle null/undefined mode gracefully
- [`src/core/webview/__tests__/ClineProvider.sticky-mode.spec.ts`](../../src/core/webview/__tests__/ClineProvider.sticky-mode.spec.ts:1) — ClineProvider - Sticky Mode > Error handling > should restore API configuration when restoring task from history with mode
- [`src/core/webview/__tests__/ClineProvider.sticky-mode.spec.ts`](../../src/core/webview/__tests__/ClineProvider.sticky-mode.spec.ts:1) — ClineProvider - Sticky Mode > Error handling > should handle mode deletion between sessions
- [`src/core/webview/__tests__/ClineProvider.sticky-mode.spec.ts`](../../src/core/webview/__tests__/ClineProvider.sticky-mode.spec.ts:1) — ClineProvider - Sticky Mode > Concurrent mode switches > should handle concurrent mode switches on the same task
- [`src/core/webview/__tests__/ClineProvider.sticky-mode.spec.ts`](../../src/core/webview/__tests__/ClineProvider.sticky-mode.spec.ts:1) — ClineProvider - Sticky Mode > Concurrent mode switches > should handle mode switches during task save operations
- [`src/core/webview/__tests__/ClineProvider.sticky-mode.spec.ts`](../../src/core/webview/__tests__/ClineProvider.sticky-mode.spec.ts:1) — ClineProvider - Sticky Mode > Mode switch failure scenarios > should handle invalid mode gracefully
- [`src/core/webview/__tests__/ClineProvider.sticky-mode.spec.ts`](../../src/core/webview/__tests__/ClineProvider.sticky-mode.spec.ts:1) — ClineProvider - Sticky Mode > Mode switch failure scenarios > should handle errors during mode switch gracefully
- [`src/core/webview/__tests__/ClineProvider.sticky-mode.spec.ts`](../../src/core/webview/__tests__/ClineProvider.sticky-mode.spec.ts:1) — ClineProvider - Sticky Mode > Mode switch failure scenarios > should handle updateTaskHistory failures
- [`src/core/webview/__tests__/ClineProvider.sticky-mode.spec.ts`](../../src/core/webview/__tests__/ClineProvider.sticky-mode.spec.ts:1) — ClineProvider - Sticky Mode > Multiple tasks switching modes simultaneously > should handle multiple tasks switching modes independently
- [`src/core/webview/__tests__/ClineProvider.sticky-mode.spec.ts`](../../src/core/webview/__tests__/ClineProvider.sticky-mode.spec.ts:1) — ClineProvider - Sticky Mode > Task initialization timing edge cases > should handle rapid task switches during mode changes
- [`src/core/webview/__tests__/ClineProvider.sticky-profile.spec.ts`](../../src/core/webview/__tests__/ClineProvider.sticky-profile.spec.ts:1) — ClineProvider - Sticky Provider Profile > createTaskWithHistoryItem > should restore provider profile from history item when reopening task outside CLI runtime
- [`src/core/webview/__tests__/ClineProvider.sticky-profile.spec.ts`](../../src/core/webview/__tests__/ClineProvider.sticky-profile.spec.ts:1) — ClineProvider - Sticky Provider Profile > createTaskWithHistoryItem > should not restore an empty task apiConfigName profile from history
- [`src/core/webview/__tests__/ClineProvider.sticky-profile.spec.ts`](../../src/core/webview/__tests__/ClineProvider.sticky-profile.spec.ts:1) — ClineProvider - Sticky Provider Profile > createTaskWithHistoryItem > should use current profile if history item has no saved apiConfigName
- [`src/core/webview/__tests__/ClineProvider.sticky-profile.spec.ts`](../../src/core/webview/__tests__/ClineProvider.sticky-profile.spec.ts:1) — ClineProvider - Sticky Provider Profile > createTaskWithHistoryItem > should override mode-based config with task's apiConfigName
- [`src/core/webview/__tests__/ClineProvider.sticky-profile.spec.ts`](../../src/core/webview/__tests__/ClineProvider.sticky-profile.spec.ts:1) — ClineProvider - Sticky Provider Profile > activateProviderProfile > should save provider profile to task metadata when switching profiles
- [`src/core/webview/__tests__/ClineProvider.sticky-profile.spec.ts`](../../src/core/webview/__tests__/ClineProvider.sticky-profile.spec.ts:1) — ClineProvider - Sticky Provider Profile > activateProviderProfile > should update task's taskApiConfigName property when switching profiles
- [`src/core/webview/__tests__/ClineProvider.sticky-profile.spec.ts`](../../src/core/webview/__tests__/ClineProvider.sticky-profile.spec.ts:1) — ClineProvider - Sticky Provider Profile > activateProviderProfile > should update in-memory task profile even if task history item does not exist yet
- [`src/core/webview/__tests__/ClineProvider.sticky-profile.spec.ts`](../../src/core/webview/__tests__/ClineProvider.sticky-profile.spec.ts:1) — ClineProvider - Sticky Provider Profile > createTaskWithHistoryItem > should skip restoring task apiConfigName from history in CLI runtime
- [`src/core/webview/__tests__/ClineProvider.sticky-profile.spec.ts`](../../src/core/webview/__tests__/ClineProvider.sticky-profile.spec.ts:1) — ClineProvider - Sticky Provider Profile > createTaskWithHistoryItem > should skip restoring mode-based provider config from history in CLI runtime
- [`src/core/webview/__tests__/ClineProvider.sticky-profile.spec.ts`](../../src/core/webview/__tests__/ClineProvider.sticky-profile.spec.ts:1) — ClineProvider - Sticky Provider Profile > createTaskWithHistoryItem > should handle missing provider profile gracefully
- [`src/core/webview/__tests__/ClineProvider.sticky-profile.spec.ts`](../../src/core/webview/__tests__/ClineProvider.sticky-profile.spec.ts:1) — ClineProvider - Sticky Provider Profile > Task metadata persistence > should include apiConfigName in task metadata when saving
- [`src/core/webview/__tests__/ClineProvider.sticky-profile.spec.ts`](../../src/core/webview/__tests__/ClineProvider.sticky-profile.spec.ts:1) — ClineProvider - Sticky Provider Profile > Multiple workspaces isolation > should preserve task profile when switching profiles in another workspace
- [`src/core/webview/__tests__/ClineProvider.sticky-profile.spec.ts`](../../src/core/webview/__tests__/ClineProvider.sticky-profile.spec.ts:1) — ClineProvider - Sticky Provider Profile > Error handling > should handle errors gracefully when saving profile fails
- [`src/core/webview/__tests__/ClineProvider.sticky-profile.spec.ts`](../../src/core/webview/__tests__/ClineProvider.sticky-profile.spec.ts:1) — ClineProvider - Sticky Provider Profile > Error handling > should handle null/undefined apiConfigName gracefully
- [`src/core/webview/__tests__/ClineProvider.sticky-profile.spec.ts`](../../src/core/webview/__tests__/ClineProvider.sticky-profile.spec.ts:1) — ClineProvider - Sticky Provider Profile > Profile restoration with activateProfile failure > should continue task restoration even if activateProviderProfile fails

</details>

## 6. Source/index preservation

HEAD e18f931de70282a05c02fc5592e61b71c339a91f; branch weak_model_runtime_hardening. Before inventory and 2,964 path records: [`baseline.json`](../../../../../../../tmp/zoo-handoff-unavailable-20261008-tvmgy80v/baseline.json:1). Semantic index mode/object/stage bytes SHA-256 56ec157367711932aaf1a7b16d3693940944ce64a75245d6965c0ad7086cda91, unchanged. No staging/reset/clean/restore. Exactly four existing source/test/model paths changed; one additive implementation report is new. No other baseline file is missing or changed. The active suppression ledger remains byte-identical; the disposable lint ledger pruned one obsolete no-explicit-any count from the delegation tool and increased none. Old reports, architecture rules, dependency/build configuration, changesets, changelogs, unrelated projects and real state remain untouched. Final preservation evidence: [`final-preservation.json`](../../../../../../../tmp/zoo-handoff-unavailable-20261008-tvmgy80v/final-preservation.json:1).

| Existing path                                                                                                                            | Before SHA-256                                                   | After SHA-256                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| [`src/core/tools/NewTaskTool.ts`](../../src/core/tools/NewTaskTool.ts:1)                                                                 | 228edb31c00c36ab32efee25595ac1ae6608317dcef79389e5b6e65951b08b45 | 113440e133ce3843f97a666ba4021ae27caf3322ed5f1259171246bdc6cb99e6 |
| [`src/core/tools/__tests__/newTaskTool.spec.ts`](../../src/core/tools/__tests__/newTaskTool.spec.ts:1)                                   | 44414bb59946bac4620510ca7345ef68433579ccffe19f7d5591878b2ab268f7 | 114e1831d46dc4a78b4edc30dcaf4201bfe2aa1630796871f7f4754c5b217ef9 |
| [`src/core/task/__tests__/ordinaryDelegationComposition.spec.ts`](../../src/core/task/__tests__/ordinaryDelegationComposition.spec.ts:1) | 69dfd28ebc20af123951ee8099ab654f0882d699057d8d80dba3ae649997cb17 | a784c174cdc35a84c004f5fe0eb8f8b5d2fc328750a9f7a94a57fa87c2cd1621 |
| [`scripts/check-provider-handoff-scheduler.ts`](../../scripts/check-provider-handoff-scheduler.ts:1)                                     | 692169f2442b40f6e89ec505164ebbb9b12e9bf9b63a76806fe15000cdca026a | a3c5d58bedb23b58afae921318831a57f4104e2cb9577d8a4d7a29b5d5ca3451 |

## 7. Bounded manual retest; no deployment assertion

Retest only with a separately authorized build from these exact final source hashes (base revision above, still a dirty working unit), in an isolated test profile with disposable histories and a scratch workspace. Version 3.82.2 alone does NOT identify fixed bytes. Record loaded build/revision and bundle SHA-256 first. No build/install/restart was performed here; the original failing saved chat was not repaired or automatically retried.

1. Fresh disposable parent, one native delegation without earlier tool results: confirm child actually admitted/started, not only enqueued; correct parent lineage and task-local mode.
2. Child completion: one correlated result, correct parent, parent resumes and accepts an external follow-up answer. No missing/duplicated/wrong-task transcript.
3. Two sequential delegations, then one nested delegation: all children start and results return to the exact awaited parent once.
4. Reopen a disposable parent; repeat delegation. Stop/cancel while a child or approval is pending; confirm no late child start and no wrong-owner result.
5. Stop at the first refusal/hang/duplicate. Preserve safe Zoo phase output with task/instance/action/child/transition correlation and exact loaded build. If fence acquisition still refuses before parent effects, the smallest next scope is a separately authorized read-only inspection of owner/generation for that specific disposable storage root and ID, distinguishing another active holder from uncertain retained evidence. Do not delete/steal a lock or blindly retry a valuable saved task.

Automated proof is limited to the reproduced current-turn-save race and participating finite controls. Live causation, loaded parity and manual success remain unverified. Remaining root failures and historical #1469 limitations are not closed by this repair.

Conditional verdict: **OFFLINE_ORDINARY_VIABLE_WITH_LIMITS**.
