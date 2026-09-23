import { describe, expect, it, vi } from "vitest"
import { IpcMessageType, QueueEventName, RooCodeEventName } from "@roo-code/types"

vi.mock("vscode", () => ({
	window: { createTextEditorDecorationType: vi.fn(), showErrorMessage: vi.fn() },
	workspace: { workspaceFolders: [], getConfiguration: vi.fn(() => ({ get: vi.fn() })) },
	env: { machineId: "phase0", uriScheme: "vscode", appName: "VSCode", language: "en", sessionId: "phase0" },
	Uri: { file: (fsPath: string) => ({ fsPath }) },
	commands: { executeCommand: vi.fn() },
	ExtensionMode: { Development: 2 },
	version: "phase0",
}))

vi.mock("@roo-code/ipc", () => {
	class IpcServer {
		public broadcast = vi.fn()
		public listen = vi.fn()
		public on = vi.fn()
	}
	return { IpcServer }
})

vi.mock("../core/task-persistence", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../core/task-persistence")>()
	return {
		...actual,
		readApiMessages: async () => [],
		saveApiMessages: async ({ messages }: { messages: unknown[] }) => messages,
		saveTaskMessages: async ({ messages }: { messages: unknown[] }) => messages,
	}
})

vi.mock("../core/task-persistence/taskMessages", () => ({ readTaskMessages: async () => [] }))

import { API } from "../extension/api"
import {
	ComposedProvider,
	makeLifecycleTask,
	providerMethods,
	sourceDerivedPreFilterAbortProjection,
} from "./helpers/queue-lifecycle-phase0"

const flush = async () => new Promise((resolve) => setImmediate(resolve))

describe("Phase 0 composed queue lifecycle", () => {
	it("current partial fix: real internal disposal emits abort but bridge retains root ownership; lineage commits before scheduler activation", async () => {
		const provider = new ComposedProvider()
		Object.assign(provider, providerMethods)
		const root = makeLifecycleTask("root", undefined)
		provider.taskRegistry.push(root as never)
		provider.history.set("root", { id: "root", status: "active" })
		const api = new API({ appendLine: vi.fn() } as never, provider as never, "/tmp/queue-lifecycle-phase0.sock")
		const dispatches = (api as unknown as { queueDispatches: Map<string, unknown> }).queueDispatches
		dispatches.set("root", {
			queueId: "q",
			generation: 1,
			requestId: "r",
			rootTaskId: "root",
			mode: "code",
			sequence: 0,
			ownershipReleased: false,
			accepted: false,
			promptReady: false,
		})
		const ipc = (api as unknown as { ipc: { broadcast: ReturnType<typeof vi.fn> } }).ipc

		const child = await providerMethods.delegateParentAndOpenChild.call(provider as never, {
			parentTaskId: "root",
			message: "child",
			initialTodos: [],
			mode: "code",
		})
		await flush()

		expect(root.abort).toBe(true)
		expect(provider.history.get("root")).toMatchObject({ status: "delegated", awaitingChildId: child.taskId })
		expect(provider.scheduled).toEqual([child.taskId])
		expect(ipc.broadcast).not.toHaveBeenCalledWith(
			expect.objectContaining({
				type: IpcMessageType.QueueEvent,
				data: expect.objectContaining({ eventName: QueueEventName.Terminal }),
			}),
		)
	})

	it("original defect red proof: source-derived pre-filter projection terminalizes the same real abort emission", async () => {
		const root = makeLifecycleTask("root", undefined)
		root.abortReason = "delegation_disposal"
		const dispatches = new Map([["root", { ownershipReleased: false }]])
		const terminal = vi.fn()
		sourceDerivedPreFilterAbortProjection(root, dispatches, terminal)

		await root.abortTask(true)

		expect(terminal).toHaveBeenCalledWith("root")
		expect(dispatches.get("root")).toMatchObject({ terminalState: "aborted", ownershipReleased: true })
	})

	it("nested return: production delegation and resumption preserve root → child → grandchild → child → root ordering", async () => {
		const provider = new ComposedProvider()
		Object.assign(provider, providerMethods)
		const root = makeLifecycleTask("root", undefined)
		provider.taskRegistry.push(root as never)
		provider.history.set("root", { id: "root", status: "active" })

		const child = await providerMethods.delegateParentAndOpenChild.call(provider as never, {
			parentTaskId: "root",
			message: "child",
			initialTodos: [],
			mode: "code",
		})
		const grandchild = await providerMethods.delegateParentAndOpenChild.call(provider as never, {
			parentTaskId: child.taskId,
			message: "grandchild",
			initialTodos: [],
			mode: "code",
		})
		await providerMethods.reopenParentFromDelegation.call(provider as never, {
			parentTaskId: child.taskId,
			childTaskId: grandchild.taskId,
			completionResultSummary: "grandchild done",
		})
		await providerMethods.reopenParentFromDelegation.call(provider as never, {
			parentTaskId: "root",
			childTaskId: child.taskId,
			completionResultSummary: "child done",
		})
		await flush()

		expect(provider.history.get(grandchild.taskId)).toMatchObject({ status: "completed" })
		expect(provider.history.get(child.taskId)).toMatchObject({ status: "completed" })
		expect(provider.history.get("root")).toMatchObject({ status: "active" })
		expect(provider.resumed).toEqual([child.taskId, "root"])
	})

	it("remaining lifecycle failure: abort notification precedes cleanup, so it is not stop proof", async () => {
		let releaseCleanup!: () => void
		const cleanup = new Promise<void>((resolve) => (releaseCleanup = resolve))
		const root = makeLifecycleTask("root", undefined)
		root._isHistoryTask = false
		root.clineMessages = ["persist"]
		root.dispose = async () => cleanup
		const events: string[] = []
		root.on(RooCodeEventName.TaskAborted, () => events.push("aborted"))
		const aborting = root.abortTask(true)
		await flush()

		expect(events).toEqual(["aborted"])
		let settled = false
		void aborting.then(() => (settled = true))
		expect(settled).toBe(false)
		releaseCleanup()
		await aborting
		expect(settled).toBe(true)
	})
})
