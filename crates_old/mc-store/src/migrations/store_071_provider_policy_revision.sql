-- Preparation is derived cache state. A namespace revision fences every policy
-- input shared by its conversations; SQL triggers advance it with the writer's
-- transaction, including writes made outside the Rust provider helpers.
CREATE TABLE mc_provider_policy_revisions_v1 (
    engine_namespace TEXT PRIMARY KEY NOT NULL,
    revision INTEGER NOT NULL CHECK(typeof(revision) = 'integer' AND revision >= 0),
    session TEXT NOT NULL
);
INSERT INTO mc_provider_policy_revisions_v1
SELECT engine_namespace, 0, min(session) FROM mc_provider_conversations_v2 GROUP BY engine_namespace;

CREATE TABLE mc_provider_policy_preparations_v1 (
    conv_key TEXT PRIMARY KEY NOT NULL,
    engine_namespace TEXT NOT NULL,
    policy_revision INTEGER NOT NULL CHECK(typeof(policy_revision) = 'integer' AND policy_revision >= 0),
    settings_key TEXT NOT NULL,
    original_baseline_json TEXT NOT NULL,
    newest_ordinal INTEGER NOT NULL CHECK(newest_ordinal >= 0),
    prepared_blob BLOB NOT NULL,
    uncompressed_bytes INTEGER NOT NULL CHECK(uncompressed_bytes >= 0),
    session TEXT NOT NULL CHECK(session = json_extract(conv_key, '$[1]'))
);
CREATE INDEX mc_provider_preparations_namespace ON mc_provider_policy_preparations_v1(engine_namespace);

-- A prepared snapshot needs the same first-before-image log as a bounded normal
-- summary, without publishing a refrozen baseline before the next admission.
DROP TRIGGER mc_provider_policy_parts_change_insert;
CREATE TRIGGER mc_provider_policy_parts_change_insert
AFTER INSERT ON mc_provider_policy_parts_v1
WHEN EXISTS (SELECT 1 FROM mc_provider_policy_summaries_v1 WHERE conv_key = NEW.conv_key)
    OR EXISTS (SELECT 1 FROM mc_provider_policy_preparations_v1 WHERE conv_key = NEW.conv_key)
BEGIN
    INSERT INTO mc_provider_policy_changes_v1
    SELECT NEW.conv_key, NEW.lineage_id, NEW.block_id, NULL, 0, NEW.session
    WHERE NOT EXISTS (SELECT 1 FROM mc_provider_policy_changes_v1 d
        WHERE d.conv_key = NEW.conv_key AND d.lineage_id = NEW.lineage_id
          AND d.block_id = NEW.block_id);
END;
DROP TRIGGER mc_provider_policy_parts_change_update;
CREATE TRIGGER mc_provider_policy_parts_change_update
AFTER UPDATE OF policy_json ON mc_provider_policy_parts_v1
WHEN EXISTS (SELECT 1 FROM mc_provider_policy_summaries_v1 WHERE conv_key = OLD.conv_key)
    OR EXISTS (SELECT 1 FROM mc_provider_policy_preparations_v1 WHERE conv_key = OLD.conv_key)
BEGIN
    INSERT INTO mc_provider_policy_changes_v1
    SELECT OLD.conv_key, OLD.lineage_id, OLD.block_id, OLD.policy_json,
        EXISTS (SELECT 1 FROM mc_provider_consumed_tags_v1 t
            JOIN mc_provider_conversations_v2 c ON c.engine_namespace = t.engine_namespace
            WHERE c.conv_key = OLD.conv_key
              AND t.tag_number = json_extract(OLD.policy_json, '$.tag_number')),
        OLD.session
    WHERE NOT EXISTS (SELECT 1 FROM mc_provider_policy_changes_v1 d
        WHERE d.conv_key = OLD.conv_key AND d.lineage_id = OLD.lineage_id
          AND d.block_id = OLD.block_id);
END;
DROP TRIGGER mc_provider_consumed_tags_change;
CREATE TRIGGER mc_provider_consumed_tags_change
AFTER INSERT ON mc_provider_consumed_tags_v1
BEGIN
    INSERT INTO mc_provider_policy_changes_v1
    SELECT p.conv_key, p.lineage_id, p.block_id, p.policy_json, 0, p.session
    FROM mc_provider_conversations_v2 c
    JOIN mc_provider_policy_parts_v1 p ON p.conv_key = c.conv_key
        AND json_extract(p.policy_json, '$.tag_number') = NEW.tag_number
    WHERE c.engine_namespace = NEW.engine_namespace
      AND (EXISTS (SELECT 1 FROM mc_provider_policy_summaries_v1 s WHERE s.conv_key = c.conv_key)
        OR EXISTS (SELECT 1 FROM mc_provider_policy_preparations_v1 s WHERE s.conv_key = c.conv_key))
      AND NOT EXISTS (SELECT 1 FROM mc_provider_policy_changes_v1 d
        WHERE d.conv_key = p.conv_key AND d.lineage_id = p.lineage_id
          AND d.block_id = p.block_id);
END;

