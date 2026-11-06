import { ensureSessionMetaRow } from "@magic-context/core/features/magic-context/storage-meta-shared";
import { getNativeReplayState } from "@magic-context/core/features/magic-context/storage-native-replay";
import { updateReplayDocument } from "@magic-context/core/features/magic-context/storage-replay-document";
import type { Database } from "@magic-context/core/shared/sqlite";

const KEY = "piDropBranches";
type Journal = {
	drops: Record<string, string>;
	pending: Record<string, string>;
};
const installed = new WeakSet<Database>();

/** Record the branch leaf in the writer's transaction when a drop is queued or applied. */
export function trackPiDropLeaf(
	db: Database,
	sessionId: string,
	leaf: string | null,
): void {
	if (!installed.has(db)) {
		db.exec(`
			CREATE TEMP TABLE IF NOT EXISTS pi_drop_leaf (session_id TEXT PRIMARY KEY, leaf TEXT);
			CREATE TEMP TRIGGER IF NOT EXISTS pi_drop_queued AFTER INSERT ON main.pending_ops
			WHEN NEW.operation = 'drop' AND EXISTS (SELECT 1 FROM pi_drop_leaf WHERE session_id = NEW.session_id AND leaf IS NOT NULL)
			BEGIN
				UPDATE session_meta SET deferred_execute_state = json_set(
					COALESCE(NULLIF(deferred_execute_state, ''), '{}'),
					'$.${KEY}.pending."' || NEW.tag_id || '"',
					(SELECT leaf FROM pi_drop_leaf WHERE session_id = NEW.session_id))
				WHERE session_id = NEW.session_id;
			END;
			CREATE TEMP TRIGGER IF NOT EXISTS pi_drop_applied AFTER UPDATE OF status ON main.tags
			WHEN NEW.status = 'dropped' AND OLD.status != 'dropped'
				AND EXISTS (SELECT 1 FROM pi_drop_leaf WHERE session_id = NEW.session_id AND leaf IS NOT NULL)
			BEGIN
				UPDATE session_meta SET deferred_execute_state = json_remove(json_set(
					COALESCE(NULLIF(deferred_execute_state, ''), '{}'),
					'$.${KEY}.drops."' || NEW.tag_number || '"',
					COALESCE(json_extract(deferred_execute_state, '$.${KEY}.pending."' || NEW.tag_number || '"'),
						(SELECT leaf FROM pi_drop_leaf WHERE session_id = NEW.session_id))),
					'$.${KEY}.pending."' || NEW.tag_number || '"')
				WHERE session_id = NEW.session_id;
			END;
			CREATE TEMP TRIGGER IF NOT EXISTS pi_drop_retired AFTER UPDATE OF status ON main.tags
			WHEN NEW.status = 'compacted'
			BEGIN
				UPDATE session_meta SET deferred_execute_state = json_remove(
					COALESCE(NULLIF(deferred_execute_state, ''), '{}'),
					'$.${KEY}.drops."' || NEW.tag_number || '"', '$.${KEY}.pending."' || NEW.tag_number || '"')
				WHERE session_id = NEW.session_id AND json_type(deferred_execute_state, '$.${KEY}') = 'object';
			END;
		`);
		installed.add(db);
	}
	ensureSessionMetaRow(db, sessionId);
	db.prepare(
		"INSERT INTO pi_drop_leaf VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET leaf = excluded.leaf",
	).run(sessionId, leaf);
}

function state(db: Database, sessionId: string): Record<string, unknown> {
	const row = db
		.prepare(
			"SELECT deferred_execute_state AS state FROM session_meta WHERE session_id = ?",
		)
		.get(sessionId) as { state: string | null } | undefined;
	const value: unknown = row?.state ? JSON.parse(row.state) : {};
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid session metadata JSON");
	return value as Record<string, unknown>;
}

function journal(value: unknown): Journal {
	const result: Journal = { drops: {}, pending: {} };
	if (!value || typeof value !== "object") return result;
	for (const kind of ["drops", "pending"] as const) {
		const entries = (value as Partial<Journal>)[kind];
		if (!entries || typeof entries !== "object") continue;
		for (const [tag, leaf] of Object.entries(entries)) {
			if (/^\d+$/.test(tag) && typeof leaf === "string" && leaf)
				result[kind][tag] = leaf;
		}
	}
	return result;
}

