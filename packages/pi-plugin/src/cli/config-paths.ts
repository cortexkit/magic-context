import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Pi stores agent settings, packages, sessions, and user-level extension
 * configuration under ~/.pi/agent by default. The Pi CLI documents
 * PI_CODING_AGENT_DIR as the override for this directory.
 */
export function getPiAgentConfigDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR?.trim();
	if (envDir) return envDir;
	return join(homedir(), ".pi", "agent");
}

export function getPiUserConfigPath(): string {
	return join(getPiAgentConfigDir(), "magic-context.jsonc");
}

/**
 * Pi's `pi install <source>` command persists extension package sources in
 * the `packages` array inside ~/.pi/agent/settings.json. Keep the historical
 * exported name requested by the setup wizard task, but point it at the actual
 * Pi settings file rather than a non-existent extensions.json.
 */
export function getPiUserExtensionsPath(): string {
	return join(getPiAgentConfigDir(), "settings.json");
}