-- Explicit overflow checks abort even when the outer writer uses OR IGNORE.
-- An exhausted revision must never wrap, become SQLite REAL, or be skipped by
-- that writer's conflict policy.
CREATE TRIGGER mc_provider_lineages_v1_revision_insert
AFTER INSERT ON mc_provider_lineages_v1
BEGIN
    SELECT CASE WHEN EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1
        WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (NEW.conv_key)) AND revision = 9223372036854775807)
        THEN RAISE(ABORT, 'provider policy revision exhausted') END;
    INSERT INTO mc_provider_policy_revisions_v1(engine_namespace, revision, session)
    SELECT engine_namespace, 0, coalesce((SELECT min(session) FROM mc_provider_conversations_v2 c WHERE c.engine_namespace=namespaces.engine_namespace), namespaces.engine_namespace) FROM (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (NEW.conv_key)) AS namespaces
    WHERE NOT EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1 r
        WHERE r.engine_namespace = namespaces.engine_namespace);
    UPDATE mc_provider_policy_revisions_v1 SET revision = revision + 1
    WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (NEW.conv_key));
END;

CREATE TRIGGER mc_provider_lineages_v1_revision_update
AFTER UPDATE ON mc_provider_lineages_v1
BEGIN
    SELECT CASE WHEN EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1
        WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key, NEW.conv_key)) AND revision = 9223372036854775807)
        THEN RAISE(ABORT, 'provider policy revision exhausted') END;
    INSERT INTO mc_provider_policy_revisions_v1(engine_namespace, revision, session)
    SELECT engine_namespace, 0, coalesce((SELECT min(session) FROM mc_provider_conversations_v2 c WHERE c.engine_namespace=namespaces.engine_namespace), namespaces.engine_namespace) FROM (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key, NEW.conv_key)) AS namespaces
    WHERE NOT EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1 r
        WHERE r.engine_namespace = namespaces.engine_namespace);
    UPDATE mc_provider_policy_revisions_v1 SET revision = revision + 1
    WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key, NEW.conv_key));
END;

CREATE TRIGGER mc_provider_lineages_v1_revision_delete
AFTER DELETE ON mc_provider_lineages_v1
BEGIN
    SELECT CASE WHEN EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1
        WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key)) AND revision = 9223372036854775807)
        THEN RAISE(ABORT, 'provider policy revision exhausted') END;
    INSERT INTO mc_provider_policy_revisions_v1(engine_namespace, revision, session)
    SELECT engine_namespace, 0, coalesce((SELECT min(session) FROM mc_provider_conversations_v2 c WHERE c.engine_namespace=namespaces.engine_namespace), namespaces.engine_namespace) FROM (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key)) AS namespaces
    WHERE NOT EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1 r
        WHERE r.engine_namespace = namespaces.engine_namespace);
    UPDATE mc_provider_policy_revisions_v1 SET revision = revision + 1
    WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key));
END;

CREATE TRIGGER mc_provider_messages_v1_revision_insert
AFTER INSERT ON mc_provider_messages_v1
BEGIN
    SELECT CASE WHEN EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1
        WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (NEW.conv_key)) AND revision = 9223372036854775807)
        THEN RAISE(ABORT, 'provider policy revision exhausted') END;
    INSERT INTO mc_provider_policy_revisions_v1(engine_namespace, revision, session)
    SELECT engine_namespace, 0, coalesce((SELECT min(session) FROM mc_provider_conversations_v2 c WHERE c.engine_namespace=namespaces.engine_namespace), namespaces.engine_namespace) FROM (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (NEW.conv_key)) AS namespaces
    WHERE NOT EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1 r
        WHERE r.engine_namespace = namespaces.engine_namespace);
    UPDATE mc_provider_policy_revisions_v1 SET revision = revision + 1
    WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (NEW.conv_key));
END;

CREATE TRIGGER mc_provider_messages_v1_revision_update
AFTER UPDATE ON mc_provider_messages_v1
BEGIN
    SELECT CASE WHEN EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1
        WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key, NEW.conv_key)) AND revision = 9223372036854775807)
        THEN RAISE(ABORT, 'provider policy revision exhausted') END;
    INSERT INTO mc_provider_policy_revisions_v1(engine_namespace, revision, session)
    SELECT engine_namespace, 0, coalesce((SELECT min(session) FROM mc_provider_conversations_v2 c WHERE c.engine_namespace=namespaces.engine_namespace), namespaces.engine_namespace) FROM (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key, NEW.conv_key)) AS namespaces
    WHERE NOT EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1 r
        WHERE r.engine_namespace = namespaces.engine_namespace);
    UPDATE mc_provider_policy_revisions_v1 SET revision = revision + 1
    WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key, NEW.conv_key));
END;

CREATE TRIGGER mc_provider_messages_v1_revision_delete
AFTER DELETE ON mc_provider_messages_v1
BEGIN
    SELECT CASE WHEN EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1
        WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key)) AND revision = 9223372036854775807)
        THEN RAISE(ABORT, 'provider policy revision exhausted') END;
    INSERT INTO mc_provider_policy_revisions_v1(engine_namespace, revision, session)
    SELECT engine_namespace, 0, coalesce((SELECT min(session) FROM mc_provider_conversations_v2 c WHERE c.engine_namespace=namespaces.engine_namespace), namespaces.engine_namespace) FROM (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key)) AS namespaces
    WHERE NOT EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1 r
        WHERE r.engine_namespace = namespaces.engine_namespace);
    UPDATE mc_provider_policy_revisions_v1 SET revision = revision + 1
    WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key));
END;

