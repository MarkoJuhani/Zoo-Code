# Ordinary-development parent-fence refusal and persistence safety — partial implementation

Date: 2026-10-07. **STATUS=IMPLEMENTATION_REQUIRED. OFFLINE_ONLY. LIVE_CAUSE=UNKNOWN. HOST=UNKNOWN. B1/B2=NOT_ENABLED.**

## 1. Result and acceptance boundary

A bounded production defect was reproduced and repaired: the Task API-save method swallowed a typed fence refusal as a boolean failure, allowing callers that ignore the boolean to continue and retry callers to treat refusal as ordinary I/O failure. Both Task save catches now rethrow typed unavailability and ownership errors. Acquisition diagnostics now distinguish timeout from filesystem refusal without including filesystem paths. These are partial improvements, **not a repair of the operator’s exact live failure and not ordinary-development stability acceptance**.
The known #1021 and #1469 corruption witnesses remain printed by the lifecycle checker. No new real-disk production-call-path reproduction or source/model repair of those witnesses was completed. The repository-wide test invocation failed and preceded the final Task edit. No live-host, B1 acceptance, release, or deployment claim is made.

## 2. Evidence provenance and fresh worktree

- Revision at investigation, final implementation, and report preflight: e18f931de, “[IMP] To Continue button”. Initial inventory: 51 staged / 24 unstaged tracked / 15 untracked; final implementation: 51 / 26 / 15.
- Read [`AGENTS.md`](../../AGENTS.md), [`docs/architecture/task-lifecycle-model.md`](../architecture/task-lifecycle-model.md), the [`prior shutdown/provider evidence`](interrupted-create-handoff-manual-supersede-b1-shutdown-provider-follow-up-evidence.md), the [`architect handoff`](interrupted-create-handoff-manual-supersede-b1-next-chat-architect-handoff.md), and the [`earlier stability evidence`](interrupted-create-handoff-manual-supersede-b1-normal-development-stability-evidence.md).
- No matching Sol-catalog report was discovered in the worktree. The operator supplied [`/tmp/zoo-openai-followup/evidence.md`](../../../../../../../tmp/zoo-openai-followup/evidence.md); its existence and captured outputs were then checked. The report and raw full-test output, command-result records, and saved crash excerpt were read. These are disposable prior test evidence, not live task logs.
- Sol-catalog full test: exit 1; webview 6 failed / 1,889 passed and core 2 failed / 147 passed. Eight recorded failures are **not passes**. The extension lane had no complete final summary. Its saved crash excerpt reports WSL Bash signal 11, not established Node/Vitest attribution.

## 3. Changed versus preserved scope

| Changed path                                                                                                                                             | This implementation’s change                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`src/core/task-persistence/parentHandoffFence.ts`](../../src/core/task-persistence/parentHandoffFence.ts)                                               | New reason and sanitized error-code diagnostics; acquisition/root-directory refusals classified. No timeout, retry, ownership, or release-policy change. |
| [`src/core/task/Task.ts`](../../src/core/task/Task.ts)                                                                                                   | New typed fence-error import and rethrow in both save catches. Existing start/resume exclusion work was pre-existing and preserved.                      |
| [`src/core/task-persistence/__tests__/interruptedCreateHandoffP2.spec.ts`](../../src/core/task-persistence/__tests__/interruptedCreateHandoffP2.spec.ts) | Added timeout reason assertion and real filesystem-refusal fixture.                                                                                      |
| [`src/core/task-persistence/__tests__/targetPersistenceBoundary.spec.ts`](../../src/core/task-persistence/__tests__/targetPersistenceBoundary.spec.ts)   | Added held-parent/unrelated-progress and unreleased-holder fixtures; earlier boundary tests preserved.                                                   |
| [`src/core/task/__tests__/manualSupersedeB1.actualInstanceStart.spec.ts`](../../src/core/task/__tests__/manualSupersedeB1.actualInstanceStart.spec.ts)   | Extended pre-existing untracked fixture with inherited-context real API/store writes and injected typed API-save refusal with exact byte preservation.   |

No edit to [`src/core/webview/ClineProvider.ts`](../../src/core/webview/ClineProvider.ts), lifecycle reducers, [`scripts/check-task-store-concurrency.ts`](../../scripts/check-task-store-concurrency.ts), catalog/provider contracts, [`turbo.json`](../../turbo.json), UI, B1 writer, policy, or other projects. No staging/reset/clean. A lint-pruning command temporarily rewrote [`src/eslint-suppressions.json`](../../src/eslint-suppressions.json); inspection showed it was initially clean, and only that generated rewrite was restored from HEAD. The final ledger diff was empty.
**Preservation evidence limitation:** original implementation Git inventories and changed-path checks exist, but no original per-file hash baseline or semantic index hash comparison was captured by this implementation. Do not upgrade path/count checks to a retrospective byte-for-byte preservation proof. Report creation separately hashes all existing dirty/untracked files and compares semantic index entries before and after its sole documentation write.

## 4. Acquisition, inheritance, release, and storage trace

