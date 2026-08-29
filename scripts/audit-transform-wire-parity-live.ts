#!/usr/bin/env bun

/**
 * Read-only live-state probe for audit-transform-wire-parity.py --live.
 *
 * Every SQLite handle is opened with `{ readonly: true }` and query_only is
 * verified before any evidence query. Live prose stays in process memory: the
 * JSON response contains only counts, ordinals, hashes, byte lengths, fixed
 * field/class names, and eight-character session prefixes.
 */

import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cavemanCompress } from "../packages/plugin/src/hooks/magic-context/caveman";
import { computeTargetDepth } from "../packages/plugin/src/hooks/magic-context/caveman-cleanup";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUST_SESSIONS = [
	"ses_0ad83017cffexe0g5N8UG0y3LZ",
	"ses_08df2045bffeBcWcqw60elghER",
];
const FIXED_SELF_CAUSED_REASONS = [
	"tool_set_hash",
	"project_docs_hash",
	"max_compartment_seq",
	"project_user_profile_version",
	"temporal_parity",
];

type Row = Record<string, unknown>;
type Lane = "rust" | "ts";

interface Options {
	contextDb: string;
	storeDb: string;
	storeRoot: string;
	opencodeDb: string;
	piSessionDir: string;
	rpcRoot: string;
	afterMs: number;
	engineAfterMs: number;
	skipRpc: boolean;
	skipRustOracle: boolean;
	captureSessionHashes: string[];
}

function parseArgs(argv: string[]): Options {
	const values = new Map<string, string>();
	const flags = new Set<string>();
	for (let index = 0; index < argv.length; index += 1) {
		const name = argv[index];
		if (name === "--skip-rpc" || name === "--skip-rust-oracle") {
			flags.add(name);
			continue;
		}
		const value = argv[index + 1];
		if (!name?.startsWith("--") || !value)
			throw new Error(`missing value for ${name}`);
		values.set(name, value);
		index += 1;
	}
	const required = (name: string): string => {
		const value = values.get(name);
		if (!value) throw new Error(`missing ${name}`);
		return value;
	};
	const afterMs = Number(required("--after-ms"));
	const engineAfterMs = Number(values.get("--engine-after-ms") ?? afterMs);
	if (!Number.isFinite(afterMs))
		throw new Error("--after-ms must be an epoch millisecond");
	if (!Number.isFinite(engineAfterMs)) {
		throw new Error("--engine-after-ms must be an epoch millisecond");
	}
	return {
		contextDb: required("--context-db"),
		storeDb: required("--store-db"),
		storeRoot: required("--store-root"),
		opencodeDb: required("--opencode-db"),
		piSessionDir: required("--pi-session-dir"),
		rpcRoot: required("--rpc-root"),
		afterMs,
		engineAfterMs,
		skipRpc: flags.has("--skip-rpc"),
		skipRustOracle: flags.has("--skip-rust-oracle"),
		captureSessionHashes: (values.get("--capture-session-hashes") ?? "")
			.split(",")
			.map((value) => value.trim())
			.filter(Boolean),
	};
}

function openReadonly(path: string): Database {
	const db = new Database(path, { readonly: true });
	db.exec("PRAGMA query_only = ON");
	const row = db.query("PRAGMA query_only").get() as Row | null;
	if (!row || Number(Object.values(row)[0]) !== 1) {
		db.close();
		throw new Error("SQLite query_only verification failed");
	}
	return db;
}

function tableExists(db: Database, table: string): boolean {
	return Boolean(
		db
			.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
			.get(table),
	);
}

function columns(db: Database, table: string): Set<string> {
	if (!tableExists(db, table)) return new Set();
	const quoted = table.replaceAll('"', '""');
	return new Set(
		(db.query(`PRAGMA table_info("${quoted}")`).all() as Row[]).map((row) =>
			String(row.name),
		),
	);
}

function count(
	db: Database,
	sql: string,
	...parameters: Array<string | number | bigint | boolean | null | Uint8Array>
): number {
	const row = db.query(sql).get(...parameters) as Row | null;
	return Number(row ? Object.values(row)[0] : 0) || 0;
}

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function fingerprint(
	value: string | Uint8Array | null | undefined,
): Record<string, unknown> {
	if (value === null || value === undefined)
		return { present: false, bytes: 0 };
	const bytes =
		typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
	return { present: true, sha256: sha256(bytes), bytes: bytes.byteLength };
}

function sessionPrefix(sessionId: string): string {
	return sessionId.slice(0, 8);
}

function projectFingerprint(projectPath: string): string {
	return sha256(projectPath).slice(0, 12);
}

function configuredLane(projectPath: string): Lane | "unverified" {
	try {
		const text = readFileSync(
			join(projectPath, ".cortexkit", "magic-context.jsonc"),
			"utf8",
		);
		return /"transform_mode"\s*:\s*"rust"/.test(text) ? "rust" : "ts";
	} catch {
		return "unverified";
	}
}

function bindingLane(
	context: Database,
	projectPath: string,
): Lane | "unverified" {
	if (
		tableExists(context, "authority_managed") &&
		context
			.query("SELECT 1 FROM authority_managed WHERE project_path = ?")
			.get(projectPath)
	) {
		return "rust";
	}
	const configured = configuredLane(projectPath);
	return configured === "unverified" ? "ts" : configured;
}

function safeJson(value: unknown): Row {
	if (value && typeof value === "object" && !Array.isArray(value))
		return value as Row;
	if (typeof value !== "string") return {};
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? parsed
			: {};
	} catch {
		return {};
	}
}

function listFiles(root: string, suffix: string): string[] {
	const files: string[] = [];
	const walk = (directory: string): void => {
		let entries: Dirent[];
		try {
			entries = readdirSync(directory, {
				withFileTypes: true,
				encoding: "utf8",
			});
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.isFile() && entry.name.endsWith(suffix)) files.push(path);
		}
	};
	walk(root);
	return files.sort();
}

function bindingRows(
	context: Database,
): Array<{ sessionId: string; projectPath: string; updatedAt: number }> {
	if (!tableExists(context, "session_projects")) return [];
	return (
		context
			.query(
				"SELECT session_id, project_path, updated_at FROM session_projects WHERE harness = 'opencode' ORDER BY updated_at DESC",
			)
			.all() as Row[]
	).map((row) => ({
		sessionId: String(row.session_id ?? ""),
		projectPath: String(row.project_path ?? ""),
		updatedAt: Number(row.updated_at ?? 0),
	}));
}

function opencodeBindingRows(
	opencode: Database,
): Array<{ sessionId: string; projectPath: string; updatedAt: number }> {
	const sessionColumns = columns(opencode, "session");
	if (!sessionColumns.has("id")) return [];
	if (sessionColumns.has("directory")) {
		return (opencode.query("SELECT id, directory FROM session").all() as Row[])
			.filter((row) => typeof row.directory === "string" && row.directory.length > 0)
			.map((row) => ({
				sessionId: String(row.id ?? ""),
				projectPath: String(row.directory),
				updatedAt: 0,
			}));
	}
	if (sessionColumns.has("data")) {
		return (opencode.query("SELECT id, data FROM session").all() as Row[])
			.map((row) => ({ row, data: safeJson(row.data) }))
			.filter(({ data }) => typeof data.directory === "string" && data.directory.length > 0)
			.map(({ row, data }) => ({
				sessionId: String(row.id ?? ""),
				projectPath: String(data.directory),
				updatedAt: 0,
			}));
	}
	return [];
}

