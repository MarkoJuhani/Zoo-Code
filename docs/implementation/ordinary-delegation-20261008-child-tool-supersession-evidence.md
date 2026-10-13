# Delegated child tool supersession — manual-fault repair

Date: 2026-10-08. OFFLINE_ONLY. Followed the [manual-testing guideline](ordinary-delegation-manual-testing-next-chat-prompt.md:1); historical reports and negative findings remain unchanged.

## 1. Reported evidence and issue classification

- Priority clarified by the user: the security-auditor child reported “The order-action file read was superseded and returned no content.” An earlier report also described an audit command superseded before returning results.
- Supplied export: [diagnostic export](../../../../../../../tmp/zoo-handoff-audit-20261008-veimqbe2/../zoo-diagnostics-01a11bff-1791471168671.json:1). SHA-256 d47ff9e956daf12692d586767da150e6770f27aa428be041d87d9eed8146d7dd; JSON preceded by comments. Version 3.82.2, error time 2026-10-08T14:52:48.665Z, Europe/Helsinki UTC+03:00. This export contains the earlier parent timeout, not the later security-auditor child incident; no child-read supersession was found in its structural/error-category inspection.
- Supplied later parent: 01a11c66-6639-74d6-99f6-ddc13a80cf34; delegation action call_378e46d3142f4204903877d603fce060. The boundary record says ready=false, locked=true, abort=true, abandoned=true. These flags can occur during intentional delegation teardown; this record alone does not establish loss of a child read or durable handoff success.
- Supplied stream-error Task: 01a11c86-62ea-722c-ac46-350dd85f3b15, instance 43270990, provider termination followed by retry. Its precise relationship to the auditor read is UNKNOWN. Scheduler admitted/started observations are not durable publication or success evidence; an inactive inherited diagnostic context alone is not execution authority.
- Linux 6.18, shell /bin/sh; development bundle stack under the project checkout. Editor edition/version, loaded revision, exact child-read action, fresh/reopened state, complete sequential/nested lineage, lock owner/generation, and whether any history was missing/duplicated/wrong-owner remain UNKNOWN. No real task directory, profile, queue, or lock was inspected.

| Reported issue                                 | Classification                         | Scope and remaining evidence                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Superseded child file read/no content          | **Reproduced-and-fixed offline**       | Actual child Task/native presenter/read handler/scheduler/disposable persistence reproduces an incorrectly superseded read. Exact historical incident remains evidence-limited because its child export was not supplied.                                                                                                                                                                          |
| Audit command superseded                       | **Evidence-limited**                   | The repaired child-text publication can supersede any pending ordinary approval, including commands. This unit executes real reads, not a terminal audit command; no independent command-execution closure claim. Next scope: the child command/action excerpt and an actual terminal-boundary regression if it persists on confirmed fixed bytes.                                                 |
| Later parent-fence timeout/unhandled rejection | **Evidence-limited**                   | Prior [timeout repair](ordinary-delegation-20261008-parent-fence-timeout-evidence.md:16) is preserved and its regression passes. The supplied stack does not identify the later lock holder or detached promise consumer. No timeout inflation, retry, uncertain lock deletion, or arbitrary lease surrender. Next scope: exact loaded-build identity and bounded correlated phase/error evidence. |
| Provider terminated stream                     | **Evidence-limited**                   | A transport failure with the existing retry path, not proof that a file read failed. No provider/network request was made. Next scope: correlate termination with the precise child tool action and request attempt.                                                                                                                                                                               |
| Editor Git pathspec inside submodule           | **Evidence-limited for Zoo causation** | Supplied stack originates in the editor's built-in Git extension. The parent repository cannot use that submodule-internal pathspec. This is not the superseded-approval exception. No unrelated repository, submodule, or editor Git installation was modified.                                                                                                                                   |

## 2. Actual path and runtime repair