1. [`ParentHandoffFence.acquire()`](../../src/core/task-persistence/parentHandoffFence.ts:79) canonicalizes real storage in its constructor and acquires a task-keyed directory lease. Existing lock directories wait only within the configured bound. They are not removed, declared stale by age, or stolen. Owner token and generation are validated on ownership checks and release.
2. [`withProviderStartExclusion()`](../../src/core/task-persistence/targetPersistenceBoundary.ts:45) inherits only a matching active root/task guard, validates the lease, and rejects expired inherited context. Otherwise it acquires a new fence. It keeps the guard active through the awaited callback, then marks it inactive and releases. Fresh callbacks must acquire rather than inherit the enqueuer’s lease.
3. [`withPersistenceExclusions()`](../../src/core/task-persistence/targetPersistenceBoundary.ts:284) reads authoritative lineage, plans task/ancestor exclusions, and acquires them before store/file locks. [`withSingleTargetPersistence()`](../../src/core/task-persistence/targetPersistenceBoundary.ts:366) uses provider-start exclusion for an ordinary unbound task and a separate fail-fast target lease for a bound parent. Protected target/action/question guards were not relaxed.
4. [`Task.startTask()`](../../src/core/task/Task.ts:2565) holds the existing start exclusion across initialization and the awaited loop. The new fixture stops all actual model behavior at a mocked loop; it does not load an extension host or operate a child. Inherited same-task/parent saves completed. A save attempted outside that inherited context was blocked behind the held lease; changing the fixture to the intended inherited context corrected the hypothesis, not production behavior.
5. [`saveApiMessages()`](../../src/core/task-persistence/apiMessages.ts:180) enters exclusion before its file writer. [`TaskHistoryStore.upsert()`](../../src/core/task-persistence/TaskHistoryStore.ts:233) plans task and incoming ancestry exclusions before its store mutex, computes a cache-relative delta in [`TaskHistoryStore.upsertCore()`](../../src/core/task-persistence/TaskHistoryStore.ts:247), and publishes under the file guard in [`TaskHistoryStore.writeTaskFile()`](../../src/core/task-persistence/TaskHistoryStore.ts:1001).
6. [`Task.saveApiConversationHistory()`](../../src/core/task/Task.ts:1416) and [`Task.saveClineMessages()`](../../src/core/task/Task.ts:1575) now distinguish typed fence refusal/loss from generic save failure. Only typed fence errors are rethrown; other catches and existing generic I/O retries remain. No timeout inflation, blind new retry, fail-open fallback, or lock cleanup was added.
   **Remaining message/metadata boundary:** the ordinary message-file writer in [`saveTaskMessages()`](../../src/core/task-persistence/taskMessages.ts:68) has no parent exclusion itself. It can run before a later metadata update refuses. The lightweight provider fixture did not reach the production metadata-update boundary. No exact task-file/metadata partial-effect matrix was completed; the added message-save rethrow is not proven there. Generation/owner bootstrap errors after lock-directory creation and their retention/diagnostics were also not exhaustively tested.

## 5. Reproduction and test limits

| Scenario                                                            | Direct result                                                                                                                                         | Limit                                                                                                                                    |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| First real-root candidate: external save while loop remains pending | Exit 1, one 20-second test timeout; unchanged suite timeout                                                                                           | Did not reach an actual 30-second acquisition refusal. Not accepted as a repaired self-contention defect.                                |
| Corrected inherited-context ordinary save                           | Pass; real API file and child metadata written/read, unrelated task advances                                                                          | Calls real API/store functions inside the mocked loop; does not exercise full Task message-save orchestration or an actual tool request. |
| Held parent fence                                                   | Real acquisition; fail-fast competing persistence callback rejects timeout before its effect; exact parent file preserved and unrelated file advances | Cooperative disposable holder, not live process evidence.                                                                                |
| Unreleased/abandoned holder                                         | Second acquisition rejects timeout; original owner remains valid and owner file remains                                                               | Holder deliberately omits release. No actual process interruption/crash was executed; only fixture-root teardown removes the data.       |
| Filesystem refusal                                                  | A regular file occupies the fence-root location; acquisition reports filesystem/EEXIST and preserves the file                                         | Tests root-directory refusal, not every permissions/ENOTDIR/durable-write failure.                                                       |
| Typed Task API save refusal                                         | Before: promise resolves false. After: rejects typed error, exact API bytes unchanged                                                                 | Acquisition is injected/mocked; does not tie the live refusal to a particular holder or root.                                            |
| Expired/lost inherited lease                                        | Existing boundary/start tests retained and run in focused groups                                                                                      | No new complete expired/non-inherited tool-result callback matrix.                                                                       |

The final [`typed-refusal regression`](../../src/core/task/__tests__/manualSupersedeB1.actualInstanceStart.spec.ts:220) is API-only. An intermediate version asserted both save methods and absence of an API file. The message assertion failed before reaching the intended fence boundary, and startup could already have produced API history; the final assertion compares actual bytes. Those failures are retained in verification history, not misrepresented as production regressions repaired by weakened guards.

## 6. Pending results, ignored failure, and later stale writes

- [`Task.flushPendingToolResultsToHistory()`](../../src/core/task/Task.ts:1346) appends the result turn to in-memory API history before saving and clears pending content only after save success. Source tracing shows a failure retains pending content; a thrown typed error also exits before clearing. **No new end-to-end pending-tool-result memory assertion was completed.**
- [`Task.addToApiConversationHistory()`](../../src/core/task/Task.ts:1220) can previously proceed after a false save for ordinary turns; pending-action/question branches have additional retry/clear behavior. Rethrowing typed fence errors prevents that particular swallowed boolean from continuing those callers and prevents the existing boolean-based retry path from treating the typed error as a normal failure. This is not an audit of every catch or fire-and-forget caller.
- No persistent failed-generation token or sticky invalidation was introduced. A later caller can still initiate a new save after a refusal is caught or the fence is released. Exact later stale-write prevention is **not proved**, and #1021 remains an actionable boundary. No claim that buffers, duplicate flushes, action/question clearing, or every callback are now safe.

## 7. Unsafe lifecycle witnesses and exact next scope

The final lifecycle umbrella exited 0 but [`scripts/check-task-store-concurrency.ts`](../../scripts/check-task-store-concurrency.ts) still emits these exact shortest traces. They remain unsafe witnesses, not passes.

### #1021 — stale live-task save reattaches abandoned lineage

