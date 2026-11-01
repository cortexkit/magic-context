-- Connection-local compatibility for inspection and the cold archive queries.
-- Persistent tables and their foreign keys remain unchanged.
-- Envelope payloads are JSON strings, even when an inspection UPDATE uses a
-- JSON function. Concatenating an empty string clears SQLite's JSON subtype so
-- json_object/json_set cannot silently embed the payload as an object instead.
CREATE TEMP VIEW IF NOT EXISTS mc_async_compaction AS
SELECT * FROM main.mc_async_compaction
UNION ALL
SELECT h.section,
       json_extract(h.body,'$.key'),json_extract(h.body,'$.session'),
       json_extract(h.body,'$.state_json'),json_extract(h.body,'$.version_high_water')
FROM main.mc_cache_sections h
WHERE h.session_id='__ckmc_async_v2_headers'
  AND NOT EXISTS(SELECT 1 FROM main.mc_async_compaction old WHERE old.session_ref=h.section);

CREATE TEMP VIEW IF NOT EXISTS mc_async_compaction_entries AS
SELECT * FROM main.mc_async_compaction_entries
UNION ALL
SELECT h.section,json_extract(h.body,'$.session'),json_extract(e.body,'$.ordinal'),
       json_extract(e.body,'$.entry_json'),json_extract(e.body,'$.index_json'),json_extract(e.body,'$.mid')
FROM main.mc_cache_sections h
JOIN main.mc_cache_sections e ON e.session_id='__ckmc_async_v2_record:'||h.section
WHERE h.session_id='__ckmc_async_v2_headers' AND e.section GLOB '__ckmc_async_v2_entry:*'
  AND NOT EXISTS(SELECT 1 FROM main.mc_async_compaction old WHERE old.session_ref=h.section);

CREATE TEMP VIEW IF NOT EXISTS mc_async_compaction_views AS
SELECT * FROM main.mc_async_compaction_views
UNION ALL
SELECT h.section,json_extract(h.body,'$.session'),json_extract(v.body,'$.version'),
       json_extract(v.body,'$.view_json'),json_extract(v.body,'$.engine_json'),json_extract(v.body,'$.announced')
FROM main.mc_cache_sections h
JOIN main.mc_cache_sections v ON v.session_id='__ckmc_async_v2_record:'||h.section
WHERE h.session_id='__ckmc_async_v2_headers' AND v.section GLOB '__ckmc_async_v2_view:*'
  AND NOT EXISTS(SELECT 1 FROM main.mc_async_compaction old WHERE old.session_ref=h.section);

CREATE TEMP VIEW IF NOT EXISTS mc_async_compaction_baselines AS
SELECT * FROM main.mc_async_compaction_baselines
UNION ALL
SELECT h.section,json_extract(h.body,'$.session'),b.section,b.body
FROM main.mc_cache_sections h
JOIN main.mc_cache_sections b ON b.session_id='__ckmc_async_v2_record:'||h.section
WHERE h.session_id='__ckmc_async_v2_headers' AND b.section NOT GLOB '__ckmc_async_v2_*'
  AND NOT EXISTS(SELECT 1 FROM main.mc_async_compaction old WHERE old.session_ref=h.section);

CREATE TEMP TRIGGER IF NOT EXISTS mc_async_v2_inspect_header_update
INSTEAD OF UPDATE ON mc_async_compaction BEGIN
 UPDATE mc_cache_sections
 SET body=json_set(body,'$.state_json',NEW.state_json||'','$.version_high_water',NEW.version_high_water)
 WHERE session_id='__ckmc_async_v2_headers' AND section=OLD.session_ref;
END;

CREATE TEMP TRIGGER IF NOT EXISTS mc_async_v2_inspect_header_insert
INSTEAD OF INSERT ON mc_async_compaction BEGIN
 SELECT CASE WHEN NEW.session_ref IS NULL OR NEW.conversation_key IS NULL OR NEW.session IS NULL OR NEW.state_json||'' IS NULL THEN RAISE(ABORT,'null async header') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM mc_cache_sections WHERE session_id='__ckmc_async_v2_keys' AND section=NEW.conversation_key AND json_extract(body,'$.reference')<>NEW.session_ref) THEN RAISE(ABORT,'async conversation key collision') END;
 INSERT INTO mc_cache_sections(session_id,section,body)
 VALUES('__ckmc_async_v2_headers',NEW.session_ref,json_object('key',NEW.conversation_key||'','session',NEW.session,'state_json',NEW.state_json||'','version_high_water',coalesce(NEW.version_high_water,0)))
 ON CONFLICT(session_id,section) DO UPDATE SET body=excluded.body;
 INSERT OR IGNORE INTO mc_cache_sections(session_id,section,body)
 VALUES('__ckmc_async_v2_keys',NEW.conversation_key,json_object('reference',NEW.session_ref,'session',NEW.session));
