#!/usr/bin/env node
// Focused TypeScript verification for Zoo Code changes.
//
// Read-only for source and configuration: never runs `eslint --fix` or
// `--prune-suppressions`, never formats, stages, or edits tracked files.
// Writes only tool caches and reports under `node_modules/.cache/zoo-verify`.
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
const LINTABLE = /\.(?:[cm]?[jt]sx?)$/
const SUPPRESSIONS = "eslint-suppressions.json"
const MAX_CAPTURE = 512 * 1024

// Files whose change can affect `pnpm lifecycle:model-check` or the semantics it models.
export const LIFECYCLE_TRIGGERS = [
	/^src\/core\/task-persistence\//,
	/^src\/core\/task\//,
	/^src\/core\/assistant-message\//,
	/^src\/core\/webview\/ClineProvider\.ts$/,
	/^src\/shared\/tools\.ts$/,
	/^packages\/types\/src\/(?:history|mode)\.ts$/,
	/^scripts\/(?:check-|run-native-tool-call-parser-scoping)/,
	/^docs\/architecture\/task-[\w-]*model\.md$/,
]

// Files that usually take part in a persisted-setting round trip (AGENTS.md checklist).
export const SETTINGS_TRIGGERS = [
	/^packages\/types\/src\/global-settings\.ts$/,
	/^packages\/types\/src\/vscode-extension-host\.ts$/,
	/^webview-ui\/src\/components\/settings\//,
	/^src\/core\/webview\/webviewMessageHandler\.ts$/,
]

const USAGE = `Usage: node .claude/skills/zoo-verify/scripts/verify.mjs [options] [files...]

Files are the ones changed by this implementation step (repo-relative or
absolute). Without files, all uncommitted changes are used and flagged.

Options:
  --only=<list>      Comma list of checks: escapes,types,lint,tests,model (default: all)
  --full             Also run root turbo check-types, lint and test
  --save-baseline    Record this run's failures as the known baseline
  --no-baseline      Ignore a saved baseline
  --dry-run          Print the plan without running checks
  --json             Print the result as JSON
  --max-lines=<n>    Detail lines per failing check (default: 15)
  --timeout=<sec>    Per-check timeout in seconds (default: 900)
  -h, --help         Show this help`

export function parseArgs(argv) {
	const options = { files: [], only: null, full: false, saveBaseline: false, useBaseline: true, dryRun: false, json: false, maxLines: 15, timeoutSec: 900 }
	const checks = new Set(["escapes", "types", "lint", "tests", "model"])
	for (const arg of argv) {
		if (arg === "-h" || arg === "--help") return { help: true }
		else if (arg === "--full") options.full = true
		else if (arg === "--save-baseline") options.saveBaseline = true
		else if (arg === "--no-baseline") options.useBaseline = false
		else if (arg === "--dry-run") options.dryRun = true
		else if (arg === "--json") options.json = true
		else if (arg.startsWith("--only=")) {
			options.only = new Set(arg.slice(7).split(",").filter(Boolean))
			for (const check of options.only) if (!checks.has(check)) throw new Error(`Unknown check: ${check}`)
		} else if (arg.startsWith("--max-lines=")) options.maxLines = positiveInt(arg.slice(12), "--max-lines")
		else if (arg.startsWith("--timeout=")) options.timeoutSec = positiveInt(arg.slice(10), "--timeout")
		else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`)
		else options.files.push(arg)
	}
	return options
}

function positiveInt(value, name) {
	const number = Number(value)
	if (!Number.isInteger(number) || number <= 0) throw new Error(`${name} needs a positive integer`)
	return number
}

const toPosix = (path) => path.split(sep).join("/")

/** Normalize user-supplied paths to repo-relative POSIX paths inside ROOT. */
export function normalizeFiles(files, { root = ROOT, cwd = process.cwd() } = {}) {
	const result = new Set()
	for (const file of files) {
		const rel = toPosix(relative(root, resolve(cwd, file)))
		if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error(`Path is outside the repository: ${file}`)
		result.add(rel)
	}
	return [...result].sort()
}

function git(args, root = ROOT) {
	const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`)
	return result.stdout
}

