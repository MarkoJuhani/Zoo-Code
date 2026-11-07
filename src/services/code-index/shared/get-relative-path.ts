import fs from "fs"
import path from "path"

/**
 * Resolves the canonical root that identifies a workspace's index.
 * The same folder opened through different symlinks resolves to one root, so it
 * shares one collection, cache file and set of point IDs.
 *
 * @param workspacePath - The workspace path as opened (may contain symlinks)
 * @returns The real path, or the given path when it cannot be resolved
 */
export function resolveIndexRoot(workspacePath: string): string {
	let realPath: string
	try {
		realPath = fs.realpathSync.native(workspacePath)
	} catch {
		// Missing, remote or virtual paths keep their given identity
		return workspacePath
	}
	// Case-insensitive file systems return the on-disk case (Windows also upper-cases the
	// drive letter). Keep the given spelling so existing indexes keep their identity.
	const caseInsensitive = process.platform === "win32" || process.platform === "darwin"
	if (caseInsensitive && realPath.toLowerCase() === workspacePath.toLowerCase()) {
		return workspacePath
	}
	return realPath
}

/**
 * Maps a path under the opened workspace root to the same file under the index root.
 * Paths outside the opened root are returned unchanged.
 *
 * @param filePath - Absolute path under displayRoot
 * @param displayRoot - The workspace root as opened
 * @param indexRoot - The canonical root from {@link resolveIndexRoot}
 * @returns The path under indexRoot
 */
export function toIndexPath(filePath: string, displayRoot: string, indexRoot: string): string {
	if (displayRoot === indexRoot) {
		return filePath
	}
	const relativePath = path.relative(displayRoot, filePath)
	if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
		return filePath
	}
	return path.join(indexRoot, relativePath)
}

/**
 * Generates a normalized absolute path from a given file path and workspace root.
 * Handles path resolution and normalization to ensure consistent absolute paths.
 *
 * @param filePath - The file path to normalize (can be relative or absolute)
 * @param workspaceRoot - The root directory of the workspace (required)
 * @returns The normalized absolute path
 */
export function generateNormalizedAbsolutePath(filePath: string, workspaceRoot: string): string {
	// Resolve the path to make it absolute if it's relative
	const resolvedPath = path.resolve(workspaceRoot, filePath)
	// Normalize to handle any . or .. segments and duplicate slashes
	return path.normalize(resolvedPath)
}

/**
 * Generates a relative file path from a normalized absolute path and workspace root.
 * Ensures consistent relative path generation across different platforms.
 *
 * @param normalizedAbsolutePath - The normalized absolute path to convert
 * @param workspaceRoot - The root directory of the workspace (required)
 * @returns The relative path from workspaceRoot to the file
 */
export function generateRelativeFilePath(normalizedAbsolutePath: string, workspaceRoot: string): string {
	// Generate the relative path
	const relativePath = path.relative(workspaceRoot, normalizedAbsolutePath)
	// Normalize to ensure consistent path separators
	return path.normalize(relativePath)
}
