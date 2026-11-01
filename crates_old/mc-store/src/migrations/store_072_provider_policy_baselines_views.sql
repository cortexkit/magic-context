-- Native-host provider storage is an undeployed lane. Discard its old dev
-- projection rather than converting duplicated replacement bodies. A dev host
-- must discard its matching host-runner ledger and bootstrap model-visible rows
-- again; this module migration cannot rewrite a separate host database.
DELETE FROM mc_provider_policy_changes_v1 WHERE conv_key IN
    (SELECT conv_key FROM mc_provider_conversations_v2 WHERE harness IN ('opencode','opencode2'));
DELETE FROM mc_provider_policy_preparations_v1 WHERE conv_key IN
    (SELECT conv_key FROM mc_provider_conversations_v2 WHERE harness IN ('opencode','opencode2'));
DELETE FROM mc_provider_policy_summaries_v1 WHERE conv_key IN
    (SELECT conv_key FROM mc_provider_conversations_v2 WHERE harness IN ('opencode','opencode2'));
DELETE FROM mc_provider_policy_parts_v1 WHERE conv_key IN
    (SELECT conv_key FROM mc_provider_conversations_v2 WHERE harness IN ('opencode','opencode2'));
DELETE FROM mc_provider_hook_answers_v1 WHERE conv_key IN
    (SELECT conv_key FROM mc_provider_conversations_v2 WHERE harness IN ('opencode','opencode2'));
DELETE FROM mc_provider_legacy_tags_v1 WHERE conv_key IN
    (SELECT conv_key FROM mc_provider_conversations_v2 WHERE harness IN ('opencode','opencode2'));
DELETE FROM mc_provider_pending_drops_v1 WHERE conv_key IN
    (SELECT conv_key FROM mc_provider_conversations_v2 WHERE harness IN ('opencode','opencode2'));
DELETE FROM mc_provider_views_v1 WHERE conv_key IN
    (SELECT conv_key FROM mc_provider_conversations_v2 WHERE harness IN ('opencode','opencode2'));
DELETE FROM mc_provider_messages_v1 WHERE conv_key IN
    (SELECT conv_key FROM mc_provider_conversations_v2 WHERE harness IN ('opencode','opencode2'));
DELETE FROM mc_provider_lineages_v1 WHERE conv_key IN
    (SELECT conv_key FROM mc_provider_conversations_v2 WHERE harness IN ('opencode','opencode2'));
DELETE FROM mc_provider_conversations_v2 WHERE harness IN ('opencode','opencode2');
DELETE FROM mc_provider_sessions_v1 WHERE harness IN ('opencode','opencode2');

ALTER TABLE mc_provider_messages_v1 ADD COLUMN frozen_policy_format INTEGER NOT NULL DEFAULT 0
    CHECK(typeof(frozen_policy_format)='integer' AND frozen_policy_format IN (0,1));
ALTER TABLE mc_provider_messages_v1 ADD COLUMN frozen_policy_raw_bytes INTEGER NOT NULL DEFAULT 0
    CHECK(typeof(frozen_policy_raw_bytes)='integer' AND frozen_policy_raw_bytes>=0);
ALTER TABLE mc_provider_messages_v1 ADD COLUMN frozen_policy_parts INTEGER NOT NULL DEFAULT 0
    CHECK(typeof(frozen_policy_parts)='integer' AND frozen_policy_parts>=0);
-- These content-free facts belong to this immutable native message, not to a
-- resident checkpoint. Write them once when newly frozen. A later covered-tier
-- conversion/deletion must retire the facts with the native row; neither policy
-- nor view resolution may assume the facts outlive that source identity.
ALTER TABLE mc_provider_messages_v1 ADD COLUMN frozen_policy_bytes BLOB
    CHECK((frozen_policy_format=0 AND frozen_policy_bytes IS NULL
        AND frozen_policy_raw_bytes=0 AND frozen_policy_parts=0)
      OR (frozen_policy_format=1 AND typeof(frozen_policy_bytes)='blob'
        AND frozen_policy_raw_bytes>0 AND frozen_policy_parts>0));

CREATE TABLE mc_provider_policy_cuts_v1 (
    conv_key TEXT NOT NULL,
    cut_id INTEGER NOT NULL CHECK(typeof(cut_id)='integer' AND cut_id>=0),
    lineage_id TEXT NOT NULL,
    frozen_through_ordinal INTEGER CHECK(frozen_through_ordinal IS NULL OR
        (typeof(frozen_through_ordinal)='integer' AND frozen_through_ordinal>=0)),
    frozen_part_count INTEGER NOT NULL CHECK(typeof(frozen_part_count)='integer' AND frozen_part_count>=0),
    baseline_json TEXT NOT NULL CHECK(json_valid(baseline_json)),
    defaults_json TEXT NOT NULL CHECK(json_valid(defaults_json)),
    prefix_totals_json TEXT NOT NULL CHECK(json_valid(prefix_totals_json)),
    policy_key TEXT NOT NULL,
    session TEXT NOT NULL CHECK(session=json_extract(conv_key,'$[1]')),
    PRIMARY KEY(conv_key,cut_id),
    FOREIGN KEY(conv_key,lineage_id) REFERENCES mc_provider_lineages_v1(conv_key,lineage_id) ON DELETE CASCADE
);
CREATE INDEX mc_provider_policy_cuts_lineage
    ON mc_provider_policy_cuts_v1(conv_key,lineage_id,frozen_through_ordinal,cut_id);

