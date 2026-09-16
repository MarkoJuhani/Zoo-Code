import { EventEmitter } from "events"
import fs from "fs/promises"
import * as path from "path"
import * as os from "os"

import * as vscode from "vscode"
import pWaitFor from "p-wait-for"

import {
	type RooCodeAPI,
	type RooCodeSettings,
	type RooCodeEvents,
	type ProviderSettings,
	type ProviderSettingsEntry,
	type TaskEvent,
	type CreateTaskOptions,
	type WebviewThemeFixture,
	RooCodeEventName,
	TaskCommandName,
	isSecretStateKey,
	IpcOrigin,
	IpcMessageType,
	QueueEventName,
	type QueueEvent,
	type QueueResult,
} from "@roo-code/types"
import { IpcServer } from "@roo-code/ipc"

import { Package } from "../shared/package"
import type { Mode } from "../shared/modes"
import { ClineProvider } from "../core/webview/ClineProvider"
import { Terminal } from "../integrations/terminal/Terminal"
import { TerminalRegistry } from "../integrations/terminal/TerminalRegistry"
import { openClineInNewTab } from "../activate/registerCommands"
import { getCommands } from "../services/command/commands"
import { getModels } from "../api/providers/fetchers/modelCache"

export interface QueueDispatchRecord {
	queueId: string
	generation: number
	requestId: string
	rootTaskId: string
	mode: string
	sequence: number
	result?: string
	parsedResult?: QueueResult
	terminalState?: "completed" | "aborted" | "denied" | "failed"
	ownershipReleased: boolean
	accepted: boolean
	promptReady: boolean
	activeTaskId?: string | null
	orderedEdges?: Array<{
		parent: string
		child: string
		transition: number
		active: boolean
	}>
	rootTaskCompleted?: boolean
	rootTaskAborted?: boolean
	fenceActive?: boolean
}

export function canonicalTaskPath(value: string): string {
	if (typeof value !== "string") {
		throw new Error("TASK_FILE: expected string")
	}
	if (value.startsWith("[")) {
		const match = value.match(/^\[(`?)([^`\]]+)\1\]\(([^()]+)\)$/)
		if (!match) {
			throw new Error("TASK_FILE: malformed Markdown link")
		}
		const label = match[2]
		let target = match[3]
		target = target.replace(/:[1-9][0-9]*$/, "")
		if (label !== target) {
			throw new Error("TASK_FILE: link label/target mismatch")
		}
		value = target
	}
	if (
		value.length > 512 ||
		!/^tasks\/ACTIVE_TASK_[A-Za-z0-9_.&() -]+\.md$/.test(value) ||
		value.includes("..") ||
		value.includes("//")
	) {
		throw new Error("TASK_FILE: noncanonical workspace task path")
	}
	return value
}

export function parseQueueResultText(text: string): QueueResult {
	if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 8192) {
		throw new Error("result: expected bounded text")
	}
	const lines = text.trim().split(/\r?\n/)
	if (!lines.length || !lines[0].startsWith("QUEUE_RESULT: ")) {
		throw new Error("result: missing first-line QUEUE_RESULT")
	}
	const fields = lines[0].includes("; ") ? lines[0].split("; ") : lines
	if (lines[0].includes("; ") && lines.length !== 1) {
		throw new Error("result: mixed inline/multiline layout")
	}
	const result: Record<string, string> = {}
	for (const field of fields) {
		const colonIdx = field.indexOf(": ")
		if (colonIdx === -1) {
			throw new Error("result: malformed field")
		}
		const key = field.slice(0, colonIdx)
		const value = field.slice(colonIdx + 2)
		if (!value || !["QUEUE_RESULT", "TICKET_ID", "TASK_FILE", "FINAL_COMMIT", "REASON"].includes(key)) {
			throw new Error("result: malformed or unknown field")
		}
		if (key in result) {
			throw new Error(`result: duplicate field ${key}`)
		}
		result[key] = value
	}
	const status = result["QUEUE_RESULT"]
	if (status === "DONE") {
		const expectedKeys = new Set(["QUEUE_RESULT", "TICKET_ID", "TASK_FILE", "FINAL_COMMIT"])
		const actualKeys = new Set(Object.keys(result))
		if (actualKeys.size !== expectedKeys.size || [...actualKeys].some((k) => !expectedKeys.has(k))) {
			throw new Error("result: missing/conflicting fields for DONE status")
		}
		if (!/^[0-9]+(?:-[0-9]+)*$/.test(result["TICKET_ID"])) {
			throw new Error("TICKET_ID: malformed")
		}
		const canonTask = canonicalTaskPath(result["TASK_FILE"])
		result["TASK_FILE"] = canonTask
		if (!/^[0-9a-f]{7,64}$/i.test(result["FINAL_COMMIT"])) {
			throw new Error("FINAL_COMMIT: expected hexadecimal commit")
		}
		return {
			QUEUE_RESULT: "DONE",
			TICKET_ID: result["TICKET_ID"],
			TASK_FILE: result["TASK_FILE"],
			FINAL_COMMIT: result["FINAL_COMMIT"],
		}
	} else if (status === "EMPTY") {
		if (Object.keys(result).length !== 1) {
			throw new Error("result: EMPTY with extra fields")
		}
		return { QUEUE_RESULT: "EMPTY" }
	} else if (status === "BLOCKED") {
		const expectedKeys = new Set(["QUEUE_RESULT", "REASON"])
		const actualKeys = new Set(Object.keys(result))
		if (actualKeys.size !== expectedKeys.size || [...actualKeys].some((k) => !expectedKeys.has(k))) {
			throw new Error("result: missing/conflicting fields for BLOCKED status")
		}
		const reason = result["REASON"]
		if (reason.length > 1024 || [...reason].some((char) => char.charCodeAt(0) <= 0x1f)) {
			throw new Error("REASON: invalid text")
		}
		return { QUEUE_RESULT: "BLOCKED", REASON: reason }
	}
	throw new Error(`result: unknown status ${status}`)
}

