import { stat } from "node:fs/promises";
import { join } from "node:path";
import type {
	RetrospectiveProjectSession,
	RetrospectiveRawMessage,
	RetrospectiveRawProvider,
	RetrospectiveSinceRead,
} from "@magic-context/core/features/magic-context/dreamer/retrospective-raw-provider";
import { readSessionActivity } from "@magic-context/core/features/magic-context/session-activity";
import { cleanUserText } from "@magic-context/core/hooks/magic-context/read-session-chunk";
import { sameProjectDirectory } from "@magic-context/core/shared/project-directory-key";
import type { Database } from "@magic-context/core/shared/sqlite";
import {
	asyncSessionEntries,
	asyncSessionHeaders,
} from "./bounded-session-reader";
import { resolvePiCodingAgentModule } from "./pi-session-api";

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
	contextDb?: Database;
	sessionDir?: string;
	listSessions?: (sessionDir?: string) => unknown[] | Promise<unknown[]>;
	loadEntriesFromFile?: (filePath: string) => unknown[] | Promise<unknown[]>;
}

export class PiRetrospectiveRawProvider implements RetrospectiveRawProvider {
	private readonly sessionPathById = new Map<string, string>();

	constructor(private readonly deps: PiRetrospectiveRawProviderDeps) {}

	async listProjectSessions(
		_projectIdentity: string,
	): Promise<RetrospectiveProjectSession[]> {
		let directory = this.deps.sessionDir;
		if (!directory && !this.deps.listSessions) {
			const mod = (await resolvePiCodingAgentModule()) as {
				getAgentDir?: () => string;
			};
			if (!mod.getAgentDir) return [];
			directory = join(mod.getAgentDir(), "sessions");
		}
		const sessions = this.deps.listSessions
			? await this.deps.listSessions(directory)
			: directory
				? asyncSessionHeaders(directory, !this.deps.sessionDir)
				: [];
		const projectCwd = this.deps.projectCwd;
		const result: RetrospectiveProjectSession[] = [];
		this.sessionPathById.clear();

		for await (const raw of sessions) {
			const info = raw as PiSessionInfoLike | null;
			if (!info || typeof info !== "object") continue;
			if (typeof info.id !== "string" || typeof info.path !== "string")
				continue;
			// One spelling-normalized comparison for every host: separators,
			// Windows drive-letter case and trailing separators do not make this
			// project's sessions look foreign, and other directories stay out.
			if (
				typeof info.cwd !== "string" ||
				!sameProjectDirectory(info.cwd, projectCwd)
			)
				continue;

			const activity = this.deps.contextDb
				? readSessionActivity(this.deps.contextDb, info.id)
				: typeof info.modified === "number"
					? info.modified
					: undefined;
			if (this.deps.contextDb && activity === undefined) continue;
			this.sessionPathById.set(info.id, info.path);
			result.push({
				sessionId: info.id,
				path: info.path,
				updatedAt: activity,
			});
		}

		return result.sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0));
	}

	async readUserMessagesSince(
		sessionId: string,
		sinceMs: number,
		capPerSession: number,
	): Promise<RetrospectiveSinceRead> {
		const limit = Math.max(1, Math.floor(capPerSession));
		const messages = await this.selectUserEntries(
			sessionId,
			(ts) => ts > sinceMs,
			limit + 1,
			false,
			sinceMs,
		);
		return {
			messages: messages.slice(0, limit),
			truncated: messages.length > limit,
		};
	}

	async readOldestMessageTimesSince(
		sessionIds: readonly string[],
		sinceMs: number,
	): Promise<Map<string, number>> {
		const out = new Map<string, number>();
		for (const sessionId of sessionIds) {
			const [oldest] = await this.selectUserEntries(
				sessionId,
				(ts) => ts > sinceMs,
				1,
				false,
				sinceMs,
			);
			if (oldest) out.set(sessionId, oldest.ts);
		}
		return out;
	}

	async readUserMessagesBefore(
		sessionId: string,
		beforeMs: number,
		count: number,
	): Promise<RetrospectiveRawMessage[]> {
		return this.selectUserEntries(
			sessionId,
			(ts) => ts <= beforeMs,
			Math.max(1, Math.floor(count)),
			true,
		);
	}

	private async selectUserEntries(
		sessionId: string,
		eligible: (ts: number) => boolean,
		limit: number,
		newest: boolean,
		sinceMs?: number,
	): Promise<RetrospectiveRawMessage[]> {
		const filePath = this.sessionPathById.get(sessionId);
		if (!filePath) return [];
		const kept: RetrospectiveRawMessage[] = [];
		try {
			// Imported/branched entry timestamps may not follow file order, so scan
			// files to EOF unless their mtime rules them out. A file cannot contain
			// an entry written after its own mtime: mtime before sinceMs means no
			// later-written entry can qualify for this since query.
			if (sinceMs !== undefined && !this.deps.loadEntriesFromFile) {
				if ((await stat(filePath)).mtimeMs < sinceMs) return [];
			}
			const entries = this.deps.loadEntriesFromFile
				? await this.deps.loadEntriesFromFile(filePath)
				: asyncSessionEntries(filePath);
			let ordinal = 0;
			let sawUserMessage = false;
			let sawAssistantReply = false;
			// Keep assistant text private while retaining whether a reply preceded a later user line.
			for await (const entry of entries) {
				ordinal++;
				let row: RetrospectiveRawMessage | null = null;
				if (isPiUserEntry(entry)) {
					row = normalizePiUserEntry(
						entry,
						sessionId,
						ordinal,
						sawUserMessage && sawAssistantReply,
					);
					sawUserMessage = true;
				} else if (sawUserMessage && isPiAssistantEntry(entry)) {
					sawAssistantReply = true;
				}
				if (!row || !eligible(row.ts)) continue;
				kept.push(row);
				kept.sort((a, b) => a.ts - b.ts || a.ordinal - b.ordinal);
				if (kept.length > limit) {
					if (newest) kept.shift();
					else kept.pop();
				}
			}
		} catch {
			return [];
		}
		// Timestamps need not be monotonic in imported/branched sessions. Scan to
		// EOF but retain only the requested prefix (or overlap suffix), not history.
		return kept;
	}
}

