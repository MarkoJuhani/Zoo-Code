import type { HistoryItem } from "@roo-code/types"

/** Internal on-disk revision; the public HistoryItem schema deliberately does not own it. */
export type OrdinaryAuthorityHistoryItem = HistoryItem & { ordinaryPersistenceRevision?: string }
export interface OrdinaryPersistenceIdentity {
	readonly id: string
	readonly parentTaskId?: string
	readonly rootTaskId?: string
	readonly revision?: string
}

/** Capture once per Task instance. A new lease or refreshed cache does not renew this identity. */
export function ordinaryPersistenceIdentity(
	item: Pick<OrdinaryAuthorityHistoryItem, "id" | "parentTaskId" | "rootTaskId" | "ordinaryPersistenceRevision">,
): OrdinaryPersistenceIdentity {
	return {
		id: item.id,
		parentTaskId: item.parentTaskId,
		rootTaskId: item.rootTaskId,
		revision: item.ordinaryPersistenceRevision,
	}
}

export function matchesOrdinaryPersistenceAuthority(
	authority: OrdinaryPersistenceIdentity,
	item: OrdinaryAuthorityHistoryItem,
): boolean {
	return (
		item.id === authority.id &&
		item.parentTaskId === authority.parentTaskId &&
		item.rootTaskId === authority.rootTaskId &&
		item.ordinaryPersistenceRevision === authority.revision
	)
}

/** An explicit instance revision is comparison evidence, not permission to advance authority. */
export function matchesOrdinaryHistorySnapshot(item: HistoryItem, disk: OrdinaryAuthorityHistoryItem | null): boolean {
	if (!Object.prototype.hasOwnProperty.call(item, "ordinaryPersistenceRevision")) return true
	const snapshot = item as OrdinaryAuthorityHistoryItem
	return (
		snapshot.ordinaryPersistenceRevision === disk?.ordinaryPersistenceRevision &&
		(!disk || (snapshot.parentTaskId === disk.parentTaskId && snapshot.rootTaskId === disk.rootTaskId))
	)
}

/** Pure publication transform; the runtime supplies a new crypto UUID on each abandonment side. */
export function advanceOrdinaryPersistenceRevision(item: HistoryItem, revision: string): OrdinaryAuthorityHistoryItem {
	return { ...item, ordinaryPersistenceRevision: revision }
}

/** Valid status values for a task's HistoryItem. */
export type HistoryItemStatus = NonNullable<HistoryItem["status"]>

export const VALID_TASK_STATUS_TRANSITIONS: Readonly<Record<HistoryItemStatus, readonly HistoryItemStatus[]>> = {
	active: ["delegated", "completed", "interrupted", "blocked_protocol_error"],
	delegated: ["active", "blocked_protocol_error"],
	interrupted: ["completed", "blocked_protocol_error"],
	blocked_protocol_error: ["active", "completed", "interrupted"],
	completed: [],
}

export class LifecycleTransitionError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "LifecycleTransitionError"
	}
}

/**
 * The transition was not applied because its serialization point stayed busy past its
 * bound. Like any refusal, nothing was written; the caller keeps the prior status.
 */
export class LifecycleTransitionContentionError extends LifecycleTransitionError {
	constructor(message: string) {
		super(message)
		this.name = "LifecycleTransitionContentionError"
	}
}

export function assertValidTransition(from: HistoryItemStatus | undefined, to: HistoryItemStatus): void {
	const fromStatus: HistoryItemStatus = from ?? "active"
	if (!VALID_TASK_STATUS_TRANSITIONS[fromStatus].includes(to)) {
		throw new Error(`Invalid task status transition: ${fromStatus} → ${to}`)
	}
}

/** Whether delegateTaskToChild accepts a parent in this status; `delegated` needs an interrupted awaited child. */
export function canDelegateTask(
	status: HistoryItemStatus | undefined,
	awaitedChildStatus?: HistoryItemStatus,
): boolean {
	const fromStatus: HistoryItemStatus = status ?? "active"
	if (fromStatus === "delegated") return awaitedChildStatus === "interrupted"
	return VALID_TASK_STATUS_TRANSITIONS[fromStatus].includes("delegated")
}

export function delegateTaskToChild(
	parent: HistoryItem,
	childId: string,
	awaitedChildStatus?: HistoryItemStatus,
): HistoryItem {
	let base = parent
	if (parent.status === "delegated") {
		if (awaitedChildStatus !== "interrupted") {
			throw new LifecycleTransitionError(
				`Cannot re-delegate task ${parent.id}: existing child ${parent.awaitingChildId} is ${awaitedChildStatus}, not interrupted`,
			)
		}
		base = {
			...parent,
			status: "active",
			awaitingChildId: undefined,
			delegatedToId: undefined,
			protocolErrorCode: undefined,
			protocolErrorChildId: undefined,
		}
	}

	assertValidTransition(base.status, "delegated")
	return {
		...base,
		status: "delegated",
		delegatedToId: childId,
		awaitingChildId: childId,
		childIds: Array.from(new Set([...(base.childIds ?? []), childId])),
	}
}

export function interruptDelegatedChild(parent: HistoryItem, child: HistoryItem): HistoryItem {
	if (
		(parent.status !== "delegated" && parent.status !== "blocked_protocol_error") ||
		parent.awaitingChildId !== child.id ||
		child.parentTaskId !== parent.id ||
		(child.status === "blocked_protocol_error" && child.protocolErrorChildId !== undefined)
	) {
		throw new LifecycleTransitionError(`Task ${parent.id} is not delegated to child ${child.id}`)
	}
	assertValidTransition(child.status, "interrupted")
	return { ...child, status: "interrupted", protocolErrorCode: undefined }
}