CREATE TRIGGER mc_provider_hook_answers_v1_revision_insert
AFTER INSERT ON mc_provider_hook_answers_v1
BEGIN
    SELECT CASE WHEN EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1
        WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (NEW.conv_key)) AND revision = 9223372036854775807)
        THEN RAISE(ABORT, 'provider policy revision exhausted') END;
    INSERT INTO mc_provider_policy_revisions_v1(engine_namespace, revision, session)
    SELECT engine_namespace, 0, coalesce((SELECT min(session) FROM mc_provider_conversations_v2 c WHERE c.engine_namespace=namespaces.engine_namespace), namespaces.engine_namespace) FROM (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (NEW.conv_key)) AS namespaces
    WHERE NOT EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1 r
        WHERE r.engine_namespace = namespaces.engine_namespace);
    UPDATE mc_provider_policy_revisions_v1 SET revision = revision + 1
    WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (NEW.conv_key));
END;

CREATE TRIGGER mc_provider_hook_answers_v1_revision_update
AFTER UPDATE ON mc_provider_hook_answers_v1
BEGIN
    SELECT CASE WHEN EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1
        WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key, NEW.conv_key)) AND revision = 9223372036854775807)
        THEN RAISE(ABORT, 'provider policy revision exhausted') END;
    INSERT INTO mc_provider_policy_revisions_v1(engine_namespace, revision, session)
    SELECT engine_namespace, 0, coalesce((SELECT min(session) FROM mc_provider_conversations_v2 c WHERE c.engine_namespace=namespaces.engine_namespace), namespaces.engine_namespace) FROM (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key, NEW.conv_key)) AS namespaces
    WHERE NOT EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1 r
        WHERE r.engine_namespace = namespaces.engine_namespace);
    UPDATE mc_provider_policy_revisions_v1 SET revision = revision + 1
    WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key, NEW.conv_key));
END;

CREATE TRIGGER mc_provider_hook_answers_v1_revision_delete
AFTER DELETE ON mc_provider_hook_answers_v1
BEGIN
    SELECT CASE WHEN EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1
        WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key)) AND revision = 9223372036854775807)
        THEN RAISE(ABORT, 'provider policy revision exhausted') END;
    INSERT INTO mc_provider_policy_revisions_v1(engine_namespace, revision, session)
    SELECT engine_namespace, 0, coalesce((SELECT min(session) FROM mc_provider_conversations_v2 c WHERE c.engine_namespace=namespaces.engine_namespace), namespaces.engine_namespace) FROM (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key)) AS namespaces
    WHERE NOT EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1 r
        WHERE r.engine_namespace = namespaces.engine_namespace);
    UPDATE mc_provider_policy_revisions_v1 SET revision = revision + 1
    WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key));
END;

CREATE TRIGGER mc_provider_policy_parts_v1_revision_insert
AFTER INSERT ON mc_provider_policy_parts_v1
BEGIN
    SELECT CASE WHEN EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1
        WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (NEW.conv_key)) AND revision = 9223372036854775807)
        THEN RAISE(ABORT, 'provider policy revision exhausted') END;
    INSERT INTO mc_provider_policy_revisions_v1(engine_namespace, revision, session)
    SELECT engine_namespace, 0, coalesce((SELECT min(session) FROM mc_provider_conversations_v2 c WHERE c.engine_namespace=namespaces.engine_namespace), namespaces.engine_namespace) FROM (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (NEW.conv_key)) AS namespaces
    WHERE NOT EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1 r
        WHERE r.engine_namespace = namespaces.engine_namespace);
    UPDATE mc_provider_policy_revisions_v1 SET revision = revision + 1
    WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (NEW.conv_key));
END;

CREATE TRIGGER mc_provider_policy_parts_v1_revision_update
AFTER UPDATE ON mc_provider_policy_parts_v1
BEGIN
    SELECT CASE WHEN EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1
        WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key, NEW.conv_key)) AND revision = 9223372036854775807)
        THEN RAISE(ABORT, 'provider policy revision exhausted') END;
    INSERT INTO mc_provider_policy_revisions_v1(engine_namespace, revision, session)
    SELECT engine_namespace, 0, coalesce((SELECT min(session) FROM mc_provider_conversations_v2 c WHERE c.engine_namespace=namespaces.engine_namespace), namespaces.engine_namespace) FROM (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key, NEW.conv_key)) AS namespaces
    WHERE NOT EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1 r
        WHERE r.engine_namespace = namespaces.engine_namespace);
    UPDATE mc_provider_policy_revisions_v1 SET revision = revision + 1
    WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key, NEW.conv_key));
END;

CREATE TRIGGER mc_provider_policy_parts_v1_revision_delete
AFTER DELETE ON mc_provider_policy_parts_v1
BEGIN
    SELECT CASE WHEN EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1
        WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key)) AND revision = 9223372036854775807)
        THEN RAISE(ABORT, 'provider policy revision exhausted') END;
    INSERT INTO mc_provider_policy_revisions_v1(engine_namespace, revision, session)
    SELECT engine_namespace, 0, coalesce((SELECT min(session) FROM mc_provider_conversations_v2 c WHERE c.engine_namespace=namespaces.engine_namespace), namespaces.engine_namespace) FROM (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key)) AS namespaces
    WHERE NOT EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1 r
        WHERE r.engine_namespace = namespaces.engine_namespace);
    UPDATE mc_provider_policy_revisions_v1 SET revision = revision + 1
    WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key));
END;

CREATE TRIGGER mc_provider_policy_summaries_v1_revision_insert
AFTER INSERT ON mc_provider_policy_summaries_v1
BEGIN
    SELECT CASE WHEN EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1
        WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (NEW.conv_key)) AND revision = 9223372036854775807)
        THEN RAISE(ABORT, 'provider policy revision exhausted') END;
    INSERT INTO mc_provider_policy_revisions_v1(engine_namespace, revision, session)
    SELECT engine_namespace, 0, coalesce((SELECT min(session) FROM mc_provider_conversations_v2 c WHERE c.engine_namespace=namespaces.engine_namespace), namespaces.engine_namespace) FROM (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (NEW.conv_key)) AS namespaces
    WHERE NOT EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1 r
        WHERE r.engine_namespace = namespaces.engine_namespace);
    UPDATE mc_provider_policy_revisions_v1 SET revision = revision + 1
    WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (NEW.conv_key));
