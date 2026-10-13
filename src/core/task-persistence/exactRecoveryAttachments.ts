import type { RecoveryPayload } from "../../shared/recoveryIntake"

/** The caller retains every source until the fenced blob write and read-back have completed. */
export interface RecoveryAttachmentSource {
	mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp"
	/** Length attested by the original attachment source, before resolution. */
	expectedByteLength: number
	readExactBytes(): Promise<Uint8Array>
}

const maxImageBytes = 8 * 1024 * 1024
const signatures: Record<RecoveryAttachmentSource["mime"], (bytes: Uint8Array) => boolean> = {
	"image/png": (b) => b.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => b[i] === v),
	"image/jpeg": (b) =>
		b.length >= 4 && b[0] === 255 && b[1] === 216 && b[b.length - 2] === 255 && b[b.length - 1] === 217,
	"image/gif": (b) =>
		b.length >= 14 &&
		Buffer.from(b.subarray(0, 6))
			.toString("ascii")
			.match(/^GIF8[79]a$/) !== null,
	"image/webp": (b) =>
		b.length >= 16 &&
		Buffer.from(b.subarray(0, 4)).toString("ascii") === "RIFF" &&
		Buffer.from(b.subarray(8, 12)).toString("ascii") === "WEBP" &&
		Buffer.from(b).readUInt32LE(4) + 8 === b.length,
}

/** All sources resolve in order or none are returned; no skipping, truncation or deduplication. */
export async function resolveExactRecoveryAttachments(
	text: string,
	sources: readonly RecoveryAttachmentSource[],
): Promise<RecoveryPayload> {
	if (
		typeof text !== "string" ||
		Buffer.byteLength(text, "utf8") > 1024 * 1024 ||
		!Array.isArray(sources) ||
		sources.length > 10
	) {
		throw new Error("intake_invalid")
	}
	const images: string[] = []
	let total = 0
	for (const source of sources) {
		if (
			!source ||
			!Object.hasOwn(signatures, source.mime) ||
			!Number.isSafeInteger(source.expectedByteLength) ||
			source.expectedByteLength < 1 ||
			typeof source.readExactBytes !== "function"
		)
			throw new Error("intake_invalid")
		const mime = source.mime as RecoveryAttachmentSource["mime"]
		let bytes: Uint8Array
		try {
			bytes = await source.readExactBytes()
		} catch {
			throw new Error("intake_unavailable")
		}
		if (
			!(bytes instanceof Uint8Array) ||
			bytes.length !== source.expectedByteLength ||
			!signatures[mime](bytes) ||
			bytes.length > maxImageBytes - total
		)
			throw new Error("intake_invalid")
		total += bytes.length
		images.push(`data:${source.mime};base64,${Buffer.from(bytes).toString("base64")}`)
	}
	if (!text && !images.length) throw new Error("intake_invalid")
	return { text, images }
}
