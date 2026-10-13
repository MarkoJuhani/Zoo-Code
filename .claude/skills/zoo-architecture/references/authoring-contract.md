# Agent and workflow authoring contract

## Ownership split

- Existing workspace Zoo/Odoo development-agent architecture: its Zoo Architecture
  Engineer owns it. This project does not migrate or rewrite it.
- Zoo Code application and its project-local Claude development architecture: the
  Zoo Code Architecture Engineer owns the Claude definitions and workflows;
  application changes require an explicit implementation request.
- Existing project-local Zoo mode/rule files remain separately owned. A requested
  Claude agent does not authorize editing them or the workspace architecture.
- User/global/managed Claude configuration and credentials are not project assets.
  Do not read or change them to make discovery or approval work.

## When a new agent is warranted

Prefer an existing role or a skill. Create only agents explicitly requested by
the user with a concrete responsibility or tool-scope difference. Do not invent
an entire team from an aspirational list. Workflows may describe future roles
without creating, launching, or authorizing those roles.

An agent can write a definition without executing the agent. Do not rely on nested
delegation: verify installed capabilities and have the main conversation coordinate
when needed. This bootstrap deliberately grants no delegation tool to its agent.

## Definition template

Use YAML frontmatter accepted by the installed Claude version, followed by Markdown
instructions. This bundle's offline validator supports flat scalar fields and
lists of scalars, not the entire YAML language. Keep the initial configuration in
that conservative subset. Do not paste provider-native Zoo tool-call templates.

```yaml
---
name: unique-lowercase-role
description: State exactly when the role applies and when it does not.
tools: Read, Glob, Grep
model: inherit
permissionMode: default
---
```

Fill in all sections below; do not leave placeholder authority in a saved agent.

### Responsibility

State the owned outcome and the boundary with existing agents. Identify whether
application edits are allowed and what explicit request selects them.

### Inputs and scope

Require a concrete user request, authorized paths/operation, relevant source,
acceptance criteria, and any target/build identity needed for dependent claims.
Do not demand unrelated production evidence or invent age-based evidence expiry.

### Outputs

Name the necessary changed artifacts and evidence. Prefer a concise final result
over a compulsory report file. Record exact checks and unresolved criteria.

### Tools and approvals

List only tools needed for this role. Prefer inherited model selection. Keep
normal native permissions. Separately approve authority/ownership/permission
expansion, dependency installation, agent retirement, new mandatory gates,
commits, pushes, PRs, merges, publishing, and extension installation.
Approval for one operation does not grant a bypass, standing authority, or the
ability to erase an existing failure. Do not silently add an autonomous executor.

### Forbidden scope

Exclude other projects, workspace Zoo/Odoo architecture, secrets, global settings,
and deployed systems. Preserve unrelated user edits. Avoid broad shell, interpreter,
network, or write allowlists and unsupported claims of filesystem isolation.

### Procedure and verification

Give a short source inspection, design/repair, review, execution, and verification
sequence. Make manual verification first-class, using the template below. Use
source-backed package commands, the narrowest relevant test layer, and existing
applicable repository gates. Long procedures belong in on-demand skills.

### Failure exits

Unknown input/authority: ask the smallest relevant question. Failed/denied tool:
retain the result and change strategy or obtain the missing decision, not bypass
the restriction. Interrupted operation: reconcile state before retrying. Missing
prerequisite: retain dependent criteria as untested while independent authorized
work proceeds. Failure remains failed until new evidence establishes repair.

## Baseline is not proof

Preserve unrelated work, not defective behavior. Existing source, tests, and
policies may be wrong or incomplete. Challenge them with the intended contract,
source analysis, a reproduction, or a discriminating check. Absence of production
proof is unverified, not proof of a defect; tests passing locally do not establish
production correctness. Do not create a production-access requirement to fix a
local bug. An explicitly requested fix can update existing code and tests.

If an inherited rule blocks a justified fix, name the conflict, preserve its
purpose where relevant, and propose the smallest correction. Ordinary code fixes
stay within the authorized implementation task. Corrections to authority,
ownership, or mandatory gates need approval; do not quietly discard requirements.

## Two-pass review

Pass 1 designs the responsibility, output, least-privilege tools, and verification.
Pass 2 adversarially checks the design before edits. Trace these cases:

| Case                                           | Required outcome                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------- |
| Sufficient request and evidence                | Complete only authorized work; verify relevant criteria.               |
| Agent request resembles a feature request      | Create the requested definition, not the feature.                      |
| Existing behavior is broken or unproven        | Investigate; fix with authority; distinguish failure from uncertainty. |
| Fast manual test can resolve uncertainty       | Offer concrete steps before costly investigation.                      |
| Manual test passes; concurrency check is unrun | Preserve the manual pass and mark concurrency untested.                |
| Missing prerequisite affects one criterion     | Continue independent work; keep that criterion untested.               |
| Permission denied or command failed            | Retain evidence; obtain a decision or change strategy, never evade.    |
| Execution interrupted                          | Reconcile state before retry; do not infer success.                    |
| Existing rule conflicts with justified repair  | Propose a scoped correction; approve protected policy changes.         |

This is a reasoning workflow, not proof that a model will follow instructions.

## Manual test and evidence template

Use the fastest check that meaningfully discriminates the reported failure.
Ask the user to run it when their installed extension, UI, provider, or environment
is more representative or accessible. Do not make a manual pass a universal gate
for unrelated prompt edits. Keep the steps short and safe; never request secrets
or mutate a deployed target without separate authorization.

```text
Criterion / hypothesis:
Tested build: extension version + checkout/commit + relevant local edits
Environment: OS / VS Code / provider or account type, with no credentials
Prerequisites: settings, existing state, or approved install needed for this check
Actions: numbered, minimal steps
Expected observations: visible state or output at each discriminating point
Observed result: what actually happened, including error or unexpected state
Evidence owner: user-reported manual / agent-executed manual / automated / static
Outcome: passed / failed / untested, for this criterion only
Remaining coverage: what this check does not establish
Repair confirmation: repeat the relevant steps after the fix
```

A user's manual result is valid attributed evidence, not an agent-executed test.
Ask for screenshots or redacted output only if needed to disambiguate the result.
Record enough build identity to relate the observation to the changed behavior;
unknown identity limits the claim, not unrelated work. Do not impose artificial
time windows or automatic recollection. Add a focused automated regression test
when it protects the failure mode. Manual success cannot silently remove applicable
security, concurrency, lifecycle, or other repository-required verification.

## Architecture validation and its limits

From the repository root, run:

```sh
node .claude/scripts/validate-architecture.mjs
node --test .claude/tests/architecture.test.mjs
```

Use the additional `--bootstrap` flag only to check the initial inventory of
exactly one custom agent. Normal validation accepts explicitly added agents.
Checks cover bounded local structure, the documented frontmatter subset, unique
names, supported tool names, normal permission modes, known bootstrap safety
settings, and authored local links/imports. They do not constitute the official
Claude schema validator or prove runtime discovery, effective merged permissions,
model compliance, Bash isolation, manual observations, or production behavior.

New supported native fields can require updating this validator and its tests.
Verify the official source and installed version; do not work around errors by
claiming that an unchecked configuration is compatible. Native Claude validation
and live smoke checks remain separate evidence.
