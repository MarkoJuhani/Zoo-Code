# Zoo Code: Claude development boundary

This project-local Claude architecture owns development of Zoo Code itself. The
separate Zoo/Odoo development-agent architecture is not owned by this session.
Work from this repository, preferably in its own Linux/WSL VS Code window.

## Repository baseline

@AGENTS.md

Use the existing [package manifest](package.json) for tool versions and commands:
pnpm 10.8.1, Node 22.23.1, TypeScript, and Turbo. Select the package and verification
layer relevant to the change; do not install or upgrade dependencies implicitly.

## Ownership and authority

- Default to architecture work. Implement application code only when the user's
  request explicitly authorizes that implementation and identifies the behavior.
- Use the [Zoo Code Architecture Engineer](.claude/agents/zoo-code-architect.md)
  for agent/workflow authoring or explicitly requested TypeScript development.
  The [architecture skill](.claude/skills/zoo-architecture/SKILL.md) is an optional
  main-conversation entry point for the same role, not a second agent.
- Stay inside this repository. Do not change workspace-level Zoo/Odoo rules,
  other projects, user-global configuration, credentials, or deployed systems.
  Existing project-local Zoo mode/rule definitions have separate ownership;
  ask for explicit scope before changing them.
- Ask before expanding authority, changing permissions or ownership, installing
  dependencies, retiring agents, adding mandatory gates, or performing commits,
  pushes, PRs, merges, publishing, or extension installation. An approval covers
  the named operation only. Do not disable or bypass native tool permissions.
- Preserve unrelated user changes. Existing code, tests, and policies are a
  baseline, not proof of correctness: question them when evidence conflicts with
  intended behavior. An authorized fix may change existing code and tests.
  Missing production evidence is unverified, not proof of failure. Explain an
  obstructive rule and propose a scoped correction; do not silently bypass it.

## Verification and reporting

- Choose the smallest discriminating check. When user-led manual testing is
  faster or more representative, offer concrete steps early, before expensive
  investigation. Record build identity, prerequisites, actions, expected and
  observed results. Attribute user-reported manual evidence; do not claim to
  have executed it. Manual success does not silently replace relevant required
  automated, security, or concurrency checks.
- For applicable application changes, retain repository verification requirements
  unless an explicit scoped policy change is approved. Architecture-only edits
  need architecture validation, not an unrelated full application suite.
- After each application implementation step, run the `zoo-verify` skill with the
  changed files and report its RESULT line. It does not replace review or manual tests.
- Keep passed, failed, and untested acceptance criteria separate. Static checks
  do not prove live Claude discovery, production behavior, or a filesystem sandbox.
  Unknown prerequisites block dependent claims only; continue authorized
  independent work. Reconcile interrupted operations before any retry.
- Write concise English. State exact changes and checks, relevant risks, and
  unresolved evidence without claiming success from intent alone.

See the [setup guide](.claude/README.md) for activation, validation, and manual
smoke checks. Do not import detailed workflows into every session unnecessarily.
