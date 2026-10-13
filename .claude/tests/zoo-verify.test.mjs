import assert from "node:assert/strict"
import test from "node:test"
import {
	buildPlan,
	classify,
	compareSuppressions,
	dependentsOf,
	groupFailures,
	isTestFile,
	normalizeFiles,
	parseAddedLines,
	parseArgs,
	parseEslint,
	parseTsc,
	parseVitest,
	scanEscapes,
	typeCommand,
} from "../skills/zoo-verify/scripts/verify.mjs"

// Pure planning/parsing logic only; live tsc/eslint/vitest runs are manual evidence.
const packages = [
	{ dir: "packages/types", name: "@roo-code/types", scripts: { "check-types": "tsc --noEmit", lint: "eslint src", test: "vitest run" }, workspaceDeps: [] },
	{ dir: "packages/core", name: "@roo-code/core", scripts: { "check-types": "tsc --noEmit", test: "vitest run" }, workspaceDeps: ["@roo-code/types"] },
	{ dir: "src", name: "zoo-code", scripts: { "check-types": "tsc --noEmit", lint: "eslint .", test: "vitest run" }, workspaceDeps: ["@roo-code/core", "@roo-code/types"] },
	{ dir: "packages/config-eslint", name: "@roo-code/config-eslint", scripts: { test: "node --test x.js" }, workspaceDeps: [] },
]
const exists = () => true

test("parses options and rejects unknown input", () => {
	const options = parseArgs(["--only=lint,tests", "--max-lines=5", "a.ts"])
	assert.deepEqual([...options.only], ["lint", "tests"])
	assert.equal(options.maxLines, 5)
	assert.deepEqual(options.files, ["a.ts"])
	assert.throws(() => parseArgs(["--only=fix"]), /Unknown check/)
	assert.throws(() => parseArgs(["--prune"]), /Unknown option/)
	assert.throws(() => parseArgs(["--timeout=0"]), /positive integer/)
})

test("normalizes paths and refuses paths outside the repository", () => {
	assert.deepEqual(normalizeFiles(["src/a.ts", "./src/a.ts"], { root: "/repo", cwd: "/repo" }), ["src/a.ts"])
	assert.deepEqual(normalizeFiles(["a.ts"], { root: "/repo", cwd: "/repo/src" }), ["src/a.ts"])
	assert.throws(() => normalizeFiles(["../other/a.ts"], { root: "/repo", cwd: "/repo" }), /outside the repository/)
})

test("type checks transitive dependents but lints and tests only the owning package", () => {
	assert.deepEqual(dependentsOf("@roo-code/types", packages).map((p) => p.dir).sort(), ["packages/core", "src"])
	const { steps } = buildPlan(["packages/types/src/mode.ts"], { packages, exists })
	assert.deepEqual(steps.filter((s) => s.check === "types").map((s) => s.pkg).sort(), ["packages/core", "packages/types", "src"])
	assert.deepEqual(steps.filter((s) => s.check === "lint").map((s) => [s.pkg, s.files]), [["packages/types", ["src/mode.ts"]]])
	assert.ok(steps.some((s) => s.check === "model"), "types/src/mode.ts feeds the lifecycle model checks")
})

test("never plans fix or prune flags", () => {
	const { steps } = buildPlan(["src/core/task/Task.ts"], { packages, exists, full: true })
	const commands = steps.map((s) => s.command.join(" ")).join("\n")
	assert.doesNotMatch(commands, /--fix|--prune-suppressions|--suppress-/)
	assert.match(commands, /--pass-on-unpruned-suppressions/)
})

test("respects --only, skips deleted files, and flags settings and outside files", () => {
	const plan = buildPlan(["src/gone.ts", "packages/types/src/global-settings.ts", "docs/x.md"], { packages, only: new Set(["lint"]), exists: (f) => f !== "src/gone.ts" })
	assert.deepEqual(plan.steps.map((s) => `${s.check}:${s.pkg}`), ["lint:packages/types"])
	assert.match(plan.notes.join("\n"), /deleted file/)
	assert.match(plan.notes.join("\n"), /Persisted Setting Checklist/)
	assert.match(plan.notes.join("\n"), /outside workspace packages: docs\/x\.md/)
})

test("non-vitest test scripts run as-is", () => {
	const { steps } = buildPlan(["packages/config-eslint/index.js"], { packages, exists })
	assert.deepEqual(steps.find((s) => s.check === "tests").command, ["pnpm", "run", "test"])
})

test("adds incremental compact flags only to a plain tsc script", () => {
	assert.deepEqual(typeCommand("tsc --noEmit").slice(0, 5), ["pnpm", "exec", "tsc", "--noEmit", "--pretty"])
	assert.ok(typeCommand("tsc -p tsconfig.esm.json --noEmit").includes("--incremental"))
	assert.deepEqual(typeCommand("tsc && node x"), ["pnpm", "run", "check-types"])
})

test("parses tsc errors with line-independent keys", () => {
	const [failure] = parseTsc("core/a.ts(12,5): error TS2322: Type 'x' is not assignable.\nnoise")
	assert.equal(failure.key, "core/a.ts:TS2322:Type 'x' is not assignable.")
	assert.equal(failure.file, "core/a.ts")
})