function save(
	db: Database,
	sessionId: string,
	document: Record<string, unknown>,
	value: Journal,
): void {
	document[KEY] = value;
	db.prepare(
		"UPDATE session_meta SET deferred_execute_state = ? WHERE session_id = ?",
	).run(JSON.stringify(document), sessionId);
}

/** A partial branch cannot prove that a decision is abandoned. */
export function piDropBranchIds(
	entries: readonly unknown[],
): Set<string> | null {
	const ids = new Set<string>();
	let parent: string | null = null;
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") return null;
		const row = entry as { id?: unknown; parentId?: unknown };
		if (
			typeof row.id !== "string" ||
			!row.id ||
			row.parentId !== parent ||
			ids.has(row.id)
		)
			return null;
		ids.add(row.id);
		parent = row.id;
	}
	return ids;
}

/**
 * Cancel abandoned queued drops on every pass before estimating reclaim: they
 * have changed no served bytes, whereas restoring applied drops needs a rebuild.
 * Returning to the abandoned branch loses a cancelled mark; the old code also
 * cancelled it at the next rebuild, and the model can mark the content again.
 */
export function cancelPiAbandonedPendingDrops(
	db: Database,
	sessionId: string,
	ids: ReadonlySet<string> | null,
): number {
	if (!ids) return 0;
	return db
		.transaction(() => {
			const document = state(db, sessionId);
			const saved = journal(document[KEY]);
			const offPending = Object.entries(saved.pending).filter(
				([, leaf]) => !ids.has(leaf),
			);
			if (!offPending.length) return 0;
			for (const [tag] of offPending) {
				db.prepare(
					"DELETE FROM pending_ops WHERE session_id = ? AND tag_id = ?",
				).run(sessionId, Number(tag));
				delete saved.pending[tag];
			}
			save(db, sessionId, document, saved);
			return offPending.length;
		})
		.immediate();
}

/** Never grants a rebuild: applied-drop restoration must ride an authorized rewrite. */
export function reconcilePiDropBranches(
	db: Database,
	sessionId: string,
	ids: ReadonlySet<string> | null,
	canRebuild: boolean,
): number {
	if (!canRebuild || !ids) return 0;
	return db
		.transaction(() => {
			const document = state(db, sessionId);
			const saved = journal(document[KEY]);
			const offBranch = Object.entries(saved.drops).filter(
				([, leaf]) => !ids.has(leaf),
			);
			if (!offBranch.length) return 0;
			const native = getNativeReplayState(db, sessionId);
			let restored = 0;
			for (const [tag] of offBranch) {
				const row = db
					.prepare(
						"UPDATE tags SET status = 'active', drop_mode = 'full' WHERE session_id = ? AND tag_number = ? AND status = 'dropped' RETURNING message_id, type",
					)
					.get(sessionId, Number(tag)) as
					| { message_id: string; type: string }
					| undefined;
				if (row) {
					restored++;
					if (row.type === "tool") native.toolInputs.delete(row.message_id);
				}
				delete saved.drops[tag];
			}
			if (
				restored &&
				!updateReplayDocument(db, sessionId, (doc) => {
					if (doc.piNative === undefined) return false;
					if (
						!doc.piNative ||
						typeof doc.piNative !== "object" ||
						Array.isArray(doc.piNative)
					)
						throw new Error("Invalid Pi native replay state");
					doc.piNative = {
						...doc.piNative,
						toolInputs: Object.fromEntries(native.toolInputs),
					};
					return true;
				})
			)
				throw new Error("Cannot persist restored Pi tool inputs");
			save(db, sessionId, document, saved);
			return restored;
		})
		.immediate();
}

/** Keep provenance with copied tags; the child's first rebuilding pass reconciles it. */
export function copyPiDropBranches(
	db: Database,
	source: string,
	destination: string,
): void {
	const sourceJournal = journal(state(db, source)[KEY]);
	const tags = new Set(
		(
			db
				.prepare("SELECT tag_number FROM tags WHERE session_id = ?")
				.all(destination) as { tag_number: number }[]
		).map((row) => String(row.tag_number)),
	);
	for (const kind of ["drops", "pending"] as const) {
		for (const tag of Object.keys(sourceJournal[kind]))
			if (!tags.has(tag)) delete sourceJournal[kind][tag];
	}
	ensureSessionMetaRow(db, destination);
	save(db, destination, state(db, destination), sourceJournal);
}
