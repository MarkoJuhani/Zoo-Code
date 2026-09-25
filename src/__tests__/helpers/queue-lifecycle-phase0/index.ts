import { EventEmitter } from "events"

import { RooCodeEventName } from "@roo-code/types"

import { TaskRegistry } from "../../../core/task/TaskRegistry"
import { TaskScheduler } from "../../../core/task/TaskScheduler"
import { Task } from "../../../core/task/Task"
import { ClineProvider } from "../../../core/webview/ClineProvider"

export type LifecycleTask = EventEmitter & {
	taskId: string
	instanceId: string
	parentTaskId?: string
	apiConfiguration: Record<string, unknown>
	abort?: boolean
	abandoned?: boolean
	abortReason?: string
	abortPromise?: Promise<void>
	_isHistoryTask: boolean
	clineMessages: unknown[]
	diffReversionPromise: Promise<void>
	emitFinalTokenUsageUpdate: () => void
	providerRef: { deref: () => { flushPostStateToWebviewThrottled: () => Promise<void> } }
	dispose: () => Promise<void>
	saveClineMessages: () => Promise<void>
	abortTask: (isAbandoned?: boolean) => Promise<void>
	run: () => Promise<void>
	flushPendingToolResultsToHistory: () => Promise<boolean>
	retrySaveApiConversationHistory: () => Promise<boolean>
	cancelAssistantMessagePersistence: () => void
	getTaskMode: () => Promise<string>
	getTaskApiConfigName: () => Promise<string | undefined>
}

export function makeLifecycleTask(
	taskId: string,
	parentTaskId: string | undefined,
	run: () => Promise<void> = async () => {},
): LifecycleTask {
	const task = new EventEmitter() as LifecycleTask
	Object.assign(task, {
		taskId,
		instanceId: `${taskId}:instance:1`,
		parentTaskId,
		apiConfiguration: {},
		_isHistoryTask: true,
		clineMessages: [],
		diffReversionPromise: Promise.resolve(),
		emitFinalTokenUsageUpdate: () => {},
		providerRef: { deref: () => ({ flushPostStateToWebviewThrottled: async () => {} }) },
		dispose: async () => {},
		saveClineMessages: async () => {},
		run,
		flushPendingToolResultsToHistory: async () => true,
		retrySaveApiConversationHistory: async () => true,
		cancelAssistantMessagePersistence: () => {},
		getTaskMode: async () => "code",
		getTaskApiConfigName: async () => undefined,
	})
	task.abortTask = Task.prototype.abortTask.bind(task as unknown as Task)
	;(task as LifecycleTask & { abortTaskOnce: () => Promise<void> }).abortTaskOnce = (
		Task.prototype as unknown as { abortTaskOnce: () => Promise<void> }
	).abortTaskOnce.bind(task)
	return task
}

type History = {
	id: string
	status: "active" | "delegated" | "completed"
	awaitingChildId?: string
	parentTaskId?: string
}

export class ComposedProvider extends EventEmitter {
	public readonly context = { globalStorageUri: { fsPath: "/tmp/queue-lifecycle-phase0" } }
	public readonly cwd = "/workspace/queue-lifecycle-phase0"
	public readonly taskRegistry = new TaskRegistry()
	public readonly taskEventListeners = new Map<LifecycleTask, Array<() => void>>()
	public readonly taskScheduler = new TaskScheduler(1)
	public readonly delegationTransitionLocks = new Map<string, Promise<void>>()
	public readonly delegationTransitions = new Map<string, number>()
	public readonly cancelledDelegationChildIds = new Set<string>()
	public readonly history = new Map<string, History>()
	public readonly scheduled: string[] = []
	public readonly lineage: Array<{ parent: string; child: string }> = []
	public readonly resumed: string[] = []
	public readonly log = () => {}
	public isViewLaunched = false
	public recentTasksCache: unknown
	public readonly contextProxy = this.context
	public taskHistoryStore = {
		invalidate: async (_id: string) => {},
		get: (id: string) => this.history.get(id),
		atomicReadAndUpdate: async (id: string, update: (history: History) => History) => {
			const history = this.history.get(id)
			if (!history) throw new Error(`missing history ${id}`)
			const next = update(history)
			this.history.set(id, next)
			return [next]
		},
		atomicUpdatePair: async (
			childId: string,
			parentId: string,
			updateChild: (history: History) => History,
			updateParent: (history: History) => History,
		) => {
			const child = this.history.get(childId)
			const parent = this.history.get(parentId)
			if (!child || !parent) throw new Error("missing pair history")
			this.history.set(childId, updateChild(child))
			this.history.set(parentId, updateParent(parent))
		},
	}

	public getCurrentTask(): LifecycleTask | undefined {
		return this.taskRegistry.current as LifecycleTask | undefined
	}

	public async handleModeSwitch(): Promise<void> {}

	public async getTaskWithId(taskId: string) {
		const historyItem = this.history.get(taskId)
		if (!historyItem) throw new Error(`missing history ${taskId}`)
		return { historyItem }
	}

	public async createTaskWithHistoryItem(history: History) {
		const instance = makeLifecycleTask(history.id, undefined, async () => {
			this.resumed.push(history.id)
		}) as LifecycleTask & {
			overwriteClineMessages: () => Promise<void>
			overwriteApiConversationHistory: () => Promise<void>
			prepareAfterDelegation: () => Promise<void>
			runResumeLoop: () => Promise<void>
		}
		instance.overwriteClineMessages = async () => {}
		instance.overwriteApiConversationHistory = async () => {}
		instance.prepareAfterDelegation = async () => {}
		instance.runResumeLoop = instance.run
		this.taskRegistry.push(instance as unknown as Task)
		return instance
	}

	public async createTask(
		_message: string,
		_images: unknown,
		parent: LifecycleTask,
		options: { startTask: boolean },
	) {
		const index = this.lineage.length + 1
		const taskId = parentTaskId(parent.taskId, index)
		const child = makeLifecycleTask(taskId, parent.taskId, async () => {
			this.scheduled.push(taskId)
		})
		this.taskRegistry.push(child as unknown as Task)
		this.history.set(taskId, { id: taskId, status: "active", parentTaskId: parent.taskId })
		this.emit(RooCodeEventName.TaskCreated, child)
		if (options.startTask) await child.run()
		return child as unknown as Task
	}
}

function parentTaskId(parent: string, transition: number): string {
	return `${parent}.child.${transition}`
}

export const providerMethods = {
	removeClineFromStack: ClineProvider.prototype.removeClineFromStack,
	delegateParentAndOpenChild: ClineProvider.prototype.delegateParentAndOpenChild,
	reopenParentFromDelegation: ClineProvider.prototype.reopenParentFromDelegation,
	runDelegationTransition: (
		ClineProvider.prototype as unknown as {
			runDelegationTransition: (parentTaskId: string, fn: () => Promise<unknown>) => Promise<unknown>
		}
	).runDelegationTransition,
}

/** Exact pre-filter branch from api.ts blob 25bb827fc40342b52c951606111850fcc8abd625. */
export function sourceDerivedPreFilterAbortProjection(
	task: LifecycleTask,
	dispatches: Map<string, { terminalState?: string; ownershipReleased: boolean }>,
	emitTerminal: (taskId: string) => void,
): void {
	task.on(RooCodeEventName.TaskAborted, () => {
		const dispatch = dispatches.get(task.taskId)
		if (dispatch && (!task.parentTaskId || task.taskId === "root")) {
			dispatch.terminalState = "aborted"
			dispatch.ownershipReleased = true
			emitTerminal(task.taskId)
		}
	})
}