END;

CREATE TRIGGER mc_provider_policy_summaries_v1_revision_update
AFTER UPDATE ON mc_provider_policy_summaries_v1
BEGIN
    SELECT CASE WHEN EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1
        WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key, NEW.conv_key)) AND revision = 9223372036854775807)
        THEN RAISE(ABORT, 'provider policy revision exhausted') END;
    INSERT INTO mc_provider_policy_revisions_v1(engine_namespace, revision, session)
    SELECT engine_namespace, 0, coalesce((SELECT min(session) FROM mc_provider_conversations_v2 c WHERE c.engine_namespace=namespaces.engine_namespace), namespaces.engine_namespace) FROM (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key, NEW.conv_key)) AS namespaces
    WHERE NOT EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1 r
        WHERE r.engine_namespace = namespaces.engine_namespace);
    UPDATE mc_provider_policy_revisions_v1 SET revision = revision + 1
    WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key, NEW.conv_key));
END;

CREATE TRIGGER mc_provider_policy_summaries_v1_revision_delete
AFTER DELETE ON mc_provider_policy_summaries_v1
BEGIN
    SELECT CASE WHEN EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1
        WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key)) AND revision = 9223372036854775807)
        THEN RAISE(ABORT, 'provider policy revision exhausted') END;
    INSERT INTO mc_provider_policy_revisions_v1(engine_namespace, revision, session)
    SELECT engine_namespace, 0, coalesce((SELECT min(session) FROM mc_provider_conversations_v2 c WHERE c.engine_namespace=namespaces.engine_namespace), namespaces.engine_namespace) FROM (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key)) AS namespaces
    WHERE NOT EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1 r
        WHERE r.engine_namespace = namespaces.engine_namespace);
    UPDATE mc_provider_policy_revisions_v1 SET revision = revision + 1
    WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key));
END;

CREATE TRIGGER mc_provider_policy_changes_v1_revision_insert
AFTER INSERT ON mc_provider_policy_changes_v1
BEGIN
    SELECT CASE WHEN EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1
        WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (NEW.conv_key)) AND revision = 9223372036854775807)
        THEN RAISE(ABORT, 'provider policy revision exhausted') END;
    INSERT INTO mc_provider_policy_revisions_v1(engine_namespace, revision, session)
    SELECT engine_namespace, 0, coalesce((SELECT min(session) FROM mc_provider_conversations_v2 c WHERE c.engine_namespace=namespaces.engine_namespace), namespaces.engine_namespace) FROM (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (NEW.conv_key)) AS namespaces
    WHERE NOT EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1 r
        WHERE r.engine_namespace = namespaces.engine_namespace);
    UPDATE mc_provider_policy_revisions_v1 SET revision = revision + 1
    WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (NEW.conv_key));
END;

CREATE TRIGGER mc_provider_policy_changes_v1_revision_update
AFTER UPDATE ON mc_provider_policy_changes_v1
BEGIN
    SELECT CASE WHEN EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1
        WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key, NEW.conv_key)) AND revision = 9223372036854775807)
        THEN RAISE(ABORT, 'provider policy revision exhausted') END;
    INSERT INTO mc_provider_policy_revisions_v1(engine_namespace, revision, session)
    SELECT engine_namespace, 0, coalesce((SELECT min(session) FROM mc_provider_conversations_v2 c WHERE c.engine_namespace=namespaces.engine_namespace), namespaces.engine_namespace) FROM (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key, NEW.conv_key)) AS namespaces
    WHERE NOT EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1 r
        WHERE r.engine_namespace = namespaces.engine_namespace);
    UPDATE mc_provider_policy_revisions_v1 SET revision = revision + 1
    WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key, NEW.conv_key));
END;

CREATE TRIGGER mc_provider_policy_changes_v1_revision_delete
AFTER DELETE ON mc_provider_policy_changes_v1
BEGIN
    SELECT CASE WHEN EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1
        WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key)) AND revision = 9223372036854775807)
        THEN RAISE(ABORT, 'provider policy revision exhausted') END;
    INSERT INTO mc_provider_policy_revisions_v1(engine_namespace, revision, session)
    SELECT engine_namespace, 0, coalesce((SELECT min(session) FROM mc_provider_conversations_v2 c WHERE c.engine_namespace=namespaces.engine_namespace), namespaces.engine_namespace) FROM (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key)) AS namespaces
    WHERE NOT EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1 r
        WHERE r.engine_namespace = namespaces.engine_namespace);
    UPDATE mc_provider_policy_revisions_v1 SET revision = revision + 1
    WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key));
END;

CREATE TRIGGER mc_provider_pending_drops_v1_revision_insert
AFTER INSERT ON mc_provider_pending_drops_v1
BEGIN
    SELECT CASE WHEN EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1
        WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (NEW.conv_key)) AND revision = 9223372036854775807)
        THEN RAISE(ABORT, 'provider policy revision exhausted') END;
    INSERT INTO mc_provider_policy_revisions_v1(engine_namespace, revision, session)
    SELECT engine_namespace, 0, coalesce((SELECT min(session) FROM mc_provider_conversations_v2 c WHERE c.engine_namespace=namespaces.engine_namespace), namespaces.engine_namespace) FROM (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (NEW.conv_key)) AS namespaces
    WHERE NOT EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1 r
        WHERE r.engine_namespace = namespaces.engine_namespace);
    UPDATE mc_provider_policy_revisions_v1 SET revision = revision + 1
    WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (NEW.conv_key));
