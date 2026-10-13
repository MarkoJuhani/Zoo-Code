# Ordinary delegation D1/D2 phase evidence — 2026-10-08

## Scope and provenance

Implemented assignment steps 1–3 inside the three authorized production files, plus one new corresponding task integration suite. No provider, delegation-tool, follow-up-tool, completion, reducer, checker, model-budget, configuration, dependency-manifest, changelog or index edits were made by this child.

Read the [repository guidance](../../AGENTS.md:48), [lifecycle model report](../architecture/task-lifecycle-model.md:1), and [historical implementation evidence](ordinary-persistence-1021-implementation-evidence.md:1). Their negative findings, partial-publication outcomes, root-run deviations, original models and historical witnesses remain unchanged. This evidence is additive, not a replacement or whole-repository acceptance.

Revision: e18f931de70282a05c02fc5592e61b71c339a91f; branch weak_model_runtime_hardening. Final pre-document inventory: **51 staged / 37 unstaged / 23 untracked / 104 distinct dirty paths**, overlapping counts. Adding this document adds one untracked/distinct path. Semantic index entries match both the supplied parent baseline and this child's baseline.

The supplied parent baseline and original production bytes are retained under the independent parent snapshot; see [source-before.json](../../../../../../../tmp/zoo-phase-split-20261008-_feb_vij/source-before.json) and [phase-incremental-manifest.json](../../../../../../../tmp/zoo-phase-split-20261008-_feb_vij/phase-incremental-manifest.json). The latter enumerates incremental hunks rather than cumulative HEAD changes. All existing retained test assertions and fixtures are untouched by this child. The already-repaired delegation/constructor fixtures are retained; their remaining four failures are not suppressed.

| Authorized file                                                                                                | Before SHA-256                                                   | After SHA-256                                                    | Incremental lines |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------- |
| [`Task.ts`](../../src/core/task/Task.ts)                                                                       | 9cc8e867314c5c6843e0db8d08f58192ea69606f542bc0948aa6f4cb292ef55f | f41ad40d8a39d169752d0337008653c1c949fe7febbad69adea02af79b1a0f00 | +109/-44          |
| [`TaskScheduler.ts`](../../src/core/task/TaskScheduler.ts)                                                     | 6a6b5051d69d124f473e125b48db6e3cd7484a1a88e2271df97cc59849121fd6 | 2c74f1d445c291ee49c367ac5744269328d643cc64696b88b1decdd37f6e2f3d | +12/-3            |
| [`targetPersistenceBoundary.ts`](../../src/core/task-persistence/targetPersistenceBoundary.ts)                 | 02ff3b9ce61da358d45a9a97512398faa2156bb0bcedbd58aa4bcadabbeb6805 | bf919c031e4c67009a15a0d6db07851ed147d3bc98f66c4e4608f6ae82c5be45 | +46/-8            |
| [`ordinaryDelegationComposition.spec.ts`](../../src/core/task/__tests__/ordinaryDelegationComposition.spec.ts) | new                                                              | 36f3a9784699cc9b119cf7c07e59b202527ef535d33d6b89967dc58aba3c604c | +449/-0           |

Outside-child differences observed during final preservation checks: two active generated distribution files changed relative to the initial manifest. This child neither wrote nor restored them. No claim is made about their producer or semantic validity. All retained model scripts, original source witnesses, provider/tool files, existing test files, completion-child test and lint suppression bytes match this child's starting hashes. No staging/reset/clean occurred.

## Independently copied verification boundary

Disposable root: /tmp/zoo-phase-split-20261008-\_feb_vij; current dirty source overlaid on a physically independent copy of the completion child's dependency/source template. Initial validation: **98,362 regular files, 5,499 links, zero shared template-file inodes, zero escaping links, zero source-hash mismatches**. Source-directory links stay within the copy. An installed pnpm 10.8.1 distribution was later physically copied into this root; no installation/Corepack download was used.

Every executable check used installed Node **22.23.1**, disposable HOME/config/cache/TMPDIR/PNPM_HOME, CI/no-tracking settings and a preload that denies network sockets, TLS, HTTP(S), datagrams and fetch; local IPC is allowed only below disposable TMPDIR. Test setup independently denies network. Commands and outputs remain in disposable storage. Three denied network operations were observed in the bounded root run; that lane is not network/live-host evidence. No extension-host launch/restart, model request, real saved-profile/task/queue access, lock repair, B1/B2 enablement or deployment was performed.

