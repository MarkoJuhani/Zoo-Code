import type { HistoryItem } from "@roo-code/types"

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

export function assertValidTransition(from: HistoryItemStatus | undefined, to: HistoryItemStatus): void {
	const fromStatus: HistoryItemStatus = from ?? "active"
	if (!VALID_TASK_STATUS_TRANSITIONS[fromStatus].includes(to)) {
		throw new Error(`Invalid task status transition: ${fromStatus} → ${to}`)
	}
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
		child: { ...child, parentTaskId: undefined, rootTaskId: undefined },
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