The child request loop suppresses live text presentation while accumulating streamed assistant text. Native tool calls can nevertheless dispatch before stream finalization. The read handler creates an owned tool approval and waits for its response. Finalization subsequently publishes the accumulated child text. Before this repair that publication updated the task's latest-message timestamp; the waiting read interpreted this as supersession and returned a correlated error instead of file content.

Source mapping: child text accumulation at [src/core/task/Task.ts](../../src/core/task/Task.ts:4200); native dispatch at [src/core/task/Task.ts](../../src/core/task/Task.ts:4170); final child text at [src/core/task/Task.ts](../../src/core/task/Task.ts:4651); timestamp-based refusal at [src/core/task/Task.ts](../../src/core/task/Task.ts:2140); read approval at [src/core/tools/ReadFileTool.ts](../../src/core/tools/ReadFileTool.ts:518). The root/native presenter already applies non-interactive text at [src/core/assistant-message/presentAssistantMessage.ts](../../src/core/assistant-message/presentAssistantMessage.ts:345).

The only runtime hunk marks the late child text non-interactive, using the existing message API. Text still publishes, but it cannot take ownership away from a waiting tool. No global approval semantics, persistence authority, reducer transition, scheduler permit, last-effect protection, timeout, or retry policy changed. A new reducer/model transition is [N/A]: this is an existing presentation-option omission, not a persisted lifecycle transition. All declared lifecycle checks were still run; their historical witnesses and budgets were unchanged.

## 3. Regression, negative control, and fixture repairs

[src/core/task/**tests**/ordinaryDelegationComposition.spec.ts](../../src/core/task/__tests__/ordinaryDelegationComposition.spec.ts:1450) adds eight event-gated schedules: complete native calls and raw streamed arguments, each approved, denied, cancelled, and deliberately superseded. Constructed child/parent Tasks, ordinary scheduler entry, native presenter, real file read, store, final disk publication, and approval handling execute. Model stream, environment collection, constructor-only activation, ignore-policy allowance, file-tracking observation, and controlled terminal cancellation are explicit fixture seams; the exact auditor-mode configuration and live host are not reproduced.

Assertions require unchanged pending approval after final child text; no early tool result; one approved result containing disposable file content; assistant-call-before-result disk order; no parent transcript contamination; zero read tracking/content on denial/cancellation/true supersession; normal scheduler settlement and permit progress after cancellation. No sleeps order the race. Real detached approval-state saves are tracked before disposable teardown.

- Initial pre-fix: 1 failed / 35 selection-skips, exit 1. Final child text changed the pending approval timestamp. [prefix-read-regression.command.json](../../../../../../../tmp/zoo-handoff-audit-20261008-veimqbe2/prefix-read-regression.command.json:1); [prefix-read-regression.output.txt](../../../../../../../tmp/zoo-handoff-audit-20261008-veimqbe2/prefix-read-regression.output.txt:1).
- Initial post-fix: approval/read/durable assertions passed; only an incorrect expectation that ordinary cancellation rejects failed. Corrected fixture to require actual settlement, not a fake error. [postfix-read-regression.command.json](../../../../../../../tmp/zoo-handoff-audit-20261008-veimqbe2/postfix-read-regression.command.json:1).
- First two-encoding selection: 2 passed / 35 selection-skips. Initial source types failed on an incomplete state mock; derivation from the existing state fixed the type without casts/suppressions. Initial eight controls: 7 passed / 1 failed during teardown because a detached approval save was not tracked; joining those real promises repaired the fixture without filesystem retry. All artifacts remain in [verification-ledger.json](../../../../../../../tmp/zoo-handoff-audit-20261008-veimqbe2/verification-ledger.json:1).
- Final targeted controls: 8 passed / 35 selection-skips, exit 0, no unhandled-error section. [joined-read-safety-controls.command.json](../../../../../../../tmp/zoo-handoff-audit-20261008-veimqbe2/joined-read-safety-controls.command.json:1).
- Negative control removes only this runtime option inside the disposable copy. Soft collection retains failing timestamp/content assertions and proceeds to the result; it does not turn them into passes. The actual durable result is “Error: Ask ignored: superseded,” not the disposable file content. One selected test fails with three assertion reports, exit 1. Active assertions were never softened. Both temporary files were restored byte-for-byte. [negative-read-result.output.txt](../../../../../../../tmp/zoo-handoff-audit-20261008-veimqbe2/negative-read-result.output.txt:1); [negative-control-restoration.json](../../../../../../../tmp/zoo-handoff-audit-20261008-veimqbe2/negative-control-restoration.json:1).