function captureLaneCoordinates(
	bindings: ReturnType<typeof bindingRows>,
	requestedHashes: string[],
): Record<string, unknown> {
	const bindingsByHash = new Map<string, ReturnType<typeof bindingRows>>();
	for (const binding of bindings) {
		const sessionHash = sha256(binding.sessionId).slice(0, 12);
		const rows = bindingsByHash.get(sessionHash) ?? [];
		rows.push(binding);
		bindingsByHash.set(sessionHash, rows);
	}

	const rows: Row[] = [];
	const ambiguousHashes: string[] = [];
	const unresolvedHashes: string[] = [];
	for (const sessionHash of [...new Set(requestedHashes)].sort()) {
		const matches = bindingsByHash.get(sessionHash) ?? [];
		const sessionIds = new Set(matches.map((row) => row.sessionId));
		if (sessionIds.size > 1) {
			ambiguousHashes.push(sessionHash);
			continue;
		}
		const resolved = matches
			.map((binding) => ({ binding, lane: configuredLane(binding.projectPath) }))
			.filter(({ lane }) => lane !== "unverified");
		const lanes = new Set(resolved.map(({ lane }) => lane));
		if (lanes.size > 1) {
			ambiguousHashes.push(sessionHash);
			continue;
		}
		const coordinate = resolved[0];
		if (!coordinate) {
			unresolvedHashes.push(sessionHash);
			continue;
		}
		rows.push({
			session_hash: sessionHash,
			lane: coordinate.lane,
			project_hash: projectFingerprint(coordinate.binding.projectPath),
		});
	}
	return {
		requested_hashes: new Set(requestedHashes).size,
		resolved_hashes: rows.length,
		rows,
		ambiguous_hashes: ambiguousHashes,
		unresolved_hashes: unresolvedHashes,
		rule: "collision-free twelve-character session hash joined to a live session-project binding and readable project config",
	};
}

function engineEvidence(
	context: Database,
	store: Database,
	bindings: ReturnType<typeof bindingRows>,
	afterMs: number,
): Record<string, unknown> {
	const bySession = new Map(bindings.map((row) => [row.sessionId, row]));
	const sessions = RUST_SESSIONS.map((sessionId) => {
		const binding = bySession.get(sessionId);
		const projectPath = binding?.projectPath ?? "";
		const compartmentTotal = tableExists(context, "compartments")
			? count(
					context,
					"SELECT COUNT(*) FROM compartments WHERE session_id = ?",
					sessionId,
				)
			: 0;
		const compartmentSince = tableExists(context, "compartments")
			? count(
					context,
					"SELECT COUNT(*) FROM compartments WHERE session_id = ? AND created_at >= ?",
					sessionId,
					afterMs,
				)
			: 0;
		const compartmentVectorCoverageTotal =
			tableExists(context, "compartments") &&
			tableExists(context, "compartment_chunk_embeddings")
				? (context
						.query(
							`SELECT COUNT(*) AS rows,
                                  COUNT(DISTINCT CASE WHEN e.compartment_id IS NOT NULL THEN c.id END) AS covered
                             FROM compartments c
                             LEFT JOIN compartment_chunk_embeddings e ON e.compartment_id = c.id
                            WHERE c.session_id = ?`,
						)
						.get(sessionId) as Row)
				: { rows: compartmentTotal, covered: 0 };
		const compartmentVectorCoverage =
			tableExists(context, "compartments") &&
			tableExists(context, "compartment_chunk_embeddings")
				? (context
						.query(
							`SELECT COUNT(*) AS rows,
                                  COUNT(DISTINCT CASE WHEN e.compartment_id IS NOT NULL THEN c.id END) AS covered
                             FROM compartments c
                             LEFT JOIN compartment_chunk_embeddings e ON e.compartment_id = c.id
                            WHERE c.session_id = ? AND c.created_at >= ?`,
						)
						.get(sessionId, afterMs) as Row)
				: { rows: compartmentSince, covered: 0 };
		const memoryStatusFilter = columns(context, "memories").has("status")
			? " AND status = 'active'"
			: "";
		const memoryTotal = tableExists(context, "memories")
			? count(
					context,
					`SELECT COUNT(*) FROM memories WHERE source_session_id = ?${memoryStatusFilter}`,
					sessionId,
				)
			: 0;
		const memorySince = tableExists(context, "memories")
			? count(
					context,
					`SELECT COUNT(*) FROM memories WHERE source_session_id = ? AND created_at >= ?${memoryStatusFilter}`,
					sessionId,
					afterMs,
				)
			: 0;
		const memoryVectorCoverageTotal =
			tableExists(context, "memories") &&
			tableExists(context, "memory_embeddings")
				? (context
						.query(
							`SELECT COUNT(*) AS rows,
                                  COUNT(DISTINCT CASE WHEN e.memory_id IS NOT NULL THEN m.id END) AS covered
                             FROM memories m
                             LEFT JOIN memory_embeddings e ON e.memory_id = m.id
                            WHERE m.source_session_id = ?${memoryStatusFilter.replace("status", "m.status")}`,
						)
						.get(sessionId) as Row)
				: { rows: memoryTotal, covered: 0 };
		const memoryVectorCoverage =
			tableExists(context, "memories") &&
			tableExists(context, "memory_embeddings")
				? (context
						.query(
							`SELECT COUNT(*) AS rows,
                                  COUNT(DISTINCT CASE WHEN e.memory_id IS NOT NULL THEN m.id END) AS covered
                             FROM memories m
                             LEFT JOIN memory_embeddings e ON e.memory_id = m.id
                            WHERE m.source_session_id = ? AND m.created_at >= ?${memoryStatusFilter.replace("status", "m.status")}`,
						)
						.get(sessionId, afterMs) as Row)
				: { rows: memorySince, covered: 0 };
		const commitRows =
			projectPath && tableExists(context, "git_commits")
				? count(
						context,
						"SELECT COUNT(*) FROM git_commits WHERE project_path = ?",
						projectPath,
					)
				: 0;
		const commitVectors =
			projectPath &&
			tableExists(context, "git_commits") &&
			tableExists(context, "git_commit_embeddings")
				? count(
						context,
						`SELECT COUNT(DISTINCT e.sha)
                         FROM git_commit_embeddings e
                         JOIN git_commits c ON c.sha = e.sha
                        WHERE c.project_path = ?`,
						projectPath,
					)
				: 0;
		const storeCompartments = tableExists(store, "mc_compartments")
			? count(
					store,
					"SELECT COUNT(*) FROM mc_compartments WHERE session_id = ?",
					sessionId,
				)
			: 0;
		const storeCompartmentsSince = tableExists(store, "mc_compartments")
			? count(
					store,
					"SELECT COUNT(*) FROM mc_compartments WHERE session_id = ? AND created_at >= ?",
					sessionId,
					afterMs,
				)
			: 0;
		return {
			session_prefix: sessionPrefix(sessionId),
			project_sha256_12: projectPath ? projectFingerprint(projectPath) : null,
			configured_lane: projectPath
				? bindingLane(context, projectPath)
				: "unverified",
			binding: {
				present: Boolean(binding),
				updated_at_ms: binding?.updatedAt ?? 0,
				repaired_since_cutoff: (binding?.updatedAt ?? 0) >= afterMs,
			},
			compartments: {
				module_total: storeCompartments,
				module_since_cutoff: storeCompartmentsSince,
				mirror_total: compartmentTotal,
				mirror_since_cutoff: compartmentSince,
				mirror_rows_with_vectors_total: Number(
					compartmentVectorCoverageTotal.covered ?? 0,
				),
				mirror_rows_with_vectors_since_cutoff: Number(
					compartmentVectorCoverage.covered ?? 0,
				),
			},
			memories: {
				mirror_total: memoryTotal,
				mirror_since_cutoff: memorySince,
				mirror_rows_with_vectors_total: Number(
					memoryVectorCoverageTotal.covered ?? 0,
				),
				mirror_rows_with_vectors_since_cutoff: Number(
					memoryVectorCoverage.covered ?? 0,
				),
			},
			commit_index: { rows: commitRows, rows_with_vectors: commitVectors },
		};
	});
	return {
		cutoff_ms: afterMs,
		sessions,
		unexplained_invariants: sessions.flatMap((row) => {
			const result: string[] = [];
			const compartments = row.compartments as Row;
			const memories = row.memories as Row;
			if (
				Number(compartments.mirror_since_cutoff) >
				Number(compartments.mirror_rows_with_vectors_since_cutoff)
			) {
				result.push(
					"post_cutoff_rust_compartments_without_complete_vector_coverage",
				);
			}
			if (
				Number(memories.mirror_since_cutoff) >
				Number(memories.mirror_rows_with_vectors_since_cutoff)
			) {
				result.push(
					"post_cutoff_rust_memories_without_complete_vector_coverage",
				);
			}
			if (!(row.binding as Row).present)
				result.push("rust_session_project_binding_absent");
			return result.map((className) => ({
				session_prefix: row.session_prefix,
				class: className,
			}));
		}),
	};
}