END;
CREATE TEMP TRIGGER IF NOT EXISTS mc_async_v2_inspect_header_delete
INSTEAD OF DELETE ON mc_async_compaction BEGIN
 DELETE FROM mc_cache_sections WHERE session_id='__ckmc_async_v2_record:'||OLD.session_ref;
 DELETE FROM mc_cache_sections WHERE session_id='__ckmc_async_v2_keys' AND section=OLD.conversation_key;
 DELETE FROM mc_cache_sections WHERE session_id='__ckmc_async_v2_outbox' AND section>=json_quote(OLD.session_ref)||':' AND section<json_quote(OLD.session_ref)||';';
 DELETE FROM mc_cache_sections WHERE session_id='__ckmc_async_v2_headers' AND section=OLD.session_ref;
END;

CREATE TEMP TRIGGER IF NOT EXISTS mc_async_v2_inspect_baseline_update
INSTEAD OF UPDATE ON mc_async_compaction_baselines BEGIN
 UPDATE mc_cache_sections SET body=NEW.view_json||''
 WHERE session_id='__ckmc_async_v2_record:'||OLD.session_ref AND section=OLD.slot;
END;
CREATE TEMP TRIGGER IF NOT EXISTS mc_async_v2_inspect_baseline_insert
INSTEAD OF INSERT ON mc_async_compaction_baselines BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mc_cache_sections WHERE session_id='__ckmc_async_v2_headers' AND section=NEW.session_ref) THEN RAISE(ABORT,'async header missing') END;
 INSERT INTO mc_cache_sections(session_id,section,body)
 VALUES('__ckmc_async_v2_record:'||NEW.session_ref,NEW.slot,NEW.view_json||'');
END;
CREATE TEMP TRIGGER IF NOT EXISTS mc_async_v2_inspect_baseline_delete
INSTEAD OF DELETE ON mc_async_compaction_baselines BEGIN
 DELETE FROM mc_cache_sections
 WHERE session_id='__ckmc_async_v2_record:'||OLD.session_ref AND section=OLD.slot;
END;

CREATE TEMP TRIGGER IF NOT EXISTS mc_async_v2_inspect_entry_insert
INSTEAD OF INSERT ON mc_async_compaction_entries BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mc_cache_sections WHERE session_id='__ckmc_async_v2_headers' AND section=NEW.session_ref) THEN RAISE(ABORT,'async header missing') END;
 INSERT INTO mc_cache_sections(session_id,section,body)
 VALUES('__ckmc_async_v2_record:'||NEW.session_ref,'__ckmc_async_v2_entry:'||printf('%020d',NEW.ordinal),json_object('ordinal',NEW.ordinal,'entry_json',NEW.entry_json||'','index_json',NEW.index_json||'','mid',NEW.mid));
 INSERT INTO mc_cache_sections(session_id,section,body)
 SELECT '__ckmc_async_v2_record:'||NEW.session_ref,'__ckmc_async_v2_mid:'||json_quote(NEW.mid)||':'||printf('%020d',NEW.ordinal),json_quote('__ckmc_async_v2_entry:'||printf('%020d',NEW.ordinal))
 WHERE NEW.mid IS NOT NULL;
END;

CREATE TEMP TRIGGER IF NOT EXISTS mc_async_v2_inspect_entry_update
INSTEAD OF UPDATE ON mc_async_compaction_entries BEGIN
 UPDATE mc_cache_sections SET body=json_object('ordinal',NEW.ordinal,'entry_json',NEW.entry_json||'','index_json',NEW.index_json||'','mid',NEW.mid)
 WHERE session_id='__ckmc_async_v2_record:'||OLD.session_ref AND section='__ckmc_async_v2_entry:'||printf('%020d',OLD.ordinal);
 DELETE FROM mc_cache_sections
 WHERE session_id='__ckmc_async_v2_record:'||OLD.session_ref AND section='__ckmc_async_v2_mid:'||json_quote(OLD.mid)||':'||printf('%020d',OLD.ordinal);
 INSERT OR REPLACE INTO mc_cache_sections(session_id,section,body)
 SELECT '__ckmc_async_v2_record:'||NEW.session_ref,'__ckmc_async_v2_mid:'||json_quote(NEW.mid)||':'||printf('%020d',NEW.ordinal),json_quote('__ckmc_async_v2_entry:'||printf('%020d',NEW.ordinal))
 WHERE NEW.mid IS NOT NULL;
 UPDATE mc_cache_sections
 SET body=CASE WHEN json_valid(json_extract(body,'$.state_json')) THEN json_set(body,'$.state_json',json_set(json_extract(body,'$.state_json'),'$.input_revision',CASE WHEN json_type(json_extract(body,'$.state_json'),'$.input_revision')='integer' AND json_extract(json_extract(body,'$.state_json'),'$.input_revision')>=0 AND json_extract(json_extract(body,'$.state_json'),'$.input_revision')<9223372036854775807 THEN json_extract(json_extract(body,'$.state_json'),'$.input_revision')+1 END)||'') ELSE body END
 WHERE session_id='__ckmc_async_v2_headers' AND section=OLD.session_ref;