Physical copy validation: [copy-validation.json](../../../../../../../tmp/zoo-phase-split-20261008-_feb_vij/copy-validation.json). Environment: [verification-env.json](../../../../../../../tmp/zoo-phase-split-20261008-_feb_vij/verification-env.json). No active-project test/lint/type/model/package-manager execution occurred. Active Git reads and source-hash checks were provenance inspection only.

## Actual pre-fix reproduction

The corrected pre-fix suite executed the **actual scheduler, constructed Task, actual Task model-loop orchestrator, detached Task presenter, real delegation tool, provider transition/registry teardown, real disposal and TaskHistoryStore/file writers**. Only VS Code/MCP activation/config/UI, controller mechanics, checkpoint service and the external model turn were doubled. Provider construction uses a structural activation-free shell; its public delegation transition, registry teardown, persistence and commit code are actual production. This is not real extension-host coverage and not a tool mock or prototype-only Task.

The offline turn records an actual native assistant tool call through Task persistence, then invokes the production safe presenter. Disposal gating is a passthrough interception of the real command-output cleanup: real cleanup runs, then its last return is gated. The parent run observes abort, its original model loop settles, and the test waits for scheduler owner settlement while provider delegation is still awaiting teardown. Pre-fix, the parent fence can be independently acquired before the gate opens. After opening the gate, no child is created.

The corrected proof is [prefix-proof.command.json](../../../../../../../tmp/zoo-phase-split-20261008-_feb_vij/prefix-proof.command.json) and [prefix-proof.output.txt](../../../../../../../tmp/zoo-phase-split-20261008-_feb_vij/prefix-proof.output.txt): **3 failed / 0 passed, exit 1, no unhandled errors**. One negative-control assertion also incorrectly required explicit active status when fresh-root status is omitted; that fixture mismatch was corrected without removing recovery/action assertions. Earlier setup runs are retained separately and are not counted as ownership proof.

Exact original fault source: [expired provider assertion](../../../../../../../tmp/zoo-ordinary-delegation-20261008-atop1b3v/before/src/core/task-persistence/targetPersistenceBoundary.ts:214) (original parent snapshot line 214) and inherited final-writer validation (original snapshot line 226). Production hashes in the pre-fix command match the parent before snapshot: boundary 02ff3b9ce61da358d45a9a97512398faa2156bb0bcedbd58aa4bcadabbeb6805; Task 9cc8e867314c5c6843e0db8d08f58192ea69606f542bc0948aa6f4cb292ef55f; scheduler 6a6b5051d69d124f473e125b48db6e3cd7484a1a88e2271df97cc59849121fd6.

Captured source-backed failure, with no prompt/credential data:

```text
[new_task] parent_flush_end task=parent saved=true
[Task#dispose] disposing task parent.<instance>
OrdinaryPersistenceAuthorityError: Ordinary persistence authority refused: Provider start exclusion expired
  expired inherited ownership refused at original boundary line 214
  delegation refused after teardown at original provider line 4123
```

Final-write refusal also occurred through the original line-226 inherited-generation check. The ungated pre-fix control similarly failed child creation/start. These observations reproduce the reported narrower symptom: child creation never happens; enqueue or provider return is not a child-start claim.

## Call graph and implementation

Original: scheduler permit → lifetime start exclusion → ordinary authority context → Task run/start → lifetime startup exclusion → model loop → fire-and-forget presenter → delegation tool → serialized provider transition reusing inherited guard → flush → remove/abort → detached disposal → child preparation/save → parent commit → enqueue. Abort lets the original run settle before provider teardown/commit. The model-loop owner previously released the guard while capable descendants still inherited it.

