import * as vscode from "vscode"

import { RooCodeEventName, type HistoryItem, type PendingTaskAction } from "@roo-code/types"

import { Task } from "../task/Task"
import {
	type DelegationHandoffFailureReason,
	type DelegationFailureStage,
	type DelegationFailureDiagnostic,
	DELEGATED_COMPLETION_RECOVERY,
	type DelegationHandoffOutcome,
	normalizeDelegationHandoffOutcome,
} from "../task/childCompletionProtocol"
import { formatResponse } from "../prompts/responses"
import { Package } from "../../shared/package"
import type { ToolUse } from "../../shared/tools"
import { t } from "../../i18n"

import { BaseTool, ToolCallbacks } from "./BaseTool"
import { sanitizeToolUseId } from "../../utils/tool-id"

interface AttemptCompletionParams {
	result: string
	command?: string
}

export interface AttemptCompletionCallbacks extends ToolCallbacks {
	askFinishSubTaskApproval: () => Promise<boolean>
	toolDescription: () => string
}

/**
 * Interface for provider methods needed by AttemptCompletionTool for delegation handling.
 */
interface DelegationProvider {
	log(message: string): void
	getTaskMetadata(
		id: string,
	): Promise<{ kind: "found"; item: HistoryItem } | { kind: "missing" } | { kind: "read_error"; error: unknown }>
	setPendingTaskAction(taskId: string, pendingAction: PendingTaskAction): Promise<void>
	clearPendingTaskAction(taskId: string, actionId: string): Promise<boolean>
	markDelegatedChildProtocolBlocked?(params: { parentTaskId: string; childTaskId: string }): Promise<boolean>
	emitDelegatedTaskCompleted(
		taskId: string,
		tokenUsage: ReturnType<Task["getTokenUsage"]>,
		toolUsage: Task["toolUsage"],
	): void
	reopenParentFromDelegation(params: {
		parentTaskId: string
		childTaskId: string
		completionResultSummary: string
		pendingActionId?: string
	}): Promise<DelegationHandoffOutcome | boolean>
}

export class AttemptCompletionTool extends BaseTool<"attempt_completion"> {
	readonly name = "attempt_completion" as const

