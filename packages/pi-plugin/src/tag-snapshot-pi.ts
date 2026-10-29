import {
	TAG_INSERT_CONFLICT_ROWS,
	tagRevisionCountSql,
	tagRevisionIncarnationSql,
	tagRevisionKey,
} from "@magic-context/core/features/magic-context/storage-tag-identity-revision";
import {
	getTagsByNumbers,
	getTagsBySession,
} from "@magic-context/core/features/magic-context/storage-tags";
import {
	type Database,
	getSqliteDatabasePath,
	inRootAsyncContext,
	withSqliteTurnDeadline,
} from "@magic-context/core/shared/sqlite";
import type { PiContextBudget } from "./pi-context-budget";
import { PI_CONTEXT_BUDGET } from "./pi-context-budget";
import {
	type PiHydrationGeneration,
	type PiHydrationRequest,
	PiTagHydrationError,
	startPiTagSnapshotWorker,
} from "./tag-snapshot-worker-client-pi";

/** Connection-local tag revisions avoid invalidating snapshots for unrelated metadata writes. */
export function createPiTagSnapshotReader(db: Database) {
	const existing = readers.get(db);
	if (existing) return existing;
	const nativeWaiters = new Set<() => number>();
	const inSnapshotRoot = <T>(operation: () => T): T =>
		inRootAsyncContext(() =>
			withSqliteTurnDeadline(() => {
				let remaining = Infinity;
				for (const waiter of nativeWaiters)
					remaining = Math.min(remaining, waiter());
				return remaining;
			}, operation),
		);
	// Replace the pi_tag_insert/update/delete TEMP triggers when an extension
	// reload keeps its SQLite connection: older definitions tracked only a
	// revision, not the changed tag numbers needed to update cached rows.
	// An outer write's conflict policy can override OR IGNORE inside a trigger,
	// so journal inserts explicitly exclude keys already present.
	// REPLACE's implicit deletes may skip DELETE triggers. Before insertion,
	// record conflicting rows' old sessions/numbers and the same write counts
	// as the shared revision observer.
	db.exec(`
		CREATE TEMP TABLE IF NOT EXISTS pi_tag_revision (revision INTEGER NOT NULL);
		INSERT INTO pi_tag_revision SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM pi_tag_revision);
		CREATE TEMP TABLE IF NOT EXISTS pi_tag_session_revision (session_id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
		CREATE TEMP TABLE IF NOT EXISTS pi_tag_watch (session_id TEXT PRIMARY KEY);
		CREATE TEMP TABLE IF NOT EXISTS pi_tag_changes (session_id TEXT, tag_number INTEGER, PRIMARY KEY (session_id, tag_number));
		CREATE TEMP TABLE IF NOT EXISTS pi_tag_version_own (session_id TEXT PRIMARY KEY, count INTEGER NOT NULL);
		CREATE TEMP TABLE IF NOT EXISTS pi_tag_first_watch (session_id TEXT PRIMARY KEY);
		CREATE TEMP TABLE IF NOT EXISTS pi_tag_first_rows (session_id TEXT, id INTEGER, tag_number INTEGER, PRIMARY KEY(session_id, id));
		CREATE TEMP TABLE IF NOT EXISTS pi_tag_first_allocation (session_id TEXT PRIMARY KEY, incarnation TEXT, seen INTEGER);
		DROP TRIGGER IF EXISTS temp.pi_tag_first_allocation;
		CREATE TEMP TRIGGER pi_tag_first_allocation AFTER UPDATE ON main.schema_migrations_meta
		WHEN SUBSTR(NEW.key, 1, 13) = 'tag_revision:' AND INSTR(OLD.value, ':') = 0
		AND NEW.value = (SELECT value FROM schema_migrations_meta WHERE key = 'tag_revision_incarnation') || ':' || OLD.value
		AND EXISTS (SELECT 1 FROM pi_tag_first_watch WHERE session_id = SUBSTR(NEW.key, 14)) BEGIN
			INSERT INTO pi_tag_first_allocation SELECT SUBSTR(NEW.key, 14), ${tagRevisionIncarnationSql("NEW.value")}, 0
			WHERE NOT EXISTS (SELECT 1 FROM pi_tag_first_allocation WHERE session_id = SUBSTR(NEW.key, 14));
			UPDATE pi_tag_first_allocation SET seen = seen + 1 WHERE session_id = SUBSTR(NEW.key, 14);
		END;
		DROP TRIGGER IF EXISTS temp.pi_tag_version_ai;
		DROP TRIGGER IF EXISTS temp.pi_tag_version_ad;
		DROP TRIGGER IF EXISTS temp.pi_tag_version_au;
		DROP TRIGGER IF EXISTS temp.pi_tag_insert;
		DROP TRIGGER IF EXISTS temp.pi_tag_update;
		DROP TRIGGER IF EXISTS temp.pi_tag_delete;
		DROP TRIGGER IF EXISTS temp.pi_tag_insert_conflicts;
		CREATE TEMP TRIGGER pi_tag_insert_conflicts BEFORE INSERT ON main.tags BEGIN
			UPDATE pi_tag_revision SET revision = revision + (SELECT COUNT(*) FROM (${TAG_INSERT_CONFLICT_ROWS}));
			INSERT INTO pi_tag_session_revision
				SELECT session_id, COUNT(*) FROM (${TAG_INSERT_CONFLICT_ROWS}) GROUP BY session_id
				ON CONFLICT(session_id) DO UPDATE SET revision = revision + excluded.revision;
			INSERT INTO pi_tag_changes
				SELECT session_id, tag_number FROM (${TAG_INSERT_CONFLICT_ROWS}) AS conflicts
				WHERE EXISTS (SELECT 1 FROM pi_tag_watch WHERE session_id = conflicts.session_id)
				AND NOT EXISTS (SELECT 1 FROM pi_tag_changes WHERE session_id = conflicts.session_id AND tag_number = conflicts.tag_number)
				GROUP BY session_id, tag_number;
		END;
		CREATE TEMP TRIGGER IF NOT EXISTS pi_tag_insert AFTER INSERT ON main.tags BEGIN
			INSERT INTO pi_tag_first_rows SELECT NEW.session_id, NEW.id, NEW.tag_number
			WHERE EXISTS (SELECT 1 FROM pi_tag_first_watch WHERE session_id = NEW.session_id)
			AND NOT EXISTS (SELECT 1 FROM pi_tag_first_rows WHERE session_id = NEW.session_id AND id = NEW.id);
			UPDATE pi_tag_revision SET revision = revision + 1;
			INSERT INTO pi_tag_session_revision VALUES (NEW.session_id, 1) ON CONFLICT(session_id) DO UPDATE SET revision = revision + 1;
			INSERT INTO pi_tag_changes SELECT NEW.session_id, NEW.tag_number WHERE EXISTS (SELECT 1 FROM pi_tag_watch WHERE session_id = NEW.session_id) AND NOT EXISTS (SELECT 1 FROM pi_tag_changes WHERE session_id = NEW.session_id AND tag_number = NEW.tag_number);
		END;
		CREATE TEMP TRIGGER IF NOT EXISTS pi_tag_update AFTER UPDATE ON main.tags BEGIN
			UPDATE pi_tag_revision SET revision = revision + 1;
			INSERT INTO pi_tag_session_revision VALUES (OLD.session_id, 1) ON CONFLICT(session_id) DO UPDATE SET revision = revision + 1;
			INSERT INTO pi_tag_session_revision SELECT NEW.session_id, 1 WHERE NEW.session_id IS NOT OLD.session_id ON CONFLICT(session_id) DO UPDATE SET revision = revision + 1;
			INSERT INTO pi_tag_changes SELECT OLD.session_id, OLD.tag_number WHERE EXISTS (SELECT 1 FROM pi_tag_watch WHERE session_id = OLD.session_id) AND NOT EXISTS (SELECT 1 FROM pi_tag_changes WHERE session_id = OLD.session_id AND tag_number = OLD.tag_number);
			INSERT INTO pi_tag_changes SELECT NEW.session_id, NEW.tag_number WHERE EXISTS (SELECT 1 FROM pi_tag_watch WHERE session_id = NEW.session_id) AND NOT EXISTS (SELECT 1 FROM pi_tag_changes WHERE session_id = NEW.session_id AND tag_number = NEW.tag_number);
		END;
		CREATE TEMP TRIGGER IF NOT EXISTS pi_tag_delete AFTER DELETE ON main.tags BEGIN
			UPDATE pi_tag_revision SET revision = revision + 1;
			INSERT INTO pi_tag_session_revision VALUES (OLD.session_id, 1) ON CONFLICT(session_id) DO UPDATE SET revision = revision + 1;
			INSERT INTO pi_tag_changes SELECT OLD.session_id, OLD.tag_number WHERE EXISTS (SELECT 1 FROM pi_tag_watch WHERE session_id = OLD.session_id) AND NOT EXISTS (SELECT 1 FROM pi_tag_changes WHERE session_id = OLD.session_id AND tag_number = OLD.tag_number);
		END;
		CREATE TEMP TRIGGER pi_tag_version_ai AFTER INSERT ON main.tags BEGIN
			INSERT INTO pi_tag_version_own VALUES (NEW.session_id, 1) ON CONFLICT(session_id) DO UPDATE SET count = count + 1;
		END;
		CREATE TEMP TRIGGER pi_tag_version_ad AFTER DELETE ON main.tags BEGIN
			INSERT INTO pi_tag_version_own VALUES (OLD.session_id, 1) ON CONFLICT(session_id) DO UPDATE SET count = count + 1;
		END;
		CREATE TEMP TRIGGER pi_tag_version_au
		AFTER UPDATE OF session_id, message_id, tag_number, type, tool_owner_message_id, status ON main.tags BEGIN
			INSERT INTO pi_tag_version_own VALUES (OLD.session_id, 1) ON CONFLICT(session_id) DO UPDATE SET count = count + 1;
			INSERT INTO pi_tag_version_own SELECT NEW.session_id, 1 WHERE NEW.session_id != OLD.session_id
				ON CONFLICT(session_id) DO UPDATE SET count = count + 1;
		END;
	`);
	// Writers from builds older than the tag_revision: triggers (and connections
	// that never ran initializeDatabase) do not advance the shared revision, so
	// the snapshot cannot see their commits. Every writer does advance the
	// durable session_meta.tags_version through schema triggers. The TEMP
	// pi_tag_version_* triggers above count this connection's firings of those
	// same events, so a durable advance this connection did not make is a write
	// the revision missed. Other bumps of tags_version (session clears, the
	// REPLACE conflict trigger) only cause a conservative extra rescan.
	const versionStamp = db.prepare(`SELECT
		COALESCE((SELECT tags_version FROM session_meta WHERE session_id = ?), 0) AS durable,
		COALESCE((SELECT count FROM pi_tag_version_own WHERE session_id = ?), 0) AS own`);
	const revision = db.prepare(`WITH stamp AS (SELECT
		COALESCE((SELECT revision FROM pi_tag_session_revision WHERE session_id = ?), 0) AS own,
		COALESCE((SELECT value FROM schema_migrations_meta WHERE key = ?), '0') AS total)
		SELECT CAST(own AS TEXT) AS local,
		(${tagRevisionIncarnationSql("total")}) || ':' || CAST(${tagRevisionCountSql("total")} - own AS TEXT) AS foreign_revision FROM stamp`);
	revisionReaders.set(db, (sessionId) => {
		const transaction = db as unknown as {
			inTransaction?: boolean;
			isTransaction?: boolean;
		};
		if (transaction.inTransaction || transaction.isTransaction) return null;
		const row = revision.get(sessionId, tagRevisionKey(sessionId)) as {
			local: string;
			foreign_revision: string;
		};
		return [row.local, row.foreign_revision] as const;
	});
	const changed = db.prepare(
		"SELECT tag_number FROM pi_tag_changes WHERE session_id = ? ORDER BY tag_number",
	);
	const clearChanged = db.prepare(
		"DELETE FROM pi_tag_changes WHERE session_id = ?",
	);
	const watch = db.prepare("INSERT OR IGNORE INTO pi_tag_watch VALUES (?)");
	const unwatch = db.prepare("DELETE FROM pi_tag_watch WHERE session_id = ?");
	const cache = new Map<string, SnapshotEntry>();
	// A snapshot with no revision row may receive its first local write without
	// becoming foreign, including updates to tags from before revisions existed.
	// pi_tag_first_allocation must record this
	// connection allocating exactly one matching incarnation, every inserted
	// number must remain in pi_tag_changes, and durable version advances must
	// equal this connection's own writes. Foreign/recreated counters do not qualify.
	const ownFirstAllocation =
		db.prepare(`SELECT 1 FROM pi_tag_first_allocation allocation
		WHERE session_id = ? AND seen = 1 AND incarnation || ':0' = ?
		AND EXISTS (SELECT 1 FROM pi_tag_watch WHERE session_id = allocation.session_id)
		AND EXISTS (SELECT 1 FROM pi_tag_changes WHERE session_id = allocation.session_id)
		AND (? = 'legacy' OR EXISTS (SELECT 1 FROM pi_tag_first_rows WHERE session_id = allocation.session_id))
		AND NOT EXISTS (SELECT 1 FROM pi_tag_first_rows first_row WHERE first_row.session_id = allocation.session_id
		AND NOT EXISTS (SELECT 1 FROM pi_tag_changes change WHERE change.session_id = first_row.session_id AND change.tag_number IS first_row.tag_number))`);
	const managed = new Set<string>();
	const epoch = ++connectionEpoch;
	const sessionEpochs = new Map<string, number>();
	let closed = false;
	let jobId = 0;
	let current: OwnerJob | undefined;
	let failedUntil = 0;
	let lastFailure: unknown;
	let failedSession: string | undefined;
	const totalRevision = db.prepare(
		"SELECT COALESCE(value, '0') AS revision, value IS NOT NULL AS present FROM (SELECT 1) LEFT JOIN schema_migrations_meta ON key = ?",
	);
	const assertOutsideTransaction = () => {
		const connection = db as unknown as {
			inTransaction?: boolean;
			isTransaction?: boolean;
		};
		if (connection.inTransaction || connection.isTransaction)
			throw new PiTagHydrationError("readiness requested inside a transaction");
	};
	const stamps = (sessionId: string, id: number) => {
		assertOutsideTransaction();
		const revision = revisionReaders.get(db)?.(sessionId);
		if (!revision) throw new PiTagHydrationError("owner revision unavailable");
		const stamp = versionStamp.get(sessionId, sessionId) as {
			durable: number;
			own: number;
		};
		const total = totalRevision.get(tagRevisionKey(sessionId)) as {
			revision: string;
			present: number;
		};
		return {
			connectionEpoch: epoch,
			sessionEpoch: sessionEpochs.get(sessionId) ?? 0,
			jobId: id,
			sessionId,
			localRevision: revision[0],
			foreignRevision: revision[1],
			durableVersion: stamp.durable,
			ownVersion: stamp.own,
			totalRevision: total.revision,
			revisionPresent: total.present,
		};
	};
	const ready = (sessionId: string, projection?: "pass") => {
		assertOutsideTransaction();
		const cached = cache.get(sessionId);
		if (!cached?.fallback) return false;
		if (cached.projection !== projection) return false;
		const revision = revisionReaders.get(db)?.(sessionId);
		if (!revision || cached.foreignRevision !== revision[1]) return false;
		const stamp = versionStamp.get(sessionId, sessionId) as {
			durable: number;
			own: number;
		};
		return (
			stamp.durable - cached.durableVersion === stamp.own - cached.ownVersion
		);
	};
	const cancel = (sessionId: string) => {
		sessionEpochs.set(sessionId, (sessionEpochs.get(sessionId) ?? 0) + 1);
		if (current?.sessionId === sessionId) current.cancel();
	};
	// A shared prewarm outlives individual context waiters. Its TEMP bookkeeping
	// must not inherit a cancelled waiter's transform-write or ownership guard.
	const load = (
		sessionId: string,
		kind: PiTagSnapshotLoadKind,
		projection?: "pass",
	): Promise<void> =>
		inSnapshotRoot(async () => {
			if (closed) throw new PiTagHydrationError("connection closed");
			managed.add(sessionId);
			if (ready(sessionId, projection)) return;
			if (current) {
				// A turn joining its prewarm owns that read from now on. Only an
				// unclaimed background read may yield to another session's turn.
				if (
					current.sessionId === sessionId &&
					!current.retryable &&
					!current.preempted
				) {
					if (kind === "turn") current.kind = "turn";
					if (current.projection === projection) return current.result;
				}
				if (
					kind === "turn" &&
					current.kind === "prewarm" &&
					current.sessionId !== sessionId &&
					!current.preempted
				) {
					current.preempted = true;
					current.cancel();
				}
				const epoch = sessionEpochs.get(sessionId) ?? 0;
				await Promise.allSettled([current.result, current.released]);
				if (epoch !== (sessionEpochs.get(sessionId) ?? 0))
					throw new PiTagHydrationError(
						"session hydration cancelled while queued",
						"cancelled",
					);
				return load(sessionId, kind, projection);
			}
			if (failedSession === sessionId && performance.now() < failedUntil)
				throw lastFailure;
			watch.run(sessionId);
			const token = stamps(sessionId, ++jobId);
			const cached = cache.get(sessionId);
			if (cached && cached.projection !== projection) {
				// A purpose switch needs a newly admitted candidate. Release the old
				// cache before allocating it, and never advertise the new mode early.
				cache.delete(sessionId);
			}
			const previous = cache.get(sessionId);
			const legacyFallbackOnly =
				previous &&
				previous.foreignRevision === token.foreignRevision &&
				(previous.legacyFallback ||
					token.durableVersion - previous.durableVersion !==
						token.ownVersion - previous.ownVersion);
			const path = getSqliteDatabasePath(db);
			const factory =
				workerFactories.get(db) ??
				((request, cached, cachedFallback) => {
					if (!path)
						throw new PiTagHydrationError(
							"read-only hydration requires a file-backed database",
						);
					return startPiTagSnapshotWorker(
						{ ...request, path },
						{ cached, cachedFallback },
					);
				});
			const worker = factory(
				{
					path: path ?? "",
					sessionId,
					connectionEpoch: epoch,
					sessionEpoch: token.sessionEpoch,
					jobId: token.jobId,
					projection,
				},
				previous?.tags ?? [],
				previous?.fallback ?? [],
			);
			const destination: OwnerJob = {
				sessionId,
				kind,
				projection,
				result: Promise.resolve(),
				released: worker.released,
				cancel: worker.cancel,
			};
			current = destination;
			let jobs = activeJobs.get(sessionId);
			if (!jobs) {
				jobs = new Set();
				activeJobs.set(sessionId, jobs);
			}
			const lifetime = {
				cancel,
				released: worker.released,
				get result() {
					return destination.result;
				},
			};
			jobs.add(lifetime);
			destination.result = worker.result
				.then(({ candidate, generation }) => {
					if (destination.preempted)
						throw new PiTagHydrationError(
							"prewarm yielded to a turn",
							"cancelled",
						);
					// No await is allowed from this owner validation through publication.
					const live = stamps(sessionId, token.jobId);
					if (
						closed ||
						current !== destination ||
						!samePiTagSnapshotToken(token, live) ||
						token.totalRevision !== live.totalRevision ||
						generation.revision !== token.totalRevision ||
						generation.durable !== token.durableVersion
					)
						throw new PiTagHydrationError(
							"owner generation or lifetime changed",
							"stale",
						);
					const snapshot: SnapshotEntry = {
						projection,
						firstAllocationPending: live.revisionPresent
							? undefined
							: candidate.tags.length === 0 &&
									!db
										.prepare("SELECT 1 FROM tags WHERE session_id = ? LIMIT 1")
										.get(sessionId)
								? "empty"
								: "legacy",
						revision: legacyFallbackOnly
							? previous.revision
							: live.localRevision,
						foreignRevision: live.foreignRevision,
						tags: legacyFallbackOnly ? previous.tags : candidate.tags,
						active: legacyFallbackOnly ? previous.active : candidate.active,
						fallback: candidate.fallback,
						durableVersion: live.durableVersion,
						ownVersion: live.ownVersion,
					};
					if (cache.size >= 100 && !cache.has(sessionId)) {
						const oldest = cache.keys().next().value;
						if (oldest !== undefined) {
							cache.delete(oldest);
							unwatch.run(oldest);
							clearChanged.run(oldest);
						}
					}
					if (!legacyFallbackOnly) clearChanged.run(sessionId);
					if (snapshot.firstAllocationPending) {
						db.prepare(
							"DELETE FROM pi_tag_first_allocation WHERE session_id = ?",
						).run(sessionId);
						db.prepare(
							"DELETE FROM pi_tag_first_rows WHERE session_id = ?",
						).run(sessionId);
						db.prepare(
							"INSERT OR IGNORE INTO pi_tag_first_watch VALUES (?)",
						).run(sessionId);
					}
					cache.set(sessionId, snapshot);
				})
				.catch((error) => {
					const releaseCachedAllocations =
						previous &&
						!legacyFallbackOnly &&
						cache.get(sessionId) === previous &&
						error instanceof PiTagHydrationError &&
						error.message.includes("candidate memory limit exceeded");
					if (releaseCachedAllocations) cache.delete(sessionId);
					// A changed candidate may fit alone but not beside the invalidated
					// cache. Retry cold within the same waiter's original deadline.
					const failure = releaseCachedAllocations
						? new PiTagHydrationError(
								"candidate memory limit exceeded with cached allocations; retrying without cache",
								"stale",
							)
						: error;
					const retryable =
						failure instanceof PiTagHydrationError &&
						(failure.code === "stale" || failure.code === "cancelled");
					if (retryable) destination.retryable = true;
					// Cancelling an old session is not a connection failure. Do not
					// replay its cancellation as the next session's startup error.
					if (
						!destination.preempted &&
						current === destination &&
						token.sessionEpoch === (sessionEpochs.get(sessionId) ?? 0)
					) {
						// Back off only the failed session; another session needs its own read.
						failedSession = sessionId;
						lastFailure = failure;
						failedUntil = performance.now() + (retryable ? 0 : 500);
					}
					throw failure;
				});
			// Observe cancellation immediately without making a failed pass wait
			// for a native worker to exit. Release still gates the next worker and
			// removal of this job's lifetime callback, even after result rejects.
			void Promise.allSettled([destination.result, worker.released]).then(
				() => {
					if (current === destination) current = undefined;
					jobs.delete(lifetime);
					if (!jobs.size) activeJobs.delete(sessionId);
				},
			);
			return destination.result;
		});
	owners.set(db, {
		ready,
		load,
		addNativeWaiter: (remaining) => {
			nativeWaiters.add(remaining);
			return () => {
				nativeWaiters.delete(remaining);
			};
		},
		manage: (sessionId) => managed.add(sessionId),
		cancel,
	});
	const fallbackRows = db.prepare(
		`SELECT ${PI_FALLBACK_ROW_COLUMNS} FROM tags WHERE session_id = ? AND ${PI_FALLBACK_ROW_PREDICATE}`,
	);
	const fallbackRowsByNumbers = db.prepare(
		`SELECT ${PI_FALLBACK_ROW_COLUMNS} FROM tags WHERE session_id = ?
		 AND tag_number IN (SELECT value FROM json_each(?)) AND ${PI_FALLBACK_ROW_PREDICATE}`,
	);
	/** Bring the cached entry up to date, or return null inside a transaction. */
	const sync = (sessionId: string): SnapshotEntry | null => {
		// Do not publish or consume journal entries inside a transaction: its
		// rows may roll back while the in-memory snapshot cannot roll back.
		const transaction = db as unknown as {
			inTransaction?: boolean;
			isTransaction?: boolean;
		};
		if (transaction.inTransaction || transaction.isTransaction) return null;
		// Subtract this connection's writes from the shared session counter. Both
		// counters roll back with the rows; unrelated foreign commits do not matter.
		const [local, external] = revisionReaders.get(db)?.(sessionId) ?? [
			"0",
			"0:0",
		];
		const stamp = versionStamp.get(sessionId, sessionId) as {
			durable: number;
			own: number;
		};
		let snapshot = cache.get(sessionId);
		if (
			snapshot?.firstAllocationPending &&
			snapshot.foreignRevision !== external &&
			snapshot.revision !== local &&
			stamp.durable - snapshot.durableVersion ===
				stamp.own - snapshot.ownVersion &&
			ownFirstAllocation.get(
				sessionId,
				external,
				snapshot.firstAllocationPending,
			)
		) {
			snapshot.foreignRevision = external;
			snapshot.firstAllocationPending = undefined;
			db.prepare("DELETE FROM pi_tag_first_watch WHERE session_id = ?").run(
				sessionId,
			);
			db.prepare("DELETE FROM pi_tag_first_rows WHERE session_id = ?").run(
				sessionId,
			);
		}
		if (!snapshot || snapshot.foreignRevision !== external) {
			if (managed.has(sessionId))
				throw new PiTagHydrationError(
					"tag snapshot is not ready; turn not sent, retry",
				);
			// Another connection changed this session's tags. There is no record
			// of which rows, so reread them all, but reuse the cached object for
			// every unchanged row. Consumers that diff rows by object identity
			// (tagAttribution in tail-hygiene-walk-pi.ts) then see only the rows
			// that actually changed.
			const tags = snapshot
				? reuseUnchangedRows(snapshot.tags, getTagsBySession(db, sessionId))
				: getTagsBySession(db, sessionId);
			snapshot = {
				revision: local,
				foreignRevision: external,
				tags,
				active: tags.filter(isActive),
				durableVersion: stamp.durable,
				ownVersion: stamp.own,
			};
			if (cache.size >= 100 && !cache.has(sessionId)) {
				const oldest = cache.keys().next().value;
				if (oldest !== undefined) {
					cache.delete(oldest);
					unwatch.run(oldest);
					clearChanged.run(oldest);
				}
			}
			cache.set(sessionId, snapshot);
			for (const tag of snapshot.tags) Object.freeze(tag);
			watch.run(sessionId);
		} else if (snapshot.revision !== local) {
			const numbers = (changed.all(sessionId) as { tag_number: number }[]).map(
				(row) => row.tag_number,
			);
			if (numbers.length > 0) {
				const dirty = new Set(numbers);
				const replacements = getTagsByNumbers(db, sessionId, numbers);
				for (const tag of replacements) Object.freeze(tag);
				snapshot.tags = mergeChangedRows(
					snapshot.tags,
					dirty,
					snapshot.projection === "pass"
						? replacements.map(projectPiPassTag)
						: replacements,
				);
				// The active projection follows the same rows: only changed numbers
				// can enter or leave it, so it is merged rather than refiltered.
				snapshot.active = mergeChangedRows(
					snapshot.active,
					dirty,
					replacements.filter(isActive),
				);
				if (!numbers.every(Number.isSafeInteger)) {
					// A NULL tag number cannot be re-read by number; rescan on next use.
					snapshot.fallback = undefined;
				} else if (snapshot.fallback) {
					// A changed number may have gained, lost or rewritten a fallback
					// row. Re-read only those numbers with the same predicate.
					snapshot.fallback = [
						...snapshot.fallback.filter((row) => !dirty.has(row.tag_number)),
						...(fallbackRowsByNumbers.all(
							sessionId,
							JSON.stringify(numbers),
						) as PiFallbackTagRow[]),
					];
				}
			}
			snapshot.revision = local;
		}
		if (
			stamp.durable - snapshot.durableVersion !==
			stamp.own - snapshot.ownVersion
		) {
			// session_meta.tags_version is advanced by schema triggers on every
			// tag write from any connection, while ownVersion counts only this
			// connection's writes. A difference beyond our own writes means
			// another connection changed tags without advancing the shared
			// `tag_revision:` key, typically an older Magic Context build, so
			// this connection's change journal never saw the write. Fallback rows
			// are tags still keyed by a temporary `pi-msg-*` id, before Pi has
			// assigned the message its real entry id. They decide whether this
			// pass looks for tags to move onto real ids, so rescan them on next
			// use. The cached tag rows are left as they are for such writers,
			// which is unchanged behaviour.
			snapshot.fallback = undefined;
			snapshot.legacyFallback = true;
		}
		snapshot.durableVersion = stamp.durable;
		snapshot.ownVersion = stamp.own;
		clearChanged.run(sessionId);
		return snapshot;
	};
	const read = (
		sessionId: string,
		borrowed = false,
	): ReturnType<typeof getTagsBySession> => {
		const snapshot = sync(sessionId);
		if (!snapshot && managed.has(sessionId))
			throw new PiTagHydrationError(
				"managed snapshot read inside a transaction",
			);
		if (!snapshot) return getTagsBySession(db, sessionId);
		// The full API remains full when a pass keeps only metadata for history.
		// Runtime attribution uses the narrow projection, not this escape hatch.
		if (snapshot.projection === "pass") {
			const before = stamps(sessionId, 0);
			const tags = getTagsBySession(db, sessionId);
			const after = stamps(sessionId, 0);
			if (
				!samePiTagSnapshotToken(before, after) ||
				before.totalRevision !== after.totalRevision
			)
				throw new PiTagHydrationError(
					"full snapshot generation changed",
					"stale",
				);
			return borrowed ? tags.map((tag) => Object.freeze(tag)) : tags;
		}
		// Heuristics can edit their working entries; never expose the cached objects.
		const full = snapshot.tags as SnapshotTag[];
		return borrowed ? full : full.map((tag) => ({ ...tag }));
	};
	entryReaders.set(db, sync);
	fallbackReaders.set(db, (sessionId) => {
		const snapshot = sync(sessionId);
		if (!snapshot) return null;
		if (!snapshot.fallback && managed.has(sessionId))
			throw new PiTagHydrationError(
				"fallback snapshot is not ready; turn not sent, retry",
			);
		snapshot.fallback ??= fallbackRows.all(sessionId) as PiFallbackTagRow[];
		return snapshot.fallback;
	});
	readers.set(db, read);
	const close = db.close.bind(db);
	Object.defineProperty(db, "close", {
		configurable: true,
		writable: true,
		value: (...args: Parameters<Database["close"]>) => {
			// Weak-key readers are collected only when the engine examines their
			// connection keys. Release large snapshots immediately on explicit close
			// rather than retaining closed sessions until a major collection.
			closed = true;
			nativeWaiters.clear();
			current?.cancel();
			cache.clear();
			entryReaders.delete(db);
			fallbackReaders.delete(db);
			readers.delete(db);
			revisionReaders.delete(db);
			owners.delete(db);
			workerFactories.delete(db);
			return close(...args);
		},
	});
	return read;
}

