import * as assert from "assert"
import * as net from "node:net"
import { once } from "node:events"
import { RooCodeEventName, type ClineMessage } from "@roo-code/types"
import { TWO_LEVEL_ROOT_PROMPT } from "../fixtures/subtasks"
import { setDefaultSuiteTimeout } from "./test-utils"
import { isCompletedAsk, waitFor, waitUntilCompleted } from "./utils"

type Frame =
	| { type: "Ack"; data: { clientId: string } }
	| { type: "QueueResponse"; data: { rpcId: string; ok: boolean; value: unknown } }
	| { type: "QueueEvent"; data: { eventName: string; payload: { parent: string; child: string } } }

function isFrame<T extends Frame["type"]>(frame: Frame, type: T): frame is Extract<Frame, { type: T }> {
	return frame.type === type
}

async function connectQueue(socketPath: string) {
	const socket = net.connect(socketPath)
	const frames: Frame[] = []
	let buffer = ""
	socket.on("data", (chunk) => {
		buffer += chunk.toString("utf8")
		for (let end = buffer.indexOf("\f"); end !== -1; end = buffer.indexOf("\f")) {
			const raw = buffer.slice(0, end)
			buffer = buffer.slice(end + 1)
			frames.push(JSON.parse(raw).data)
		}
	})
	await once(socket, "connect")
	await waitFor(() => frames.some((frame) => frame.type === "Ack"))
	const clientId = frames.find((frame) => isFrame(frame, "Ack"))!.data.clientId
	let serial = 0
	const rpc = async (commandName: string, data: Record<string, unknown>) => {
		const rpcId = `isolated-${++serial}`
		socket.write(
			JSON.stringify({
				type: "message",
				data: {
					type: "TaskCommand",
					origin: "client",
					clientId,
					data: { commandName, data: { ...data, rpcId } },
				},
			}) + "\f",
		)
		await waitFor(() => frames.some((frame) => frame.type === "QueueResponse" && frame.data.rpcId === rpcId))
		const reply = frames.find(
			(frame): frame is Extract<Frame, { type: "QueueResponse" }> =>
				isFrame(frame, "QueueResponse") && frame.data.rpcId === rpcId,
		)!.data
		assert.strictEqual(reply.ok, true, `${commandName} rejected`)
		return reply.value
	}
	return { socket, rpc, frames }
}

