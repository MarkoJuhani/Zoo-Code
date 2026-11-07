// npx vitest run core/config/__tests__/CustomModesManager.rendererRoundTrip.spec.ts
//
// Regression for the ~60 s `prep=state` delay seen in Task.attemptApiRequest. ClineProvider.getState()
// awaits getCustomModes(), which awaits `globalState.update()` on every cache miss. In a remote
// extension host that promise settles only after the workbench renderer answers the storage RPC; a
// background-throttled renderer answers on its next one-minute wake-up. A read must not wait for
// that write, and a slow refresh must not leave the cache already expired.

import type { Mock } from "vitest"

import * as path from "path"
import * as fs from "fs/promises"

import * as yaml from "yaml"
import * as vscode from "vscode"

import { fileExistsAtPath } from "../../../utils/fs"
import { getWorkspacePath } from "../../../utils/path"
import { GlobalFileNames } from "../../../shared/globalFileNames"
import { clearAllMocks } from "../../../test-utils/reset"
import { makeExtensionContext, makeUri } from "../../../test-utils/vscode"

import { CustomModesManager } from "../CustomModesManager"

vi.mock("vscode", () => ({
	workspace: {
		workspaceFolders: [],
		onDidSaveTextDocument: vi.fn(),
		createFileSystemWatcher: vi.fn(),
	},
	window: {
		showErrorMessage: vi.fn(),
	},
}))

vi.mock("fs/promises", () => ({
	mkdir: vi.fn(),
	readFile: vi.fn(),
	writeFile: vi.fn(),
	stat: vi.fn(),
	readdir: vi.fn(),
	rm: vi.fn(),
}))

vi.mock("../../../utils/fs")
vi.mock("../../../utils/path")

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((r) => {
		resolve = r
	})
	return { promise, resolve }
}

const flushMacrotask = () => new Promise<void>((resolve) => setImmediate(resolve))

describe("CustomModesManager.getCustomModes renderer round trip", () => {
	const mockStoragePath = `${path.sep}mock${path.sep}settings`
	const mockSettingsPath = path.join(mockStoragePath, "settings", GlobalFileNames.customModes)
	const mockWorkspacePath = path.resolve("/mock/workspace")

	let mockContext: vscode.ExtensionContext
	let manager: CustomModesManager
	let pendingUpdate: ReturnType<typeof deferred<void>>

	beforeEach(() => {
		mockContext = makeExtensionContext({ globalStorageUri: makeUri(mockStoragePath) })
		pendingUpdate = deferred<void>()
		// Models the extension-host memento: the promise settles only when the renderer replies.
		mockContext.globalState.update = vi.fn(() => pendingUpdate.promise)
		;(vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = []
		;(getWorkspacePath as Mock).mockReturnValue(mockWorkspacePath)
		;(fileExistsAtPath as Mock).mockImplementation(async (p: string) => p === mockSettingsPath)
		;(fs.mkdir as Mock).mockResolvedValue(undefined)
		;(fs.readFile as Mock).mockImplementation(async (p: string) => {
			if (p === mockSettingsPath) return yaml.stringify({ customModes: [] })
			throw new Error("File not found")
		})
		manager = new CustomModesManager(mockContext, vi.fn())
	})

	afterEach(() => {
		vi.restoreAllMocks()
		clearAllMocks()
	})

	it("returns the modes without waiting for the globalState write to be acknowledged", async () => {
		let settled = false
		const read = manager.getCustomModes().then((modes) => {
			settled = true
			return modes
		})

		await vi.waitFor(() => expect(mockContext.globalState.update).toHaveBeenCalled())
		await flushMacrotask()

		// The renderer has not answered the storage RPC yet; a read must still complete.
		expect(settled).toBe(true)

		pendingUpdate.resolve()
		await read
	})

	it("keeps a refresh cached for the TTL measured from when it completed, not when it started", async () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000)
		// The refresh itself is slow: the settings file read completes 60 s after it started.
		// (The globalState mirror is no longer awaited, so it cannot be the slow step.)
		const slowRead = deferred<void>()
		const readFile = fs.readFile as Mock
		const readSettings = readFile.getMockImplementation()
		readFile.mockImplementationOnce(async (p: string) => {
			await slowRead.promise
			return readSettings?.(p)
		})
		const first = manager.getCustomModes()
		await vi.waitFor(() => expect(readFile).toHaveBeenCalled())

		now.mockReturnValue(1_060_000)
		slowRead.resolve()
		pendingUpdate.resolve()
		await first
		const readsAfterFirst = (fs.readFile as Mock).mock.calls.length

		// The next request starts immediately afterwards and should be served from the cache.
		now.mockReturnValue(1_060_001)
		await manager.getCustomModes()

		expect((fs.readFile as Mock).mock.calls.length).toBe(readsAfterFirst)
		expect(mockContext.globalState.update).toHaveBeenCalledTimes(1)
	})

	it("does not cache or mirror modes read before a watcher cleared the cache", async () => {
		const slowRead = deferred<void>()
		const readFile = fs.readFile as Mock
		const readSettings = readFile.getMockImplementation()
		readFile.mockImplementationOnce(async (p: string) => {
			await slowRead.promise
			return readSettings?.(p)
		})
		const stale = manager.getCustomModes()
		await vi.waitFor(() => expect(readFile).toHaveBeenCalled())

		// A file watcher saw a change and cleared the cache while the old file was being read.
		manager["clearCache"]()
		slowRead.resolve()
		await stale
		pendingUpdate.resolve()

		expect(mockContext.globalState.update).not.toHaveBeenCalled()
		const readsBefore = readFile.mock.calls.length
		await manager.getCustomModes()
		expect(readFile.mock.calls.length).toBeGreaterThan(readsBefore)
	})
})
