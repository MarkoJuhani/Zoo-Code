# Ordinary delegation fixture evidence — 2026-10-08

Contract: ZOO-ORDINARY-DELEGATION-20261008. Bounded fixture-only child; **not a delegation/runtime repair or host-safety acceptance**.

## Ownership and baseline

- Read [project instructions](../../AGENTS.md:1), [lifecycle model](../architecture/task-lifecycle-model.md:1), [retained persistence evidence](ordinary-persistence-1021-implementation-evidence.md:248), and [parent code prompt](../../../../.roo/skills/audit-architecture/references/zoo-code-ordinary-delegation-20261008-code-prompt.md:1).
- Parent snapshot: [`before`](../../../../../../../tmp/zoo-ordinary-delegation-20261008-atop1b3v/before); manifest: [`baseline.json`](../../../../../../../tmp/zoo-ordinary-delegation-20261008-atop1b3v/baseline.json:1).
- HEAD `e18f931de70282a05c02fc5592e61b71c339a91f`; branch `weak_model_runtime_hardening`. Parent inventory: **51 staged / 35 unstaged / 19 untracked / 98 distinct dirty paths** (overlapping staged/unstaged counts).
- Baseline and immediate pre-edit workspace matched all 2948 regular-file hashes; no pre-existing source delta was reset, staged, cleaned, or replaced from HEAD.
- Exactly two existing paths changed: [provider fixture](../../src/__tests__/ClineProvider.delegation.spec.ts:1) and [task fixture](../../src/core/task/__tests__/Task.spec.ts:1). This document is the sole new workspace path. Hunks announced before candidate editing and before copying to the workspace.
- No production/store/scheduler/tool edits, integration regressions, dependency changes, configuration edits, or suppression-file edits. Parent owns runtime refinements and actual-composition regressions.

## Fixture repair, without assertion weakening

- [Provider fixture](../../src/__tests__/ClineProvider.delegation.spec.ts:78) now creates a fresh disposable root per test and initializes real stores. Seeds authoritative parent/awaited-child metadata; uses the real provider storage context and real authoritative reads. Every successful upsert/atomic update/delete forwards into the actual store, exclusions, file locks, merge checks and publication guards. Store watchers are disposed before deleting only the fixture-owned root.
- Existing scenario hooks retain fault injection, ordering gates and in-memory projections. Their return values never substitute for real publication; the real atomic updater still validates disk. The two deliberate stale/missing webview-cache cases override only the cache getter, not authoritative reads, store publication or guards. Two providers in the serialization test share the same disposable root and use separate actual store instances.
- Parent double gains the required pending-results array and awaited disposal method; child double and execution-context assertions remain unchanged.
- [Task storage mock](../../src/core/task/__tests__/Task.spec.ts:298) now preserves real storage exports. Filesystem doubles forward to actual I/O **only** under explicitly registered fixture-owned roots. Unrelated transcript doubles are retained. The actual-start and mention-processing constructor-start scenarios receive real provider stores/storage; no ownership/exclusion function is mocked or relaxed.
- The first post-state effect has an entry gate after real lease acquisition. Original clean-state/before-first-message assertions are unchanged and execute before releasing that effect. The constructor promise in the mention test is observed immediately with the same existing rejection disposition, then awaited before cleanup; this prevents delayed-handler noise, not suppression of runner errors.
- Compiler-AST comparison retained **74/74 provider assertions and 438/438 task assertions**, in exact order and with unchanged complete printed assertion ASTs. All **20/20 provider and 189/189 task suite/test declaration signatures** (including parameter matrices) match. These declaration counts are not expanded test counts. No tests skipped, assertions deleted/replaced, or matcher strength reduced. See [`assertion-preservation.json`](../../../../../../../tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/assertion-preservation.json:1).
- Scoped lint suppression bytes equal baseline: [`suppression-preservation.json`](../../../../../../../tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/suppression-preservation.json:1); no suppression count increase.

## Independent disposable execution and isolation

