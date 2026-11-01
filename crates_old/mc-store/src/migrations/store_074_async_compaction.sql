-- One small, fixed-size record per async conversation. The held transcript,
-- its tag index and the engine baselines live in the row tables below, so an
-- ordinary notice rewrites only this record and appends its new entries.
CREATE TABLE mc_async_compaction (
    session_ref TEXT PRIMARY KEY,
    conversation_key TEXT NOT NULL UNIQUE,
    session TEXT NOT NULL,
    state_json TEXT NOT NULL,
    version_high_water INTEGER NOT NULL DEFAULT 0
);
-- Append-only held transcript: one immutable runner entry per ordinal, with
-- the tag addresses (tag, opaque part key, part digest) of its parts.
CREATE TABLE mc_async_compaction_entries (
    session_ref TEXT NOT NULL,
    session TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    entry_json TEXT NOT NULL,
    index_json TEXT NOT NULL,
    PRIMARY KEY (session_ref, ordinal),
    FOREIGN KEY (session_ref) REFERENCES mc_async_compaction(session_ref)
);
-- Immutable published views and their announcement outbox. engine_json is
-- the engine's own form of the same view, kept while the view can still
-- become the engine baseline (cleared when a resync starts a new generation).
CREATE TABLE mc_async_compaction_views (
    session_ref TEXT NOT NULL,
    session TEXT NOT NULL,
    version INTEGER NOT NULL,
    view_json TEXT NOT NULL,
    engine_json TEXT,
    announced INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session_ref, version),
    FOREIGN KEY (session_ref) REFERENCES mc_async_compaction(session_ref)
);
-- An engine baseline ('produced' or 'applied') that is not one of the
-- published views above, such as Setup's initial view or a view rebased by
-- a verified fork descent.
CREATE TABLE mc_async_compaction_baselines (
    session_ref TEXT NOT NULL,
    session TEXT NOT NULL,
    slot TEXT NOT NULL,
    view_json TEXT NOT NULL,
    PRIMARY KEY (session_ref, slot),
    FOREIGN KEY (session_ref) REFERENCES mc_async_compaction(session_ref)
);
