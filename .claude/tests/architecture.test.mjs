import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"
import { BUNDLE_FILES, PROJECT_ROOT, parseFrontmatter, validateArchitecture } from "../scripts/validate-architecture.mjs"

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "zoo-claude-architecture-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const name of BUNDLE_FILES) {
    mkdirSync(dirname(join(root, name)), { recursive: true })
    writeFileSync(join(root, name), readFileSync(join(PROJECT_ROOT, name)))
  }
  writeFileSync(join(root, "AGENTS.md"), "# Existing repository baseline\n")
  writeFileSync(join(root, "package.json"), "{}\n")
  return root
}

function edit(root, name, mutate) {
  const path = join(root, name)
  writeFileSync(path, mutate(readFileSync(path, "utf8")))
}

function settings(root, mutate) {
  edit(root, ".claude/settings.json", (text) => {
    const data = JSON.parse(text)
    mutate(data)
    return JSON.stringify(data)
  })
}

function fails(root, pattern, options = {}) {
  const result = validateArchitecture({ projectRoot: root, ...options })
  assert.equal(result.ok, false)
  assert.match(result.errors.join("\n"), pattern)
}

// These checks validate static contracts, not model compliance or live Claude.
test("current project validates without freezing the future agent inventory", () => {
  const result = validateArchitecture()
  assert.equal(result.ok, true, result.errors.join("\n"))
  assert.ok(result.agents >= 1)
  assert.ok(result.skills >= 1)
})

test("isolated bootstrap fixture validates with exactly one custom agent", (t) => {
  const root = fixture(t)
  const result = validateArchitecture({ projectRoot: root, bootstrap: true })
  assert.equal(result.ok, true, result.errors.join("\n"))
  assert.equal(result.agents, 1)
  assert.equal(result.skills, 1)
})

test("accepts a minimal requested reviewer in normal validation, not bootstrap", (t) => {
  const root = fixture(t)
  writeFileSync(join(root, ".claude/agents/reviewer.md"), "---\nname: typescript-reviewer\ndescription: Inspect source without editing.\ntools:\n  - Read\n  - Glob\npermissionMode: plan\n---\n# Scope\nReport source-grounded findings only.\n")
  const result = validateArchitecture({ projectRoot: root })
  assert.equal(result.ok, true, result.errors.join("\n"))
  assert.equal(result.agents, 2)
  fails(root, /expected exactly one/, { bootstrap: true })
})

test("allows regular skill support files without pretending to validate their behavior", (t) => {
  const root = fixture(t)
  const support = join(root, ".claude/skills/zoo-architecture/scripts")
  mkdirSync(support, { recursive: true })
  writeFileSync(join(support, "support.mjs"), "// Deliberately not executed by the structural validator.\n")
  const result = validateArchitecture({ projectRoot: root })
  assert.equal(result.ok, true, result.errors.join("\n"))
})

test("rejects duplicate agent names", (t) => {
  const root = fixture(t)
  writeFileSync(join(root, ".claude/agents/duplicate.md"), readFileSync(join(root, ".claude/agents/zoo-code-architect.md")))
  fails(root, /duplicate agent name/)
})

test("rejects malformed frontmatter and duplicate fields", () => {
  assert.throws(() => parseFrontmatter("# No header"), /missing YAML frontmatter/)
  assert.throws(() => parseFrontmatter("---\nname: one\nname: two\n---\nBody"), /duplicate field/)
  assert.throws(() => parseFrontmatter("---\nname: one\n---\n"), /missing instruction body/)
})

test("supports the documented scalar/list subset and rejects nested YAML", () => {
  const data = parseFrontmatter('---\nname: sample\ndescription: "Description: quoted"\ntools:\n  - Read\npermissionMode: default\n---\nBody')
  assert.deepEqual(data.tools, ["Read"])
  assert.equal(data.description, "Description: quoted")
  assert.throws(() => parseFrontmatter("---\nname: sample\nhooks:\n  Nested: thing\n---\nBody"), /unsupported frontmatter/)
})

test("rejects unquoted YAML mapping syntax in scalar values", () => {
  assert.throws(() => parseFrontmatter("---\ndescription: Description: unquoted\n---\nBody"), /unsupported scalar/)
})

test("rejects unsupported agent fields instead of claiming compatibility", (t) => {
  const root = fixture(t)
  edit(root, ".claude/agents/zoo-code-architect.md", (text) => text.replace("model: inherit", "model: inherit\nomitClaudeMd: true"))
  fails(root, /unsupported agent field/)
})

test("rejects unsafe agent permission mode", (t) => {
  const root = fixture(t)
  edit(root, ".claude/agents/zoo-code-architect.md", (text) => text.replace("permissionMode: default", "permissionMode: bypassPermissions"))
  fails(root, /unsafe\/unsupported permission mode/)
})

test("rejects implicit delegation by the initial agent", (t) => {
  const root = fixture(t)
  edit(root, ".claude/agents/zoo-code-architect.md", (text) => text.replace("tools: Read,", "tools: Agent, Read,"))
  fails(root, /must not gain delegation/)
})

test("rejects an unknown native tool name", (t) => {
  const root = fixture(t)
  edit(root, ".claude/agents/zoo-code-architect.md", (text) => text.replace("tools: Read,", "tools: ShellMagic, Read,"))
  fails(root, /unsupported tool ShellMagic/)
})

test("rejects a persistent broad shell allowlist", (t) => {
  const root = fixture(t)
  settings(root, (data) => data.permissions.allow.push("Bash(pnpm *)"))
  fails(root, /persistent allow rules/)
})

