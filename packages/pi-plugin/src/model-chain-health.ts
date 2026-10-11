/**
 * Report Pi historian and dreamer model chains that Pi's model registry
 * empties, with the registered model each dropped entry most likely meant.
 *
 * `validatePiDreamerModels` drops every configured `provider/model` that
 * `ctx.modelRegistry.find()` does not know. When that leaves a chain empty the
 * historian (or the dreamer task) simply never runs, and the only traces were
 * a `/ctx-status` line and a once-per-process log line. A common cause is the
 * OpenCode provider name in a Pi block (`google/…` where the Pi extension
 * registers `google-antigravity/…`), or a model id the provider's catalog does
 * not carry, so naming the closest registered model makes the notice
 * actionable.
 */

import { isDreamerRunnable } from "@magic-context/core/config/agent-disable";
import type {
	HistorianConfig,
	MagicContextConfig,
} from "@magic-context/core/config/schema/magic-context";
import { buildDreamTaskRuntimeConfigs } from "@magic-context/core/features/magic-context/dreamer/task-config";
import { resolveHistorianModel } from "@magic-context/core/shared/model-resolution";

/**
 * The Pi-compatible host: Pi itself, or OMP (oh-my-pi, whose child CLI
 * expands `@role` model selectors itself rather than its model registry).
 */
type PiHarness = "pi" | "omp";

export interface PiModelRegistryLike {
	find(provider: string, modelId: string): unknown;
	getAll?: () => ReadonlyArray<{ provider?: unknown; id?: unknown }>;
	/** OMP only: resolves once the boot-time discovery merge has settled. */
	awaitBackgroundRefresh?: () => Promise<unknown>;
	awaitInitialBackgroundRefresh?: () => Promise<unknown>;
}

export interface DroppedPiModel {
	model: string;
	/** Closest registered `provider/id`, when one is close enough to suggest. */
	suggestion?: string;
}

export interface EmptyPiModelChain {
	/** `historian` or a dreamer task name. */
	owner: string;
	dropped: DroppedPiModel[];
}

type ChainEntry = string | { model: string };

function entryModel(entry: ChainEntry): string {
	return typeof entry === "string" ? entry : entry.model;
}

/**
 * Whether Pi's registry knows a configured `provider/model`. The registry is
 * looked up by provider id and model id, split at the first `/`. OMP expands
 * `@role` selectors in its child CLI rather than its registry, so those count
 * as available there (and only there).
 */
export function isPiModelRegistered(
	model: string,
	registry: Pick<PiModelRegistryLike, "find">,
	harness: PiHarness,
): boolean {
	if (harness === "omp" && model.startsWith("@")) return true;
	const separator = model.indexOf("/");
	return (
		separator > 0 &&
		Boolean(
			registry.find(model.slice(0, separator), model.slice(separator + 1)),
		)
	);
}

/**
 * Wait for the host's discovery-backed catalogue to settle before treating a
 * `find()` miss as proof a model does not exist.
 *
 * OMP composes its catalogue in two phases: the `ModelRegistry` constructor
 * loads only the synchronous layers, and a dynamic-only extension provider such
 * as `litellm` appears only after the boot-time `refreshInBackground()` merge
 * runs -- which OMP deliberately never awaits on the startup path, and whose
 * extension `registerProvider` calls are themselves queued until after
 * extension loading. So a synchronous lookup during extension registration can
 * miss a model that exists, and it does so intermittently (observed: four OMP
 * processes inside one minute, two registering the historian and two
 * reporting `registered historian trigger: DISABLED` for the same config).
 *
 * OMP's own consumers re-check after awaiting this (session/agent-session.ts
 * `#retryInactiveAdvisorAfterModelDiscovery`, task/executor.ts). An extension
 * that trusts one synchronous miss disables the feature for the life of the
 * process. Prefer the initial-discovery barrier: it remains pending until the
 * host completes discovery, including when discovery has not started yet.
 * Older hosts expose only the in-flight barrier, which resolves immediately
 * when idle. Pi without either API is checked synchronously. Refresh failures
 * are swallowed so the caller can re-read the settled catalogue.
 * Do not time out into an absence report: elapsed time is not evidence that
 * a model is missing from a catalogue that has not finished loading.
 */
