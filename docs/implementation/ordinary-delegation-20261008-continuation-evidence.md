# Ordinary delegated continuation — implementation evidence (2026-10-08)

## Result and scope

Implemented the ordinary post-child continuation repair. **Accepted verification: 390 passed tests / 14 files, zero skipped tests, no reported unhandled errors; source/public type checks, touched-file lint/formatting, and all eight unchanged lifecycle model stages passed.**

This is an ordinary extension workflow repair, not B1 enablement, noncooperative cleanup or broader persistence redesign. Only the three authorized production files and the corresponding composition test changed; this document is new. [targetPersistenceBoundary.ts](../../src/core/task-persistence/targetPersistenceBoundary.ts) was read but not modified. No schema, config, dependencies, store, reducers, historical models/witnesses, model bounds/budgets or active suppression file changed. No install, root rerun, host launch, live profile, API/model request, deployment or Git staging/reset/clean occurred.

## Actual pre-fix reproduction

Before production edits, appended the bounded actual post-child followup regression and executed it against byte-identical baseline production. [actual-prefix command](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/continuation-actual-prefix.command.json) and [actual-prefix output](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/continuation-actual-prefix.output.txt) retain **exit 1, one failed selected test / 21 selection-skips**. Durable provider completion returned committed/queued, but the real followup never opened an active question waiter; the 2.5-second assertion failed with an undefined waiter. This is not a root-suite or mocked admission proof.

The baseline [provider supplied-runner call](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/before/src/core/webview/ClineProvider.ts:5118) supplied its authorized resume as a function callback; [scheduler custom-runner exclusion](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/before/src/core/task/TaskScheduler.ts:64) therefore wrapped the whole resumed model loop in [Task.runWithStartExclusion()](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/before/src/core/task/Task.ts:2763). The baseline [question-wait refusal](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/before/src/core/task-persistence/targetPersistenceBoundary.ts:264) correctly rejects idle waits inheriting that capable scope. The repair changes the composed entry/phase lifetime, not the refusal policy.

Initial setup failures are retained separately and are **not** production proof: binding an existing creation mock recursively, then environment collection calling a missing ignore-controller fixture method. The creation fixture now captures its original implementation; only offline workspace/editor environment-detail collection is doubled. Real preparation and history writes remain executed. Interim type/fixture failures (wrong store method, nested scheduler-spy recursion, missing receiver annotation) are retained in the disposable command/output records and were corrected without deleting existing assertions.

## Production and regression mapping

