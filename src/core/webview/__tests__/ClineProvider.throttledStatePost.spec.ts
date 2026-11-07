// npx vitest run core/webview/__tests__/ClineProvider.throttledStatePost.spec.ts
//
// A hidden, throttled renderer can hold a state post for minutes. The throttled path must not start
// a new full-state post every debounce window while one is still waiting.

import { ClineProvider } from "../ClineProvider"

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((r) => {
		resolve = r
	})
	return { promise, resolve }
}

function makeProvider(post: () => Promise<void>): ClineProvider {
	// Only the state-post members are used; the constructor's extension wiring is not needed.
	const provider: ClineProvider = Object.create(ClineProvider.prototype)
	provider["_disposed"] = false
	provider["log"] = vi.fn()
	provider.postStateToWebviewWithoutTaskHistory = vi.fn(post)
	return provider
}

describe("ClineProvider throttled state post", () => {
	it("runs one post at a time and coalesces calls made meanwhile into one follow-up post", async () => {
		const posts: Array<ReturnType<typeof deferred>> = []
		const provider = makeProvider(() => {
			const post = deferred()
			posts.push(post)
			return post.promise
		})

		const first = provider["postStateToWebviewOneAtATime"]()
		const second = provider["postStateToWebviewOneAtATime"]()
		const third = provider["postStateToWebviewOneAtATime"]()

		expect(posts).toHaveLength(1)
		expect(second).toBe(third)

		let secondSettled = false
		void second.then(() => {
			secondSettled = true
		})
		posts[0].resolve()
		await first
		await vi.waitFor(() => expect(posts).toHaveLength(2))
		// The follow-up reads the newest state, so callers waiting on it are not released early.
		expect(secondSettled).toBe(false)

		posts[1].resolve()
		await second
		expect(posts).toHaveLength(2)
	})

	it("starts a fresh post once the previous one has finished", async () => {
		const provider = makeProvider(async () => {})

		await provider["postStateToWebviewOneAtATime"]()
		await provider["postStateToWebviewOneAtATime"]()

		expect(provider.postStateToWebviewWithoutTaskHistory).toHaveBeenCalledTimes(2)
	})

	it("logs a failed post and still runs the queued follow-up", async () => {
		const failed = deferred()
		const post = vi
			.fn<() => Promise<void>>()
			.mockImplementationOnce(() => failed.promise.then(() => Promise.reject(new Error("renderer gone"))))
			.mockResolvedValue(undefined)
		const provider = makeProvider(post)

		const first = provider["postStateToWebviewOneAtATime"]()
		const followUp = provider["postStateToWebviewOneAtATime"]()
		failed.resolve()

		await expect(first).resolves.toBeUndefined()
		await expect(followUp).resolves.toBeUndefined()
		expect(post).toHaveBeenCalledTimes(2)
		expect(provider["log"]).toHaveBeenCalledWith(expect.stringContaining("renderer gone"))
	})

	it("does not start a queued follow-up after disposal", async () => {
		const running = deferred()
		const provider = makeProvider(() => running.promise)

		void provider["postStateToWebviewOneAtATime"]()
		const followUp = provider["postStateToWebviewOneAtATime"]()
		provider["_disposed"] = true
		running.resolve()
		await followUp

		expect(provider.postStateToWebviewWithoutTaskHistory).toHaveBeenCalledTimes(1)
	})
})
