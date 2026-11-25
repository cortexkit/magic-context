import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolvePiHarnessDetection } from "./pi-harness-kind";

type LegacyTui = Pick<
	typeof import("@earendil-works/pi-tui"),
	"Box" | "Text" | "matchesKey" | "truncateToWidth" | "visibleWidth"
>;

type TuiExports = Partial<LegacyTui> & { createSurface?: unknown };

function legacyExports(tui: TuiExports | undefined): LegacyTui | undefined {
	if (
		typeof tui?.Box === "function" &&
		typeof tui.Text === "function" &&
		typeof tui.matchesKey === "function" &&
		typeof tui.truncateToWidth === "function" &&
		typeof tui.visibleWidth === "function"
	) {
		return tui as LegacyTui;
	}
}

async function loadLegacyTui(): Promise<LegacyTui | undefined> {
	// OMP scans literal imports across the extension graph before evaluation.
	const piPeer = "@earendil-works/pi-tui";
	if ((await resolvePiHarnessDetection()).kind === "omp") {
		// OMP resolves literal imports of its own TUI to the running host's copy.
		const tui: TuiExports | undefined = await import(
			"@oh-my-pi/pi-tui" as string
		).catch(() => undefined);
		const legacy = legacyExports(tui);
		if (legacy) return legacy;
		// A recognized rows-based host cannot use old components, even when a
		// copy of the Pi peer happens to be installed next to the extension.
		if (typeof tui?.createSurface === "function") return undefined;
	} else if (process.argv[1]) {
		try {
			// A globally installed Pi owns the peer. The extension package's
			// optional peer may not exist in the module tree that loaded us.
			const hostRequire = createRequire(realpathSync(process.argv[1]));
			const peerUrl = pathToFileURL(hostRequire.resolve(piPeer));
			const tui = legacyExports(await import(peerUrl.href));
			if (tui) return tui;
		} catch {
			// An embedded host or test entry may have no on-disk host package.
		}
	}
	// Also accept a local Pi peer on older OMP installs without the canonical
	// package. An unavailable display dependency must not stop the extension.
	return legacyExports(await import(piPeer).catch(() => undefined));
}

export const legacyTui = await loadLegacyTui();

export function matchesKey(...args: Parameters<LegacyTui["matchesKey"]>) {
	return legacyTui?.matchesKey(...args) ?? false;
}

export function truncateToWidth(
	...args: Parameters<LegacyTui["truncateToWidth"]>
) {
	return legacyTui?.truncateToWidth(...args) ?? args[0];
}

export function visibleWidth(text: string): number {
	return legacyTui?.visibleWidth(text) ?? text.length;
}