| Boundary                            | Source                                                                                                         | Behavior                                                                                                                                                                                                                                                                        |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ordinary prepared entry             | [PreparedTaskResume](../../src/core/task/TaskScheduler.ts:6)                                                   | Names a specific Task-owned prepared-resume contract, not a generic unprotected callback or escape flag.                                                                                                                                                                        |
| Semaphore and execution stages      | [TaskScheduler.schedule()](../../src/core/task/TaskScheduler.ts:47)                                            | Whole run promise still holds the semaphore; admitted means permit ownership, started means actual matching invocation, cancellation has no settlement, failure rejects and releases in finally. Supplied function callbacks retain their existing lifetime exclusion.          |
| Bounded Task admission              | [Task.runScheduledResume()](../../src/core/task/Task.ts:2749)                                                  | Provider authorization calls Task-owned preparation under live exclusions and immutable authority. Only the known Task loop is returned for synchronous invocation in independent orchestration; its promise is observed immediately and awaited outside provider ownership.    |
| Prepared start event                | [Task.initiateTaskLoop()](../../src/core/task/Task.ts:3659)                                                    | Checkpoint work remains joined in capable preparation. Prepared TaskStarted is deferred until the matching loop is invoked, so a cancelled prepared continuation never emits a start.                                                                                           |
| Enqueue/fallback routing            | [scheduleTask()](../../src/core/webview/ClineProvider.ts:327)                                                  | Forwards the explicit entry to the real scheduler or the same Task-owned fallback admission. Return value remains enqueue acceptance only. Arbitrary functions still use lifetime protection in both routes.                                                                    |
| Exact committed identity            | [resumeIdentity](../../src/core/webview/ClineProvider.ts:5083)                                                 | Captures the completed parent identity once; authoritative validation requires unchanged immutable revision/lineage, active parent, exact completed child, no awaiting/delegated child, current instance, unchanged transition and no abort/abandon/cancellation.               |
| Joined invocation authorization     | [authorizeResume](../../src/core/webview/ClineProvider.ts:5129)                                                | Reacquires the parent transition and ancestry-planned parent/child exclusions; validates before and after bounded preparation, then checks live instance/transition/cancellation synchronously adjacent to invocation. Ownership is released before waiting for the model loop. |
| Actual question composition         | [post-child ordinary regression](../../src/core/task/__tests__/ordinaryDelegationComposition.spec.ts:928)      | Real delegation and completion, constructed Tasks, real scheduler/store/writers and actual native presenter/tool/ask path. Same external answer and idle-fence proof runs through scheduler and fallback.                                                                       |
| Pre-admission stale controls        | [admission-gap controls](../../src/core/task/__tests__/ordinaryDelegationComposition.spec.ts:1011)             | Current instance, durable ownership, transition and immutable revision changes all cancel before loop invocation, without start/settle or transcript changes.                                                                                                                   |
| Through-invocation ownership        | [invocation/permit/observer control](../../src/core/task/__tests__/ordinaryDelegationComposition.spec.ts:1074) | Real semaphore blocker delays admission; real metadata-read barrier proves parent and child fences exclude competitors; the next provider transition cannot cross invocation but proceeds while the prior loop remains pending.                                                 |
| After-preparation stale controls    | [prepared-gap controls](../../src/core/task/__tests__/ordinaryDelegationComposition.spec.ts:1187)              | Current instance or transition change after capable preparation cancels the prepared loop. Parent ownership remains live through that gap.                                                                                                                                      |
| Failure control                     | [resumed-loop rejection control](../../src/core/task/__tests__/ordinaryDelegationComposition.spec.ts:1233)     | Exactly begin/admitted/started/failed, never settled; original failure retained despite throwing observers, successor executes after real permit release.                                                                                                                       |
| Validation-return microtask control | [microtask-gap control](../../src/core/task/__tests__/ordinaryDelegationComposition.spec.ts:1269)              | A real registry switch queued after the final asynchronous validation snapshot cannot start the old loop. Disposable mutation removing the adjacent synchronous check fails this test.                                                                                          |

The parent/child completion publication remains durable before enqueue. The previous child promise is awaited and its permit released before the parent can acquire a scheduler permit. Provider transition and cooperative ownership persist through bounded preparation and **matching synchronous invocation only**; they are not awaited through a model loop or question idle wait. The Task-owned loop alone enters independent orchestration. Existing arbitrary function callbacks remain protected through their last awaited effect, including existing question-wait refusal and custom fallback controls. No timeout was increased, lease surrendered/stolen, expired scope renewed or stale authority refreshed.

Post-child question tests prove a zero-wait external parent-fence acquisition succeeds while the actual full-question waiter is active, then send a scoped external answer through the real response handler. The answer yields exactly one correlated durable tool result; the authoritative parent question clears and child remains completed. Diagnostics distinguish begin, permit admission, actual start, cancellation, settlement and failure. Continuation disposition is parent-committed after durable completion. Throwing observers do not alter run outcome or permit release.

Additional negative control: [invocation-negative command](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/continuation-invocation-negative.command.json) / [invocation-negative output](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/continuation-invocation-negative.output.txt) executed a **disposable-only mutation** removing the final synchronous live-instance check: exit 1, one failed selected test / 31 selection-skips, stale continuation incorrectly started and settled. The mutation was restored before accepted verification; active source was never mutated for this control.

## Isolation and preservation

Disposable root: /tmp/zoo-ordinary-continuation-20261008-yucnn1hj. Physically copied the provider/phase dependency template, then overlaid active tracked/untracked source. [copy validation](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/copy-validation.json) records **98,398 regular files, 5,499 links, 2,955 source hashes, zero shared active/template file inodes, zero escaping project links and zero source mismatches**. Installed pnpm distribution was copied, not installed. All executable verification used Node **22.23.1**, isolated HOME/config/cache/TMPDIR/PNPM_HOME, no-tracking settings and [offline preload](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/offline.cjs) denying sockets/TLS/HTTP(S)/datagrams/fetch; local IPC is permitted only below disposable TMPDIR. Exact override environment: [verification environment](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/verification-env.json). Active commands were limited to source edits, document materialization and read-only provenance/hash inspection.

