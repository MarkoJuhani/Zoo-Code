import { resolveExactRecoveryAttachments, type RecoveryAttachmentSource } from "../exactRecoveryAttachments"

const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, ...Array(16).fill(0)])
const gif = Uint8Array.from(Buffer.from("GIF89aabcdefgh", "ascii"))
const source = (mime: RecoveryAttachmentSource["mime"], bytes: Uint8Array): RecoveryAttachmentSource => ({
	mime,
	expectedByteLength: bytes.length,
	readExactBytes: async () => bytes,
})

it.each(["early", "late"])("resolves direct/queued %s image-only and mixed in exact order", async () => {
	const sources = [source("image/png", png), source("image/gif", gif), source("image/png", png)]
	for (const text of ["", "hello"]) {
		const payload = await resolveExactRecoveryAttachments(text, sources)
		expect(payload.images).toEqual([
			`data:image/png;base64,${Buffer.from(png).toString("base64")}`,
			`data:image/gif;base64,${Buffer.from(gif).toString("base64")}`,
			`data:image/png;base64,${Buffer.from(png).toString("base64")}`,
		])
		expect(payload.text).toBe(text)
	}
})
it("rejects unreadable, unsupported, malformed, truncated and oversized attachment sets without partial return", async () => {
	const valid = source("image/png", png)
	const bad: RecoveryAttachmentSource[] = [
		{
			mime: "image/png",
			expectedByteLength: 3,
			readExactBytes: async () => {
				throw new Error("private path")
			},
		},
		{ ...source("image/png", png.subarray(0, 8)), expectedByteLength: png.length },
		source("image/jpeg", png),
		source("image/png", new Uint8Array(8 * 1024 * 1024 + 1)),
		{
			mime: "image/svg+xml" as RecoveryAttachmentSource["mime"],
			expectedByteLength: png.length,
			readExactBytes: async () => png,
		},
	]
	for (const item of bad)
		await expect(resolveExactRecoveryAttachments("keep", [valid, item])).rejects.toThrow(
			/^intake_(invalid|unavailable)$/,
		)
	await expect(resolveExactRecoveryAttachments("", [])).rejects.toThrow("intake_invalid")
	await expect(resolveExactRecoveryAttachments("keep", Array(11).fill(valid))).rejects.toThrow("intake_invalid")
})