1. [Provider exclusion](../../src/core/task-persistence/targetPersistenceBoundary.ts:162) now **registers inherited effects synchronously before root-resolution await**, drains joined descendants on both successful and throwing owner paths, then checks ownership before release. Registration occurs before an abort can settle the original loop. Detached capable effects do not release the lease early. A late effect that merely inherits an inactive guard still refuses. Explicit fresh work acquires a genuinely new lease; active inherited fresh reacquisition refuses immediately rather than deadlocking. No timeout/budget inflation, fail-open renewal or age theft.
2. [Scheduler](../../src/core/task/TaskScheduler.ts:39) now has an explicit **no-runner ordinary orchestration entry**. The semaphore still tracks the whole run promise. [Ordinary admission](../../src/core/task/Task.ts:2735) uses only a bounded fresh authority preflight; original start/fence timeout policies remain unchanged. Queued execution is independent of its enqueuer's async scopes, without releasing the enqueuer's lease. **Supplied arbitrary callbacks remain protected through their final effects**. Escaping a store mutex is prohibited.
3. [Startup](../../src/core/task/Task.ts:2770) and [history resume](../../src/core/task/Task.ts:2848) validate immutable authority before their first capable effect, prepare under a start fence, and return the loop continuation. [Loop admission](../../src/core/task/Task.ts:3620) awaits checkpoint initialization and start publication; the [loop body](../../src/core/task/Task.ts:3646) runs outside the workflow's capable lease. Existing outer arbitrary scopes are never surrendered.
4. [Fresh follow-up](../../src/core/task/Task.ts:1756) now checks independent orchestration, prepares under exact ordinary/start authority, releases that preparation phase, and waits. Existing independent idle-status publishers reacquire/revalidate exact question and authority before their final webview effect. [Answer result delivery](../../src/core/task/Task.ts:598) reacquires exact authority/question before feedback durability. Follow-up tool bytes did not need changes.
5. [Saved-question resume](../../src/core/task/Task.ts:651) reacquires exact Task revision/lineage/question for continuation, commits a single native correlated result under authority, then admits the next loop and waits outside the lease. The pending question clears only after durable result publication. A stale externally answered instance remains sticky-refused; all three durable files remain byte-identical in the scheduler regression.

No lifecycle reducer transition was added. Existing abstract models do not execute [async-context](../../src/core/task-persistence/targetPersistenceBoundary.ts:5) guard lifetime, detached presenter/disposal, or externally invoked answer callbacks. The new actual composition suite supplies bounded refinement evidence for those boundaries; the abstract models and their original witnesses/budgets were not silently changed.

## Final regressions and remaining reproduced provider blockers

[New composition suite](../../src/core/task/__tests__/ordinaryDelegationComposition.spec.ts:1): **10 tests, 8 passed / 2 failed**. Passing cases cover both capable-callback and no-runner gated last disposal, ungated handoff, actual child admission/start/settlement, fresh external answer, saved external answer with exactly one native result and no lease during the paused loop, arbitrary capable-callback protection, immediate active fresh refusal, and immutable-revision stale external-answer rejection. Real root, real Task instances, real scheduler permits and real disk store are used throughout.

The two failures intentionally remain ordinary integration regressions, not skips/expected-failure markers:

- **Default provider scheduling still uses a supplied callback**, so the fresh full-question waiter is refused under the lifetime callback fence. Change the parent-owned [scheduling helper](../../src/core/webview/ClineProvider.ts:185): when no explicit runner was supplied, call the new scheduler entry with an absent runner; when a custom runner is supplied, retain its capable-callback protection and observer-stage routing. Do not blanket-remove callback protection. The fixture's provider default path executes the real helper, so this failure is not masked by the new API.
- **Pre-child teardown failure leaves the registry/UI empty** while authoritative parent/action evidence is still recoverable and no child has been saved or scheduled. Extend the parent-owned [delegation teardown](../../src/core/webview/ClineProvider.ts:4120) into guarded failure restoration: recheck ownership/generation and authoritative parent identity, retain its pending action, publish no child, and reconstruct the same parent with startup disabled only when ownership has not moved. Restoration itself must remain inside the live parent exclusion through its last effect. Preserve unknown/partially committed evidence and never delete a prepared/committed child merely to satisfy legacy deletion assertions.

Parent additionally owns diagnostics sink correlation and separate completion repair. This child made **no provider or completion changes**. Remaining four delegation fixture failures concern pending-action mismatch wording and obsolete child-deletion expectations under truthful partial-commit preservation; the final selected run retains all four. Do not label them resolved or erase their assertions here. The completion-child premature transcript-correlation regression remains outside this child's implementation and was not used as a prerequisite.

## Verification results and limits

Final selected suite: **9 files; 7 passed / 2 failed; 278 tests passed / 6 failed; zero unhandled errors; exit 1**. Six failures are the four retained delegation-fixture failures and the two reproduced provider integration blockers. No existing safety assertion was weakened. Existing pending-question 29/29, ordinary-authority 23/23, scheduler 20/20, real-instance start 8/8, start/binding guard 6/6, Task fixture 160/160 and provider handoff 7/7 pass. Counts overlap earlier runs and must not be added together.

Final source and types-package checks, scoped ESLint prune/max-warnings and Prettier check: each exit 0. Suppression bytes unchanged. Model stages: all eight exit 0, original witnesses/bounds intact: lifecycle 89 states; historical store 625 plus current ordinary authority 24,540; provider/scheduler 104 with 6/6 legacy counterexamples; cleanup 96,174; parser 924/924; completion 88; delegated-mode readers four pairs/5 modes; pending question seven states. Model passes do not close the two actual provider integration faults.