export function areQueueResultsEqual(a: QueueResult, b: QueueResult): boolean {
	if (a.QUEUE_RESULT !== b.QUEUE_RESULT) return false
	if (a.QUEUE_RESULT === "DONE" && b.QUEUE_RESULT === "DONE") {
		return (
			a.TICKET_ID === b.TICKET_ID &&
			a.TASK_FILE === b.TASK_FILE &&
			a.FINAL_COMMIT.toLowerCase() === b.FINAL_COMMIT.toLowerCase()
		)
	}
	if (a.QUEUE_RESULT === "EMPTY" && b.QUEUE_RESULT === "EMPTY") {
		return true
	}
	if (a.QUEUE_RESULT === "BLOCKED" && b.QUEUE_RESULT === "BLOCKED") {
		return a.REASON === b.REASON
	}
	return false
}

export class API extends EventEmitter<RooCodeEvents> implements RooCodeAPI {
	private readonly outputChannel: vscode.OutputChannel
	private readonly sidebarProvider: ClineProvider
	private readonly context: vscode.ExtensionContext
	private readonly ipc?: IpcServer
	private readonly log: (...args: unknown[]) => void
	private readonly serverInstanceId: string =
		process.env.ROO_CODE_SERVER_INSTANCE || Math.random().toString(36).slice(2)
	private logfile?: string
	private queueLease?: { queueId: string; ownerToken: string; leasedAt: number }
	private pendingDispatch?: QueueDispatchRecord
	private queueDispatches = new Map<string, QueueDispatchRecord>()