END;

CREATE TRIGGER mc_provider_pending_drops_v1_revision_update
AFTER UPDATE ON mc_provider_pending_drops_v1
BEGIN
    SELECT CASE WHEN EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1
        WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key, NEW.conv_key)) AND revision = 9223372036854775807)
        THEN RAISE(ABORT, 'provider policy revision exhausted') END;
    INSERT INTO mc_provider_policy_revisions_v1(engine_namespace, revision, session)
    SELECT engine_namespace, 0, coalesce((SELECT min(session) FROM mc_provider_conversations_v2 c WHERE c.engine_namespace=namespaces.engine_namespace), namespaces.engine_namespace) FROM (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key, NEW.conv_key)) AS namespaces
    WHERE NOT EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1 r
        WHERE r.engine_namespace = namespaces.engine_namespace);
    UPDATE mc_provider_policy_revisions_v1 SET revision = revision + 1
    WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key, NEW.conv_key));
END;

CREATE TRIGGER mc_provider_pending_drops_v1_revision_delete
AFTER DELETE ON mc_provider_pending_drops_v1
BEGIN
    SELECT CASE WHEN EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1
        WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key)) AND revision = 9223372036854775807)
        THEN RAISE(ABORT, 'provider policy revision exhausted') END;
    INSERT INTO mc_provider_policy_revisions_v1(engine_namespace, revision, session)
    SELECT engine_namespace, 0, coalesce((SELECT min(session) FROM mc_provider_conversations_v2 c WHERE c.engine_namespace=namespaces.engine_namespace), namespaces.engine_namespace) FROM (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key)) AS namespaces
    WHERE NOT EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1 r
        WHERE r.engine_namespace = namespaces.engine_namespace);
    UPDATE mc_provider_policy_revisions_v1 SET revision = revision + 1
    WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key));
END;

CREATE TRIGGER mc_provider_legacy_tags_v1_revision_insert
AFTER INSERT ON mc_provider_legacy_tags_v1
BEGIN
    SELECT CASE WHEN EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1
        WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (NEW.conv_key)) AND revision = 9223372036854775807)
        THEN RAISE(ABORT, 'provider policy revision exhausted') END;
    INSERT INTO mc_provider_policy_revisions_v1(engine_namespace, revision, session)
    SELECT engine_namespace, 0, coalesce((SELECT min(session) FROM mc_provider_conversations_v2 c WHERE c.engine_namespace=namespaces.engine_namespace), namespaces.engine_namespace) FROM (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (NEW.conv_key)) AS namespaces
    WHERE NOT EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1 r
        WHERE r.engine_namespace = namespaces.engine_namespace);
    UPDATE mc_provider_policy_revisions_v1 SET revision = revision + 1
    WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (NEW.conv_key));
END;

CREATE TRIGGER mc_provider_legacy_tags_v1_revision_update
AFTER UPDATE ON mc_provider_legacy_tags_v1
BEGIN
    SELECT CASE WHEN EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1
        WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key, NEW.conv_key)) AND revision = 9223372036854775807)
        THEN RAISE(ABORT, 'provider policy revision exhausted') END;
    INSERT INTO mc_provider_policy_revisions_v1(engine_namespace, revision, session)
    SELECT engine_namespace, 0, coalesce((SELECT min(session) FROM mc_provider_conversations_v2 c WHERE c.engine_namespace=namespaces.engine_namespace), namespaces.engine_namespace) FROM (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key, NEW.conv_key)) AS namespaces
    WHERE NOT EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1 r
        WHERE r.engine_namespace = namespaces.engine_namespace);
    UPDATE mc_provider_policy_revisions_v1 SET revision = revision + 1
    WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key, NEW.conv_key));
END;

CREATE TRIGGER mc_provider_legacy_tags_v1_revision_delete
AFTER DELETE ON mc_provider_legacy_tags_v1
BEGIN
    SELECT CASE WHEN EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1
        WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key)) AND revision = 9223372036854775807)
        THEN RAISE(ABORT, 'provider policy revision exhausted') END;
    INSERT INTO mc_provider_policy_revisions_v1(engine_namespace, revision, session)
    SELECT engine_namespace, 0, coalesce((SELECT min(session) FROM mc_provider_conversations_v2 c WHERE c.engine_namespace=namespaces.engine_namespace), namespaces.engine_namespace) FROM (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key)) AS namespaces
    WHERE NOT EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1 r
        WHERE r.engine_namespace = namespaces.engine_namespace);
    UPDATE mc_provider_policy_revisions_v1 SET revision = revision + 1
    WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key IN (OLD.conv_key));
END;

