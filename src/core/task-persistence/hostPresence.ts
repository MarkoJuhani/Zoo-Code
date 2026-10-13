import crypto from "crypto"
import * as fs from "fs/promises"
import * as fsSync from "fs"
import * as path from "path"

import { currentHolder, holderProvablyExited, isFenceHolder, type FenceHolder } from "./parentHandoffFence"

/**
 * Directory beside `tasks/` where every live TaskHistoryStore publishes one record.
 *
 * Startup delegation repair treats an `active` delegated child as orphaned. That is only true when no
 * other store sharing this storage may be running it: a second window, an F5 development host, or a
 * second provider in this process. Records let a starting store see such peers.
 */
export const HOST_PRESENCE_DIRECTORY = ".host-presence"

interface HostPresenceRecord {
	schemaVersion: 1
	token: string
	publishedAt: number
	/** Absent when this process could not determine its identity; such a peer can never be proven exited. */
	holder?: FenceHolder
}

export interface HostPresence {
	readonly token: string
	/** Best-effort, synchronous so it can run from `dispose()`. A leftover record only makes peers more cautious. */
	release(): void
}

const recordName = (token: string) => `${token}.json`

/**
 * Records this process published and has not released. The sidebar provider (and so its store) is
 * not disposed on shutdown, so without this a normal window close would leave its record behind, and
 * a record whose exit cannot be proven later (for example after a reboot) would block repair.
 */
const ownRecords = new Set<string>()
let exitHookInstalled = false

/** Synchronously remove every record this process still holds. Runs on process exit; idempotent. */
export function releaseAllHostPresence(): void {
	for (const recordPath of ownRecords) {
		try {
			fsSync.rmSync(recordPath, { force: true })
		} catch {
			// Peers then keep treating this record as live until they can prove this process exited.
		}
	}
	ownRecords.clear()
}

/**
 * Publish this store's presence record (temporary file plus rename, so readers never see a partial record).
 * Must run before the store can own a running task, so any later startup repair sees it.
 */
export async function publishHostPresence(root: string): Promise<HostPresence> {
	const directory = path.join(root, HOST_PRESENCE_DIRECTORY)
	await fs.mkdir(directory, { recursive: true })
	const token = crypto.randomUUID()
	const record: HostPresenceRecord = { schemaVersion: 1, token, publishedAt: Date.now() }
	const holder = currentHolder()
	if (holder) record.holder = holder
	const finalPath = path.join(directory, recordName(token))
	const temporaryPath = `${finalPath}.${crypto.randomUUID()}.tmp`
	await fs.writeFile(temporaryPath, JSON.stringify(record), { encoding: "utf8", flag: "wx", mode: 0o600 })
	await fs.rename(temporaryPath, finalPath)
	ownRecords.add(finalPath)
	if (!exitHookInstalled) {
		exitHookInstalled = true
		process.once("exit", releaseAllHostPresence)
	}
	return {
		token,
		release: () => {
			ownRecords.delete(finalPath)
			try {
				fsSync.rmSync(finalPath, { force: true })
			} catch {
				// Peers then keep treating this record as live until they can prove this process exited.
			}
		},
	}
}

function isHostPresenceRecord(value: unknown): value is HostPresenceRecord {
	if (!value || typeof value !== "object") return false
	const record: Partial<Record<keyof HostPresenceRecord, unknown>> = value
	return (
		record.schemaVersion === 1 &&
		typeof record.token === "string" &&
		record.token.length > 0 &&
		typeof record.publishedAt === "number" &&
		(record.holder === undefined || isFenceHolder(record.holder))
	)
}

/**
 * Return the presence record files of peers that may still be alive, excluding `ownToken`.
 *
 * Any doubt counts as alive: an unreadable or malformed record, a record without a holder, or a holder
 * that is not provably exited (another machine, another pid namespace, untrusted /proc). Only records
 * whose holder is provably exited are ignored, and those are removed best-effort. Never decided by age.
 */
export async function findLivePeerHosts(root: string, ownToken: string | undefined): Promise<string[]> {
	const directory = path.join(root, HOST_PRESENCE_DIRECTORY)
	let names: string[]
	try {
		names = await fs.readdir(directory)
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return []
		throw error
	}
	const live: string[] = []
	for (const name of names) {
		// A temporary file belongs to a publisher that has not finished; it cannot own a task yet.
		if (!name.endsWith(".json") || (ownToken !== undefined && name === recordName(ownToken))) continue
		const recordPath = path.join(directory, name)
		let record: unknown
		try {
			record = JSON.parse(await fs.readFile(recordPath, "utf8"))
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue
			live.push(recordPath)
			continue
		}
		if (!isHostPresenceRecord(record) || !record.holder || !holderProvablyExited(record.holder)) {
			live.push(recordPath)
			continue
		}
		await fs.rm(recordPath, { force: true }).catch(() => {
			// A leftover exited record is ignored again by the next reader.
		})
	}
	return live
}
