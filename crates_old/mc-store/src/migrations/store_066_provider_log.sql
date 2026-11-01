-- The v65 payload is retained as a read-only rollback artifact. The schema fence
-- prevents an older binary from serving it after normalized writes have begun.
CREATE TABLE mc_provider_conversations_v2 (
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
    UNIQUE(project_root, session, harness)
);
CREATE INDEX mc_provider_conversations_session ON mc_provider_conversations_v2(session);
CREATE INDEX mc_provider_conversations_engine_namespace ON mc_provider_conversations_v2(engine_namespace);

CREATE TABLE mc_provider_lineages_v1 (
    conv_key TEXT NOT NULL,
    lineage_id TEXT NOT NULL,
    first_ordinal INTEGER NOT NULL CHECK(first_ordinal >= 0),
    descends_from TEXT,
    through_ordinal INTEGER,
    session TEXT NOT NULL CHECK(session = json_extract(conv_key, '$[1]')),
    PRIMARY KEY(conv_key, lineage_id),
    CHECK((descends_from IS NULL) = (through_ordinal IS NULL))
);
CREATE TABLE mc_provider_messages_v1 (
    conv_key TEXT NOT NULL,
    lineage_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
    mid TEXT NOT NULL,
    message_bytes BLOB NOT NULL,
    session TEXT NOT NULL CHECK(session = json_extract(conv_key, '$[1]')),
    PRIMARY KEY(conv_key, lineage_id, ordinal),
    UNIQUE(conv_key, lineage_id, mid)
);
CREATE TABLE mc_provider_hook_answers_v1 (
    conv_key TEXT NOT NULL,
    answer_seq INTEGER NOT NULL,
    lineage_id TEXT NOT NULL,
    subject_mid TEXT NOT NULL,
    hook TEXT NOT NULL,
    subject_part TEXT NOT NULL DEFAULT '',
    ordinal INTEGER,
    ops_json TEXT NOT NULL,
    tags_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending', 'live', 'burned')),
    legacy_json TEXT,
    policy_json TEXT NOT NULL DEFAULT '{}',
    session TEXT NOT NULL CHECK(session = json_extract(conv_key, '$[1]')),
    PRIMARY KEY(conv_key, answer_seq)
);
CREATE INDEX mc_provider_answers_subject ON mc_provider_hook_answers_v1
    (conv_key, lineage_id, subject_mid, hook, subject_part, state);
CREATE INDEX mc_provider_answers_pending ON mc_provider_hook_answers_v1(conv_key, lineage_id, state, ordinal);
-- Admission-time policy metadata, never transcript or operation content. Keeping
-- it with the lineage makes protection, time and sibling releases restart-safe.
CREATE TABLE mc_provider_policy_parts_v1 (
    conv_key TEXT NOT NULL,
    lineage_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    block_id TEXT NOT NULL,
    policy_json TEXT NOT NULL,
    session TEXT NOT NULL CHECK(session = json_extract(conv_key, '$[1]')),
    PRIMARY KEY(conv_key, lineage_id, block_id)
);
CREATE INDEX mc_provider_policy_parts_ordinal ON mc_provider_policy_parts_v1(conv_key,lineage_id,ordinal);
CREATE INDEX mc_provider_policy_parts_identity ON mc_provider_policy_parts_v1(conv_key,block_id);
CREATE TABLE mc_provider_views_v1 (
    conv_key TEXT NOT NULL,
    version INTEGER NOT NULL,
    lineage_id TEXT NOT NULL,
    range_from INTEGER NOT NULL,
    range_to INTEGER NOT NULL,
    replacement_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('produced', 'applied', 'not_applied')),
    view_json TEXT NOT NULL,
    session TEXT NOT NULL CHECK(session = json_extract(conv_key, '$[1]')),
    PRIMARY KEY(conv_key, version)
);
-- These rows retain the older observation lane without putting growing maps back
-- into the conversation row. Host answers use tags_json and mc_tags instead.
CREATE TABLE mc_provider_legacy_tags_v1 (
    conv_key TEXT NOT NULL,
    tag_number INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('live', 'burned')),
    tag_json TEXT,
    session TEXT NOT NULL CHECK(session = json_extract(conv_key, '$[1]')),
    PRIMARY KEY(conv_key, tag_number, state)
);
CREATE TABLE mc_provider_pending_drops_v1 (
    conv_key TEXT NOT NULL,
    tag_number INTEGER NOT NULL,
    session TEXT NOT NULL CHECK(session = json_extract(conv_key, '$[1]')),
    PRIMARY KEY(conv_key, tag_number)
);
-- A release belongs to the engine's number space, not to a transport answer.
-- Replaying that answer cannot make an already consumed number actionable.
CREATE TABLE mc_provider_consumed_tags_v1 (
    engine_namespace TEXT NOT NULL,
    tag_number INTEGER NOT NULL,
    session TEXT NOT NULL,
    PRIMARY KEY(engine_namespace,tag_number)
);

INSERT INTO mc_provider_conversations_v2
    (conv_key, project_root, session, harness, lineage_id, preset, params_json,
     setup_json, engine_namespace, version_high_water, rebuild_epoch,
     hook_counters_json, last_answer_json, wait_request, record_json, legacy_shape_json)