The single root attempt additionally exposed a one-second fake-clock disk-settlement assumption in [src/core/task/**tests**/pending-question.spec.ts](../../src/core/task/__tests__/pending-question.spec.ts:523). A separate fixture-only repair captures the actual idle callback, explicitly invokes it while the real answer UI publication is gated, and awaits real resume settlement with live persistence/poll clocks. Original no-obsolete-notification, no-early-continuation, once-only-continuation and no-model-request assertions remain. Its focused regression passes. The root outcome is therefore **non-final for this later fixture change**; no second root run was made.

## 4. Exact offline verification

Independent copy: [copy-validation.json](../../../../../../../tmp/zoo-handoff-audit-20261008-veimqbe2/copy-validation.json:1): 98,203 regular files, 5,499 links, 2,965 source records; no shared active/template inodes, escaping dependency links, or initial source mismatches. Source overlay uses current dirty working bytes, not HEAD. Initial copy omitted dependency distribution folders; they were restored from the existing offline template before project verification. No installation occurred.

Runtime: Node 22.23.1, copied installed pnpm 10.8.1; independently isolated home/config/cache/temp/pnpm-home and a network-denial preload. [verification-env.json](../../../../../../../tmp/zoo-handoff-audit-20261008-veimqbe2/verification-env.json:1). Three HTTPS requests were denied during root tests, none allowed. Existing Vite file-URL and Prettier unknown-option warnings, expected jsdom test stderr, and network-denial stderr remain recorded, not suppressed. No project executable verification ran against the active tree.

| Final lane                       | Outcome                                                                                                              |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Focused safety union             | **594 passed / 24 files**, exit 0, 171.82 s; no unhandled-error section                                              |
| Source types                     | Exit 0, 46.41 s                                                                                                      |
| Public types                     | Exit 0, 15.04 s; public source unchanged afterwards                                                                  |
| Three touched-file lint, pruning | Exit 0, 14.17 s; no increased suppression counts                                                                     |
| Three touched-file formatting    | Exit 0, 1.67 s                                                                                                       |
| Eight declared lifecycle stages  | Exit 0, 19.16 s; no changed model bytes, budgets, or witnesses                                                       |
| Single complete root attempt     | **Exit 1**, 668.62 s, within 1,800 s; 12/13 outer tasks successful, 0/13 cached; no reported unhandled-error section |

Exact invocations follow. Each linked record also contains cwd, full arguments, runtime, bound, duration, exit, and output artifact. Counts from overlapping selections are not additive.

- **prefix-read-regression** — cwd: /tmp/zoo-handoff-audit-20261008-veimqbe2/Zoo-Code/src; exit 1. [Command record](../../../../../../../tmp/zoo-handoff-audit-20261008-veimqbe2/prefix-read-regression.command.json:1).

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-handoff-audit-20261008-veimqbe2/Zoo-Code/src/node_modules/vitest/vitest.mjs run core/task/__tests__/ordinaryDelegationComposition.spec.ts -t 'delegated final text preserves a pending native file read' --maxWorkers=1 --reporter=default
```

- **negative-read-result** — cwd: /tmp/zoo-handoff-audit-20261008-veimqbe2/Zoo-Code/src; exit 1. [Command record](../../../../../../../tmp/zoo-handoff-audit-20261008-veimqbe2/negative-read-result.command.json:1).

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-handoff-audit-20261008-veimqbe2/Zoo-Code/src/node_modules/vitest/vitest.mjs run core/task/__tests__/ordinaryDelegationComposition.spec.ts -t 'delegated final text.*\(complete, approve\)' --maxWorkers=1 --reporter=default
```

