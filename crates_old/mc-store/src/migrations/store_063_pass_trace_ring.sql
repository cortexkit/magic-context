-- 5. Pass-trace histories as ring rows. The sequence orders entries; the slot only bounds
--    storage, so readers order by seq and never by slot. The request history lives today in a
--    carrier entry inside scheduler_interesting_history; only the newest carrier counts,
--    as in pass_trace_meta_parts.
CREATE TABLE mc_pass_trace_history (
    session_id TEXT    NOT NULL,
    kind       TEXT    NOT NULL,   -- 'scheduler' | 'interesting' | 'request'
    slot       INTEGER NOT NULL,   -- seq % 256, or seq % 32 for 'request'
    seq        INTEGER NOT NULL,
    entry      TEXT    NOT NULL,
    PRIMARY KEY (session_id, kind, slot)
);
INSERT INTO mc_pass_trace_history (session_id, kind, slot, seq, entry)
SELECT t.session_id, 'scheduler', e.key % 256, e.key, json(e.value)
  FROM mc_pass_trace AS t, json_each(t.scheduler_history) AS e;
INSERT INTO mc_pass_trace_history (session_id, kind, slot, seq, entry)
SELECT t.session_id, 'interesting', e.key % 256, e.key, json(e.value)
  FROM mc_pass_trace AS t, json_each(t.scheduler_interesting_history) AS e
 WHERE json_extract(e.value, '$.scheduler_decision') IS NOT '__request_trace_history__';
INSERT INTO mc_pass_trace_history (session_id, kind, slot, seq, entry)
SELECT t.session_id, 'request', r.key % 32, r.key, json(r.value)
  FROM mc_pass_trace AS t, json_each(t.scheduler_interesting_history) AS c,
       json_each(c.value, '$.request_history') AS r
 WHERE c.key = (SELECT MAX(c2.key) FROM json_each(t.scheduler_interesting_history) AS c2
                 WHERE json_extract(c2.value, '$.scheduler_decision') = '__request_trace_history__');
ALTER TABLE mc_pass_trace ADD COLUMN scheduler_next_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mc_pass_trace ADD COLUMN interesting_next_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mc_pass_trace ADD COLUMN request_next_seq INTEGER NOT NULL DEFAULT 0;
UPDATE mc_pass_trace SET
    scheduler_next_seq = COALESCE(json_array_length(scheduler_history), 0),
    interesting_next_seq = COALESCE(json_array_length(scheduler_interesting_history), 0),
    request_next_seq = COALESCE((SELECT MAX(seq) + 1 FROM mc_pass_trace_history AS h
                                  WHERE h.session_id = mc_pass_trace.session_id
                                    AND h.kind = 'request'), 0);
-- Dropping the array columns makes a reader that names them fail loudly instead of reading
-- a frozen copy. Readers that select * must move to the view below.
ALTER TABLE mc_pass_trace DROP COLUMN scheduler_history;
ALTER TABLE mc_pass_trace DROP COLUMN scheduler_interesting_history;
CREATE VIEW mc_pass_trace_history_arrays AS
SELECT t.session_id,
       (SELECT json_group_array(json(h.entry) ORDER BY h.seq) FROM mc_pass_trace_history AS h
         WHERE h.session_id = t.session_id AND h.kind = 'scheduler') AS scheduler_history,
       (SELECT json_group_array(json(h.entry) ORDER BY h.seq) FROM mc_pass_trace_history AS h
         WHERE h.session_id = t.session_id AND h.kind = 'interesting') AS scheduler_interesting_history,
       (SELECT json_group_array(json(h.entry) ORDER BY h.seq) FROM mc_pass_trace_history AS h
         WHERE h.session_id = t.session_id AND h.kind = 'request') AS request_history
  FROM mc_pass_trace AS t;
