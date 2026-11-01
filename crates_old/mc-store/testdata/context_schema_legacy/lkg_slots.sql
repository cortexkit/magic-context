
        CREATE TABLE IF NOT EXISTS lkg_slots_v94 (
            session_id TEXT PRIMARY KEY,
            json_prefix_chars INTEGER NOT NULL,
            json_prefix_chunks INTEGER NOT NULL,
            json_prefix_hash TEXT NOT NULL,
            input_id_seq TEXT NOT NULL,
            input_content_digests TEXT NOT NULL,
            input_content_signatures TEXT,
            last_input_message_id TEXT NOT NULL,
            model_key TEXT,
            provider_key TEXT,
            captured_at INTEGER NOT NULL,
            row_version INTEGER,
            capture_sequence INTEGER
        );
