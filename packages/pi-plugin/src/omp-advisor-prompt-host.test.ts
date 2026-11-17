import { expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
	isOmpAdvisorRequest,
	isOmpStockAdvisorPrompt,
} from "./omp-request-kind";

// Host canary for OMP advisor recognition. Magic Context exempts an OMP
// advisor request from the dispatch fence only when OMP's stock advisor prompt
// leads its instructions (isOmpAdvisorRequest). OMP has changed that prompt's
// opening without a changelog entry before (18.20.2 dropped its conventions
// block), and every advisor request was then refused. So each OMP coding-agent
// release pinned in this package's devDependencies is read here: adding a
// newer alias fails this test if OMP changes the prompt, or the way it builds
// an advisor request, again.

const require = createRequire(import.meta.url);
const manifest = JSON.parse(
	readFileSync(join(import.meta.dir, "../package.json"), "utf8"),
) as { devDependencies: Record<string, string> };

type Version = [number, number, number];
const compare = (a: Version, b: Version) =>
	a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
// The rule covers OMP's advisors from 18.8.0, checked against each release's
// source; older releases word the prompt differently and are not recognised.
const FIRST_COVERED: Version = [18, 8, 0];
// The release that removed the conventions block from the prompt.
const WITHOUT_CONVENTIONS: Version = [18, 20, 2];

const hosts = Object.entries(manifest.devDependencies).flatMap(
	([alias, spec]) => {
		const match = /^npm:@oh-my-pi\/pi-coding-agent@(\d+)\.(\d+)\.(\d+)$/.exec(
			spec,
		);
		if (!match) return [];
		const version = match.slice(1).map(Number) as Version;
		return compare(version, FIRST_COVERED) >= 0
			? [{ alias, version: version.join("."), parts: version }]
			: [];
	},
);

test("issue 940 canary: a pinned OMP release without the conventions block is under test", () => {
	expect(
		hosts.some((host) => compare(host.parts, WITHOUT_CONVENTIONS) >= 0),
	).toBe(true);
});

const WORKFLOW = "<workflow>\n";

for (const host of hosts) {
	const root = require
		.resolve(`${host.alias}/package.json`)
		.slice(0, -"package.json".length);
	const read = (path: string) => readFileSync(join(root, path), "utf8");

	test(`issue 940 canary: OMP ${host.version} advisor prompt is recognised`, () => {
		expect(JSON.parse(read("package.json")).version).toBe(host.version);
		const prompt = read("src/prompts/advisor/system.md");
		// OMP renders the file as a template; the part the rule reads must be
		// plain text, so the file is what reaches the provider.
		expect(prompt.indexOf(WORKFLOW)).toBeGreaterThan(0);
		expect(prompt.slice(0, prompt.indexOf(WORKFLOW))).not.toContain("{{");
		expect(isOmpStockAdvisorPrompt(prompt)).toBe(true);
	});

	test(`issue 940 canary: OMP ${host.version} still builds advisor requests the rule expects`, () => {
		const advisors = read("src/session/session-advisors.ts");
		// The stock prompt is the first system prompt element; WATCHDOG.yml
		// instructions are appended after it, and advise is always a tool.
		expect(advisors).toContain(
			'import advisorSystemPrompt from "../prompts/advisor/system.md"',
		);
		expect(advisors).toMatch(
			/const systemPrompt = \[prompt\.render\(advisorSystemPrompt\b/,
		);
		expect(advisors).toContain("systemPrompt.push(config.instructions.trim())");
		expect(advisors).toMatch(/\[adviseTool, \.\.\.tools\]/);
		expect(read("src/advisor/advise-tool.ts")).toContain(
			'readonly name = "advise";',
		);
		// Every advisor update starts with this heading.
		expect(read("src/advisor/delta-split.ts")).toContain(
			'const heading = "### Session update";',
		);
	});

	test(`issue 940 canary: OMP ${host.version} advisor requests built from its own files are recognised`, () => {
		const prompt = read("src/prompts/advisor/system.md");
		const agentCore = dirname(
			dirname(Bun.resolveSync("@oh-my-pi/pi-agent-core", realpathSync(root))),
		);
		expect(
			JSON.parse(readFileSync(join(agentCore, "package.json"), "utf8")).version,
		).toBe(host.version);
		// The row OMP puts first once it has compacted the advisor's context.
		const summary = readFileSync(
			join(agentCore, "src/compaction/prompts/compaction-summary-context.md"),
			"utf8",
		);
		expect(summary).toContain("{{summary}}");
		const reminder = {
			type: "text",
			text: "<system-reminder>\nToday: 2026-01-01; current working directory: '/throwaway/omp-advisor'. Do not repeat this information in your reply.\n</system-reminder>",
		};
		const request = (firstReview: string) => ({
			messages: [
				{
					role: "system",
					content: `${prompt}\n\nCustom reviewer instructions.`,
				},
				{
					role: "user",
					content: [reminder, { type: "text", text: firstReview }],
				},
			],
			tools: [
				{ type: "function", function: { name: "advise" } },
				{ type: "function", function: { name: "read" } },
			],
		});
		expect(
			isOmpAdvisorRequest(
				request("### Session update\n\n**user**:\nRead hello.txt.\n"),
			),
		).toBe(true);
		expect(
			isOmpAdvisorRequest(
				request(summary.replace("{{summary}}", "Earlier review.")),
			),
		).toBe(true);
	});
}