suite("Two-level real extension delegation", function () {
	setDefaultSuiteTimeout(this)
	test("manual root creates grandchild and resumes both parents", async () => {
		const api = globalThis.api
		try {
			const root = await waitUntilCompleted({
				api,
				timeout: 60_000,
				start: () =>
					api.startNewTask({
						configuration: {
							mode: "ask",
							alwaysAllowSubtasks: true,
							autoApprovalEnabled: true,
							enableCheckpoints: false,
						},
						text: TWO_LEVEL_ROOT_PROMPT,
					}),
			})
			const history = await api.getTaskHistoryItem(root)
			assert.strictEqual(history?.childIds?.length, 1)
			const childId = history?.childIds?.[0]
			assert.ok(childId)
			const child = await api.getTaskHistoryItem(childId)
			assert.strictEqual(child?.childIds?.length, 1)
		} finally {
			while (api.getCurrentTaskStack().length) await api.clearCurrentTask()
		}
	})
	test("manual task before queue ownership requires subtask approval", async () => {
		const api = globalThis.api
		const asks: Array<{ taskId: string; message: ClineMessage }> = []
		const handler = (event: { taskId: string; message: ClineMessage }) => {
			if (
				isCompletedAsk(event.message) &&
				event.message.ask === "tool" &&
				event.message.text?.includes('"newTask"')
			)
				asks.push(event)
		}
		api.on(RooCodeEventName.Message, handler)
		try {
			const root = await api.startNewTask({
				configuration: {
					mode: "ask",
					alwaysAllowSubtasks: false,
					autoApprovalEnabled: true,
					enableCheckpoints: false,
				},
				text: TWO_LEVEL_ROOT_PROMPT,
			})
			await waitFor(() => asks.some(({ taskId }) => taskId === root))
			assert.strictEqual((await api.getTaskHistoryItem(root))?.childIds?.length ?? 0, 0)
		} finally {
			api.off(RooCodeEventName.Message, handler)
			while (api.getCurrentTaskStack().length) await api.clearCurrentTask()
		}
	})
	test("queue-owned unattended root creates grandchild and resumes both parents", async () => {
		const api = globalThis.api
		const socketPath = process.env.ROO_CODE_IPC_SOCKET_PATH
		if (!socketPath?.includes("roo-test-user-data-")) throw new Error("test socket must be isolated")
		const { socket, rpc, frames } = await connectQueue(socketPath)
		const queueId = "isolated-two-level",
			ownerToken = "isolated-owner",
			requestId = "isolated-request"
		const asks: Array<{ taskId: string; message: ClineMessage }> = []
		const handler = (event: { taskId: string; message: ClineMessage }) => {
			if (isCompletedAsk(event.message) && event.message.ask === "tool") asks.push(event)
		}
		api.on(RooCodeEventName.Message, handler)
		try {
			await rpc("QueueAcquireLease", { queueId, ownerToken })
			const started = (await rpc("QueueStartTask", {
				queueId,
				ownerToken,
				generation: 1,
				requestId,
				mode: "ask",
				text: TWO_LEVEL_ROOT_PROMPT,
				configuration: { autoApprovalEnabled: true, enableCheckpoints: false, alwaysAllowSubtasks: false },
			})) as { rootTaskId: string }
			const root = started.rootTaskId
			await waitFor(async () => (await api.getTaskHistoryItem(root))?.childIds?.length === 1, { timeout: 30_000 })
			const childId = (await api.getTaskHistoryItem(root))?.childIds?.[0]
			assert.ok(childId)
			await waitFor(async () => (await api.getTaskHistoryItem(childId))?.childIds?.length === 1, {
				timeout: 30_000,
			})
			const child = await api.getTaskHistoryItem(childId)
			assert.strictEqual(child?.childIds?.length, 1)
			const grandchildId = child?.childIds?.[0]
			assert.ok(grandchildId)
			assert.strictEqual(asks.filter(({ message }) => message.text?.includes('"newTask"')).length, 2)
			const delegated = frames.filter(
				(frame) => frame.type === "QueueEvent" && frame.data.eventName === "delegated",
			)
			await waitFor(
				() =>
					delegated.length === 2 ||
					frames.filter((frame) => frame.type === "QueueEvent" && frame.data.eventName === "delegated")
						.length === 2,
			)
			assert.deepStrictEqual(
				frames
					.filter(
						(frame): frame is Extract<Frame, { type: "QueueEvent" }> =>
							isFrame(frame, "QueueEvent") && frame.data.eventName === "delegated",
					)
					.map((frame) => [frame.data.payload.parent, frame.data.payload.child]),
				[
					[root, childId],
					[childId, grandchildId],
				],
			)
			await waitFor(async () => (await api.getTaskHistoryItem(root))?.status === "completed", { timeout: 60_000 })
			assert.strictEqual((await api.getTaskHistoryItem(childId))?.status, "completed")
			const snapshot = (await rpc("QueueSubscribe", {
				queueId,
				ownerToken,
				generation: 1,
				requestId,
				rootTaskId: root,
			})) as { accepted: boolean; orderedEdges: Array<{ parent: string; child: string }> }
			assert.strictEqual(snapshot.accepted, false, "test must not accept queue completion")
			assert.deepStrictEqual(
				snapshot.orderedEdges.map(({ parent, child }) => [parent, child]),
				[
					[root, childId],
					[childId, grandchildId],
				],
			)
		} finally {
			api.off(RooCodeEventName.Message, handler)
			socket.end()
			while (api.getCurrentTaskStack().length) await api.clearCurrentTask()
		}
	})
	test("manual task after queue ownership requires subtask approval", async () => {
		const api = globalThis.api
		const asks: string[] = []
		const handler = ({ taskId, message }: { taskId: string; message: ClineMessage }) => {
			if (isCompletedAsk(message) && message.ask === "tool" && message.text?.includes('"newTask"'))
				asks.push(taskId)
		}
		api.on(RooCodeEventName.Message, handler)
		try {
			const root = await api.startNewTask({
				configuration: {
					mode: "ask",
					alwaysAllowSubtasks: false,
					autoApprovalEnabled: true,
					enableCheckpoints: false,
				},
				text: TWO_LEVEL_ROOT_PROMPT,
			})
			await waitFor(() => asks.includes(root))
			assert.strictEqual((await api.getTaskHistoryItem(root))?.childIds?.length ?? 0, 0)
		} finally {
			api.off(RooCodeEventName.Message, handler)
			while (api.getCurrentTaskStack().length) await api.clearCurrentTask()
		}
	})
})
