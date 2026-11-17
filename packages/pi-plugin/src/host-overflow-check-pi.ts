import { log } from "@magic-context/core/shared/logger";

/**
 * The running host's own classifier for "the request was too long" errors.
 *
 * Pi decides on its own whether a failed reply was a context overflow, and
 * starts its compaction when it was. Magic Context cancels that compaction and
 * must then start its own overflow recovery, so it has to agree with the host
 * about which errors are overflows. Its own pattern list
 * (`detectOverflow`) misses some that Pi's catches, such as `request_too_large`,
 * `413 status code (no body)` and `Token limit exceeded`.
 *
 * Pi and Oh My Pi both serve the root of `@earendil-works/pi-ai` to extensions
 * from their own copy: Pi maps it to its pi-ai compat entry (a jiti alias, or a
 * virtual module in the compiled binary), and Oh My Pi rewrites the specifier
 * to its legacy shim, which re-exports `isContextOverflow` from
 * `@oh-my-pi/pi-ai/error`. The extension build keeps this import external, so
 * the check below is the host's, not a copy bundled with Magic Context.
 *
 * The import runs on first use, never while the extension loads, and any
 * failure (no such module, no such export, or the check throwing) only means
 * the host's check is not consulted.
 */
export type PiHostOverflowCheck = (message: unknown) => boolean;

type HostOverflowModule = { isContextOverflow?: unknown };

const HOST_PI_AI_MODULE = "@earendil-works/pi-ai";

const importHostModule = (): Promise<HostOverflowModule> =>
	import("@earendil-works/pi-ai") as Promise<HostOverflowModule>;

let loadHostModule: () => Promise<HostOverflowModule> = importHostModule;
let hostCheck: Promise<PiHostOverflowCheck | undefined> | undefined;

/** Load the host's overflow check once; resolves undefined when the host has none. */
export function loadPiHostOverflowCheck(): Promise<
	PiHostOverflowCheck | undefined
> {
	hostCheck ??= resolveHostOverflowCheck();
	return hostCheck;
}

async function resolveHostOverflowCheck(): Promise<
	PiHostOverflowCheck | undefined
> {
	let module: HostOverflowModule;
	try {
		module = await loadHostModule();
	} catch (error) {
		log(
			`[magic-context] host overflow check unavailable: ${HOST_PI_AI_MODULE} did not load (${error instanceof Error ? error.message : String(error)}); using Magic Context's overflow patterns only`,
		);
		return undefined;
	}
	const check = module?.isContextOverflow;
	if (typeof check !== "function") {
		log(
			`[magic-context] host overflow check unavailable: ${HOST_PI_AI_MODULE} has no isContextOverflow export; using Magic Context's overflow patterns only`,
		);
		return undefined;
	}
	log(
		`[magic-context] host overflow check: using isContextOverflow from ${HOST_PI_AI_MODULE}`,
	);
	// No context window is passed: only the failed reply's own error decides,
	// never a usage figure measured against a window.
	return (message) => {
		try {
			return check(message) === true;
		} catch {
			return false;
		}
	};
}

/**
 * Replace how the host module is imported, and forget the loaded check.
 * Passing undefined restores the real import.
 */
export function __setPiHostOverflowModuleLoaderForTests(
	loader: (() => Promise<HostOverflowModule>) | undefined,
): void {
	loadHostModule = loader ?? importHostModule;
	hostCheck = undefined;
}
