INSERT INTO session_meta(session_id,harness) VALUES('s','opencode');
INSERT INTO message_history_source(session_id,message_id,message_ordinal,source_version,normalized_content_hash,role,updated_at) VALUES
('s','before',1,'v','h','user',10),
('s','old-first',2,'v','h','user',10),
('s','summarized',3,'v','h','assistant',10),
('s','raw',4,'v','h','assistant',10),
('s','partial',5,'v','h','assistant',10),
('s','all',6,'v','h','assistant',10),
('s','owner',7,'v','h','assistant',10),
('s','file',8,'v','h','assistant',10),
('s','compacted',9,'v','h','assistant',10),
('s','zero',10,'v','h','user',10),
('s','stamp',11,'v','h','assistant',10);
INSERT INTO compartments(session_id,sequence,start_message,end_message,title,content,created_at) VALUES('s',1,2,3,'A summary','Stored prose',20);
INSERT INTO tags(id,session_id,message_id,type,status,byte_size,token_count,tag_number,tool_name,tool_owner_message_id,input_byte_size,input_token_count,drop_mode) VALUES
(1,'s','raw:p2','message','active',10,3,1,NULL,NULL,NULL,NULL,'full'),
(2,'s','partial:p2','message','active',12,4,2,NULL,NULL,NULL,NULL,'full'),
(3,'s','partial:p4','message','dropped',14,NULL,3,NULL,NULL,NULL,NULL,'full'),
(4,'s','all:p1','message','dropped',21,7,4,NULL,NULL,NULL,NULL,'full'),
(5,'s','all:p3','message','dropped',23,8,5,NULL,NULL,NULL,NULL,'full'),
(6,'s','call_123','tool','dropped',300,75,6,'bash','owner',50,12,'skeleton_real'),
(7,'s','file:file5','file','dropped',42,10,7,NULL,NULL,NULL,NULL,'full'),
(8,'s','compacted:p0','message','compacted',60,15,8,NULL,NULL,NULL,NULL,'full'),
(9,'s','raw:p7','message','compacted',30,9,9,NULL,NULL,NULL,NULL,'full'),
(10,'s','stamp:p2','message','active',64,16,10,NULL,NULL,NULL,NULL,'full'),
(11,'s','summarized:p0','message','active',20,5,11,NULL,NULL,NULL,NULL,'full');
INSERT INTO pending_ops(session_id,tag_id,operation,queued_at) VALUES('s',10,'drop',123),('s',11,'drop',124);