function changedFiles(root = ROOT) {
	const tracked = git(["diff", "--name-only", "HEAD"], root).split("\n")
	const untracked = git(["ls-files", "--others", "--exclude-standard"], root).split("\n")
	return [...new Set([...tracked, ...untracked].filter(Boolean))].sort()
}

/** Workspace packages from pnpm-workspace.yaml (simple `- "dir"` and `- "dir/*"` entries). */
export function workspacePackages(root = ROOT) {
	const yaml = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8")
	const dirs = []
	for (const match of yaml.matchAll(/^\s*-\s*["']?([^"'#\s]+)["']?/gm)) {
		const pattern = match[1]
		if (pattern.endsWith("/*")) {
			const parent = pattern.slice(0, -2)
			if (!existsSync(join(root, parent))) continue
			for (const entry of readdirSync(join(root, parent), { withFileTypes: true })) {
				if (entry.isDirectory()) dirs.push(`${parent}/${entry.name}`)
			}
		} else dirs.push(pattern)
	}
	const packages = []
	for (const dir of dirs) {
		const manifest = join(root, dir, "package.json")
		if (!existsSync(manifest)) continue
		const pkg = JSON.parse(readFileSync(manifest, "utf8"))
		const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies }
		const workspaceDeps = Object.entries(deps).filter(([, v]) => String(v).startsWith("workspace:")).map(([k]) => k)
		packages.push({ dir, name: pkg.name, scripts: pkg.scripts ?? {}, workspaceDeps })
	}
	return packages.sort((a, b) => b.dir.length - a.dir.length)
}

export function ownerOf(file, packages) {
	return packages.find((pkg) => file === pkg.dir || file.startsWith(`${pkg.dir}/`))
}

/** Packages that depend on `name`, directly or transitively. */
export function dependentsOf(name, packages) {
	const found = new Set()
	const queue = [name]
	while (queue.length) {
		const current = queue.shift()
		for (const pkg of packages) {
			if (pkg.workspaceDeps.includes(current) && !found.has(pkg.name)) {
				found.add(pkg.name)
				queue.push(pkg.name)
			}
		}
	}
	return packages.filter((pkg) => found.has(pkg.name))
}

/** Build the ordered check plan: types -> lint -> tests -> model, as cheap feedback first. */
export function buildPlan(files, { packages, only = null, full = false, exists = (f) => existsSync(join(ROOT, f)) }) {
	const want = (check) => !only || only.has(check)
	const owned = new Map()
	const outside = []
	for (const file of files) {
		const pkg = ownerOf(file, packages)
		if (!pkg) outside.push(file)
		else owned.set(pkg, [...(owned.get(pkg) ?? []), file])
	}
	const steps = []
	const notes = []
	const untested = []

	const scannable = files.filter((f) => LINTABLE.test(f) && exists(f))
	if (want("escapes") && scannable.length) steps.push({ check: "escapes", pkg: ".", files: scannable, command: ["(built-in) scan added lines for type escapes"] })

	if (want("types")) {
		const typePackages = new Map()
		for (const pkg of owned.keys()) {
			typePackages.set(pkg.name, { pkg, reason: "changed" })
			for (const dependent of dependentsOf(pkg.name, packages)) {
				if (!typePackages.has(dependent.name)) typePackages.set(dependent.name, { pkg: dependent, reason: `depends on ${pkg.name}` })
			}
		}
		for (const { pkg, reason } of typePackages.values()) {
			const script = pkg.scripts["check-types"]
			if (!script) continue
			steps.push({ check: "types", pkg: pkg.dir, reason, command: typeCommand(script) })
		}
	}

	for (const [pkg, pkgFiles] of owned) {
		const present = pkgFiles.filter(exists)
		const deleted = pkgFiles.filter((f) => !exists(f))
		if (deleted.length) notes.push(`${pkg.dir}: ${deleted.length} deleted file(s); covered only by type checks and dependent tests`)
		const local = present.map((f) => f.slice(pkg.dir.length + 1))
		const lintable = local.filter((f) => LINTABLE.test(f))
		if (want("lint") && pkg.scripts.lint && lintable.length) {
			steps.push({ check: "lint", pkg: pkg.dir, files: lintable, command: ["pnpm", "exec", "eslint", "--max-warnings=0", "--pass-on-unpruned-suppressions", "--no-warn-ignored", "--format", "json"] })
		}
		if (want("tests") && pkg.scripts.test && lintable.length) {
			if (/\bvitest\b/.test(pkg.scripts.test)) {
				steps.push({ check: "tests", pkg: pkg.dir, files: lintable, command: ["pnpm", "exec", "vitest", "related", "--run", "--passWithNoTests", "--reporter=json"] })
			} else steps.push({ check: "tests", pkg: pkg.dir, command: ["pnpm", "run", "test"] })
		}
		if (pkg.dir === "apps/vscode-e2e") untested.push("apps/vscode-e2e: extension-host e2e tests are not run by this tool")
	}
	if (owned.size && want("tests") && !full) untested.push("tests in dependent packages and dynamically imported modules (use --full before commit)")

	if (want("model") && files.some((f) => LIFECYCLE_TRIGGERS.some((re) => re.test(f)))) {
		steps.push({ check: "model", pkg: ".", command: ["pnpm", "lifecycle:model-check"] })
	}
	if (files.some((f) => SETTINGS_TRIGGERS.some((re) => re.test(f)))) {
		notes.push("Settings files changed: walk the Persisted Setting Checklist in AGENTS.md; this tool does not verify the round trip")
	}
	if (outside.length) notes.push(`${outside.length} file(s) outside workspace packages: ${outside.slice(0, 5).join(", ")}${outside.length > 5 ? ", ..." : ""}`)
	if (full) for (const task of ["check-types", "lint", "test"]) steps.push({ check: "full", pkg: ".", command: ["pnpm", task] })
	return { steps, notes, untested }
}

