import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiHarnessKind } from "./pi-harness-kind";
import { configurePiSubagentHostTools } from "./subagent-runner";

/** Only a serving OMP runtime may supply the child built-in tool filter. */
export function registerPiSubagentHostTools(
	pi: ExtensionAPI,
	harness: PiHarnessKind,
): void {
	if (harness !== "omp") return;
	let active = false;
	pi.on("session_start", () => {
		active = true;
		// Do not publish at factory load: a separate loader-only evaluation can
		// otherwise replace the serving session's API with permanently unbound
		// action stubs. Both hosts bind the original API's runtime before this event.
		configurePiSubagentHostTools(() => {
			if (!active) return undefined;
			if (typeof pi.getAllTools === "function") {
				return pi.getAllTools().map((tool) => tool.name);
			}
			if (typeof pi.getActiveTools === "function") return pi.getActiveTools();
			return undefined;
		});
	});
	pi.on("session_shutdown", () => {
		// Invalidate only this supplier, not a newer independent session's one.
		active = false;
	});
}