export type PiSnapshotTag = ReturnType<typeof getTagsBySession>[number];
type SnapshotTag = PiSnapshotTag;

/** Historical fields used by attribution, protection, saved-drop replay and served numbers. */
export type PiTagMetadata = Pick<
	SnapshotTag,
	| "id"
	| "tagNumber"
	| "messageId"
	| "type"
	| "status"
	| "toolOwnerMessageId"
	| "tokenCount"
	| "toolName"
	| "dropMode"
>;
export type PiPassTag = PiTagMetadata & Partial<SnapshotTag>;

/** Keep full active heuristic rows and only historical attribution, protection and replay fields. */
export function projectPiPassTag(tag: SnapshotTag): PiPassTag {
	if (tag.status === "active") return tag;
	return Object.freeze({
		id: tag.id,
		tagNumber: tag.tagNumber,
		messageId: tag.messageId,
		type: tag.type,
		status: tag.status,
		toolOwnerMessageId: tag.toolOwnerMessageId,
		tokenCount: tag.tokenCount,
		toolName: tag.toolName,
		dropMode: tag.dropMode,
	});
}

/**
 * A tag row that names an unsettled Pi id: a message tag stored under a
 * `pi-msg-*` fallback message id, or a tool tag whose owner is one. Columns are
 * raw SQL values, so callers apply exactly the filters their SQL used to.
 */
