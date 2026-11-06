PRAGMA journal_mode=WAL;
CREATE TABLE session_message (session_id TEXT, type TEXT, seq INTEGER, data TEXT);
INSERT INTO session_message VALUES
('ses_runner', 'user', 0, '{}'),
('ses_runner', 'assistant', 1, '{"tokens":{"input":10,"output":20,"reasoning":5,"cache":{"read":10000,"write":2000}},"time":{"created":1788861600000,"streamed":1788861600100,"completed":1788861601000},"model":{"id":"claude-opus-4-6","providerID":"anthropic","variant":"max"}}'),
('ses_runner', 'assistant', 2, '{"tokens":{"input":10,"output":20,"reasoning":0,"cache":{"read":100,"write":12000}},"time":{"created":1788868020000,"completed":1788868021000},"model":{"id":"claude-opus-4-6","providerID":"anthropic"}}'),
('ses_runner', 'assistant', 3, '{"tokens":{"input":10,"output":20,"cache":{"read":100,"write":12000}},"time":{"created":1788868080000,"completed":1788868081000},"model":{"id":"claude-opus-4-6","providerID":"anthropic"}}'),
('ses_runner', 'assistant', 4, '{"tokens":{"input":10,"output":20,"cache":{"read":100,"write":12000}},"time":{"created":1788868140000,"completed":1788868141000},"model":{"id":"claude-opus-4-6","providerID":"anthropic"}}'),
('ses_other', 'assistant', 5, '{}');
