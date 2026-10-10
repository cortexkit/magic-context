import type {
	ContextEvent,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { isCheckoutClaimRefusalError } from "@magic-context/core/features/magic-context/checkout-claim";
import { log } from "@magic-context/core/shared/logger";
import { withSqliteTransformPass } from "@magic-context/core/shared/sqlite";
import { isOmpSideContext } from "./omp-request-kind";
import { PiContextBudget } from "./pi-context-budget";
import { resolvePiHarnessKind } from "./pi-harness-kind";

const ENTRY_TYPE = "magic-context-turn-refused";
const RETRY_MESSAGE =
	"Magic Context could not safely prepare this turn; send your message again.";

export class PiContextSupersededError extends Error {}

interface Operation {
	pass?: PiContextBudget;
	ready: boolean;
	refused: boolean;
	ended: boolean;
}
const receiptMaps = new Set<Map<string | object, Operation>>();
export function clearPiContextReceipt(sessionId: string): void {
	for (const receipts of receiptMaps) receipts.delete(sessionId);
}

function operationKey(ctx: ExtensionContext): string | object {
	return (
		ctx.sessionManager?.getSessionId?.() ?? ctx.sessionManager ?? "no-session"
	);
}

/**
 * Pi catches context-hook exceptions and continues with its original messages.
 * Escaping errors here are deliberate refusals: abort the operation as well as
 * logging the original error. The entry is display-only, never a model message.
 */
export function registerPiGuardedContext(
	pi: ExtensionAPI,
	handler: (
		event: ContextEvent,
		ctx: ExtensionContext,
		budget: PiContextBudget,
	) =>
		| Promise<{ messages: ContextEvent["messages"] } | undefined>
		| Promise<void>,
	options: {
		compactionOff?: (ctx: ExtensionContext) => boolean;
		onRefusal?: (
			ctx: ExtensionContext,
			budget: PiContextBudget,
			message: string,
			isCurrent: () => boolean,
		) => void;
	} = {},
): void {
	const operations = new Map<string | object, Operation>();
	const sideSessions = new Map<
		string | object,
		{ contexts: number; sides: number }
	>();
	receiptMaps.add(operations);
	// Keep the dispatch backstop disabled for previously observed side sessions
	// after cache eviction or reload: OMP still erases side-request attribution.
	// Only per-turn completion records are invalidated by cache cleanup.
	const newOperation = (): Operation => ({
		ready: false,
		refused: false,
		ended: false,
	});
	const fenceEnabled = resolvePiHarnessKind() === "omp";
	const refuse = (
		ctx: ExtensionContext,
		budget: PiContextBudget,
		reason: unknown,
		isCurrent: () => boolean,
	): void => {
		if (!isCurrent()) {
			log(
				`[magic-context][pi] DISCARDED CONTEXT RESULT ${budget.diagnostic()}`,
				reason,
			);
			return;
		}
		budget.abandoned = true;
		budget.recovery =
			budget.recovery === "not attempted"
				? "no managed result; refused"
				: budget.recovery;
		const message = isCheckoutClaimRefusalError(reason)
			? reason.message
			: `${RETRY_MESSAGE} ${budget.diagnostic()} (${reason instanceof Error ? reason.message : String(reason)})`;
		try {
			ctx.ui?.notify(message, "error");
		} catch (error) {
			log("[magic-context][pi] refusal notice failed", error);
		}
		try {
			pi.appendEntry(ENTRY_TYPE, { message });
		} catch (error) {
			log("[magic-context][pi] refusal entry failed", error);
		} finally {
			if (!budget.sideTurn) ctx.abort();
		}
		// Queue ordinary error diagnostics without blocking a provider request.
		// A checkout held elsewhere forbids even deferred writes to its Magic Context
		// store; the magic-context-turn-refused entry already displays the reason.
		if (isCheckoutClaimRefusalError(reason)) return;
		try {
			options.onRefusal?.(ctx, budget, message, isCurrent);
		} catch (error) {
			log("[magic-context][pi] refusal diagnostic failed", error);
		}
	};
	if (fenceEnabled) {
		pi.on("agent_start", (_event, ctx) => {
			operations.set(operationKey(ctx), newOperation());
		});
		pi.on("agent_end", (_event, ctx) => {
			const key = operationKey(ctx);
			const counts = sideSessions.get(key);
			if (counts)
				log(
					`[magic-context][pi] OMP context counts session=${String(key)} side_contexts=${counts.sides} context_passes=${counts.contexts} dispatch_fence=${counts.sides ? "latched off" : "on"}`,
				);
			const operation = operations.get(key);
			if (operation) {
				operation.ended = true;
				operation.ready = false;
			}
		});
		// OMP supplies session identity, but no provider-attempt ID. The latest
		// context pass is the receipt for this operation, including payload retries.
		// No awaits, DB access or payload hashing are allowed in this backstop.
		pi.on("before_provider_request", (_event, ctx) => {
			if (options.compactionOff?.(ctx)) return;
			const key = operationKey(ctx);
			// OMP erases the ephemeral request's attribution before this hook. Its
			// abort API is session-wide, so after seeing OMP's attributed reminder
			// and prompt in a context event we cannot safely abort any payload here.
			// Every other session still requires a completed managed context pass,
			// even when we do not recognize the provider's body format.
			if (sideSessions.get(key)?.sides) return;
			let operation = operations.get(key);
			if (!operation) {
				operation = newOperation();
				operations.set(key, operation);
			}
			const active = operation;
			const isCurrent = () => operations.get(key) === active;
			const budget = active.pass ?? new PiContextBudget();
			try {
				// A context result completed before the preparation deadline remains
				// valid on provider retries. Ownership, refusal and turn end still apply.
				budget.assertOwner();
				if (!budget.completed) budget.assertOutcome();
				if (!active.ready || active.refused || active.ended || budget.abandoned)
					throw new Error("missing managed context receipt");
			} catch (error) {
				active.refused = true;
				budget.stage = "provider dispatch";
				refuse(ctx, budget, error, isCurrent);
			}
		});
	}
	pi.registerEntryRenderer?.<{ message: string }>(
		ENTRY_TYPE,
		(entry) => new Text(entry.data?.message ?? RETRY_MESSAGE, 0, 0),
	);
	pi.on("context", async (event, ctx) => {
		const budget = new PiContextBudget();
		budget.sideTurn = fenceEnabled && isOmpSideContext(event);
		const key = operationKey(ctx);
		if (fenceEnabled) {
			let counts = sideSessions.get(key);
			if (!counts) {
				counts = { contexts: 0, sides: 0 };
				sideSessions.set(key, counts);
			}
			counts.contexts++;
			if (budget.sideTurn && ++counts.sides === 1)
				log(
					`[magic-context][pi] OMP dispatch fence disabled for session ${String(key)}: verified ephemeral context; session-wide abort cannot distinguish provider operations (side_contexts=${counts.sides} context_passes=${counts.contexts})`,
				);
		}
		const owner = operations.get(key);
		let operation = operations.get(key);
		if (budget.sideTurn || !operation || !fenceEnabled) {
			operation = newOperation();
			if (!budget.sideTurn) operations.set(key, operation);
		}
		const active = operation;
		active.pass = budget;
		active.ready = false;
		const isOwned = () =>
			budget.sideTurn
				? operations.get(key) === owner
				: operations.get(key) === active && active.pass === budget;
		const isCurrent = () => isOwned() && (budget.sideTurn || !active.ended);
		budget.assertOwner = () => {
			if (!isCurrent())
				throw new PiContextSupersededError(
					"Pi context pass superseded before writer admission",
				);
		};
		try {
			// Share at most 250 ms of synchronous waiting for later turn writes,
			// including autocommit statements. Initial session-meta admission uses
			// the separate yielding writer budget shared with OpenCode.
			// Do not rerun the handler: it may already have committed earlier writes.
			const result = await withSqliteTransformPass(() =>
				handler(event, ctx, budget),
			);
			budget.assertOutcome();
			if (result?.messages) {
				budget.completed = true;
				active.ready = true;
			}
			return result;
		} catch (error) {
			// A newer pass owns this session now. Calling its session-wide abort
			// API from the abandoned hook would cancel the replacement turn.
			if (error instanceof PiContextSupersededError || !isCurrent()) {
				log(
					`[magic-context][pi] DISCARDED CONTEXT RESULT ${budget.diagnostic()}`,
					error,
				);
				throw error;
			}
			log("[magic-context][pi] turn refused", error);
			// A checkout-claim refusal is not a retryable preparation failure: the
			// user has to move the agent first, so show its own message instead.
			// Direct handler fixtures lack the host abort API; retain their original
			// exception contract. Real Pi contexts always supply abort().
			if (typeof ctx.abort !== "function") {
				budget.abandoned = true;
				if (!isCheckoutClaimRefusalError(error))
					options.onRefusal?.(
						ctx,
						budget,
						error instanceof Error ? error.message : String(error),
						isOwned,
					);
				throw error;
			}
			active.refused = true;
			refuse(ctx, budget, error, isOwned);
			return { messages: event.messages };
		}
	});
}