	constructor(
		outputChannel: vscode.OutputChannel,
		provider: ClineProvider,
		socketPath?: string,
		enableLogging = false,
	) {
		super()

		this.outputChannel = outputChannel
		this.sidebarProvider = provider
		this.context = provider.context

		if (enableLogging) {
			this.log = (...args: unknown[]) => {
				this.outputChannelLog(...args)
				console.log(args)
			}

			this.logfile = path.join(os.tmpdir(), "roo-code-messages.log")
		} else {
			this.log = () => {}
		}

		this.registerListeners(this.sidebarProvider)

		if (socketPath) {
			const ackMetadata = () => ({
				queueProtocol: 1,
				workspace: this.sidebarProvider.cwd,
				serverInstance: this.serverInstanceId,
				extensionVersion: Package.version,
				buildRevision: process.env.ROO_CODE_BUILD_REVISION || "current",
				capabilities: [
					"queue-lease",
					"correlated-start",
					"targeted-accept",
					"terminal-release",
					"targeted-cancel",
					"snapshot-subscribe",
				],
			})
			const ipc = (this.ipc = new IpcServer(socketPath, this.log, ackMetadata))

			ipc.listen()
			this.log(`[API] ipc server started: socketPath=${socketPath}, pid=${process.pid}, ppid=${process.ppid}`)

			ipc.on(IpcMessageType.TaskCommand, async (clientId, command) => {
				const sendResponse = (eventName: RooCodeEventName, payload: unknown[]) => {
					ipc.send(clientId, {
						type: IpcMessageType.TaskEvent,
						origin: IpcOrigin.Server,
						data: { eventName, payload } as TaskEvent,
					})
				}

				const sendQueueRpcResponse = (
					rpcId: string | undefined,
					commandName: string,
					ok: boolean,
					value?: unknown,
					error?: string,
				) => {
					ipc.send(clientId, {
						type: IpcMessageType.QueueResponse,
						origin: IpcOrigin.Server,
						data: {
							rpcId,
							commandName,
							ok,
							value,
							...(error ? { error } : {}),
						},
					})
				}

				switch (command.commandName) {
					case TaskCommandName.StartNewTask:
						this.log(
							`[API] StartNewTask -> ${command.data.text}, ${JSON.stringify(command.data.configuration)}`,
						)
						await this.startNewTask(command.data)
						break
					case TaskCommandName.CancelTask:
						this.log(`[API] CancelTask`)
						if (this.queueLease) {
							this.log(`[API] Untargeted CancelTask ignored while queue lease is active`)
							break
						}
						await this.cancelCurrentTask()
						break
					case TaskCommandName.CloseTask:
						this.log(`[API] CloseTask`)
						await vscode.commands.executeCommand("workbench.action.files.saveFiles")
						await vscode.commands.executeCommand("workbench.action.closeWindow")
						break
					case TaskCommandName.ResumeTask:
						this.log(`[API] ResumeTask -> ${command.data}`)
						try {
							await this.resumeTask(command.data)
						} catch (error) {
							const errorMessage = error instanceof Error ? error.message : String(error)
							this.log(`[API] ResumeTask failed for taskId ${command.data}: ${errorMessage}`)
							// Don't rethrow - we want to prevent IPC server crashes.
							// The error is logged for debugging purposes.
						}
						break
					case TaskCommandName.SendMessage:
						this.log(`[API] SendMessage -> ${command.data.text}`)
						await this.sendMessage(command.data.text, command.data.images)
						break
					case TaskCommandName.GetCommands:
						try {
							const commands = await getCommands(this.sidebarProvider.cwd)

							sendResponse(RooCodeEventName.CommandsResponse, [
								commands.map((cmd) => ({
									name: cmd.name,
									source: cmd.source,
									filePath: cmd.filePath,
									description: cmd.description,
									argumentHint: cmd.argumentHint,
								})),
							])
						} catch (error) {
							sendResponse(RooCodeEventName.CommandsResponse, [[]])
						}

						break
					case TaskCommandName.GetModes:
						try {
							const modes = await this.sidebarProvider.getModes()
							sendResponse(RooCodeEventName.ModesResponse, [modes])
						} catch (error) {
							sendResponse(RooCodeEventName.ModesResponse, [[]])
						}

						break
					case TaskCommandName.GetModels:
						try {
							sendResponse(RooCodeEventName.ModelsResponse, [{}])
						} catch (error) {
							sendResponse(RooCodeEventName.ModelsResponse, [{}])
						}

						break
					case TaskCommandName.DeleteQueuedMessage:
						this.log(`[API] DeleteQueuedMessage -> ${command.data}`)
						try {
							this.deleteQueuedMessage(command.data)
						} catch (error) {
							const errorMessage = error instanceof Error ? error.message : String(error)
							this.log(`[API] DeleteQueuedMessage failed for messageId ${command.data}: ${errorMessage}`)
						}
						break

					case TaskCommandName.QueueAcquireLease: {
						const { rpcId, queueId, ownerToken } = command.data
						if (this.queueLease && this.queueLease.ownerToken !== ownerToken) {
							sendQueueRpcResponse(rpcId, command.commandName, false, undefined, "Runtime already leased")
							break
						}
						this.queueLease = { queueId, ownerToken, leasedAt: Date.now() }
						sendQueueRpcResponse(rpcId, command.commandName, true, { queueId, exclusive: true })
						break
					}

					case TaskCommandName.QueueStartTask: {
						const { rpcId, queueId, ownerToken, generation, requestId, mode, text, configuration, images } =
							command.data
						if (
							!this.queueLease ||
							this.queueLease.queueId !== queueId ||
							this.queueLease.ownerToken !== ownerToken
						) {
							sendQueueRpcResponse(
								rpcId,
								command.commandName,
								false,
								undefined,
								"Lease ownership mismatch",
							)
							break
						}

						const existing = this.queueDispatches.get(requestId)
						if (existing) {
							sendQueueRpcResponse(rpcId, command.commandName, true, {
								queueId,
								generation: existing.generation,
								requestId,
								rootTaskId: existing.rootTaskId,
								mode: existing.mode,
							})
							break
						}

						const dispatch: QueueDispatchRecord = {
							queueId,
							generation,
							requestId,
							rootTaskId: "",
							mode,
							sequence: 0,
							ownershipReleased: false,
							accepted: false,
							promptReady: false,
							activeTaskId: null,
							orderedEdges: [],
							rootTaskCompleted: false,
							rootTaskAborted: false,
							fenceActive: false,
						}
						this.pendingDispatch = dispatch
						this.queueDispatches.set(requestId, dispatch)

						try {
							if (mode) {
								await this.sidebarProvider.handleModeSwitch(mode as Mode)
							}
							const taskId = await this.startNewTask({
								configuration: { autoApprovalEnabled: false, ...(configuration ?? {}) },
								text,
								images,
							})
							dispatch.rootTaskId = taskId
							dispatch.activeTaskId = taskId
							this.queueDispatches.set(taskId, dispatch)
							this.pendingDispatch = undefined

							sendQueueRpcResponse(rpcId, command.commandName, true, {
								queueId,
								generation,
								requestId,
								rootTaskId: taskId,
								mode,
							})
						} catch (error) {
							this.pendingDispatch = undefined
							this.queueDispatches.delete(requestId)
							const errMsg = error instanceof Error ? error.message : String(error)
							sendQueueRpcResponse(rpcId, command.commandName, false, undefined, errMsg)
						}
						break
					}

					case TaskCommandName.QueueSubscribe: {
						const { rpcId, queueId, ownerToken, generation, requestId, rootTaskId } = command.data
						if (
							!this.queueLease ||
							this.queueLease.queueId !== queueId ||
							this.queueLease.ownerToken !== ownerToken
						) {
							sendQueueRpcResponse(
								rpcId,
								command.commandName,
								false,
								undefined,
								"Lease ownership mismatch",
							)
							break
						}

						const dispatch =
							(rootTaskId ? this.queueDispatches.get(rootTaskId) : undefined) ||
							(requestId ? this.queueDispatches.get(requestId) : undefined)
						const currentTask = this.sidebarProvider.getCurrentTask()

						if (dispatch) {
							if (generation !== undefined && dispatch.generation !== generation) {
								sendQueueRpcResponse(
									rpcId,
									command.commandName,
									false,
									undefined,
									"Generation mismatch",
								)
								break
							}
							if (rootTaskId && dispatch.rootTaskId && dispatch.rootTaskId !== rootTaskId) {
								sendQueueRpcResponse(rpcId, command.commandName, false, undefined, "Root task mismatch")
								break
							}

							sendQueueRpcResponse(rpcId, command.commandName, true, {
								scope: {
									queueId: dispatch.queueId,
									generation: dispatch.generation,
									requestId: dispatch.requestId,
									rootTaskId: dispatch.rootTaskId || null,
									mode: dispatch.mode,
								},
								found: true,
								sequence: dispatch.sequence,
								runtimeState: dispatch.terminalState ?? (currentTask ? "running" : "idle"),
								ownershipReleased: dispatch.ownershipReleased,
								accepted: dispatch.accepted,
								result: dispatch.result ?? null,
								activeTaskId: dispatch.activeTaskId ?? currentTask?.taskId ?? null,
								orderedEdges: dispatch.orderedEdges ?? [],
							})
						} else {
							sendQueueRpcResponse(rpcId, command.commandName, true, {
								scope: {
									queueId,
									generation: generation ?? 0,
									requestId: requestId ?? "",
									rootTaskId: rootTaskId ?? null,
									mode: "",
								},
								found: false,
								sequence: 0,
								runtimeState: currentTask ? "running" : "idle",
								ownershipReleased: false,
								accepted: false,
								result: null,
								activeTaskId: currentTask?.taskId ?? null,
								orderedEdges: [],
							})
						}
						break
					}

					case TaskCommandName.QueueAcceptCompletion: {
						const { rpcId, queueId, ownerToken, generation, requestId, rootTaskId, result } = command.data
						if (
							!this.queueLease ||
							this.queueLease.queueId !== queueId ||
							this.queueLease.ownerToken !== ownerToken
						) {
							sendQueueRpcResponse(
								rpcId,
								command.commandName,
								false,
								undefined,
								"Lease ownership mismatch",
							)
							break
						}

						const dispatch = this.queueDispatches.get(rootTaskId)
						if (
							!dispatch ||
							dispatch.queueId !== queueId ||
							dispatch.generation !== generation ||
							dispatch.requestId !== requestId ||
							dispatch.rootTaskId !== rootTaskId
						) {
							sendQueueRpcResponse(
								rpcId,
								command.commandName,
								false,
								undefined,
								"Target task not found or dispatch identity mismatch",
							)
							break
						}

						let parsedClientResult: QueueResult
						try {
							if (typeof result === "string") {
								parsedClientResult = parseQueueResultText(result)
							} else {
								parsedClientResult = result as QueueResult
							}
						} catch (err) {
							const errMsg = err instanceof Error ? err.message : String(err)
							sendQueueRpcResponse(
								rpcId,
								command.commandName,
								false,
								undefined,
								`Malformed acceptance result: ${errMsg}`,
							)
							break
						}

						if (dispatch.accepted) {
							if (
								dispatch.parsedResult &&
								areQueueResultsEqual(dispatch.parsedResult, parsedClientResult)
							) {
								sendQueueRpcResponse(rpcId, command.commandName, true, {
									accepted: true,
									taskId: rootTaskId,
								})
								break
							} else {
								sendQueueRpcResponse(
									rpcId,
									command.commandName,
									false,
									undefined,
									"Conflicting result on already accepted task",
								)
								break
							}
						}

						if (!dispatch.result || !dispatch.parsedResult) {
							sendQueueRpcResponse(
								rpcId,
								command.commandName,
								false,
								undefined,
								"No validated completion result available for acceptance",
							)
							break
						}

						if (!areQueueResultsEqual(dispatch.parsedResult, parsedClientResult)) {
							sendQueueRpcResponse(
								rpcId,
								command.commandName,
								false,
								undefined,
								"Acceptance result does not match retained root result",
							)
							break
						}

						const currentTask = this.sidebarProvider.getCurrentTask()
						if (!currentTask || currentTask.taskId !== rootTaskId) {
							sendQueueRpcResponse(
								rpcId,
								command.commandName,
								false,
								undefined,
								"Owned root task is not the active task instance",
							)
							break
						}

						const lastMsg = currentTask.clineMessages ? currentTask.clineMessages.at(-1) : undefined
						const isPendingCompletion =
							(dispatch.promptReady ||
								(lastMsg?.type === "ask" && lastMsg?.ask === "completion_result") ||
								typeof currentTask.approveAsk === "function") &&
							!lastMsg?.isAnswered &&
							lastMsg?.ask !== "tool" &&
							lastMsg?.ask !== "command" &&
							lastMsg?.ask !== "followup"

						if (!isPendingCompletion) {
							sendQueueRpcResponse(
								rpcId,
								command.commandName,
								false,
								undefined,
								"Task is not awaiting completion confirmation",
							)
							break
						}

						try {
							await this.approveCurrentAsk()
							dispatch.accepted = true
							dispatch.promptReady = false
							this.emitQueueEvent(dispatch, QueueEventName.Acceptance, {
								taskId: rootTaskId,
								accepted: true,
							})
							sendQueueRpcResponse(rpcId, command.commandName, true, {
								accepted: true,
								taskId: rootTaskId,
							})
						} catch (error) {
							const errMsg = error instanceof Error ? error.message : String(error)
							sendQueueRpcResponse(rpcId, command.commandName, false, undefined, errMsg)
						}
						break
					}

					case TaskCommandName.QueueReleaseLease: {
						const { rpcId, queueId, ownerToken } = command.data
						if (
							!this.queueLease ||
							this.queueLease.queueId !== queueId ||
							this.queueLease.ownerToken !== ownerToken
						) {
							sendQueueRpcResponse(
								rpcId,
								command.commandName,
								false,
								undefined,
								"Lease ownership mismatch",
							)
							break
						}

						const activeDispatches = Array.from(new Set(this.queueDispatches.values())).filter(
							(d) => d.queueId === queueId && (!d.terminalState || !d.ownershipReleased),
						)
						if (activeDispatches.length > 0) {
							sendQueueRpcResponse(
								rpcId,
								command.commandName,
								false,
								undefined,
								"Cannot release lease while execution cleanup is pending",
							)
							break
						}

						this.queueLease = undefined
						sendQueueRpcResponse(rpcId, command.commandName, true, { released: true })
						break
					}

					case TaskCommandName.QueueCancelTask: {
						const { rpcId, queueId, ownerToken, generation, requestId, rootTaskId } = command.data
						if (
							!this.queueLease ||
							this.queueLease.queueId !== queueId ||
							this.queueLease.ownerToken !== ownerToken
						) {
							sendQueueRpcResponse(
								rpcId,
								command.commandName,
								false,
								undefined,
								"Lease ownership mismatch",
							)
							break
						}

						const dispatch = this.queueDispatches.get(rootTaskId)
						if (
							!dispatch ||
							dispatch.queueId !== queueId ||
							(generation !== undefined && dispatch.generation !== generation) ||
							(requestId !== undefined && dispatch.requestId !== requestId) ||
							dispatch.rootTaskId !== rootTaskId
						) {
							sendQueueRpcResponse(
								rpcId,
								command.commandName,
								false,
								undefined,
								"Target task not found or dispatch identity mismatch",
							)
							break
						}

						const currentTask = this.sidebarProvider.getCurrentTask()
						if (
							currentTask &&
							(currentTask.taskId === rootTaskId || dispatch.activeTaskId === currentTask.taskId)
						) {
							await this.cancelCurrentTask()
							dispatch.rootTaskAborted = true
							dispatch.terminalState = "aborted"
							if (dispatch.orderedEdges) {
								for (const edge of dispatch.orderedEdges) {
									edge.active = false
								}
							}
							dispatch.fenceActive = true
							dispatch.ownershipReleased = true
							this.emitQueueEvent(dispatch, QueueEventName.Terminal, {
								taskId: rootTaskId,
								runtimeState: "aborted",
								ownershipReleased: true,
							})
							sendQueueRpcResponse(rpcId, command.commandName, true, {
								cancelled: true,
								taskId: rootTaskId,
							})
						} else {
							sendQueueRpcResponse(
								rpcId,
								command.commandName,
								false,
								undefined,
								"Task not currently active",
							)
						}
						break
					}
				}
			})
		}
	}