function normalizePiUserEntry(
	entry: unknown,
	sessionId: string,
	ordinal: number,
	followsAssistantReply: boolean,
): RetrospectiveRawMessage | null {
	const e = entry as PiMessageEntryLike | null;
	if (!e || typeof e !== "object" || e.type !== "message") return null;
	const message = e.message as PiUserMessageLike | null;
	if (!message || typeof message !== "object") return null;
	if (message.role !== "user" || typeof message.timestamp !== "number")
		return null;
	const text = cleanUserText(extractPiTextContent(message.content));
	if (!text) return null;
	return {
		sessionId,
		ordinal,
		role: "user",
		text,
		ts: message.timestamp,
		...(followsAssistantReply ? { followsAssistantReply: true } : {}),
	};
}

function isPiUserEntry(entry: unknown): boolean {
	return piMessageRole(entry) === "user";
}

function isPiAssistantEntry(entry: unknown): boolean {
	return piMessageRole(entry) === "assistant";
}

function piMessageRole(entry: unknown): unknown {
	const e = entry as PiMessageEntryLike | null;
	if (!e || typeof e !== "object" || e.type !== "message") return null;
	const message = e.message as PiUserMessageLike | null;
	return message && typeof message === "object" ? message.role : null;
}

function extractPiTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => {
			if (part === null || typeof part !== "object") return [];
			const record = part as Record<string, unknown>;
			return record.synthetic !== true &&
				record.type === "text" &&
				typeof record.text === "string"
				? [record.text]
				: [];
		})
		.join("\n");
}
