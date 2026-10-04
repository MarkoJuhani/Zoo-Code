import type { ExtensionState } from "@roo-code/types"

import { Task } from "../Task"

// When the backend auto-resolves an interactive ask, isAnswered:true is stamped
// on the ClineMessage before it is added so the webview state snapshot already
// carries the resolved flag. This eliminates the race between showing approval
// buttons and the former separate clearApprovalButtons message.

type ProviderStub = {
	getState: () => Promise<Partial<ExtensionState>>
	postMessageToWebview: ReturnType<typeof vi.fn>
}

function buildTask(provider: ProviderStub | undefined) {
	const task = Object.create(Task.prototype) as Task
	task["abort"] = false
	task["clineMessages"] = []
	task["askResponse"] = undefined
	task["askResponseText"] = undefined
	task["askResponseImages"] = undefined
	task["lastMessageTs"] = undefined
	task["addToClineMessages"] = vi.fn(async () => {})
	task["saveClineMessages"] = vi.fn(async () => true)
	task["updateClineMessage"] = vi.fn(async () => {})
	task["cancelAutoApprovalTimeout"] = vi.fn(() => {})
	task["checkpointSave"] = vi.fn(async () => {})
	task["emit"] = vi.fn()
	task["providerRef"] = { deref: () => provider } as unknown as Task["providerRef"]

	return task
}

async function attachQueue(task: Task) {
	const { MessageQueueService } = await import("../../message-queue/MessageQueueService")
	Object.defineProperty(task, "messageQueueService", { value: new MessageQueueService() })
}

describe("Task.ask auto-approval stamping", () => {
	it("keeps an auto-approved tool ask alive when presenter text arrives before the handler resumes", async () => {
		const task = buildTask({
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			getState: async () => ({
				autoApprovalEnabled: true,
				alwaysAllowExecute: true,
				allowedCommands: ["echo"],
				deniedCommands: [],
			}),
		})
		await attachQueue(task)
		const originalApproveAsk = task.approveAsk.bind(task)
		vi.spyOn(task, "approveAsk").mockImplementation(() => {
			originalApproveAsk()
			void task.say("text", "I will run the tool.", undefined, false, undefined, undefined, {
				isNonInteractive: true,
			})
		})

		const result = await task.ask("command", "echo hi", false)
		expect(result.response).toBe("yesButtonClicked")
		expect(task["lastMessageTs"]).toBe((task["addToClineMessages"] as ReturnType<typeof vi.fn>).mock.calls[0][0].ts)
	})

	it("stamps isAnswered:true on the message when a command ask is auto-approved", async () => {
		const postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		const provider: ProviderStub = {
			postMessageToWebview,
			getState: async () => ({
				autoApprovalEnabled: true,
				alwaysAllowExecute: true,
				allowedCommands: ["echo"],
				deniedCommands: [],
			}),
		}

		const task = buildTask(provider)
		await attachQueue(task)

		const result = await task.ask("command", "echo hi", false)

		expect(result.response).toBe("yesButtonClicked")
		// The message must carry isAnswered:true so the webview never shows buttons.
		const addCall = (task["addToClineMessages"] as ReturnType<typeof vi.fn>).mock.calls[0][0]
		expect(addCall.isAnswered).toBe(true)
		// clearApprovalButtons is no longer sent as a separate message.
		expect(postMessageToWebview).not.toHaveBeenCalledWith({ type: "clearApprovalButtons" })
	})

	it("stamps isAnswered:true on the message when a command ask is auto-denied", async () => {
		const postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		const provider: ProviderStub = {
			postMessageToWebview,
			getState: async () => ({
				autoApprovalEnabled: true,
				alwaysAllowExecute: true,
				allowedCommands: [],
				deniedCommands: ["echo"],
			}),
		}

		const task = buildTask(provider)
		await attachQueue(task)

		const result = await task.ask("command", "echo hi", false)

		expect(result.response).toBe("noButtonClicked")
		const addCall = (task["addToClineMessages"] as ReturnType<typeof vi.fn>).mock.calls[0][0]
		expect(addCall.isAnswered).toBe(true)
		expect(postMessageToWebview).not.toHaveBeenCalledWith({ type: "clearApprovalButtons" })
	})

	it("does not stamp isAnswered when the ask requires a manual decision", async () => {
		const postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		const provider: ProviderStub = {
			postMessageToWebview,
			getState: async () => ({
				autoApprovalEnabled: false,
				alwaysAllowExecute: false,
				allowedCommands: [],
				deniedCommands: [],
			}),
		}

		const task = buildTask(provider)
		await attachQueue(task)

		const askPromise = task.ask("command", "echo hi", false)

		// Simulate the user clicking Run after the buttons are shown.
		setTimeout(() => {
			task.approveAsk()
		}, 0)

		await askPromise

		const addCall = (task["addToClineMessages"] as ReturnType<typeof vi.fn>).mock.calls[0][0]
		expect(addCall.isAnswered).toBeFalsy()
		expect(postMessageToWebview).not.toHaveBeenCalledWith({ type: "clearApprovalButtons" })
	})

	it("does not stamp isAnswered for the followup timeout branch", async () => {
		const postMessageToWebview = vi.fn().mockResolvedValue(undefined)
		const provider: ProviderStub = {
			postMessageToWebview,
			getState: async () => ({
				autoApprovalEnabled: true,
				alwaysAllowFollowupQuestions: true,
				followupAutoApproveTimeoutMs: 60_000,
			}),
		}

		const task = buildTask(provider)
		await attachQueue(task)

		const suggestions = JSON.stringify({ suggest: [{ answer: "yes" }] })
		const askPromise = task.ask("followup", suggestions, false)

		// Resolve the ask before the long timeout fires so the test completes.
		setTimeout(() => {
			task.approveAsk()
		}, 0)

		await askPromise

		const addCall = (task["addToClineMessages"] as ReturnType<typeof vi.fn>).mock.calls[0][0]
		expect(addCall.isAnswered).toBeFalsy()
		expect(postMessageToWebview).not.toHaveBeenCalledWith({ type: "clearApprovalButtons" })
	})
})