SELECT json_array(project_root, session, harness), project_root, session, harness,
    coalesce(json_extract(record, '$.setup.request.lineage_id'), ''),
    json_extract(record, '$.setup.state.preset'),
    coalesce(json_extract(record, '$.setup.request.params'), '{}'),
    json_remove(json_extract(record, '$.setup'), '$.state.last_produced', '$.state.last_applied'),
    mc_provider_engine_namespace(project_root, session, harness),
    coalesce(json_extract(record, '$.setup.state.version_high_water'), 0),
    coalesce(json_extract(record, '$.setup.state.rebuild_epoch'), 0),
    coalesce(json_remove(json_extract(record, '$.hook'), '$.answers', '$.live', '$.burned'), '{}'),
    json_extract(record, '$.last_answer'), json_extract(record, '$.wait_request'),
    json_remove(record, '$.messages', '$.pending_drops', '$.hook.answers', '$.hook.live', '$.hook.burned',
        '$.setup.state.last_produced', '$.setup.state.last_applied', '$.wait_view'),
    json_object('messages', json_type(record, '$.messages') IS NOT NULL,
        'pending_drops', json_type(record, '$.pending_drops') IS NOT NULL,
        'answers', json_type(record, '$.hook.answers') IS NOT NULL,
        'live', json_type(record, '$.hook.live') IS NOT NULL,
        'burned', json_type(record, '$.hook.burned') IS NOT NULL,
        'last_produced', json_type(record, '$.setup.state.last_produced') IS NOT NULL,
        'last_applied', json_type(record, '$.setup.state.last_applied') IS NOT NULL,
        'wait_view', json_type(record, '$.wait_view') IS NOT NULL,
        'produced_version', json_extract(record, '$.setup.state.last_produced.version'),
        'applied_version', json_extract(record, '$.setup.state.last_applied.version'),
        'wait_version', json_extract(record, '$.wait_view.version'))
FROM mc_provider_sessions_v1;

INSERT INTO mc_provider_lineages_v1(conv_key, lineage_id, first_ordinal, session)
SELECT c.conv_key, l.key, coalesce((SELECT min(CAST(m.key AS INTEGER)) FROM json_each(l.value) m), 0), s.session
FROM mc_provider_conversations_v2 c
JOIN mc_provider_sessions_v1 s USING(project_root, session, harness), json_each(s.record, '$.messages') l;
INSERT INTO mc_provider_messages_v1
SELECT c.conv_key, l.key, CAST(m.key AS INTEGER), json_extract(m.value, '$.mid'),
    CAST(json_extract(m.value, '$.message') AS BLOB), s.session
FROM mc_provider_conversations_v2 c
JOIN mc_provider_sessions_v1 s USING(project_root, session, harness),
    json_each(s.record, '$.messages') l, json_each(l.value) m;
INSERT INTO mc_provider_hook_answers_v1
    (conv_key, answer_seq, lineage_id, subject_mid, hook, subject_part, ordinal,
     ops_json, tags_json, state, legacy_json, session)
SELECT c.conv_key, CAST(a.key AS INTEGER), coalesce(json_extract(a.value, '$.lineage'), ''),
    json_extract(a.value, '$.subject'), 'legacy', CAST(a.key AS TEXT), NULL,
    json_extract(a.value, '$.answer'), json_extract(a.value, '$.tags'),
    CASE WHEN json_extract(a.value, '$.observed') THEN 'live'
         WHEN EXISTS(SELECT 1 FROM json_each(a.value, '$.tags') t
            JOIN json_each(s.record, '$.hook.burned') b ON b.value=t.value) THEN 'burned'
         ELSE 'pending' END, a.value, s.session
FROM mc_provider_conversations_v2 c
JOIN mc_provider_sessions_v1 s USING(project_root, session, harness), json_each(s.record, '$.hook.answers') a;
INSERT INTO mc_provider_legacy_tags_v1
SELECT c.conv_key, CAST(t.key AS INTEGER), 'live', t.value, s.session
FROM mc_provider_conversations_v2 c
JOIN mc_provider_sessions_v1 s USING(project_root, session, harness), json_each(s.record, '$.hook.live') t;
INSERT INTO mc_provider_legacy_tags_v1
SELECT c.conv_key, t.value, 'burned', NULL, s.session
FROM mc_provider_conversations_v2 c
JOIN mc_provider_sessions_v1 s USING(project_root, session, harness), json_each(s.record, '$.hook.burned') t;
INSERT INTO mc_provider_pending_drops_v1
SELECT c.conv_key, d.value, s.session FROM mc_provider_conversations_v2 c
JOIN mc_provider_sessions_v1 s USING(project_root, session, harness), json_each(s.record, '$.pending_drops') d;
INSERT INTO mc_provider_views_v1
SELECT c.conv_key, json_extract(v.value, '$.version'), json_extract(v.value, '$.range.lineage_id'),
    json_extract(v.value, '$.range.from'), json_extract(v.value, '$.range.to'),
    json_extract(v.value, '$.replacement'),
    CASE WHEN v.key='last_applied' THEN 'applied' ELSE 'produced' END, v.value, s.session
FROM mc_provider_conversations_v2 c
JOIN mc_provider_sessions_v1 s USING(project_root, session, harness), json_each(s.record, '$.setup.state') v
WHERE v.key IN ('last_produced', 'last_applied') AND v.type='object'
ON CONFLICT(conv_key, version) DO UPDATE SET state='applied';
INSERT INTO mc_provider_views_v1
SELECT c.conv_key, json_extract(s.record, '$.wait_view.version'), json_extract(s.record, '$.wait_view.range.lineage_id'),
    json_extract(s.record, '$.wait_view.range.from'), json_extract(s.record, '$.wait_view.range.to'),
    json_extract(s.record, '$.wait_view.replacement'), 'produced', json_extract(s.record, '$.wait_view'), s.session
FROM mc_provider_conversations_v2 c
JOIN mc_provider_sessions_v1 s USING(project_root, session, harness)
WHERE json_type(s.record, '$.wait_view')='object'
ON CONFLICT(conv_key, version) DO NOTHING;