Single root run: declared pnpm test wrapper using copied pnpm 10.8.1, Turbo concurrency one and continue-on-failure, network denied. It **did not complete** within the 480-second bound; process group received intentional SIGTERM, outer exit -15. Completed printed lanes: CLI 565 passed/1 skipped (38 passed/1 skipped files), core 149/15, VS Code shim 407/22 and telemetry 49/4. Root printed 8/12 successful tasks before termination, not a final verdict. Extension and webview full counts are unavailable; no complete-root or default-concurrency safety claim. This run preceded the final authority-preflight refinement; later final-source focused/static checks are enumerated separately. No second root rerun was attempted.

Intermediate failures are retained: one final admission patch attempt failed its text-match assertion before any write; its corrected hunk subsequently passed final checks; initial fixture lacked model metadata/checkpoint export; one attempted combined command was blocked by ignore rules before mutation; one stronger whole-phase authority experiment produced a retained test-seam timeout and one unhandled stale-lineage rejection; it was narrowed to the preflight now tested. Final-source run has no unhandled errors. The intermediate rejection is not relabeled as a host crash. No SIGSEGV/signal-11/exit-139 was captured. The root SIGTERM is an explicit verification bound, not evidence of a crash.

[N/A] live-host smoke/restart, real saved-state/profile repair, model/network requests, deployment/release/B1/B2, completed full-root final-source verification, power-loss/crash durability, whole-repository acceptance, default-concurrency safety, complete completion refinement, and parent diagnostics sink tests.

## Exact executable commands

All command records below are Node22 execution **inside the independent disposable copy**. All other verification is [N/A] except read-only source/index/hash inspection and direct document validation. Exact retained output/argv ledger: [phase-validation-ledger.json](../../../../../../../tmp/zoo-phase-split-20261008-_feb_vij/phase-validation-ledger.json); final commands are individually retained next to their outputs.

### prefix-proof

Cwd: /tmp/zoo-phase-split-20261008-\_feb_vij/Zoo-Code/src. Exit: 1. Runtime: Node 22.23.1.

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-phase-split-20261008-_feb_vij/Zoo-Code/src/node_modules/vitest/vitest.mjs run core/task/__tests__/ordinaryDelegationComposition.spec.ts --maxWorkers=1 --reporter=default --no-silent
```

### phase-release-focused

Cwd: /tmp/zoo-phase-split-20261008-\_feb_vij/Zoo-Code/src. Exit: 1. Runtime: Node 22.23.1.

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-phase-split-20261008-_feb_vij/Zoo-Code/src/node_modules/vitest/vitest.mjs run core/task/__tests__/ordinaryDelegationComposition.spec.ts core/task/__tests__/TaskScheduler.spec.ts core/task/__tests__/manualSupersedeB1.startGuard.spec.ts core/task/__tests__/manualSupersedeB1.actualInstanceStart.spec.ts core/task/__tests__/pending-question.spec.ts core/task/__tests__/ordinaryPersistenceOwnership.spec.ts core/webview/__tests__/ClineProvider.delegation.spec.ts core/task/__tests__/Task.spec.ts core/task/__tests__/providerHandoff.spec.ts __tests__/ClineProvider.delegation.spec.ts --maxWorkers=1 --reporter=default
```

### composition-bounded-final

Cwd: /tmp/zoo-phase-split-20261008-\_feb_vij/Zoo-Code/src. Exit: 1. Runtime: Node 22.23.1.

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-phase-split-20261008-_feb_vij/Zoo-Code/src/node_modules/vitest/vitest.mjs run core/task/__tests__/ordinaryDelegationComposition.spec.ts --maxWorkers=1 --reporter=default
```

### phase-release-types

Cwd: /tmp/zoo-phase-split-20261008-\_feb_vij/Zoo-Code/src. Exit: 0. Runtime: Node 22.23.1.

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-phase-split-20261008-_feb_vij/Zoo-Code/node_modules/typescript/bin/tsc --noEmit --pretty false
```

### phase-release-lint

