import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { TUI } from "@earendil-works/pi-tui";
import { resolvePiHarnessDetection } from "./pi-harness-kind";

type LegacyTui = Pick<
	typeof import("@earendil-works/pi-tui"),
	"Box" | "Text" | "matchesKey" | "truncateToWidth" | "visibleWidth"
>;

type TuiExports = Partial<LegacyTui> & { createSurface?: unknown };
type RowsTui = {
	visibleWidth: LegacyTui["visibleWidth"];
	truncate: LegacyTui["truncateToWidth"];
	decodeKey: (
		data: string,
		options: { kitty: boolean; backspaceIsCtrl: boolean },
	) => { id: string; kind: string } | null;
};

type DisplayTui = { legacy?: LegacyTui; rows?: RowsTui };

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

async function loadOmpRowsTui(): Promise<RowsTui | undefined> {
	try {
		const width: Partial<RowsTui> = await import(
			"@oh-my-pi/pi-tui/text/width" as string
		);
		const keys: Partial<RowsTui> = await import(
			"@oh-my-pi/pi-tui/driver/input/keys" as string
		);
		if (width.visibleWidth && width.truncate && keys.decodeKey) {
			return {
				visibleWidth: width.visibleWidth,
				truncate: width.truncate,
				decodeKey: keys.decodeKey,
			};
		}
	} catch {
		// Without the host's width and key helpers, use text notifications only.
	}
}

async function loadDisplayTui(): Promise<DisplayTui> {
	// OMP scans literal imports across the extension graph before evaluation.
	const piPeer = "@earendil-works/pi-tui";
	if ((await resolvePiHarnessDetection()).kind === "omp") {
		// OMP resolves literal imports of its own TUI to the running host's copy.
		const tui: TuiExports | undefined = await import(
			"@oh-my-pi/pi-tui" as string
		).catch(() => undefined);
		const legacy = legacyExports(tui);
		if (legacy) return { legacy };
		// A recognized rows-based host cannot use old components, even when a
		// copy of the Pi peer happens to be installed next to the extension.
		if (typeof tui?.createSurface === "function") {
			return { rows: await loadOmpRowsTui() };
		}
	} else if (process.argv[1]) {
		try {
			// A globally installed Pi owns the peer. The extension package's
			// optional peer may not exist in the module tree that loaded us.
			const hostRequire = createRequire(realpathSync(process.argv[1]));
			const peerUrl = pathToFileURL(hostRequire.resolve(piPeer));
			const tui = legacyExports(await import(peerUrl.href));
			if (tui) return { legacy: tui };
		} catch {
			// An embedded host or test entry may have no on-disk host package.
		}
	}
	// Also accept a local Pi peer on older OMP installs without the canonical
	// package. An unavailable display dependency must not stop the extension.
	return { legacy: legacyExports(await import(piPeer).catch(() => undefined)) };
}

const { legacy, rows } = await loadDisplayTui();
export const legacyTui = legacy;
export const hasOmpRowsTui = rows !== undefined;
export const canRenderPiRows = legacyTui !== undefined || hasOmpRowsTui;

export type PiRowsHost =
	| Pick<TUI, "terminal" | "requestRender">
	| { size(): { rows: number }; requestRender(): void };

export function piTerminalRows(host: PiRowsHost): number {
	return "size" in host ? host.size().rows : host.terminal.rows;
}

export function piOverlayOptions(width: number) {
	return {
		overlay: true,
		...(legacyTui && { overlayOptions: { anchor: "center" as const, width } }),
	};
}

export function matchesKey(...args: Parameters<LegacyTui["matchesKey"]>) {
	if (legacyTui) return legacyTui.matchesKey(...args);
	const [data, key] = args;
	// The rows canvas passes complete input sequences, and does not forward key releases.
	const event = rows?.decodeKey(data, { kitty: false, backspaceIsCtrl: false });
	return event?.id === (key === "return" ? "enter" : key);
}

export function truncateToWidth(
	...args: Parameters<LegacyTui["truncateToWidth"]>
) {
	return (
		legacyTui?.truncateToWidth(...args) ?? rows?.truncate(...args) ?? args[0]
	);
}

export function visibleWidth(text: string): number {
	return (
		legacyTui?.visibleWidth(text) ?? rows?.visibleWidth(text) ?? text.length
	);
}
