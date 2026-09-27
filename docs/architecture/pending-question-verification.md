# Pending-question runtime barrier verification

## Scope and evidence

Implemented within Zoo-Code only. No rules, modes, changelog, or commits changed. The starting working tree was clean. Investigation was source evidence, not an actual incident trace; these are constructed regression scenarios, not a claim to reproduce a reported production incident.

## Behavior

- Validated complete questions receive task/question/native-call identity. Registration waits for the existing assistant-history durability boundary before publishing the question.
- Question updates use production lifecycle reducers evaluated against disk inside the existing atomic writer lock. Request interruption retains ownership; rehydration restores the question instead of accepting generic resume approval as its answer.
- Pending questions stop presenter/tool dispatch, completion effects, missing-tool continuation, and provider requests. Answers require an explicit owned envelope; unowned synthetic empty feedback, generic approvals, stale delivery, and duplicates are ignored.
- Explicit empty text, image-only text, free text, queued responses, suggestion modes, and configured automatic answers are supported. Timers capture ownership and are cleared when asks exit.
- Accepted answers remain durable until the matching native result is persisted. Feedback uses deterministic message identity. Resume repairs the matching result and supplies error results for other interrupted calls.
- Explicit question abandonment/replacement has a task API; delegated-child abandonment clears question state through the lifecycle reducer. Ordinary cancel/abort remains an interruption, not consent.

## Known limits and review targets

- [N/A] Real VS Code extension-host/browser E2E and a fresh extension process were not run. Coverage uses the actual internal dispatcher, ask, request-loop entry, history-loading entry, webview message handler, React UI, and real filesystem stores, with external services mocked.
- The reducer model is intentionally small and does not prove scheduler liveness, arbitrary cross-host simultaneous execution, power-loss behavior, or full composed runtime correctness.
- Explicit question abandonment/replacement is exposed as a runtime API, not a new webview control. Existing cancel retains the question for resumption; delegated-child abandonment is wired to its existing reducer.
- Old unanswered historical UI rows are not migrated into barriers. Malformed/orphaned durable question state fails closed if its matching assistant native call cannot be found; no automatic orphan repair is supplied.
- Feedback/API history and task metadata remain separate atomic files. Tests cover answer retention, feedback retry identity, normal exactly-once result replay, and stale metadata ownership, not every crash boundary or concurrent multi-host execution interleaving.
- Full project tests did not complete successfully; see the exact failure below. Independent review remains required.

## Exact verification commands and results

All commands below ran from the Zoo-Code project root.

```sh
pnpm --dir src exec vitest run core/task/__tests__/pending-question.spec.ts core/tools/__tests__/askFollowupQuestionTool.spec.ts core/tools/__tests__/attemptCompletionTool.spec.ts core/task/__tests__/ask-queued-message-drain.spec.ts core/auto-approval/__tests__/followup.spec.ts core/webview/__tests__/ClineProvider.flicker-free-cancel.spec.ts core/webview/__tests__/webviewMessageHandler.spec.ts core/task-persistence/__tests__/pendingQuestion.realPersistence.spec.ts core/task-persistence/__tests__/taskLifecycle.spec.ts core/task/__tests__/Task.resume-eviction-race.spec.ts core/assistant-message/__tests__/presentAssistantMessage-unknown-tool.spec.ts --maxWorkers=2 --reporter=dot
```

PASS: 11 suites, 278 tests.

```sh
pnpm --dir webview-ui exec vitest run src/components/chat/__tests__/ChatView.spec.tsx --reporter=verbose
```

PASS: 1 suite, 31 tests.

```sh
pnpm --dir src exec tsc --noEmit --pretty false
```

PASS.

```sh
pnpm --dir webview-ui exec tsc --noEmit --pretty false
```

PASS.

```sh
pnpm --dir packages/types exec tsc --noEmit --pretty false
```

PASS.

