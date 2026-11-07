import * as vscode from "vscode"
import { CodeIndexManager } from "./manager"
import { resolveIndexRoot } from "./shared/get-relative-path"

/** Resolves workspaces and owns their cached CodeIndexManager instances. */
export class CodeIndexManagerRegistry {
	private static instances = new Map<string, CodeIndexManager>()

	public static getOrCreate(context: vscode.ExtensionContext, workspacePath?: string): CodeIndexManager | undefined {
		const folder = this.resolveWorkspaceFolder(workspacePath)
		const resolvedPath = workspacePath || folder?.uri.fsPath
		if (!resolvedPath) {
			return undefined
		}

		// One manager per real folder, so symlinked paths never index it twice
		const instanceKey = resolveIndexRoot(resolvedPath)
		const existing = this.instances.get(instanceKey)
		if (existing) {
			return existing
		}

		// Preserve real workspace URIs, including remote schemes and authorities.
		const folderUri = folder?.uri ?? vscode.Uri.file(resolvedPath)
		const manager = new CodeIndexManager(resolvedPath, folderUri, context)
		this.instances.set(instanceKey, manager)
		return manager
	}

	public static getAllInstances(): CodeIndexManager[] {
		return Array.from(this.instances.values())
	}

	public static disposeAll(): void {
		for (const instance of this.instances.values()) {
			instance.dispose()
		}
		this.instances.clear()
	}

	private static resolveWorkspaceFolder(workspacePath?: string): vscode.WorkspaceFolder | undefined {
		if (workspacePath) {
			return vscode.workspace.workspaceFolders?.find((folder) => folder.uri.fsPath === workspacePath)
		}

		const activeEditor = vscode.window.activeTextEditor
		if (activeEditor) {
			const folder = vscode.workspace.getWorkspaceFolder(activeEditor.document.uri)
			if (folder) {
				return folder
			}
		}

		return vscode.workspace.workspaceFolders?.[0]
	}
}