CREATE TRIGGER mc_provider_conversations_v2_revision_insert
AFTER INSERT ON mc_provider_conversations_v2
BEGIN
    SELECT CASE WHEN EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1
        WHERE engine_namespace IN (SELECT engine_namespace FROM (SELECT NEW.engine_namespace AS engine_namespace) WHERE engine_namespace IS NOT NULL) AND revision = 9223372036854775807)
        THEN RAISE(ABORT, 'provider policy revision exhausted') END;
    INSERT INTO mc_provider_policy_revisions_v1(engine_namespace, revision, session)
    SELECT engine_namespace, 0, coalesce((SELECT min(session) FROM mc_provider_conversations_v2 c WHERE c.engine_namespace=namespaces.engine_namespace), namespaces.engine_namespace) FROM (SELECT engine_namespace FROM (SELECT NEW.engine_namespace AS engine_namespace) WHERE engine_namespace IS NOT NULL) AS namespaces
    WHERE NOT EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1 r
        WHERE r.engine_namespace = namespaces.engine_namespace);
    UPDATE mc_provider_policy_revisions_v1 SET revision = revision + 1
    WHERE engine_namespace IN (SELECT engine_namespace FROM (SELECT NEW.engine_namespace AS engine_namespace) WHERE engine_namespace IS NOT NULL);
END;

CREATE TRIGGER mc_provider_conversations_v2_revision_update
AFTER UPDATE ON mc_provider_conversations_v2
BEGIN
    SELECT CASE WHEN EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1
        WHERE engine_namespace IN (SELECT engine_namespace FROM (SELECT OLD.engine_namespace AS engine_namespace UNION SELECT NEW.engine_namespace AS engine_namespace) WHERE engine_namespace IS NOT NULL) AND revision = 9223372036854775807)
        THEN RAISE(ABORT, 'provider policy revision exhausted') END;
    INSERT INTO mc_provider_policy_revisions_v1(engine_namespace, revision, session)
    SELECT engine_namespace, 0, coalesce((SELECT min(session) FROM mc_provider_conversations_v2 c WHERE c.engine_namespace=namespaces.engine_namespace), namespaces.engine_namespace) FROM (SELECT engine_namespace FROM (SELECT OLD.engine_namespace AS engine_namespace UNION SELECT NEW.engine_namespace AS engine_namespace) WHERE engine_namespace IS NOT NULL) AS namespaces
    WHERE NOT EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1 r
        WHERE r.engine_namespace = namespaces.engine_namespace);
    UPDATE mc_provider_policy_revisions_v1 SET revision = revision + 1
    WHERE engine_namespace IN (SELECT engine_namespace FROM (SELECT OLD.engine_namespace AS engine_namespace UNION SELECT NEW.engine_namespace AS engine_namespace) WHERE engine_namespace IS NOT NULL);
END;

CREATE TRIGGER mc_provider_conversations_v2_revision_delete
BEFORE DELETE ON mc_provider_conversations_v2
BEGIN
    SELECT CASE WHEN EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1
        WHERE engine_namespace IN (SELECT engine_namespace FROM (SELECT OLD.engine_namespace AS engine_namespace) WHERE engine_namespace IS NOT NULL) AND revision = 9223372036854775807)
        THEN RAISE(ABORT, 'provider policy revision exhausted') END;
    INSERT INTO mc_provider_policy_revisions_v1(engine_namespace, revision, session)
    SELECT engine_namespace, 0, coalesce((SELECT min(session) FROM mc_provider_conversations_v2 c WHERE c.engine_namespace=namespaces.engine_namespace), namespaces.engine_namespace) FROM (SELECT engine_namespace FROM (SELECT OLD.engine_namespace AS engine_namespace) WHERE engine_namespace IS NOT NULL) AS namespaces
    WHERE NOT EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1 r
        WHERE r.engine_namespace = namespaces.engine_namespace);
    UPDATE mc_provider_policy_revisions_v1 SET revision = revision + 1
    WHERE engine_namespace IN (SELECT engine_namespace FROM (SELECT OLD.engine_namespace AS engine_namespace) WHERE engine_namespace IS NOT NULL);
END;

CREATE TRIGGER mc_provider_consumed_tags_v1_revision_insert
AFTER INSERT ON mc_provider_consumed_tags_v1
BEGIN
    SELECT CASE WHEN EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1
        WHERE engine_namespace IN (SELECT engine_namespace FROM (SELECT NEW.engine_namespace AS engine_namespace) WHERE engine_namespace IS NOT NULL) AND revision = 9223372036854775807)
        THEN RAISE(ABORT, 'provider policy revision exhausted') END;
    INSERT INTO mc_provider_policy_revisions_v1(engine_namespace, revision, session)
    SELECT engine_namespace, 0, coalesce((SELECT min(session) FROM mc_provider_conversations_v2 c WHERE c.engine_namespace=namespaces.engine_namespace), namespaces.engine_namespace) FROM (SELECT engine_namespace FROM (SELECT NEW.engine_namespace AS engine_namespace) WHERE engine_namespace IS NOT NULL) AS namespaces
    WHERE NOT EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1 r
        WHERE r.engine_namespace = namespaces.engine_namespace);
    UPDATE mc_provider_policy_revisions_v1 SET revision = revision + 1
    WHERE engine_namespace IN (SELECT engine_namespace FROM (SELECT NEW.engine_namespace AS engine_namespace) WHERE engine_namespace IS NOT NULL);
END;