export interface PiFallbackTagRow {
	id: number;
	tag_number: number;
	type: unknown;
	message_id: unknown;
	tool_owner_message_id: unknown;
	entry_fingerprint: unknown;
}

// Selects every fallback row: a message tag under a `pi-msg-*` id, or a tool
// tag whose owner message has one. Every check that asks whether such rows
// exist reads these cached rows instead of querying the table. Matching stays
// in SQL's own LIKE (ASCII case-insensitive), so the cached set is exactly the
// set a direct table query would return.
export const PI_FALLBACK_ROW_COLUMNS =
	"id, tag_number, type, message_id, tool_owner_message_id, entry_fingerprint";
export const PI_FALLBACK_ROW_PREDICATE = `((type = 'message' AND message_id LIKE 'pi-msg-%')
	OR (type = 'tool' AND tool_owner_message_id LIKE 'pi-msg-%'))`;

interface SnapshotEntry {
	projection?: "pass";
	firstAllocationPending?: "empty" | "legacy";
	legacyFallback?: boolean;
	revision: string;
	foreignRevision: string;
	tags: PiPassTag[];
	/** `tags` rows whose status is "active", in the same order. */
	active: SnapshotTag[];
	/**
	 * At the last sync: session_meta.tags_version (durableVersion) and how many
	 * of its advances this connection's own tag writes caused (ownVersion).
	 */
	durableVersion: number;
	ownVersion: number;
	/**
	 * Fallback rows, loaded on first use after each full reload (a reread of
	 * every row of the session) and then kept current from the same journal as
	 * `tags`: the TEMP table pi_tag_changes, filled by this connection's tag
	 * triggers with the numbers changed since the last read.
	 */
	fallback?: PiFallbackTagRow[];
}