	private emitQueueEvent(dispatch: QueueDispatchRecord, eventName: QueueEventName, payload: Record<string, unknown>) {
		dispatch.sequence += 1
		const queueEvent: QueueEvent = {
			queueId: dispatch.queueId,
			generation: dispatch.generation,
			requestId: dispatch.requestId,
			rootTaskId: dispatch.rootTaskId,
			mode: dispatch.mode,
			sequence: dispatch.sequence,
			eventName,
			payload,
		}
		this.ipc?.broadcast({
			type: IpcMessageType.QueueEvent,
			origin: IpcOrigin.Server,
			data: queueEvent,
		})
	}

	public override emit<K extends keyof RooCodeEvents>(
		eventName: K,
		...args: K extends keyof RooCodeEvents ? RooCodeEvents[K] : never
	) {
		const data = { eventName: eventName as RooCodeEventName, payload: args } as TaskEvent
		this.ipc?.broadcast({ type: IpcMessageType.TaskEvent, origin: IpcOrigin.Server, data })
		return super.emit(eventName, ...args)
	}

	public async startNewTask({
		configuration,
		text,
		images,
		newTab,
	}: {
		configuration: RooCodeSettings
		text?: string
		images?: string[]
		newTab?: boolean
	}) {
		let provider: ClineProvider

		if (newTab) {
			await vscode.commands.executeCommand("workbench.action.files.revert")
			await vscode.commands.executeCommand("workbench.action.closeAllEditors")

			provider = await openClineInNewTab({ context: this.context, outputChannel: this.outputChannel })
			this.registerListeners(provider)
		} else {
			await vscode.commands.executeCommand(`${Package.name}.SidebarProvider.focus`)

			provider = this.sidebarProvider
		}

		await provider.evictCurrentTask()
		await provider.postStateToWebview()
		await provider.postMessageToWebview({ type: "action", action: "chatButtonClicked" })
		await provider.postMessageToWebview({ type: "invoke", invoke: "newChat", text, images })

		const options: CreateTaskOptions = {
			consecutiveMistakeLimit: Number.MAX_SAFE_INTEGER,
		}

		const task = await provider.createTask(text, images, undefined, options, configuration)

		if (!task) {
			throw new Error("Failed to create task due to policy restrictions")
		}

		return task.taskId
	}