	async execute(params: AttemptCompletionParams, task: Task, callbacks: AttemptCompletionCallbacks): Promise<void> {
		if (task.isDelegatedCompletionStopped) return
		const { result } = params
		const { handleError, pushToolResult, askFinishSubTaskApproval, toolCallId } = callbacks

		// Prevent attempt_completion if any tool failed in the current turn
		if (task.didToolFailInCurrentTurn) {
			const errorMsg = t("common:errors.attempt_completion_tool_failed")

			await task.say("error", errorMsg)
			pushToolResult(formatResponse.toolError(errorMsg))
			return
		}

		const preventCompletionWithOpenTodos = vscode.workspace
			.getConfiguration(Package.name)
			.get<boolean>("preventCompletionWithOpenTodos", false)

		const hasIncompleteTodos = task.todoList && task.todoList.some((todo) => todo.status !== "completed")

		if (preventCompletionWithOpenTodos && hasIncompleteTodos) {
			task.consecutiveMistakeCount++
			task.recordToolError("attempt_completion")

			pushToolResult(
				formatResponse.toolError(
					"Cannot complete task while there are incomplete todos. Please finish all todos before attempting completion.",
				),
			)

			return
		}

		try {
			if (!result) {
				task.consecutiveMistakeCount++
				task.recordToolError("attempt_completion")
				pushToolResult(await task.sayAndCreateMissingParamError("attempt_completion", "result"))
				return
			}

			task.consecutiveMistakeCount = 0

			try {
				await task.say("completion_result", result, undefined, false)
			} catch (error) {
				if (!task.parentTaskId) throw error
				await this.pushDelegationFailure(
					task,
					undefined,
					pushToolResult,
					"completion_display_failed",
					"completion_display",
					error,
				)
				return
			}

			// Whether this attempt_completion call is a stale replay of an already-completed
			// subtask (user revisiting it from history) rather than a live model-initiated
			// completion. Determined below, before telemetry is flushed, so a replay -- which
			// runs this handler again on a fresh Task instance with a zero telemetry baseline
			// -- doesn't produce a duplicate "attempt_completion" installment for work that
			// was already reported when the subtask first completed.
			let isStaleHistoryReplay = false

			// Check for subtask using authoritative metadata-only delegation reads.
			if (task.parentTaskId) {
				const provider = task.providerRef.deref() as DelegationProvider | undefined
				if (!provider) {
					await this.pushDelegationFailure(
						task,
						undefined,
						pushToolResult,
						"provider_unavailable",
						"provider_access",
					)
					return
				}

				const childRead = await this.readMetadata(provider, task.taskId)
				if (childRead.kind !== "found") {
					await this.blockDelegatedCompletion(
						task,
						provider,
						pushToolResult,
						childRead.kind === "missing" ? "child_metadata_missing" : "metadata_read_failed",
						"child_metadata_read",
						childRead.kind === "read_error" ? childRead.error : undefined,
					)
					return
				}
				const historyItem = childRead.item
				const status = historyItem.status

				if (status === "completed") {
					isStaleHistoryReplay = true
				} else if (historyItem.parentTaskId !== task.parentTaskId) {
					// A detached child does not require a parent lookup or consume a saved action.
					if (historyItem.pendingAction) {
						await this.pushDelegationFailure(
							task,
							provider,
							pushToolResult,
							"ownership_moved",
							"ownership_validation",
							undefined,
							historyItem.pendingAction.actionId,
						)
						return
					}
					isStaleHistoryReplay = true
				} else if (status === "active" || status === "interrupted" || status === "blocked_protocol_error") {
					const parentRead = await this.readMetadata(provider, task.parentTaskId)
					if (parentRead.kind !== "found") {
						await this.blockDelegatedCompletion(
							task,
							provider,
							pushToolResult,
							parentRead.kind === "missing" ? "parent_metadata_missing" : "metadata_read_failed",
							"parent_metadata_read",
							parentRead.kind === "read_error" ? parentRead.error : undefined,
						)
						return
					}
					const parentHistory = parentRead.item
					const parentOwns =
						parentHistory.awaitingChildId === task.taskId &&
						(parentHistory.delegatedToId === undefined || parentHistory.delegatedToId === task.taskId)
					const parentStateValid =
						parentHistory.status === "delegated" ||
						parentHistory.status === "active" ||
						parentHistory.status === "blocked_protocol_error"

					if (!parentOwns || !parentStateValid) {
						await this.blockDelegatedCompletion(
							task,
							provider,
							pushToolResult,
							parentOwns ? "parent_state_mismatch" : "ownership_moved",
							"ownership_validation",
						)
						return
					} else {
						const savedAction = historyItem.pendingAction
						if (
							savedAction &&
							(savedAction.kind !== "finish_subtask" || savedAction.parentTaskId !== task.parentTaskId)
						) {
							await this.blockDelegatedCompletion(
								task,
								provider,
								pushToolResult,
								"pending_action_mismatch",
								"pending_action_write",
								undefined,
								savedAction.actionId,
							)
							return
						}
						const pendingActionId =
							savedAction?.actionId ?? (toolCallId ? sanitizeToolUseId(toolCallId) : undefined)
						const completionResult = savedAction?.kind === "finish_subtask" ? savedAction.result : result
						if (pendingActionId && !savedAction) {
							const pendingAction: PendingTaskAction = {
								kind: "finish_subtask",
								actionId: pendingActionId,
								approvalText: JSON.stringify({ tool: "finishTask" }),
								parentTaskId: task.parentTaskId,
								result,
							}
							try {
								await provider.setPendingTaskAction(task.taskId, pendingAction)
								task.setPendingTaskAction(pendingAction)
							} catch (error) {
								await this.pushDelegationFailure(
									task,
									provider,
									pushToolResult,
									"pending_action_write_failed",
									"pending_action_write",
									error,
									pendingActionId,
								)
								return
							}
						}

						// Telemetry is best-effort only after the pair commit.
						try {
							if (!(await task.waitForCurrentAssistantMessagePersistence())) return
						} catch (error) {
							await this.pushDelegationFailure(
								task,
								provider,
								pushToolResult,
								"durability_failed",
								"preapproval_durability",
								error,
								pendingActionId,
							)
							return
						}

						const delegation = await this.delegateToParent(
							task,
							completionResult,
							provider,
							pendingActionId,
							askFinishSubTaskApproval,
							pushToolResult,
						)
						if (delegation === "delegated") {
							this.postcommit(
								provider,
								task,
								"telemetry",
								() => task.flushTelemetryInstallment("attempt_completion"),
								pendingActionId,
							)
							this.postcommit(
								provider,
								task,
								"final_token_usage",
								() => task.emitFinalTokenUsageUpdate(),
								pendingActionId,
							)
							this.postcommit(
								provider,
								task,
								"child_completion_event",
								() =>
									provider.emitDelegatedTaskCompleted(
										task.taskId,
										task.getTokenUsage(),
										task.toolUsage,
									),
								pendingActionId,
							)
						}
						if (delegation !== "continue") return
					}
				} else {
					await this.blockDelegatedCompletion(
						task,
						provider,
						pushToolResult,
						"unexpected_child_status",
						"child_status_validation",
					)
					return
				}
			}

			// PostHog telemetry: report here, once per model-initiated attempt_completion
			// call, regardless of whether the user goes on to accept, decline, or give
			// feedback. Gating this on user acceptance previously meant a task that never
			// got an explicit "yes" (declined, abandoned mid-review, etc.) reported nothing
			// at all. This is independent of the public TaskCompleted API event, which still
			// only fires once the task is genuinely finished. Skipped for a stale history
			// replay (revisiting an already-completed subtask) since that reruns this handler
			// on a fresh Task instance and would otherwise double-report work already flushed
			// when the subtask first completed. Committed delegation returns above.
			if (!isStaleHistoryReplay) {
				task.emitFinalTokenUsageUpdate()
				task.flushTelemetryInstallment("attempt_completion")
			}

			const { response, text, images, queuedMessageId } = await task.ask("completion_result", "", false)

			if (response === "yesButtonClicked") {
				// A stale history replay reruns this handler on a fresh Task instance for a
				// subtask that already completed (and already emitted TaskCompleted) the first
				// time through -- re-acknowledging it from history must not emit it again.
				if (!isStaleHistoryReplay) {
					try {
						await this.emitPublicTaskCompleted(task)
					} catch (error) {
						await handleError("persisting task completion", error as Error)
					}
				}
				return
			}

			// User provided feedback - push tool result to continue the conversation
			if (queuedMessageId) {
				const persisted = await task.persistQueuedFeedbackAndAcknowledge(queuedMessageId, text, images)
				if (!persisted) {
					throw new Error(`Failed to persist queued completion feedback ${queuedMessageId}`)
				}
			} else {
				await task.say("user_feedback", text ?? "", images)
			}

			const feedbackText = `<user_message>\n${text}\n</user_message>`
			pushToolResult(formatResponse.toolResult(feedbackText, images))
		} catch (error) {
			await handleError("inspecting site", error as Error)
		}
	}

