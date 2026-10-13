import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

import type { PendingTaskAction } from "@roo-code/types"

import { Task } from "../Task"
import { createOrdinaryTaskPersistenceAuthority } from "../../task-persistence/targetPersistenceBoundary"

type AskAnswer = Awaited<ReturnType<Task["ask"]>>
/** A restored-task user wait: presented under the start exclusion, answered after its release. */
type UserWait = { kind: "user_wait"; wait: () => Promise<AskAnswer>; resolve: (answer: AskAnswer) => Promise<unknown> }
type PendingActionAccess = {
	resumePendingTaskAction(action: PendingTaskAction): Promise<UserWait>
}

const isUserWait = (value: unknown): value is UserWait =>
	typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "user_wait"

/**
 * Present, wait and resolve in order, as resumeTaskFromHistory does around its exclusion scopes.
 * The scope and ownership re-check belong to resumeTaskFromHistory and are covered elsewhere.
 */
const getPendingActionAccess = (task: Task) => ({
	async resumePendingTaskAction(action: PendingTaskAction): Promise<void> {
		// Private member access on a prototype-built Task; no public seam exists.
		let next: unknown = await (task as unknown as PendingActionAccess).resumePendingTaskAction(action)
		while (isUserWait(next)) next = await next.resolve(await next.wait())
	},
})

/** Real disposable storage: clearing a resolved action runs under ordinary persistence and its fence. */
let globalStoragePath: string
beforeEach(async () => {
	globalStoragePath = await fs.mkdtemp(path.join(os.tmpdir(), "pending-action-replay-"))
})
afterEach(async () => {
	await fs.rm(globalStoragePath, { recursive: true, force: true })
})

function createTask(provider?: object) {
	const task = Object.create(Task.prototype) as Task
	// Each presentation reads the authoritative status baseline under its scope.
	if (provider && !("getTaskMetadata" in provider))
		Object.assign(provider, {
			getTaskMetadata: vi.fn().mockResolvedValue({ kind: "found", item: { id: "task-1", status: "active" } }),
		})
	Object.assign(task, {
		taskId: "task-1",
		globalStoragePath,
		persistenceAuthority: createOrdinaryTaskPersistenceAuthority({ id: "task-1" }),
		providerRef: { deref: () => provider },
		ask: vi.fn(),
		// A restored ask is presented by prepareAsk and answered by its returned wait; the `ask`
		// mock stands for that presented ask and supplies its answer.
		prepareAsk: vi.fn((...args: Parameters<Task["ask"]>) => Promise.resolve(() => task.ask(...args))),
		say: vi.fn().mockResolvedValue(undefined),
		initiateTaskLoop: vi.fn().mockResolvedValue(undefined),
		persistQueuedFeedbackAndAcknowledge: vi.fn().mockResolvedValue(true),
		pendingAction: finishAction,
	})
	return task
}

const createAction: PendingTaskAction = {
	kind: "create_subtask",
	actionId: "create-action",
	approvalText: JSON.stringify({ tool: "newTask" }),
	mode: "ask",
	message: "Child task",
	todos: [],
}

const finishAction: PendingTaskAction = {
	kind: "finish_subtask",
	actionId: "finish-action",
	approvalText: JSON.stringify({ tool: "finishTask" }),
	parentTaskId: "parent-1",
	result: "Done",
}