export async function waitForPiModelRegistryRefresh(
	registry: Pick<
		PiModelRegistryLike,
		"awaitBackgroundRefresh" | "awaitInitialBackgroundRefresh"
	>,
): Promise<void> {
	const refresh =
		registry.awaitInitialBackgroundRefresh ?? registry.awaitBackgroundRefresh;
	if (typeof refresh !== "function") return;
	try {
		await refresh.call(registry);
	} catch {
		// Swallowed on purpose: the caller re-reads the registry either way.
	}
}

function registeredModels(
	registry: PiModelRegistryLike,
): Array<{ provider: string; id: string }> {
	try {
		const all = registry.getAll?.() ?? [];
		return all.flatMap((model) =>
			typeof model?.provider === "string" && typeof model.id === "string"
				? [{ provider: model.provider, id: model.id }]
				: [],
		);
	} catch {
		return [];
	}
}

function editDistance(a: string, b: string): number {
	const previous = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i += 1) {
		let diagonal = previous[0];
		previous[0] = i;
		for (let j = 1; j <= b.length; j += 1) {
			const above = previous[j];
			previous[j] = Math.min(
				previous[j] + 1,
				previous[j - 1] + 1,
				diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
			diagonal = above;
		}
	}
	return previous[b.length];
}

/**
 * The registered model a dropped `provider/model` most likely meant:
 *
 * 1. the same model id under another provider (`google/x` gives
 *    `google-antigravity/x`), preferring a provider whose name starts with or
 *    contains the configured one;
 * 2. otherwise the closest model id within the same provider, when the ids
 *    differ in no more than 40% of the longer one's characters.
 */
export function suggestRegisteredPiModel(
	dropped: string,
	registered: ReadonlyArray<{ provider: string; id: string }>,
): string | undefined {
	const separator = dropped.indexOf("/");
	if (separator <= 0) return undefined;
	const provider = dropped.slice(0, separator).toLowerCase();
	const modelId = dropped.slice(separator + 1).toLowerCase();

	const sameId = registered
		.filter(
			(model) =>
				model.id.toLowerCase() === modelId &&
				model.provider.toLowerCase() !== provider,
		)
		.sort((left, right) => {
			const rank = (name: string) =>
				name.toLowerCase().startsWith(provider)
					? 0
					: name.toLowerCase().includes(provider)
						? 1
						: 2;
			return (
				rank(left.provider) - rank(right.provider) ||
				left.provider.localeCompare(right.provider)
			);
		});
	if (sameId[0]) return `${sameId[0].provider}/${sameId[0].id}`;

	let best: { key: string; distance: number } | undefined;
	for (const model of registered) {
		if (model.provider.toLowerCase() !== provider) continue;
		const distance = editDistance(modelId, model.id.toLowerCase());
		const allowed = Math.ceil(0.4 * Math.max(modelId.length, model.id.length));
		if (distance > allowed) continue;
		const key = `${model.provider}/${model.id}`;
		if (
			!best ||
			distance < best.distance ||
			(distance === best.distance && key.localeCompare(best.key) < 0)
		) {
			best = { key, distance };
		}
	}
	return best?.key;
}

/**
 * Chains that would run but have no model left after registry validation:
 * the historian when it is enabled and configured for Pi, and each dreamer
 * task that is scheduled while the dreamer is enabled. A task with an empty
 * schedule never runs on its own, so its chain is not reported.
 */
export function findEmptyPiModelChains(args: {
	config: MagicContextConfig;
	registry: PiModelRegistryLike;
	harness: PiHarness;
}): EmptyPiModelChain[] {
	const { config, registry, harness } = args;
	const registered = registeredModels(registry);
	const empty: EmptyPiModelChain[] = [];
	for (const { owner, chain } of runnablePiModelChains(config, harness)) {
		const models = chain.map(entryModel);
		if (models.some((model) => isPiModelRegistered(model, registry, harness)))
			continue;
		empty.push({
			owner,
			dropped: models.map((model) => {
				const suggestion = suggestRegisteredPiModel(model, registered);
				return suggestion ? { model, suggestion } : { model };
			}),
		});
	}
	return empty;
}