- **joined-read-safety-controls** — cwd: /tmp/zoo-handoff-audit-20261008-veimqbe2/Zoo-Code/src; exit 0. [Command record](../../../../../../../tmp/zoo-handoff-audit-20261008-veimqbe2/joined-read-safety-controls.command.json:1).

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-handoff-audit-20261008-veimqbe2/Zoo-Code/src/node_modules/vitest/vitest.mjs run core/task/__tests__/ordinaryDelegationComposition.spec.ts -t 'delegated final text preserves a pending native file read' --maxWorkers=1 --reporter=default
```

- **question-fixture-regression** — cwd: /tmp/zoo-handoff-audit-20261008-veimqbe2/Zoo-Code/src; exit 0. [Command record](../../../../../../../tmp/zoo-handoff-audit-20261008-veimqbe2/question-fixture-regression.command.json:1).

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-handoff-audit-20261008-veimqbe2/Zoo-Code/src/node_modules/vitest/vitest.mjs run core/task/__tests__/pending-question.spec.ts -t 'does not publish an obsolete idle notification' --maxWorkers=1 --reporter=default
```

- **final-focused** — cwd: /tmp/zoo-handoff-audit-20261008-veimqbe2/Zoo-Code/src; exit 0. [Command record](../../../../../../../tmp/zoo-handoff-audit-20261008-veimqbe2/final-focused.command.json:1).

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-handoff-audit-20261008-veimqbe2/Zoo-Code/src/node_modules/vitest/vitest.mjs run core/task/__tests__/ordinaryDelegationComposition.spec.ts core/task/__tests__/TaskScheduler.spec.ts core/task/__tests__/Task.spec.ts core/task/__tests__/providerHandoff.spec.ts core/task/__tests__/pending-question.spec.ts core/task/__tests__/ordinaryPersistenceOwnership.spec.ts core/task/__tests__/manualSupersedeB1.startGuard.spec.ts core/task/__tests__/manualSupersedeB1.actualInstanceStart.spec.ts core/webview/__tests__/ordinaryCompletionOwnership.spec.ts __tests__/ClineProvider.delegation.spec.ts __tests__/ClineProvider.history-resume-delegation.spec.ts __tests__/delegation-concurrent.spec.ts __tests__/nested-delegation-resume.spec.ts __tests__/delegation-handoff-robustness.spec.ts core/tools/__tests__/newTaskTool.spec.ts core/webview/__tests__/ordinaryAbandonmentPersistence.spec.ts core/task-persistence/__tests__/taskLifecycle.spec.ts core/webview/__tests__/manualSupersedeB1.providerStart.spec.ts core/webview/__tests__/manualSupersedeB1.providerFinalEffects.spec.ts __tests__/delegation-restart-persistence.integration.spec.ts core/task/__tests__/ask-clear-approval-buttons.spec.ts core/task/__tests__/ask-queued-message-drain.spec.ts core/assistant-message/__tests__/presentAssistantMessage-unknown-tool.spec.ts core/tools/__tests__/readFileTool.spec.ts --maxWorkers=1 --reporter=default
```

- **final-source-types** — cwd: /tmp/zoo-handoff-audit-20261008-veimqbe2/Zoo-Code/src; exit 0. [Command record](../../../../../../../tmp/zoo-handoff-audit-20261008-veimqbe2/final-source-types.command.json:1).

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-handoff-audit-20261008-veimqbe2/Zoo-Code/node_modules/typescript/bin/tsc --noEmit --pretty false
```