/** Add compact output and an incremental cache to a plain `tsc ...` script; otherwise run it as-is. */
export function typeCommand(script) {
	if (/^tsc(?:\s|$)/.test(script) && !/[;&|]/.test(script)) {
		return ["pnpm", "exec", ...script.split(/\s+/), "--pretty", "false", "--incremental", "--tsBuildInfoFile", "node_modules/.cache/zoo-verify/tsc.tsbuildinfo"]
	}
	return ["pnpm", "run", "check-types"]
}

export const isTestFile = (file) => /(?:^|\/)(?:__tests__|__mocks__|test-utils)\/|\.(?:spec|test)\.[cm]?[jt]sx?$|^apps\/vscode-e2e\//.test(file)

/** Added lines with their new line numbers from a `git diff -U0` of one file. */
export function parseAddedLines(diff) {
	const added = []
	let line = 0
	for (const raw of diff.split("\n")) {
		const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
		if (hunk) line = Number(hunk[1])
		else if (raw.startsWith("+") && !raw.startsWith("+++")) added.push({ line: line++, text: raw.slice(1) })
	}
	return added
}

const isCommentLine = (text = "") => {
	const trimmed = text.trim()
	return trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.endsWith("*/")
}

/**
 * Type escapes on added lines. Explicit `any` is left to ESLint and the suppression ratchet.
 * Production: @ts-ignore, @ts-nocheck and unexplained eslint-disable fail; tests only warn.
 * A double assertion is accepted with a comment on its line or the line above (AGENTS.md).
 */
export function scanEscapes(added, fileLines, isTest) {
	const findings = []
	const strict = isTest ? "warn" : "fail"
	for (const { line, text } of added) {
		const directive = /(?:\/\/|\/\*|^\s*\*)\s*@ts-(ignore|nocheck|expect-error)\b(.*)/.exec(text)
		if (directive?.[1] === "ignore" || directive?.[1] === "nocheck") {
			findings.push({ kind: `ts-${directive[1]}`, severity: strict, line, text })
		} else if (directive && !directive[2].replace(/\*\/.*$/, "").replace(/^[\s:-]+/, "").trim()) {
			findings.push({ kind: "ts-expect-error-without-description", severity: "warn", line, text })
		}
		const disable = /(?:\/\/|\/\*)\s*eslint-disable(?:-next-line|-line)?\b(.*)/.exec(text)
		if (disable && !/\s--\s*\S/.test(disable[1])) {
			findings.push({ kind: "eslint-disable-without-reason", severity: strict, line, text })
		}
		const cast = /\bas\s+unknown\s+as\b/.exec(text)
		if (cast && !isCommentLine(text) && !text.slice(cast.index).includes("//") && !isCommentLine(fileLines[line - 2])) {
			findings.push({ kind: "double-assertion-without-comment", severity: "warn", line, text })
		}
	}
	return findings
}