	private async readMetadata(
		provider: DelegationProvider,
		id: string,
	): ReturnType<DelegationProvider["getTaskMetadata"]> {
		try {
			return await provider.getTaskMetadata(id)
		} catch (error) {
			return { kind: "read_error", error }
		}
	}

	private normalizeError(error: unknown): { name?: string; code?: string } {
		// Never stringify arbitrary exceptions or trust accessor properties.
		const diagnostic: { name?: string; code?: string } = {}
		try {
			const value = error as { name?: unknown; code?: unknown }
			const name = value?.name
			if (
				typeof name === "string" &&
				["Error", "TypeError", "RangeError", "SyntaxError", "AbortError", "TimeoutError"].includes(name)
			)
				diagnostic.name = name
		} catch {}
		try {
			const code = (error as { code?: unknown })?.code
			if (
				typeof code === "string" &&
				["ENOENT", "EACCES", "EPERM", "EIO", "ENOSPC", "ETIMEDOUT", "ECONNRESET", "ABORT_ERR"].includes(code)
			)
				diagnostic.code = code
		} catch {}
		return diagnostic
	}

	private safeLog(provider: DelegationProvider | undefined, message: string): void {
		try {
			provider?.log(message)
		} catch {
			/* Diagnostic sinks cannot change lifecycle outcomes. */
		}
	}

	private async pushDelegationFailure(
		task: Task,
		provider: DelegationProvider | undefined,
		pushToolResult: (result: string) => void,
		reason: DelegationHandoffFailureReason,
		stage: DelegationFailureStage,
		error?: unknown,
		actionId?: string,
	): Promise<void> {
		const diagnostic: DelegationFailureDiagnostic = {
			phase: "precommit",
			stage,
			reason,
			parentTaskId: task.parentTaskId!,
			childTaskId: task.taskId,
			...(actionId && { actionId }),
			...this.normalizeError(error),
		}
		const message = `Delegated completion handoff failed: ${JSON.stringify(diagnostic)}. ${DELEGATED_COMPLETION_RECOVERY}`
		// Set the loop gate before any fallible sink, including persistence of the UI message.
		await task.stopDelegatedCompletion(message)
		this.safeLog(provider, `[AttemptCompletionTool] ${message}`)
		task.recordToolError("attempt_completion")
		pushToolResult(formatResponse.toolError(message))
	}

	private postcommit(
		provider: DelegationProvider,
		task: Task,
		stage: string,
		notify: () => void,
		actionId?: string,
	): void {
		try {
			notify()
		} catch (error) {
			this.safeLog(
				provider,
				`[AttemptCompletionTool] Postcommit diagnostic ${JSON.stringify({
					phase: "committed",
					stage,
					parentTaskId: task.parentTaskId,
					childTaskId: task.taskId,
					...(actionId && { actionId }),
					...this.normalizeError(error),
				})}`,
			)
		}
	}

