/**
 * Claude OAuth helper for harness scripts.
 *
 * Reads credentials from macOS Keychain (Claude Code login) or
 * `~/.claude/.credentials.json` fallback, builds the OAuth-style request
 * (system identity prefix, billing header, beta flags, OAuth Bearer token),
 * and calls Anthropic with Claude Max subscription auth.
 *
 * Mirrors the request shape used by `opencode-claude-auth` to keep
 * Anthropic's OAuth backend happy.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

const SYSTEM_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const CLI_VERSION = process.env.ANTHROPIC_CLI_VERSION ?? "2.1.80";
const USER_AGENT = `claude-cli/${CLI_VERSION} (external, cli)`;
const BETA_FLAGS = [
	"claude-code-20250219",
	"oauth-2025-04-20",
	"interleaved-thinking-2025-05-14",
	"prompt-caching-scope-2026-01-05",
];
const BILLING_SALT = "59cf53e54c78";

interface ClaudeCredentials {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
}

function readKeychainCredentials(): ClaudeCredentials | null {
	if (process.platform !== "darwin") return null;
	try {
		const raw = execSync(`security find-generic-password -s "Claude Code-credentials" -w`, {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
		}).trim();
		return parseCredentialBlob(raw);
	} catch {
		return null;
	}
}

function readCredentialsFile(): ClaudeCredentials | null {
	const path = join(homedir(), ".claude", ".credentials.json");
	if (!existsSync(path)) return null;
	try {
		return parseCredentialBlob(readFileSync(path, "utf-8"));
	} catch {
		return null;
	}
}

function parseCredentialBlob(raw: string): ClaudeCredentials | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	const data = (parsed as { claudeAiOauth?: unknown }).claudeAiOauth ?? parsed;
	const c = data as { accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown };
	if (typeof c.accessToken !== "string" || typeof c.refreshToken !== "string" || typeof c.expiresAt !== "number") {
		return null;
	}
	return { accessToken: c.accessToken, refreshToken: c.refreshToken, expiresAt: c.expiresAt };
}

export function getClaudeOAuthToken(): string | null {
	const creds = readKeychainCredentials() ?? readCredentialsFile();
	if (!creds) return null;
	if (creds.expiresAt < Date.now()) {
		console.error("⚠ Claude OAuth token expired. Run `claude` to refresh.");
		return null;
	}
	return creds.accessToken;
}

function buildBillingHeader(firstUserText: string): string {
	const sampled = [4, 7, 20].map((i) => (i < firstUserText.length ? firstUserText[i] : "0")).join("");
	const suffix = createHash("sha256").update(`${BILLING_SALT}${sampled}${CLI_VERSION}`).digest("hex").slice(0, 3);
	const cch = createHash("sha256").update(firstUserText).digest("hex").slice(0, 5);
	return `x-anthropic-billing-header: cc_version=${CLI_VERSION}.${suffix}; cc_entrypoint=cli; cch=${cch};`;
}

export interface ClaudeResponse {
	content: Array<{ type: string; text?: string; thinking?: string }>;
	stop_reason?: string;
	usage?: {
		input_tokens: number;
		output_tokens: number;
		cache_creation_input_tokens?: number;
		cache_read_input_tokens?: number;
	};
}

export interface CallOptions {
	maxTokens?: number;
	/** Extended thinking budget in tokens. 0 or omitted disables thinking. */
	thinkingBudget?: number;
}

/**
 * Call Anthropic via Claude Max OAuth.
 * Throws if no credentials are available — caller should fall back to API key.
 */
export async function callClaudeOAuth(
	model: string,
	systemPrompt: string,
	userPrompt: string,
	options: CallOptions = {},
): Promise<ClaudeResponse> {
	const accessToken = getClaudeOAuthToken();
	if (!accessToken) {
		throw new Error("No Claude OAuth credentials available");
	}

	const maxTokens = options.maxTokens ?? 16000;
	const thinkingBudget = options.thinkingBudget ?? 0;

	// OAuth requires structured `system` array with identity prefix as its own
	// entry, billing header at index 0, then the actual prompt as a separate entry.
	const billingHeader = buildBillingHeader(userPrompt);
	const system = [
		{ type: "text", text: billingHeader },
		{ type: "text", text: SYSTEM_IDENTITY },
		{ type: "text", text: systemPrompt },
	];

	const sessionId = randomUUID();
	const requestId = randomUUID();

	// When extended thinking is enabled, max_tokens must exceed thinking budget,
	// and temperature must be 1 (no other temperature allowed).
	const body: Record<string, unknown> = {
		model,
		max_tokens: thinkingBudget > 0 ? maxTokens + thinkingBudget : maxTokens,
		system,
		messages: [{ role: "user", content: userPrompt }],
	};
	if (thinkingBudget > 0) {
		body.thinking = { type: "enabled", budget_tokens: thinkingBudget };
		body.temperature = 1;
	}

	const response = await fetch("https://api.anthropic.com/v1/messages", {
		method: "POST",
		headers: {
			authorization: `Bearer ${accessToken}`,
			"anthropic-version": "2023-06-01",
			"anthropic-beta": BETA_FLAGS.join(","),
			"content-type": "application/json",
			"x-app": "cli",
			"user-agent": USER_AGENT,
			"x-client-request-id": requestId,
			"X-Claude-Code-Session-Id": sessionId,
		},
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		const errText = await response.text();
		throw new Error(`Claude OAuth API ${response.status}: ${errText}`);
	}
	return (await response.json()) as ClaudeResponse;
}
