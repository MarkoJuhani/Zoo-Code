import type { ApiMessage } from "./apiMessages"
import { readStrictJson } from "./interruptedCreateHandoffDisk"
import { getEffectiveApiHistory } from "../condense"
import {
	classifyManualSupersedeResultIdentity,
	type ManualSupersedeResultIdentityInput,
} from "./manualSupersedeResultIdentity"

/** Read-only restart/error observation. Never appends, retries, repairs metadata or grants readiness. */
export async function observeManualSupersedeB1Readback(
	apiFile: string,
	confirmation: Omit<ManualSupersedeResultIdentityInput, "rawHistory" | "effectiveHistory">,
) {
	const read = await readStrictJson(apiFile, (value): value is ApiMessage[] => Array.isArray(value))
	const history =
		read.kind === "found"
			? { kind: "parsed" as const, value: read.value }
			: { kind: read.kind === "missing" ? ("missing" as const) : ("read_error" as const) }
	let effectiveHistory = history
	try {
		if (read.kind === "found") effectiveHistory = { kind: "parsed", value: getEffectiveApiHistory(read.value) }
	} catch {
		effectiveHistory = { kind: "read_error" }
	}
	const identity = classifyManualSupersedeResultIdentity({ ...confirmation, rawHistory: history, effectiveHistory })
	return {
		disposition: identity.disposition,
		record: identity.classification,
		writeAuthorized: false as const,
		ready: false as const,
		retryAuthorized: false as const,
		identity,
	}
}
