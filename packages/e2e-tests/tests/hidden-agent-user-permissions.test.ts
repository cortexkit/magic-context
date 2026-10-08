import { expect, test } from "bun:test";
import { TestHarness } from "../src/harness";
import { inspectHostOpenFiles } from "../src/host-open-files";
import { dirname } from "node:path";

/**
 * Issue 639 asked whether OpenCode 1 has OpenCode 2's flaw: there, the user's
 * global permission rules are appended after a Magic Context hidden agent's own
 * rules, so a user's `edit: allow` beat the agent's wildcard deny.
 *
 * OpenCode 1 composes an agent's ruleset as defaults, then the user's global
 * `permission`, then the agent's own `permission`, and a tool call takes the
 * LAST matching rule. This reads the rulesets the real host resolved for every
 * hidden Magic Context agent while the user's config allows everything, and
 * evaluates them the way the host does.
 */

interface Rule {
	permission: string;
	pattern: string;
	action: "allow" | "deny" | "ask";
}

function wildcard(pattern: string, value: string): boolean {
	const source = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
	return new RegExp(`^${source}$`, "s").test(value);
}

function evaluate(rules: Rule[], permission: string, pattern = "*"): string {
	return (
		rules.findLast((rule) => wildcard(rule.permission, permission) && wildcard(rule.pattern, pattern))
			?.action ?? "ask"
	);
}

const HIDDEN_AGENT_TOOLS: Record<string, string[]> = {
	historian: [],
	"historian-recomp": [],
	"historian-editor": [],
	dreamer: ["ctx_memory"],
	"dreamer-docs": ["read", "grep", "glob"],
	"dreamer-reviewer": [],
	"dreamer-retrospective": ["ctx_search"],
	"dreamer-primer-investigator": ["read", "grep", "glob", "ctx_search"],
	"dreamer-memory-mapper": ["read", "grep", "glob"],
	"dreamer-classifier": [],
	"smart-note-compiler": [],
};

test("OpenCode 1 keeps every hidden Magic Context agent's denies over a user config that allows everything", async () => {
	const h = await TestHarness.create({
		magicContextConfig: { dreamer: { disable: false } },
		openCodeGlobalConfigExtra: {
			permission: { "*": "allow", edit: "allow", bash: "allow", write: "allow", task: "allow" },
		},
	});
	try {
		const health = (await fetch(`${h.serverUrl}/global/health`).then((r) => r.json())) as {
			version: string;
		};
		expect(health.version).toMatch(/^1\.18\./);
		const files = inspectHostOpenFiles(h.opencode.pid, dirname(h.opencode.env.configDir), h.contextDbPath());
		console.log(`issue-639 oc1 host=${health.version} pid=${files.pid} lsof=${JSON.stringify(files.databases)}`);
		const agents = (await fetch(`${h.serverUrl}/agent`).then((r) => r.json())) as Array<{
			name: string;
			permission: Rule[];
		}>;
		const byName = new Map(agents.map((agent) => [agent.name, agent]));
		for (const [name, allowed] of Object.entries(HIDDEN_AGENT_TOOLS)) {
			const agent = byName.get(name);
			expect(agent, `hidden agent ${name} is registered`).toBeDefined();
			const outcome = Object.fromEntries(
				["edit", "write", "bash", "task", "webfetch", ...allowed].map((tool) => [
					tool,
					evaluate(agent!.permission, tool),
				]),
			);
			console.log(`issue-639 oc1 agent ${name} resolved=${JSON.stringify(outcome)}`);
			for (const tool of ["edit", "write", "bash", "task", "webfetch"])
				expect({ name, tool, effect: outcome[tool] }).toEqual({ name, tool, effect: "deny" });
			for (const tool of allowed)
				expect({ name, tool, effect: outcome[tool] }).toEqual({ name, tool, effect: "allow" });
		}
	} finally {
		await h.dispose();
	}
}, 120_000);