const isActive = (tag: PiPassTag): tag is SnapshotTag =>
	tag.status === "active";

function sameRow(
	left: PiPassTag,
	right: PiPassTag,
	keys: readonly (keyof PiPassTag)[],
): boolean {
	if (Object.keys(left).length !== keys.length) return false;
	for (const key of keys) if (!Object.is(left[key], right[key])) return false;
	return true;
}

export interface PiTagSnapshotCandidate {
	tags: PiPassTag[];
	active: SnapshotTag[];
	fallback: PiFallbackTagRow[];
	estimatedBytes: number;
	allocatedBytes: number;
	reusedBytes: number;
}

/**
 * Evidence required to publish a job into its original connection/session.
 * Only this session's revisions participate: unrelated database commits must
 * not invalidate a long-running hydration.
 */
export interface PiTagSnapshotToken {
	connectionEpoch: number;
	sessionEpoch: number;
	jobId: number;
	sessionId: string;
	localRevision: string;
	foreignRevision: string;
	durableVersion: number;
	ownVersion: number;
}

export function samePiTagSnapshotToken(
	left: PiTagSnapshotToken,
	right: PiTagSnapshotToken,
): boolean {
	return (
		left.connectionEpoch === right.connectionEpoch &&
		left.sessionEpoch === right.sessionEpoch &&
		left.jobId === right.jobId &&
		left.sessionId === right.sessionId &&
		left.localRevision === right.localRevision &&
		left.foreignRevision === right.foreignRevision &&
		left.durableVersion === right.durableVersion &&
		left.ownVersion === right.ownVersion
	);
}