[preservation manifest](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/continuation-preservation.json) confirms every baseline file outside the four touched source/test files retains its hash, no missing baseline files, byte-identical semantic index, byte-identical active suppression file, no clone suppression count increase, and exact preservation of the original test body (only imports changed before the appended tests). Accepted source hashes: [verified source](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/verified-source.json). Per-file incremental patches are retained next to the manifests; they describe this continuation work rather than the cumulative dirty checkout.

| File                                                                                                         | Before SHA-256                                                   | Accepted SHA-256                                                 |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| [Task.ts](../../src/core/task/Task.ts)                                                                       | f41ad40d8a39d169752d0337008653c1c949fe7febbad69adea02af79b1a0f00 | d53c5a290eee0a1d0fb9b370f732a56c010d6b8fbbee6482bcde542b756f06e0 |
| [TaskScheduler.ts](../../src/core/task/TaskScheduler.ts)                                                     | 2c74f1d445c291ee49c367ac5744269328d643cc64696b88b1decdd37f6e2f3d | dee317580e90e1065d4ebbc45411ceaf78f52aff3d01c84b17201a43f9fcbf9f |
| [ordinaryDelegationComposition.spec.ts](../../src/core/task/__tests__/ordinaryDelegationComposition.spec.ts) | 68fac1b99b96e1abb2c3612278bd0b7c9caa852738f933d578cd21bea60db7ea | 69dfd28ebc20af123951ee8099ab654f0882d699057d8d80dba3ae649997cb17 |
| [ClineProvider.ts](../../src/core/webview/ClineProvider.ts)                                                  | f64e70ba16092a2408a4fec9b13fcb4f68e74753578a654c7c71c0388da8ee75 | 8f3272329e3460c50922dfa53c7706d57a9efd33cb077dfae7c7707bf6133a7e |

## Exact verification commands

Every command below ran in the independent disposable copy with the recorded Node 22/offline environment. Each command record includes exact argv, cwd, exit and duration. [accepted command ledger](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/continuation-accepted-ledger.json) retains the complete accepted sequence. These direct Node invocations execute the existing declared tools/model stages without installation or changing package configuration.

### continuation-actual-prefix

Cwd: /tmp/zoo-ordinary-continuation-20261008-yucnn1hj/Zoo-Code/src. Exit: 1. [command](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/continuation-actual-prefix.command.json) / [output](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/continuation-actual-prefix.output.txt).

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-ordinary-continuation-20261008-yucnn1hj/Zoo-Code/src/node_modules/vitest/vitest.mjs run core/task/__tests__/ordinaryDelegationComposition.spec.ts -t 'actual post-child ordinary continuation' --maxWorkers=1 --reporter=default --no-silent
```

### continuation-invocation-negative

Cwd: /tmp/zoo-ordinary-continuation-20261008-yucnn1hj/Zoo-Code/src. Exit: 1. [command](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/continuation-invocation-negative.command.json) / [output](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/continuation-invocation-negative.output.txt).

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-ordinary-continuation-20261008-yucnn1hj/Zoo-Code/src/node_modules/vitest/vitest.mjs run core/task/__tests__/ordinaryDelegationComposition.spec.ts -t 'validation-to-invocation microtask gap' --maxWorkers=1 --reporter=default
```

### continuation-accepted-format-write

Cwd: /tmp/zoo-ordinary-continuation-20261008-yucnn1hj/Zoo-Code. Exit: 0. Duration: 2.17 s. [command](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/continuation-accepted-format-write.command.json) / [output](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/continuation-accepted-format-write.output.txt).

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-ordinary-continuation-20261008-yucnn1hj/Zoo-Code/node_modules/prettier/bin/prettier.cjs --write src/core/task/Task.ts src/core/task/TaskScheduler.ts src/core/webview/ClineProvider.ts src/core/task/__tests__/ordinaryDelegationComposition.spec.ts
```

### continuation-accepted-focused

Cwd: /tmp/zoo-ordinary-continuation-20261008-yucnn1hj/Zoo-Code/src. Exit: 0. Duration: 114.64 s. [command](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/continuation-accepted-focused.command.json) / [output](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/continuation-accepted-focused.output.txt).

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-ordinary-continuation-20261008-yucnn1hj/Zoo-Code/src/node_modules/vitest/vitest.mjs run core/task/__tests__/ordinaryDelegationComposition.spec.ts core/task/__tests__/TaskScheduler.spec.ts core/task/__tests__/Task.spec.ts core/task/__tests__/providerHandoff.spec.ts core/task/__tests__/pending-question.spec.ts core/task/__tests__/ordinaryPersistenceOwnership.spec.ts core/task/__tests__/manualSupersedeB1.startGuard.spec.ts core/task/__tests__/manualSupersedeB1.actualInstanceStart.spec.ts core/webview/__tests__/ordinaryCompletionOwnership.spec.ts __tests__/ClineProvider.delegation.spec.ts __tests__/ClineProvider.history-resume-delegation.spec.ts __tests__/delegation-concurrent.spec.ts __tests__/nested-delegation-resume.spec.ts __tests__/delegation-handoff-robustness.spec.ts --maxWorkers=1 --reporter=default
```