Exact model trace: stale-save-a.read → abandon-b.read → abandon-b.prepare → abandon-b.revalidate(child-a) → abandon-b.commit(child-a) → abandon-b.revalidate(parent) → abandon-b.commit(parent) → A.refresh → stale-save-a.prepare → stale-save-a.revalidate(child-a) → stale-save-a.commit(child-a).
Source exposure: the Task metadata save reconstructs readonly parent/root fields while taking status from the refreshed provider cache, then generic upsert can delta-merge the old lineage. Parent exclusion serializes cooperative writes but does not alone reject a snapshot that was stale before acquisition. **No new actual abandonment-call-path disk reproducer was completed.**
Next bounded implementation: reproduce stale Task snapshot → actual ordinary abandonment → cache refresh → late message/metadata save, asserting exact disk bytes and no later lineage restoration. Required edit scope: [`src/core/task/Task.ts`](../../src/core/task/Task.ts), [`src/core/task-persistence/TaskHistoryStore.ts`](../../src/core/task-persistence/TaskHistoryStore.ts), the exact abandonment entry in [`ClineProvider.abandonSubtask()`](../../src/core/webview/ClineProvider.ts:4969) if the failing call path requires it, corresponding task/persistence/provider tests, and [`scripts/check-task-store-concurrency.ts`](../../scripts/check-task-store-concurrency.ts) for source-grounded promotion. Do not strip lineage indiscriminately or bypass owner/action/question guards.

### #1469 — stale child completion clears newer handoff

Exact model trace: complete-a.read → complete-a.prepare → redelegate-b.read → redelegate-b.prepare → redelegate-b.revalidate(child-a) → redelegate-b.commit(child-a) → complete-a.revalidate(child-a) → complete-a.commit(child-a) → redelegate-b.revalidate(child-b) → redelegate-b.commit(child-b) → redelegate-b.revalidate(parent) → redelegate-b.commit(parent) → complete-a.revalidate(parent) → complete-a.commit(parent).
The model describes a stale prepared completion applied after a newer handoff. Current source has fresh pair reads and cooperative exclusions that the old model witness does not fully represent; this implementation did **not** establish whether the same exact schedule still reaches the actual completion call path. Neither the model witness nor the source path is declared closed.
Next bounded implementation: gate the actual old-child completion and newer delegation boundaries, use real canonical storage, and test the old completion at final parent publication. Required exact scope: [`ClineProvider.reopenParentFromDelegation()`](../../src/core/webview/ClineProvider.ts:4366), [`TaskHistoryStore.atomicUpdatePair()`](../../src/core/task-persistence/TaskHistoryStore.ts:1228), corresponding provider/real-concurrency tests, and [`scripts/check-task-store-concurrency.ts`](../../scripts/check-task-store-concurrency.ts). Add [`src/core/task-persistence/taskLifecycle.ts`](../../src/core/task-persistence/taskLifecycle.ts) only when the verified transition defect needs a shared reducer change. Promote a witness to a source-grounded universal invariant only after exact-child/action/question ownership rejection and unrelated progress/failure tests; do not merely delete the expected counterexample. Additional path edits were not performed here.

### Separate external-theft witness

[`src/core/webview/__tests__/manualSupersedeB1.providerFinalEffects.spec.ts`](../../src/core/webview/__tests__/manualSupersedeB1.providerFinalEffects.spec.ts) is unchanged. Its external-theft case remains a negative witness, not B1 acceptance. It was not explicitly rerun in this implementation’s final focused groups; the full extension lane did not finish. No claim of closing syscall-time external theft by these cooperative leases.

## 8. Exact verification commands and underlying outcomes