// Includes row slots, array references and string headers as well as UTF-16
// payloads. This is candidate admission, not a bound on process RSS or GC cost.
function candidateRowBytes(row: object, overhead: number): number {
	let bytes = overhead;
	for (const value of Object.values(row)) {
		if (typeof value === "string") bytes += 24 + value.length * 2;
		else if (value instanceof Uint8Array) bytes += 24 + value.byteLength;
	}
	return bytes;
}

function passTagBytes(row: PiPassTag): number {
	// Charge a 48-byte header plus 24 bytes per field slot: 384 bytes of base
	// overhead for a full 14-field row. String/binary payloads are added separately.
	// Narrow projections use the same per-slot cost.
	return candidateRowBytes(row, 48 + 24 * Object.keys(row).length);
}

/**
 * Private streaming assembly: only finish exposes the arrays, after both
 * streams end. Work and identity reuse happen per row, never at publication.
 * The caller supplies scheduling between rows; this helper never reads SQLite.
 */
export function createPiTagSnapshotCandidate(
	cached: readonly PiPassTag[] = [],
	byteLimit = 128 * 1024 * 1024,
	cachedFallback: readonly PiFallbackTagRow[] = [],
) {
	const tags: PiPassTag[] = [];
	const active: SnapshotTag[] = [];
	const fallback: PiFallbackTagRow[] = [];
	// The old snapshot stays alive during assembly. Count its rows once, then
	// charge candidate references and genuinely new rows separately.
	let reusedBytes = 0;
	for (const row of cached)
		reusedBytes += passTagBytes(row) + 8 + (isActive(row) ? 8 : 0);
	if (cached.length) reusedBytes += 128;
	for (const row of cachedFallback)
		reusedBytes += candidateRowBytes(row, 192) + 8;
	if (cachedFallback.length) reusedBytes += 64;
	let allocatedBytes =
		192 + (cachedFallback.length ? 64 + cachedFallback.length * 48 : 0);
	let estimatedBytes = reusedBytes + allocatedBytes;
	const fallbackCache =
		cachedFallback.length && estimatedBytes <= byteLimit
			? new Map(cachedFallback.map((row) => [row.id, row]))
			: undefined;
	let oldIndex = 0;
	let keys: (keyof PiPassTag)[] | undefined;
	let tagsEnded = false;
	let fallbackEnded = false;
	let failed = false;
	const reject = (reason: string): never => {
		failed = true;
		throw new Error(`Pi tag hydration: ${reason}`);
	};
	const admit = (bytes: number) => {
		allocatedBytes += bytes;
		estimatedBytes = reusedBytes + allocatedBytes;
		if (estimatedBytes > byteLimit) reject("candidate memory limit exceeded");
	};
	return {
		get estimatedBytes() {
			return estimatedBytes;
		},
		appendTag(row: PiPassTag) {
			if (failed || tagsEnded) reject("tag packet after end or failure");
			const previous = tags.at(-1);
			if (
				previous &&
				(previous.tagNumber > row.tagNumber ||
					(previous.tagNumber === row.tagNumber &&
						(previous.id ?? 0) >= (row.id ?? 0)))
			)
				reject("noncanonical tag order");
			keys = Object.keys(row) as (keyof PiPassTag)[];
			while (oldIndex < cached.length) {
				const old = cached[oldIndex];
				if (
					!old ||
					old.tagNumber > row.tagNumber ||
					(old.tagNumber === row.tagNumber && (old.id ?? 0) >= (row.id ?? 0))
				)
					break;
				oldIndex += 1;
			}
			const old = cached[oldIndex];
			const selected =
				old && old.id === row.id && sameRow(old, row, keys) ? old : row;
			admit(
				(selected === old ? 0 : passTagBytes(row)) +
					8 +
					(isActive(selected) ? 8 : 0),
			);
			Object.freeze(selected);
			tags.push(selected);
			if (isActive(selected)) active.push(selected);
		},
		appendFallback(row: PiFallbackTagRow) {
			if (failed || fallbackEnded)
				reject("fallback packet after end or failure");
			const old = fallbackCache?.get(row.id);
			const rowKeys = Object.keys(row) as (keyof PiFallbackTagRow)[];
			const selected =
				old &&
				Object.keys(old).length === rowKeys.length &&
				rowKeys.every((key) => Object.is(old[key], row[key]))
					? old
					: row;
			admit((selected === old ? 0 : candidateRowBytes(row, 192)) + 8);
			fallback.push(Object.freeze(selected));
		},
		end(stream: "tags" | "fallback") {
			if (failed) reject("end after failure");
			if (stream === "tags") {
				if (tagsEnded) reject("duplicate tag end");
				tagsEnded = true;
			} else {
				if (fallbackEnded) reject("duplicate fallback end");
				fallbackEnded = true;
			}
		},
		finish(): PiTagSnapshotCandidate {
			if (failed || !tagsEnded || !fallbackEnded)
				throw new Error("Pi tag hydration: incomplete candidate");
			if (estimatedBytes > byteLimit) reject("candidate memory limit exceeded");
			return {
				tags,
				active,
				fallback,
				estimatedBytes,
				allocatedBytes,
				reusedBytes,
			};
		},
	};
}