interface CavemanInput {
	key: string;
	text: string;
	lane: Lane;
	sessionId: string;
	tagOrdinal: number;
	persistedDepth: number;
}

function inferEligibleTotal(rows: Row[]): Record<string, unknown> {
	const actual = new Map<number, number>([
		[
			1,
			rows.filter((row) => Number(row.depth ?? row.caveman_depth) === 1).length,
		],
		[
			2,
			rows.filter((row) => Number(row.depth ?? row.caveman_depth) === 2).length,
		],
		[
			3,
			rows.filter((row) => Number(row.depth ?? row.caveman_depth) === 3).length,
		],
	]);
	const candidates: number[] = [];
	for (
		let total = rows.length;
		total <= Math.max(rows.length, rows.length * 3);
		total += 1
	) {
		const expected = new Map<number, number>([
			[1, 0],
			[2, 0],
			[3, 0],
		]);
		for (let position = 0; position < total; position += 1) {
			const depth = computeTargetDepth(position, total);
			if (depth > 0) expected.set(depth, (expected.get(depth) ?? 0) + 1);
		}
		if ([1, 2, 3].every((depth) => expected.get(depth) === actual.get(depth))) {
			candidates.push(total);
		}
	}
	return {
		inferred_eligible_total_min: candidates[0] ?? null,
		inferred_eligible_total_max: candidates.at(-1) ?? null,
		candidate_total_count: candidates.length,
		persisted_counts_match_typescript_oracle: candidates.length > 0,
	};
}

function compressedDepthState(rows: Row[]): Record<string, unknown> {
	const sorted = [...rows].sort(
		(left, right) => Number(left.tag_number) - Number(right.tag_number),
	);
	const counts: Record<string, number> = { lite: 0, full: 0, ultra: 0 };
	const ranges: Record<
		string,
		{ min_tag_ordinal: number; max_tag_ordinal: number } | null
	> = {
		lite: null,
		full: null,
		ultra: null,
	};
	let inversions = 0;
	let previous = 4;
	for (const row of sorted) {
		const depth = Number(row.depth ?? row.caveman_depth ?? 0);
		if (depth > previous) inversions += 1;
		previous = depth;
		const name =
			depth === 1
				? "lite"
				: depth === 2
					? "full"
					: depth === 3
						? "ultra"
						: null;
		if (!name) continue;
		counts[name] += 1;
		const tag = Number(row.tag_number);
		const range = ranges[name];
		ranges[name] = range
			? {
					min_tag_ordinal: Math.min(range.min_tag_ordinal, tag),
					max_tag_ordinal: Math.max(range.max_tag_ordinal, tag),
				}
			: { min_tag_ordinal: tag, max_tag_ordinal: tag };
	}
	return {
		counts,
		ranges,
		ordering_inversions: inversions,
		boundary_oracle: inferEligibleTotal(sorted),
	};
}

function tsCavemanCandidate(
	context: Database,
	bindings: ReturnType<typeof bindingRows>,
): {
	sessionId: string;
	rows: Row[];
	samples: CavemanInput[];
} | null {
	if (
		!columns(context, "tags").has("caveman_depth") ||
		!tableExists(context, "source_contents")
	) {
		return null;
	}
	const projects = new Map(
		bindings.map((row) => [row.sessionId, row.projectPath]),
	);
	const candidates = context
		.query(
			`SELECT session_id, COUNT(*) AS rows, COUNT(DISTINCT caveman_depth) AS depths
               FROM tags
              WHERE type = 'message' AND status = 'active' AND caveman_depth BETWEEN 1 AND 3
              GROUP BY session_id
             HAVING depths = 3
              ORDER BY rows DESC`,
		)
		.all() as Row[];
	for (const candidate of candidates) {
		const sessionId = String(candidate.session_id);
		const projectPath = projects.get(sessionId);
		if (!projectPath || bindingLane(context, projectPath) !== "ts") continue;
		const rows = context
			.query(
				`SELECT t.tag_number, t.caveman_depth AS depth, s.content
                   FROM tags t
                   JOIN source_contents s ON s.session_id = t.session_id AND s.tag_id = t.tag_number
                  WHERE t.session_id = ? AND t.type = 'message' AND t.status = 'active'
                    AND t.caveman_depth BETWEEN 1 AND 3
                  ORDER BY t.tag_number`,
			)
			.all(sessionId) as Row[];
		const samples: CavemanInput[] = [];
		for (const depth of [3, 2, 1]) {
			const row = rows.find(
				(value) =>
					Number(value.depth) === depth && typeof value.content === "string",
			);
			if (!row) continue;
			samples.push({
				key: `ts-${depth}`,
				text: String(row.content),
				lane: "ts",
				sessionId,
				tagOrdinal: Number(row.tag_number),
				persistedDepth: depth,
			});
		}
		if (samples.length === 3) return { sessionId, rows, samples };
	}
	return null;
}