Commands with `projects/Zoo-Code` prefixes were executed from the workspace root. Commands with project-local paths were executed after changing into Zoo Code. Underlying exits below are independent of enclosing shell exit 0; test totals from overlapping invocations are not additive unique-test claims. Commands and counts are from the implementation, not rerun by this documentation-only follow-up.
| Check | Exact command | Underlying exit | Result / capture |
| --- | --- | --- | --- |
| Initial candidate | pnpm --dir projects/Zoo-Code/src exec vitest run [`core/task/__tests__/manualSupersedeB1.actualInstanceStart.spec.ts`](../../src/core/task/__tests__/manualSupersedeB1.actualInstanceStart.spec.ts) -t 'permits ordinary API and metadata saves' --reporter=default | 1, then 0 | First external-context version timed out at the unchanged 20-second test limit; inherited-context replacement passed. This is a corrected hypothesis, not a repaired production defect. |
| Typed-refusal regression before Task edit | pnpm --dir projects/Zoo-Code/src exec vitest run [`core/task/__tests__/manualSupersedeB1.actualInstanceStart.spec.ts`](../../src/core/task/__tests__/manualSupersedeB1.actualInstanceStart.spec.ts) -t 'propagates a typed fence refusal' --reporter=default | 1 | 1 failed / 7 filtered: the API-save promise resolved false instead of rejecting. The fence acquisition was mocked; storage and Task were real. |
| Final focused regressions | pnpm --dir src exec vitest run [`core/task/__tests__/manualSupersedeB1.actualInstanceStart.spec.ts`](../../src/core/task/__tests__/manualSupersedeB1.actualInstanceStart.spec.ts) [`core/task-persistence/__tests__/interruptedCreateHandoffP2.spec.ts`](../../src/core/task-persistence/__tests__/interruptedCreateHandoffP2.spec.ts) [`core/task-persistence/__tests__/targetPersistenceBoundary.spec.ts`](../../src/core/task-persistence/__tests__/targetPersistenceBoundary.spec.ts) --reporter=default | 0 | 40 passed / 3 files, after final Task/test edits; [`/tmp/zoo-fence-last.txt`](../../../../../../../tmp/zoo-fence-last.txt). |
| Earlier expanded ordinary group | pnpm --dir projects/Zoo-Code/src exec vitest run [`core/task-persistence/__tests__/interruptedCreateHandoffP2.spec.ts`](../../src/core/task-persistence/__tests__/interruptedCreateHandoffP2.spec.ts) [`core/task-persistence/__tests__/targetPersistenceBoundary.spec.ts`](../../src/core/task-persistence/__tests__/targetPersistenceBoundary.spec.ts) [`core/task-persistence/__tests__/TaskHistoryStore.realConcurrency.spec.ts`](../../src/core/task-persistence/__tests__/TaskHistoryStore.realConcurrency.spec.ts) [`core/task-persistence/__tests__/TaskHistoryStore.spec.ts`](../../src/core/task-persistence/__tests__/TaskHistoryStore.spec.ts) [`core/task-persistence/__tests__/apiMessages.spec.ts`](../../src/core/task-persistence/__tests__/apiMessages.spec.ts) [`core/task/__tests__/manualSupersedeB1.actualInstanceStart.spec.ts`](../../src/core/task/__tests__/manualSupersedeB1.actualInstanceStart.spec.ts) [`core/task/__tests__/apiConversationHistory.spec.ts`](../../src/core/task/__tests__/apiConversationHistory.spec.ts) [`core/webview/__tests__/ClineProvider.taskHistory.spec.ts`](../../src/core/webview/__tests__/ClineProvider.taskHistory.spec.ts) [`core/webview/__tests__/ClineProvider.flicker-free-cancel.spec.ts`](../../src/core/webview/__tests__/ClineProvider.flicker-free-cancel.spec.ts) [`core/webview/__tests__/ClineProvider.spec.ts`](../../src/core/webview/__tests__/ClineProvider.spec.ts) --reporter=dot | 0 | 303 passed / 10 files before the final Task catch edit; [`/tmp/zoo-fence-focused.log`](../../../../../../../tmp/zoo-fence-focused.log). |
| Post-Task provider/storage/shutdown | pnpm --dir src exec vitest run [`core/task-persistence/__tests__/TaskHistoryStore.realConcurrency.spec.ts`](../../src/core/task-persistence/__tests__/TaskHistoryStore.realConcurrency.spec.ts) [`core/task-persistence/__tests__/TaskHistoryStore.spec.ts`](../../src/core/task-persistence/__tests__/TaskHistoryStore.spec.ts) [`core/task-persistence/__tests__/apiMessages.spec.ts`](../../src/core/task-persistence/__tests__/apiMessages.spec.ts) [`core/task/__tests__/apiConversationHistory.spec.ts`](../../src/core/task/__tests__/apiConversationHistory.spec.ts) [`core/webview/__tests__/ClineProvider.taskHistory.spec.ts`](../../src/core/webview/__tests__/ClineProvider.taskHistory.spec.ts) [`core/webview/__tests__/ClineProvider.flicker-free-cancel.spec.ts`](../../src/core/webview/__tests__/ClineProvider.flicker-free-cancel.spec.ts) [`core/webview/__tests__/ClineProvider.spec.ts`](../../src/core/webview/__tests__/ClineProvider.spec.ts) --reporter=default | 0 | 264 passed / 7 files after the final Task edit; [`/tmp/zoo-fence-post-task-provider.txt`](../../../../../../../tmp/zoo-fence-post-task-provider.txt). |
| Mocked native/Codex | pnpm --dir src exec vitest run [`api/providers/__tests__/openai-native.spec.ts`](../../src/api/providers/__tests__/openai-native.spec.ts) [`api/providers/__tests__/openai-codex.spec.ts`](../../src/api/providers/__tests__/openai-codex.spec.ts) [`api/providers/__tests__/manualSupersedeB1.nativeWire.spec.ts`](../../src/api/providers/__tests__/manualSupersedeB1.nativeWire.spec.ts) --reporter=default | 0 | 175 passed / 3 files: 98 native, 60 Codex, 17 wire tests. Before final Task edit; no actual transport/model request. [`/tmp/zoo-fence-native.log`](../../../../../../../tmp/zoo-fence-native.log). |
| Broad Task persistence attempt | pnpm --dir projects/Zoo-Code/src exec vitest run [`core/task/__tests__/manualSupersedeB1.actualInstanceStart.spec.ts`](../../src/core/task/__tests__/manualSupersedeB1.actualInstanceStart.spec.ts) [`core/task/__tests__/Task.persistence.spec.ts`](../../src/core/task/__tests__/Task.persistence.spec.ts) --reporter=default | 1 | 15 failed / 52 passed / 2 files; 3 unhandled errors. Fourteen broad-suite failures and one then-invalid new metadata-save expectation. [`/tmp/zoo-fence-task-final.txt`](../../../../../../../tmp/zoo-fence-task-final.txt). No green rerun of the broad suite. |
| Source type check | pnpm --dir src exec tsc --noEmit --pretty false | 0 final | Fresh source TypeScript check after final edits. Intermediate test receiver typing failed with exit 2 and was corrected. |
| Types check, wrong outer context | pnpm --filter @roo-code/types check-types | 1 | Invoked from the outer workspace; compiler executable not found. This execution is a failure, not a pass. |
| Types check, project context | pnpm --dir packages/types exec tsc --noEmit --pretty false | 0 | Fresh types check from Zoo Code; not a cached Turbo type task. |
| Lint with pruning attempt | pnpm --dir projects/Zoo-Code/src exec eslint --prune-suppressions --max-warnings=0 [`core/task-persistence/parentHandoffFence.ts`](../../src/core/task-persistence/parentHandoffFence.ts) [`core/task-persistence/__tests__/interruptedCreateHandoffP2.spec.ts`](../../src/core/task-persistence/__tests__/interruptedCreateHandoffP2.spec.ts) [`core/task-persistence/__tests__/targetPersistenceBoundary.spec.ts`](../../src/core/task-persistence/__tests__/targetPersistenceBoundary.spec.ts) [`core/task/__tests__/manualSupersedeB1.actualInstanceStart.spec.ts`](../../src/core/task/__tests__/manualSupersedeB1.actualInstanceStart.spec.ts) | 0 | Reformatted the out-of-scope suppression ledger. The initially clean ledger was restored from HEAD only; final diff is empty. No final suppression increase. |
| Final touched-file lint | pnpm --dir src exec eslint --max-warnings=0 [`core/task/Task.ts`](../../src/core/task/Task.ts) [`core/task/__tests__/manualSupersedeB1.actualInstanceStart.spec.ts`](../../src/core/task/__tests__/manualSupersedeB1.actualInstanceStart.spec.ts) [`core/task-persistence/parentHandoffFence.ts`](../../src/core/task-persistence/parentHandoffFence.ts) [`core/task-persistence/__tests__/interruptedCreateHandoffP2.spec.ts`](../../src/core/task-persistence/__tests__/interruptedCreateHandoffP2.spec.ts) [`core/task-persistence/__tests__/targetPersistenceBoundary.spec.ts`](../../src/core/task-persistence/__tests__/targetPersistenceBoundary.spec.ts) | 0 | After final edits; non-pruning to preserve the ledger. |
| Final format write | pnpm exec prettier --write [`src/core/task/Task.ts`](../../src/core/task/Task.ts) [`src/core/task/__tests__/manualSupersedeB1.actualInstanceStart.spec.ts`](../../src/core/task/__tests__/manualSupersedeB1.actualInstanceStart.spec.ts) | 0 | Only these authorized touched paths in the final formatting pass. Earlier passes formatted the fence and boundary tests. [`/tmp/zoo-fence-format-last.txt`](../../../../../../../tmp/zoo-fence-format-last.txt). |
| Final format check | pnpm exec prettier --check [`src/core/task/Task.ts`](../../src/core/task/Task.ts) [`src/core/task/__tests__/manualSupersedeB1.actualInstanceStart.spec.ts`](../../src/core/task/__tests__/manualSupersedeB1.actualInstanceStart.spec.ts) [`src/core/task-persistence/parentHandoffFence.ts`](../../src/core/task-persistence/parentHandoffFence.ts) [`src/core/task-persistence/__tests__/interruptedCreateHandoffP2.spec.ts`](../../src/core/task-persistence/__tests__/interruptedCreateHandoffP2.spec.ts) [`src/core/task-persistence/__tests__/targetPersistenceBoundary.spec.ts`](../../src/core/task-persistence/__tests__/targetPersistenceBoundary.spec.ts) | 0 | All matched files formatted; existing unknown-option warnings. Earlier formatting checks exited 1 before scoped formatting. [`/tmp/zoo-fence-format-check.txt`](../../../../../../../tmp/zoo-fence-format-check.txt). |
| Lifecycle umbrella | pnpm lifecycle:model-check | 0 | Rerun after Task change; output inspected. Both unsafe witnesses remain. [`/tmp/zoo-fence-post-task-model.txt`](../../../../../../../tmp/zoo-fence-post-task-model.txt). |
| Build | pnpm build | 0 | Final post-Task run: 4 successful / 4 total, all 4 cached. Not clean-build or loaded-extension proof. [`/tmp/zoo-fence-post-task-build.txt`](../../../../../../../tmp/zoo-fence-post-task-build.txt). |
| Repository-wide tests | pnpm test | 1 | Exactly one invocation during this implementation, before final Task catch changes. Turbo aborted on webview; incomplete extension lane. [`/tmp/zoo-fence-full-test.log`](../../../../../../../tmp/zoo-fence-full-test.log). |
| Whitespace | git -C projects/Zoo-Code diff --check | 0 | Initial/final implementation checks; final after all implementation edits. |
| Staged whitespace | git -C projects/Zoo-Code diff --cached --check | 0 | Final implementation check; no staging command executed. |