### continuation-accepted-source-types

Cwd: /tmp/zoo-ordinary-continuation-20261008-yucnn1hj/Zoo-Code/src. Exit: 0. Duration: 53.69 s. [command](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/continuation-accepted-source-types.command.json) / [output](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/continuation-accepted-source-types.output.txt).

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-ordinary-continuation-20261008-yucnn1hj/Zoo-Code/node_modules/typescript/bin/tsc --noEmit --pretty false
```

### continuation-accepted-public-types

Cwd: /tmp/zoo-ordinary-continuation-20261008-yucnn1hj/Zoo-Code/packages/types. Exit: 0. Duration: 12.26 s. [command](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/continuation-accepted-public-types.command.json) / [output](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/continuation-accepted-public-types.output.txt).

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-ordinary-continuation-20261008-yucnn1hj/Zoo-Code/node_modules/typescript/bin/tsc --noEmit --pretty false
```

### continuation-accepted-lint

Cwd: /tmp/zoo-ordinary-continuation-20261008-yucnn1hj/Zoo-Code/src. Exit: 0. Duration: 13.07 s. [command](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/continuation-accepted-lint.command.json) / [output](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/continuation-accepted-lint.output.txt).

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-ordinary-continuation-20261008-yucnn1hj/Zoo-Code/node_modules/eslint/bin/eslint.js --prune-suppressions --max-warnings=0 core/task/Task.ts core/task/TaskScheduler.ts core/webview/ClineProvider.ts core/task/__tests__/ordinaryDelegationComposition.spec.ts
```

### continuation-accepted-format-check

Cwd: /tmp/zoo-ordinary-continuation-20261008-yucnn1hj/Zoo-Code. Exit: 0. Duration: 2.12 s. [command](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/continuation-accepted-format-check.command.json) / [output](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/continuation-accepted-format-check.output.txt).

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-ordinary-continuation-20261008-yucnn1hj/Zoo-Code/node_modules/prettier/bin/prettier.cjs --check src/core/task/Task.ts src/core/task/TaskScheduler.ts src/core/webview/ClineProvider.ts src/core/task/__tests__/ordinaryDelegationComposition.spec.ts
```

### continuation-accepted-model-check-task-lifecycle.ts

Cwd: /tmp/zoo-ordinary-continuation-20261008-yucnn1hj/Zoo-Code. Exit: 0. Duration: 0.42 s. [command](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/continuation-accepted-model-check-task-lifecycle.ts.command.json) / [output](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/continuation-accepted-model-check-task-lifecycle.ts.output.txt).

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-ordinary-continuation-20261008-yucnn1hj/Zoo-Code/node_modules/tsx/dist/cli.mjs scripts/check-task-lifecycle.ts
```

### continuation-accepted-model-check-task-store-concurrency.ts

Cwd: /tmp/zoo-ordinary-continuation-20261008-yucnn1hj/Zoo-Code. Exit: 0. Duration: 7.5 s. [command](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/continuation-accepted-model-check-task-store-concurrency.ts.command.json) / [output](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/continuation-accepted-model-check-task-store-concurrency.ts.output.txt).

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-ordinary-continuation-20261008-yucnn1hj/Zoo-Code/node_modules/tsx/dist/cli.mjs scripts/check-task-store-concurrency.ts
```

### continuation-accepted-model-check-provider-handoff-scheduler.ts