	public async resumeTask(taskId: string): Promise<void> {
		await vscode.commands.executeCommand(`${Package.name}.SidebarProvider.focus`)
		await this.waitForWebviewLaunch(5_000)

		const { historyItem } = await this.sidebarProvider.getTaskWithId(taskId)
		await this.sidebarProvider.createTaskWithHistoryItem(historyItem)

		if (this.sidebarProvider.viewLaunched) {
			await this.sidebarProvider.postMessageToWebview({ type: "action", action: "chatButtonClicked" })
		} else {
			this.log(
				`[API#resumeTask] webview not launched after resume for task ${taskId}; continuing in headless mode`,
			)
		}
	}

	public async isTaskInHistory(taskId: string): Promise<boolean> {
		try {
			await this.sidebarProvider.getTaskWithId(taskId)
			return true
		} catch {
			return false
		}
	}

	public async getTaskHistoryItem(taskId: string) {
		const item = this.sidebarProvider.taskHistoryStore.get(taskId)
		return item ? structuredClone(item) : undefined
	}

	public async getTaskApiConversationHistoryLength(taskId: string): Promise<number> {
		try {
			const { apiConversationHistory } = await this.sidebarProvider.getTaskWithId(taskId)
			return apiConversationHistory.length
		} catch {
			return 0
		}
	}

	public getCurrentTaskStack() {
		return this.sidebarProvider.getCurrentTaskStack()
	}

	public async clearCurrentTask(_lastMessage?: string) {
		// Legacy finishSubTask removed; clear current by closing active task instance.
		await this.sidebarProvider.evictCurrentTask()
		await this.sidebarProvider.postStateToWebview()
	}

	public async cancelCurrentTask() {
		await this.sidebarProvider.cancelTask()
	}

	public async abandonSubtask(childTaskId: string): Promise<boolean> {
		return this.sidebarProvider.abandonSubtask(childTaskId)
	}

	public async sendMessage(text?: string, images?: string[]) {
		const currentTask = this.sidebarProvider.getCurrentTask()

		// In headless/sandbox flows the webview may not be launched, so routing
		// through invoke=sendMessage drops the message. Deliver directly to the
		// task ask-response channel instead.
		if (!this.sidebarProvider.viewLaunched) {
			if (!currentTask) {
				this.log("[API#sendMessage] no current task in headless mode; message dropped")
				return
			}

			await currentTask.submitUserMessage(text ?? "", images)
			return
		}

		await this.sidebarProvider.postMessageToWebview({ type: "invoke", invoke: "sendMessage", text, images })
	}

	public deleteQueuedMessage(messageId: string) {
		const currentTask = this.sidebarProvider.getCurrentTask()

		if (!currentTask) {
			this.log(`[API#deleteQueuedMessage] no current task; ignoring delete for messageId ${messageId}`)
			return
		}

		currentTask.messageQueueService.removeMessage(messageId)
	}

	public async pressPrimaryButton() {
		await this.sidebarProvider.postMessageToWebview({ type: "invoke", invoke: "primaryButtonClick" })
	}

	public async pressSecondaryButton() {
		await this.sidebarProvider.postMessageToWebview({ type: "invoke", invoke: "secondaryButtonClick" })
	}

	public async approveCurrentAsk() {
		this.sidebarProvider.getCurrentTask()?.approveAsk()
	}

	public isReady() {
		return this.sidebarProvider.viewLaunched
	}

	public captureWebviewThemeFixture(): Promise<WebviewThemeFixture> {
		return this.sidebarProvider.requestWebviewThemeFixture()
	}

	public getLatestAnnouncementId(): string {
		return this.sidebarProvider.latestAnnouncementId
	}

	private async waitForWebviewLaunch(timeoutMs: number): Promise<boolean> {
		try {
			await pWaitFor(() => this.sidebarProvider.viewLaunched, {
				timeout: timeoutMs,
				interval: 50,
			})

			return true
		} catch {
			this.log(`[API#waitForWebviewLaunch] webview did not launch within ${timeoutMs}ms`)
			return false
		}
	}

