
    CREATE TABLE IF NOT EXISTS lkg_slot_chunks (
        session_id TEXT NOT NULL,
        chunk INTEGER NOT NULL,
        hash TEXT NOT NULL,
        body TEXT NOT NULL,
        PRIMARY KEY (session_id, chunk)
    );