Cwd: /tmp/zoo-ordinary-continuation-20261008-yucnn1hj/Zoo-Code. Exit: 0. Duration: 0.42 s. [command](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/continuation-accepted-model-check-provider-handoff-scheduler.ts.command.json) / [output](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/continuation-accepted-model-check-provider-handoff-scheduler.ts.output.txt).

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-ordinary-continuation-20261008-yucnn1hj/Zoo-Code/node_modules/tsx/dist/cli.mjs scripts/check-provider-handoff-scheduler.ts
```

### continuation-accepted-model-check-task-cleanup-protocol.ts

Cwd: /tmp/zoo-ordinary-continuation-20261008-yucnn1hj/Zoo-Code. Exit: 0. Duration: 5.39 s. [command](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/continuation-accepted-model-check-task-cleanup-protocol.ts.command.json) / [output](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/continuation-accepted-model-check-task-cleanup-protocol.ts.output.txt).

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-ordinary-continuation-20261008-yucnn1hj/Zoo-Code/node_modules/tsx/dist/cli.mjs scripts/check-task-cleanup-protocol.ts
```

### continuation-accepted-model-run-native-tool-call-parser-scoping.mjs

Cwd: /tmp/zoo-ordinary-continuation-20261008-yucnn1hj/Zoo-Code. Exit: 0. Duration: 0.52 s. [command](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/continuation-accepted-model-run-native-tool-call-parser-scoping.mjs.command.json) / [output](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/continuation-accepted-model-run-native-tool-call-parser-scoping.mjs.output.txt).

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node scripts/run-native-tool-call-parser-scoping.mjs
```

### continuation-accepted-model-check-completion-persistence.ts

Cwd: /tmp/zoo-ordinary-continuation-20261008-yucnn1hj/Zoo-Code. Exit: 0. Duration: 0.42 s. [command](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/continuation-accepted-model-check-completion-persistence.ts.command.json) / [output](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/continuation-accepted-model-check-completion-persistence.ts.output.txt).

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-ordinary-continuation-20261008-yucnn1hj/Zoo-Code/node_modules/tsx/dist/cli.mjs scripts/check-completion-persistence.ts
```

### continuation-accepted-model-check-delegated-mode-readers.ts

Cwd: /tmp/zoo-ordinary-continuation-20261008-yucnn1hj/Zoo-Code. Exit: 0. Duration: 0.37 s. [command](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/continuation-accepted-model-check-delegated-mode-readers.ts.command.json) / [output](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/continuation-accepted-model-check-delegated-mode-readers.ts.output.txt).

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-ordinary-continuation-20261008-yucnn1hj/Zoo-Code/node_modules/tsx/dist/cli.mjs scripts/check-delegated-mode-readers.ts
```

### continuation-accepted-model-check-pending-question.ts

Cwd: /tmp/zoo-ordinary-continuation-20261008-yucnn1hj/Zoo-Code. Exit: 0. Duration: 0.47 s. [command](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/continuation-accepted-model-check-pending-question.ts.command.json) / [output](../../../../../../../tmp/zoo-ordinary-continuation-20261008-yucnn1hj/continuation-accepted-model-check-pending-question.ts.output.txt).

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-ordinary-continuation-20261008-yucnn1hj/Zoo-Code/node_modules/tsx/dist/cli.mjs scripts/check-pending-question.ts
```

## Verification limits and parent handoff

- [N/A] Root rerun: explicitly forbidden. Parent completed one full root attempt with exit 1 / 108 failures at /tmp/zoo-ordinary-final-20261008-tqm1mn2l. That result is not replaced by focused green tests.
- [N/A] Other root failures, unrelated fixture work, live extension-host/webview E2E, restart/manual smoke, network/profile/API access, power-loss and noncooperative writers.
- [N/A] New models or state-space/budget changes: the existing handoff/scheduler model already expresses retained publication-to-invocation ownership and post-invocation phase splitting. Its provider locking/semaphore aspects remain abstractions; the actual composition tests above provide the concrete boundary evidence.
- Prior test-only followup evidence remains [ordinary-delegation-20261008-root-followup-evidence.md](ordinary-delegation-20261008-root-followup-evidence.md) (458 passed / 19 files and seven fixture repairs). This continuation adds no fixture changes outside the corresponding composition file and makes no complete-root green claim.

The accepted result is bounded offline ordinary-continuation correctness with retained ownership/permit/diagnostic controls. All unrelated dirty bytes, active suppressions and semantic index entries are preserved.
