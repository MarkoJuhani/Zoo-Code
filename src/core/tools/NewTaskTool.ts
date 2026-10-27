import * as vscode from "vscode"

import type { PendingTaskAction, TodoItem } from "@roo-code/types"

import { Task } from "../task/Task"
import type { ClineProvider } from "../webview/ClineProvider"
import { getModeBySlug } from "../../shared/modes"
import { formatResponse } from "../prompts/responses"
import { t } from "../../i18n"
import { parseMarkdownChecklist } from "./UpdateTodoListTool"
import { Package } from "../../shared/package"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { ToolUse } from "../../shared/tools"
import { sanitizeToolUseId } from "../../utils/tool-id"
import { canDelegateTask } from "../task-persistence/taskLifecycle"
import { toError } from "../../utils/errors"

interface NewTaskParams {
	mode: string
	message: string
	todos?: string
}

export class NewTaskTool extends BaseTool<"new_task"> {
	readonly name = "new_task" as const

	async execute(params: NewTaskParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { mode, message, todos } = params
		const { askApproval, handleError, pushToolResult, toolCallId } = callbacks

		let diagnostics: ReturnType<ClineProvider["createDelegationDiagnostics"]> | undefined
		try {
			// Validate required parameters.
			if (!mode) {
				task.consecutiveMistakeCount++
				task.recordToolError("new_task")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("new_task", "mode"))
				return
			}

			if (!message) {
				task.consecutiveMistakeCount++
				task.recordToolError("new_task")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("new_task", "message"))
				return
			}

			// Get the VSCode setting for requiring todos.
			const provider = task.providerRef.deref()

			if (!provider) {
				pushToolResult(formatResponse.toolError("Provider reference lost"))
				return
			}

			// A completed or blocked task cannot delegate; the provider would refuse after approval.
			// Refuse before saving an action that a reopen would replay. Interrupted and delegated
			// tasks keep their own recovery and re-delegation paths.
			const metadata = await provider.getTaskMetadata(task.taskId)
			const item = metadata.kind === "found" ? metadata.item : undefined
			const status = item?.status
			if (status && status !== "interrupted" && status !== "delegated" && !canDelegateTask(status)) {
				// A blocked parent records the failing child; a blocked child's own completion is missing.
				const errorMsg =
					status === "blocked_protocol_error" && !item?.protocolErrorChildId
						? "This task is blocked because it has not finished with attempt_completion, so it cannot start a subtask. No subtask was created. Finish the remaining work yourself and call attempt_completion."
						: `This task is ${status === "completed" ? "already completed" : "blocked by a subtask protocol error"}, so it cannot start a subtask. No subtask was created. Ask the user to start a new task for this follow-up work.`
				task.recordToolError("new_task")
				task.didToolFailInCurrentTurn = true
				await task.say("error", errorMsg)
				pushToolResult(formatResponse.toolError(errorMsg))
				return
			}

			const state = await provider.getState()

			// Use the package name as the VSCode configuration namespace.
			const requireTodos = vscode.workspace
				.getConfiguration(Package.name)
				.get<boolean>("newTaskRequireTodos", false)

			// Check if todos are required based on VSCode setting.
			// Note: `undefined` means not provided, empty string is valid.
			if (requireTodos && todos === undefined) {
				task.consecutiveMistakeCount++
				task.recordToolError("new_task")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("new_task", "todos"))
				return
			}

			// Parse todos if provided, otherwise use empty array
			let todoItems: TodoItem[] = []
			if (todos) {
				try {
					todoItems = parseMarkdownChecklist(todos)
				} catch (error) {
					task.consecutiveMistakeCount++
					task.recordToolError("new_task")
					task.didToolFailInCurrentTurn = true
					pushToolResult(formatResponse.toolError("Invalid todos format: must be a markdown checklist"))
					return
				}
			}

			task.consecutiveMistakeCount = 0

			// Un-escape one level of backslashes before '@' for hierarchical subtasks
			// Un-escape one level: \\@ -> \@ (removes one backslash for hierarchical subtasks)
			const unescapedMessage = message.replace(/\\\\@/g, "\\@")

			// Verify the mode exists
			const targetMode = getModeBySlug(mode, state?.customModes)

			if (!targetMode) {
				pushToolResult(formatResponse.toolError(`Invalid mode: ${mode}`))
				return
			}

			const toolMessage = JSON.stringify({
				tool: "newTask",
				mode: targetMode.name,
				content: message,
				todos: todoItems,
			})
			const pendingActionId = toolCallId ? sanitizeToolUseId(toolCallId) : undefined
			if (pendingActionId) {
				const pendingAction: PendingTaskAction = {
					kind: "create_subtask",
					actionId: pendingActionId,
					approvalText: toolMessage,
					mode,
					message: unescapedMessage,
					todos: todoItems,
				}
				await provider.setPendingTaskAction(task.taskId, pendingAction)
				task.setPendingTaskAction(pendingAction)
			}

			diagnostics = provider.createDelegationDiagnostics?.({
				taskId: task.taskId,
				instanceId: task.instanceId,
				actionId: pendingActionId,
			})
			diagnostics?.event("approval", "begin")
			const didApprove = await askApproval("tool", toolMessage)
			diagnostics?.event("approval", "end")

			if (!didApprove) {
				return
			}

			// Native finalization can approve while the current assistant save still owns
			// the parent fence. Await that turn outside the handoff scope, even when
			// there are no earlier tool results for the provider to flush.
			if (!(await task.waitForCurrentAssistantMessagePersistence())) {
				return
			}
			// The approval's own answered-ask save also holds the parent fence, and the handoff
			// acquires it with zero wait. Await it here, outside every scope. A failed save is
			// only logged by the task and does not block delegation.
			await task.waitForAnsweredAskPersistence()
			if (task.abort || task.abandoned) {
				return
			}

			// Delegate parent and open child as sole active task
			diagnostics?.event("tool_handoff", "begin")
			const child = await provider.delegateParentAndOpenChild({
				parentTaskId: task.taskId,
				message: unescapedMessage,
				initialTodos: todoItems,
				mode,
				...(pendingActionId && { pendingActionId }),
				...(diagnostics && { diagnostics }),
			})
			diagnostics?.event("tool_handoff", "end") // Provider returned; child may still fail asynchronously.

			// Reflect delegation in tool result (no pause/unpause, no wait)
			pushToolResult(`Delegated to child task ${child.taskId}`)
			return
		} catch (error) {
			diagnostics?.event("tool_handoff", "failure", error)
			await handleError("creating new task", toError(error))
			return
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"new_task">): Promise<void> {
		const mode: string | undefined = block.params.mode
		const message: string | undefined = block.params.message
		const todos: string | undefined = block.params.todos

		const partialMessage = JSON.stringify({
			tool: "newTask",
			mode: mode ?? "",
			content: message ?? "",
			todos: todos,
		})

		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const newTaskTool = new NewTaskTool()
