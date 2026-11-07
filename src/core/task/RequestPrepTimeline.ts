export interface RequestPrepSnapshot {
	/** Time since preparation began, up to the provider call (or now, while still preparing). */
	totalMs: number
	/** Part of totalMs spent in deliberate waits (rate limit countdown, approval prompt). */
	userWaitMs: number
	/** Completed phases in order, with their durations. */
	phases: ReadonlyArray<{ name: string; ms: number }>
	/** The phase still running, while preparation has not finished. */
	current?: { name: string; ms: number }
}

/**
 * Times the steps Zoo takes before it hands a request to the provider. Diagnostics only: it
 * records phase names and durations, never request content.
 */
export class RequestPrepTimeline {
	private readonly now: () => number
	private readonly startedAt: number
	private readonly phases: { name: string; ms: number; userWait: boolean }[] = []
	private current: { name: string; since: number; userWait: boolean } | undefined
	private finishedAt: number | undefined

	constructor(now: () => number = Date.now) {
		this.now = now
		this.startedAt = now()
	}

	/** Ends the running phase and starts `name`. `userWait` marks a deliberate wait, not Zoo work. */
	phase(name: string, options: { userWait?: boolean } = {}): void {
		if (this.finishedAt !== undefined) return
		const now = this.now()
		this.closeCurrent(now)
		this.current = { name, since: now, userWait: options.userWait ?? false }
	}

	/** Call right before the provider request; later calls are ignored. */
	finish(): void {
		if (this.finishedAt !== undefined) return
		this.finishedAt = this.now()
		this.closeCurrent(this.finishedAt)
	}

	snapshot(): RequestPrepSnapshot {
		const now = this.finishedAt ?? this.now()
		const running = this.current && { name: this.current.name, ms: now - this.current.since }
		const userWaitMs =
			this.phases.reduce((sum, phase) => sum + (phase.userWait ? phase.ms : 0), 0) +
			(running && this.current?.userWait ? running.ms : 0)
		return {
			totalMs: now - this.startedAt,
			userWaitMs,
			phases: this.phases.map(({ name, ms }) => ({ name, ms })),
			...(running ? { current: running } : {}),
		}
	}

	private closeCurrent(now: number): void {
		if (!this.current) return
		this.phases.push({ name: this.current.name, ms: now - this.current.since, userWait: this.current.userWait })
		this.current = undefined
	}
}