Executable tree: `/tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/Zoo-Code`; all test/type/lint/format subprocesses ran in its source package, never the active project.

Source is a physical copy of the parent before-snapshot; dependencies are separate physical copies from the prior child's retained installed dependency tree, **not execution in that child's tree**. Validation: **94,342 regular files / 5,489 links / 2,948 baseline source hashes / 17 dependency directories**, zero source/dependency hash mismatches, zero escaping links and zero shared regular-file inodes with either active project or prior child. See [`copy-validation.json`](../../../../../../../tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/copy-validation.json:1).

Installed runtime: Node **22.23.1**, selected explicitly by absolute executable and first on PATH. Fresh disposable home/config/cache/temp; inherited credentials/configuration were not passed. Environment and network-denial preload: [`verification-env.json`](../../../../../../../tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/verification-env.json:1), [`offline.cjs`](../../../../../../../tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/offline.cjs:1). Network attempts were blocked at socket/TLS/HTTP/HTTPS/fetch/DNS entry, with only disposable IPC permitted. **15 denied attempts**, kind `node:https.request`; no outbound network was permitted and no dependency installation occurred. Denials are retained in [`network-denials.txt`](../../../../../../../tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/network-denials.txt:1). This is process-level denial, not a kernel network-namespace proof.

No host launch/restart, live-state/profile/history/queue inspection or mutation, external model call, deployment, B1/B2 enablement, or lock repair/deletion was performed. Fixture cleanup removes only newly created disposable fixture roots after resource disposal.

## Reproduction and final results

| Lane                                           | Exit | Files / tests / unhandled errors                                                                                                                                                                                                       |
| ---------------------------------------------- | ---: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unchanged parent baseline, two selected suites |    1 | 2 failed files; **22 failed / 159 passed / 181 total**; **1 unhandled rejection**. Provider 21/21 fail (missing context, plus serialization timeout); Task 1 failed / 159 passed, missing storage export escapes failed ordering test. |
| Final same two selected suites                 |    1 | 1 failed / 1 passed file; **4 failed / 177 passed / 181 total**; **no unhandled-error section**. Task 160/160 pass; provider 17 pass / 4 fail.                                                                                         |
| Final six-suite focused lane                   |    1 | 1 failed / 5 passed files; **4 failed / 249 passed / 253 total**; **no unhandled-error section**. Provider 17/21; Task 160/160; tool 15/15; pending question 29/29; ordinary persistence 23/23; abandonment 5/5.                       |
| Final source typecheck                         |    0 | Declared source no-output check; no diagnostics.                                                                                                                                                                                       |
| Final scoped lint with suppression pruning     |    0 | Both changed fixtures; suppression file unchanged.                                                                                                                                                                                     |
| Copy-only formatting                           |    0 | Changed fixtures only; existing configuration unknown-option warning retained.                                                                                                                                                         |

Repeated lanes overlap and are **not additive**. No full-root run or model checker was executed by this fixture-only child; those are parent-owned.

### Retained intermediate failures and command corrections

1. First real-storage candidate: exit 1, **4 failed / 177 passed**, one unhandled missing-real-root rejection in the constructor-start mention scenario. This exposed a second obsolete storage fixture, repaired with real disposable storage and immediate observation of the original constructor promise.
2. First static invocations: each exit 1 before analysis, because TypeScript/ESLint entry points were incorrectly addressed under source dependencies. Corrected to the installed copied workspace-root links; no install/download attempted.
3. Attempted async scenario hook inside the actual store updater: source typecheck exit 2 (synchronous updater contract; read-only provider field assignment); scoped lint exit 0; selected tests exit 1, **17 failed / 164 passed / 181 total**, **2 unhandled errors**. Invalid candidate discarded: async gates moved before the actual synchronous mutation; successful mutations still use real guards/publication. Provider store assigned through a test fixture property descriptor. This was fixture experimentation, **not a new production reproduction**.
4. Corrected final static checks exit 0. Final two- and six-suite lanes retain four runtime assertion failures, without unhandled errors. All original failures/logs remain in disposable artifacts.
5. First documentation validation exited 1 for line-1 anchors into three intentionally empty successful-output files and checking the self-record before it was created. Filename-only anchors and write-before-revalidation corrected this; whitespace/index/hash checks in that attempt already passed. Retained [initial documentation validation](../../../../../../../tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/initial-evidence-validation.json:1).

