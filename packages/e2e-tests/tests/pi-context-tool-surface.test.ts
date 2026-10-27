import { expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CTX_REDUCE_DESCRIPTION } from "../../plugin/src/tools/ctx-reduce/constants";
import { FULL_PARAMETER_DESCRIPTIONS } from "../../plugin/src/tools/parameter-descriptions";
import { PiTestHarness } from "../src/pi-harness";
import type { CapturedRequest } from "../src/mock-provider/server";
import { resolvePiHostInvocation } from "../src/pi-runner/spawn";
import { forEachHost } from "../src/scenario-hosts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/**
 * Pi 0.87.1's exact tool list with required memory/note arguments, and OMP
 * 18.12.3's historical list before enabling the context tools listed below.
 * The OMP historical pin remains an inequality check, not a current snapshot.
 */
const TOOL_BYTES_SHA256 = {
	omp: "76a6eb5bf46e2fc43a9ab84640ed7257bc5d1c63b2242f3f464cf3cec8a8280b",
	pi: "d421ab31332486cb3e6448c2e46ed267d24d00d59a589caeb0fda7237e4264c2",
} as const;

const CONTEXT_TOOL_NAMES = [
	"ctx_expand",
	"ctx_memory",
	"ctx_note",
	"ctx_reduce",
	"ctx_search",
] as const;

function stringEnd(source: string, start: number): number {
	let escaped = false;
	for (let index = start + 1; index < source.length; index += 1) {
		const character = source[index];
		if (escaped) {
			escaped = false;
		} else if (character === "\\") {
			escaped = true;
		} else if (character === '"') {
			return index + 1;
		}
	}
	throw new Error("unterminated JSON string in provider request");
}

function valueEnd(source: string, start: number): number {
	const first = source[start];
	if (first === '"') return stringEnd(source, start);
	if (first !== "{" && first !== "[") {
		let index = start;
		while (index < source.length && !",}]".includes(source[index] ?? "")) {
			index += 1;
		}
		while (index > start && /\s/.test(source[index - 1] ?? "")) index -= 1;
		return index;
	}

	const expectedClosers: string[] = [first === "{" ? "}" : "]"];
	let inString = false;
	let escaped = false;
	for (let index = start + 1; index < source.length; index += 1) {
		const character = source[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') inString = false;
			continue;
		}
		if (character === '"') inString = true;
		else if (character === "{" || character === "[") {
			expectedClosers.push(character === "{" ? "}" : "]");
		} else if (character === "}" || character === "]") {
			if (expectedClosers.pop() !== character) {
				throw new Error("unbalanced JSON value in provider request");
			}
			if (expectedClosers.length === 0) return index + 1;
		}
	}
	throw new Error("unterminated JSON value in provider request");
}

function rawTopLevelProperty(rawBody: string, property: string): string {
	let index = 0;
	const skipWhitespace = () => {
		while (/\s/.test(rawBody[index] ?? "")) index += 1;
	};
	skipWhitespace();
	if (rawBody[index] !== "{") throw new Error("provider request is not a JSON object");
	index += 1;
	while (index < rawBody.length) {
		skipWhitespace();
		if (rawBody[index] === "}") break;
		if (rawBody[index] !== '"') throw new Error("expected JSON property name");
		const keyStart = index;
		const keyEnd = stringEnd(rawBody, keyStart);
		const key = JSON.parse(rawBody.slice(keyStart, keyEnd)) as string;
		index = keyEnd;
		skipWhitespace();
		if (rawBody[index] !== ":") throw new Error("expected JSON property colon");
		index += 1;
		skipWhitespace();
		const start = index;
		const end = valueEnd(rawBody, start);
		if (key === property) return rawBody.slice(start, end);
		index = end;
		skipWhitespace();
		if (rawBody[index] === ",") index += 1;
		else if (rawBody[index] !== "}") throw new Error("expected JSON property separator");
	}
	throw new Error(`provider request omitted top-level ${property}`);
}

function requestForPrompt(
	requests: CapturedRequest[],
	prompt: string,
): CapturedRequest {
	const request = requests
		.filter((candidate) => JSON.stringify(candidate.body.messages).includes(prompt))
		.at(-1);
	if (!request?.rawBody) throw new Error(`no captured provider request contains ${prompt}`);
	return request;
}

