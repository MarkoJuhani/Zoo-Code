---
name: zoo-task-brief
description: Draft a task brief for non-trivial Zoo Code implementation work from the current conversation and measured repository facts, then stop for the user's approval. The approved brief becomes the implementation prompt. Not for small well-located fixes, debugging an unknown cause, or architecture authoring.
argument-hint: "<short task description> [--save <path>]"
disable-model-invocation: true
---

# Zoo Code task brief

Turn a requested change into a brief the user approves before any application
edit. Reuse the repository rules by reference; do not copy them into the brief:
[project instructions](../../../CLAUDE.md), [repository rules](../../../AGENTS.md),
[setup and workflow](../../README.md), the
[evidence template](../zoo-architecture/references/authoring-contract.md#manual-test-and-evidence-template),
and [zoo-verify](../zoo-verify/SKILL.md).

## Procedure

1. **Restate and triage.** State the goal in one line. If the fix is small and
   well located (one or two files, known cause, obvious check), say so, recommend
   implementing directly, and stop. A brief there only adds overhead.
2. **Unknown cause.** If the cause is not established, recommend running
   `zoo-code-debugger` first and wait for the user's decision. Build the brief on
   its diagnosis. Do not guess a root cause; mark it unknown instead.
3. **Measure, read-only.** Record `git rev-parse --short HEAD` and note that line
   numbers may drift. Locate the affected files and symbols. Run
   `node .claude/skills/zoo-verify/scripts/verify.mjs --dry-run <files>` for the
   check plan. Run the narrowest command that shows the current errors or
   failures (for example the package's type check or one test file) and record
   exact codes and counts. Measure a proposed config change with a command-line
   override, not by editing the file. Writes to `node_modules/.cache` are
   acceptable; never edit tracked files, save a baseline, or stage while drafting.
   If a command is denied or fails, write "not measured" with the reason; never
   estimate a number or change the command's form to get past a denial.
4. **Fill in the template** below. Ask only the open questions whose answers
   change scope or behavior; record other assumptions in the brief.
5. **Present and stop.** Show the brief and end the turn. Implementation starts
   only after the user explicitly approves it. That approval is the implementation
   authorization CLAUDE.md requires, for the brief's scope only. It does not
   approve commits, pushes, dependency installs, or policy changes. If the work
   needs to leave the approved scope, stop and present a revised brief.
6. **Save only on request.** With `--save <path>` or an explicit request, write
   the brief to that path. Never create `docs/implementation/` files by default.

If drafting is interrupted, or HEAD or the working tree changed before approval,
re-measure the starting point before presenting the brief again.

## Template

Keep each section short and concrete. Delete a section that does not apply.

```markdown
# Task brief: <title>

**Goal:** <one or two sentences of observable behavior>

**Authorization:** You are authorized to edit application code within the scope below.

**Measured starting point:** commit <sha>, <date>; line numbers may drift.

- `<command>` -> <exact errors or failures, with counts>
- Not measured: <item and reason>

**Scope:** <files, symbols, and behavior in scope>

**Out of scope:** <other packages, unrelated failing tests, refactors, docs>

**Behavior to preserve:** <exact semantics, ordering, messages, defaults>

**Forbidden shortcuts:** `as any`; `as unknown as` without a comment saying why;
`@ts-ignore`/`@ts-nocheck`; `eslint-disable` without `-- reason`; raising any
count in `src/eslint-suppressions.json`; `eslint --prune-suppressions`;
weakening, skipping, or deleting test assertions; commit, stash, reset, or
checkout of other work.

**Lifecycle note:** (task, delegation, persistence, or approval paths) Follow the
AGENTS.md lifecycle rules and read `docs/architecture/task-lifecycle-model.md`;
run `pnpm lifecycle:model-check`, and `pnpm test` before completion. If control
flow or ordering must change, stop and report before changing it.

**Settings note:** (persisted setting) Complete the AGENTS.md Persisted Setting Checklist.

**Verification:**

1. Before editing: `node .claude/skills/zoo-verify/scripts/verify.mjs --save-baseline <files>`
2. After editing: the same command without `--save-baseline`.
3. Acceptance: 0 new failures, no escapes FAIL, no suppression count increase.
4. Risky diff (lifecycle, concurrency, provider protocol): `zoo-code-reviewer`.
5. `--full` before commit, or report it as not run.
6. UI or provider behavior: user-led manual steps in the evidence template.

**Report:** changed files; decisions and behavior changes; each command with its
RESULT line; passed, failed, and untested items listed separately.
```

## Worked example

Illustrative only. The numbers were measured on 2026-10-09 and are not current
data; re-measure before using a brief like this.

```markdown
# Task brief: enable useUnknownInCatchVariables in src

**Goal:** `src/tsconfig.json` sets `useUnknownInCatchVariables: true` and `src` type-checks.

**Authorization:** You are authorized to edit application code within the scope below.

**Measured starting point:** commit <sha>, 2026-10-09; line numbers may drift.

- In `src`: `pnpm exec tsc --noEmit -p . --useUnknownInCatchVariables` -> 48 errors, mostly TS18046:
  28 in 12 production files, 20 in `src/api/providers/__tests__/bedrock-error-handling.spec.ts`.

**Scope:** the flag; the catch blocks those 48 errors name.

**Out of scope:** `webview-ui`, `packages/*`, other tsconfig flags, unrelated failing tests.

**Behavior to preserve:** error messages, retry and error classification, and
what each catch block rethrows or logs.

**Forbidden shortcuts:** the standard list; in particular no `catch (e: any)`.
Narrow with `instanceof Error` or an existing type guard.

**Verification:** zoo-verify baseline and rerun on the changed files; 0 new
failures; `zoo-code-reviewer` not required (mechanical narrowing); `--full`
before commit or reported as not run.

**Report:** standard.
```