- **public-types** — cwd: /tmp/zoo-handoff-audit-20261008-veimqbe2/Zoo-Code/packages/types; exit 0. [Command record](../../../../../../../tmp/zoo-handoff-audit-20261008-veimqbe2/public-types.command.json:1).

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-handoff-audit-20261008-veimqbe2/Zoo-Code/node_modules/typescript/bin/tsc --noEmit --pretty false
```

- **final-touched-lint** — cwd: /tmp/zoo-handoff-audit-20261008-veimqbe2/Zoo-Code/src; exit 0. [Command record](../../../../../../../tmp/zoo-handoff-audit-20261008-veimqbe2/final-touched-lint.command.json:1).

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-handoff-audit-20261008-veimqbe2/Zoo-Code/node_modules/eslint/bin/eslint.js --prune-suppressions --max-warnings=0 core/task/Task.ts core/task/__tests__/ordinaryDelegationComposition.spec.ts core/task/__tests__/pending-question.spec.ts
```

- **final-format** — cwd: /tmp/zoo-handoff-audit-20261008-veimqbe2/Zoo-Code; exit 0. [Command record](../../../../../../../tmp/zoo-handoff-audit-20261008-veimqbe2/final-format.command.json:1).

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-handoff-audit-20261008-veimqbe2/Zoo-Code/node_modules/prettier/bin/prettier.cjs --check src/core/task/Task.ts src/core/task/__tests__/ordinaryDelegationComposition.spec.ts src/core/task/__tests__/pending-question.spec.ts
```

- **lifecycle-model-check** — cwd: /tmp/zoo-handoff-audit-20261008-veimqbe2/Zoo-Code; exit 0. [Command record](../../../../../../../tmp/zoo-handoff-audit-20261008-veimqbe2/lifecycle-model-check.command.json:1).

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-handoff-audit-20261008-veimqbe2/pnpm/bin/pnpm.cjs lifecycle:model-check
```

- **root-test** — cwd: /tmp/zoo-handoff-audit-20261008-veimqbe2/Zoo-Code; exit 1. [Command record](../../../../../../../tmp/zoo-handoff-audit-20261008-veimqbe2/root-test.command.json:1).

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-handoff-audit-20261008-veimqbe2/pnpm/bin/pnpm.cjs test --force --continue=dependencies-successful --concurrency=2
```

[N/A] second complete root attempt, model/API requests, live-host smoke/restart, build/install/deploy, real profile/task/queue inspection or repair, lock repair/deletion, unrelated submodule repair, crash/power-loss recovery, and whole-repository stability.

### Documentation and whitespace verification

- **report-format-write** — cwd: /tmp/zoo-handoff-audit-20261008-veimqbe2/Zoo-Code; exit 0.

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-handoff-audit-20261008-veimqbe2/Zoo-Code/node_modules/prettier/bin/prettier.cjs --write docs/implementation/ordinary-delegation-20261008-child-tool-supersession-evidence.md
```

- **report-format-check** — cwd: /tmp/zoo-handoff-audit-20261008-veimqbe2/Zoo-Code; exit 0.

```sh
/home/markooo/.nvm/versions/node/v22.23.1/bin/node /tmp/zoo-handoff-audit-20261008-veimqbe2/Zoo-Code/node_modules/prettier/bin/prettier.cjs --check docs/implementation/ordinary-delegation-20261008-child-tool-supersession-evidence.md
```

- **whitespace** — cwd: /home/markooo/V19/projects/Zoo-Code; exit 0.

```sh
git diff --check -- src/core/task/Task.ts src/core/task/__tests__/ordinaryDelegationComposition.spec.ts src/core/task/__tests__/pending-question.spec.ts docs/implementation/ordinary-delegation-20261008-child-tool-supersession-evidence.md
```

## 5. Root failure obligations — retained

Measured extension outcome: **77 failed / 9,710 passed / 39 skipped**, 14 failed / 505 passed / 4 skipped files. Other package lanes: webview 1,895; core 149; types 441; CLI 565 (one skipped); cloud 247; telemetry 49; VS Code shim 407 passed. These are package counts, not sums with the focused selection.

