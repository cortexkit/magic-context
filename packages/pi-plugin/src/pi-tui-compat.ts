import { resolvePiHarnessDetection } from "./pi-harness-kind";

type LegacyTui = Pick<
	typeof import("@earendil-works/pi-tui"),
	"Box" | "Text" | "matchesKey" | "truncateToWidth" | "visibleWidth"
>;

async function loadLegacyTui(): Promise<LegacyTui | undefined> {
	if ((await resolvePiHarnessDetection()).kind === "pi") {
		// OMP scans the entire extension graph before evaluation. Resolve the Pi
		// peer only on Pi, so OMP never sees a dependency on the foreign TUI.
		const piPeer = "@earendil-works/pi-tui";
		return import(piPeer);
	}
	// OMP resolves literal imports of its own TUI to the running host's copy.
	const tui = (await import(
		"@oh-my-pi/pi-tui" as string
	)) as Partial<LegacyTui>;
	if (
		typeof tui.Box === "function" &&
		typeof tui.Text === "function" &&
		typeof tui.matchesKey === "function" &&
		typeof tui.truncateToWidth === "function" &&
		typeof tui.visibleWidth === "function"
	) {
		return tui as LegacyTui;
	}
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
