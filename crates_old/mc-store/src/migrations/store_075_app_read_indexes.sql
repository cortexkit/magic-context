CREATE INDEX idx_mc_async_compaction_session ON mc_async_compaction(session);

-- Keep the runner message identity beside the held entry so a transcript window
-- can find its rows without decoding every entry in the conversation.
ALTER TABLE mc_async_compaction_entries ADD COLUMN mid TEXT;
UPDATE mc_async_compaction_entries
SET mid = CASE WHEN json_valid(entry_json)
    THEN json_extract(entry_json, '$.mid') END;
CREATE INDEX idx_mc_async_compaction_entries_mid
    ON mc_async_compaction_entries(session_ref, mid);
