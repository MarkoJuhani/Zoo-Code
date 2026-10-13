# Claude Code development setup for Zoo Code

This setup creates three custom agents (**Zoo Code Architecture Engineer**,
**Zoo Code Reviewer**, **Zoo Code Debugger**), the user-invoked architecture
skill, and the `zoo-verify` verification skill. It does not replace the existing
Zoo/Odoo agent architecture or edit existing Zoo modes/rules.

## What is included

| File                                                                           | Responsibility                                                                             |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| [Project instructions](../CLAUDE.md)                                           | Always-loaded compact scope, approvals, verification, and existing repository conventions. |
| [Settings](settings.json)                                                      | Conservative native permission defaults; no blanket shell allowlist.                       |
| [Agent](agents/zoo-code-architect.md)                                          | Architecture authoring; TypeScript work only when explicitly requested.                    |
| Reviewer: `agents/zoo-code-reviewer.md`                                        | Fresh-context, read-only review of a diff; ranked findings, no edits.                      |
| Debugger: `agents/zoo-code-debugger.md`                                        | Root cause and failing regression test; edits test files only.                             |
| [Skill](skills/zoo-architecture/SKILL.md)                                      | User-invoked architecture workflow in the main conversation.                               |
| Verify skill: `skills/zoo-verify/SKILL.md`                                     | Focused read-only checks for changed files; no ESLint pruning.                             |
| Task brief skill: `skills/zoo-task-brief/SKILL.md`                             | User-invoked: drafts an implementation brief from measured facts and stops for approval.   |
| [Authoring contract](skills/zoo-architecture/references/authoring-contract.md) | Agent template, adversarial review, manual-test/evidence format.                           |
| [Validator](scripts/validate-architecture.mjs)                                 | Bounded offline configuration/link checks.                                                 |
| [Tests](tests/architecture.test.mjs)                                           | Validator regressions and bootstrap-contract assertions.                                   |

No other agents, dependencies, MCP configuration, hooks, command duplicates,
user-local settings, or global configuration are created. These files are normal
project assets; creating them does not commit, publish, or install anything.

## Activate in VS Code / WSL

1. Prefer opening Zoo Code itself as a separate VS Code folder in Linux/WSL,
   rather than starting Claude at the containing V19 workspace. Confirm the
   Claude session's working directory is this repository. Do not grant the whole
   parent workspace as an additional directory just to discover these files.
2. The VS Code extension bundles a CLI for its chat panel. A standalone `claude`
   command is not required for that panel. Check the extension version in the
   Extensions view; confirm whether it is installed/running in the WSL context.
3. Start a fresh Claude session after creating the files. Check which project
   instructions and settings loaded using the extension's available session/
   configuration UI. Confirm the active mode is Manual/default and review the
   effective permissions, including pre-existing user/local/managed overrides.
4. Invoke `/zoo-architecture create-agent <your request>`, or ask the main
   conversation to use `zoo-code-architect` for the task. Use the extension's
   available agent picker/mentions if supported by its installed version. Do not
   assume a terminal-only agent-management command works in the chat panel.
5. If the custom skill/agent is missing, verify working directory and extension
   version first; restart the session. Do not silently install/upgrade tools or
   alter global settings. Report discovery as unverified until observed live.

Project-local instructions do not override all ancestor/user/managed instructions:
Claude may concatenate instruction files above the working directory, and settings
can merge with other scopes. Opening this folder is a practical scope choice, not
proof of complete isolation. Do not copy workspace Zoo/Gemini tool workarounds
into Claude instructions to resolve a conflict.

## Future standalone CLI use

After a separately approved standalone CLI installation, start `claude` from this
repository and use the skill. When supported by that CLI version, `claude --agent
zoo-code-architect` selects the named role for the main session. Agent-management
and status commands vary by version; check native help instead of guessing.
No installation is performed by this bootstrap.

## Development workflow

The main session coordinates and implements; subagents cannot launch subagents.
None of these steps is a mandatory gate.

1. Bug with an unclear cause: ask for `zoo-code-debugger`. It returns a root
   cause, rejected hypotheses, a failing regression test, and manual steps.
2. Non-trivial change: run `/zoo-task-brief <task>`; the approved brief is the implementation prompt.
3. The main session implements the smallest fix, then runs `zoo-verify` with
   the changed files (`--save-baseline` before starting when tests already fail).
4. Before committing a non-trivial change: ask for `zoo-code-reviewer` on the
   diff. Fix CONFIRMED findings; decide on PLAUSIBLE ones.
5. Run the user-led manual check when the behavior needs the installed extension.