CREATE TRIGGER mc_provider_consumed_tags_v1_revision_update
AFTER UPDATE ON mc_provider_consumed_tags_v1
BEGIN
    SELECT CASE WHEN EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1
        WHERE engine_namespace IN (SELECT engine_namespace FROM (SELECT OLD.engine_namespace AS engine_namespace UNION SELECT NEW.engine_namespace AS engine_namespace) WHERE engine_namespace IS NOT NULL) AND revision = 9223372036854775807)
        THEN RAISE(ABORT, 'provider policy revision exhausted') END;
    INSERT INTO mc_provider_policy_revisions_v1(engine_namespace, revision, session)
    SELECT engine_namespace, 0, coalesce((SELECT min(session) FROM mc_provider_conversations_v2 c WHERE c.engine_namespace=namespaces.engine_namespace), namespaces.engine_namespace) FROM (SELECT engine_namespace FROM (SELECT OLD.engine_namespace AS engine_namespace UNION SELECT NEW.engine_namespace AS engine_namespace) WHERE engine_namespace IS NOT NULL) AS namespaces
    WHERE NOT EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1 r
        WHERE r.engine_namespace = namespaces.engine_namespace);
    UPDATE mc_provider_policy_revisions_v1 SET revision = revision + 1
    WHERE engine_namespace IN (SELECT engine_namespace FROM (SELECT OLD.engine_namespace AS engine_namespace UNION SELECT NEW.engine_namespace AS engine_namespace) WHERE engine_namespace IS NOT NULL);
END;

CREATE TRIGGER mc_provider_consumed_tags_v1_revision_delete
AFTER DELETE ON mc_provider_consumed_tags_v1
BEGIN
    SELECT CASE WHEN EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1
        WHERE engine_namespace IN (SELECT engine_namespace FROM (SELECT OLD.engine_namespace AS engine_namespace) WHERE engine_namespace IS NOT NULL) AND revision = 9223372036854775807)
        THEN RAISE(ABORT, 'provider policy revision exhausted') END;
    INSERT INTO mc_provider_policy_revisions_v1(engine_namespace, revision, session)
    SELECT engine_namespace, 0, coalesce((SELECT min(session) FROM mc_provider_conversations_v2 c WHERE c.engine_namespace=namespaces.engine_namespace), namespaces.engine_namespace) FROM (SELECT engine_namespace FROM (SELECT OLD.engine_namespace AS engine_namespace) WHERE engine_namespace IS NOT NULL) AS namespaces
    WHERE NOT EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1 r
        WHERE r.engine_namespace = namespaces.engine_namespace);
    UPDATE mc_provider_policy_revisions_v1 SET revision = revision + 1
    WHERE engine_namespace IN (SELECT engine_namespace FROM (SELECT OLD.engine_namespace AS engine_namespace) WHERE engine_namespace IS NOT NULL);
END;

CREATE TRIGGER mc_tags_revision_insert
AFTER INSERT ON mc_tags
BEGIN
    SELECT CASE WHEN EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1
        WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE engine_namespace IN (NEW.session_id)) AND revision = 9223372036854775807)
        THEN RAISE(ABORT, 'provider policy revision exhausted') END;
    INSERT INTO mc_provider_policy_revisions_v1(engine_namespace, revision, session)
    SELECT engine_namespace, 0, coalesce((SELECT min(session) FROM mc_provider_conversations_v2 c WHERE c.engine_namespace=namespaces.engine_namespace), namespaces.engine_namespace) FROM (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE engine_namespace IN (NEW.session_id)) AS namespaces
    WHERE NOT EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1 r
        WHERE r.engine_namespace = namespaces.engine_namespace);
    UPDATE mc_provider_policy_revisions_v1 SET revision = revision + 1
    WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE engine_namespace IN (NEW.session_id));
END;

CREATE TRIGGER mc_tags_revision_update
AFTER UPDATE ON mc_tags
BEGIN
    SELECT CASE WHEN EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1
        WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE engine_namespace IN (OLD.session_id, NEW.session_id)) AND revision = 9223372036854775807)
        THEN RAISE(ABORT, 'provider policy revision exhausted') END;
    INSERT INTO mc_provider_policy_revisions_v1(engine_namespace, revision, session)
    SELECT engine_namespace, 0, coalesce((SELECT min(session) FROM mc_provider_conversations_v2 c WHERE c.engine_namespace=namespaces.engine_namespace), namespaces.engine_namespace) FROM (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE engine_namespace IN (OLD.session_id, NEW.session_id)) AS namespaces
    WHERE NOT EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1 r
        WHERE r.engine_namespace = namespaces.engine_namespace);
    UPDATE mc_provider_policy_revisions_v1 SET revision = revision + 1
    WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE engine_namespace IN (OLD.session_id, NEW.session_id));
END;

CREATE TRIGGER mc_tags_revision_delete
AFTER DELETE ON mc_tags
BEGIN
    SELECT CASE WHEN EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1
        WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE engine_namespace IN (OLD.session_id)) AND revision = 9223372036854775807)
        THEN RAISE(ABORT, 'provider policy revision exhausted') END;
    INSERT INTO mc_provider_policy_revisions_v1(engine_namespace, revision, session)
    SELECT engine_namespace, 0, coalesce((SELECT min(session) FROM mc_provider_conversations_v2 c WHERE c.engine_namespace=namespaces.engine_namespace), namespaces.engine_namespace) FROM (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE engine_namespace IN (OLD.session_id)) AS namespaces
    WHERE NOT EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1 r
        WHERE r.engine_namespace = namespaces.engine_namespace);
    UPDATE mc_provider_policy_revisions_v1 SET revision = revision + 1
    WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE engine_namespace IN (OLD.session_id));
END;

CREATE TRIGGER mc_cache_state_revision_insert
AFTER INSERT ON mc_cache_state
BEGIN
    SELECT CASE WHEN EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1
        WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE engine_namespace IN (NEW.session_id)) AND revision = 9223372036854775807)
        THEN RAISE(ABORT, 'provider policy revision exhausted') END;
    INSERT INTO mc_provider_policy_revisions_v1(engine_namespace, revision, session)
    SELECT engine_namespace, 0, coalesce((SELECT min(session) FROM mc_provider_conversations_v2 c WHERE c.engine_namespace=namespaces.engine_namespace), namespaces.engine_namespace) FROM (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE engine_namespace IN (NEW.session_id)) AS namespaces
    WHERE NOT EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1 r
        WHERE r.engine_namespace = namespaces.engine_namespace);
    UPDATE mc_provider_policy_revisions_v1 SET revision = revision + 1
    WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE engine_namespace IN (NEW.session_id));
