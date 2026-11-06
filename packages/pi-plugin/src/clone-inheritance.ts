// Pi clone inheritance follows the durable-state rules documented in issue #225.
import { open, stat } from "node:fs/promises";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import {
	type CloneCompartmentRow,
	type CloneSessionStateFilter,
	type CloneTagRow,
	type CopySessionStateForCloneResult,
	copySessionStateForClone,
	type PendingPiCompactionMarker,
} from "@magic-context/core/features/magic-context/storage";
import { log } from "@magic-context/core/shared/logger";
import { copyPiDropBranches } from "./drop-branches-pi";
import { convertEntriesToRawMessages } from "./read-session-pi";

const CONTENT_ID_SUFFIX = /:(?:p|file)\d+$/;
const BARE_SESSION_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const loggedCloneStartFailures = new Set<string>();

function logCloneStartFailureOnce(sessionId: string, write: () => void): void {
	if (loggedCloneStartFailures.has(sessionId)) return;
	// Bound retained startup diagnostics in long-lived hosts with many children.
	if (loggedCloneStartFailures.size >= 1024) {
		const oldest = loggedCloneStartFailures.values().next().value;
		if (oldest !== undefined) loggedCloneStartFailures.delete(oldest);
	}
	loggedCloneStartFailures.add(sessionId);
	write();
}

type SessionManagerLike = {
	getSessionId?: () => string | undefined;
	getBranch?: () => unknown[];
	getHeader?: () => { parentSession?: unknown } | null;
};

type CloneContextLike = { sessionManager?: SessionManagerLike };
type CloneStartEventLike = { reason?: unknown; previousSessionFile?: unknown };

// OMP emits session_switch and session_branch after the destination session
// manager exposes the copied transcript through getBranch().
export type PiCloneTransitionRegistrar = (
	event: "session_switch" | "session_branch",
	handler: (event: CloneStartEventLike, ctx: CloneContextLike) => Promise<void>,
) => void;

export interface PiCloneInheritanceDeps {
	onInherited?: (sessionId: string) => void;
	db: ContextDatabase;
	signalPendingMarker: (sessionId: string) => void;
	writeLog?: (message: string) => void;
}

function entryId(entry: unknown): string | null {
	if (entry === null || typeof entry !== "object") return null;
	const id = (entry as { id?: unknown }).id;
	return typeof id === "string" && id.length > 0 ? id : null;
}

function branchPosition(entries: readonly unknown[], id: string): number {
	return entries.findIndex((entry) => entryId(entry) === id);
}

function latestCompactionFirstKept(entries: readonly unknown[]): string | null {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry === null || typeof entry !== "object") continue;
		const value = entry as { type?: unknown; firstKeptEntryId?: unknown };
		if (
			value.type === "compaction" &&
			typeof value.firstKeptEntryId === "string" &&
			value.firstKeptEntryId.length > 0
		) {
			return value.firstKeptEntryId;
		}
	}
	return null;
}

function parsePendingMarker(
	raw: string | null,
): PendingPiCompactionMarker | null {
	if (!raw) return null;
	try {
		const value = JSON.parse(raw) as Partial<PendingPiCompactionMarker>;
		if (
			typeof value.firstKeptEntryId === "string" &&
			typeof value.endMessageId === "string" &&
			typeof value.ordinal === "number" &&
			Number.isFinite(value.ordinal) &&
			typeof value.tokensBefore === "number" &&
			Number.isFinite(value.tokensBefore) &&
			typeof value.summary === "string" &&
			typeof value.publishedAt === "number" &&
			Number.isFinite(value.publishedAt)
		) {
			return value as PendingPiCompactionMarker;
		}
	} catch {
		return null;
	}
	return null;
}

