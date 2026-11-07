import fs from "fs"
import os from "os"
import path from "path"

import {
	generateNormalizedAbsolutePath,
	generateRelativeFilePath,
	resolveIndexRoot,
	toIndexPath,
} from "../get-relative-path"

describe("get-relative-path", () => {
	describe("generateNormalizedAbsolutePath", () => {
		it("should use provided workspace root", () => {
			const filePath = "src/file.ts"
			const workspaceRoot = path.join(path.sep, "custom", "workspace")
			const result = generateNormalizedAbsolutePath(filePath, workspaceRoot)
			// On Windows, path.resolve adds the drive letter, so we need to use path.resolve for the expected value
			expect(result).toBe(path.resolve(workspaceRoot, filePath))
		})

		it("should handle absolute paths", () => {
			const filePath = path.join(path.sep, "absolute", "path", "file.ts")
			const workspaceRoot = path.join(path.sep, "custom", "workspace")
			const result = generateNormalizedAbsolutePath(filePath, workspaceRoot)
			// When an absolute path is provided, it should be resolved to include drive letter on Windows
			expect(result).toBe(path.resolve(filePath))
		})

		it("should normalize paths with . and .. segments", () => {
			const filePath = "./src/../src/file.ts"
			const workspaceRoot = path.join(path.sep, "custom", "workspace")
			const result = generateNormalizedAbsolutePath(filePath, workspaceRoot)
			// Use path.resolve to get the expected normalized absolute path
			expect(result).toBe(path.resolve(workspaceRoot, "src", "file.ts"))
		})
	})

	describe("generateRelativeFilePath", () => {
		it("should use provided workspace root", () => {
			const workspaceRoot = path.join(path.sep, "custom", "workspace")
			const absolutePath = path.join(workspaceRoot, "src", "file.ts")
			const result = generateRelativeFilePath(absolutePath, workspaceRoot)
			expect(result).toBe(path.join("src", "file.ts"))
		})

		it("should handle paths outside workspace", () => {
			const absolutePath = path.join(path.sep, "outside", "workspace", "file.ts")
			const workspaceRoot = path.join(path.sep, "custom", "workspace")
			const result = generateRelativeFilePath(absolutePath, workspaceRoot)
			// The result will have .. segments to navigate outside
			expect(result).toContain("..")
		})

		it("should handle same path as workspace", () => {
			const workspaceRoot = path.join(path.sep, "custom", "workspace")
			const absolutePath = workspaceRoot
			const result = generateRelativeFilePath(absolutePath, workspaceRoot)
			expect(result).toBe(".")
		})

		it("should handle multi-workspace scenarios", () => {
			// Simulate the error scenario from the issue
			const workspaceRoot = path.join(path.sep, "Users", "test", "project")
			const absolutePath = path.join(path.sep, "Users", "test", "admin", ".prettierrc.json")
			const result = generateRelativeFilePath(absolutePath, workspaceRoot)
			// Should generate a valid relative path, not throw an error
			expect(result).toBe(path.join("..", "admin", ".prettierrc.json"))
		})
	})

	describe("index root", () => {
		let tempRoot: string
		let realRoot: string
		let linkRoot: string

		beforeEach(() => {
			// The temp dir itself may sit behind a symlink (macOS /var), so compare real paths
			tempRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "index-root-")))
			realRoot = path.join(tempRoot, "real")
			linkRoot = path.join(tempRoot, "link")
			fs.mkdirSync(realRoot)
			fs.symlinkSync(realRoot, linkRoot, "junction")
		})

		afterEach(() => {
			fs.rmSync(tempRoot, { recursive: true, force: true })
		})

		it("resolves a symlinked workspace and its real path to the same root", () => {
			expect(resolveIndexRoot(linkRoot)).toBe(realRoot)
			expect(resolveIndexRoot(realRoot)).toBe(realRoot)
		})

		it.each<NodeJS.Platform>(["win32", "darwin"])(
			"keeps the given spelling for a case-only difference on %s",
			(platform) => {
				const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue(platform)
				const realpathSpy = vi.spyOn(fs.realpathSync, "native").mockReturnValue("C:\\Projects\\App")
				try {
					expect(resolveIndexRoot("c:\\projects\\app")).toBe("c:\\projects\\app")
				} finally {
					platformSpy.mockRestore()
					realpathSpy.mockRestore()
				}
			},
		)

		it("treats a case-only difference as a different path on Linux", () => {
			const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux")
			const realpathSpy = vi.spyOn(fs.realpathSync, "native").mockReturnValue("/Projects/App")
			try {
				expect(resolveIndexRoot("/projects/app")).toBe("/Projects/App")
			} finally {
				platformSpy.mockRestore()
				realpathSpy.mockRestore()
			}
		})

		it("keeps a path that cannot be resolved", () => {
			const missing = path.join(tempRoot, "missing")
			expect(resolveIndexRoot(missing)).toBe(missing)
		})

		it("maps files under the opened root to the index root", () => {
			const filePath = path.join(linkRoot, "src", "file.ts")
			expect(toIndexPath(filePath, linkRoot, realRoot)).toBe(path.join(realRoot, "src", "file.ts"))
		})

		it("leaves paths unchanged when the roots match or the file is outside the opened root", () => {
			const inside = path.join(realRoot, "file.ts")
			const outside = path.join(tempRoot, "other", "file.ts")
			expect(toIndexPath(inside, realRoot, realRoot)).toBe(inside)
			expect(toIndexPath(outside, linkRoot, realRoot)).toBe(outside)
		})
	})
})