### Repository-wide lane results

| Lane        | Current invocation evidence                                | Qualification                                                                                                                                                                                                                                                                                                                                                         |
| ----------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core        | 15 passed files; 149 passed tests                          | Fresh completed summary.                                                                                                                                                                                                                                                                                                                                              |
| Webview     | 2 failed / 162 passed files; 3 failed / 1,892 passed tests | Two malformed-mode suggestion failures in [`webview-ui/src/components/chat/__tests__/ChatView.spec.tsx`](../../webview-ui/src/components/chat/__tests__/ChatView.spec.tsx); one sound-setting case in [`webview-ui/src/components/settings/__tests__/SettingsView.spec.tsx`](../../webview-ui/src/components/settings/__tests__/SettingsView.spec.tsx). Not repaired. |
| Extension   | No final test/file summary before Turbo abort              | Incomplete, not green.                                                                                                                                                                                                                                                                                                                                                |
| Other lanes | Turbo total: 11 successful / 13, 9 cached                  | No fresh per-lane totals were separately extracted; cached success is not a fresh test run.                                                                                                                                                                                                                                                                           |

The broad [`src/core/task/__tests__/Task.persistence.spec.ts`](../../src/core/task/__tests__/Task.persistence.spec.ts) attempt has 14 unresolved failures: most report a missing storage-base export in its storage mock; remaining assertions are downstream of mocked/failed hydration. This implementation did not baseline that entire suite before the Task catch edit, so fixture-error evidence is not a proof all failures pre-existed or are unrelated. Three unhandled errors were reported. Its one then-invalid new regression failure was corrected and passed in final focused runs; the broad suite itself was not rerun green.

### Model counts and interpretation

- Persisted lifecycle: 89 states, 5/5 actions, 4/4 landmarks. Shared store: 625 states, 6 scenarios, 6 invariants, 7/7 phases, 3/3 landmarks, both unsafe witnesses retained.
- Provider/scheduler: 104 states, 10/10 actions, 12/12 landmarks, six legacy counterexamples. Cleanup: 96,174 states, 20/20 actions, 11/11 landmarks.
- Parser: 924/924 schedules, 6/6 actions, 8/8 landmarks. Completion persistence: 88 states, 12/12 actions, 7/7 landmarks. Delegated-mode reader: four divergent pairs, five built-in modes. Pending questions: seven states. Bounds were not increased.

### Crash attribution