function scanStep(step) {
	const started = Date.now()
	const result = { check: "escapes", pkg: ".", command: "scan added lines (git diff -U0 HEAD; untracked files in full)", failures: [], notes: [] }
	let warnings = 0
	for (const file of step.files) {
		const content = readFileSync(join(ROOT, file), "utf8")
		const fileLines = content.split("\n")
		const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "--", file], { cwd: ROOT, stdio: "ignore" }).status === 0
		const added = tracked ? parseAddedLines(git(["diff", "-U0", "HEAD", "--", file])) : fileLines.map((text, i) => ({ line: i + 1, text }))
		for (const finding of scanEscapes(added, fileLines, isTestFile(file))) {
			const text = `${file}:${finding.line} ${finding.kind}: ${finding.text.trim().slice(0, 160)}`
			if (finding.severity === "fail") result.failures.push({ key: `${file}:${finding.kind}:${finding.text.trim()}`, file, message: finding.kind, text })
			else { warnings++; result.notes.push(`WARN ${text}`) }
		}
	}
	result.seconds = Number(((Date.now() - started) / 1000).toFixed(1))
	result.warnings = warnings
	result.status = result.failures.length ? "fail" : warnings ? "warn" : "pass"
	return result
}

function run(command, { cwd, timeoutSec, signal }) {
	return new Promise((resolvePromise) => {
		const started = Date.now()
		const child = spawn(command[0], command.slice(1), { cwd, env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] })
		let output = ""
		const collect = (chunk) => { output = (output + chunk).slice(-MAX_CAPTURE) }
		child.stdout.on("data", collect)
		child.stderr.on("data", collect)
		let timedOut = false
		const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM") }, timeoutSec * 1000)
		const abort = () => child.kill("SIGTERM")
		signal.addEventListener("abort", abort, { once: true })
		child.on("error", (error) => collect(`\n${error.message}`))
		child.on("close", (code) => {
			clearTimeout(timer)
			signal.removeEventListener("abort", abort)
			resolvePromise({ code: code ?? 1, output, timedOut, seconds: (Date.now() - started) / 1000 })
		})
	})
}

/** Parse `tsc --pretty false` output into stable failure records. */
export function parseTsc(output) {
	const failures = []
	for (const line of output.split("\n")) {
		const match = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line.trim())
		if (match) failures.push({ key: `${match[1]}:${match[4]}:${match[5]}`, file: match[1], message: `${match[4]} ${match[5]}`, text: `${match[1]}:${match[2]}:${match[3]} ${match[4]} ${match[5]}` })
	}
	return failures
}

/** Parse ESLint JSON results; bulk-suppressed counts feed the read-only ratchet check. */
export function parseEslint(results, pkgRoot) {
	const failures = []
	const fatal = []
	const suppressed = {}
	for (const result of results) {
		const file = toPosix(relative(pkgRoot, result.filePath))
		for (const message of result.messages) {
			if (message.fatal) fatal.push(file)
			const rule = message.ruleId ?? "parse"
			failures.push({ key: `${file}:${rule}:${message.message}`, file, message: `${rule} ${message.message}`, text: `${file}:${message.line ?? 0}:${message.column ?? 0} ${rule} ${message.message}` })
		}
		for (const message of result.suppressedMessages ?? []) {
			if (!message.suppressions?.some((s) => s.kind === "file")) continue
			suppressed[file] ??= {}
			suppressed[file][message.ruleId] = (suppressed[file][message.ruleId] ?? 0) + 1
		}
	}
	return { failures, fatal, suppressed }
}

/**
 * Compare suppression budgets without pruning.
 * - increased: working-tree count above HEAD (policy: counts must never increase)
 * - lowerable: linted file uses fewer suppressions than budgeted (safe to lower by hand)
 * - removedElsewhere: HEAD entries reduced/removed for files outside this change (possible over-prune)
 */
