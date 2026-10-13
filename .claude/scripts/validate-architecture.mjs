import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
export const BUNDLE_FILES = Object.freeze([
  "CLAUDE.md",
  ".claude/settings.json",
  ".claude/agents/zoo-code-architect.md",
  ".claude/skills/zoo-architecture/SKILL.md",
  ".claude/skills/zoo-architecture/references/authoring-contract.md",
  ".claude/README.md",
  ".claude/scripts/validate-architecture.mjs",
  ".claude/tests/architecture.test.mjs",
])
const AGENT_KEYS = new Set(["name", "description", "tools", "model", "permissionMode"])
const SKILL_KEYS = new Set(["name", "description", "argument-hint", "disable-model-invocation"])
const TOOLS = new Set(["Read", "Glob", "Grep", "Edit", "Write", "Bash", "WebFetch", "WebSearch", "AskUserQuestion", "Skill", "Agent"])
const MAX_FILE_BYTES = 64 * 1024
const MAX_ENTRIES = 200

function scalar(value, location) {
  if (value === "true" || value === "false") return value === "true"
  if (value.startsWith('"')) {
    const parsed = JSON.parse(value)
    if (typeof parsed !== "string") throw new Error(`${location}: expected a string`)
    return parsed
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'")
  if (!value || /^[\[\]{>|&*!@`]/.test(value) || /:\s|\s#/.test(value)) {
    throw new Error(`${location}: unsupported scalar; quote it or maintain the validator`)
  }
  return value
}

// Conservative authored subset only: no general YAML/schema/runtime claims.
export function parseFrontmatter(text, location = "frontmatter") {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!match) throw new Error(`${location}: missing YAML frontmatter`)
  const result = Object.create(null)
  let listKey
  for (const raw of match[1].split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue
    const item = /^  - (.+)$/.exec(raw)
    if (item && listKey) {
      result[listKey].push(scalar(item[1], location))
      continue
    }
    const field = /^([A-Za-z][\w-]*):(?: (.*))?$/.exec(raw)
    if (!field) throw new Error(`${location}: unsupported frontmatter line`)
    const [, key, value] = field
    if (Object.hasOwn(result, key)) throw new Error(`${location}: duplicate field ${key}`)
    listKey = value === undefined ? key : undefined
    result[key] = listKey ? [] : scalar(value, location)
  }
  if (!text.slice(match[0].length).trim()) throw new Error(`${location}: missing instruction body`)
  return result
}

function stringList(value, label) {
  const items = Array.isArray(value) ? value : typeof value === "string" ? value.split(",").map((item) => item.trim()) : []
  if (!items.length || items.some((item) => typeof item !== "string" || !item)) throw new Error(`${label}: expected a non-empty string list`)
  if (new Set(items).size !== items.length) throw new Error(`${label}: duplicate list entry`)
  return items
}

export function validateArchitecture({ projectRoot = PROJECT_ROOT, bootstrap = false } = {}) {
  const root = realpathSync(projectRoot)
  const errors = []
  const texts = new Map()
  const report = (error) => errors.push(error instanceof Error ? error.message : String(error))
  const checked = (action) => { try { return action() } catch (error) { report(error); return undefined } }

  function localPath(name) {
    const full = resolve(root, name)
    const rel = relative(root, full)
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`${name}: path escapes project`)
    let part = root
    for (const segment of rel.split(sep).filter(Boolean)) {
      part = resolve(part, segment)
      if (lstatSync(part).isSymbolicLink()) throw new Error(`${name}: symlinked bundle path`)
    }
    return full
  }

  function read(name) {
    if (texts.has(name)) return texts.get(name)
    const full = localPath(name)
    const info = lstatSync(full)
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error(`${name}: not a bounded regular file`)
    const text = readFileSync(full, "utf8")
    texts.set(name, text)
    return text
  }

  function markdownFiles(start) {
    const result = []
    let entries = 0
    function walk(name, depth) {
      if (depth > 5) throw new Error(`${start}: directory nesting exceeds bound`)
      for (const entry of readdirSync(localPath(name), { withFileTypes: true })) {
        if (++entries > MAX_ENTRIES) throw new Error(`${start}: inventory exceeds bound`)
        const child = `${name}/${entry.name}`
        if (entry.isSymbolicLink()) throw new Error(`${child}: symlinked bundle entry`)
        if (entry.isDirectory()) walk(child, depth + 1)
        else if (entry.isFile() && entry.name.endsWith(".md")) result.push(child)
        else if (!entry.isFile()) throw new Error(`${child}: unsupported entry in Markdown inventory`)
      }
    }
    walk(start, 0)
    return result
  }

  for (const name of BUNDLE_FILES) checked(() => read(name))
  checked(() => {
    const text = read("CLAUDE.md")
    if (!/^@AGENTS\.md\s*$/m.test(text)) throw new Error("CLAUDE.md: missing repository baseline import")
    if (!lstatSync(localPath("AGENTS.md")).isFile()) throw new Error("AGENTS.md: missing repository baseline")
  })

  checked(() => {
    const settings = JSON.parse(read(".claude/settings.json"))
    if (Object.keys(settings).some((key) => !["$schema", "permissions"].includes(key))) throw new Error("settings: unsupported top-level field; review validator coverage")
    const permissions = settings.permissions
    if (!permissions || permissions.defaultMode !== "default") throw new Error("settings: Manual/default mode is required")
    if (Object.keys(permissions).some((key) => !["defaultMode", "allow", "ask", "deny"].includes(key))) throw new Error("settings: unsupported permission field; review coverage")
    for (const key of ["allow", "ask", "deny"]) {
      if (!Array.isArray(permissions[key]) || permissions[key].some((item) => typeof item !== "string" || !item)) throw new Error(`settings: invalid ${key} rules`)
      if (new Set(permissions[key]).size !== permissions[key].length) throw new Error(`settings: duplicate ${key} rule`)
    }
    if (permissions.allow.length) throw new Error("settings: new persistent allow rules require an explicit authority decision and validator review")
    for (const rule of ["Bash", "Edit(./CLAUDE.md)", "Write(./CLAUDE.md)", "Edit(./AGENTS.md)", "Write(./AGENTS.md)", "Edit(./.claude/**)", "Write(./.claude/**)", "Edit(./.roomodes)", "Write(./.roomodes)", "Edit(./.roo/**)", "Write(./.roo/**)"]) {
      if (!permissions.ask.includes(rule)) throw new Error(`settings: missing approval rule ${rule}`)
    }
    for (const rule of ["Read(./.env)", "Read(./.env.*)", "Read(./**/.env)", "Read(./**/.env.*)", "Read(./**/*.pem)", "Read(./**/*.key)", "Read(./.mcp.json)", "Read(./.claude/settings.local.json)"]) {
      if (!permissions.deny.includes(rule)) throw new Error(`settings: missing known secret rule ${rule}`)
    }
    if (permissions.deny.includes("Bash") || permissions.deny.includes("Edit") || permissions.deny.includes("Write")) throw new Error("settings: bare tool denial conflicts with approved development")
  })

  const agentPaths = checked(() => markdownFiles(".claude/agents")) ?? []
  const names = new Set()
  for (const name of agentPaths) checked(() => {
    const agent = parseFrontmatter(read(name), name)
    if (Object.keys(agent).some((key) => !AGENT_KEYS.has(key))) throw new Error(`${name}: unsupported agent field; verify native support and maintain validator`)
    if (typeof agent.name !== "string" || !/^[a-z][a-z0-9-]*$/.test(agent.name)) throw new Error(`${name}: invalid agent name`)
    if (names.has(agent.name)) throw new Error(`${name}: duplicate agent name ${agent.name}`)
    names.add(agent.name)
    if (typeof agent.description !== "string" || !agent.description.trim()) throw new Error(`${name}: missing agent description`)
    if (!["default", "plan"].includes(agent.permissionMode)) throw new Error(`${name}: unsafe/unsupported permission mode`)
    if (agent.model !== undefined && (typeof agent.model !== "string" || !agent.model)) throw new Error(`${name}: invalid model`)
    for (const tool of stringList(agent.tools, `${name}: tools`)) {
      if (!TOOLS.has(tool) && !/^Agent\([a-z][a-z0-9-]*\)$/.test(tool)) throw new Error(`${name}: unsupported tool ${tool}`)
    }
    if (name === ".claude/agents/zoo-code-architect.md") {
      if (agent.name !== "zoo-code-architect" || agent.model !== "inherit" || agent.permissionMode !== "default") throw new Error(`${name}: initial role/model/permission contract changed; review ownership`)
      if (stringList(agent.tools, name).some((tool) => tool === "Agent" || tool.startsWith("Agent("))) throw new Error(`${name}: initial agent must not gain delegation implicitly`)
    }
  })
  if (!names.size) report("agents: no valid agent definitions")
  if (bootstrap && agentPaths.length !== 1) report("bootstrap: expected exactly one custom agent")

  const skillPaths = checked(() => markdownFiles(".claude/skills")) ?? []
  const skillNames = new Set()
  for (const name of skillPaths) {
    checked(() => read(name))
    if (!name.endsWith("/SKILL.md")) continue
    checked(() => {
      const skill = parseFrontmatter(read(name), name)
      if (Object.keys(skill).some((key) => !SKILL_KEYS.has(key))) throw new Error(`${name}: unsupported skill field; verify native support and maintain validator`)
      if (typeof skill.name !== "string" || !/^[a-z][a-z0-9-]*$/.test(skill.name)) throw new Error(`${name}: invalid skill name`)
      if (skillNames.has(skill.name)) throw new Error(`${name}: duplicate skill name`)
      skillNames.add(skill.name)
      if (typeof skill.description !== "string" || !skill.description.trim()) throw new Error(`${name}: missing skill description`)
      if (name === ".claude/skills/zoo-architecture/SKILL.md" && (skill.name !== "zoo-architecture" || skill["disable-model-invocation"] !== true)) throw new Error(`${name}: architecture skill must remain explicitly user-invoked`)
    })
  }

  for (const [name, text] of texts) {
    if (!name.endsWith(".md")) continue
    // Check authored inline local link files, not Markdown's full grammar or anchors.
    for (const match of text.matchAll(/\[[^\]\n]+\]\(([^\s)]+)\)/g)) {
      const href = match[1]
      if (/^https?:\/\//.test(href) || href.startsWith("#")) continue
      checked(() => {
        if (isAbsolute(href) || /^[a-z]+:/i.test(href)) throw new Error(`${name}: unsupported local link ${href}`)
        const target = href.split("#")[0]
        if (!lstatSync(localPath(relative(root, resolve(root, dirname(name), target)))).isFile()) throw new Error(`${name}: local link is not a file: ${href}`)
      })
    }
  }
  return { ok: errors.length === 0, errors, agents: names.size, skills: skillNames.size, files: texts.size }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.some((arg) => arg !== "--bootstrap")) {
    console.error("Usage: node .claude/scripts/validate-architecture.mjs [--bootstrap]")
    process.exitCode = 2
  } else {
    try {
      const result = validateArchitecture({ bootstrap: args.includes("--bootstrap") })
      for (const error of result.errors.slice(0, 30)) console.error(error)
      if (result.errors.length > 30) console.error(`(${result.errors.length - 30} additional errors omitted)`)
      console.log(`Claude architecture ${result.ok ? "OK" : "FAIL"}: agents=${result.agents} skills=${result.skills} files=${result.files}; structural checks only`)
      process.exitCode = result.ok ? 0 : 1
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    }
  }
}