Current captured repository-wide output has no SIGSEGV/segmentation-fault/signal-11 marker; it exits 1 on test failure. No new host/kernel/process/log inspection was performed, so absence of a captured marker is **not proof that no host signal occurred**. Prior Sol evidence includes WSL Bash signal 11; causal attribution to Node/Vitest or common cause with the older exit 139 remains **UNKNOWN**. No retry-until-green full invocation.

### Checks not completed — [N/A], not PASS

- Repository-wide tests after final Task edit. Full per-lane fresh totals and complete extension-lane proof.
- Final broad Task persistence green run; final explicit external-theft suite rerun. Native/Codex rerun after final Task edit (the 175-test run predates it).
- Actual pending-tool-result callback/memory/stale-write matrix; actual process-interrupted holder; full task-message/metadata partial-effect assertions.
- Exact real-disk #1021/#1469 production-call-path reproduction, source repair, and model promotion.
- Clean uncached build, loaded extension-host smoke, live task/storage/profile/process/queue inspection, child/model/network operation, B1/B2 implementation or enablement, staging, release, deployment.

## 9. Complete inventory and preservation disposition

Initial implementation inventory: **51 staged, 24 unstaged tracked, 15 untracked**. Final implementation and report preflight: **51 staged, 26 unstaged tracked, 15 untracked**. After adding this report: expected **51 / 26 / 16**. Staged/unstaged counts overlap. The two newly unstaged paths are the previously staged fence source and P2 test; the boundary test, Task source, and actual-instance test were already dirty/untracked.
The exact final implementation path inventory is retained in [`/tmp/zoo-fence-inventory.txt`](../../../../../../../tmp/zoo-fence-inventory.txt) and materialized below so ephemeral artifact retention is not required to understand scope. This report is the sole new path in the documentation follow-up.

### Staged paths — 51, unchanged by this implementation

