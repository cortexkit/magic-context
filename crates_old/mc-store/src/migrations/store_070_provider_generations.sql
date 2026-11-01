-- Preserve legacy identities/bytes while allowing native generations of the same
-- canonical project/session/harness. Child ledgers already use conv_key and keep
-- session at JSON index 1; adding generation coordinates at indices 3/4 scopes
-- all of them without rewriting any message, answer, view or memory data.
DROP TRIGGER mc_provider_policy_parts_change_update;
DROP TRIGGER mc_provider_consumed_tags_change;
DROP TRIGGER mc_provider_consumed_tags_change_delete;
DROP TRIGGER mc_provider_consumed_tags_change_update;
DROP TRIGGER mc_provider_conversations_policy_namespace_change;
DROP TRIGGER mc_provider_conversations_policy_summary_delete;

CREATE TABLE mc_provider_conversations_70 (
    conv_key TEXT PRIMARY KEY,
    project_root TEXT NOT NULL,
    session TEXT NOT NULL,
    harness TEXT NOT NULL,
    lineage_id TEXT NOT NULL DEFAULT '',
    preset TEXT,
    params_json TEXT NOT NULL DEFAULT '{}',
    setup_json TEXT,
    engine_namespace TEXT NOT NULL,
    version_high_water INTEGER NOT NULL DEFAULT 0,
    rebuild_epoch INTEGER NOT NULL DEFAULT 0,
    hook_counters_json TEXT NOT NULL DEFAULT '{}',
    last_answer_json TEXT,
    wait_request TEXT,
    cursor_frontier INTEGER NOT NULL DEFAULT 0,
    served_through_ordinal INTEGER,
    historian_model_chain_json TEXT NOT NULL DEFAULT '[]',
    record_json TEXT NOT NULL DEFAULT '{}',
    legacy_shape_json TEXT NOT NULL DEFAULT '{}',
    profile_generation TEXT NOT NULL DEFAULT '',
    provider_generation TEXT NOT NULL DEFAULT '',
    native_pins_json TEXT,
    native_plan_json TEXT,
    UNIQUE(project_root, session, harness, profile_generation, provider_generation),
    CHECK((profile_generation = '') = (provider_generation = '')),
    CHECK(profile_generation = '' OR (json_valid(native_pins_json)
        AND json_valid(native_plan_json)
        AND json_extract(native_pins_json, '$.profile_generation') IS profile_generation
        AND json_extract(native_pins_json, '$.provider_generation') IS provider_generation)),
    CHECK(profile_generation = '' OR harness = 'claude-code'),
    CHECK(project_root IS json_extract(conv_key, '$[0]')
        AND session IS json_extract(conv_key, '$[1]')
        AND harness IS json_extract(conv_key, '$[2]')),
    CHECK((profile_generation = '' AND json_array_length(conv_key) = 3)
        OR (profile_generation <> '' AND json_array_length(conv_key) = 5
            AND profile_generation IS json_extract(conv_key, '$[3]')
            AND provider_generation IS json_extract(conv_key, '$[4]')))
);
INSERT INTO mc_provider_conversations_70
    (conv_key,project_root,session,harness,lineage_id,preset,params_json,setup_json,
     engine_namespace,version_high_water,rebuild_epoch,hook_counters_json,
     last_answer_json,wait_request,cursor_frontier,served_through_ordinal,
     historian_model_chain_json,record_json,legacy_shape_json)
SELECT conv_key,project_root,session,harness,lineage_id,preset,params_json,setup_json,
    engine_namespace,version_high_water,rebuild_epoch,hook_counters_json,
    last_answer_json,wait_request,cursor_frontier,served_through_ordinal,
    historian_model_chain_json,record_json,legacy_shape_json
FROM mc_provider_conversations_v2;
DROP TABLE mc_provider_conversations_v2;
ALTER TABLE mc_provider_conversations_70 RENAME TO mc_provider_conversations_v2;
CREATE INDEX mc_provider_conversations_session ON mc_provider_conversations_v2(session);
CREATE INDEX mc_provider_conversations_engine_namespace ON mc_provider_conversations_v2(engine_namespace);
CREATE TRIGGER mc_provider_native_contract_immutable
BEFORE UPDATE ON mc_provider_conversations_v2
WHEN OLD.profile_generation <> '' AND (
    OLD.conv_key IS NOT NEW.conv_key OR OLD.project_root IS NOT NEW.project_root
    OR OLD.session IS NOT NEW.session OR OLD.harness IS NOT NEW.harness
    OR OLD.profile_generation IS NOT NEW.profile_generation
    OR OLD.provider_generation IS NOT NEW.provider_generation
    OR OLD.engine_namespace IS NOT NEW.engine_namespace
    OR OLD.native_pins_json IS NOT NEW.native_pins_json
    OR OLD.native_plan_json IS NOT NEW.native_plan_json)
BEGIN
    SELECT RAISE(ABORT, 'native provider contract is immutable');
END;

-- Restore the v68 trigger definitions after rebuilding their referenced table.
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
CREATE TRIGGER mc_provider_consumed_tags_change_delete
AFTER DELETE ON mc_provider_consumed_tags_v1
BEGIN
    DELETE FROM mc_provider_policy_changes_v1 WHERE conv_key IN (SELECT conv_key
        FROM mc_provider_conversations_v2 WHERE engine_namespace = OLD.engine_namespace);
    DELETE FROM mc_provider_policy_summaries_v1 WHERE conv_key IN (SELECT conv_key
        FROM mc_provider_conversations_v2 WHERE engine_namespace = OLD.engine_namespace);
END;
CREATE TRIGGER mc_provider_consumed_tags_change_update
AFTER UPDATE ON mc_provider_consumed_tags_v1
BEGIN
    DELETE FROM mc_provider_policy_changes_v1 WHERE conv_key IN (SELECT conv_key
        FROM mc_provider_conversations_v2
        WHERE engine_namespace IN (OLD.engine_namespace, NEW.engine_namespace));
    DELETE FROM mc_provider_policy_summaries_v1 WHERE conv_key IN (SELECT conv_key
        FROM mc_provider_conversations_v2
        WHERE engine_namespace IN (OLD.engine_namespace, NEW.engine_namespace));
END;
CREATE TRIGGER mc_provider_conversations_policy_namespace_change
AFTER UPDATE OF engine_namespace ON mc_provider_conversations_v2
WHEN OLD.engine_namespace IS NOT NEW.engine_namespace
BEGIN
    DELETE FROM mc_provider_policy_summaries_v1 WHERE conv_key = OLD.conv_key;
    DELETE FROM mc_provider_policy_changes_v1 WHERE conv_key = OLD.conv_key;
END;
CREATE TRIGGER mc_provider_conversations_policy_summary_delete
AFTER DELETE ON mc_provider_conversations_v2
BEGIN
    DELETE FROM mc_provider_policy_summaries_v1 WHERE conv_key = OLD.conv_key;
    DELETE FROM mc_provider_policy_changes_v1 WHERE conv_key = OLD.conv_key;
END;