Cwd: /tmp/zoo-phase-split-20261008-\_feb_vij/Zoo-Code/src. Exit: 0. Runtime: Node 22.23.1.

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-phase-split-20261008-_feb_vij/Zoo-Code/node_modules/eslint/bin/eslint.js --prune-suppressions --max-warnings=0 core/task/Task.ts core/task/TaskScheduler.ts core/task-persistence/targetPersistenceBoundary.ts core/task/__tests__/ordinaryDelegationComposition.spec.ts
```

### phase-release-format

Cwd: /tmp/zoo-phase-split-20261008-\_feb_vij/Zoo-Code. Exit: 0. Runtime: Node 22.23.1.

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-phase-split-20261008-_feb_vij/Zoo-Code/node_modules/prettier/bin/prettier.cjs --check src/core/task/Task.ts src/core/task/TaskScheduler.ts src/core/task-persistence/targetPersistenceBoundary.ts src/core/task/__tests__/ordinaryDelegationComposition.spec.ts
```

### phase-model-check-task-lifecycle.ts

Cwd: /tmp/zoo-phase-split-20261008-\_feb_vij/Zoo-Code. Exit: 0. Runtime: Node 22.23.1.

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-phase-split-20261008-_feb_vij/Zoo-Code/node_modules/tsx/dist/cli.mjs scripts/check-task-lifecycle.ts
```

### phase-model-check-task-store-concurrency.ts

Cwd: /tmp/zoo-phase-split-20261008-\_feb_vij/Zoo-Code. Exit: 0. Runtime: Node 22.23.1.

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-phase-split-20261008-_feb_vij/Zoo-Code/node_modules/tsx/dist/cli.mjs scripts/check-task-store-concurrency.ts
```

### phase-model-check-provider-handoff-scheduler.ts

Cwd: /tmp/zoo-phase-split-20261008-\_feb_vij/Zoo-Code. Exit: 0. Runtime: Node 22.23.1.

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-phase-split-20261008-_feb_vij/Zoo-Code/node_modules/tsx/dist/cli.mjs scripts/check-provider-handoff-scheduler.ts
```

### phase-model-check-task-cleanup-protocol.ts

Cwd: /tmp/zoo-phase-split-20261008-\_feb_vij/Zoo-Code. Exit: 0. Runtime: Node 22.23.1.

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-phase-split-20261008-_feb_vij/Zoo-Code/node_modules/tsx/dist/cli.mjs scripts/check-task-cleanup-protocol.ts
```

### phase-model-run-native-tool-call-parser-scoping.mjs

Cwd: /tmp/zoo-phase-split-20261008-\_feb_vij/Zoo-Code. Exit: 0. Runtime: Node 22.23.1.

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node scripts/run-native-tool-call-parser-scoping.mjs
```

### phase-model-check-completion-persistence.ts

Cwd: /tmp/zoo-phase-split-20261008-\_feb_vij/Zoo-Code. Exit: 0. Runtime: Node 22.23.1.

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-phase-split-20261008-_feb_vij/Zoo-Code/node_modules/tsx/dist/cli.mjs scripts/check-completion-persistence.ts
```

### phase-model-check-delegated-mode-readers.ts

Cwd: /tmp/zoo-phase-split-20261008-\_feb_vij/Zoo-Code. Exit: 0. Runtime: Node 22.23.1.

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-phase-split-20261008-_feb_vij/Zoo-Code/node_modules/tsx/dist/cli.mjs scripts/check-delegated-mode-readers.ts
```

### phase-model-check-pending-question.ts

Cwd: /tmp/zoo-phase-split-20261008-\_feb_vij/Zoo-Code. Exit: 0. Runtime: Node 22.23.1.

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-phase-split-20261008-_feb_vij/Zoo-Code/node_modules/tsx/dist/cli.mjs scripts/check-pending-question.ts
```

### phase-root-test

Cwd: /tmp/zoo-phase-split-20261008-\_feb_vij/Zoo-Code. Exit: -15. Runtime: Node 22.23.1.

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-phase-split-20261008-_feb_vij/pnpm/bin/pnpm.cjs test --concurrency=1 --continue
```

### phase-types-package

Cwd: /tmp/zoo-phase-split-20261008-\_feb_vij/Zoo-Code/packages/types. Exit: 0. Runtime: Node 22.23.1.

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-phase-split-20261008-_feb_vij/Zoo-Code/node_modules/typescript/bin/tsc --noEmit --pretty false
```

## Final conditional offline verdict

**IMPLEMENTATION_REQUIRED** — D1 ownership expiry is repaired and phase-scoped scheduler/question paths have actual bounded proof, but the current provider default scheduling and teardown recovery faults remain reproduced in final-source tests. Parent integration, diagnostics and the separate completion repair remain required. No live-host viability claim.
