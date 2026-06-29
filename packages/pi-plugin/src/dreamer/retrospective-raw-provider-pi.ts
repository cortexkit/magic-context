import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type {
	RetrospectiveProjectSession,
	RetrospectiveRawMessage,
	RetrospectiveRawProvider,
	RetrospectiveSinceRead,
} from "@magic-context/core/features/magic-context/dreamer/retrospective-raw-provider";

interface PiSessionInfoLike {
	id?: unknown;
	path?: unknown;
	cwd?: unknown;
	modified?: unknown;
}

interface PiMessageEntryLike {
	type?: unknown;
	id?: unknown;
	message?: unknown;
}

interface PiUserMessageLike {
	role?: unknown;
	timestamp?: unknown;
	content?: unknown;
}

export interface PiRetrospectiveRawProviderDeps {
	projectCwd: string;
	sessionDir?: string;
	listSessions?: (sessionDir?: string) => unknown[] | Promise<unknown[]>;
	loadEntriesFromFile?: (filePath: string) => unknown[] | Promise<unknown[]>;
}

const PI_CODING_AGENT_MODULE = "@earendil-works/pi-coding-agent";

export class PiRetrospectiveRawProvider implements RetrospectiveRawProvider {
	private readonly sessionPathById = new Map<string, string>();
	private resolvedDefaultDeps: Promise<
		Required<
			Pick<
				PiRetrospectiveRawProviderDeps,
				"listSessions" | "loadEntriesFromFile"
			>
		>
	> | null = null;

	constructor(private readonly deps: PiRetrospectiveRawProviderDeps) {}

	async listProjectSessions(
		_projectIdentity: string,
	): Promise<RetrospectiveProjectSession[]> {
		const deps = await this.resolveDeps();
		const sessions = await deps.listSessions(this.deps.sessionDir);
		const projectCwd = resolve(this.deps.projectCwd);
		const result: RetrospectiveProjectSession[] = [];
		this.sessionPathById.clear();

		for (const raw of sessions) {
			const info = raw as PiSessionInfoLike | null;
			if (!info || typeof info !== "object") continue;
			if (typeof info.id !== "string" || typeof info.path !== "string")
				continue;
			if (typeof info.cwd !== "string" || resolve(info.cwd) !== projectCwd)
				continue;

			this.sessionPathById.set(info.id, info.path);
			result.push({
				sessionId: info.id,
				path: info.path,
				updatedAt:
					typeof info.modified === "number" ? info.modified : undefined,
			});
		}

		return result.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
	}

	async readUserMessagesSince(
		sessionId: string,
		sinceMs: number,
		capPerSession: number,
	): Promise<RetrospectiveSinceRead> {
		const all = await this.loadUserEntries(sessionId);
		// OLDEST-first cap: keep the oldest post-watermark messages so the
		// watermark walks forward through a backlog without skipping the gap
		// (mirrors the OpenCode reader; see readRetrospectiveScanWindow).
		const limit = Math.max(1, Math.floor(capPerSession));
		const eligible = all
			.filter((entry) => entry.ts > sinceMs)
			.sort((a, b) => a.ts - b.ts || a.ordinal - b.ordinal);
		// `truncated` is the exact saturation signal — more eligible rows existed
		// than the cap kept (Pi loads user-only entries, so length is reliable here,
		// but we keep the same contract as OpenCode for the aggregator).
		return {
			messages: eligible.slice(0, limit),
			truncated: eligible.length > limit,
		};
	}

	async readUserMessagesBefore(
		sessionId: string,
		beforeMs: number,
		count: number,
	): Promise<RetrospectiveRawMessage[]> {
		const all = await this.loadUserEntries(sessionId);
		return all
			.filter((entry) => entry.ts <= beforeMs)
			.sort((a, b) => a.ts - b.ts || a.ordinal - b.ordinal)
			.slice(-Math.max(1, Math.floor(count)));
	}

	private async loadUserEntries(
		sessionId: string,
	): Promise<RetrospectiveRawMessage[]> {
		const filePath = this.sessionPathById.get(sessionId);
		if (!filePath) return [];
		const deps = await this.resolveDeps();
		let entries: unknown[];
		try {
			entries = await deps.loadEntriesFromFile(filePath);
		} catch {
			return [];
		}
		if (!Array.isArray(entries)) return [];
		return entries
			.map((entry, index) => normalizePiUserEntry(entry, sessionId, index + 1))
			.filter((entry): entry is RetrospectiveRawMessage => entry !== null);
	}

	private async resolveDeps(): Promise<
		Required<
			Pick<
				PiRetrospectiveRawProviderDeps,
				"listSessions" | "loadEntriesFromFile"
			>
		>
	> {
		if (this.deps.listSessions && this.deps.loadEntriesFromFile) {
			return {
				listSessions: this.deps.listSessions,
				loadEntriesFromFile: this.deps.loadEntriesFromFile,
			};
		}
		this.resolvedDefaultDeps ??= loadDefaultPiSessionDeps();
		return this.resolvedDefaultDeps;
	}
}

function normalizePiUserEntry(
	entry: unknown,
	sessionId: string,
	ordinal: number,
): RetrospectiveRawMessage | null {
	const e = entry as PiMessageEntryLike | null;
	if (!e || typeof e !== "object" || e.type !== "message") return null;
	const message = e.message as PiUserMessageLike | null;
	if (!message || typeof message !== "object") return null;
	if (message.role !== "user" || typeof message.timestamp !== "number")
		return null;
	const text = extractPiTextContent(message.content).trim();
	if (!text) return null;
	return {
		sessionId,
		ordinal,
		role: "user",
		text,
		ts: message.timestamp,
	};
}

function extractPiTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => {
			if (part === null || typeof part !== "object") return [];
			const record = part as Record<string, unknown>;
			return record.type === "text" && typeof record.text === "string"
				? [record.text]
				: [];
		})
		.join("\n");
}

async function loadDefaultPiSessionDeps(): Promise<
	Required<
		Pick<PiRetrospectiveRawProviderDeps, "listSessions" | "loadEntriesFromFile">
	>
> {
	const mod = (await import(/* @vite-ignore */ PI_CODING_AGENT_MODULE)) as {
		SessionManager?: {
			listAll?: (sessionDir?: string) => unknown[] | Promise<unknown[]>;
		};
		loadEntriesFromFile?: (filePath: string) => unknown[] | Promise<unknown[]>;
		parseSessionEntries?: (content: string) => unknown[];
	};
	const listSessions = mod.SessionManager?.listAll;
	if (typeof listSessions !== "function") {
		throw new Error(
			"Pi session APIs unavailable: expected SessionManager.listAll on pi-coding-agent",
		);
	}
	// loadEntriesFromFile is NOT part of pi-coding-agent's public API —
	// fall back to readFileSync + parseSessionEntries (both exported).
	const loadEntriesFromFile: (
		filePath: string,
	) => unknown[] | Promise<unknown[]> =
		mod.loadEntriesFromFile ??
		((filePath: string) => {
			const content = readFileSync(filePath, "utf8");
			return mod.parseSessionEntries?.(content) ?? [];
		});
	return {
		listSessions: listSessions.bind(mod.SessionManager),
		loadEntriesFromFile,
	};
}