### Four unresolved original runtime assertions

1. [Pending-action replacement](../../src/__tests__/ClineProvider.delegation.spec.ts:274): expects the older pending-action mismatch message, receives the broader owner/action/question-change refusal. This is a preserved error-surface mismatch, **not evidence that stale publication succeeds**.
2. [Atomic parent-write failure](../../src/__tests__/ClineProvider.delegation.spec.ts:860): original child-deletion assertion fails because deletion is never called.
3. [Initial-child metadata failure](../../src/__tests__/ClineProvider.delegation.spec.ts:1007): original disposal-before-delete order expects deletion; actual order contains disposal only.
4. [Initial parent-commit failure](../../src/__tests__/ClineProvider.delegation.spec.ts:1007): same preserved deletion/order mismatch after a prepared child was saved.

Current production deliberately preserves uncertain/prepared-child evidence. These three rollback expectations must be reconciled by the parent with truthful partial-commit semantics; **do not indiscriminately delete durable children to make tests green**. The child does not relabel these as storage-fixture errors or alter their assertions. Their first failing assertion prevents later assertions in those cases from executing; AST preservation does not imply all assertions were reached.

Fresh delegation ownership expiry (D1), scheduled question availability (D2), phase-correlated diagnostics (D3), actual presenter/scheduler composition and live usability remain parent-owned. Fixture-backed green cases do **not** prove those faults repaired. Historical #1021/#1469 witnesses and previous uncertainty/partial commits are unmodified. No native-crash or host-safety conclusion follows from normal test exits.

## Exact verification commands, cwd, exits and artifact hashes

Every command below used the isolated environment cited above. Common cwd: `/tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/Zoo-Code/src`. Executable paths resolve only into the own disposable copy, except the explicitly installed Node runtime.

### baseline-selected — exit 1

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/Zoo-Code/src/node_modules/vitest/vitest.mjs run __tests__/ClineProvider.delegation.spec.ts core/task/__tests__/Task.spec.ts --maxWorkers=1 --reporter=default
```

Command record: [`baseline-selected.command.json`](../../../../../../../tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/baseline-selected.command.json:1); output: [`baseline-selected.output.txt`](../../../../../../../tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/baseline-selected.output.txt:1). Output SHA-256: `7592336716cf23c93f45d7913c700ba7e6dee643af6c191ac3c4c8f94f5c3294`.

### fixture-candidate — exit 1

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/Zoo-Code/src/node_modules/vitest/vitest.mjs run __tests__/ClineProvider.delegation.spec.ts core/task/__tests__/Task.spec.ts --maxWorkers=1 --reporter=default
```

Command record: [`fixture-candidate.command.json`](../../../../../../../tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/fixture-candidate.command.json:1); output: [`fixture-candidate.output.txt`](../../../../../../../tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/fixture-candidate.output.txt:1). Output SHA-256: `bb3d91f90fb5d140c1e903ef77230bbbe9e3cbe9fd04e9dd08f86f03483c02d8`.

### fixture-typecheck-initial — exit 1

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/Zoo-Code/src/node_modules/typescript/bin/tsc --noEmit
```

Command record: [`fixture-typecheck-initial.command.json`](../../../../../../../tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/fixture-typecheck-initial.command.json:1); output: [`fixture-typecheck-initial.output.txt`](../../../../../../../tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/fixture-typecheck-initial.output.txt:1). Output SHA-256: `36046c48d9f0f3f0efadab81985c2f3f7aa4adaee94cd40e4cf36b63f9d4570d`.

### fixture-lint-initial — exit 1

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/Zoo-Code/src/node_modules/eslint/bin/eslint.js --prune-suppressions --max-warnings=0 __tests__/ClineProvider.delegation.spec.ts core/task/__tests__/Task.spec.ts
```