export type PiTagSnapshotCandidateLoader = (
	assembly: ReturnType<typeof createPiTagSnapshotCandidate>,
) => Promise<void>;

/** Internal injection seam for transport and deterministic candidate tests. */
export async function loadPiTagSnapshotCandidate(
	loader: PiTagSnapshotCandidateLoader,
	cached: readonly PiPassTag[] = [],
	byteLimit?: number,
	cachedFallback: readonly PiFallbackTagRow[] = [],
): Promise<PiTagSnapshotCandidate> {
	const assembly = createPiTagSnapshotCandidate(
		cached,
		byteLimit,
		cachedFallback,
	);
	await loader(assembly);
	return assembly.finish();
}

/**
 * Return `fresh` with each row that equals its cached counterpart (same id,
 * same fields) replaced by the cached frozen object. Both lists are in
 * canonical tag_number/id order, so one merge walk pairs them.
 */
function reuseUnchangedRows(
	cached: readonly PiPassTag[],
	fresh: SnapshotTag[],
): SnapshotTag[] {
	// Every row of both lists was built by the same toTagEntry, so they share
	// one key set; read it once instead of per row.
	const first = fresh[0];
	if (!first) return fresh;
	const keys = Object.keys(first) as (keyof SnapshotTag)[];
	let index = 0;
	for (let position = 0; position < fresh.length; position += 1) {
		const row = fresh[position];
		if (!row) continue;
		while (index < cached.length) {
			const old = cached[index];
			if (
				!old ||
				old.tagNumber > row.tagNumber ||
				(old.tagNumber === row.tagNumber && (old.id ?? 0) >= (row.id ?? 0))
			)
				break;
			index += 1;
		}
		const old = cached[index];
		if (old && old.id === row.id && sameRow(old, row, keys))
			fresh[position] = old as SnapshotTag;
	}
	return fresh;
}