	private registerListeners(provider: ClineProvider) {
		provider.on(RooCodeEventName.TaskCreated, (task) => {
			if (this.pendingDispatch && !this.pendingDispatch.rootTaskId) {
				this.pendingDispatch.rootTaskId = task.taskId
				this.pendingDispatch.activeTaskId = task.taskId
				this.queueDispatches.set(task.taskId, this.pendingDispatch)
				this.pendingDispatch = undefined
			}

			// Task Lifecycle

			task.on(RooCodeEventName.TaskStarted, async () => {
				this.emit(RooCodeEventName.TaskStarted, task.taskId)
				await this.fileLog(`[${new Date().toISOString()}] taskStarted -> ${task.taskId}\n`)

				const dispatch = this.queueDispatches.get(task.taskId)
				if (dispatch && !dispatch.fenceActive) {
					this.emitQueueEvent(dispatch, QueueEventName.Progress, { taskId: task.taskId })
				}
			})

			task.on(RooCodeEventName.TaskCompleted, async (_, tokenUsage, toolUsage) => {
				this.emit(RooCodeEventName.TaskCompleted, task.taskId, tokenUsage, toolUsage, {
					isSubtask: !!task.parentTaskId,
				})

				await this.fileLog(
					`[${new Date().toISOString()}] taskCompleted -> ${task.taskId} | ${JSON.stringify(tokenUsage, null, 2)} | ${JSON.stringify(toolUsage, null, 2)}\n`,
				)

				const dispatch = this.queueDispatches.get(task.taskId)
				if (dispatch && (!task.parentTaskId || task.taskId === dispatch.rootTaskId)) {
					dispatch.rootTaskCompleted = true
					dispatch.terminalState = "completed"
					const hasActiveDescendants = dispatch.orderedEdges?.some((e) => e.active)
					if (hasActiveDescendants) {
						dispatch.ownershipReleased = false
						this.emitQueueEvent(dispatch, QueueEventName.Terminal, {
							taskId: task.taskId,
							runtimeState: "completed",
							ownershipReleased: false,
						})
					} else {
						dispatch.fenceActive = true
						dispatch.ownershipReleased = true
						this.emitQueueEvent(dispatch, QueueEventName.Terminal, {
							taskId: task.taskId,
							runtimeState: "completed",
							ownershipReleased: true,
						})
					}
				}
			})

			task.on(RooCodeEventName.TaskAborted, (reason) => {
				if (reason) {
					this.emit(RooCodeEventName.TaskAborted, task.taskId, reason)
				} else {
					this.emit(RooCodeEventName.TaskAborted, task.taskId)
				}

				if (reason === "delegation_disposal") {
					this.log(`[queue] delegation disposal retained ownership for ${task.taskId}`)
					return
				}

				const dispatch = this.queueDispatches.get(task.taskId)
				if (dispatch && (!task.parentTaskId || task.taskId === dispatch.rootTaskId)) {
					dispatch.rootTaskAborted = true
					dispatch.terminalState = "aborted"
					const hasActiveDescendants = dispatch.orderedEdges?.some((e) => e.active)
					if (hasActiveDescendants) {
						dispatch.ownershipReleased = false
						this.emitQueueEvent(dispatch, QueueEventName.Terminal, {
							taskId: task.taskId,
							runtimeState: "aborted",
							ownershipReleased: false,
						})
					} else {
						dispatch.fenceActive = true
						dispatch.ownershipReleased = true
						this.emitQueueEvent(dispatch, QueueEventName.Terminal, {
							taskId: task.taskId,
							runtimeState: "aborted",
							ownershipReleased: true,
						})
					}
				}
			})

			task.on(RooCodeEventName.TaskFocused, () => {
				this.emit(RooCodeEventName.TaskFocused, task.taskId)
			})

			task.on(RooCodeEventName.TaskUnfocused, () => {
				this.emit(RooCodeEventName.TaskUnfocused, task.taskId)
			})

			task.on(RooCodeEventName.TaskActive, () => {
				this.emit(RooCodeEventName.TaskActive, task.taskId)
			})

			task.on(RooCodeEventName.TaskInteractive, () => {
				this.emit(RooCodeEventName.TaskInteractive, task.taskId)
			})

			task.on(RooCodeEventName.TaskResumable, () => {
				this.emit(RooCodeEventName.TaskResumable, task.taskId)
			})

			task.on(RooCodeEventName.TaskIdle, () => {
				this.emit(RooCodeEventName.TaskIdle, task.taskId)
			})

			// Subtask Lifecycle

			task.on(RooCodeEventName.TaskPaused, () => {
				this.emit(RooCodeEventName.TaskPaused, task.taskId)
			})

			task.on(RooCodeEventName.TaskUnpaused, () => {
				this.emit(RooCodeEventName.TaskUnpaused, task.taskId)
			})

			task.on(RooCodeEventName.TaskSpawned, (childTaskId) => {
				this.emit(RooCodeEventName.TaskSpawned, task.taskId, childTaskId)

				const dispatch = this.queueDispatches.get(task.taskId)
				if (dispatch) {
					this.queueDispatches.set(childTaskId, dispatch)
				}
			})

			// Task Execution

			task.on(RooCodeEventName.Message, async (message) => {
				this.emit(RooCodeEventName.Message, { taskId: task.taskId, ...message })

				if (message.message.partial !== true) {
					await this.fileLog(`[${new Date().toISOString()}] ${JSON.stringify(message.message, null, 2)}\n`)
				}

				const dispatch = this.queueDispatches.get(task.taskId)
				if (dispatch) {
					if (dispatch.fenceActive) {
						return
					}
					const msg = message.message
					if (task.taskId === dispatch.rootTaskId) {
						if (msg.type === "say" && msg.say === "completion_result") {
							const text = msg.text ?? ""
							const partial = Boolean(msg.partial)
							if (partial) {
								this.emitQueueEvent(dispatch, QueueEventName.Result, {
									taskId: task.taskId,
									text,
									partial: true,
								})
							} else {
								try {
									const parsed = parseQueueResultText(text)
									if (dispatch.parsedResult) {
										if (!areQueueResultsEqual(dispatch.parsedResult, parsed)) {
											dispatch.terminalState = "failed"
											dispatch.promptReady = false
											this.emitQueueEvent(dispatch, QueueEventName.Terminal, {
												taskId: task.taskId,
												runtimeState: "failed",
												ownershipReleased: false,
											})
											return
										}
									} else {
										dispatch.result = text
										dispatch.parsedResult = parsed
									}
									this.emitQueueEvent(dispatch, QueueEventName.Result, {
										taskId: task.taskId,
										text,
										partial: false,
									})
								} catch (err) {
									this.emitQueueEvent(dispatch, QueueEventName.Result, {
										taskId: task.taskId,
										text,
										partial: false,
									})
								}
							}
						} else if (msg.type === "ask" && msg.ask === "completion_result") {
							if (!msg.partial) {
								dispatch.promptReady = true
							}
							this.emitQueueEvent(dispatch, QueueEventName.Progress, { taskId: task.taskId })
						} else {
							if (msg.type === "ask") {
								dispatch.promptReady = false
							}
							this.emitQueueEvent(dispatch, QueueEventName.Progress, { taskId: task.taskId })
						}
					} else {
						this.emitQueueEvent(dispatch, QueueEventName.Progress, { taskId: task.taskId })
					}
				}
			})

			task.on(RooCodeEventName.TaskModeSwitched, (taskId, mode) => {
				this.emit(RooCodeEventName.TaskModeSwitched, taskId, mode)
			})

			task.on(RooCodeEventName.TaskAskResponded, () => {
				this.emit(RooCodeEventName.TaskAskResponded, task.taskId)
			})

			task.on(RooCodeEventName.QueuedMessagesUpdated, (taskId, messages) => {
				this.emit(RooCodeEventName.QueuedMessagesUpdated, taskId, messages)
			})

			// Task Analytics

			task.on(RooCodeEventName.TaskToolFailed, (taskId, tool, error) => {
				this.emit(RooCodeEventName.TaskToolFailed, taskId, tool, error)
			})

			task.on(RooCodeEventName.TaskTokenUsageUpdated, (_, tokenUsage, toolUsage) => {
				this.emit(RooCodeEventName.TaskTokenUsageUpdated, task.taskId, tokenUsage, toolUsage)

				const dispatch = this.queueDispatches.get(task.taskId)
				if (dispatch && !dispatch.fenceActive) {
					this.emitQueueEvent(dispatch, QueueEventName.Progress, { taskId: task.taskId })
				}
			})

			// Let's go!

			this.emit(RooCodeEventName.TaskCreated, task.taskId)
		})

		// Delegation events are emitted by the provider, not by individual task instances.
		provider.on(RooCodeEventName.TaskDelegated, (parentTaskId, childTaskId, transition) => {
			if (transition !== undefined) {
				this.emit(RooCodeEventName.TaskDelegated, parentTaskId, childTaskId, transition)
			} else {
				this.emit(RooCodeEventName.TaskDelegated, parentTaskId, childTaskId)
			}

			const dispatch = this.queueDispatches.get(parentTaskId)
			if (dispatch && !dispatch.fenceActive) {
				this.queueDispatches.set(childTaskId, dispatch)
				dispatch.activeTaskId = childTaskId
				if (!dispatch.orderedEdges) {
					dispatch.orderedEdges = []
				}
				const trans = typeof transition === "number" ? transition : 1
				const existing = dispatch.orderedEdges.find((e) => e.child === childTaskId)
				if (existing) {
					if (trans >= existing.transition) {
						existing.active = true
						existing.transition = trans
					}
				} else {
					dispatch.orderedEdges.push({
						parent: parentTaskId,
						child: childTaskId,
						transition: trans,
						active: true,
					})
				}
				this.emitQueueEvent(dispatch, QueueEventName.Delegated, {
					parent: parentTaskId,
					child: childTaskId,
					transition: trans,
				})
			}
		})
		provider.on(RooCodeEventName.TaskDelegationCompleted, (parentTaskId, childTaskId, summary, transition) => {
			if (transition !== undefined) {
				this.emit(RooCodeEventName.TaskDelegationCompleted, parentTaskId, childTaskId, summary, transition)
			} else {
				this.emit(RooCodeEventName.TaskDelegationCompleted, parentTaskId, childTaskId, summary)
			}

			const dispatch = this.queueDispatches.get(parentTaskId) || this.queueDispatches.get(childTaskId)
			if (dispatch && !dispatch.fenceActive) {
				const trans = typeof transition === "number" ? transition : 1
				if (dispatch.orderedEdges) {
					const edge = dispatch.orderedEdges.find((e) => e.child === childTaskId && e.parent === parentTaskId)
					if (edge && trans < edge.transition) {
						return
					}
					const retired = new Set<string>([childTaskId])
					for (const e of dispatch.orderedEdges) {
						if (e.child === childTaskId || retired.has(e.parent)) {
							e.active = false
							retired.add(e.child)
						}
					}
				}
				dispatch.activeTaskId = parentTaskId
				const payload: Record<string, unknown> = {
					parent: parentTaskId,
					child: childTaskId,
					transition: trans,
				}
				if (summary !== undefined) {
					payload.summary = summary
				}
				this.emitQueueEvent(dispatch, QueueEventName.DelegationCompleted, payload)

				if ((dispatch.rootTaskCompleted || dispatch.rootTaskAborted) && !dispatch.ownershipReleased) {
					const hasActiveDescendants = dispatch.orderedEdges?.some((e) => e.active)
					if (!hasActiveDescendants) {
						dispatch.fenceActive = true
						dispatch.ownershipReleased = true
						this.emitQueueEvent(dispatch, QueueEventName.Terminal, {
							taskId: dispatch.rootTaskId,
							runtimeState: dispatch.terminalState || "completed",
							ownershipReleased: true,
						})
					}
				}
			}
		})
		provider.on(RooCodeEventName.TaskDelegationResumed, (parentTaskId, childTaskId, transition) => {
			if (transition !== undefined) {
				this.emit(RooCodeEventName.TaskDelegationResumed, parentTaskId, childTaskId, transition)
			} else {
				this.emit(RooCodeEventName.TaskDelegationResumed, parentTaskId, childTaskId)
			}

			const dispatch = this.queueDispatches.get(parentTaskId) || this.queueDispatches.get(childTaskId)
			if (dispatch && !dispatch.fenceActive) {
				const trans = typeof transition === "number" ? transition : 1
				this.emitQueueEvent(dispatch, QueueEventName.DelegationResumed, {
					parent: parentTaskId,
					child: childTaskId,
					transition: trans,
				})
			}
		})
		provider.on(RooCodeEventName.TaskResumeScheduled, (parentTaskId, childTaskId, ok, transition) => {
			if (transition !== undefined) {
				this.emit(RooCodeEventName.TaskResumeScheduled, parentTaskId, childTaskId, ok, transition)
			} else {
				this.emit(RooCodeEventName.TaskResumeScheduled, parentTaskId, childTaskId, ok)
			}

			const dispatch = this.queueDispatches.get(parentTaskId) || this.queueDispatches.get(childTaskId)
			if (dispatch && !dispatch.fenceActive) {
				const trans = typeof transition === "number" ? transition : 1
				if (dispatch.orderedEdges) {
					const edge = dispatch.orderedEdges.find((e) => e.child === childTaskId && e.parent === parentTaskId)
					if (edge && trans < edge.transition) {
						return
					}
					const retired = new Set<string>([childTaskId])
					for (const e of dispatch.orderedEdges) {
						if (e.child === childTaskId || retired.has(e.parent)) {
							e.active = false
							retired.add(e.child)
						}
					}
				}
				dispatch.activeTaskId = parentTaskId
				this.emitQueueEvent(dispatch, QueueEventName.ResumeScheduled, {
					parent: parentTaskId,
					child: childTaskId,
					ok: Boolean(ok),
					transition: trans,
				})

				if ((dispatch.rootTaskCompleted || dispatch.rootTaskAborted) && !dispatch.ownershipReleased) {
					const hasActiveDescendants = dispatch.orderedEdges?.some((e) => e.active)
					if (!hasActiveDescendants) {
						dispatch.fenceActive = true
						dispatch.ownershipReleased = true
						this.emitQueueEvent(dispatch, QueueEventName.Terminal, {
							taskId: dispatch.rootTaskId,
							runtimeState: dispatch.terminalState || "completed",
							ownershipReleased: true,
						})
					}
				}
			}
		})
	}
	// Logging

