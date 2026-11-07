// Holder diagnostics: a refused fence acquire names the operation that held the lock, without paths or tokens.
import * as crypto from "crypto"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"

vi.mock("../../../utils/storage", () => ({
	getStorageBasePath: vi.fn().mockImplementation((defaultPath: string) => defaultPath),
}))

import {
	ParentHandoffFence,
	ParentHandoffFenceUnavailableError,
	findParentHandoffFenceUnavailableError,
	type ParentHandoffFenceLease,
} from "../parentHandoffFence"
import {
	OrdinaryPersistenceAuthorityError,
	inIndependentTaskOrchestration,
	withDefaultFenceOperationLabel,
	withFenceOperationLabel,
	withProviderStartExclusion,
} from "../targetPersistenceBoundary"
import { ClineProvider } from "../../webview/ClineProvider"

const keyFor = (id: string) => crypto.createHash("sha256").update(id).digest("hex")
const correlationOf = (token: string) => crypto.createHash("sha256").update(token).digest("hex").slice(0, 16)

let root: string
const leases: ParentHandoffFenceLease[] = []

beforeEach(async () => {
	root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "fence-holder-")))
})

afterEach(async () => {
	for (const lease of leases.splice(0)) await lease.release().catch(() => undefined)
	await fs.rm(root, { recursive: true, force: true })
})

async function hold(label?: string) {
	const lease = await new ParentHandoffFence(root).acquire("parent", label === undefined ? {} : { label })
	leases.push(lease)
	return lease
}

async function refusal(timeoutMs = 0): Promise<ParentHandoffFenceUnavailableError> {
	const error = await new ParentHandoffFence(root).acquire("parent", { timeoutMs, retryIntervalMs: 5 }).then(
		() => undefined,
		(caught: unknown) => caught,
	)
	expect(error).toBeInstanceOf(ParentHandoffFenceUnavailableError)
	if (!(error instanceof ParentHandoffFenceUnavailableError)) throw new Error("expected a fence refusal")
	return error
}

const ownerLabel = async () =>
	(
		JSON.parse(
			await fs.readFile(path.join(root, ".handoff-fences", `${keyFor("parent")}.lock`, "owner.json"), "utf8"),
		) as {
			label?: string
		}
	).label

describe("ParentHandoffFence holder diagnostics", () => {
	it.each([0, 60])(
		"an acquire refused after %i ms names the labeled holder and keeps message and reason unchanged",
		async (timeoutMs) => {
			const holder = await hold("task.usage_drain")

			const error = await refusal(timeoutMs)

			expect(error.message).toBe("Parent handoff fence is unavailable for parent (timeout)")
			expect(error.reason).toBe("timeout")
			expect(error.holder).toEqual({
				label: "task.usage_drain",
				generation: holder.generation,
				ownerCorrelation: correlationOf(holder.ownerToken),
				heldMs: expect.any(Number),
				sameProcess: true,
			})
			const serialized = JSON.stringify(error.holder)
			for (const secret of [root, os.hostname(), holder.ownerToken]) expect(serialized).not.toContain(secret)
		},
	)

	it.each([
		["no label", undefined],
		["an invalid label", "Task Usage/../drain"],
	])("a holder with %s is reported as unlabeled and records no label", async (_name, label) => {
		await hold(label)

		expect(await ownerLabel()).toBeUndefined()
		expect((await refusal()).holder?.label).toBe("unlabeled")
	})

	it("findParentHandoffFenceUnavailableError unwraps originalError wrappers and ignores other errors", async () => {
		await hold("task.answered_ask")
		const error = await refusal()
		const wrapped = new OrdinaryPersistenceAuthorityError(
			"wrapped",
			new OrdinaryPersistenceAuthorityError("inner", error),
		)

		expect(findParentHandoffFenceUnavailableError(wrapped)?.holder?.label).toBe("task.answered_ask")
		expect(findParentHandoffFenceUnavailableError(new Error("other"))).toBeUndefined()
		expect(findParentHandoffFenceUnavailableError(undefined)).toBeUndefined()
	})
})

describe("fence operation labels", () => {
	const labelInside = (wrap: <T>(effect: () => Promise<T>) => Promise<T>) =>
		wrap(() => withProviderStartExclusion(root, "parent", ownerLabel))

	it("records the acquire-site fallback when no label is set", async () => {
		expect(await labelInside((effect) => effect())).toBe("provider_start")
	})

	it("the innermost explicit label wins; a default label keeps a caller's label", async () => {
		expect(
			await labelInside((effect) =>
				withFenceOperationLabel("provider.delegation_handoff", () =>
					withFenceOperationLabel("task.usage_drain", effect),
				),
			),
		).toBe("task.usage_drain")
		expect(
			await labelInside((effect) =>
				withFenceOperationLabel("task.usage_retry", () =>
					withDefaultFenceOperationLabel("task.ui_messages", effect),
				),
			),
		).toBe("task.usage_retry")
		expect(await labelInside((effect) => withDefaultFenceOperationLabel("task.ui_messages", effect))).toBe(
			"task.ui_messages",
		)
	})

	it("independent task orchestration does not inherit its caller's label", async () => {
		expect(
			await labelInside((effect) =>
				withFenceOperationLabel("provider.delegation_handoff", () => inIndependentTaskOrchestration(effect)),
			),
		).toBe("provider_start")
	})
})

describe("delegation diagnostics failure output", () => {
	it("adds the fence reason and holder to an authority refusal", async () => {
		const lines: string[] = []
		const provider = {
			log: (line: string) => lines.push(line),
			contextProxy: { globalStorageUri: { fsPath: root } },
		}
		// Double assertion: createDelegationDiagnostics reads only `log` and the storage path; a real
		// ClineProvider needs a VS Code extension context.
		const diagnostics = ClineProvider.prototype.createDelegationDiagnostics.call(
			provider as unknown as ClineProvider,
			{
				taskId: "parent",
			},
		)
		const holder = await hold("task.usage_drain")

		diagnostics.event("fence_acquire", "failure", await refusal())

		expect(lines).toHaveLength(1)
		const logged = JSON.parse(lines[0].replace("[ordinary_delegation] ", "")) as { failure: unknown }
		expect(logged.failure).toEqual({
			type: "authority_refused",
			reason: "timeout",
			holder: {
				label: "task.usage_drain",
				generation: holder.generation,
				ownerCorrelation: correlationOf(holder.ownerToken),
				heldMs: expect.any(Number),
				sameProcess: true,
			},
		})
	})
})