-- Current exceptions, not before-images or a change journal. Complete effective
-- policy reads merge immutable message facts, cut defaults, these overrides and
-- live-tail rows; a raw tail-table read is not the whole conversation policy.
CREATE TABLE mc_provider_policy_overrides_v1 (
    conv_key TEXT NOT NULL,
    source_lineage_id TEXT NOT NULL,
    block_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK(typeof(ordinal)='integer' AND ordinal>=0),
    cut_id INTEGER NOT NULL CHECK(typeof(cut_id)='integer' AND cut_id>=0),
    override_json TEXT NOT NULL CHECK(json_valid(override_json)),
    session TEXT NOT NULL CHECK(session=json_extract(conv_key,'$[1]')),
    PRIMARY KEY(conv_key,source_lineage_id,block_id),
    FOREIGN KEY(conv_key,cut_id) REFERENCES mc_provider_policy_cuts_v1(conv_key,cut_id) ON DELETE CASCADE,
    FOREIGN KEY(conv_key,source_lineage_id,ordinal) REFERENCES mc_provider_messages_v1(conv_key,lineage_id,ordinal) ON DELETE CASCADE
);
CREATE INDEX mc_provider_policy_overrides_ordinal
    ON mc_provider_policy_overrides_v1(conv_key,source_lineage_id,ordinal);
CREATE INDEX mc_provider_policy_overrides_cut ON mc_provider_policy_overrides_v1(conv_key,cut_id);

-- A view is an immutable recipe over message identities and genuinely new
-- synthetic head/history bytes. Only its acknowledgement state may change.
-- The writer bounds inheritance at 16 levels / 8 MiB of ancestor recipe bytes,
-- re-rooting synthetic entries and effective treatments instead of copying
-- native history. Retention follows applied/produced/LKG/receipt roots.
CREATE TABLE mc_provider_views_v2 (
    conv_key TEXT NOT NULL,
    version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version>=0),
    lineage_id TEXT NOT NULL,
    range_from INTEGER NOT NULL CHECK(typeof(range_from)='integer' AND range_from>=0),
    range_to INTEGER NOT NULL CHECK(typeof(range_to)='integer' AND range_to>=range_from),
    base_version INTEGER CHECK(base_version IS NULL OR
        (typeof(base_version)='integer' AND base_version>=0 AND base_version<version)),
    policy_cut_id INTEGER NOT NULL,
    view_meta_json TEXT NOT NULL CHECK(json_valid(view_meta_json)),
    sequence_json TEXT NOT NULL CHECK(json_valid(sequence_json)),
    new_head_history_bytes BLOB,
    head_history_format INTEGER NOT NULL DEFAULT 1 CHECK(head_history_format=1),
    serializer_profile TEXT NOT NULL,
    render_key TEXT NOT NULL,
    tokenizer_key TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('produced','applied','not_applied','invalidated')),
    session TEXT NOT NULL CHECK(session=json_extract(conv_key,'$[1]')),
    PRIMARY KEY(conv_key,version),
    FOREIGN KEY(conv_key,base_version) REFERENCES mc_provider_views_v2(conv_key,version),
    FOREIGN KEY(conv_key,policy_cut_id) REFERENCES mc_provider_policy_cuts_v1(conv_key,cut_id),
    FOREIGN KEY(conv_key,lineage_id) REFERENCES mc_provider_lineages_v1(conv_key,lineage_id)
);
CREATE INDEX mc_provider_views_v2_state ON mc_provider_views_v2(conv_key,state,version);

CREATE TABLE mc_provider_view_overrides_v1 (
    conv_key TEXT NOT NULL,
    version INTEGER NOT NULL,
    source_lineage_id TEXT NOT NULL,
    mid TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK(typeof(ordinal)='integer' AND ordinal>=0),
    block_index INTEGER NOT NULL CHECK(typeof(block_index)='integer' AND block_index>=-1),
    block_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('set','reset')),
    patch_json TEXT CHECK(patch_json IS NULL OR json_valid(patch_json)),
    session TEXT NOT NULL CHECK(session=json_extract(conv_key,'$[1]')),
    PRIMARY KEY(conv_key,version,source_lineage_id,mid,block_index),
    CHECK((action='set' AND patch_json IS NOT NULL) OR (action='reset' AND patch_json IS NULL)),
    FOREIGN KEY(conv_key,version) REFERENCES mc_provider_views_v2(conv_key,version) ON DELETE CASCADE,
    FOREIGN KEY(conv_key,source_lineage_id,mid) REFERENCES mc_provider_messages_v1(conv_key,lineage_id,mid) ON DELETE CASCADE
);
CREATE INDEX mc_provider_view_overrides_source
    ON mc_provider_view_overrides_v1(conv_key,source_lineage_id,mid,version);

-- Immutable append admission makes the verified frontier reusable. A source
-- deletion invalidates it at the first affected ordinal, including direct dev
-- SQL deletes; readers must never hide a history gap behind a cached frontier.
CREATE TRIGGER mc_provider_native_delete_frontier
AFTER DELETE ON mc_provider_messages_v1
BEGIN
    UPDATE mc_provider_conversations_v2 SET cursor_frontier=min(cursor_frontier,OLD.ordinal)
    WHERE conv_key=OLD.conv_key AND cursor_frontier>OLD.ordinal;
END;
