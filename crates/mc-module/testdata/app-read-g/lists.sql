INSERT INTO session_meta(session_id, harness) VALUES ('ses', 'opencode');
WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<4)
INSERT INTO compartments(session_id, sequence, start_message, end_message, title, content, created_at, harness)
SELECT 'ses', x, x, x, 'summary', 'é😀', x, 'opencode' FROM n;
WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<4)
INSERT INTO session_facts(session_id, category, content, created_at, updated_at, harness)
SELECT 'ses', 'CONSTRAINTS', replace(hex(zeroblob(8000)), '00', 'x'), x, x, 'opencode' FROM n;
WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<4)
INSERT INTO notes(type, status, content, session_id, created_at, updated_at, harness)
SELECT 'session', 'active', replace(hex(zeroblob(10000)), '00', 'x'), 'ses', x, x, 'opencode' FROM n;
WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<4)
INSERT INTO subagent_invocations(session_id, harness, subagent, task, started_at, status, input_tokens)
SELECT 'ses', 'opencode', 'agent-'||x, replace(hex(zeroblob(4000)), '00', 'x'), x, 'done', x FROM n;
WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<4)
INSERT INTO memories(project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at, status)
SELECT 'git:a', 'CONSTRAINTS', 'needle '||replace(hex(zeroblob(10000)), '00', 'x'), 'hash-'||x, x, x, x, x, 'active' FROM n;
INSERT INTO project_state(project_path, project_memory_epoch, project_user_profile_version) VALUES ('git:a', 2, 3);
WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<4)
INSERT INTO primers(project_path, question, answer, last_observed_at, created_at, updated_at)
SELECT 'git:a', 'question-'||x, replace(hex(zeroblob(8000)), '00', 'x'), x, x, x FROM n;
WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<4)
INSERT INTO primer_candidates(project_path, harness, session_id, question, normalized_question, source_message_time, created_at)
SELECT 'git:a', 'opencode', 'ses-'||x, 'question-'||x, 'question-'||x, x, x FROM n;
WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<4)
INSERT INTO workspaces(name, created_at, updated_at) SELECT 'workspace-'||x, x, x FROM n;
INSERT INTO workspace_members(workspace_id, project_path, display_name, display_path, added_at)
VALUES (1, 'git:a', 'A', '/fixture/a', 1), (1, 'git:b', 'B', '/fixture/b', 1);
WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<4)
INSERT INTO user_memories(content, promoted_at, created_at, updated_at)
SELECT replace(hex(zeroblob(10000)), '00', 'x'), x, x, x FROM n;
WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<4)
INSERT INTO user_memory_candidates(content, session_id, created_at)
SELECT replace(hex(zeroblob(10000)), '00', 'x'), 'ses', x FROM n;
WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<4)
INSERT INTO task_schedule_state(project_path, task, schedule, last_error)
SELECT 'git:'||x, 'verify', '0 3 * * *', replace(hex(zeroblob(8000)), '00', 'x') FROM n;
WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<4)
INSERT INTO dream_state(key, value) SELECT 'state-'||x, replace(hex(zeroblob(8000)), '00', 'x') FROM n;
WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<4)
INSERT INTO dream_runs(project_path, started_at, finished_at, holder_id, tasks_json, memory_changes_json)
SELECT 'git:a', x, x+10, 'holder', replace(hex(zeroblob(30000)), '00', 'x'), '{"writtenIds":[1,2,3,4]}' FROM n;