test("parses ESLint results and counts only bulk-suppressed messages", () => {
	const parsed = parseEslint([
		{
			filePath: "/pkg/core/a.ts",
			messages: [{ ruleId: "no-x", message: "bad", line: 3, column: 1 }],
			suppressedMessages: [
				{ ruleId: "@typescript-eslint/no-explicit-any", suppressions: [{ kind: "file" }] },
				{ ruleId: "@typescript-eslint/no-explicit-any", suppressions: [{ kind: "directive" }] },
			],
		},
		{ filePath: "/pkg/core/b.ts", messages: [{ fatal: true, message: "Parsing error", line: 1 }], suppressedMessages: [] },
	], "/pkg")
	assert.equal(parsed.failures.length, 2)
	assert.deepEqual(parsed.suppressed, { "core/a.ts": { "@typescript-eslint/no-explicit-any": 1 } })
	assert.deepEqual(parsed.fatal, ["core/b.ts"])
})

test("suppression ratchet reports increases, lowerable budgets, and reductions elsewhere without pruning", () => {
	const any = "@typescript-eslint/no-explicit-any"
	const head = { "a.ts": { [any]: { count: 3 } }, "b.ts": { [any]: { count: 4 } }, "c.ts": { [any]: { count: 2 } } }
	const current = { "a.ts": { [any]: { count: 3 } }, "b.ts": { [any]: { count: 5 } } }
	const result = compareSuppressions({ head, current, suppressed: { "a.ts": { [any]: 1 } }, linted: ["a.ts", "b.ts"], fatal: ["b.ts"], changed: ["a.ts", "b.ts"] })
	assert.deepEqual(result.increased, [`b.ts ${any}: 4 -> 5`])
	assert.deepEqual(result.lowerable, [`a.ts ${any}: 3 -> 1`], "fatal b.ts must not be offered for lowering")
	assert.deepEqual(result.removedElsewhere, [`c.ts ${any}: 2 -> 0`])
})

test("parses Vitest JSON including suite-level failures", () => {
	const parsed = parseVitest({
		numTotalTests: 2,
		testResults: [
			{ name: "/pkg/a.spec.ts", status: "failed", assertionResults: [{ status: "failed", fullName: "a works", failureMessages: ["Error: boom\n at x"] }, { status: "passed" }] },
			{ name: "/pkg/b.spec.ts", status: "failed", message: "Cannot find module", assertionResults: [] },
		],
	}, "/pkg")
	assert.deepEqual(parsed.failures.map((f) => f.key), ["a.spec.ts>a works", "b.spec.ts>(suite)"])
	assert.equal(parsed.failures[0].message, "Error: boom")
})

test("classifies baseline failures as known and reports fixed ones only for checks that ran", () => {
	const results = [{ check: "tests", pkg: "src", failures: [{ key: "a>x" }, { key: "a>new" }] }]
	const baseline = { failures: ["tests:src:a>x", "tests:src:a>gone", "lint:src:z"] }
	const { fixed } = classify(results, baseline)
	assert.equal(results[0].failures[0].baseline, true)
	assert.equal(results[0].failures[1].baseline, false)
	assert.deepEqual(fixed, ["tests:src:a>gone"])
})

test("groups many failures per file", () => {
	const lines = groupFailures([
		{ file: "a.ts", message: "Error: one", baseline: true },
		{ file: "a.ts", message: "Error: two" },
		{ file: "b.ts", message: "Error: three" },
	])
	assert.deepEqual(lines, ["a.ts: 2 failure(s), 1 known; first: Error: one", "b.ts: 1 failure(s); first: Error: three"])
})

test("reads added line numbers from a zero-context diff", () => {
	const diff = "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -3,0 +4,2 @@\n+one\n+two\n@@ -10 +12 @@\n-old\n+new\n\\ No newline at end of file"
	assert.deepEqual(parseAddedLines(diff), [{ line: 4, text: "one" }, { line: 5, text: "two" }, { line: 12, text: "new" }])
})

test("classifies test and production paths", () => {
	assert.equal(isTestFile("src/core/task/__tests__/a.spec.ts"), true)
	assert.equal(isTestFile("src/test-utils/vscode.ts"), true)
	assert.equal(isTestFile("webview-ui/src/x.test.tsx"), true)
	assert.equal(isTestFile("src/core/task/Task.ts"), false)
})

test("type escapes fail in production and warn in tests", () => {
	const added = [
		{ line: 1, text: "// @ts-ignore" },
		{ line: 2, text: "/* @ts-nocheck */" },
		{ line: 3, text: "// eslint-disable-next-line @typescript-eslint/no-explicit-any" },
		{ line: 4, text: "// eslint-disable-next-line no-console -- CLI output" },
		{ line: 5, text: "// @ts-expect-error" },
		{ line: 6, text: "// @ts-expect-error: upstream type is wrong" },
	]
	const prod = scanEscapes(added, [], false)
	assert.deepEqual(prod.map((f) => [f.line, f.kind, f.severity]), [
		[1, "ts-ignore", "fail"],
		[2, "ts-nocheck", "fail"],
		[3, "eslint-disable-without-reason", "fail"],
		[5, "ts-expect-error-without-description", "warn"],
	])
	assert.ok(scanEscapes(added, [], true).every((f) => f.severity === "warn"))
})

test("double assertions need a comment on the line or the line above", () => {
	const fileLines = ["// vscode.Uri has no public constructor", "const a = x as unknown as Uri", "const b = y as unknown as Foo", "const c = z as unknown as Bar // structural mock"]
	const added = fileLines.map((text, i) => ({ line: i + 1, text })).slice(1)
	assert.deepEqual(scanEscapes(added, fileLines, false).map((f) => [f.line, f.kind]), [[3, "double-assertion-without-comment"]])
})

test("ignores directives that are not in comments", () => {
	assert.deepEqual(scanEscapes([{ line: 1, text: 'const s = "@ts-ignore is banned"' }], [], false), [])
})