	private async blockDelegatedCompletion(
		task: Task,
		provider: DelegationProvider,
		pushToolResult: (result: string) => void,
		reason: DelegationHandoffFailureReason,
		stage: DelegationFailureStage,
		error?: unknown,
		actionId?: string,
	): Promise<void> {
		try {
			await provider.markDelegatedChildProtocolBlocked?.({
				parentTaskId: task.parentTaskId!,
				childTaskId: task.taskId,
			})
		} catch (blockError) {
			this.safeLog(
				provider,
				`[AttemptCompletionTool] Block persistence failed ${JSON.stringify({
					phase: "precommit",
					stage: "block_persistence",
					parentTaskId: task.parentTaskId,
					childTaskId: task.taskId,
					...this.normalizeError(blockError),
				})}`,
			)
		}
		await this.pushDelegationFailure(task, provider, pushToolResult, reason, stage, error, actionId)
	}

	private async delegateToParent(
		task: Task,
		result: string,
		provider: DelegationProvider,
		pendingActionId: string | undefined,
		askFinishSubTaskApproval: () => Promise<boolean>,
		pushToolResult: (result: string) => void,
	): Promise<"delegated" | "denied" | "continue" | "blocked" | undefined> {
		let didApprove: boolean
		try {
			didApprove = await askFinishSubTaskApproval()
		} catch (error) {
			await this.pushDelegationFailure(
				task,
				provider,
				pushToolResult,
				"approval_failed",
				"approval",
				error,
				pendingActionId,
			)
			return "blocked"
		}
		if (!didApprove) {
			pushToolResult(formatResponse.toolDenied())
			return "denied"
		}

		try {
			if (!(await task.waitForCurrentAssistantMessagePersistence())) return
		} catch (error) {
			await this.pushDelegationFailure(
				task,
				provider,
				pushToolResult,
				"durability_failed",
				"postapproval_durability",
				error,
				pendingActionId,
			)
			return "blocked"
		}

		let outcome: DelegationHandoffOutcome
		try {
			outcome = normalizeDelegationHandoffOutcome(
				await provider.reopenParentFromDelegation({
					parentTaskId: task.parentTaskId!,
					childTaskId: task.taskId,
					completionResultSummary: result,
					...(pendingActionId && { pendingActionId }),
				}),
			)
		} catch (error) {
			await this.pushDelegationFailure(
				task,
				provider,
				pushToolResult,
				"unexpected_provider_rejection",
				"provider_handoff",
				error,
				pendingActionId,
			)
			return "blocked"
		}

		if (outcome.kind === "detached") {
			// Do not let normal feedback persistence consume an uncommitted saved action.
			if (pendingActionId) {
				await this.pushDelegationFailure(
					task,
					provider,
					pushToolResult,
					"ownership_moved",
					"provider_outcome",
					undefined,
					pendingActionId,
				)
				return "blocked"
			}
			return "continue"
		}
		if (outcome.kind === "pending") {
			await task.stopDelegatedCompletion(
				`Delegated completion is pending ${outcome.reason}. ${DELEGATED_COMPLETION_RECOVERY}`,
			)
			return
		}
		if (outcome.kind === "recoverable_failure") {
			await this.blockDelegatedCompletion(
				task,
				provider,
				pushToolResult,
				outcome.reason,
				"provider_outcome",
				undefined,
				pendingActionId,
			)
			return "blocked"
		}

		this.postcommit(provider, task, "tool_result", () => pushToolResult(""), pendingActionId)
		return "delegated"
	}

	override async handlePartial(task: Task, block: ToolUse<"attempt_completion">): Promise<void> {
		const result: string | undefined = block.params.result
		const command: string | undefined = block.params.command

		const lastMessage = task.clineMessages.at(-1)

		if (command) {
			if (lastMessage && lastMessage.ask === "command") {
				await task.ask("command", command ?? "", block.partial).catch(() => {})
			} else {
				await task.say("completion_result", result ?? "", undefined, false)
				await task.ask("command", command ?? "", block.partial).catch(() => {})
			}
		} else {
			await task.say("completion_result", result ?? "", undefined, block.partial)
		}
	}

	/**
	 * Emits the public RooCodeEventName.TaskCompleted API event. Only called once the
	 * task is genuinely finished (user accepted, or a subtask was successfully delegated
	 * back to its parent) and the matching assistant turn is restart-visible -- unlike the
	 * PostHog telemetry flush, which reports on every model-initiated attempt_completion call.
	 */
	private async emitPublicTaskCompleted(task: Task): Promise<void> {
		const persistenceReady = await task.waitForCurrentAssistantMessagePersistence()
		if (!persistenceReady) return

		// Force final token usage update before emitting TaskCompleted.
		// This ensures the latest stats are captured regardless of throttle timer.
		task.emitFinalTokenUsageUpdate()

		task.emit(RooCodeEventName.TaskCompleted, task.taskId, task.getTokenUsage(), task.toolUsage)
	}
}

export const attemptCompletionTool = new AttemptCompletionTool()
