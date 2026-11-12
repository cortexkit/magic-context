import { createRequire } from "node:module";
import { join } from "node:path";
import { listOpenFiles } from "../../../plugin/src/shared/test-open-files";

interface OmpLogger {
	setTransports(options: { file: string }): void;
	info(message: string): void;
}

interface LoggerBinding {
	logger: OmpLogger;
	module: string;
	aliases: [string, ...string[]];
}

const require = createRequire(import.meta.url);

async function loggerBindings(
	aliases: readonly string[],
): Promise<LoggerBinding[]> {
	const instances = new Map<OmpLogger["setTransports"], LoggerBinding>();
	for (const alias of aliases) {
		const hostRequire = createRequire(require.resolve(`${alias}/package.json`));
		const module = hostRequire.resolve("@oh-my-pi/pi-utils/logger.js");
		const logger = (await import(module)) as OmpLogger;
		const previous = instances.get(logger.setTransports);
		if (previous) previous.aliases.push(alias);
		else
			instances.set(logger.setTransports, { logger, module, aliases: [alias] });
	}
	return [...instances.values()];
}

// OMP's env loader can call refreshDirsFromEnv() after HOME is restored, so
// import sandboxing alone cannot contain later logs. AI and coding-agent aliases
// can resolve distinct peer-installed pi-utils instances; pin each actual logger.
export async function pinOmpLoggerFiles(
	root: string,
	aliases: readonly string[],
): Promise<void> {
	for (const binding of await loggerBindings(aliases)) {
		const directory = join(root, "omp-logs", binding.aliases[0]);
		binding.logger.setTransports({ file: directory });
		console.log(
			"OMP fixture logger pin:",
			JSON.stringify({
				aliases: binding.aliases,
				module: binding.module,
				directory,
			}),
		);
	}
}

export async function exerciseOmpLoggerFiles(
	aliases: readonly string[],
): Promise<void> {
	for (const binding of await loggerBindings(aliases)) {
		binding.logger.info(
			`OMP fixture file logging probe: ${binding.aliases.join(", ")}`,
		);
	}
	// These pinned versions buffer file output for up to one second. Let their
	// real sinks write before inspecting descriptors, including older Winston sinks.
	await Bun.sleep(1_100);
}

export function reportOmpLogDescriptors(): void {
	if (process.platform !== "linux") return;
	const inventory = listOpenFiles();
	// A missing inventory must not silently omit the fixture's descriptor evidence.
	if (!inventory.available) throw new Error(inventory.reason);
	for (const line of inventory.paths) {
		if (/\/omp\.[^/\s]*\.log(?:\s|\.|$)/.test(line))
			console.log("OMP fixture log descriptor:", line);
	}
}