All 76 previously unaddressed identities are still present; one additional pending-question fixture failure was repaired after the root attempt. [root-failure-comparison.json](../../../../../../../tmp/zoo-handoff-audit-20261008-veimqbe2/root-failure-comparison.json:1). The arithmetic remainder is 76 failures across 13 files, **not a measured final root result**. Existing failures remain obligations; no pre-existing/unrelated waiver or production-stability claim is made. Exact identities: [root-failures.json](../../../../../../../tmp/zoo-handoff-audit-20261008-veimqbe2/root-failures.json:1); full output: [root-test.output.txt](../../../../../../../tmp/zoo-handoff-audit-20261008-veimqbe2/root-test.output.txt:1).

| Root failed file                                                                                                                                                   | Count | Disposition                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | ----------------------------------------------------------------- |
| [src/**tests**/queue-lifecycle-composed.spec.ts](../../src/__tests__/queue-lifecycle-composed.spec.ts:1)                                                           | 4     | Retained; diagnosis/repair remains required                       |
| [src/**tests**/removeClineFromStack-delegation.spec.ts](../../src/__tests__/removeClineFromStack-delegation.spec.ts:1)                                             | 3     | Retained; diagnosis/repair remains required                       |
| [src/**tests**/single-open-invariant.spec.ts](../../src/__tests__/single-open-invariant.spec.ts:1)                                                                 | 6     | Retained; diagnosis/repair remains required                       |
| [src/core/assistant-message/**tests**/presentAssistantMessage-images.spec.ts](../../src/core/assistant-message/__tests__/presentAssistantMessage-images.spec.ts:1) | 1     | Retained; diagnosis/repair remains required                       |
| [src/core/task-persistence/**tests**/TaskHistoryStore.reconciliation.spec.ts](../../src/core/task-persistence/__tests__/TaskHistoryStore.reconciliation.spec.ts:1) | 7     | Retained; diagnosis/repair remains required                       |
| [src/core/task-persistence/**tests**/interruptedCreateHandoffDisk.spec.ts](../../src/core/task-persistence/__tests__/interruptedCreateHandoffDisk.spec.ts:1)       | 1     | Retained; diagnosis/repair remains required                       |
| [src/core/task-persistence/**tests**/manualSupersedeB1.bypass.spec.ts](../../src/core/task-persistence/__tests__/manualSupersedeB1.bypass.spec.ts:1)               | 2     | Retained; diagnosis/repair remains required                       |
| [src/core/task/**tests**/Task.pending-action.spec.ts](../../src/core/task/__tests__/Task.pending-action.spec.ts:1)                                                 | 2     | Retained; diagnosis/repair remains required                       |
| [src/core/task/**tests**/Task.throttle.test.ts](../../src/core/task/__tests__/Task.throttle.test.ts:1)                                                             | 6     | Retained; diagnosis/repair remains required                       |
| [src/core/task/**tests**/pending-question.spec.ts](../../src/core/task/__tests__/pending-question.spec.ts:1)                                                       | 1     | Event-gated fixture repaired after root; final focused proof only |
| [src/core/webview/**tests**/ClineProvider.apiHandlerRebuild.spec.ts](../../src/core/webview/__tests__/ClineProvider.apiHandlerRebuild.spec.ts:1)                   | 9     | Retained; diagnosis/repair remains required                       |
| [src/core/webview/**tests**/ClineProvider.sticky-mode.spec.ts](../../src/core/webview/__tests__/ClineProvider.sticky-mode.spec.ts:1)                               | 19    | Retained; diagnosis/repair remains required                       |
| [src/core/webview/**tests**/ClineProvider.sticky-profile.spec.ts](../../src/core/webview/__tests__/ClineProvider.sticky-profile.spec.ts:1)                         | 15    | Retained; diagnosis/repair remains required                       |
| [src/api/providers/fetchers/**tests**/openrouter.spec.ts](../../src/api/providers/fetchers/__tests__/openrouter.spec.ts:1)                                         | 1     | Retained; diagnosis/repair remains required                       |

## 6. Source/index preservation and build limits