```sh
pnpm --dir src exec eslint --prune-suppressions --max-warnings=0 core/task/Task.ts core/task-persistence/taskLifecycle.ts core/task-persistence/TaskHistoryStore.ts core/task-persistence/__tests__/pendingQuestion.realPersistence.spec.ts core/task-persistence/__tests__/taskLifecycle.spec.ts core/tools/AskFollowupQuestionTool.ts core/tools/AttemptCompletionTool.ts core/tools/BaseTool.ts core/assistant-message/presentAssistantMessage.ts core/webview/webviewMessageHandler.ts core/webview/__tests__/webviewMessageHandler.spec.ts core/tools/__tests__/askFollowupQuestionTool.spec.ts core/task/__tests__/pending-question.spec.ts
```

PASS. No suppression count increases; follow-up tool test explicit-any count decreased from 20 to 10.

```sh
pnpm --dir webview-ui exec eslint --max-warnings=0 src/components/chat/ChatView.tsx src/components/chat/ChatRow.tsx src/components/chat/__tests__/ChatView.spec.tsx
```

PASS.

```sh
pnpm lifecycle:model-check
```

PASS. Includes the new production-reducer question check: 7 distinct states, depth bound 8, budget 100.

```sh
pnpm test
```

FAIL: two assertions in packages/types/src/**tests**/openai-models.test.ts (GPT-6 Sol description and Codex context/description). Those test/model files were not modified. The runner subsequently printed a segmentation fault and exited 139. No baseline full-suite rerun was performed, so this is not a proven baseline comparison.

```sh
git diff --check
```

PASS.

## Changed files

- [`docs/architecture/task-lifecycle-model.md`](../../docs/architecture/task-lifecycle-model.md)
- [`package.json`](../../package.json)
- [`packages/types/src/history.ts`](../../packages/types/src/history.ts)
- [`packages/types/src/message.ts`](../../packages/types/src/message.ts)
- [`packages/types/src/vscode-extension-host.ts`](../../packages/types/src/vscode-extension-host.ts)
- [`src/core/assistant-message/presentAssistantMessage.ts`](../../src/core/assistant-message/presentAssistantMessage.ts)
- [`src/core/task-persistence/TaskHistoryStore.ts`](../../src/core/task-persistence/TaskHistoryStore.ts)
- [`src/core/task-persistence/__tests__/taskLifecycle.spec.ts`](../../src/core/task-persistence/__tests__/taskLifecycle.spec.ts)
- [`src/core/task-persistence/taskLifecycle.ts`](../../src/core/task-persistence/taskLifecycle.ts)
- [`src/core/task/Task.ts`](../../src/core/task/Task.ts)
- [`src/core/tools/AskFollowupQuestionTool.ts`](../../src/core/tools/AskFollowupQuestionTool.ts)
- [`src/core/tools/AttemptCompletionTool.ts`](../../src/core/tools/AttemptCompletionTool.ts)
- [`src/core/tools/BaseTool.ts`](../../src/core/tools/BaseTool.ts)
- [`src/core/tools/__tests__/askFollowupQuestionTool.spec.ts`](../../src/core/tools/__tests__/askFollowupQuestionTool.spec.ts)
- [`src/core/webview/__tests__/webviewMessageHandler.spec.ts`](../../src/core/webview/__tests__/webviewMessageHandler.spec.ts)
- [`src/core/webview/webviewMessageHandler.ts`](../../src/core/webview/webviewMessageHandler.ts)
- [`src/eslint-suppressions.json`](../../src/eslint-suppressions.json)
- [`webview-ui/src/components/chat/ChatRow.tsx`](../../webview-ui/src/components/chat/ChatRow.tsx)
- [`webview-ui/src/components/chat/ChatView.tsx`](../../webview-ui/src/components/chat/ChatView.tsx)
- [`webview-ui/src/components/chat/__tests__/ChatView.spec.tsx`](../../webview-ui/src/components/chat/__tests__/ChatView.spec.tsx)
- [`scripts/check-pending-question.ts`](../../scripts/check-pending-question.ts)
- [`src/core/task-persistence/__tests__/pendingQuestion.realPersistence.spec.ts`](../../src/core/task-persistence/__tests__/pendingQuestion.realPersistence.spec.ts)
- [`src/core/task/__tests__/pending-question.spec.ts`](../../src/core/task/__tests__/pending-question.spec.ts)
- This verification report.