function createCloneFilter(
	entries: readonly unknown[],
): CloneSessionStateFilter {
	const rawMessages = convertEntriesToRawMessages([...entries]);
	const rawOrdinalById = new Map(
		rawMessages.map((message) => [message.id, message.ordinal]),
	);
	const validStateIds = new Set<string>(rawOrdinalById.keys());
	const validOrdinals = new Set<number>(rawOrdinalById.values());
	for (const entry of entries) {
		const id = entryId(entry);
		if (id) validStateIds.add(id);
	}
	const includeMessageId = (id: string) => validStateIds.has(id);

	return {
		resolveBoundaryOrdinal: (id) => rawOrdinalById.get(id),
		includeMessageId,
		copySessionNotesAndFacts: true,
		mapOrdinal: (ordinal) => (validOrdinals.has(ordinal) ? ordinal : undefined),
		includeTag: (tag: CloneTagRow) => {
			if (tag.type === "tool") {
				return (
					typeof tag.toolOwnerMessageId === "string" &&
					includeMessageId(tag.toolOwnerMessageId)
				);
			}
			return rawOrdinalById.has(tag.messageId.replace(CONTENT_ID_SUFFIX, ""));
		},
		selectPendingPiMarker: (
			rawState: string | null,
			copiedCompartments: readonly CloneCompartmentRow[],
		): string | null => {
			const pending = parsePendingMarker(rawState);
			if (!pending) return null;
			if (pending.firstKeptEntryId === null) return null;
			const pendingFirstKeptPosition = branchPosition(
				entries,
				pending.firstKeptEntryId,
			);
			if (pendingFirstKeptPosition < 0) return null;

			const mappedOrdinal = rawOrdinalById.get(pending.endMessageId);
			if (mappedOrdinal === undefined) return null;
			const matchingCompartment = copiedCompartments.find(
				(compartment) =>
					compartment.endMessageId === pending.endMessageId &&
					compartment.endMessage === mappedOrdinal,
			);
			if (!matchingCompartment) return null;

			const currentFirstKept = latestCompactionFirstKept(entries);
			if (currentFirstKept !== null) {
				const currentPosition = branchPosition(entries, currentFirstKept);
				if (currentPosition >= pendingFirstKeptPosition) return null;
			}

			return JSON.stringify({ ...pending, ordinal: mappedOrdinal });
		},
	};
}

export async function readPiSessionIdFromFile(
	filePath: string,
): Promise<string> {
	const file = await open(filePath, "r");
	try {
		// Only the header is needed, not a potentially enormous parent transcript.
		// OMP may place a title record before the actual session header.
		const prefix = Buffer.alloc(64 * 1024);
		const { bytesRead } = await file.read(prefix, 0, prefix.length, 0);
		for (const line of prefix
			.subarray(0, bytesRead)
			.toString("utf8")
			.split("\n")) {
			if (!line.trim()) continue;
			let header: { type?: unknown; id?: unknown };
			try {
				header = JSON.parse(line);
			} catch {
				break;
			}
			if (header?.type === "title") continue;
			if (
				header?.type === "session" &&
				typeof header.id === "string" &&
				header.id.length > 0
			)
				return header.id;
			break;
		}
	} finally {
		await file.close();
	}
	throw new Error("previous session file has no valid session header");
}

async function resolveStartupParentSessionId(parent: string): Promise<string> {
	try {
		if ((await stat(parent)).isFile())
			return await readPiSessionIdFromFile(parent);
	} catch (error) {
		const code = (error as { code?: unknown } | null)?.code;
		if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
	}
	// Native Pi stores a file path; OMP forkFrom stores the source UUID. Only
	// accept an explicit ID, never search session directories or guess filenames.
	if (!/[\\/]/.test(parent) && BARE_SESSION_ID.test(parent)) return parent;
	throw new Error(
		"parentSession is neither an existing session file nor a bare session UUID",
	);
}

/** Fail-open session-start entry point for Pi fork/clone state inheritance. */
export async function handlePiCloneSessionStart(
	event: CloneStartEventLike,
	ctx: CloneContextLike,
	deps: PiCloneInheritanceDeps,
): Promise<CopySessionStateForCloneResult | null> {
	// Oh My Pi omits reason on startup; this session_start hook treats that absence as startup.
	const isStartup = event.reason === "startup" || event.reason === undefined;
	if (event.reason !== "fork" && !isStartup) return null;
	return inheritPiCloneSession(event, ctx, deps, isStartup);
}

