import { TaskScheduler } from "../TaskScheduler"
import type { Task } from "../Task"

// These are actual scheduler callback effects, NOT child launches or a B1 guard implementation.
describe("B1 scheduler final-effect bypass witnesses", () => {
	it("cancelQueued at admission cannot exclude a subsequently executed callback", async () => {
		const scheduler = new TaskScheduler(1)
		const run = vi.fn(async () => {})
		// Scheduler's production contract uses only abort/abandoned on this minimal non-running fixture.
		const task = { abort: false, abandoned: false } as unknown as Task
		await scheduler.schedule(task, run, (stage) => {
			if (stage === "admitted") scheduler.cancelQueued()
		})
		expect(run).toHaveBeenCalledTimes(1)
	})

	it("paused admitted callback completes after cancellation; unrelated queued work continues", async () => {
		const scheduler = new TaskScheduler(1)
		let release!: () => void
		let arrived!: () => void
		const reached = new Promise<void>((resolve) => {
			arrived = resolve
		})
		const pause = new Promise<void>((resolve) => {
			release = resolve
		})
		const effects: string[] = []
		const task = { abort: false, abandoned: false } as unknown as Task
		const pending = scheduler.schedule(task, async () => {
			arrived()
			await pause
			effects.push("late-parent-effect")
		})
		await reached
		scheduler.cancelQueued()
		release()
		await pending
		await scheduler.schedule(task, async () => {
			effects.push("unrelated")
		})
		expect(effects).toEqual(["late-parent-effect", "unrelated"])
	})
})