export function compareSuppressions({ head = {}, current = {}, suppressed = {}, linted = [], fatal = [], changed = [] }) {
	const increased = []
	const lowerable = []
	const removedElsewhere = []
	const count = (data, file, rule) => data[file]?.[rule]?.count ?? 0
	for (const file of Object.keys(current)) {
		for (const rule of Object.keys(current[file])) {
			const before = count(head, file, rule)
			const now = count(current, file, rule)
			if (now > before) increased.push(`${file} ${rule}: ${before} -> ${now}`)
		}
	}
	for (const file of linted) {
		if (fatal.includes(file)) continue
		for (const rule of Object.keys(current[file] ?? {})) {
			const used = suppressed[file]?.[rule] ?? 0
			const budget = count(current, file, rule)
			if (used < budget) lowerable.push(`${file} ${rule}: ${budget} -> ${used}`)
		}
	}
	for (const file of Object.keys(head)) {
		if (changed.includes(file)) continue
		for (const rule of Object.keys(head[file])) {
			const before = count(head, file, rule)
			const now = count(current, file, rule)
			if (now < before) removedElsewhere.push(`${file} ${rule}: ${before} -> ${now}`)
		}
	}
	return { increased, lowerable, removedElsewhere }
}

/** Parse a Vitest JSON report into failure records. */
export function parseVitest(report, pkgRoot) {
	const failures = []
	for (const suite of report.testResults ?? []) {
		const file = toPosix(relative(pkgRoot, suite.name))
		const failed = (suite.assertionResults ?? []).filter((a) => a.status === "failed")
		for (const test of failed) {
			const first = (test.failureMessages?.[0] ?? "").split("\n")[0].slice(0, 200)
			failures.push({ key: `${file}>${test.fullName}`, file, message: first, text: `${file} > ${test.fullName}: ${first}` })
		}
		if (!failed.length && suite.status === "failed") {
			const message = (suite.message ?? "suite failed").split("\n")[0].slice(0, 200)
			failures.push({ key: `${file}>(suite)`, file, message, text: `${file}: ${message}` })
		}
	}
	return { failures, files: report.testResults?.length ?? 0, tests: report.numTotalTests ?? 0 }
}

const tail = (output, lines) => output.trim().split("\n").slice(-lines).map((line) => line.slice(0, 240))

function readJson(path) {
	try { return JSON.parse(readFileSync(path, "utf8")) } catch { return undefined }
}

