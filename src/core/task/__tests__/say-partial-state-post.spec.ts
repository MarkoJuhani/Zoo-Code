// npx vitest run core/task/__tests__/say-partial-state-post.spec.ts
//
// Regression for the ~231 s "processing" hold in the stream loop. A first `reasoning` chunk runs
// `await this.say("reasoning", text, undefined, true)`, which creates a new partial message through
// addToClineMessages(). That awaits provider.postStateToWebviewThrottled(); on the debounce's leading
// edge this runs getStateToPostToWebview() (globalState write, several secret reads) and
// webview.postMessage(), each a renderer round trip. With a background-throttled renderer every
// round trip waits for a one-minute wake-up, so the loop stops reading the provider stream.
// Partial say messages are documented as safe on the throttled path; the stream must not wait for it.

import type { ExtensionState } from "@roo-code/types"

import { Task } from "../Task"

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((r) => {
		resolve = r
	})
	return { promise, resolve }
}

const flushMacrotask = () => new Promise<void>((resolve) => setImmediate(resolve))

type ProviderStub = {
	getState: () => Promise<Partial<ExtensionState>>
	postMessageToWebview: ReturnType<typeof vi.fn>
	postStateToWebviewThrottled: ReturnType<typeof vi.fn>
	flushPostStateToWebviewThrottled: ReturnType<typeof vi.fn>
}

function buildTask(provider: ProviderStub) {
	const task = Object.create(Task.prototype) as Task
	task["abort"] = false
	task["clineMessages"] = []
	task["lastMessageTs"] = undefined
	task["cloudSyncedMessageTimestamps"] = new Set<number>()
	task["saveClineMessages"] = vi.fn(async () => true)
	task["emit"] = vi.fn()
	// Task holds a WeakRef to the provider; only deref() is used on this path.
	task["providerRef"] = { deref: () => provider } as unknown as Task["providerRef"]
	return task
}

describe("Task.say partial message and webview state post", () => {
	it("does not block a new partial reasoning message on the throttled state post", async () => {
		const statePost = deferred<void>()
		const provider: ProviderStub = {
			getState: async () => ({}),
			postMessageToWebview: vi.fn().mockResolvedValue(undefined),
			// Leading-edge debounce call: resolves only when every renderer round trip has answered.
			postStateToWebviewThrottled: vi.fn(() => statePost.promise),
			flushPostStateToWebviewThrottled: vi.fn().mockResolvedValue(undefined),
		}
		const task = buildTask(provider)

		let settled = false
		const said = task.say("reasoning", "thinking", undefined, true).then(() => {
			settled = true
		})

		await vi.waitFor(() => expect(provider.postStateToWebviewThrottled).toHaveBeenCalled())
		await flushMacrotask()

		expect(task["clineMessages"]).toHaveLength(1)
		expect(settled).toBe(true)

		statePost.resolve()
		await said
	})
})