	private outputChannelLog(...args: unknown[]) {
		for (const arg of args) {
			if (arg === null) {
				this.outputChannel.appendLine("null")
			} else if (arg === undefined) {
				this.outputChannel.appendLine("undefined")
			} else if (typeof arg === "string") {
				this.outputChannel.appendLine(arg)
			} else if (arg instanceof Error) {
				this.outputChannel.appendLine(`Error: ${arg.message}\n${arg.stack || ""}`)
			} else {
				try {
					this.outputChannel.appendLine(
						JSON.stringify(
							arg,
							(key, value) => {
								if (typeof value === "bigint") return `BigInt(${value})`
								if (typeof value === "function") return `Function: ${value.name || "anonymous"}`
								if (typeof value === "symbol") return value.toString()
								return value
							},
							2,
						),
					)
				} catch (error) {
					this.outputChannel.appendLine(`[Non-serializable object: ${Object.prototype.toString.call(arg)}]`)
				}
			}
		}
	}

	private async fileLog(message: string) {
		if (!this.logfile) {
			return
		}

		try {
			await fs.appendFile(this.logfile, message, "utf8")
		} catch (_) {
			this.logfile = undefined
		}
	}

	// Global Settings Management

	public getConfiguration(): RooCodeSettings {
		return Object.fromEntries(
			Object.entries(this.sidebarProvider.getValues()).filter(([key]) => !isSecretStateKey(key)),
		)
	}

