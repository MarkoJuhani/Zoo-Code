import { TaskSemaphore } from "../../utils/TaskSemaphore"
import { type Task } from "./Task"

export type TaskScheduleStage = "admitted" | "cancelled" | "started" | "settled" | "failed"

export interface TaskScheduleObserver {
	(stage: TaskScheduleStage, error?: unknown): void
}

/**
 * Semaphore-based concurrency gate for task execution.
 *
 * Ships at maxConcurrency=1, which is structurally identical to the current
 * serial behavior. Raising maxConcurrency later enables Story 3.2b fan-out
 * without touching the gate logic here.
 */
export class TaskScheduler {
	private readonly sem: TaskSemaphore

	constructor(maxConcurrency = 1) {
		this.sem = new TaskSemaphore(maxConcurrency)
	}

	get waiting(): number {
		return this.sem.waiting
	}

	/**
	 * Acquire a permit for `task`, call `run()`, and release on completion.
	 *
	 * The returned promise resolves/rejects with the same value as `run()`.
	 * Release is guaranteed via try/finally even if `run()` throws.
	 *
	 * If the task was aborted or abandoned while waiting for a permit (e.g. the
	 * user cancelled it before it started), the permit is released immediately
	 * without calling `run()`.
	 */
	async schedule(task: Task, run: () => Promise<void>, observe?: TaskScheduleObserver): Promise<void> {
		const notify: TaskScheduleObserver = (stage, error) => {
			try {
				observe?.(stage, error)
			} catch {
				// Observation must not affect execution, its outcome, or permit ownership.
			}
		}
		let release: () => void
		try {
			release = await this.sem.acquire()
		} catch (error) {
			notify("cancelled", error)
			throw error
		}
		try {
			notify("admitted")
			if (task.abort || task.abandoned) {
				notify("cancelled")
				return
			}
			notify("started")
			await run()
			notify("settled")
		} catch (error) {
			notify("failed", error)
			throw error
		} finally {
			release()
		}
	}

	/**
	 * Cancel all queued (waiting) tasks. Tasks that already acquired a permit
	 * are not affected — they continue to run to completion.
	 */
	cancelQueued(): void {
		this.sem.cancel()
	}
}