function rustCavemanCandidate(
	context: Database,
	store: Database,
	bindings: ReturnType<typeof bindingRows>,
): {
	sessionId: string;
	rows: Row[];
	samples: CavemanInput[];
} | null {
	if (!tableExists(store, "mc_cache_state") || !tableExists(store, "mc_tags"))
		return null;
	const projectBySession = new Map(
		bindings.map((row) => [row.sessionId, row.projectPath]),
	);
	for (const sessionId of RUST_SESSIONS) {
		if (bindingLane(context, projectBySession.get(sessionId) ?? "") !== "rust")
			continue;
		const state = store
			.query("SELECT core_state FROM mc_cache_state WHERE session_id = ?")
			.get(sessionId) as Row | null;
		const core = safeJson(state?.core_state);
		const units = Array.isArray(core.frozen_units)
			? (core.frozen_units as Row[])
			: [];
		const depthByBlock = new Map<string, number>();
		for (const unit of units) {
			const key = String(unit.key ?? "");
			if (!key.startsWith("cav:")) continue;
			const depth = Number(unit.reset_rule ?? 0);
			if (depth >= 1 && depth <= 3)
				depthByBlock.set(key.slice("cav:".length), depth);
		}
		if (new Set(depthByBlock.values()).size < 3) continue;
		const rows: Array<Row & { depth: number | undefined }> = (
			store
				.query(
					"SELECT tag_number, block_id, source_bytes FROM mc_tags WHERE session_id = ? AND kind = 'message' ORDER BY tag_number",
				)
				.all(sessionId) as Row[]
		)
			.filter((row) => depthByBlock.has(String(row.block_id)))
			.map((row) => ({
				...row,
				depth: depthByBlock.get(String(row.block_id)),
			}));
		const samples: CavemanInput[] = [];
		for (const depth of [3, 2, 1]) {
			const row = rows.find((value) => Number(value.depth) === depth);
			const bytes = row?.source_bytes;
			if (!(bytes instanceof Uint8Array)) continue;
			let text: string;
			try {
				text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			} catch {
				continue;
			}
			samples.push({
				key: `rust-${depth}`,
				text,
				lane: "rust",
				sessionId,
				tagOrdinal: Number(row?.tag_number),
				persistedDepth: depth,
			});
		}
		if (samples.length === 3) return { sessionId, rows, samples };
	}
	return null;
}

function rustCavemanFingerprints(cases: CavemanInput[], skip: boolean): Row {
	if (skip) return { status: "skipped", cases: [] };
	const completed = spawnSync(
		"cargo",
		["run", "--quiet", "-p", "mc-module", "--bin", "mc-caveman-live-differ"],
		{
			cwd: ROOT,
			input: JSON.stringify({
				cases: cases.map(({ key, text }) => ({ key, text })),
			}),
			encoding: "utf8",
			maxBuffer: 8 * 1024 * 1024,
		},
	);
	if (completed.status !== 0) {
		const stderr = completed.stderr ?? "";
		return {
			status: "failed",
			stderr_sha256: sha256(stderr),
			stderr_bytes: Buffer.byteLength(stderr),
			cases: [],
		};
	}
	return { status: "ok", ...safeJson(completed.stdout) };
}

function cavemanEvidence(
	context: Database,
	store: Database,
	bindings: ReturnType<typeof bindingRows>,
	skipRustOracle: boolean,
): Record<string, unknown> {
	const projectBySession = new Map(
		bindings.map((row) => [row.sessionId, row.projectPath]),
	);
	const tsCandidateInventory =
		columns(context, "tags").has("caveman_depth") &&
		tableExists(context, "source_contents")
			? (
					context
						.query(
							`SELECT t.session_id, COUNT(*) AS rows,
                              COUNT(DISTINCT t.caveman_depth) AS depths,
                              SUM(CASE WHEN s.content IS NOT NULL THEN 1 ELSE 0 END) AS source_rows
                         FROM tags t
                         LEFT JOIN source_contents s ON s.session_id = t.session_id AND s.tag_id = t.tag_number
                        WHERE t.type = 'message' AND t.status = 'active'
                          AND t.caveman_depth BETWEEN 1 AND 3
                        GROUP BY t.session_id ORDER BY rows DESC LIMIT 12`,
						)
						.all() as Row[]
				).map((row) => ({
					session_prefix: sessionPrefix(String(row.session_id)),
					lane: bindingLane(
						context,
						projectBySession.get(String(row.session_id)) ?? "",
					),
					rows: Number(row.rows),
					depths: Number(row.depths),
					source_rows: Number(row.source_rows),
				}))
			: [];
	const sessions = [
		tsCavemanCandidate(context, bindings),
		rustCavemanCandidate(context, store, bindings),
	].filter((value): value is NonNullable<typeof value> => value !== null);
	const inputs = sessions.flatMap((session) => session.samples);
	const rust = rustCavemanFingerprints(inputs, skipRustOracle);
	const rustCases = new Map(
		(Array.isArray(rust.cases) ? (rust.cases as Row[]) : []).map((row) => [
			String(row.key),
			row,
		]),
	);
	const output = sessions.map((session) => ({
		lane: session.samples[0]?.lane,
		session_prefix: sessionPrefix(session.sessionId),
		depth_state: compressedDepthState(session.rows),
		samples: session.samples.map((sample) => {
			const source = fingerprint(sample.text);
			const ts = {
				lite: fingerprint(cavemanCompress(sample.text, "lite")),
				full: fingerprint(cavemanCompress(sample.text, "full")),
				ultra: fingerprint(cavemanCompress(sample.text, "ultra")),
			};
			const rustCase = rustCases.get(sample.key) ?? {};
			const exact = ["lite", "full", "ultra"].every((level) => {
				const tsValue = ts[level as keyof typeof ts] as Row;
				const rustValue = rustCase[level] as Row | undefined;
				return (
					tsValue.sha256 === rustValue?.sha256 &&
					tsValue.bytes === rustValue?.bytes
				);
			});
			return {
				tag_ordinal: sample.tagOrdinal,
				persisted_depth: sample.persistedDepth,
				source,
				typescript: ts,
				rust: {
					lite: rustCase.lite ?? null,
					full: rustCase.full ?? null,
					ultra: rustCase.ultra ?? null,
				},
				exact_all_depths: exact,
			};
		}),
	}));
	return {
		rust_oracle_status: rust.status,
		ts_candidate_inventory: tsCandidateInventory,
		sessions: output,
		unexplained_invariants: output.flatMap((session) => {
			const result: string[] = [];
			const depthState = session.depth_state as Row;
			if (Number(depthState.ordering_inversions) > 0) {
				result.push("persisted_depth_order_inversion");
			}
			const boundaryOracle = depthState.boundary_oracle as Row;
			if (boundaryOracle.persisted_counts_match_typescript_oracle !== true) {
				result.push("persisted_depth_boundaries_differ_from_typescript_oracle");
			}
			if (session.samples.some((sample) => !sample.exact_all_depths))
				result.push("typescript_rust_compressed_bytes_differ");
			return result.map((className) => ({
				lane: session.lane,
				session_prefix: session.session_prefix,
				class: className,
			}));
		}),
	};
}

