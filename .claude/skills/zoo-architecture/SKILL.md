---
name: zoo-architecture
description: Author, revise, or review Zoo Code Claude agents and development workflows, or perform explicitly requested TypeScript implementation using the same architecture role.
argument-hint: "<create-agent | revise-agent | review-workflow | implement> <request>"
disable-model-invocation: true
---

# Zoo architecture workflow

Use this skill in the main conversation. Read the
[architecture agent definition](../../agents/zoo-code-architect.md) as the role
contract and the [authoring reference](references/authoring-contract.md) for
architecture tasks. This is another entry point for the same role, not another
agent. Reading its definition does not apply its native tool restrictions to the
main session: the main session's effective permissions remain in force.

## 1. Select scope

Interpret the user's request and any supplied arguments. Default to architecture
work. `implement` is permitted only when the request explicitly authorizes
application changes; examples of desired future agents do not grant that scope.
Identify outputs, exact target paths, acceptance criteria, and existing work to
preserve. Ask only for missing decisions that affect authority or the outcome.

## 2. Inspect and design

Read only the source/configuration relevant to the selected action. Reuse existing
agents or skills when appropriate. For a requested new agent, design its ownership,
inputs, outputs, tools, forbidden scope, approvals, and failure exits before
writing. Use the author's template. For application work, locate the behavioral
boundary and choose a small discriminating check, rather than presuming existing
behavior or tests are correct.

## 3. Review separately

Before writing, trace the happy path, ambiguous request, missing evidence,
permission denial, and interrupted operation. Check ownership conflicts,
unnecessary always-loaded context, unsafe tool grants, policy conflicts, and
unsupported verification/enforcement claims. Repair the design in this pass.
Do not spawn extra agents merely to satisfy the two-pass review. Ask before
changing authority/ownership, retiring agents, or adding mandatory gates.

## 4. Materialize the authorized change

Create or edit only authorized files, retaining unrelated user edits. Do not
install dependencies, change permissions, or perform Git/release operations without
specific approval. An approved task may fix defective existing code/tests;
preservation is not a freeze on behavior. Explain policy conflicts and obtain
approval for corrections that change protected authority or mandatory gates.

## 5. Verify efficiently

Prefer a short user-led manual test when it is faster or more representative;
use the [evidence template](references/authoring-contract.md#manual-test-and-evidence-template).
Run bounded architecture checks for architecture edits; choose source-backed
package tests/checks for implementation. Preserve applicable repository checks.
A manual pass is evidence for its named behavior, not a full-suite substitute.
Keep user-reported, agent-executed, static, and runtime evidence distinct.

Run `node .claude/scripts/validate-architecture.mjs` and
`node --test .claude/tests/architecture.test.mjs` from the repository root when
changing the architecture bundle. Do not use `--bootstrap` after intentionally
adding another agent: that flag proves the initial one-agent inventory only.
The validator covers its documented conservative subset; a newly needed native
feature requires source-backed validator maintenance, not an unsupported success.

## 6. Exit honestly

Return changes, evidence, and passed/failed/untested acceptance criteria. Retain
unknown prerequisites for dependent claims while continuing independent work.
Reconcile interrupted state before retrying; do not bypass denials or invent
runtime/production results. Ask for a bounded missing decision only when needed.
