/**
 * Oh My Pi (OMP) 18.8.6 stops waiting after 30s without cancelling the context handler.
 * Cooperatively finish mandatory work by 25s (5s host margin); stop optional work at 21s.
 * Mandatory tagging/reclaim and final publication share the 25s outcome clock.
 * At expiry the fallback is a synchronous, storage-independent visible refusal.
 * The real OMP held-writer edge probe measured 4ms for that fallback and 25.745s
 * from handler entry to refusal, including probe instrumentation: 4.255s below
 * OMP's 30s deadline. This is one Mac observation, not a Windows upper bound.
 * Writer admission retains the shared helper's 16.5s ceiling but reserves 2s of mandatory work:
 * the measured non-wait maximum was 0.822s, so this reserve is over twice that.
 * Synchronous host/native calls cannot be preempted by these checkpoints or timers.
 * The independent dispatch receipt fence is the backstop after synchronous stalls.
 * Plain Pi has no handler deadline; these cooperative budgets apply there too.
 * These are initial engineering budgets, not Windows latency percentiles.
 */
export const PI_CONTEXT_BUDGET = {
	hostDeadlineMs: 30_000,
	hostMarginMs: 5_000,
	outcomeMs: 25_000,
	fallbackObservedMs: 4,
	// Optional work stops four seconds before the outcome deadline.
	workMs: 21_000,
	writerMs: 16_500,
	completionReserveMs: 2_000,
	searchMs: 3_000,
} as const;

export class PiContextDeadlineError extends Error {}

/**
 * The pass reached its deadline while waiting for a historian run. `refusal`
 * is the text the user is shown if the pass is refused for it (see
 * describeHistorianJoinRefusal); the message stays the budget diagnostic.
 */
export class PiHistorianJoinDeadlineError extends PiContextDeadlineError {
	constructor(
		diagnostic: string,
		readonly refusal: string,
	) {
		super(diagnostic);
	}
}

export class PiContextSupersededError extends Error {
	constructor(
		message: string,
		readonly origin = "context ownership",
	) {
		super(message);
	}
}

/** One cooperative clock shared by preparation, admission, normal work and recovery. */
export class PiContextBudget {
	sideTurn = false;
	stage = "entry";
	recovery = "not attempted";
	abandoned = false;
	completed = false;
	failureReason?: string;
	signal?: AbortSignal;
	private cancelled = false;
	isCancelled(error?: unknown): boolean {
		// Older hosts do not expose the run signal. Their AbortError is the only
		// cancellation evidence; with a signal, require the run itself to be aborted.
		return (
			this.cancelled ||
			this.signal?.aborted === true ||
			(!this.signal &&
				typeof error === "object" &&
				error !== null &&
				"name" in error &&
				error.name === "AbortError")
		);
	}
	cancel(): void {
		this.cancelled = true;
		this.abandoned = true;
		this.completed = false;
		this.failureReason = undefined;
	}
	assertOwner: () => void = () => {};
	constructor(
		readonly startedAt = performance.now(),
		private readonly now = () => performance.now(),
	) {}
	elapsed(): number {
		return this.now() - this.startedAt;
	}
	remainingWork = (): number => {
		return Math.max(0, PI_CONTEXT_BUDGET.workMs - this.elapsed());
	};
	remainingOutcome = (): number =>
		Math.max(0, PI_CONTEXT_BUDGET.outcomeMs - this.elapsed());
	writerAllowance(): number {
		return Math.max(
			0,
			Math.min(
				PI_CONTEXT_BUDGET.writerMs,
				this.remainingWork() - PI_CONTEXT_BUDGET.completionReserveMs,
			),
		);
	}

	hydrationAllowance(): number {
		return Math.max(
			0,
			Math.min(
				this.remainingWork() - PI_CONTEXT_BUDGET.completionReserveMs,
				this.remainingOutcome() - PI_CONTEXT_BUDGET.completionReserveMs,
			),
		);
	}
	assertOutcome = (): void => {
		this.assertOwner();
		this.signal?.throwIfAborted();
		if (this.abandoned || this.elapsed() >= PI_CONTEXT_BUDGET.outcomeMs)
			throw new PiContextDeadlineError(this.diagnostic());
	};
	assert = (): void => {
		this.assertOutcome();
		if (this.elapsed() >= PI_CONTEXT_BUDGET.workMs)
			throw new PiContextDeadlineError(this.diagnostic());
	};
	// A returned managed result can be attributed to the next assistant, even
	// after a new pass takes ownership. An unfinished or refused result cannot.
	// The resolving pass supplies its own owner guard around the queued write.
	//
	// The outcome deadline fences only a pass that is still running. A completed
	// pass already finished inside it (waitMandatory checks the deadline after
	// the handler returns), and its row is written later, when the next pass
	// names the assistant that answered. Measuring elapsed time then would
	// measure when the next pass started, and dropped the row of every reclaim
	// whose next turn began 25 s or more after it. A refused dispatch marks the
	// pass abandoned, so a completed result whose request never went out still
	// records nothing.
	assertDecisionPublication = (): void => {
		this.signal?.throwIfAborted();
		if (!this.completed) this.assertOwner();
		if (
			this.abandoned ||
			(!this.completed && this.elapsed() >= PI_CONTEXT_BUDGET.outcomeMs)
		)
			throw new PiContextDeadlineError(this.diagnostic());
	};
	diagnostic(): string {
		return `stage=${this.stage} elapsed=${Math.round(this.elapsed())}ms recovery=${this.recovery}`;
	}
	private waitUntil = async <T>(
		pending: Promise<T>,
		assert: () => void,
		remaining: () => number,
	): Promise<T> => {
		try {
			assert();
		} catch (error) {
			// Callers start the work before passing its promise here. Even when the
			// entry guard rejects the wait, own that promise's eventual rejection.
			void pending.catch(() => {});
			throw error;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		let onAbort: (() => void) | undefined;
		try {
			return await Promise.race([
				pending,
				...(this.signal
					? [
							new Promise<never>((_, reject) => {
								onAbort = () => reject(this.signal?.reason);
								this.signal?.addEventListener("abort", onAbort, {
									once: true,
								});
							}),
						]
					: []),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new PiContextDeadlineError(this.diagnostic())),
						remaining(),
					);
				}),
			]);
		} finally {
			clearTimeout(timer);
			if (onAbort) this.signal?.removeEventListener("abort", onAbort);
			assert();
		}
	};
	wait = <T>(pending: Promise<T>): Promise<T> =>
		this.waitUntil(pending, this.assert, () => this.remainingWork());
	waitMandatory = <T>(pending: Promise<T>): Promise<T> =>
		this.waitUntil(pending, this.assertOutcome, this.remainingOutcome);
}