END;

CREATE TRIGGER mc_cache_state_revision_update
AFTER UPDATE ON mc_cache_state
BEGIN
    SELECT CASE WHEN EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1
        WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE engine_namespace IN (OLD.session_id, NEW.session_id)) AND revision = 9223372036854775807)
        THEN RAISE(ABORT, 'provider policy revision exhausted') END;
    INSERT INTO mc_provider_policy_revisions_v1(engine_namespace, revision, session)
    SELECT engine_namespace, 0, coalesce((SELECT min(session) FROM mc_provider_conversations_v2 c WHERE c.engine_namespace=namespaces.engine_namespace), namespaces.engine_namespace) FROM (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE engine_namespace IN (OLD.session_id, NEW.session_id)) AS namespaces
    WHERE NOT EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1 r
        WHERE r.engine_namespace = namespaces.engine_namespace);
    UPDATE mc_provider_policy_revisions_v1 SET revision = revision + 1
    WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE engine_namespace IN (OLD.session_id, NEW.session_id));
END;

CREATE TRIGGER mc_cache_state_revision_delete
AFTER DELETE ON mc_cache_state
BEGIN
    SELECT CASE WHEN EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1
        WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE engine_namespace IN (OLD.session_id)) AND revision = 9223372036854775807)
        THEN RAISE(ABORT, 'provider policy revision exhausted') END;
    INSERT INTO mc_provider_policy_revisions_v1(engine_namespace, revision, session)
    SELECT engine_namespace, 0, coalesce((SELECT min(session) FROM mc_provider_conversations_v2 c WHERE c.engine_namespace=namespaces.engine_namespace), namespaces.engine_namespace) FROM (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE engine_namespace IN (OLD.session_id)) AS namespaces
    WHERE NOT EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1 r
        WHERE r.engine_namespace = namespaces.engine_namespace);
    UPDATE mc_provider_policy_revisions_v1 SET revision = revision + 1
    WHERE engine_namespace IN (SELECT DISTINCT engine_namespace FROM mc_provider_conversations_v2 WHERE engine_namespace IN (OLD.session_id));
END;

-- INSERT OR REPLACE can remove an old namespace row without firing DELETE
-- triggers when recursive triggers are disabled. Fence that old number space.
CREATE TRIGGER mc_provider_conversations_revision_replace
BEFORE INSERT ON mc_provider_conversations_v2
BEGIN
    SELECT CASE WHEN EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1
        WHERE engine_namespace IN (SELECT engine_namespace FROM mc_provider_conversations_v2
    WHERE conv_key = NEW.conv_key AND engine_namespace IS NOT NEW.engine_namespace) AND revision = 9223372036854775807)
        THEN RAISE(ABORT, 'provider policy revision exhausted') END;
    INSERT INTO mc_provider_policy_revisions_v1(engine_namespace, revision, session)
    SELECT engine_namespace, 0, coalesce((SELECT min(session) FROM mc_provider_conversations_v2 c WHERE c.engine_namespace=namespaces.engine_namespace), namespaces.engine_namespace) FROM (SELECT engine_namespace FROM mc_provider_conversations_v2
    WHERE conv_key = NEW.conv_key AND engine_namespace IS NOT NEW.engine_namespace) AS namespaces
    WHERE NOT EXISTS (SELECT 1 FROM mc_provider_policy_revisions_v1 r
        WHERE r.engine_namespace = namespaces.engine_namespace);
    UPDATE mc_provider_policy_revisions_v1 SET revision = revision + 1
    WHERE engine_namespace IN (SELECT engine_namespace FROM mc_provider_conversations_v2
    WHERE conv_key = NEW.conv_key AND engine_namespace IS NOT NEW.engine_namespace);
END;

CREATE TRIGGER mc_provider_preparation_namespace_change
AFTER UPDATE OF engine_namespace ON mc_provider_conversations_v2
WHEN OLD.engine_namespace IS NOT NEW.engine_namespace
BEGIN
    DELETE FROM mc_provider_policy_preparations_v1 WHERE conv_key = OLD.conv_key;
END;
CREATE TRIGGER mc_provider_preparation_conversation_delete
AFTER DELETE ON mc_provider_conversations_v2
BEGIN
    DELETE FROM mc_provider_policy_preparations_v1 WHERE conv_key = OLD.conv_key;
END;
CREATE TRIGGER mc_provider_preparation_part_move
AFTER UPDATE OF conv_key, lineage_id, ordinal, block_id ON mc_provider_policy_parts_v1
WHEN OLD.conv_key IS NOT NEW.conv_key OR OLD.lineage_id IS NOT NEW.lineage_id
    OR OLD.ordinal IS NOT NEW.ordinal OR OLD.block_id IS NOT NEW.block_id
BEGIN
    DELETE FROM mc_provider_policy_preparations_v1 WHERE conv_key IN (OLD.conv_key, NEW.conv_key);
END;
CREATE TRIGGER mc_provider_preparation_part_delete
AFTER DELETE ON mc_provider_policy_parts_v1
BEGIN
    DELETE FROM mc_provider_policy_preparations_v1 WHERE conv_key = OLD.conv_key;
END;