function nestedStrings(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap(nestedStrings);
	if (value && typeof value === "object")
		return Object.values(value as Row).flatMap(nestedStrings);
	return [];
}

function piEvidence(context: Database, root: string): Record<string, unknown> {
	const candidates: Array<Row & { score: number }> = [];
	for (const path of listFiles(root, ".jsonl")) {
		let text: string;
		try {
			text = readFileSync(path, "utf8");
		} catch {
			continue;
		}
		let sessionId = "";
		let messageEntries = 0;
		let stableEntryIds = 0;
		let tagCarriers = 0;
		let compactionEntries = 0;
		let parseErrors = 0;
		const stableIds = new Set<string>();
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			let entry: Row;
			try {
				entry = JSON.parse(line) as Row;
			} catch {
				parseErrors += 1;
				continue;
			}
			const type = String(entry.type ?? "");
			if (type === "session" && !sessionId) {
				sessionId = String(
					entry.id ?? entry.sessionId ?? entry.session_id ?? "",
				);
			}
			if (type === "message") {
				messageEntries += 1;
				if (typeof entry.id === "string" && entry.id) {
					stableEntryIds += 1;
					stableIds.add(entry.id);
				}
			}
			if (type === "compaction") compactionEntries += 1;
			tagCarriers += nestedStrings(entry).filter((value) =>
				/^§\d+§(?: |$)/.test(value),
			).length;
		}
		if (!sessionId || !tableExists(context, "session_meta")) continue;
		const metaColumns = columns(context, "session_meta");
		const selected = [
			"cached_m0_bytes",
			"cached_m1_bytes",
			"pending_pi_compaction_marker_state",
		]
			.filter((column) => metaColumns.has(column))
			.join(", ");
		const meta = selected
			? (context
					.query(`SELECT ${selected} FROM session_meta WHERE session_id = ?`)
					.get(sessionId) as Row | null)
			: null;
		if (!meta) continue;
		const tagRows = tableExists(context, "tags")
			? (context
					.query(
						"SELECT message_id FROM tags WHERE session_id = ? AND harness = 'pi'",
					)
					.all(sessionId) as Row[])
			: [];
		const tagOwner = (value: unknown): string => {
			const identity = String(value ?? "");
			const marker = identity.indexOf(":mc-text-v1:");
			if (marker >= 0) return identity.slice(0, marker);
			return identity.replace(/:p\d+$/, "");
		};
		const matchedStableTags = tagRows.filter((row) =>
			stableIds.has(tagOwner(row.message_id)),
		).length;
		const fallbackTags = tagRows.filter((row) =>
			tagOwner(row.message_id).startsWith("pi-msg-"),
		).length;
		const fileBytes = Buffer.byteLength(text);
		candidates.push({
			score:
				Number(Boolean(meta.cached_m0_bytes)) +
				Number(Boolean(meta.cached_m1_bytes)) +
				messageEntries,
			session_prefix: sessionPrefix(sessionId),
			file: { sha256: sha256(text), bytes: fileBytes },
			entries: {
				messages: messageEntries,
				stable_message_ids: stableEntryIds,
				parse_errors: parseErrors,
				tag_carriers: tagCarriers,
				compactions: compactionEntries,
			},
			tagging: {
				durable_tags: tagRows.length,
				adopted_stable_ids: matchedStableTags,
				fallback_ids_remaining: fallbackTags,
			},
			marker_drain: {
				native_compaction_entries: compactionEntries,
				pending_marker_present: Boolean(
					meta.pending_pi_compaction_marker_state,
				),
			},
			m0: fingerprint(meta.cached_m0_bytes as Uint8Array | string | undefined),
			m1: fingerprint(meta.cached_m1_bytes as Uint8Array | string | undefined),
		});
	}
	candidates.sort((left, right) => right.score - left.score);
	const sessions = candidates
		.slice(0, 2)
		.map(({ score: _score, ...row }) => row);
	return {
		files_scanned: listFiles(root, ".jsonl").length,
		sessions,
		coverage: { requested_sessions: 2, observed_sessions: sessions.length },
		unexplained_invariants: sessions.flatMap((session) => {
			const result: string[] = [];
			const tagging = session.tagging as Row;
			const marker = session.marker_drain as Row;
			if (
				Number(tagging.durable_tags) > 0 &&
				Number(tagging.adopted_stable_ids) === 0
			) {
				result.push("pi_stable_tag_adoption_unobserved");
			}
			if (
				Number(marker.native_compaction_entries) > 0 &&
				marker.pending_marker_present === true
			) {
				result.push("pi_native_compaction_with_pending_marker");
			}
			return result.map((className) => ({
				session_prefix: session.session_prefix,
				class: className,
			}));
		}),
	};
}

interface RpcRecord {
	port: number;
	pid: number;
	started_at: number;
	token?: string;
	instance_id?: string;
}