Command record: [`fixture-lint-initial.command.json`](../../../../../../../tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/fixture-lint-initial.command.json:1); output: [`fixture-lint-initial.output.txt`](../../../../../../../tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/fixture-lint-initial.output.txt:1). Output SHA-256: `9669709513c193308cd4a239f4d35d363de4099d14fbb86cf58702ef6ba43ef6`.

### fixture-typecheck-candidate — exit 2

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/Zoo-Code/node_modules/typescript/bin/tsc --noEmit
```

Command record: [`fixture-typecheck-candidate.command.json`](../../../../../../../tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/fixture-typecheck-candidate.command.json:1); output: [`fixture-typecheck-candidate.output.txt`](../../../../../../../tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/fixture-typecheck-candidate.output.txt:1). Output SHA-256: `efe2a0a4781145c25165ef2cd430f6319b05956800b227c738e8e8154faf5e3e`.

### fixture-lint-candidate — exit 0

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/Zoo-Code/node_modules/eslint/bin/eslint.js --prune-suppressions --max-warnings=0 __tests__/ClineProvider.delegation.spec.ts core/task/__tests__/Task.spec.ts
```

Command record: [`fixture-lint-candidate.command.json`](../../../../../../../tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/fixture-lint-candidate.command.json:1); output: [`fixture-lint-candidate.output.txt`](../../../../../../../tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/fixture-lint-candidate.output.txt). Output SHA-256: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

### fixture-selected-refined — exit 1

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/Zoo-Code/src/node_modules/vitest/vitest.mjs run __tests__/ClineProvider.delegation.spec.ts core/task/__tests__/Task.spec.ts --maxWorkers=1 --reporter=default
```

Command record: [`fixture-selected-refined.command.json`](../../../../../../../tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/fixture-selected-refined.command.json:1); output: [`fixture-selected-refined.output.txt`](../../../../../../../tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/fixture-selected-refined.output.txt:1). Output SHA-256: `f16be0eb743d7490f4894e25ef6115c8d0f25981c7ac1b83836442f5d4eef6f1`.

### fixture-format — exit 0

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/Zoo-Code/node_modules/prettier/bin/prettier.cjs --write __tests__/ClineProvider.delegation.spec.ts core/task/__tests__/Task.spec.ts
```

Command record: [`fixture-format.command.json`](../../../../../../../tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/fixture-format.command.json:1); output: [`fixture-format.output.txt`](../../../../../../../tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/fixture-format.output.txt:1). Output SHA-256: `528c978bc1aa51b1d8526c603f28ee4ca7dcb816787165d67c43a6dcad8856bb`.

### fixture-typecheck-final — exit 0

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/Zoo-Code/node_modules/typescript/bin/tsc --noEmit
```

Command record: [`fixture-typecheck-final.command.json`](../../../../../../../tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/fixture-typecheck-final.command.json:1); output: [`fixture-typecheck-final.output.txt`](../../../../../../../tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/fixture-typecheck-final.output.txt). Output SHA-256: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

### fixture-lint-final — exit 0

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/Zoo-Code/node_modules/eslint/bin/eslint.js --prune-suppressions --max-warnings=0 __tests__/ClineProvider.delegation.spec.ts core/task/__tests__/Task.spec.ts
```

Command record: [`fixture-lint-final.command.json`](../../../../../../../tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/fixture-lint-final.command.json:1); output: [`fixture-lint-final.output.txt`](../../../../../../../tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/fixture-lint-final.output.txt). Output SHA-256: `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

### fixture-selected-final — exit 1

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/Zoo-Code/src/node_modules/vitest/vitest.mjs run __tests__/ClineProvider.delegation.spec.ts core/task/__tests__/Task.spec.ts --maxWorkers=1 --reporter=default
```