Delegate when the agent would read far more than it returns (long traces, large
files such as `Task.ts`, independent review). Keep small, well-located fixes in
the main session: a subagent re-reads context the main session already has.
Tool restrictions in the reviewer and debugger prompts (read-only, tests-only)
are instructions; `Bash` and `Edit` are not path-sandboxed.

## Use it to create your next agent

Example request:

> Create a project-local TypeScript reviewer for Zoo Code. It may inspect source
> and report defects, but may not edit application files or install tools. Focus
> on lifecycle and concurrency boundaries. Define tools and failure exits, and
> give me a fast manual check when that is more informative than another test.

The architect should inspect relevant source, decide whether an existing role or
skill suffices, design a requested role, adversarially review it, and materialize
only the authorized definition. It must not implement the feature described in
that definition. New agents are created only when requested, not as a full team.

For application work, explicitly request implementation and name the behavior.
The same initial agent can then fix existing TypeScript and tests within scope.
Preserve unrelated user edits, not defective behavior. Existing policies can be
questioned; changes to authority/ownership or mandatory gates require approval.

## Manual smoke checks

These are user-led checks, not claims that bootstrap validation already executed
the extension. Use the [manual evidence template](skills/zoo-architecture/references/authoring-contract.md#manual-test-and-evidence-template).
Record extension/build identity and attribute the user's observations.

| Check                        | Minimal action                                                               | Expected observation / limits                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Discovery                    | Open this folder, start a new session, inspect skill/agent availability.     | Custom skill and named agent are available; project instructions/settings are loaded.                              |
| Ownership                    | Ask the agent to explain the two architectures without edits.                | It separates Claude Zoo Code development from the existing Zoo/Odoo architecture.                                  |
| Definition vs implementation | In a disposable copy, request a read-only reviewer definition.               | It creates the requested agent definition, not application changes or extra roles.                                 |
| Approval boundary            | Ask for a proposed dependency install, but do not approve execution.         | It requests approval rather than executing or changing command form to evade it.                                   |
| Repair philosophy            | Describe a reproducible broken behavior in existing code and ask for a plan. | It investigates and proposes a scoped fix, rather than freezing the old behavior.                                  |
| Manual-first workflow        | Describe a UI issue requiring your installed extension.                      | It supplies short actions/expected results and attributes your report; unrelated checks are not claimed as passed. |

Do not manufacture an expensive manual test for every architecture edit. Prefer
manual testing early when it resolves uncertainty faster; keep applicable automated
regression/security/concurrency checks, and list untested coverage explicitly.
Any file-writing smoke check should use a disposable copy or separate authorization.

## Offline verification

Run from the Zoo Code repository root:

```sh
node --check .claude/scripts/validate-architecture.mjs
node --check .claude/tests/architecture.test.mjs
node .claude/scripts/validate-architecture.mjs --bootstrap
node --test .claude/tests/architecture.test.mjs
node --test .claude/tests/zoo-verify.test.mjs
```

After intentionally adding more agents, omit `--bootstrap`. The validator accepts
unique additional agent definitions in its documented conservative subset. Extend
it with tests when a verified native feature needs additional supported fields.
It is not the official runtime/schema validator or a behavior/sandbox guarantee.

For application changes, use source-backed commands from the package that owns
the behavior and preserve relevant [repository requirements](../AGENTS.md).
Do not run an unrelated full app suite merely because a prompt changed.

## Permission and evidence limitations

- Shared settings request approval for shell commands and changes to architecture
  surfaces. The agent's approval obligations also cover authority expansion,
  dependency installation, commits, pushes, PRs, merges, publishing, and installs.
- Native Read deny rules cover the listed common secret-file patterns, not every
  possible secret. They do not stop an approved shell command reading a file.
  Review shell commands; never treat a Read deny rule as a Bash sandbox.
- No broad tool allowlist or permission-bypass mode is configured. Existing global,
  local, managed, and UI-selected settings may affect effective behavior; check
  them without reading credentials or automatically rewriting those sources.
- The initial agent has no delegation tool. Skill execution in the main conversation
  is governed by that main session's tools, not a newly applied subagent allowlist.
- Static checks establish local structure only. Record live discovery, manual,
  automated, and production evidence separately, with failed/untested criteria.

Official references: [instructions](https://code.claude.com/docs/en/memory),
[agents](https://code.claude.com/docs/en/sub-agents),
[skills](https://code.claude.com/docs/en/skills),
[permissions](https://code.claude.com/docs/en/permissions),
[settings](https://code.claude.com/docs/en/settings), and
[VS Code](https://code.claude.com/docs/en/vs-code). Installed-version compatibility
and live effective settings must be checked separately; do not assume latest
online documentation describes an older installed extension.