describe("Task pending action replay", () => {
	it("executes an approved create-subtask action", async () => {
		const provider = { delegateParentAndOpenChild: vi.fn().mockResolvedValue({ taskId: "child-1" }) }
		const task = createTask(provider)
		task.ask = vi.fn().mockResolvedValue({ response: "yesButtonClicked" })

		await getPendingActionAccess(task).resumePendingTaskAction(createAction)

		expect(provider.delegateParentAndOpenChild).toHaveBeenCalledWith({
			parentTaskId: "task-1",
			message: "Child task",
			initialTodos: [],
			mode: "ask",
			pendingActionId: "create-action",
		})
	})

	it("executes an approved finish-subtask action", async () => {
		const provider = { reopenParentFromDelegation: vi.fn().mockResolvedValue(true) }
		const task = createTask(provider)
		task.ask = vi.fn().mockResolvedValue({ response: "yesButtonClicked" })

		await getPendingActionAccess(task).resumePendingTaskAction(finishAction)

		expect(provider.reopenParentFromDelegation).toHaveBeenCalledWith({
			parentTaskId: "parent-1",
			childTaskId: "task-1",
			completionResultSummary: "Done",
			pendingActionId: "finish-action",
		})
	})

	it("falls back to a fresh completion ask when approved finish delegation is stale", async () => {
		const provider = {
			reopenParentFromDelegation: vi
				.fn()
				.mockResolvedValue({ kind: "detached", phase: "precommit", reason: "ownership_moved" }),
			clearPendingTaskAction: vi.fn().mockResolvedValue(true),
		}
		const task = createTask(provider)
		task.ask = vi
			.fn()
			.mockResolvedValueOnce({ response: "yesButtonClicked" })
			.mockResolvedValueOnce({ response: "yesButtonClicked" })
		const initiateTaskLoop = (task as unknown as { initiateTaskLoop: ReturnType<typeof vi.fn> }).initiateTaskLoop

		await getPendingActionAccess(task).resumePendingTaskAction(finishAction)

		expect(provider.clearPendingTaskAction).toHaveBeenCalledWith("task-1", "finish-action")
		expect(task.ask).toHaveBeenNthCalledWith(2, "completion_result", "", false)
		expect(initiateTaskLoop).not.toHaveBeenCalled()
	})

	it("keeps a recoverable approved finish handoff pending and retryable", async () => {
		const provider = {
			reopenParentFromDelegation: vi
				.fn()
				.mockResolvedValue({ kind: "recoverable_failure", phase: "precommit", reason: "history_write_failed" }),
			clearPendingTaskAction: vi.fn(),
			markDelegatedChildProtocolBlocked: vi.fn().mockResolvedValue(true),
		}
		const task = createTask(provider)
		task.ask = vi.fn().mockResolvedValue({ response: "yesButtonClicked" })

		await expect(getPendingActionAccess(task).resumePendingTaskAction(finishAction)).rejects.toThrow(
			"history_write_failed",
		)

		expect(provider.markDelegatedChildProtocolBlocked).toHaveBeenCalledWith({
			parentTaskId: "parent-1",
			childTaskId: "task-1",
		})
		expect(provider.clearPendingTaskAction).not.toHaveBeenCalled()
		expect(task.ask).toHaveBeenCalledTimes(1)
		expect(task.ask).not.toHaveBeenCalledWith("completion_result", "", false)
	})

	it("adopts and resumes a newer persisted action at the stale-action recursion boundary", async () => {
		const newerAction: PendingTaskAction = {
			...createAction,
			actionId: "newer-action",
			approvalText: JSON.stringify({ tool: "newTask", action: "newer" }),
		}
		const provider = {
			reopenParentFromDelegation: vi.fn().mockResolvedValue(false),
			clearPendingTaskAction: vi.fn().mockResolvedValue(false),
			taskHistoryStore: { get: vi.fn().mockReturnValue({ pendingAction: newerAction }) },
			delegateParentAndOpenChild: vi.fn().mockResolvedValue({ taskId: "child-2" }),
		}
		const task = createTask(provider)
		task.ask = vi
			.fn()
			.mockResolvedValueOnce({ response: "yesButtonClicked" })
			.mockResolvedValueOnce({ response: "yesButtonClicked" })
		const initiateTaskLoop = (task as unknown as { initiateTaskLoop: ReturnType<typeof vi.fn> }).initiateTaskLoop

		await getPendingActionAccess(task).resumePendingTaskAction(finishAction)

		expect(task.ask).toHaveBeenCalledTimes(2)
		expect(task.ask).toHaveBeenNthCalledWith(1, "tool", finishAction.approvalText, false)
		expect(task.ask).toHaveBeenNthCalledWith(2, "tool", newerAction.approvalText, false)
		expect(task.ask).not.toHaveBeenCalledWith("completion_result", "", false)
		expect(provider.reopenParentFromDelegation).toHaveBeenCalledTimes(1)
		expect(provider.reopenParentFromDelegation).toHaveBeenCalledWith(
			expect.objectContaining({ pendingActionId: "finish-action" }),
		)
		expect(provider.clearPendingTaskAction).toHaveBeenCalledTimes(1)
		expect(provider.clearPendingTaskAction).toHaveBeenCalledWith("task-1", "finish-action")
		expect(provider.taskHistoryStore.get).toHaveBeenCalledTimes(1)
		expect(provider.taskHistoryStore.get).toHaveBeenCalledWith("task-1")
		expect(provider.delegateParentAndOpenChild).toHaveBeenCalledTimes(1)
		expect(provider.delegateParentAndOpenChild).toHaveBeenCalledWith({
			parentTaskId: "task-1",
			message: newerAction.message,
			initialTodos: newerAction.todos,
			mode: newerAction.mode,
			pendingActionId: "newer-action",
		})
		expect(provider.clearPendingTaskAction.mock.invocationCallOrder[0]).toBeLessThan(
			provider.taskHistoryStore.get.mock.invocationCallOrder[0],
		)
		expect(provider.taskHistoryStore.get.mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(task.ask).mock.invocationCallOrder[1],
		)
		expect(vi.mocked(task.ask).mock.invocationCallOrder[1]).toBeLessThan(
			provider.delegateParentAndOpenChild.mock.invocationCallOrder[0],
		)
		expect((task as unknown as { pendingAction?: PendingTaskAction }).pendingAction).toEqual(newerAction)
		expect(initiateTaskLoop).not.toHaveBeenCalled()
	})

	it("continues with denied queued feedback after durable persistence", async () => {
		const provider = { reopenParentFromDelegation: vi.fn().mockResolvedValue(false) }
		const task = createTask(provider)
		task.ask = vi.fn().mockResolvedValue({
			response: "messageResponse",
			text: "Revise this",
			queuedMessageId: "queued-1",
		})

		await getPendingActionAccess(task).resumePendingTaskAction(finishAction)

		expect(task.persistQueuedFeedbackAndAcknowledge).toHaveBeenCalledWith("queued-1", "Revise this", undefined)
		const initiateTaskLoop = (task as unknown as { initiateTaskLoop: ReturnType<typeof vi.fn> }).initiateTaskLoop
		// The denied loop is prepared in the resolve phase and runs after the exclusion is released.
		expect(initiateTaskLoop).toHaveBeenCalledWith(
			[expect.objectContaining({ type: "tool_result", tool_use_id: "finish-action" })],
			expect.any(Function),
		)
		const persist = vi.mocked(task.persistQueuedFeedbackAndAcknowledge)
		expect(persist.mock.invocationCallOrder[0]).toBeLessThan(initiateTaskLoop.mock.invocationCallOrder[0])
	})

	it("does not continue when durable queued feedback persistence fails", async () => {
		const task = createTask({})
		task.ask = vi.fn().mockResolvedValue({
			response: "messageResponse",
			text: "Revise this",
			queuedMessageId: "queued-1",
		})
		task.persistQueuedFeedbackAndAcknowledge = vi.fn().mockResolvedValue(false)
		const initiateTaskLoop = (task as unknown as { initiateTaskLoop: ReturnType<typeof vi.fn> }).initiateTaskLoop

		await expect(getPendingActionAccess(task).resumePendingTaskAction(createAction)).rejects.toThrow(
			"task loop was not resumed",
		)
		expect(initiateTaskLoop).not.toHaveBeenCalled()
	})

	it("records ordinary feedback when a restored action is denied", async () => {
		const task = createTask({})
		task.ask = vi.fn().mockResolvedValue({ response: "messageResponse", text: "No" })

		await getPendingActionAccess(task).resumePendingTaskAction(createAction)

		expect(task.say).toHaveBeenCalledWith("user_feedback", "No", undefined)
	})

	it("continues with a textless denial when the user clicks the deny button", async () => {
		const provider = {
			delegateParentAndOpenChild: vi.fn(),
			reopenParentFromDelegation: vi.fn(),
		}
		const task = createTask(provider)
		task.ask = vi.fn().mockResolvedValue({ response: "noButtonClicked" })
		const initiateTaskLoop = (task as unknown as { initiateTaskLoop: ReturnType<typeof vi.fn> }).initiateTaskLoop

		await getPendingActionAccess(task).resumePendingTaskAction(createAction)

		expect(provider.delegateParentAndOpenChild).not.toHaveBeenCalled()
		expect(provider.reopenParentFromDelegation).not.toHaveBeenCalled()
		expect(task.say).not.toHaveBeenCalled()
		// The denied loop is prepared in the resolve phase and runs after the exclusion is released.
		expect(initiateTaskLoop).toHaveBeenCalledWith(
			[
				{
					type: "tool_result",
					tool_use_id: "create-action",
					content: JSON.stringify({ status: "denied", message: "The user denied this operation." }),
				},
			],
			expect.any(Function),
		)
	})

	it("fails clearly when the provider is unavailable", async () => {
		const task = createTask()

		await expect(getPendingActionAccess(task).resumePendingTaskAction(createAction)).rejects.toThrow(
			"Provider unavailable",
		)
	})
})

describe("delegated completion loop stop", () => {
	it.each([false, true])(
		"stops the real request loop while retaining pending action (UI rejects: %s)",
		async (rejectUI) => {
			const task = createTask({})
			if (rejectUI) task.say = vi.fn().mockRejectedValue(new Error("UI unavailable"))
			await task.stopDelegatedCompletion("Repair storage, then reopen the child or restart from its parent.")
			expect(task.isDelegatedCompletionStopped).toBe(true)
			expect((task as unknown as { pendingAction: PendingTaskAction }).pendingAction).toEqual(finishAction)
			await expect(task.recursivelyMakeClineRequests([])).resolves.toBe(true)
			expect(task.say).toHaveBeenCalledExactlyOnceWith("error", expect.stringContaining("reopen"))
		},
	)
})
