/// <reference types="bun-types" />

/**
 * Rust mode: the classify dreamer task under `historian.runner: "host"`.
 *
 * Classify used to ride the module's runner route to Broca. Under the host runner
 * the module declares no Broca route at boot and its producer factory has no
 * target, so every classify attempt failed with "host historian runner does not
 * use a subc module route". Classify now runs the way the historian does under
 * that runner: the module answers `host_completion_required` with the system
 * prompt, the host runs the completion on its own carrier, and the module checks
 * and records the text the host sends back under the same command id.
 *
 * This drives classify through the real module under the Broca runner the stack
 * names (the module runs it), after restarting the module with the host runner
 * configured in its user tier, and after restarting it with no runner configured,
 * where an OpenCode 1 or OpenCode 2 route gets the host runner by default. On the
 * host paths the test stands in for the host's carrier.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { RustTestHarness } from "../src/rust-harness";
import { rustPrereqs } from "../src/rust-scenario-support";

interface PoolItem {
	memory_id: number;
	content_hash: string;
}

function normalizedHash(content: string): string {
	return createHash("sha256")
		.update(content.trim().toLowerCase())
		.digest("hex");
}

function classifyPrompt(
	project: string,
	items: PoolItem[],
	park: boolean,
): string {
	return [
		"## Task: Classify Project Memories",
		"",
		`**Project:** ${project}`,
		"",
		"Score EVERY memory in the pool below. Emit one <classify> manifest covering every id.",
		"",
		"### Memory pool to classify",
		items
			.map(
				(item) =>
					`[${item.memory_id}] ARCHITECTURE (current: importance=50 scope=project shareable=false)\n` +
					`classify lane row ${park ? `${"hermetic-broca-pause-this-run"} ` : ""}${item.memory_id}`,
			)
			.join("\n\n"),
	].join("\n");
}

describe.skipIf(!rustPrereqs.ok)(
	"rust classify under the host historian runner",
	() => {
		let h: RustTestHarness;
		let sessionId: string;
		let projectIdentity: string;
		let contextStoreUuid: string;
		let authorityGeneration: number;
		let items: PoolItem[];

		beforeEach(async () => {
			h = await RustTestHarness.create({
				startInTsMode: true,
				magicContextConfig: {
					memory: { enabled: true, injection_budget_tokens: 4_000 },
				},
			});
			sessionId = await h.createSession();

			// One tool-driven write mints the project's memory rows; the rest are seeded
			// directly so the pool is large enough to be a realistic classify batch.
			let bootstrapWrite = false;
			h.mock.addMatcher((body) => {
				if (
					bootstrapWrite ||
					!JSON.stringify(body.system ?? "").includes("## Magic Context")
				) {
					return null;
				}
				const tools = Array.isArray(body.tools) ? body.tools : [];
				const memoryTool = tools.find(
					(tool) =>
						tool !== null &&
						typeof tool === "object" &&
						(tool as { name?: unknown }).name === "ctx_memory",
				) as { name: string } | undefined;
				if (!memoryTool) return null;
				bootstrapWrite = true;
				return {
					content: [
						{
							type: "tool_use",
							id: "toolu_classify_lane_bootstrap",
							name: memoryTool.name,
							input: {
								action: "write",
								category: "ARCHITECTURE",
								content: "classify lane corpus row 0",
							},
						},
					],
					stop_reason: "tool_use",
					usage: {
						input_tokens: 100,
						output_tokens: 10,
						cache_creation_input_tokens: 100,
					},
				};
			});
			await h.sendPrompt(sessionId, "initialize the TypeScript memory store");
			expect(bootstrapWrite).toBe(true);

			const contextDbPath = join(
				h.env.dataDir,
				"cortexkit",
				"magic-context",
				"context.db",
			);
			const seedDb = new Database(contextDbPath);
			try {
				const projectRow = seedDb
					.prepare("SELECT project_path FROM memories ORDER BY id LIMIT 1")
					.get() as { project_path?: string } | undefined;
				projectIdentity = projectRow?.project_path ?? "";
				expect(projectIdentity).toBeTruthy();
				seedDb.transaction(() => {
					const insert = seedDb.prepare(
						`INSERT INTO memories(
                        project_path, category, content, normalized_hash, importance, scope,
                        shareable, source_session_id, source_type, seen_count, retrieval_count,
                        first_seen_at, created_at, updated_at, last_seen_at, status,
                        verification_status
                    ) VALUES (?, 'ARCHITECTURE', ?, ?, NULL, 'project', 0, ?, 'agent', 1, 0,
                        ?, ?, ?, ?, 'active', 'unverified')`,
					);
					for (let index = 1; index < 12; index += 1) {
						const content = `classify lane corpus row ${index}`;
						const now = 1_800_000_000_000 + index;
						insert.run(
							projectIdentity,
							content,
							normalizedHash(content),
							sessionId,
							now,
							now,
							now,
							now,
						);
					}
				})();
				const uuidRow = seedDb
					.prepare(
						"SELECT value FROM context_store_meta WHERE key = 'store_uuid'",
					)
					.get() as { value?: string } | undefined;
				contextStoreUuid = uuidRow?.value ?? "";
				expect(contextStoreUuid).toBeTruthy();
			} finally {
				seedDb.close();
			}

			// Rust mode mirrors the corpus into the module store and flips memories authority.
			await h.restart({ rust: true });
			await h.sendPrompt(
				sessionId,
				"activate Rust authority for the classify lane corpus",
			);
			await h.waitForRustPasses(1);

			const status = await h.subc.moduleRequest(sessionId, h.env.workdir, {
				method: "authority.status",
				context_store_uuid: contextStoreUuid,
				project: projectIdentity,
				domain: "memories",
			});
			const authority = (
				status as { authority?: { state?: string; generation?: number } }
			).authority;
			expect(authority?.state).toBe("MODULE");
			authorityGeneration = authority?.generation ?? -1;

			const moduleDb = new Database(
				join(h.env.dataDir, "cortexkit", "magic-context", "store.db"),
				{ readonly: true },
			);
			try {
				items = (
					moduleDb
						.prepare(
							"SELECT id, normalized_hash FROM mc_memories WHERE project_path = ? AND status = 'active' ORDER BY id",
						)
						.all(projectIdentity) as Array<{
						id: number;
						normalized_hash: string;
					}>
				).map((row) => ({
					memory_id: row.id,
					content_hash: row.normalized_hash,
				}));
			} finally {
				moduleDb.close();
			}
			expect(items.length).toBeGreaterThan(1);
		});

		afterEach(async () => {
			await h?.dispose();
		});

		const runTask = (
			park: boolean,
			modelChain: string[],
			hostCompletion?: Record<string, unknown>,
			commandId = `classify:lane:${park ? "park" : "clean"}:${Date.now()}`,
		) =>
			h.subc.moduleRequest(sessionId, h.env.workdir, {
				method: "dreamer.run_task",
				task: "classify",
				command_id: commandId,
				authority_generation: authorityGeneration,
				model_chain: modelChain,
				payload: {
					prompt_body: classifyPrompt(projectIdentity, items, park),
					items,
				},
				...(hostCompletion ? { host_completion: hostCompletion } : {}),
			});

		it("runs classify on the host by default for OpenCode 1 and OpenCode 2 routes", async () => {
			// No runner in the module's user tier at all: the route's harness decides.
			writeFileSync(h.subc.moduleConfigPath, "{}");
			await h.subc.restartModule();
			const producerRunsBefore = h.subc.producerRequestCount();

			const manifest = `<classify>\n${items
				.map(
					(item) =>
						`<memory id="${item.memory_id}" importance="55" scope="project" shareable="false"/>`,
				)
				.join("\n")}\n</classify>`;
			for (const harness of ["opencode", "opencode2"]) {
				const commandId = `classify:lane:default:${harness}:${Date.now()}`;
				const request = (hostCompletion?: Record<string, unknown>) =>
					h.subc.moduleRequest(
						sessionId,
						h.env.workdir,
						{
							method: "dreamer.run_task",
							task: "classify",
							command_id: commandId,
							authority_generation: authorityGeneration,
							model_chain: ["mock-anthropic/mock-sonnet"],
							payload: {
								prompt_body: classifyPrompt(projectIdentity, items, false),
								items,
							},
							...(hostCompletion ? { host_completion: hostCompletion } : {}),
						},
						harness,
					);
				const asked = (await request()) as { ok?: boolean; code?: string };
				// Broca is registered and reachable here, so this answer is the default
				// choosing the host, not a fallback from a missing route.
				expect(asked.ok).toBe(false);
				expect(asked.code).toBe("host_completion_required");
				const after = (await request({
					text: manifest,
					model: "mock-anthropic/mock-sonnet",
				})) as { ok?: boolean; diagnostics?: { runner?: string } };
				expect(after.ok).toBe(true);
				expect(after.diagnostics?.runner).toBe("host");

				const status = (await h.subc.moduleRequest(
					sessionId,
					h.env.workdir,
					{ method: "session.status" },
					harness,
				)) as { dreamer?: { runner?: Record<string, unknown> } };
				console.log(`dreamer runner on ${harness}: ${JSON.stringify(status.dreamer)}`);
				expect(status.dreamer?.runner).toEqual({
					runner: "host",
					source: "default_for_harness",
					harness,
					observed: "last_completion",
				});
			}
			// Nothing went to Broca on either harness.
			expect(h.subc.producerRequestCount()).toBe(producerRunsBefore);
		}, 300_000);

		it("still classifies after the module restarts with historian.runner = host", async () => {
			const before = (await runTask(false, ["mock-anthropic/mock-sonnet"])) as {
				ok?: boolean;
			};
			expect(before.ok).toBe(true);

			const moduleConfigDir = join(h.env.dataDir, "module-config", "cortexkit");
			mkdirSync(moduleConfigDir, { recursive: true });
			writeFileSync(
				join(moduleConfigDir, "magic-context.jsonc"),
				JSON.stringify({ historian: { runner: "host" } }),
			);
			await h.subc.restartModule();

			const commandId = `classify:lane:host:${Date.now()}`;
			const asked = (await runTask(
				false,
				["mock-anthropic/mock-sonnet"],
				undefined,
				commandId,
			)) as { ok?: boolean; code?: string; system_prompt?: string };
			console.log(
				`classify under historian.runner=host, first answer: ${JSON.stringify({ ...asked, system_prompt: asked.system_prompt?.slice(0, 60) })}`,
			);
			// The module no longer attempts a route it does not have: it asks the host.
			expect(asked.ok).toBe(false);
			expect(asked.code).toBe("host_completion_required");
			expect(asked.system_prompt).toContain("memory classifier");

			// The host's carrier answers with a manifest covering the pool.
			const manifest = `<classify>\n${items
				.map(
					(item) =>
						`<memory id="${item.memory_id}" importance="60" scope="project" shareable="false"/>`,
				)
				.join("\n")}\n</classify>`;
			let after: unknown;
			try {
				after = await runTask(
					false,
					["mock-anthropic/mock-sonnet"],
					{ text: manifest, model: "mock-anthropic/mock-sonnet" },
					commandId,
				);
			} catch (error) {
				after = {
					ok: false,
					error: (error as { message?: string }).message ?? String(error),
				};
			}
			console.log(
				`classify under historian.runner=host: ${JSON.stringify(after).slice(0, 600)}`,
			);
			const classifyLines = h.subc
				.moduleLog()
				.split("\n")
				.filter((line) => line.includes("classify attempt="))
				.slice(-2);
			console.log(`module classify lines: ${classifyLines.join(" | ")}`);
			expect((after as { ok?: boolean }).ok).toBe(true);
			expect((after as { manifest_text?: string }).manifest_text).toBe(manifest);
			expect(
				(after as { diagnostics?: { runner?: string } }).diagnostics?.runner,
			).toBe("host");
			expect(classifyLines.at(-1)).toContain("session=host outcome=manifest");
		}, 300_000);
	},
);