forEachHost(import.meta.url, null, (host) => {
	if (host !== "pi" && host !== "omp") {
		throw new Error(`unsupported Pi tool-surface host ${host}`);
	}
	it(`${host}: captures exact tool-list bytes from an isolated real host`, async () => {
		const base = join(realpathSync(tmpdir()), "magic-context", "issue-756");
		mkdirSync(base, { recursive: true });
		const previousTmp = process.env.TMPDIR;
		const previousOmpPackage = process.env.MC_E2E_OMP_PACKAGE_JSON;
		process.env.TMPDIR = base;
		if (host === "omp") {
			process.env.MC_E2E_OMP_PACKAGE_JSON = resolve(
				import.meta.dir,
				"../../pi-plugin/node_modules/omp-coding-agent-1812/package.json",
			);
		}
		let harness: PiTestHarness | undefined;
		try {
			const invocation = resolvePiHostInvocation(host);
			const hostVersion = JSON.parse(
				await Bun.file(invocation.packageJson).text(),
			) as { version: string };
			expect(hostVersion.version).toBe(host === "omp" ? "18.12.3" : "0.87.1");
			console.log(`[real host] ${host} ${hostVersion.version}`);
			harness = await PiTestHarness.create({
				host,
				...(host === "omp"
					? { piSettingsExtra: { tools: { xdev: true, intentTracing: false } } }
					: {}),
				magicContextConfig: {
					compressor: { enabled: false },
					dreamer: { disable: true },
				},
			});
			const session = await harness.createSession();
			const prompts = [
				"ordinary first turn for Pi context tools",
				"ordinary second turn for Pi context tools",
			];
			const captured: CapturedRequest[] = [];
			for (const prompt of prompts) {
				await harness.sendPrompt(session, prompt);
				captured.push(requestForPrompt(harness.mock.requests(), prompt));
			}

			const wireDir = join(base, "wire");
			mkdirSync(wireDir, { recursive: true });
			const toolBytes = captured.map((request) =>
				rawTopLevelProperty(request.rawBody ?? "", "tools"),
			);
			const systemBytes = captured.map((request) =>
				rawTopLevelProperty(request.rawBody ?? "", "system"),
			);
			for (let index = 0; index < captured.length; index += 1) {
				writeFileSync(
					join(wireDir, `${host}-turn-${index + 1}.request.json`),
					captured[index]?.rawBody ?? "",
				);
				writeFileSync(
					join(wireDir, `${host}-turn-${index + 1}.tools.json`),
					toolBytes[index] ?? "",
				);
			}
			const summarizeTools = (request: CapturedRequest) => {
				const tools = Array.isArray(request.body.tools) ? request.body.tools : [];
				const systemText = JSON.stringify(request.body.system);
				return {
					tools: tools.filter(isRecord).map((tool) => ({
						name: tool.name,
						descriptionBytes:
							typeof tool.description === "string"
								? Buffer.byteLength(tool.description)
								: undefined,
					})),
					xdLinks: [...systemText.matchAll(/xd:\/\/[^\s"\\<>]+/g)].map(
						(match) => match[0],
					),
				};
			};
			const opened = execFileSync("lsof", ["-Fn", "-p", String(harness.hostPid)], {
				encoding: "utf8",
			});
			writeFileSync(join(base, `${host}-lsof.txt`), opened);
			const stores = opened
				.split("\n")
				.filter(
					(line) =>
						line.startsWith("n/") &&
						(/\.db(?:-wal|-shm)?$/.test(line) || /\/(?:\.config|\.pi|\.omp)\//.test(line)),
				)
				.map((line) => line.slice(1));
			expect(stores.length).toBeGreaterThan(0);
			expect(stores.every((path) => path.startsWith(`${base}/`))).toBe(true);
			for (const path of [
				harness.env.baseDir,
				harness.env.configDir,
				harness.env.dataDir,
				harness.env.cacheDir,
				harness.env.agentDir,
			]) {
				expect(path.startsWith(`${base}/`)).toBe(true);
			}

			const toolHashes = toolBytes.map((bytes) => hash(bytes));
			const firstTools = Array.isArray(captured[0]?.body.tools)
				? captured[0].body.tools.filter(isRecord)
				: [];
			expect(toolHashes[1]).toBe(toolHashes[0]);
			expect(toolBytes[1]).toBe(toolBytes[0]);
			if (host === "pi") {
				expect(toolHashes[0]).toBe(TOOL_BYTES_SHA256.pi);
				for (const request of captured) {
					const tools = Array.isArray(request.body.tools) ? request.body.tools : [];
					for (const tool of tools.filter(isRecord)) {
						expect(tool).not.toHaveProperty("loadMode");
					}
				}
			} else {
				expect(toolHashes[0]).not.toBe(TOOL_BYTES_SHA256.omp);
				const toolNames = firstTools.map((tool) =>
					typeof tool.name === "string" ? tool.name.replace(/^_/, "") : tool.name,
				);
				for (const name of CONTEXT_TOOL_NAMES) expect(toolNames).toContain(name);
				const reduceTool = firstTools.find(
					(tool) => tool.name === "ctx_reduce" || tool.name === "_ctx_reduce",
				);
				expect(reduceTool).toBeDefined();
				expect(reduceTool?.description).toBe(CTX_REDUCE_DESCRIPTION);
				const schema = reduceTool?.input_schema;
				expect(isRecord(schema)).toBe(true);
				if (isRecord(schema)) {
					expect(schema.type).toBe("object");
					expect(schema).toEqual({
						type: "object",
						properties: {
							drop: {
								type: "string",
								description: FULL_PARAMETER_DESCRIPTIONS.ctx_reduce.drop,
							},
						},
						additionalProperties: true,
						required: [],
					});
				}
				const systemText = captured
					.map((request) => JSON.stringify(request.body.system))
					.join("\n");
				expect(systemText).not.toMatch(
					/xd:\/\/ctx_(?:search|memory(?:_list)?|note|expand|reduce)\b/,
				);
			}
			console.log(
				`[tool wire capture] ${JSON.stringify({
					host,
					version: hostVersion.version,
					turns: captured.map((request, index) => ({
						request_sha256: hash(request.rawBody ?? ""),
						request_bytes: Buffer.byteLength(request.rawBody ?? ""),
						tools_sha256: toolHashes[index],
						tools_bytes: Buffer.byteLength(toolBytes[index] ?? ""),
						system_sha256: hash(systemBytes[index] ?? ""),
						tools: summarizeTools(request),
						ctx_reduce: (Array.isArray(request.body.tools) ? request.body.tools : [])
							.filter(isRecord)
							.find(
								(tool) =>
									typeof tool.name === "string" &&
									tool.name.replace(/^_/, "") === "ctx_reduce",
							),
					})),
					wire_dir: wireDir,
				})}`,
			);
		} finally {
			await harness?.dispose();
			if (previousTmp === undefined) delete process.env.TMPDIR;
			else process.env.TMPDIR = previousTmp;
			if (previousOmpPackage === undefined) delete process.env.MC_E2E_OMP_PACKAGE_JSON;
			else process.env.MC_E2E_OMP_PACKAGE_JSON = previousOmpPackage;
		}
	}, 60000);
});