HEAD e18f931de70282a05c02fc5592e61b71c339a91f; branch weak_model_runtime_hardening. Before inventory: [baseline.json](../../../../../../../tmp/zoo-handoff-audit-20261008-veimqbe2/baseline.json:1). Semantic index SHA-256 56ec157367711932aaf1a7b16d3693940944ce64a75245d6965c0ad7086cda91; mode/object/stage bytes are unchanged. No staging/reset/clean/restore. Only the three existing paths below and this additive report are authorized changes; all other baseline source/link bytes must match at final audit. The active suppression ledger is byte-identical to baseline; isolated lint normalized its serialization, with identical per-file/rule counts and no increases. The first preservation assertion compared raw copied ledger bytes and stopped on this serialization-only difference; the subsequent semantic comparison found no count changes. Preservation record: [final-preservation.json](../../../../../../../tmp/zoo-handoff-audit-20261008-veimqbe2/final-preservation.json:1).

| Changed path                                                                                                                           | Before SHA-256                                                   | After SHA-256                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| [src/core/task/Task.ts](../../src/core/task/Task.ts:1)                                                                                 | d53c5a290eee0a1d0fb9b370f732a56c010d6b8fbbee6482bcde542b756f06e0 | 661b31d3c7565d061b93cbb9b6c5579708cdba070c37774f23cecf32d1f007ab |
| [src/core/task/**tests**/ordinaryDelegationComposition.spec.ts](../../src/core/task/__tests__/ordinaryDelegationComposition.spec.ts:1) | a784c174cdc35a84c004f5fe0eb8f8b5d2fc328750a9f7a94a57fa87c2cd1621 | 74552f15e18750632fb832d864d892e20290f384547eaca0b82965abd845dc0b |
| [src/core/task/**tests**/pending-question.spec.ts](../../src/core/task/__tests__/pending-question.spec.ts:1)                           | ee64f84da1efa6facd1381a0b6c4abb9dd040ac2198f36b6b791d7ee6954fcb2 | c792d40bc932db5c76bccb9e734b396630ac16487317df24c86d585c4650919a |

Ignored development bundle before this unit: SHA-256 75a23c2a5c1433916c89408d113b0e58188df27611f0101dcfbfed2aa4dea061. Later observed SHA-256 f336ee50e5cd243228129c4f4b8229b0a03d08a9b6ed4c437d4503cabe4b2643. This agent did not build, install, launch, replace, or restore the active bundle. Its producer and loaded-host adoption are UNKNOWN. Version 3.82.2 and base revision alone do not identify fixed dirty-source bytes; loaded full-build parity is not established.

## 7. Bounded manual-retest checklist

Retest only after a separately authorized build from the exact final source hashes above, in a disposable test profile and scratch workspace. Record the loaded bundle SHA-256, build/revision, editor edition, timestamp/timezone and task/instance/action IDs first. No deployment/restart was performed here.

1. Fresh parent delegates a security-auditor child that emits explanatory text and a native read of a disposable order-action file. Leave approval pending through stream completion, then approve. Require actual file content and one correctly correlated result, not a superseded error.
2. Repeat with automatic read approval, then deny and cancel separate disposable reads. Denied/cancelled reads must not return file content; subsequent disposable work must still start.
3. In the child, run a harmless bounded audit command in the scratch workspace. Confirm actual execution/result rather than agent summary alone; record any superseded command with its exact action ID.
4. Complete the child and verify one result in the exact awaited parent, normal continuation, and preserved history after reopen. Then exercise two sequential delegations and one nested delegation.
5. Stop at the first hang, timeout, duplicate/wrong-owner/missing result, or empty task view. Preserve bounded phase/error excerpts without prompts, credentials, profiles, headers, or sensitive file contents. Do not delete uncertain locks or retry the valuable original history automatically.

**Conditional offline verdict: OFFLINE_ORDINARY_VIABLE_WITH_LIMITS** — for the tested participating read/approval path only; loaded-build parity, actual audit-command/transport/host errors and the retained root failures remain explicit limits.