/**
 * Replace the rows of `dirty` tag numbers in canonical tag_number/id order.
 * Both inputs use that order, including duplicate tag numbers in legacy stores.
 */
function mergeChangedRows<T extends PiPassTag>(
	rows: readonly T[],
	dirty: ReadonlySet<number>,
	replacements: readonly T[],
): T[] {
	const highest = rows.at(-1)?.tagNumber ?? -1;
	let appendOnly = true;
	for (const number of dirty) {
		if (number <= highest) {
			appendOnly = false;
			break;
		}
	}
	// Ordinary appends already have canonical order. Do not filter or merge the
	// historical prefix just to add a few new rows.
	if (appendOnly) return [...rows, ...replacements];
	const unchanged = rows.filter((tag) => !dirty.has(tag.tagNumber));
	const merged: T[] = [];
	let index = 0;
	for (const tag of unchanged) {
		while (index < replacements.length) {
			const next = replacements[index];
			if (!next) break;
			if (
				next.tagNumber > tag.tagNumber ||
				(next.tagNumber === tag.tagNumber && (next.id ?? 0) > (tag.id ?? 0))
			)
				break;
			merged.push(next);
			index += 1;
		}
		merged.push(tag);
	}
	for (; index < replacements.length; index++) {
		const row = replacements[index];
		if (row) merged.push(row);
	}
	return merged;
}

const entryReaders = new WeakMap<
	Database,
	(sessionId: string) => SnapshotEntry | null
>();

const fallbackReaders = new WeakMap<
	Database,
	(sessionId: string) => readonly PiFallbackTagRow[] | null
>();

const readers = new WeakMap<
	Database,
	(sessionId: string, borrowed?: boolean) => ReturnType<typeof getTagsBySession>
>();

const revisionReaders = new WeakMap<
	Database,
	(sessionId: string) => readonly [string, string] | null
>();

/** Revision for tag-only observations; transactions must use uncached reads. */
export function readPiTagSnapshotRevision(
	db: Database,
	sessionId: string,
): readonly [string, string] | null {
	if (!readers.has(db)) createPiTagSnapshotReader(db);
	return revisionReaders.get(db)?.(sessionId) ?? null;
}

export function getPiTagSnapshot(db: Database, sessionId: string) {
	let reader = readers.get(db);
	if (!reader) {
		reader = createPiTagSnapshotReader(db);
		readers.set(db, reader);
	}
	return reader(sessionId);
}

/** Full read-only diagnostic view; pass-mode caches reconstruct it with a fenced table read. */
export function getPiTagSnapshotView(db: Database, sessionId: string) {
	return createPiTagSnapshotReader(db)(sessionId, true);
}

/** One immutable pass projection: full active rows plus narrow all-status history. */
export function getPiPassTagSnapshotView(
	db: Database,
	sessionId: string,
): readonly PiPassTag[] {
	createPiTagSnapshotReader(db);
	const snapshot = entryReaders.get(db)?.(sessionId);
	if (snapshot?.projection === "pass") return snapshot.tags;
	const full =
		(snapshot?.tags as SnapshotTag[] | undefined) ??
		getTagsBySession(db, sessionId);
	return full.map(projectPiPassTag);
}

/**
 * Internal read-only projection of the rows whose status is "active", in tag
 * order: the same rows as filtering `getPiTagSnapshotView`, maintained from
 * changed rows instead of refiltering every tag of the session. Rows are the
 * frozen cached objects. Pass `passTags`, the full list this caller already
 * read, to keep both lists one tag state: if the snapshot has moved since that
 * read (another connection committed in between), or inside a transaction,
 * the result is a filter of `passTags` itself.
 */
export function getPiActiveTagSnapshotView(
	db: Database,
	sessionId: string,
	passTags?: readonly PiPassTag[],
): SnapshotTag[] {
	createPiTagSnapshotReader(db);
	const snapshot = entryReaders.get(db)?.(sessionId);
	// Copy the array (not the frozen rows) so a caller that sorts or splices
	// its list cannot reorder the cached projection. Every change to the rows
	// publishes a new `tags` array, so the same array means the same state.
	if (snapshot && (!passTags || snapshot.tags === passTags))
		return snapshot.active.slice();
	return (passTags ?? getTagsBySession(db, sessionId)).filter(isActive);
}

