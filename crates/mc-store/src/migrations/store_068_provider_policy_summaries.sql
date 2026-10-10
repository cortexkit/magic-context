-- Bounded provider policy summaries. A host hook needs channel-1 totals over
-- every content-free policy part of its conversation lineage. Rereading those
-- rows on every hook grows with the session, so a conversation keeps a summary
-- of them and the hook reads only the rows that changed since it was taken.
--
-- The summary row is derived state: deleting it is always safe and makes the
-- next hook rebuild it from the policy parts. While it exists, these triggers
-- record each changed part once, keeping the first pre-change copy so the
-- summary can remove what that row contributed before. Without a summary the
-- triggers record nothing, so bulk engine rewrites only drop the summary.
-- The inserts test for an existing entry instead of using OR IGNORE: inside a
-- trigger, an upsert's conflict handling would override OR IGNORE.
CREATE TABLE mc_provider_policy_summaries_v1 (
    conv_key TEXT PRIMARY KEY,
    summary_json TEXT NOT NULL,
    session TEXT NOT NULL CHECK(session = json_extract(conv_key, '$[1]'))
);
CREATE TABLE mc_provider_policy_changes_v1 (
    conv_key TEXT NOT NULL,
    lineage_id TEXT NOT NULL,
    block_id TEXT NOT NULL,
    -- NULL when the row did not exist when the summary was taken.
    previous_json TEXT,
    -- Whether the previous copy's tag number was already consumed.
    previous_consumed INTEGER NOT NULL DEFAULT 0,
    session TEXT NOT NULL CHECK(session = json_extract(conv_key, '$[1]')),
    PRIMARY KEY(conv_key, lineage_id, block_id)
);

-- Tag-number and arc lookups for the bounded reads, and for the promotion,
-- burn and queue updates that already select parts by tag number.
CREATE INDEX mc_provider_policy_parts_tag
    ON mc_provider_policy_parts_v1(conv_key, json_extract(policy_json, '$.tag_number'));
CREATE INDEX mc_provider_policy_parts_arc
    ON mc_provider_policy_parts_v1(conv_key, json_extract(policy_json, '$.arc_id'));
CREATE INDEX mc_provider_policy_parts_unserved
    ON mc_provider_policy_parts_v1(conv_key) WHERE json_extract(policy_json, '$.served') = 0;
-- The newest surviving cadence transition and fire are looked up on every hook.
CREATE INDEX mc_provider_answers_cadence
    ON mc_provider_hook_answers_v1(conv_key, lineage_id, answer_seq)
    WHERE json_type(policy_json, '$.cadence_event') = 'object';
CREATE INDEX mc_provider_answers_cadence_fire
    ON mc_provider_hook_answers_v1(conv_key, lineage_id, answer_seq)
    WHERE json_extract(policy_json, '$.cadence_event.fire') = 1;

CREATE TRIGGER mc_provider_policy_parts_change_insert
AFTER INSERT ON mc_provider_policy_parts_v1
WHEN EXISTS (SELECT 1 FROM mc_provider_policy_summaries_v1 WHERE conv_key = NEW.conv_key)
BEGIN
    INSERT INTO mc_provider_policy_changes_v1
    SELECT NEW.conv_key, NEW.lineage_id, NEW.block_id, NULL, 0, NEW.session
    WHERE NOT EXISTS (SELECT 1 FROM mc_provider_policy_changes_v1 d
        WHERE d.conv_key = NEW.conv_key AND d.lineage_id = NEW.lineage_id
          AND d.block_id = NEW.block_id);
END;
CREATE TRIGGER mc_provider_policy_parts_change_update
AFTER UPDATE OF policy_json ON mc_provider_policy_parts_v1
WHEN EXISTS (SELECT 1 FROM mc_provider_policy_summaries_v1 WHERE conv_key = OLD.conv_key)
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
-- A deleted part cannot be subtracted incrementally: drop the summary instead.
CREATE TRIGGER mc_provider_policy_parts_change_delete
AFTER DELETE ON mc_provider_policy_parts_v1
BEGIN
    DELETE FROM mc_provider_policy_summaries_v1 WHERE conv_key = OLD.conv_key;
    DELETE FROM mc_provider_policy_changes_v1 WHERE conv_key = OLD.conv_key;
END;
-- Consuming a tag number deactivates every part carrying it.
CREATE TRIGGER mc_provider_consumed_tags_change
AFTER INSERT ON mc_provider_consumed_tags_v1
BEGIN
    INSERT INTO mc_provider_policy_changes_v1
    SELECT p.conv_key, p.lineage_id, p.block_id, p.policy_json, 0, p.session
    FROM mc_provider_conversations_v2 c
    JOIN mc_provider_policy_summaries_v1 s ON s.conv_key = c.conv_key
    JOIN mc_provider_policy_parts_v1 p ON p.conv_key = c.conv_key
        AND json_extract(p.policy_json, '$.tag_number') = NEW.tag_number
    WHERE c.engine_namespace = NEW.engine_namespace
      AND NOT EXISTS (SELECT 1 FROM mc_provider_policy_changes_v1 d
        WHERE d.conv_key = p.conv_key AND d.lineage_id = p.lineage_id
          AND d.block_id = p.block_id);
END;
CREATE TRIGGER mc_provider_conversations_policy_summary_delete
AFTER DELETE ON mc_provider_conversations_v2
BEGIN
    DELETE FROM mc_provider_policy_summaries_v1 WHERE conv_key = OLD.conv_key;
    DELETE FROM mc_provider_policy_changes_v1 WHERE conv_key = OLD.conv_key;
END;
