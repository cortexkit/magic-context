import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	awaitPluginActivation,
	type PluginActivationClient,
} from "./plugin-activation";

const bundles = new Map<string, Promise<string>>();

export async function requireSchemaGuard(
	client: PluginActivationClient,
	directory: string,
): Promise<void> {
	await awaitPluginActivation(
		client,
		directory,
		"mc-e2e-llm-schema-guard",
		60_000,
	);
}

export function schemaGeneration(version: string, externalVersion?: string): "2.0" | "2.1" | "2.2" {
	if (/^opencode v2\.0\.\d+$/.test(version)) return "2.0";
	if (version === "opencode v2.1.0") return "2.1";
	if (/^opencode v2\.2\.\d+$/.test(version) && version === `opencode v${externalVersion}`) return "2.2";
	throw new Error(`No e2e LLM schema bundle for ${version}`);
}

/** Bundle the LLM message-schema validator with its matching Effect dependencies.
 * The host forbids foreign Effect imports from plugins; no such imports remain
 * in this bundle. Media is converted only on the oracle's detached checking copy.
 */
export async function prepareSchemaGuard(
	cli: string,
	root: string,
	env: NodeJS.ProcessEnv,
): Promise<string> {
	const probe = spawnSync(cli, ["--version"], { encoding: "utf8", env });
	if (probe.status !== 0)
		throw new Error(`Cannot select LLM schema: ${probe.stderr}`);
	// An unpinned compatibility CLI must bring its exact schema dependency, not
	// silently reuse the older pinned schema dependency or skip schema validation.
	const externalRoot = process.env.MC_E2E_OPENCODE2_AI_ROOT;
	const externalVersion = externalRoot ? JSON.parse(readFileSync(join(externalRoot, "node_modules/@opencode/ai/package.json"), "utf8")).version as string : undefined;
	const generation = schemaGeneration(probe.stdout.trim(), externalVersion);
	const bundleKey = `${probe.stdout.trim()}:${externalRoot ?? "pinned"}`;
	let bundle = bundles.get(bundleKey);
	if (!bundle) {
		bundle = (async () => {
			const module = generation === "2.1" ? "@opencode/ai-2-1" : "@opencode/ai";
			const result = await Bun.build({
				entrypoints: [join(import.meta.dir, "schema-guard/server.js")],
				target: "bun",
				plugins: [
					{
						name: "host-schema",
						setup(build) {
							build.onResolve({ filter: /^@opencode\/ai\// }, ({ path }) => ({
								path: Bun.resolveSync(
									generation === "2.2" && externalRoot
										? join(externalRoot, "node_modules/@opencode/ai/dist", `${path.slice("@opencode/ai/".length)}.js`)
										: path.replace("@opencode/ai", module),
									import.meta.dir,
								),
							}));
						},
					},
				],
			});
			if (!result.success)
				throw new AggregateError(result.logs, "LLM schema bundle failed");
			return result.outputs[0]!.text();
		})();
		bundles.set(bundleKey, bundle);
	}
	const directory = join(root, "schema-guard");
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "server.js"), await bundle);
	return directory;
}
