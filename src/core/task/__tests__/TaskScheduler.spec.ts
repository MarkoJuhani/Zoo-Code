import { E_CANCELED } from "async-mutex"
import { TaskScheduler } from "../TaskScheduler"
import { type Task } from "../Task"

const stubTask = () => ({}) as unknown as Task

describe("TaskScheduler", () => {
	it("runs a task immediately when a permit is available", async () => {
		const scheduler = new TaskScheduler(1)
		let ran = false
		const stages: string[] = []
		await scheduler.schedule(
			stubTask(),
			async () => {
				ran = true
			},
			(stage) => stages.push(stage),
		)
		expect(ran).toBe(true)
		expect(stages).toEqual(["admitted", "started", "settled"])
	})

	it("queues a second task at maxConcurrency=1 until the first completes", async () => {
		const scheduler = new TaskScheduler(1)
		const order: number[] = []
		let resolveFirst!: () => void

		const first = scheduler.schedule(stubTask(), () => new Promise<void>((res) => (resolveFirst = res)))
		// Give the microtask queue a chance to acquire the permit.
		await Promise.resolve()

		expect(scheduler.waiting).toBe(0)

		const second = scheduler.schedule(stubTask(), async () => {
			order.push(2)
		})
		await Promise.resolve()
		expect(scheduler.waiting).toBe(1)

		order.push(1)
		resolveFirst()
		await first
		await second

		expect(order).toEqual([1, 2])
	})

	it("allows two tasks in parallel at maxConcurrency=2", async () => {
		const scheduler = new TaskScheduler(2)
		const running: number[] = []
		let resolveA: (() => void) | undefined
		let resolveB: (() => void) | undefined

		const a = scheduler.schedule(stubTask(), () => new Promise<void>((res) => (resolveA = res)))
		const b = scheduler.schedule(stubTask(), () => new Promise<void>((res) => (resolveB = res)))

		// Two microtask ticks: one for sem.acquire() in each schedule() call.
		await Promise.resolve()
		await Promise.resolve()

		expect(scheduler.waiting).toBe(0)
		expect(resolveA).toBeDefined()
		expect(resolveB).toBeDefined()
		running.push(1, 2)
		resolveA!()
		resolveB!()
		await Promise.all([a, b])
		expect(running).toEqual([1, 2])
	})

	it("releases the permit even when the run function throws", async () => {
		const scheduler = new TaskScheduler(1)
		const stages: string[] = []
		await expect(
			scheduler.schedule(
				stubTask(),
				async () => {
					throw new Error("boom")
				},
				(stage) => stages.push(stage),
			),
		).rejects.toThrow("boom")
		expect(stages).toEqual(["admitted", "started", "failed"])

		// Permit must have been released — next task should run immediately.
		let ran = false
		await scheduler.schedule(stubTask(), async () => {
			ran = true
		})
		expect(ran).toBe(true)
	})

	it("cancelQueued() rejects waiting tasks without affecting the running one", async () => {
		const scheduler = new TaskScheduler(1)
		let resolveRunning!: () => void
		const running = scheduler.schedule(stubTask(), () => new Promise<void>((res) => (resolveRunning = res)))

		await Promise.resolve()

		const errors: unknown[] = []
		const stages: string[] = []
		const queued = scheduler
			.schedule(
				stubTask(),
				async () => {},
				(stage) => stages.push(stage),
			)
			.catch((e) => errors.push(e))
		await Promise.resolve()

		expect(scheduler.waiting).toBe(1)
		scheduler.cancelQueued()
		expect(scheduler.waiting).toBe(0)

		await queued
		expect(errors).toHaveLength(1)
		expect(stages).toEqual(["cancelled"])

		// Running task is unaffected.
		resolveRunning()
		await expect(running).resolves.toBeUndefined()
	})

	it("skips run() and releases permit when task is aborted before admission", async () => {
		const scheduler = new TaskScheduler(1)
		let resolveFirst!: () => void
		const first = scheduler.schedule(stubTask(), () => new Promise<void>((res) => (resolveFirst = res)))
		await Promise.resolve()

		const abortedTask = { abort: true, abandoned: false } as unknown as Task
		let ran = false
		const stages: string[] = []
		const queued = scheduler.schedule(
			abortedTask,
			async () => {
				ran = true
			},
			(stage) => stages.push(stage),
		)
		await Promise.resolve()
		expect(scheduler.waiting).toBe(1)

		resolveFirst()
		await Promise.all([first, queued])

		expect(ran).toBe(false)
		expect(stages).toEqual(["admitted", "cancelled"])
		// Permit must be released — a subsequent task can run immediately.
		let next = false
		await scheduler.schedule(stubTask(), async () => {
			next = true
		})
		expect(next).toBe(true)
	})

	it("skips run() and releases permit when task is abandoned before admission", async () => {
		const scheduler = new TaskScheduler(1)
		let resolveFirst!: () => void
		const first = scheduler.schedule(stubTask(), () => new Promise<void>((res) => (resolveFirst = res)))
		await Promise.resolve()

		const abandonedTask = { abort: false, abandoned: true } as unknown as Task
		let ran = false
		const queued = scheduler.schedule(abandonedTask, async () => {
			ran = true
		})
		await Promise.resolve()

		resolveFirst()
		await Promise.all([first, queued])

		expect(ran).toBe(false)
	})

	it("defaults to maxConcurrency=1", async () => {
		const scheduler = new TaskScheduler()
		let resolveFirst!: () => void
		const first = scheduler.schedule(stubTask(), () => new Promise<void>((res) => (resolveFirst = res)))
		await Promise.resolve()

		const second = scheduler.schedule(stubTask(), async () => {})
		await Promise.resolve()
		expect(scheduler.waiting).toBe(1)

		resolveFirst()
		await Promise.all([first, second])
	})

	it.each(["admitted", "started", "settled"])("isolates a throwing %s observer on success", async (throwAt) => {
		const scheduler = new TaskScheduler(1)
		const run = vi.fn().mockResolvedValue(undefined)
		const nextRun = vi.fn().mockResolvedValue(undefined)
		const stages: string[] = []
		const first = scheduler.schedule(stubTask(), run, (stage) => {
			stages.push(stage)
			if (stage === throwAt) throw new Error("observer failure")
		})
		const next = scheduler.schedule(stubTask(), nextRun)
		expect(scheduler.waiting).toBe(1)
		await expect(first).resolves.toBeUndefined()
		await expect(next).resolves.toBeUndefined()
		expect(run).toHaveBeenCalledOnce()
		expect(nextRun).toHaveBeenCalledOnce()
		expect(stages).toEqual(["admitted", "started", "settled"])
		expect(scheduler.waiting).toBe(0)
		expect(scheduler["sem"].available).toBe(1)
	})

	it.each(["admitted", "started", "failed"])(
		"preserves the run error when the %s observer throws",
		async (throwAt) => {
			const scheduler = new TaskScheduler(1)
			const runError = new Error("original run failure")
			const run = vi.fn().mockRejectedValue(runError)
			const nextRun = vi.fn().mockResolvedValue(undefined)
			const observe = vi.fn((stage: string) => {
				if (stage === throwAt) throw new Error("observer failure")
			})
			const first = scheduler.schedule(stubTask(), run, observe)
			const next = scheduler.schedule(stubTask(), nextRun)
			expect(scheduler.waiting).toBe(1)
			await expect(first).rejects.toBe(runError)
			await next
			expect(run).toHaveBeenCalledOnce()
			expect(observe.mock.calls.map(([stage]) => stage)).toEqual(["admitted", "started", "failed"])
			expect(observe).toHaveBeenLastCalledWith("failed", runError)
			expect(nextRun).toHaveBeenCalledOnce()
			expect(scheduler["sem"].available).toBe(1)
		},
	)

	it.each([
		{ flag: "abort" as const, throwAt: "admitted" },
		{ flag: "abort" as const, throwAt: "cancelled" },
		{ flag: "abandoned" as const, throwAt: "admitted" },
		{ flag: "abandoned" as const, throwAt: "cancelled" },
	])("releases a queued $flag task when its $throwAt observer throws", async ({ flag, throwAt }) => {
		const scheduler = new TaskScheduler(1)
		let finish!: () => void
		const running = scheduler.schedule(stubTask(), () => new Promise<void>((resolve) => (finish = resolve)))
		await vi.waitFor(() => expect(finish).toBeDefined())
		const task = stubTask()
		const run = vi.fn().mockResolvedValue(undefined)
		const nextRun = vi.fn().mockResolvedValue(undefined)
		const stages: string[] = []
		const cancelled = scheduler.schedule(task, run, (stage) => {
			stages.push(stage)
			if (stage === throwAt) throw new Error("observer failure")
		})
		const next = scheduler.schedule(stubTask(), nextRun)
		expect(scheduler.waiting).toBe(2)
		task[flag] = true
		finish()
		await expect(cancelled).resolves.toBeUndefined()
		await Promise.all([running, next])
		expect(run).not.toHaveBeenCalled()
		expect(stages).toEqual(["admitted", "cancelled"])
		expect(nextRun).toHaveBeenCalledOnce()
		expect(scheduler.waiting).toBe(0)
		expect(scheduler["sem"].available).toBe(1)
	})

	it("preserves acquisition rejection when the cancellation observer throws", async () => {
		const scheduler = new TaskScheduler(1)
		const acquireError = new Error("acquisition failed")
		vi.spyOn(scheduler["sem"], "acquire").mockRejectedValueOnce(acquireError)
		const run = vi.fn().mockResolvedValue(undefined)
		const observe = vi.fn(() => {
			throw new Error("observer failure")
		})
		await expect(scheduler.schedule(stubTask(), run, observe)).rejects.toBe(acquireError)
		expect(observe).toHaveBeenCalledExactlyOnceWith("cancelled", acquireError)
		expect(run).not.toHaveBeenCalled()
		await scheduler.schedule(stubTask(), run)
		expect(run).toHaveBeenCalledOnce()
		expect(scheduler["sem"].available).toBe(1)
	})

	it("preserves queue cancellation and held permits when observers throw", async () => {
		const scheduler = new TaskScheduler(1)
		let finish!: () => void
		const running = scheduler.schedule(stubTask(), () => new Promise<void>((resolve) => (finish = resolve)))
		await vi.waitFor(() => expect(finish).toBeDefined())
		const cancelledRun = vi.fn().mockResolvedValue(undefined)
		const observe = vi.fn(() => {
			throw new Error("observer failure")
		})
		const queued = scheduler.schedule(stubTask(), cancelledRun, observe)
		const rejected = expect(queued).rejects.toBe(E_CANCELED)
		expect(scheduler.waiting).toBe(1)
		scheduler.cancelQueued()
		await rejected
		expect(observe).toHaveBeenCalledExactlyOnceWith("cancelled", E_CANCELED)
		expect(cancelledRun).not.toHaveBeenCalled()
		expect(scheduler.waiting).toBe(0)
		expect(scheduler["sem"].available).toBe(0)
		const nextRun = vi.fn().mockResolvedValue(undefined)
		const next = scheduler.schedule(stubTask(), nextRun)
		expect(scheduler.waiting).toBe(1)
		expect(nextRun).not.toHaveBeenCalled()
		finish()
		await Promise.all([running, next])
		expect(nextRun).toHaveBeenCalledOnce()
		expect(scheduler["sem"].available).toBe(1)
	})
})
