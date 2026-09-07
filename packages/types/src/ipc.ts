import { z } from "zod"

import { type TaskEvent, taskEventSchema } from "./events.js"
import { rooCodeSettingsSchema } from "./global-settings.js"

/**
 * IpcMessageType
 */

export enum IpcMessageType {
	Connect = "Connect",
	Disconnect = "Disconnect",
	Ack = "Ack",
	TaskCommand = "TaskCommand",
	TaskEvent = "TaskEvent",
	QueueResponse = "QueueResponse",
}

/**
 * IpcOrigin
 */

export enum IpcOrigin {
	Client = "client",
	Server = "server",
}

/**
 * Ack
 */

export const ackSchema = z.object({
	clientId: z.string(),
	pid: z.number(),
	ppid: z.number(),
	queueProtocol: z.number().optional(),
	workspace: z.string().optional(),
	serverInstance: z.string().optional(),
	extensionVersion: z.string().optional(),
	buildRevision: z.string().optional(),
	capabilities: z.array(z.string()).optional(),
})

export type Ack = z.infer<typeof ackSchema>

/**
 * TaskCommandName
 */

export enum TaskCommandName {
	StartNewTask = "StartNewTask",
	CancelTask = "CancelTask",
	CloseTask = "CloseTask",
	ResumeTask = "ResumeTask",
	SendMessage = "SendMessage",
	GetCommands = "GetCommands",
	GetModes = "GetModes",
	GetModels = "GetModels",
	DeleteQueuedMessage = "DeleteQueuedMessage",
	QueueAcquireLease = "QueueAcquireLease",
	QueueStartTask = "QueueStartTask",
	QueueSubscribe = "QueueSubscribe",
	QueueAcceptCompletion = "QueueAcceptCompletion",
	QueueReleaseLease = "QueueReleaseLease",
	QueueCancelTask = "QueueCancelTask",
}

/**
 * TaskCommand
 */

export const taskCommandSchema = z.discriminatedUnion("commandName", [
	z.object({
		commandName: z.literal(TaskCommandName.StartNewTask),
		data: z.object({
			configuration: rooCodeSettingsSchema,
			text: z.string(),
			images: z.array(z.string()).optional(),
			newTab: z.boolean().optional(),
		}),
	}),
	z.object({
		commandName: z.literal(TaskCommandName.CancelTask),
	}),
	z.object({
		commandName: z.literal(TaskCommandName.CloseTask),
	}),
	z.object({
		commandName: z.literal(TaskCommandName.ResumeTask),
		data: z.string(),
	}),
	z.object({
		commandName: z.literal(TaskCommandName.SendMessage),
		data: z.object({
			text: z.string().optional(),
			images: z.array(z.string()).optional(),
		}),
	}),
	z.object({
		commandName: z.literal(TaskCommandName.GetCommands),
	}),
	z.object({
		commandName: z.literal(TaskCommandName.GetModes),
	}),
	z.object({
		commandName: z.literal(TaskCommandName.GetModels),
	}),
	z.object({
		commandName: z.literal(TaskCommandName.DeleteQueuedMessage),
		data: z.string(), // messageId
	}),
	z.object({
		commandName: z.literal(TaskCommandName.QueueAcquireLease),
		data: z.object({
			rpcId: z.string().optional(),
			queueId: z.string(),
			ownerToken: z.string(),
		}),
	}),
	z.object({
		commandName: z.literal(TaskCommandName.QueueStartTask),
		data: z.object({
			rpcId: z.string().optional(),
			queueId: z.string(),
			ownerToken: z.string(),
			generation: z.number(),
			requestId: z.string(),
			rootTaskId: z.string().nullable().optional(),
			mode: z.string(),
			text: z.string(),
			configuration: rooCodeSettingsSchema.optional(),
			images: z.array(z.string()).optional(),
		}),
	}),
	z.object({
		commandName: z.literal(TaskCommandName.QueueSubscribe),
		data: z.object({
			rpcId: z.string().optional(),
			queueId: z.string(),
			ownerToken: z.string(),
			generation: z.number().optional(),
			requestId: z.string().optional(),
			rootTaskId: z.string().nullable().optional(),
		}),
	}),
	z.object({
		commandName: z.literal(TaskCommandName.QueueAcceptCompletion),
		data: z.object({
			rpcId: z.string().optional(),
			queueId: z.string(),
			ownerToken: z.string(),
			generation: z.number(),
			requestId: z.string(),
			rootTaskId: z.string(),
			result: z.string(),
		}),
	}),
	z.object({
		commandName: z.literal(TaskCommandName.QueueReleaseLease),
		data: z.object({
			rpcId: z.string().optional(),
			queueId: z.string(),
			ownerToken: z.string(),
		}),
	}),
	z.object({
		commandName: z.literal(TaskCommandName.QueueCancelTask),
		data: z.object({
			rpcId: z.string().optional(),
			queueId: z.string(),
			ownerToken: z.string(),
			generation: z.number(),
			requestId: z.string(),
			rootTaskId: z.string(),
		}),
	}),
])

export type TaskCommand = z.infer<typeof taskCommandSchema>

/**
 * IpcMessage
 */

export const ipcMessageSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal(IpcMessageType.Ack),
		origin: z.literal(IpcOrigin.Server),
		data: ackSchema,
	}),
	z.object({
		type: z.literal(IpcMessageType.TaskCommand),
		origin: z.literal(IpcOrigin.Client),
		clientId: z.string(),
		data: taskCommandSchema,
	}),
	z.object({
		type: z.literal(IpcMessageType.TaskEvent),
		origin: z.literal(IpcOrigin.Server),
		relayClientId: z.string().optional(),
		data: taskEventSchema,
	}),
	z.object({
		type: z.literal(IpcMessageType.QueueResponse),
		origin: z.literal(IpcOrigin.Server),
		data: z.object({
			rpcId: z.string().optional(),
			commandName: z.string(),
			ok: z.boolean(),
			value: z.unknown().optional(),
			error: z.string().optional(),
		}),
	}),
])

export type IpcMessage = z.infer<typeof ipcMessageSchema>

/**
 * IpcClientEvents
 */

export type IpcClientEvents = {
	[IpcMessageType.Connect]: []
	[IpcMessageType.Disconnect]: []
	[IpcMessageType.Ack]: [data: Ack]
	[IpcMessageType.TaskCommand]: [data: TaskCommand]
	[IpcMessageType.TaskEvent]: [data: TaskEvent]
}

/**
 * IpcServerEvents
 */

export type IpcServerEvents = {
	[IpcMessageType.Connect]: [clientId: string]
	[IpcMessageType.Disconnect]: [clientId: string]
	[IpcMessageType.TaskCommand]: [clientId: string, data: TaskCommand]
	[IpcMessageType.TaskEvent]: [relayClientId: string | undefined, data: TaskEvent]
}