export function registerPiCloneSessionTransitions(
	on: PiCloneTransitionRegistrar,
	deps: PiCloneInheritanceDeps,
): void {
	on("session_switch", async (event, ctx) => {
		if (event.reason !== "fork") return;
		await inheritPiCloneSession(event, ctx, deps, false);
	});
	on("session_branch", async (event, ctx) => {
		if (
			event.reason !== "fork" &&
			event.reason !== "branch" &&
			event.reason !== "btw"
		)
			return;
		await inheritPiCloneSession(event, ctx, deps, false);
	});
}

async function inheritPiCloneSession(
	event: CloneStartEventLike,
	ctx: CloneContextLike,
	deps: PiCloneInheritanceDeps,
	isStartup: boolean,
): Promise<CopySessionStateForCloneResult | null> {
	let stage = "resolve-destination";
	let sourceSessionId = "unknown";
	let destinationSessionId = "unknown";
	const writeLog = deps.writeLog ?? log;
	try {
		const manager = ctx.sessionManager;
		if (typeof manager?.getSessionId !== "function") {
			throw new Error("Pi session manager does not expose getSessionId");
		}
		destinationSessionId = manager.getSessionId() ?? "";
		if (destinationSessionId.length === 0) {
			throw new Error("Pi clone session id is empty");
		}
		const sourceReference = isStartup
			? manager.getHeader?.()?.parentSession
			: event.previousSessionFile;
		// A header without ancestry is an ordinary new session, not a failed fork.
		if (isStartup && sourceReference === undefined) return null;
		if (typeof sourceReference !== "string" || sourceReference.length === 0) {
			logCloneStartFailureOnce(destinationSessionId, () =>
				writeLog(
					`[magic-context][pi] clone-inheritance: skipped dest=${destinationSessionId} reason=missing-parent`,
				),
			);
			return null;
		}

		stage = "read-source-header";
		sourceSessionId = isStartup
			? await resolveStartupParentSessionId(sourceReference)
			: await readPiSessionIdFromFile(sourceReference);

		stage = "read-clone-branch";
		if (typeof manager.getBranch !== "function") {
			throw new Error("Pi session manager does not expose getBranch");
		}
		const branchEntries = manager.getBranch();
		if (!Array.isArray(branchEntries)) {
			throw new Error("Pi clone branch is unavailable");
		}

		stage = "copy-state";
		const filter = createCloneFilter(branchEntries);
		const result = copySessionStateForClone(
			deps.db,
			sourceSessionId,
			destinationSessionId,
			{
				...filter,
				requireEmptyDestinationMeta: isStartup,
				selectPendingPiMarker: (raw, compartments) => {
					// The copier selects metadata after copying tags, inside its guarded
					// transaction. Carry provenance atomically with those same tag rows.
					copyPiDropBranches(deps.db, sourceSessionId, destinationSessionId);
					return filter.selectPendingPiMarker(raw, compartments);
				},
			},
		);
		if (result.kind === "destination-not-empty") {
			writeLog(
				`[magic-context][pi] clone-inheritance: skipped source=${sourceSessionId} dest=${destinationSessionId} stage=destination-guard reason=destination-not-empty`,
			);
			return result;
		}

		stage = "signal-marker";
		if (result.pendingMarkerMigrated) {
			deps.signalPendingMarker(destinationSessionId);
		}
		writeLog(
			`[magic-context][pi] clone-inheritance: migrated compartments=${result.compartmentsCopied} tags=${result.tagsCopied} notes=${result.notesCopied} facts=${result.factsCopied} source=${sourceSessionId} dest=${destinationSessionId} reason=${isStartup ? "startup" : event.reason}`,
		);
		deps.onInherited?.(destinationSessionId);
		return result;
	} catch (error) {
		logCloneStartFailureOnce(destinationSessionId, () =>
			writeLog(
				`[magic-context][pi] clone-inheritance: failed source=${sourceSessionId} dest=${destinationSessionId} stage=${stage} error=${error instanceof Error ? error.message : String(error)}; run /ctx-wrapup to rebuild, or re-clone`,
			),
		);
		return null;
	}
}

export const __test = { createCloneFilter, parsePendingMarker };