async function callProjectRpc(
	rpcRoot: string,
	projectPath: string,
	method: "sidebar-snapshot" | "status-detail",
	sessionId: string,
): Promise<{ body: Row | null; stage: string }> {
	const directory = join(
		rpcRoot,
		sha256(projectPath.replace(/\/+$/, "")).slice(0, 16),
	);
	const records: RpcRecord[] = [];
	try {
		for (const entry of readdirSync(directory)) {
			if (!entry.startsWith("port-") || !entry.endsWith(".json")) continue;
			const parsed = safeJson(readFileSync(join(directory, entry), "utf8"));
			const record = parsed as unknown as RpcRecord;
			if (
				Number.isInteger(record.port) &&
				record.port > 0 &&
				typeof record.token === "string"
			) {
				records.push(record);
			}
		}
	} catch {
		return { body: null, stage: "discovery_directory_absent" };
	}
	if (records.length === 0) return { body: null, stage: "no_port_records" };
	records.sort(
		(left, right) =>
			Number(right.started_at ?? 0) - Number(left.started_at ?? 0),
	);
	for (const record of records) {
		try {
			const health = await fetch(`http://127.0.0.1:${record.port}/health`, {
				signal: AbortSignal.timeout(1_500),
			});
			if (!health.ok) continue;
			const identity = (await health.json()) as Row;
			if (Number(identity.pid) !== Number(record.pid)) continue;
			if (identity.instance_id && identity.instance_id !== record.instance_id)
				continue;
			const response = await fetch(
				`http://127.0.0.1:${record.port}/rpc/${method}`,
				{
					method: "POST",
					headers: {
						authorization: `Bearer ${record.token}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({ sessionId, directory: projectPath }),
					signal: AbortSignal.timeout(5_000),
				},
			);
			if (!response.ok) continue;
			const body = (await response.json()) as Row;
			if (body.error) continue;
			return { body, stage: "ok" };
		} catch {}
	}
	return { body: null, stage: "no_healthy_response" };
}

function findSessionStores(
	primary: Database,
	primaryPath: string,
	storeRoot: string,
	sessionId: string,
): Array<{ db: Database; path: string; borrowed: boolean }> {
	const matches: Array<{ db: Database; path: string; borrowed: boolean }> = [];
	if (
		tableExists(primary, "mc_cache_state") &&
		primary
			.query("SELECT 1 FROM mc_cache_state WHERE session_id = ?")
			.get(sessionId)
	) {
		matches.push({ db: primary, path: primaryPath, borrowed: true });
	}
	let entries: Dirent[];
	try {
		entries = readdirSync(storeRoot, { withFileTypes: true, encoding: "utf8" });
	} catch {
		return matches;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const path = join(storeRoot, entry.name, "store.db");
		if (resolve(path) === resolve(primaryPath)) continue;
		let db: Database | undefined;
		try {
			db = openReadonly(path);
			if (
				tableExists(db, "mc_cache_state") &&
				db
					.query("SELECT 1 FROM mc_cache_state WHERE session_id = ?")
					.get(sessionId)
			) {
				matches.push({ db, path, borrowed: false });
			} else {
				db.close();
			}
		} catch {
			db?.close();
		}
	}
	return matches;
}

function directOperatorFields(
	lane: Lane,
	sessionId: string,
	context: Database,
	store: Database,
): Record<string, number | null> {
	if (lane === "rust") {
		const cache = tableExists(store, "mc_cache_state")
			? (store
					.query("SELECT meta FROM mc_cache_state WHERE session_id = ?")
					.get(sessionId) as Row | null)
			: null;
		const usage = safeJson(safeJson(cache?.meta).last_usage);
		return {
			inputTokens: Number(usage.current_total_input_tokens ?? 0),
			contextLimit: Number(usage.context_limit_tokens ?? 0),
			compartmentCount: tableExists(store, "mc_compartments")
				? count(
						store,
						"SELECT COUNT(*) FROM mc_compartments WHERE session_id = ?",
						sessionId,
					)
				: null,
			pendingOpsCount: tableExists(store, "pending_agent_drops")
				? count(
						store,
						"SELECT COUNT(*) FROM pending_agent_drops WHERE session_id = ?",
						sessionId,
					)
				: null,
			totalTags: tableExists(store, "mc_tags")
				? count(
						store,
						"SELECT COUNT(*) FROM mc_tags WHERE session_id = ?",
						sessionId,
					)
				: null,
		};
	}
	const meta = tableExists(context, "session_meta")
		? (context
				.query(
					"SELECT last_input_tokens, last_usage_context_limit FROM session_meta WHERE session_id = ?",
				)
				.get(sessionId) as Row | null)
		: null;
	return {
		inputTokens: Number(meta?.last_input_tokens ?? 0),
		contextLimit: Number(meta?.last_usage_context_limit ?? 0),
		compartmentCount: tableExists(context, "compartments")
			? count(
					context,
					"SELECT COUNT(*) FROM compartments WHERE session_id = ?",
					sessionId,
				)
			: null,
		pendingOpsCount: tableExists(context, "pending_ops")
			? count(
					context,
					"SELECT COUNT(*) FROM pending_ops WHERE session_id = ?",
					sessionId,
				)
			: null,
		totalTags: tableExists(context, "tags")
			? count(
					context,
					"SELECT COUNT(*) FROM tags WHERE session_id = ?",
					sessionId,
				)
			: null,
	};
}

export function compareOperatorFields(
	before: Row,
	after: Row,
	sidebar: Row,
	status: Row,
): Row[] {
	return [
		"inputTokens",
		"contextLimit",
		"compartmentCount",
		"pendingOpsCount",
		"totalTags",
	].map((field) => {
		const sidebarValue =
			typeof sidebar[field] === "number" ? Number(sidebar[field]) : null;
		const statusValue =
			typeof status[field] === "number" ? Number(status[field]) : null;
		const beforeValue =
			typeof before[field] === "number" ? Number(before[field]) : null;
		const afterValue =
			typeof after[field] === "number" ? Number(after[field]) : null;
		const rpcValues = [sidebarValue, statusValue].filter(
			(value): value is number => value !== null,
		);
		const stableValues = [beforeValue, afterValue].filter(
			(value): value is number => value !== null,
		);
		return {
			field,
			direct_before: beforeValue,
			direct_after: afterValue,
			sidebar: sidebarValue,
			status: statusValue,
			matched_snapshot: rpcValues.every((value) =>
				stableValues.includes(value),
			),
			exposed_by: [
				sidebarValue !== null ? "sidebar" : null,
				statusValue !== null ? "status" : null,
			].filter(Boolean),
		};
	});
}

export function evaluateOperatorTagTotalContract(
	lane: Lane,
	before: Row,
	after: Row,
	status: Row,
): Row {
	const beforeTotal =
		typeof before.totalTags === "number" ? Number(before.totalTags) : null;
	const afterTotal =
		typeof after.totalTags === "number" ? Number(after.totalTags) : null;
	const statusTotal =
		typeof status.totalTags === "number" ? Number(status.totalTags) : null;
	const directStable = beforeTotal !== null && beforeTotal === afterTotal;
	const sourceMatchesLane =
		lane === "rust"
			? status.tagCountsAuthoritative === false
			: status.tagCountsAuthoritative !== false;
	return {
		direct_before: beforeTotal,
		direct_after: afterTotal,
		direct_stable: directStable,
		status: statusTotal,
		status_matches_direct_total:
			directStable && statusTotal !== null && statusTotal === beforeTotal,
		authority_source:
			lane === "rust"
				? status.tagCountsAuthoritative === false
					? "module"
					: "host_or_unknown"
				: status.tagCountsAuthoritative === false
					? "module"
					: "host",
		source_matches_lane: sourceMatchesLane,
	};
}

export function operatorTagTotalFailureClasses(lane: Lane, contract: Row): string[] {
	const failures: string[] = [];
	if (contract.direct_stable !== true) {
		failures.push(`${lane}_tag_total_bracket_not_quiescent`);
	} else if (contract.status_matches_direct_total !== true) {
		failures.push(`${lane}_status_tag_total_mismatch`);
	}
	if (contract.source_matches_lane !== true) {
		failures.push(`${lane}_status_tag_total_wrong_authority`);
	}
	return failures;
}

function sessionDirectory(
	opencode: Database,
	sessionId: string,
	fallback: string,
): string {
	const sessionColumns = columns(opencode, "session");
	if (sessionColumns.has("directory")) {
		const row = opencode
			.query("SELECT directory FROM session WHERE id = ?")
			.get(sessionId) as Row | null;
		if (typeof row?.directory === "string" && row.directory)
			return row.directory;
	}
	if (sessionColumns.has("data")) {
		const row = opencode
			.query("SELECT data FROM session WHERE id = ?")
			.get(sessionId) as Row | null;
		const data = safeJson(row?.data);
		if (typeof data.directory === "string" && data.directory)
			return data.directory;
	}
	return fallback;
}

async function operatorEvidence(
	context: Database,
	store: Database,
	opencode: Database,
	primaryStorePath: string,
	storeRoot: string,
	bindings: ReturnType<typeof bindingRows>,
	rpcRoot: string,
	skipRpc: boolean,
): Promise<Record<string, unknown>> {
	const selected: Row[] = [];
	const attemptStages: Record<string, number> = {};
	for (const lane of ["rust", "ts"] as Lane[]) {
		const candidates = bindings.filter(
			(binding) => bindingLane(context, binding.projectPath) === lane,
		);
		for (const binding of candidates) {
			if (skipRpc) break;
			const directory = sessionDirectory(
				opencode,
				binding.sessionId,
				binding.projectPath,
			);
			const [sidebarAttempt, statusAttempt] = await Promise.all([
				callProjectRpc(
					rpcRoot,
					directory,
					"sidebar-snapshot",
					binding.sessionId,
				),
				callProjectRpc(rpcRoot, directory, "status-detail", binding.sessionId),
			]);
			attemptStages[`${lane}:sidebar:${sidebarAttempt.stage}`] =
				(attemptStages[`${lane}:sidebar:${sidebarAttempt.stage}`] ?? 0) + 1;
			attemptStages[`${lane}:status:${statusAttempt.stage}`] =
				(attemptStages[`${lane}:status:${statusAttempt.stage}`] ?? 0) + 1;
			const initialSidebar = sidebarAttempt.body;
			const initialStatus = statusAttempt.body;
			if (!initialSidebar || !initialStatus) continue;
			const sessionStores =
				lane === "rust"
					? findSessionStores(
							store,
							primaryStorePath,
							storeRoot,
							binding.sessionId,
						)
					: [{ db: store, path: primaryStorePath, borrowed: true }];
			if (sessionStores.length === 0) continue;
			const rpcValues = { ...initialSidebar, ...initialStatus };
			const scoredStores = sessionStores.map((candidate) => {
				const fields = directOperatorFields(
					lane,
					binding.sessionId,
					context,
					candidate.db,
				);
				// Route the store using independent fields so the tag value under test cannot select
				// a convenient database and make its own contract check pass.
				const score = [
					"inputTokens",
					"contextLimit",
					"compartmentCount",
					"pendingOpsCount",
				].filter(
					(field) =>
						typeof rpcValues[field] === "number" &&
						Number(rpcValues[field]) === fields[field],
				).length;
				return { candidate, fields, score };
			});
			scoredStores.sort((left, right) => right.score - left.score);
			const selectedStore = scoredStores[0];
			if (!selectedStore) continue;
			const sessionStore = selectedStore.candidate;
			const directBefore = selectedStore.fields;
			const [sidebarRefresh, statusRefresh] = await Promise.all([
				callProjectRpc(
					rpcRoot,
					directory,
					"sidebar-snapshot",
					binding.sessionId,
				),
				callProjectRpc(rpcRoot, directory, "status-detail", binding.sessionId),
			]);
			const sidebar = sidebarRefresh.body;
			const status = statusRefresh.body;
			if (!sidebar || !status) {
				for (const candidate of sessionStores) {
					if (!candidate.borrowed) candidate.db.close();
				}
				continue;
			}
			const directAfter = directOperatorFields(
				lane,
				binding.sessionId,
				context,
				sessionStore.db,
			);
			const tagTotalContract = evaluateOperatorTagTotalContract(
				lane,
				directBefore,
				directAfter,
				status,
			);
			selected.push({
				lane,
				session_prefix: sessionPrefix(binding.sessionId),
				project_sha256_12: projectFingerprint(binding.projectPath),
				rpc_directory_sha256_12: projectFingerprint(directory),
				store_path_sha256_12: sha256(sessionStore.path).slice(0, 12),
				store_candidate_count: sessionStores.length,
				store_match_score: selectedStore.score,
				fields: compareOperatorFields(
					directBefore,
					directAfter,
					sidebar,
					status,
				),
				tag_total_contract: tagTotalContract,
				context_schema_version_direct: tableExists(context, "schema_migrations")
					? count(
							context,
							"SELECT COALESCE(MAX(version), 0) FROM schema_migrations WHERE version < 10000",
						)
					: 0,
				context_schema_version_status: Number(
					(status.storage_versions as Row | undefined)
						?.context_db_schema_version ?? 0,
				),
				module_schema_version_direct:
					lane === "rust" &&
					tableExists(sessionStore.db, "cortexkit_schema_version")
						? count(
								sessionStore.db,
								"SELECT COALESCE(MAX(version), 0) FROM cortexkit_schema_version WHERE namespace = 'mc_cache'",
							)
						: null,
				module_schema_version_status: null,
			});
			for (const candidate of sessionStores) {
				if (!candidate.borrowed) candidate.db.close();
			}
			break;
		}
	}
	const mismatches = selected.flatMap((session) => {
		const fieldMismatches = (session.fields as Row[])
			.filter(
				(field) =>
					field.field !== "totalTags" &&
					field.matched_snapshot === false &&
					(field.exposed_by as unknown[]).length > 0,
			)
			.map((field) => ({
				lane: session.lane,
				session_prefix: session.session_prefix,
				field: field.field,
			}));
		const contract = session.tag_total_contract as Row;
		const tagFailures = operatorTagTotalFailureClasses(session.lane as Lane, contract);
		return [
			...fieldMismatches,
			...tagFailures.map((className) => ({
				class: className,
				lane: session.lane,
				session_prefix: session.session_prefix,
				field: "totalTags",
			})),
		];
	});
	return {
		sessions: selected,
		coverage: {
			requested_lanes: 2,
			observed_lanes: new Set(selected.map((row) => row.lane)).size,
			rpc_skipped: skipRpc,
			attempt_stages: attemptStages,
		},
		unexplained_invariants: mismatches,
	};
}

function maintenanceDistribution(
	db: Database,
	table: string,
	afterMs: number,
): { rows: number; dispositions: Record<string, number>; rounds: number } {
	if (!tableExists(db, table)) return { rows: 0, dispositions: {}, rounds: 0 };
	const tableColumns = columns(db, table);
	const hasDisposition = tableColumns.has("disposition");
	const hasRounds = tableColumns.has("rounds");
	const selected = [
		hasDisposition ? "disposition" : "NULL AS disposition",
		hasRounds ? "rounds" : "0 AS rounds",
	].join(", ");
	const rows = db
		.query(`SELECT ${selected} FROM "${table}" WHERE created_at >= ?`)
		.all(afterMs) as Row[];
	const dispositions: Record<string, number> = {};
	let rounds = 0;
	for (const row of rows) {
		const disposition = String(row.disposition ?? "recorded");
		dispositions[disposition] = (dispositions[disposition] ?? 0) + 1;
		rounds += Number(row.rounds ?? 0) || 0;
	}
	return { rows: rows.length, dispositions, rounds };
}

export function maintenanceCoverageGaps(evidence: {
	recomp: { rows: number };
	wrapup: { rows: number };
	dreamer_appliers: { rows: number };
}): string[] {
	const gaps: string[] = [];
	if (evidence.recomp.rows === 0) gaps.push("zero_live_rust_recomp_commands");
	if (evidence.wrapup.rows === 0) gaps.push("zero_live_rust_wrapup_commands");
	if (evidence.dreamer_appliers.rows === 0)
		gaps.push("zero_live_rust_dreamer_apply_commands");
	return gaps.sort();
}

export function maintenanceFailureClasses(evidence: {
	recomp: { rows: number; dispositions: Record<string, number> };
	wrapup: { rows: number; dispositions: Record<string, number> };
	dreamer_appliers: { rows: number };
}): string[] {
	const classes: string[] = [];
	for (const disposition of Object.keys(evidence.recomp.dispositions)) {
		if (!["started", "already_in_progress", "nothing_to_do"].includes(disposition))
			classes.push("unknown_rust_recomp_disposition");
	}
	for (const disposition of Object.keys(evidence.wrapup.dispositions)) {
		if (!["completed", "nothing_to_compact", "failed"].includes(disposition))
			classes.push("unknown_rust_wrapup_disposition");
	}
	return [...new Set(classes)].sort();
}

function maintenanceEvidence(store: Database, afterMs: number): Record<string, unknown> {
	const recomp = maintenanceDistribution(store, "mc_recomp_commands", afterMs);
	const wrapup = maintenanceDistribution(store, "mc_wrapup_commands", afterMs);
	const dreamer = maintenanceDistribution(store, "mc_dream_task_commands", afterMs);
	const evidence = {
		cutoff_ms: afterMs,
		recomp,
		wrapup,
		dreamer_appliers: dreamer,
	};
	return {
		...evidence,
		coverage_gaps: maintenanceCoverageGaps({
			recomp,
			wrapup,
			dreamer_appliers: dreamer,
		}),
		unexplained_invariants: maintenanceFailureClasses(evidence),
	};
}

function decisionEvidence(
	context: Database,
	store: Database,
	bindings: ReturnType<typeof bindingRows>,
	afterMs: number,
): Record<string, unknown> {
	const laneBySession = new Map<string, Lane>();
	for (const binding of bindings) {
		const lane = bindingLane(context, binding.projectPath);
		if (lane === "rust" || lane === "ts")
			laneBySession.set(binding.sessionId, lane);
	}
	const rows = tableExists(context, "transform_decisions")
		? (context
				.query(
					`SELECT session_id, ts_ms, decision, materialize_reason,
                          system_hash_prev, system_hash_new,
                          m0_model_key_prev, m0_model_key_new,
                          m0_tool_set_hash_prev, m0_tool_set_hash_new
                     FROM transform_decisions
                    WHERE ts_ms >= ? ORDER BY session_id, ts_ms`,
				)
				.all(afterMs) as Row[])
		: [];
	const distributions: Record<
		Lane,
		{
			rows: number;
			decisions: Record<string, number>;
			reasons: Record<string, number>;
		}
	> = {
		rust: { rows: 0, decisions: {}, reasons: {} },
		ts: { rows: 0, decisions: {}, reasons: {} },
	};
	const fixedClasses: Record<string, number> = Object.fromEntries(
		FIXED_SELF_CAUSED_REASONS.map((reason) => [reason, 0]),
	);
	let repeatedRenderConfig = 0;
	const previousBySession = new Map<string, Row>();
	for (const row of rows) {
		const sessionId = String(row.session_id ?? "");
		const lane = laneBySession.get(sessionId);
		if (!lane) continue;
		distributions[lane].rows += 1;
		const decision = String(row.decision ?? "none");
		const reason = String(row.materialize_reason ?? "none");
		distributions[lane].decisions[decision] =
			(distributions[lane].decisions[decision] ?? 0) + 1;
		distributions[lane].reasons[reason] =
			(distributions[lane].reasons[reason] ?? 0) + 1;
		if (reason in fixedClasses) fixedClasses[reason] += 1;
		const previous = previousBySession.get(sessionId);
		if (
			reason === "render_config" &&
			previous?.materialize_reason === "render_config" &&
			Number(row.ts_ms) - Number(previous.ts_ms) <= 120_000
		) {
			repeatedRenderConfig += 1;
		}
		previousBySession.set(sessionId, row);
	}
	fixedClasses.repeated_render_config_within_120s = repeatedRenderConfig;

	const scheduler: Record<string, number> = {};
	let schedulerRows = 0;
	if (tableExists(store, "mc_pass_trace")) {
		for (const row of store
			.query("SELECT scheduler_history FROM mc_pass_trace")
			.all() as Row[]) {
			let history: unknown[] = [];
			try {
				history = JSON.parse(String(row.scheduler_history ?? "[]"));
			} catch {
				history = [];
			}
			for (const item of history) {
				if (!item || typeof item !== "object") continue;
				const observation = item as Row;
				if (Number(observation.timestamp_ms ?? -1) < afterMs) continue;
				schedulerRows += 1;
				const decision = String(observation.scheduler_decision ?? "none");
				scheduler[decision] = (scheduler[decision] ?? 0) + 1;
			}
		}
	}
	return {
		cutoff_ms: afterMs,
		transform_decisions: distributions,
		scheduler_history: { rows: schedulerRows, decisions: scheduler },
		fixed_self_caused_classes: fixedClasses,
		unexplained_invariants: Object.entries(fixedClasses)
			.filter(([, value]) => value > 0)
			.map(([className, value]) => ({ class: className, count: value })),
	};
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	const context = openReadonly(options.contextDb);
	const store = openReadonly(options.storeDb);
	const opencode = openReadonly(options.opencodeDb);
	try {
		// The OpenCode handle is intentionally opened and verified even though the
		// consolidated legs use context bindings rather than message prose.
		const opencodeSchemaPresent =
			tableExists(opencode, "session") && tableExists(opencode, "message");
		const bindings = bindingRows(context);
		const captureBindings = [...bindings, ...opencodeBindingRows(opencode)];
		const report = {
			method: {
				sqlite_open_options: { readonly: true },
				sqlite_query_only_verified: true,
				opencode_schema_present: opencodeSchemaPresent,
				after_ms: options.afterMs,
			},
			capture_lane_coordinates: captureLaneCoordinates(
				captureBindings,
				options.captureSessionHashes,
			),
			engine_truth: engineEvidence(
				context,
				store,
				bindings,
				options.engineAfterMs,
			),
			caveman: cavemanEvidence(
				context,
				store,
				bindings,
				options.skipRustOracle,
			),
			pi_real_jsonl: piEvidence(context, options.piSessionDir),
			operator_reads: await operatorEvidence(
				context,
				store,
				opencode,
				options.storeDb,
				options.storeRoot,
				bindings,
				options.rpcRoot,
				options.skipRpc,
			),
			decision_window: decisionEvidence(
				context,
				store,
				bindings,
				options.afterMs,
			),
			maintenance: maintenanceEvidence(store, options.afterMs),
		};
		process.stdout.write(`${JSON.stringify(report)}\n`);
	} finally {
		opencode.close();
		store.close();
		context.close();
	}
}

if (import.meta.main) await main();