- [`docs/architecture/interrupted-create-handoff-recovery-analysis.md`](../architecture/interrupted-create-handoff-recovery-analysis.md)
- [`docs/architecture/interrupted-create-handoff-recovery-p1-contract.md`](../architecture/interrupted-create-handoff-recovery-p1-contract.md)
- [`docs/architecture/interrupted-create-handoff-recovery-p1-design-review.md`](../architecture/interrupted-create-handoff-recovery-p1-design-review.md)
- [`docs/implementation/interrupted-create-handoff-manual-supersede-a-boundary-audit.md`](interrupted-create-handoff-manual-supersede-a-boundary-audit.md)
- [`docs/implementation/interrupted-create-handoff-manual-supersede-b-closure-contract.md`](interrupted-create-handoff-manual-supersede-b-closure-contract.md)
- [`docs/implementation/interrupted-create-handoff-manual-supersede-b1-b2-design.md`](interrupted-create-handoff-manual-supersede-b1-b2-design.md)
- [`docs/implementation/interrupted-create-handoff-manual-supersede-b1-integrated-result-only-blocked-report.md`](interrupted-create-handoff-manual-supersede-b1-integrated-result-only-blocked-report.md)
- [`docs/implementation/interrupted-create-handoff-manual-supersede-b1-prerequisite-evidence.md`](interrupted-create-handoff-manual-supersede-b1-prerequisite-evidence.md)
- [`docs/implementation/interrupted-create-handoff-manual-supersede-b1-result-only-attempt-report.md`](interrupted-create-handoff-manual-supersede-b1-result-only-attempt-report.md)
- [`docs/implementation/interrupted-create-handoff-manual-supersede-b1-target-persistence-boundary-report.md`](interrupted-create-handoff-manual-supersede-b1-target-persistence-boundary-report.md)
- [`docs/implementation/interrupted-create-handoff-manual-supersede-i0-implementation.md`](interrupted-create-handoff-manual-supersede-i0-implementation.md)
- [`docs/implementation/interrupted-create-handoff-manual-supersede-r1-decision.md`](interrupted-create-handoff-manual-supersede-r1-decision.md)
- [`docs/implementation/interrupted-create-handoff-manual-supersede-r2a-decision.md`](interrupted-create-handoff-manual-supersede-r2a-decision.md)
- [`docs/implementation/interrupted-create-handoff-manual-supersede-result-identity-implementation.md`](interrupted-create-handoff-manual-supersede-result-identity-implementation.md)
- [`docs/implementation/interrupted-create-handoff-recovery-p2-interface-review.md`](interrupted-create-handoff-recovery-p2-interface-review.md)
- [`docs/implementation/interrupted-create-handoff-recovery-p2.md`](interrupted-create-handoff-recovery-p2.md)
- [`docs/implementation/interrupted-create-handoff-recovery-p3-interface-review.md`](interrupted-create-handoff-recovery-p3-interface-review.md)
- [`docs/implementation/interrupted-create-handoff-recovery-p3-revised-direct-intake-interface-review.md`](interrupted-create-handoff-recovery-p3-revised-direct-intake-interface-review.md)
- [`docs/implementation/interrupted-create-handoff-recovery-p3-target-interface-addendum.md`](interrupted-create-handoff-recovery-p3-target-interface-addendum.md)
- [`docs/implementation/interrupted-create-handoff-recovery-p3.md`](interrupted-create-handoff-recovery-p3.md)
- [`src/api/providers/__tests__/manualSupersedeB1.nativeWire.spec.ts`](../../src/api/providers/__tests__/manualSupersedeB1.nativeWire.spec.ts)
- [`src/core/task-persistence/TaskHistoryStore.ts`](../../src/core/task-persistence/TaskHistoryStore.ts)
- [`src/core/task-persistence/__tests__/exactRecoveryAttachments.spec.ts`](../../src/core/task-persistence/__tests__/exactRecoveryAttachments.spec.ts)
- [`src/core/task-persistence/__tests__/interruptedCreateHandoffDisk.spec.ts`](../../src/core/task-persistence/__tests__/interruptedCreateHandoffDisk.spec.ts)
- [`src/core/task-persistence/__tests__/interruptedCreateHandoffP2.spec.ts`](../../src/core/task-persistence/__tests__/interruptedCreateHandoffP2.spec.ts)
- [`src/core/task-persistence/__tests__/manualSupersedeB1.bypass.spec.ts`](../../src/core/task-persistence/__tests__/manualSupersedeB1.bypass.spec.ts)
- [`src/core/task-persistence/__tests__/manualSupersedeB1.fixture.ts`](../../src/core/task-persistence/__tests__/manualSupersedeB1.fixture.ts)
- [`src/core/task-persistence/__tests__/manualSupersedeB1.readback.spec.ts`](../../src/core/task-persistence/__tests__/manualSupersedeB1.readback.spec.ts)
- [`src/core/task-persistence/__tests__/manualSupersedeB1.startupQuarantine.spec.ts`](../../src/core/task-persistence/__tests__/manualSupersedeB1.startupQuarantine.spec.ts)
- [`src/core/task-persistence/__tests__/manualSupersedePreflight.spec.ts`](../../src/core/task-persistence/__tests__/manualSupersedePreflight.spec.ts)
- [`src/core/task-persistence/__tests__/manualSupersedeR1Witness.spec.ts`](../../src/core/task-persistence/__tests__/manualSupersedeR1Witness.spec.ts)
- [`src/core/task-persistence/__tests__/manualSupersedeResultIdentity.spec.ts`](../../src/core/task-persistence/__tests__/manualSupersedeResultIdentity.spec.ts)
- [`src/core/task-persistence/__tests__/recoveryIntake.spec.ts`](../../src/core/task-persistence/__tests__/recoveryIntake.spec.ts)
- [`src/core/task-persistence/__tests__/targetPersistenceBoundary.spec.ts`](../../src/core/task-persistence/__tests__/targetPersistenceBoundary.spec.ts)
- [`src/core/task-persistence/apiMessages.ts`](../../src/core/task-persistence/apiMessages.ts)
- [`src/core/task-persistence/exactRecoveryAttachments.ts`](../../src/core/task-persistence/exactRecoveryAttachments.ts)
- [`src/core/task-persistence/interruptedCreateHandoffDisk.ts`](../../src/core/task-persistence/interruptedCreateHandoffDisk.ts)
- [`src/core/task-persistence/interruptedCreateHandoffEligibility.ts`](../../src/core/task-persistence/interruptedCreateHandoffEligibility.ts)
- [`src/core/task-persistence/manualSupersedeB1Boundary.ts`](../../src/core/task-persistence/manualSupersedeB1Boundary.ts)
- [`src/core/task-persistence/manualSupersedeB1Readback.ts`](../../src/core/task-persistence/manualSupersedeB1Readback.ts)
- [`src/core/task-persistence/manualSupersedePreflight.ts`](../../src/core/task-persistence/manualSupersedePreflight.ts)
- [`src/core/task-persistence/manualSupersedeResultIdentity.ts`](../../src/core/task-persistence/manualSupersedeResultIdentity.ts)
- [`src/core/task-persistence/parentHandoffFence.ts`](../../src/core/task-persistence/parentHandoffFence.ts)
- [`src/core/task-persistence/recoveryIntake.ts`](../../src/core/task-persistence/recoveryIntake.ts)
- [`src/core/task-persistence/targetPersistenceBoundary.ts`](../../src/core/task-persistence/targetPersistenceBoundary.ts)
- [`src/core/task/__tests__/manualSupersedeB1.schedulerBypass.spec.ts`](../../src/core/task/__tests__/manualSupersedeB1.schedulerBypass.spec.ts)
- [`src/shared/recoveryIntake.ts`](../../src/shared/recoveryIntake.ts)
- [`webview-ui/src/utils/__tests__/recoveryClientState.spec.ts`](../../webview-ui/src/utils/__tests__/recoveryClientState.spec.ts)
- [`webview-ui/src/utils/__tests__/recoverySubmission.spec.ts`](../../webview-ui/src/utils/__tests__/recoverySubmission.spec.ts)
- [`webview-ui/src/utils/recoveryClientState.ts`](../../webview-ui/src/utils/recoveryClientState.ts)
- [`webview-ui/src/utils/recoverySubmission.ts`](../../webview-ui/src/utils/recoverySubmission.ts)

### Unstaged tracked paths — 26