Command record: [`fixture-selected-final.command.json`](../../../../../../../tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/fixture-selected-final.command.json:1); output: [`fixture-selected-final.output.txt`](../../../../../../../tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/fixture-selected-final.output.txt:1). Output SHA-256: `e60ddfdbb39381e7642a519d85f4db916955c7f884b629962e760d1af31d74c3`.

### fixture-focused-six — exit 1

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/Zoo-Code/src/node_modules/vitest/vitest.mjs run core/tools/__tests__/newTaskTool.spec.ts __tests__/ClineProvider.delegation.spec.ts core/task/__tests__/Task.spec.ts core/task/__tests__/pending-question.spec.ts core/task/__tests__/ordinaryPersistenceOwnership.spec.ts core/webview/__tests__/ordinaryAbandonmentPersistence.spec.ts --maxWorkers=1 --reporter=default
```

Command record: [`fixture-focused-six.command.json`](../../../../../../../tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/fixture-focused-six.command.json:1); output: [`fixture-focused-six.output.txt`](../../../../../../../tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/fixture-focused-six.output.txt:1). Output SHA-256: `61af1178eb12db1abb71ff72dc033eca500f65eb21bbbd3f4b1ca28bba2aab5d`.

## Preservation and scope verification

- All **2946 other baseline regular-file hashes** and **6 source-directory links** match parent baseline. Immediate write-turn validation found zero out-of-scope changes; [application record](../../../../../../../tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/fixture-application-preservation.json:1).
- Status provenance: parent inventory has 98 dirty paths; this child began with 100 because the completion child had already added two untracked paths. Final inventory has 103; only the two authorized fixture statuses and this new document were added relative to child start. The pre-existing completion evidence/test were not created or edited by this child. No initial status entry was removed.
- All semantic index entries are byte-identical. SHA-256 of `git ls-files --stage -z` output: `56ec157367711932aaf1a7b16d3693940944ce64a75245d6965c0ad7086cda91`. No Git index write operation used.
- Tested fixture bytes exactly match workspace fixture bytes. Incremental deltas preserve parent dirty source as their input, not HEAD.

| Authorized existing path                                                                     | Before SHA-256                                                     | Final SHA-256                                                      |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| [`ClineProvider.delegation.spec.ts`](../../src/__tests__/ClineProvider.delegation.spec.ts:1) | `9f816ca2b7900c4e79a9668a9dade46343e58b08ebec0642acde80f55f0cfb5a` | `cd704032d3fdf98a42df0ee70d7863d5a5605b2e3b24099b62a3f588c091fc6e` |
| [`Task.spec.ts`](../../src/core/task/__tests__/Task.spec.ts:1)                               | `f93ed6e3cc25208caa6375b63d08fe9943c273fdc5bf111d2f93fb735a9f630c` | `740cfc880147582702c70b8b503c427b7996e34420cf9fd63c3b79dcab628803` |

Additional durable manifests: [`verification-commands.json`](../../../../../../../tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/verification-commands.json:1), [`final-preservation-before-evidence.json`](../../../../../../../tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/final-preservation-before-evidence.json:1). This document's own SHA-256 and final whitespace/link/index checks are recorded in [`final-evidence-validation.json`](../../../../../../../tmp/zoo-ordinary-fixtures-20261008-y5iusfx_/final-evidence-validation.json:1) to avoid a self-referential digest.

Exact non-executable workspace verification: `git -C projects/Zoo-Code diff --check`; bounded Python baseline/index/hash/link validation and TypeScript-compiler AST assertion comparison (records above). No active-project tests, lint, builds or typechecks were run. Scoped lint was invoked directly with the copied installed executable and declared flags rather than a package-manager bootstrap.

[N/A] full root test run; lifecycle/model checks; source/types-wide root checks; actual composition regressions; host/restart smoke; deployment/release/B1/B2; power-loss/crash guarantees; live saved-state repair; default-concurrency safety; whole-repository stability. Parent retains responsibility for those required runtime lanes.

**IMPLEMENTATION_REQUIRED** — fixture repair completed with unchanged assertions, but four original delegation runtime assertions remain red and D1/D2/D3 are not repaired or accepted by this subtask.
