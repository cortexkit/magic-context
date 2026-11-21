import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SUBAGENT_TOOL_ALLOWLIST_FLAG = "magic-context-tool-allowlist";
export const OMP_CHILD_TOOL_CONFIG =
	"tools:\n  xdev: false\nplan:\n  enabled: false\n  defaultOnStartup: false\n";

// OMP 19.1 moved Auto-QA from the write transport to `report_issue`, a
// special tool restored by setActiveTools even with --no-tools. Turn it off
// before the host builds its tool registry, not by allowing it in the guard.
// https://github.com/can1357/oh-my-pi/blob/v19.1.0/packages/coding-agent/src/tools/resolve.ts#L397-L400
// Older OMP only exposes Auto-QA through `write`, which children never have.
export const OMP_CHILD_TOOL_ENV = { PI_AUTO_QA: "0" } as const;

/** Select child tools without disabling extensions that supply model providers. */
export function registerSubagentToolBoundary(pi: ExtensionAPI): void {
	pi.registerFlag(SUBAGENT_TOOL_ALLOWLIST_FLAG, {
		description: "Exact active tool names for a Magic Context hidden child.",
		type: "string",
	});
	pi.on("session_start", async () => {
		const value = pi.getFlag(SUBAGENT_TOOL_ALLOWLIST_FLAG);
		if (value === undefined) return;
		try {
			const names: unknown =
				typeof value === "string" ? JSON.parse(value) : null;
			if (
				!Array.isArray(names) ||
				!names.every((name) => typeof name === "string")
			) {
				throw new Error("Invalid Magic Context child tool allowlist");
			}
			// OMP's CLI gates built-ins only. Its public setter also replaces discovered
			// extension tools, after pending registrations have completed. Pi already
			// filters the full registry through its CLI allowlist.
			await pi.setActiveTools(names);
			const allowed = new Set(names);
			if (pi.getActiveTools().some((name) => !allowed.has(name))) {
				throw new Error(
					"Host activated tools outside the Magic Context child allowlist",
				);
			}
		} catch (error) {
			// OMP reports hook exceptions and continues startup. A failed restriction
			// must terminate the child instead of offering tools outside its allowlist.
			process.stderr.write(
				`Magic Context child tool restriction failed: ${String(error)}\n`,
			);
			process.exit(1);
		}
	});
}