- [`docs/architecture/task-cleanup-protocol-model.md`](../architecture/task-cleanup-protocol-model.md)
- [`packages/types/src/__tests__/openai-models.test.ts`](../../packages/types/src/__tests__/openai-models.test.ts)
- [`packages/types/src/providers/openai-codex.ts`](../../packages/types/src/providers/openai-codex.ts)
- [`packages/types/src/providers/openai.ts`](../../packages/types/src/providers/openai.ts)
- [`scripts/check-task-cleanup-protocol.ts`](../../scripts/check-task-cleanup-protocol.ts)
- [`src/api/providers/__tests__/openai-codex.spec.ts`](../../src/api/providers/__tests__/openai-codex.spec.ts)
- [`src/api/providers/__tests__/openai-native.spec.ts`](../../src/api/providers/__tests__/openai-native.spec.ts)
- [`src/api/providers/openai-codex.ts`](../../src/api/providers/openai-codex.ts)
- [`src/core/task-persistence/TaskHistoryStore.ts`](../../src/core/task-persistence/TaskHistoryStore.ts)
- [`src/core/task-persistence/__tests__/TaskHistoryStore.realConcurrency.spec.ts`](../../src/core/task-persistence/__tests__/TaskHistoryStore.realConcurrency.spec.ts)
- [`src/core/task-persistence/__tests__/TaskHistoryStore.spec.ts`](../../src/core/task-persistence/__tests__/TaskHistoryStore.spec.ts)
- [`src/core/task-persistence/__tests__/interruptedCreateHandoffP2.spec.ts`](../../src/core/task-persistence/__tests__/interruptedCreateHandoffP2.spec.ts)
- [`src/core/task-persistence/__tests__/manualSupersedeB1.startupQuarantine.spec.ts`](../../src/core/task-persistence/__tests__/manualSupersedeB1.startupQuarantine.spec.ts)
- [`src/core/task-persistence/__tests__/targetPersistenceBoundary.spec.ts`](../../src/core/task-persistence/__tests__/targetPersistenceBoundary.spec.ts)
- [`src/core/task-persistence/apiMessages.ts`](../../src/core/task-persistence/apiMessages.ts)
- [`src/core/task-persistence/parentHandoffFence.ts`](../../src/core/task-persistence/parentHandoffFence.ts)
- [`src/core/task-persistence/targetPersistenceBoundary.ts`](../../src/core/task-persistence/targetPersistenceBoundary.ts)
- [`src/core/task/Task.ts`](../../src/core/task/Task.ts)
- [`src/core/task/TaskScheduler.ts`](../../src/core/task/TaskScheduler.ts)
- [`src/core/task/__tests__/Task.resume-eviction-race.spec.ts`](../../src/core/task/__tests__/Task.resume-eviction-race.spec.ts)
- [`src/core/webview/ClineProvider.ts`](../../src/core/webview/ClineProvider.ts)
- [`src/core/webview/__tests__/ClineProvider.flicker-free-cancel.spec.ts`](../../src/core/webview/__tests__/ClineProvider.flicker-free-cancel.spec.ts)
- [`src/core/webview/__tests__/ClineProvider.spec.ts`](../../src/core/webview/__tests__/ClineProvider.spec.ts)
- [`src/core/webview/__tests__/ClineProvider.taskHistory.spec.ts`](../../src/core/webview/__tests__/ClineProvider.taskHistory.spec.ts)
- [`src/utils/__tests__/safeWriteJson.test.ts`](../../src/utils/__tests__/safeWriteJson.test.ts)
- [`src/utils/safeWriteJson.ts`](../../src/utils/safeWriteJson.ts)

### Pre-existing untracked paths — 15

- [`docs/implementation/interrupted-create-handoff-manual-supersede-b1-binding-race-blocked-report.md`](interrupted-create-handoff-manual-supersede-b1-binding-race-blocked-report.md)
- [`docs/implementation/interrupted-create-handoff-manual-supersede-b1-guarded-publication-evidence.md`](interrupted-create-handoff-manual-supersede-b1-guarded-publication-evidence.md)
- [`docs/implementation/interrupted-create-handoff-manual-supersede-b1-next-chat-architect-handoff.md`](interrupted-create-handoff-manual-supersede-b1-next-chat-architect-handoff.md)
- [`docs/implementation/interrupted-create-handoff-manual-supersede-b1-normal-development-stability-evidence.md`](interrupted-create-handoff-manual-supersede-b1-normal-development-stability-evidence.md)
- [`docs/implementation/interrupted-create-handoff-manual-supersede-b1-provider-final-effects-evidence.md`](interrupted-create-handoff-manual-supersede-b1-provider-final-effects-evidence.md)
- [`docs/implementation/interrupted-create-handoff-manual-supersede-b1-provider-start-next-code-prompt.md`](interrupted-create-handoff-manual-supersede-b1-provider-start-next-code-prompt.md)
- [`docs/implementation/interrupted-create-handoff-manual-supersede-b1-provider-start-partial.md`](interrupted-create-handoff-manual-supersede-b1-provider-start-partial.md)
- [`docs/implementation/interrupted-create-handoff-manual-supersede-b1-shutdown-provider-follow-up-evidence.md`](interrupted-create-handoff-manual-supersede-b1-shutdown-provider-follow-up-evidence.md)
- [`docs/implementation/interrupted-create-handoff-manual-supersede-b1-startup-admission-evidence.md`](interrupted-create-handoff-manual-supersede-b1-startup-admission-evidence.md)
- [`docs/implementation/interrupted-create-handoff-manual-supersede-b1-startup-effects-evidence.md`](interrupted-create-handoff-manual-supersede-b1-startup-effects-evidence.md)
- [`src/core/task-persistence/__tests__/manualSupersedeB1.startupEffects.spec.ts`](../../src/core/task-persistence/__tests__/manualSupersedeB1.startupEffects.spec.ts)
- [`src/core/task/__tests__/manualSupersedeB1.actualInstanceStart.spec.ts`](../../src/core/task/__tests__/manualSupersedeB1.actualInstanceStart.spec.ts)
- [`src/core/task/__tests__/manualSupersedeB1.startGuard.spec.ts`](../../src/core/task/__tests__/manualSupersedeB1.startGuard.spec.ts)
- [`src/core/webview/__tests__/manualSupersedeB1.providerFinalEffects.spec.ts`](../../src/core/webview/__tests__/manualSupersedeB1.providerFinalEffects.spec.ts)
- [`src/core/webview/__tests__/manualSupersedeB1.providerStart.spec.ts`](../../src/core/webview/__tests__/manualSupersedeB1.providerStart.spec.ts)

### Documentation follow-up

- Added [`docs/implementation/ordinary-development-parent-fence-persistence-safety-report.md`](ordinary-development-parent-fence-persistence-safety-report.md).
- Before/after semantic staged entries compared; all pre-existing inventoried dirty/untracked files hashed and compared during this report write. No implementation source edited in the documentation follow-up.

## 10. Final offline verdict

**IMPLEMENTATION_REQUIRED.** The proven API-save typed-error swallowing defect has a passing offline regression, and fence diagnostics are more truthful. The exact operator failure cause is UNKNOWN. Both ordinary corruption witnesses, incomplete tool-result/metadata failure coverage, the broad Task suite failures, and repository-wide failures remain open. Ordinary development is not declared stable. B1/B2 remain unenabled; no live-host safety, acceptance, release, or deployment readiness is implied.