	public async setConfiguration(values: RooCodeSettings) {
		await this.sidebarProvider.contextProxy.setValues(values)
		await this.sidebarProvider.providerSettingsManager.saveConfig(values.currentApiConfigName || "default", values)
		if (values.modeApiConfigs) {
			await Promise.all(
				Object.entries(values.modeApiConfigs).map(([mode, configId]) =>
					this.sidebarProvider.providerSettingsManager.setModeConfig(mode as Mode, configId),
				),
			)
		}
		await this.sidebarProvider.postStateToWebview()
	}

	public setTerminalProfile(name: string | undefined): void {
		const previousProfile = Terminal.getTerminalProfile()
		Terminal.setTerminalProfile(name)

		if (Terminal.getTerminalProfile() !== previousProfile) {
			TerminalRegistry.closeIdleTerminals()
		}
	}

	// Provider Profile Management

	public getProfiles(): string[] {
		return this.sidebarProvider.getProviderProfileEntries().map(({ name }) => name)
	}

	public getProfileEntry(name: string): ProviderSettingsEntry | undefined {
		return this.sidebarProvider.getProviderProfileEntry(name)
	}

	public async createProfile(name: string, profile?: ProviderSettings, activate: boolean = true) {
		const entry = this.getProfileEntry(name)

		if (entry) {
			throw new Error(`Profile with name "${name}" already exists`)
		}

		const id = await this.sidebarProvider.upsertProviderProfile(name, profile ?? {}, activate)

		if (!id) {
			throw new Error(`Failed to create profile with name "${name}"`)
		}

		return id
	}

	public async updateProfile(
		name: string,
		profile: ProviderSettings,
		activate: boolean = true,
	): Promise<string | undefined> {
		const entry = this.getProfileEntry(name)

		if (!entry) {
			throw new Error(`Profile with name "${name}" does not exist`)
		}

		const id = await this.sidebarProvider.upsertProviderProfile(name, profile, activate)

		if (!id) {
			throw new Error(`Failed to update profile with name "${name}"`)
		}

		return id
	}

	public async upsertProfile(
		name: string,
		profile: ProviderSettings,
		activate: boolean = true,
	): Promise<string | undefined> {
		const id = await this.sidebarProvider.upsertProviderProfile(name, profile, activate)

		if (!id) {
			throw new Error(`Failed to upsert profile with name "${name}"`)
		}

		return id
	}

	public async deleteProfile(name: string): Promise<void> {
		const entry = this.getProfileEntry(name)

		if (!entry) {
			throw new Error(`Profile with name "${name}" does not exist`)
		}

		await this.sidebarProvider.deleteProviderProfile(entry)
	}

	public getActiveProfile(): string | undefined {
		return this.getConfiguration().currentApiConfigName
	}

	public async setActiveProfile(name: string): Promise<string | undefined> {
		const entry = this.getProfileEntry(name)

		if (!entry) {
			throw new Error(`Profile with name "${name}" does not exist`)
		}

		await this.sidebarProvider.activateProviderProfile({ name })
		return this.getActiveProfile()
	}
}