test("rejects loss of shell approval and architecture write approval", (t) => {
  const root = fixture(t)
  settings(root, (data) => { data.permissions.ask = data.permissions.ask.filter((rule) => rule !== "Bash") })
  fails(root, /missing approval rule Bash/)
  settings(root, (data) => { data.permissions.ask.push("Bash"); data.permissions.ask = data.permissions.ask.filter((rule) => rule !== "Edit(.\/.claude/**)") })
  fails(root, /missing approval rule Edit/)
})

test("rejects loss of the known secret-file deny rules", (t) => {
  const root = fixture(t)
  settings(root, (data) => { data.permissions.deny = data.permissions.deny.filter((rule) => rule !== "Read(./.env)") })
  fails(root, /missing known secret rule/)
})

test("rejects invalid JSON and unsupported settings without silent fallback", (t) => {
  const root = fixture(t)
  settings(root, (data) => { data.model = "hardcoded-model" })
  fails(root, /unsupported top-level field/)
  writeFileSync(join(root, ".claude/settings.json"), "{ trailing: }")
  fails(root, /JSON|property|Unexpected/i)
})

test("requires Manual/default shared permission mode", (t) => {
  const root = fixture(t)
  settings(root, (data) => { data.permissions.defaultMode = "acceptEdits" })
  fails(root, /Manual\/default mode/)
})

test("keeps the main architecture skill explicitly user invoked", (t) => {
  const root = fixture(t)
  edit(root, ".claude/skills/zoo-architecture/SKILL.md", (text) => text.replace("disable-model-invocation: true", "disable-model-invocation: false"))
  fails(root, /explicitly user-invoked/)
})

test("detects missing managed files and missing authored link targets", (t) => {
  const root = fixture(t)
  unlinkSync(join(root, ".claude/README.md"))
  fails(root, /ENOENT/)
})

test("rejects links escaping the project", (t) => {
  const root = fixture(t)
  edit(root, "CLAUDE.md", (text) => `${text}\n[Outside](../outside.md)\n`)
  fails(root, /path escapes project/)
})

test("rejects a symlinked managed file even if its target is local", (t) => {
  const root = fixture(t)
  unlinkSync(join(root, ".claude/README.md"))
  symlinkSync("../AGENTS.md", join(root, ".claude/README.md"))
  fails(root, /symlinked bundle path/)
})

test("bounds recursive agent inventories", (t) => {
  const root = fixture(t)
  const nested = join(root, ".claude/agents/a/b/c/d/e/f")
  mkdirSync(nested, { recursive: true })
  fails(root, /directory nesting exceeds bound/)
})

test("requires the existing repository baseline import", (t) => {
  const root = fixture(t)
  edit(root, "CLAUDE.md", (text) => text.replace("@AGENTS.md", "AGENTS.md"))
  fails(root, /missing repository baseline import/)
})

test("static wording retains manual attribution, repair freedom, and honest coverage", () => {
  const agent = readFileSync(join(PROJECT_ROOT, ".claude/agents/zoo-code-architect.md"), "utf8")
  const contract = readFileSync(join(PROJECT_ROOT, ".claude/skills/zoo-architecture/references/authoring-contract.md"), "utf8")
  assert.match(agent, /Preserve unrelated edits, not broken behavior/)
  assert.match(agent, /user-reported manual evidence/)
  assert.match(agent, /explicitly requested application work/)
  assert.match(contract, /Outcome: passed \/ failed \/ untested/)
  assert.match(contract, /Missing prerequisite affects one criterion/)
  assert.match(contract, /Reconcile state before retry/)
  assert.match(contract, /Absence of production\s+proof is unverified/)
})

test("reviewer stays read-only and neither added agent gains delegation", () => {
  const load = (name) => parseFrontmatter(readFileSync(join(PROJECT_ROOT, `.claude/agents/${name}.md`), "utf8"), name)
  const tools = (agent) => agent.tools.split(",").map((tool) => tool.trim())
  const reviewer = load("zoo-code-reviewer")
  const debuggerAgent = load("zoo-code-debugger")
  for (const agent of [reviewer, debuggerAgent]) {
    assert.equal(agent.model, "inherit")
    assert.equal(agent.permissionMode, "default")
    assert.ok(!tools(agent).some((tool) => tool.startsWith("Agent")))
  }
  assert.ok(!tools(reviewer).some((tool) => tool === "Edit" || tool === "Write"))
  assert.match(debuggerAgent.description, /never production source/)
})

test("task brief skill is user invoked and keeps its guardrail sections", () => {
  const text = readFileSync(join(PROJECT_ROOT, ".claude/skills/zoo-task-brief/SKILL.md"), "utf8")
  const skill = parseFrontmatter(text, "zoo-task-brief")
  assert.equal(skill.name, "zoo-task-brief")
  assert.equal(skill["disable-model-invocation"], true)
  // Anchor to the template, not the worked example, which repeats the headings.
  assert.match(text, /^\*\*Forbidden shortcuts:\*\* `as any`[\s\S]*?--prune-suppressions/m)
  assert.match(text, /^\*\*Verification:\*\*\r?\n1\. Before editing: .*--save-baseline/m)
})

test("CLI exits nonzero on failure and rejects unsupported arguments", (t) => {
  const root = fixture(t)
  const script = join(root, ".claude/scripts/validate-architecture.mjs")
  let result = spawnSync(process.execPath, [script, "--unknown"], { encoding: "utf8" })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /Usage:/)
  settings(root, (data) => { data.permissions.defaultMode = "bypassPermissions" })
  result = spawnSync(process.execPath, [script], { encoding: "utf8" })
  assert.equal(result.status, 1)
  assert.match(result.stdout, /structural checks only/)
})
