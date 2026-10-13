---
name: zoo-verify
description: "Run focused, read-only TypeScript verification for the files changed in a Zoo Code implementation step: a type-escape scan of added lines, incremental tsc for the owning and dependent packages, ESLint with a no-prune suppression ratchet, Vitest related tests, and the lifecycle model check when relevant. Use after each implementation step and before handing work to review; not a substitute for code review or manual testing."
argument-hint: "[--only=escapes,types,lint,tests,model] [--full] [--save-baseline] <changed files>"
---

# Zoo Code focused verification

Run the script from the repository root with the files this step changed:

```sh
node .claude/skills/zoo-verify/scripts/verify.mjs <changed files...>
```

Pass explicit files. Without files it checks every uncommitted change, which in a
busy working tree mixes in unrelated work; the output warns when that happens.
Use `--dry-run` to see the plan first when the change spans several packages.

## What it runs

In this order, each only when relevant:

0. **escapes** (instant): scans only the lines this change added, against HEAD
   (untracked files in full). See "Type escapes" below.
1. **types**: the package's `check-types` script. A plain `tsc` script gets
   `--incremental` with a cache under `node_modules/.cache/zoo-verify`; the first
   run in `src` takes about 80 s, later runs about 8 s. Packages that depend on a
   changed package are type-checked too (for example `packages/types` changes).
2. **lint**: ESLint on the changed files only, with `--max-warnings=0` and
   `--pass-on-unpruned-suppressions`. Never `--fix`, never `--prune-suppressions`.
3. **tests**: `vitest related --run` in the owning package, which runs the tests
   that statically import the changed files. Core files can fan out widely
   (`Task.ts` reaches about 55 test files, about 110 s).
4. **model**: `pnpm lifecycle:model-check` (about 20 s) when task, lifecycle,
   provider-handoff, or model files change.
5. `--full`: root `pnpm check-types`, `pnpm lint`, `pnpm test`. Use before a
   commit of a lifecycle change, as AGENTS.md requires `pnpm test` then.

Use `--only=types,lint` for a quick loop while editing; run all checks once the
step is complete.

## Baseline: new versus existing failures

The working tree can already contain failing tests from other work. Before a
step, record them; afterwards, compare:

```sh
node .claude/skills/zoo-verify/scripts/verify.mjs --save-baseline <files>
# implement
node .claude/skills/zoo-verify/scripts/verify.mjs <files>
```

The result marks failures `[known]` when they were in the baseline, and counts
`new`, `known`, and `fixed`. A known failure is still a failure, not a pass. A
known failure may hide a new cause with the same test name; read it when the
changed code is involved. Lines are not part of the keys, so moved code does not
create false "new" failures. Delete or re-save a stale baseline
(`node_modules/.cache/zoo-verify/baseline.json`) after rebasing.

## Type escapes

Explicit `any` is caught by ESLint (`no-explicit-any` is an error) and the
suppression ratchet. The scan covers the escapes that bypass both:

| Added line contains                                             | Production | Tests, mocks, `test-utils`, e2e |
| --------------------------------------------------------------- | ---------- | ------------------------------- |
| `@ts-ignore`, `@ts-nocheck` in a comment                        | FAIL       | WARN                            |
| `eslint-disable…` without `-- reason`                           | FAIL       | WARN                            |
| `@ts-expect-error` without a description                        | WARN       | WARN                            |
| `as unknown as` without a comment on its line or the line above | WARN       | WARN                            |

Prefer, in this order: a precise type or generic; `satisfies` instead of `as`;
`unknown` plus a type guard or zod schema for external data; `vi.mocked()` and
typed helpers in `src/test-utils/` for test doubles. When a double assertion is
truly needed, add a comment saying why (AGENTS.md). Fix a FAIL by removing the
escape or, for `eslint-disable`, adding `-- <reason>`. Known false positives:
directive-like text inside string literals and template strings.

## ESLint suppressions: never prune automatically

`src/eslint-suppressions.json` is a ratchet: counts must never rise. ESLint's
`--prune-suppressions` rewrites the whole file from the current lint run, and it
removes more than intended in these cases (from ESLint 9.39 source):

- a linted file fails to parse: all of its suppressions count as unused and are
  deleted;
- a file is temporarily missing or renamed: its entries are deleted;
- an `any` is removed mid-edit and later restored: the lowered count stays, and
  the restored code then fails lint.

The script reports instead of rewriting:

- `suppression count increased vs HEAD`: a failure; fix the code, do not raise
  the count.
- `can lower by hand`: the changed file now needs fewer suppressions. Edit only
  that entry's `count` in `eslint-suppressions.json` (remove the rule entry at 0).
- `reduced vs HEAD outside this change`: possible over-pruning. Lint that file;
  if it now errors, restore that entry to its HEAD count from
  `git show HEAD:src/eslint-suppressions.json`. Never set a count above HEAD.
  Ask the user before restoring the whole file from HEAD, because that also
  discards intended reductions.

## Reading the result

The last line is `RESULT PASS|FAIL|INTERRUPTED | new N | known N | fixed N`.
Exit codes: 0 pass, 1 any failure, 2 usage error, 130 interrupted. `UNTESTED`
lines list what was not covered (dependent-package tests, dynamic imports,
extension-host e2e). Report them as untested; do not claim them as passed.

Passing checks show the code type-checks, lints, and passes related tests. They
do not prove lifecycle or concurrency correctness, live provider behavior, or
the UI. Use `zoo-code-reviewer` for risky diffs and a user-led manual check for
behavior that needs the installed extension.

## Limits and safety

- Writes only caches and reports under `node_modules/.cache/zoo-verify` (git
  ignored). It does not edit, format, stage, or prune tracked files.
- Shell commands still need approval under the project settings; that is
  deliberate. Concurrent runs in one package share the tsc cache; avoid them.
- New Vitest, ESLint, or TypeScript versions can change flags or report formats.
  On a parse failure the script falls back to the command's exit code and the
  last output lines; fix the parser rather than trusting a silent pass.
