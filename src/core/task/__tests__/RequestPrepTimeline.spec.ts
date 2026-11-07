// npx vitest run core/task/__tests__/RequestPrepTimeline.spec.ts

import { RequestPrepTimeline } from "../RequestPrepTimeline"

describe("RequestPrepTimeline", () => {
	it("records each phase until finish and ignores later calls", () => {
		let now = 1_000
		const prep = new RequestPrepTimeline(() => now)

		prep.phase("state")
		now += 5
		prep.phase("rateLimit", { userWait: true })
		now += 300
		prep.phase("tools")
		now += 20
		prep.finish()
		now += 1_000
		prep.phase("late")
		prep.finish()

		expect(prep.snapshot()).toEqual({
			totalMs: 325,
			userWaitMs: 300,
			phases: [
				{ name: "state", ms: 5 },
				{ name: "rateLimit", ms: 300 },
				{ name: "tools", ms: 20 },
			],
		})
	})

	it("reports the running phase, including a running deliberate wait", () => {
		let now = 0
		const prep = new RequestPrepTimeline(() => now)

		prep.phase("approvalLimit", { userWait: true })
		now += 7_000

		expect(prep.snapshot()).toEqual({
			totalMs: 7_000,
			userWaitMs: 7_000,
			phases: [],
			current: { name: "approvalLimit", ms: 7_000 },
		})
	})
})