export function blockDelegatedChildProtocol(
	parent: HistoryItem,
	child: HistoryItem,
): { parent: HistoryItem; child: HistoryItem } {
	if (
		(parent.status !== "delegated" && parent.status !== "active" && parent.status !== "blocked_protocol_error") ||
		parent.awaitingChildId !== child.id ||
		child.parentTaskId !== parent.id
	) {
		throw new LifecycleTransitionError(`Task ${parent.id} is not delegated to child ${child.id}`)
	}
	let blockedChild = child
	if (child.status !== "blocked_protocol_error") {
		assertValidTransition(child.status, "blocked_protocol_error")
		blockedChild = { ...child, status: "blocked_protocol_error", protocolErrorCode: "missing_attempt_completion" }
	}
	return {
		child: blockedChild,
		parent: {
			...parent,
			status: "blocked_protocol_error",
			protocolErrorCode: "missing_attempt_completion",
			protocolErrorChildId: child.id,
		},
	}
}

export function completeDelegatedChild(
	parent: HistoryItem,
	child: HistoryItem,
	completionResultSummary: string,
): { parent: HistoryItem; child: HistoryItem } {
	if (
		(parent.status !== "delegated" && parent.status !== "active" && parent.status !== "blocked_protocol_error") ||
		parent.awaitingChildId !== child.id ||
		child.parentTaskId !== parent.id
	) {
		throw new LifecycleTransitionError(`Task ${parent.id} is not delegated to child ${child.id}`)
	}
	assertValidTransition(child.status, "completed")
	if (parent.status !== "active") assertValidTransition(parent.status, "active")

	return {
		child: {
			...child,
			status: "completed",
			completionResultSummary,
			protocolErrorCode: undefined,
		},
		parent: {
			...parent,
			status: "active",
			completedByChildId: child.id,
			completionResultSummary,
			awaitingChildId: undefined,
			delegatedToId: undefined,
			protocolErrorCode: undefined,
			protocolErrorChildId: undefined,
			childIds: Array.from(new Set([...(parent.childIds ?? []), child.id])),
		},
	}
}

export function abandonDelegatedChild(
	parent: HistoryItem,
	child: HistoryItem,
): { parent: HistoryItem; child: HistoryItem } {
	if (parent.status !== "delegated" || parent.awaitingChildId !== child.id || child.parentTaskId !== parent.id) {
		throw new LifecycleTransitionError(`Task ${parent.id} is not delegated to child ${child.id}`)
	}
	if (child.status !== "interrupted") {
		throw new LifecycleTransitionError(`Cannot abandon child ${child.id} with status ${child.status}`)
	}
	assertValidTransition(parent.status, "active")

	return {
		child: { ...child, parentTaskId: undefined, rootTaskId: undefined, pendingQuestion: undefined },
		parent: {
			...parent,
			status: "active",
			awaitingChildId: undefined,
			delegatedToId: undefined,
			protocolErrorCode: undefined,
			protocolErrorChildId: undefined,
		},
	}
}

/**
 * A user resume makes an interrupted task live again (`interrupted → active`). Allowed only
 * for the child its parent still awaits (parent `delegated` or `blocked_protocol_error`), or
 * for a task with no parent link (never delegated, or abandoned). A child superseded by
 * re-delegation stays interrupted: an active linked child must be the one its parent awaits.
 *
 * `interrupted → active` is intentionally absent from VALID_TASK_STATUS_TRANSITIONS, which
 * keeps stale ordinary saves from undoing an interruption. Only this reducer's result,
 * persisted by TaskHistoryStore.resumeInterruptedTask, may make that transition.
 */
export function resumeInterruptedTask(task: HistoryItem, parent?: HistoryItem): HistoryItem {
	if (task.status !== "interrupted") {
		throw new LifecycleTransitionError(`Cannot resume task ${task.id} with status ${task.status ?? "active"}`)
	}
	if (task.awaitingChildId !== undefined || task.delegatedToId !== undefined) {
		throw new LifecycleTransitionError(`Cannot resume task ${task.id}: it still points to an awaited child`)
	}
	if (
		task.parentTaskId !== undefined &&
		(parent?.id !== task.parentTaskId ||
			(parent.status !== "delegated" && parent.status !== "blocked_protocol_error") ||
			parent.awaitingChildId !== task.id)
	) {
		throw new LifecycleTransitionError(`Task ${task.parentTaskId} no longer awaits interrupted child ${task.id}`)
	}
	return { ...task, status: "active" }
}

/** A question is not resolved by interruption, approval, or synthetic tool feedback. */
export function registerPendingQuestion(
	item: HistoryItem,
	question: NonNullable<HistoryItem["pendingQuestion"]>,
): HistoryItem {
	if (question.taskId !== item.id || item.pendingQuestion || item.status === "completed") {
		throw new LifecycleTransitionError("Question registration conflicts with task ownership")
	}
	return { ...item, pendingQuestion: question }
}

export function answerPendingQuestion(
	item: HistoryItem,
	questionId: string,
	answer: NonNullable<NonNullable<HistoryItem["pendingQuestion"]>["answer"]>,
): HistoryItem {
	if (item.pendingQuestion?.id !== questionId || item.pendingQuestion.answer) return item
	return { ...item, pendingQuestion: { ...item.pendingQuestion, answer } }
}

export function clearPendingQuestion(
	item: HistoryItem,
	questionId: string,
	reason: "durable_result" | "abandon" | "replace",
): HistoryItem {
	if (item.pendingQuestion?.id !== questionId) return item
	if (reason === "durable_result" && !item.pendingQuestion.answer) {
		throw new LifecycleTransitionError("An unanswered question has no durable answer result")
	}
	return { ...item, pendingQuestion: undefined }
}