function headJson(path) {
	const result = spawnSync("git", ["show", `HEAD:${path}`], { cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
	if (result.status !== 0) return {}
	try { return JSON.parse(result.stdout) } catch { return {} }
}

async function execute(step, context) {
	const cwd = join(ROOT, step.pkg)
	const cacheDir = join(cwd, "node_modules/.cache/zoo-verify")
	mkdirSync(cacheDir, { recursive: true })
	const report = join(cacheDir, `${step.check}-report.json`)
	rmSync(report, { force: true })
	const command = [...step.command]
	if (step.check === "lint") command.push("--output-file", report, ...step.files)
	if (step.check === "tests" && command.includes("related")) command.push(`--outputFile=${report}`, ...step.files)
	const outcome = await run(command, { cwd, timeoutSec: context.timeoutSec, signal: context.signal })
	const result = { check: step.check, pkg: step.pkg, reason: step.reason, command: command.join(" "), seconds: Number(outcome.seconds.toFixed(1)), failures: [], notes: [] }

	if (context.signal.aborted) return { ...result, status: "interrupted" }
	if (outcome.timedOut) return { ...result, status: "fail", failures: [{ key: `${step.check}:${step.pkg}:timeout`, text: `timed out after ${context.timeoutSec}s` }] }

	if (step.check === "types" && command.includes("--pretty")) {
		result.failures = parseTsc(outcome.output)
	} else if (step.check === "lint") {
		const results = readJson(report)
		if (!results) result.failures = [{ key: `lint:${step.pkg}:crash`, text: tail(outcome.output, 5).join(" | ") }]
		else {
			const parsed = parseEslint(results, cwd)
			result.failures = parsed.failures
			const suppressionsPath = join(cwd, SUPPRESSIONS)
			if (existsSync(suppressionsPath)) {
				const changedHere = context.files.filter((f) => f.startsWith(`${step.pkg}/`)).map((f) => f.slice(step.pkg.length + 1))
				const ratchet = compareSuppressions({ head: headJson(`${step.pkg}/${SUPPRESSIONS}`), current: readJson(suppressionsPath) ?? {}, suppressed: parsed.suppressed, linted: step.files, fatal: parsed.fatal, changed: changedHere })
				for (const line of ratchet.increased) result.failures.push({ key: `suppression-increase:${line.split(":")[0]}`, text: `suppression count increased vs HEAD: ${line}` })
				for (const line of ratchet.lowerable) result.notes.push(`can lower by hand (do not prune): ${line}`)
				for (const line of ratchet.removedElsewhere) result.notes.push(`reduced vs HEAD outside this change, check for over-pruning: ${line}`)
			}
			if (parsed.fatal.length) result.notes.push(`parse errors in ${parsed.fatal.join(", ")}: never prune suppressions while a file fails to parse`)
		}
	} else if (step.check === "tests" && command.includes("related")) {
		const json = readJson(report)
		if (!json) result.failures = [{ key: `tests:${step.pkg}:crash`, text: tail(outcome.output, 5).join(" | ") }]
		else {
			const parsed = parseVitest(json, cwd)
			result.failures = parsed.failures
			result.notes.push(`${parsed.files} test file(s), ${parsed.tests} test(s)`)
		}
	}
	if (outcome.code !== 0 && !result.failures.length) {
		result.failures = [{ key: `${step.check}:${step.pkg}:exit`, text: `exit ${outcome.code}: ${tail(outcome.output, 8).join(" | ")}` }]
	}
	result.status = result.failures.length ? "fail" : "pass"
	return result
}

function baselinePath() {
	return join(ROOT, "node_modules/.cache/zoo-verify/baseline.json")
}

export function classify(results, baseline) {
	const known = new Set(baseline?.failures ?? [])
	const ranChecks = new Set(results.map((r) => `${r.check}:${r.pkg}`))
	const current = new Set()
	for (const result of results) {
		for (const failure of result.failures) {
			const key = `${result.check}:${result.pkg}:${failure.key}`
			current.add(key)
			failure.baseline = known.has(key)
		}
	}
	const fixed = [...known].filter((key) => ranChecks.has(key.split(":").slice(0, 2).join(":")) && !current.has(key))
	return { current: [...current], fixed }
}

/** Collapse many failures to one line per file: count, new/known split, and the first message. */
export function groupFailures(failures) {
	const groups = new Map()
	for (const failure of failures) {
		const file = failure.file ?? "(other)"
		const group = groups.get(file) ?? { count: 0, known: 0, first: failure.message ?? failure.text }
		group.count++
		if (failure.baseline) group.known++
		groups.set(file, group)
	}
	return [...groups].map(([file, g]) => `${file}: ${g.count} failure(s)${g.known ? `, ${g.known} known` : ""}; first: ${g.first}`)
}

function printText(summary, maxLines) {
	const lines = []
	lines.push(`zoo-verify | scope: ${summary.files.length} file(s), ${summary.scope} | HEAD ${summary.head} | baseline: ${summary.baseline}`)
	if (summary.scope === "uncommitted diff") lines.push("WARN  no files given: checking every uncommitted change; failures may come from unrelated work")
	for (const result of summary.results) {
		const label = result.status.toUpperCase().padEnd(5)
		const counts = result.failures.length ? ` ${result.failures.filter((f) => !f.baseline).length} new, ${result.failures.filter((f) => f.baseline).length} known` : ""
		lines.push(`${label} ${result.check.padEnd(7)} ${result.pkg}${result.reason && result.reason !== "changed" ? ` (${result.reason})` : ""} ${result.seconds}s${counts}`)
		lines.push(`      $ ${result.command}`)
		const ordered = [...result.failures.filter((f) => !f.baseline), ...result.failures.filter((f) => f.baseline)]
		const detail = ordered.length > maxLines ? groupFailures(ordered) : ordered.map((f) => `${f.baseline ? "[known] " : ""}${f.text}`)
		for (const line of detail.slice(0, maxLines)) lines.push(`      ${line}`)
		if (detail.length > maxLines) lines.push(`      ... ${detail.length - maxLines} more line(s) (raise --max-lines or use --json)`)
		for (const note of result.notes.slice(0, maxLines)) lines.push(`      ${note.startsWith("WARN ") ? note : `note: ${note}`}`)
		if (result.notes.length > maxLines) lines.push(`      ... ${result.notes.length - maxLines} more note(s) (raise --max-lines or use --json)`)
	}
	for (const note of summary.notes) lines.push(`NOTE  ${note}`)
	for (const item of summary.untested) lines.push(`UNTESTED ${item}`)
	if (summary.fixed.length) lines.push(`FIXED ${summary.fixed.length} baseline failure(s) no longer occur`)
	lines.push(`RESULT ${summary.status.toUpperCase()} | new ${summary.newFailures} | known ${summary.knownFailures} | fixed ${summary.fixed.length} | warnings ${summary.warnings} | static checks and tests only; not a review, manual test, or runtime proof`)
	console.log(lines.join("\n"))
}

async function main() {
	let options
	try { options = parseArgs(process.argv.slice(2)) } catch (error) {
		console.error(`${error.message}\n\n${USAGE}`)
		return 2
	}
	if (options.help) { console.log(USAGE); return 0 }

	let files
	let scope = "explicit files"
	try {
		files = options.files.length ? normalizeFiles(options.files) : changedFiles()
	} catch (error) {
		console.error(error.message)
		return 2
	}
	if (!options.files.length) scope = "uncommitted diff"
	if (!files.length && !options.full) { console.log("zoo-verify: no changed files; nothing to check"); return 0 }

	const plan = buildPlan(files, { packages: workspacePackages(), only: options.only, full: options.full })
	const head = git(["rev-parse", "--short", "HEAD"]).trim()
	if (options.dryRun) {
		const printable = plan.steps.map((s) => `${s.check.padEnd(5)} ${s.pkg}${s.reason && s.reason !== "changed" ? ` (${s.reason})` : ""}: ${[...s.command, ...(s.files ?? [])].join(" ")}`)
		console.log([`zoo-verify plan | ${files.length} file(s), ${scope} | HEAD ${head}`, ...printable, ...plan.notes.map((n) => `NOTE  ${n}`), ...plan.untested.map((u) => `UNTESTED ${u}`)].join("\n"))
		return 0
	}

	const controller = new AbortController()
	const onSignal = () => controller.abort()
	process.once("SIGINT", onSignal)
	process.once("SIGTERM", onSignal)
	const results = []
	const notRun = []
	for (const step of plan.steps) {
		if (controller.signal.aborted) { notRun.push(`${step.check} ${step.pkg}`); continue }
		results.push(step.check === "escapes" ? scanStep(step) : await execute(step, { files, timeoutSec: options.timeoutSec, signal: controller.signal }))
	}

	const baselineData = options.useBaseline ? readJson(baselinePath()) : undefined
	const { current, fixed } = classify(results, baselineData)
	const all = results.flatMap((r) => r.failures)
	const interrupted = controller.signal.aborted || results.some((r) => r.status === "interrupted")
	const summary = {
		files,
		scope,
		head,
		baseline: baselineData ? `${baselineData.head} (${baselineData.savedAt})` : "none",
		results,
		notes: plan.notes,
		untested: [...plan.untested, ...notRun.map((s) => `${s} (interrupted before running)`)],
		fixed,
		newFailures: all.filter((f) => !f.baseline).length,
		knownFailures: all.filter((f) => f.baseline).length,
		warnings: results.reduce((sum, r) => sum + (r.warnings ?? 0), 0),
		status: interrupted ? "interrupted" : all.length ? "fail" : "pass",
	}
	if (options.saveBaseline && !interrupted) {
		mkdirSync(dirname(baselinePath()), { recursive: true })
		writeFileSync(baselinePath(), JSON.stringify({ head, savedAt: new Date().toISOString(), files, failures: current }, null, "\t"))
		summary.notes.push(`baseline saved with ${current.length} failure(s) at ${toPosix(relative(ROOT, baselinePath()))}`)
	}
	if (options.json) console.log(JSON.stringify(summary, null, 2))
	else printText(summary, options.maxLines)
	return interrupted ? 130 : all.length ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = await main()
}
