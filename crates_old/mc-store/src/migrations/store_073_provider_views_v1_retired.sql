-- Broca runner and Claude Code views now persist as mc_provider_views_v2
-- recipes, and Pi host views move to the whole-copy Pi recipe lane, which also
-- lives in mc_provider_views_v2. Nothing reads or writes mc_provider_views_v1
-- any longer.
--
-- Reason for discarding rather than converting: no released build ever created
-- this table. Every release tag through v0.49.8 ships store migrations up to 63,
-- and mc_provider_views_v1 first appears in migration 66, so its rows can only
-- come from unreleased development builds. A v1 row holds a whole engine and
-- wire copy of a view; rebuilding a recipe from it would mean decoding host
-- bytes the module never validated as recipe sources. Instead, reset exactly the
-- conversations that own a v1 row, as migration 72 did for OpenCode. A dev host
-- must also discard its matching host-runner ledger and bootstrap again; this
-- module migration cannot rewrite a separate host database.
DELETE FROM mc_provider_sessions_v1 WHERE EXISTS (
    SELECT 1 FROM mc_provider_conversations_v2 c
    WHERE c.project_root=mc_provider_sessions_v1.project_root
      AND c.session=mc_provider_sessions_v1.session
      AND c.harness=mc_provider_sessions_v1.harness
      AND c.conv_key IN (SELECT conv_key FROM mc_provider_views_v1));
DELETE FROM mc_provider_policy_changes_v1 WHERE conv_key IN (SELECT conv_key FROM mc_provider_views_v1);
DELETE FROM mc_provider_policy_preparations_v1 WHERE conv_key IN (SELECT conv_key FROM mc_provider_views_v1);
DELETE FROM mc_provider_policy_summaries_v1 WHERE conv_key IN (SELECT conv_key FROM mc_provider_views_v1);
DELETE FROM mc_provider_policy_parts_v1 WHERE conv_key IN (SELECT conv_key FROM mc_provider_views_v1);
DELETE FROM mc_provider_hook_answers_v1 WHERE conv_key IN (SELECT conv_key FROM mc_provider_views_v1);
DELETE FROM mc_provider_legacy_tags_v1 WHERE conv_key IN (SELECT conv_key FROM mc_provider_views_v1);
DELETE FROM mc_provider_pending_drops_v1 WHERE conv_key IN (SELECT conv_key FROM mc_provider_views_v1);
DELETE FROM mc_provider_view_overrides_v1 WHERE conv_key IN (SELECT conv_key FROM mc_provider_views_v1);
DELETE FROM mc_provider_views_v2 WHERE conv_key IN (SELECT conv_key FROM mc_provider_views_v1);
DELETE FROM mc_provider_policy_overrides_v1 WHERE conv_key IN (SELECT conv_key FROM mc_provider_views_v1);
DELETE FROM mc_provider_policy_cuts_v1 WHERE conv_key IN (SELECT conv_key FROM mc_provider_views_v1);
DELETE FROM mc_provider_messages_v1 WHERE conv_key IN (SELECT conv_key FROM mc_provider_views_v1);
DELETE FROM mc_provider_lineages_v1 WHERE conv_key IN (SELECT conv_key FROM mc_provider_views_v1);
DELETE FROM mc_provider_conversations_v2 WHERE conv_key IN (SELECT conv_key FROM mc_provider_views_v1);
DROP TABLE mc_provider_views_v1;