END;
CREATE TEMP TRIGGER IF NOT EXISTS mc_async_v2_inspect_view_insert
INSTEAD OF INSERT ON mc_async_compaction_views BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM mc_cache_sections WHERE session_id='__ckmc_async_v2_headers' AND section=NEW.session_ref) THEN RAISE(ABORT,'async header missing') END;
 INSERT INTO mc_cache_sections(session_id,section,body)
 VALUES('__ckmc_async_v2_record:'||NEW.session_ref,'__ckmc_async_v2_view:'||printf('%020d',NEW.version),json_object('version',NEW.version,'view_json',NEW.view_json||'','engine_json',NEW.engine_json||'','announced',coalesce(NEW.announced,0)));
 INSERT OR REPLACE INTO mc_cache_sections(session_id,section,body)
 SELECT '__ckmc_async_v2_outbox',json_quote(NEW.session_ref)||':'||printf('%020d',NEW.version),json_object('reference',NEW.session_ref,'version',NEW.version,'session',NEW.session)
 WHERE coalesce(NEW.announced,0)=0;
END;
CREATE TEMP TRIGGER IF NOT EXISTS mc_async_v2_inspect_entry_delete
INSTEAD OF DELETE ON mc_async_compaction_entries BEGIN
 DELETE FROM mc_cache_sections
 WHERE session_id='__ckmc_async_v2_record:'||OLD.session_ref AND section='__ckmc_async_v2_entry:'||printf('%020d',OLD.ordinal);
 DELETE FROM mc_cache_sections
 WHERE session_id='__ckmc_async_v2_record:'||OLD.session_ref AND section='__ckmc_async_v2_mid:'||json_quote(OLD.mid)||':'||printf('%020d',OLD.ordinal);
 UPDATE mc_cache_sections
 SET body=CASE WHEN json_valid(json_extract(body,'$.state_json')) THEN json_set(body,'$.state_json',json_set(json_extract(body,'$.state_json'),'$.input_revision',CASE WHEN json_type(json_extract(body,'$.state_json'),'$.input_revision')='integer' AND json_extract(json_extract(body,'$.state_json'),'$.input_revision')>=0 AND json_extract(json_extract(body,'$.state_json'),'$.input_revision')<9223372036854775807 THEN json_extract(json_extract(body,'$.state_json'),'$.input_revision')+1 END)||'') ELSE body END
 WHERE session_id='__ckmc_async_v2_headers' AND section=OLD.session_ref;
END;

CREATE TEMP TRIGGER IF NOT EXISTS mc_async_v2_inspect_view_update
INSTEAD OF UPDATE ON mc_async_compaction_views BEGIN
 UPDATE mc_cache_sections SET body=json_object('version',NEW.version,'view_json',NEW.view_json||'','engine_json',NEW.engine_json||'','announced',NEW.announced)
 WHERE session_id='__ckmc_async_v2_record:'||OLD.session_ref AND section='__ckmc_async_v2_view:'||printf('%020d',OLD.version);
 DELETE FROM mc_cache_sections
 WHERE session_id='__ckmc_async_v2_outbox' AND section=json_quote(OLD.session_ref)||':'||printf('%020d',OLD.version);
 INSERT OR REPLACE INTO mc_cache_sections(session_id,section,body)
 SELECT '__ckmc_async_v2_outbox',json_quote(NEW.session_ref)||':'||printf('%020d',NEW.version),json_object('reference',NEW.session_ref,'version',NEW.version,'session',NEW.session)
 WHERE NEW.announced=0;
END;
CREATE TEMP TRIGGER IF NOT EXISTS mc_async_v2_inspect_view_delete
INSTEAD OF DELETE ON mc_async_compaction_views BEGIN
 DELETE FROM mc_cache_sections WHERE session_id='__ckmc_async_v2_record:'||OLD.session_ref AND section='__ckmc_async_v2_view:'||printf('%020d',OLD.version);
 DELETE FROM mc_cache_sections WHERE session_id='__ckmc_async_v2_outbox' AND section=json_quote(OLD.session_ref)||':'||printf('%020d',OLD.version);
END;