/**
 * Current fallback rows of a session (see PiFallbackTagRow), or null inside a
 * transaction, where callers must query the table themselves. Rows are kept
 * up to date from the changed-number journal, so a pass that only appends
 * tags never rescans the session for `pi-msg-*` ids.
 */
export function readPiFallbackTagRows(
	db: Database,
	sessionId: string,
): readonly PiFallbackTagRow[] | null {
	createPiTagSnapshotReader(db);
	return fallbackReaders.get(db)?.(sessionId) ?? null;
}

type PiTagSnapshotLoadKind = "prewarm" | "turn";

interface OwnerJob {
	sessionId: string;
	kind: PiTagSnapshotLoadKind;
	projection?: "pass";
	/** A turn preempted this background read; its cancellation is not a failure. */
	preempted?: boolean;
	result: Promise<void>;
	released: Promise<void>;
	cancel: () => void;
	/** Stale or cancelled results need a fresh worker, not the rejected promise. */
	retryable?: boolean;
}

type PiSnapshotWorkerFactory = (
	request: PiHydrationRequest,
	cached: readonly PiPassTag[],
	cachedFallback: readonly PiFallbackTagRow[],
) => {
	result: Promise<{
		candidate: PiTagSnapshotCandidate;
		generation: PiHydrationGeneration;
	}>;
	released: Promise<void>;
	cancel: () => void;
};

let connectionEpoch = 0;
const owners = new WeakMap<
	Database,
	{
		ready: (sessionId: string, projection?: "pass") => boolean;
		load: (
			sessionId: string,
			kind: PiTagSnapshotLoadKind,
			projection?: "pass",
		) => Promise<void>;
		addNativeWaiter: (remaining: () => number) => () => void;
		manage: (sessionId: string) => void;
		cancel: (sessionId: string) => void;
	}
>();
const workerFactories = new WeakMap<Database, PiSnapshotWorkerFactory>();
const activeJobs = new Map<
	string,
	Set<{
		cancel: (sessionId: string) => void;
		result: Promise<void>;
		released: Promise<void>;
	}>
>();
const waitDeadlines = new WeakMap<PiContextBudget, number>();

/** Internal fixture seam; never selects a synchronous loader in production. */
export function __setPiTagSnapshotWorkerForTests(
	db: Database,
	factory: PiSnapshotWorkerFactory,
): void {
	workerFactories.set(db, factory);
}

/** Best-effort background hydration; a turn may claim it or preempt it for another session. */
export function prewarmPiTagSnapshot(
	db: Database,
	sessionId: string,
	projection?: "pass",
): void {
	createPiTagSnapshotReader(db);
	void owners
		.get(db)
		?.load(sessionId, "prewarm", projection)
		.catch(() => {});
}

/** Cancel in-flight jobs only after a session switch or teardown is confirmed.
 * Cached complete snapshots remain available if the same reader is reused.
 * A cancellable session_before_switch announcement must not invoke this.
 */
export function cancelPiTagSnapshotSession(sessionId: string): void {
	for (const job of activeJobs.get(sessionId) ?? []) job.cancel(sessionId);
}

/** Runtime shutdown owns both result settlement and native thread release.
 * The caller applies its existing shutdown deadline; context passes never
 * await this drain and can refuse while a cancelled native read is exiting.
 */
export async function drainPiTagSnapshotSession(
	sessionId: string,
): Promise<void> {
	await Promise.allSettled(
		[...(activeJobs.get(sessionId) ?? [])].flatMap((job) => [
			job.result,
			job.released,
		]),
	);
}

export function assertPiTagSnapshotReady(
	db: Database,
	sessionId: string,
): void {
	createPiTagSnapshotReader(db);
	const owner = owners.get(db);
	owner?.manage(sessionId);
	if (!owner?.ready(sessionId, "pass") && !owner?.ready(sessionId))
		throw new PiTagHydrationError(
			"tag snapshot is not ready; turn not sent, retry",
		);
}

/** A valid cached snapshot returns synchronously without starting a worker or
 * consuming the local change journal; normal pipeline synchronization owns it.
 * Missing or invalid snapshots instead return an asynchronous readiness wait.
 */
export function ensurePiTagSnapshotReady(
	db: Database,
	sessionId: string,
	budget: PiContextBudget,
	projection?: "pass",
): Promise<void> | void {
	budget.assert();
	createPiTagSnapshotReader(db);
	const owner = owners.get(db);
	if (!owner) throw new PiTagHydrationError("snapshot owner unavailable");
	owner.manage(sessionId);
	if (owner.ready(sessionId, projection)) return;
	let deadline = waitDeadlines.get(budget);
	if (deadline === undefined) {
		deadline = performance.now() + budget.hydrationAllowance();
		waitDeadlines.set(budget, deadline);
	}
	const end = deadline;
	return (async () => {
		// Discard stale or externally cancelled reads and retry within the original
		// allowance. The budget's signal and owner guard distinguish a cancelled
		// pass from a shared prewarm that was cancelled independently of the pass.
		for (;;) {
			budget.assert();
			const allowance = Math.min(
				end - performance.now(),
				budget.hydrationAllowance(),
			);
			if (allowance <= 0)
				throw new PiTagHydrationError(
					"remaining pass budget exhausted waiting for tag snapshot; turn not sent, retry",
					"deadline",
				);
			let timer: ReturnType<typeof setTimeout> | undefined;
			// Snapshot loading must not inherit a request's write guard. Cap its native
			// lock waits by the remaining turn budget while awaiting readiness.
			const releaseNativeWaiter = owner.addNativeWaiter(
				() => budget.remainingOutcome() - PI_CONTEXT_BUDGET.completionReserveMs,
			);
			try {
				await budget.wait(
					Promise.race([
						owner.load(sessionId, "turn", projection),
						new Promise<never>((_, reject) => {
							timer = setTimeout(
								() =>
									reject(
										new PiTagHydrationError(
											"remaining pass budget exhausted waiting for tag snapshot; turn not sent, retry",
											"deadline",
										),
									),
								allowance,
							);
						}),
					]),
				);
				budget.assert();
				assertPiTagSnapshotReady(db, sessionId);
				return;
			} catch (error) {
				budget.assert();
				if (
					!(
						error instanceof PiTagHydrationError &&
						(error.code === "stale" || error.code === "cancelled")
					)
				)
					throw error;
			} finally {
				clearTimeout(timer);
				releaseNativeWaiter();
			}
		}
	})();
}