/**
 * The configured model chains that would run: the historian's when it is
 * enabled and has a Pi model, and each scheduled dreamer task's while the
 * dreamer is enabled.
 */
export function runnablePiModelChains(
	config: MagicContextConfig,
	harness: PiHarness,
): Array<{ owner: string; chain: ChainEntry[] }> {
	const chains: Array<{ owner: string; chain: ChainEntry[] }> = [];
	const historian = config.historian as HistorianConfig | undefined;
	const resolved = resolveHistorianModel(config, harness);
	if (historian?.disable !== true && resolved.primary) {
		chains.push({
			owner: "historian",
			chain: [resolved.primary, ...resolved.fallbacks],
		});
	}
	if (isDreamerRunnable(config)) {
		for (const task of buildDreamTaskRuntimeConfigs(
			config.dreamer,
			harness,
			config.language,
		)) {
			if (task.schedule.trim() === "") continue;
			const chain = [task.model, ...(task.fallbackModels ?? [])].filter(
				(entry): entry is NonNullable<typeof entry> => entry !== undefined,
			) as ChainEntry[];
			if (chain.length > 0) chains.push({ owner: task.task, chain });
		}
	}
	return chains;
}

function formatDropped(dropped: DroppedPiModel): string {
	return dropped.suggestion
		? `${dropped.model} (did you mean ${dropped.suggestion}?)`
		: `${dropped.model} (no similar model registered)`;
}

/** One line per empty chain, e.g. for `/ctx-status` and `doctor`. */
export function formatEmptyPiModelChain(chain: EmptyPiModelChain): string {
	return `${chain.owner}: ${chain.dropped.map(formatDropped).join(", ")}`;
}

/**
 * A note for a session whose emergency drain latch is set while the historian
 * cannot run.
 *
 * The latch (`session_meta.emergency_drain_active`, the time it was set) is
 * read and cleared only when a historian run reserves drain tokens: it lets
 * that run drain past the per-window budget, and the same reservation clears
 * it once usage is back below the force band or it is older than its
 * self-expiry bound. With no runnable historian nothing reads it, so it has no
 * effect, but nothing clears it either. Clearing it here would change no
 * behaviour (the first historian run clears or re-arms it from the usage it
 * sees), so it is only reported, to explain a timestamp that looks stuck.
 */
export function describeInertEmergencyDrainLatch(
	activeSince: number,
): string | undefined {
	if (!Number.isFinite(activeSince) || activeSince <= 0) return undefined;
	return `emergency drain latch set ${new Date(activeSince).toISOString()} has no effect while the historian cannot run; its next run clears it unless usage is still in the force band`;
}

/** The in-session notice for chains that cannot run. */
export function formatEmptyPiModelChainsNotice(
	chains: readonly EmptyPiModelChain[],
): string {
	const owners = chains.map((chain) => chain.owner).join(", ");
	return [
		`⚠️ Magic Context: no configured model for ${owners} is registered in Pi, so ${chains.length === 1 ? "it" : "they"} will not run.`,
		...chains.map((chain) => `  ${formatEmptyPiModelChain(chain)}`),
		"Fix the Pi model names in magic-context.jsonc (the Pi blocks use Pi's provider ids, see `pi --list-models`).",
	].join("\n");
}

/**
 * A key for the set of dropped models, so a process notifies once for a given
 * problem and again only when a config reload changes it.
 */
export function emptyPiModelChainsKey(
	chains: readonly EmptyPiModelChain[],
): string {
	return chains
		.map(
			(chain) =>
				`${chain.owner}=${chain.dropped.map((dropped) => dropped.model).join("|")}`,
		)
		.join(";");
}
