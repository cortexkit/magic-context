-- A standalone head with 25,000 messages, ten parts per message, and a long
-- summarized prefix. Pending drops include duplicate operations, hidden parts,
-- tool parts, file parts, inactive tags, and unsummarized text parts.
BEGIN;
INSERT INTO session_meta(session_id,harness,last_input_tokens,new_work_tokens)
VALUES ('large-head','opencode',180000,12000);

WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<250000)
INSERT INTO tags(session_id,message_id,type,status,tag_number,tool_name,tool_owner_message_id,harness)
SELECT 'large-head',
       CASE WHEN i%10=3 THEN 'call_'||i ELSE 'm'||((i-1)/10+1)||':p'||((i-1)%10) END,
       CASE WHEN i%10=3 THEN 'tool' WHEN i%10=4 THEN 'file' ELSE 'message' END,
       CASE WHEN i%10=9 THEN 'dropped' WHEN i%10=0 THEN 'compacted' ELSE 'active' END,
       i, CASE WHEN i%10=3 THEN 'read' END,
       CASE WHEN i%10=3 THEN 'm'||((i-1)/10+1) END, 'opencode'
FROM n;

WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<25000)
INSERT INTO message_history_source(session_id,message_id,message_ordinal,source_version,normalized_content_hash,role,harness,updated_at)
SELECT 'large-head','m'||i,i,'v1','hash-'||i,'assistant','opencode',1700000000000 FROM n;

WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<3000)
INSERT INTO compartments(session_id,sequence,start_message,end_message,title,content,created_at,harness)
SELECT 'large-head',i,(i-1)*4+2,i*4+1,'summary '||i,'summary',1700000000000+i,'opencode'
FROM n;
UPDATE compartments SET end_block_index=1 WHERE session_id='large-head' AND sequence=3000;

WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<300)
INSERT INTO pending_ops(session_id,tag_id,operation,queued_at)
SELECT 'large-head',
       CASE WHEN i<=100 THEN i*10+1 ELSE (12000+i)*10+1+(i%4) END,
       CASE WHEN i%17=0 THEN 'other' ELSE 'drop' END,1700000100000+i
FROM n;
INSERT INTO pending_ops(session_id,tag_id,operation,queued_at)
SELECT session_id,tag_id,operation,queued_at+1000 FROM pending_ops WHERE id%10=0;
INSERT INTO pending_ops(session_id,tag_id,operation,queued_at)
VALUES ('large-head',1,'drop',1700000200000),
       ('large-head',9,'drop',1700000200001),
       ('large-head',10,'drop',1700000200002),
       ('large-head',120001,'drop',1700000200003),
       ('large-head',120003,'drop',1700000200004),
       ('large-head',120005,'drop',1700000200005);
COMMIT;
