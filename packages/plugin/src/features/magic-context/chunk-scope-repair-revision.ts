import type { Database, Statement } from "../../shared/sqlite";
import { isKnownAutocommit } from "../../shared/sqlite-helpers";

const revisions = new WeakMap<Database, { statement: Statement; schemaVersion?: number }>();
const KEY = "chunk_scope_repair_revision";

/** A selective local revision, with conservative invalidation for external writers. */
export function readChunkScopeRepairRevision(db: Database): string | null {
    if (!isKnownAutocommit(db)) return null;
    let state = revisions.get(db);
    if (!state) {
        // Partial schemas can register memory embeddings before the metadata
        // table exists. Keep their repair scans exact without installing triggers.
        if (
            !db
                .prepare(
                    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations_meta'",
                )
                .get()
        )
            return null;
        // TEMP triggers do not change context.db's schema. Unlike call-site
        // invalidation they also observe project remaps, restored history rows
        // and raw SQL on this connection. Updating session_projects.updated_at
        // alone does not change a session's project binding.
        const bump = `INSERT INTO schema_migrations_meta(key, value) VALUES ('${KEY}', lower(hex(randomblob(16))))
            ON CONFLICT(key) DO UPDATE SET value = excluded.value;`;
        db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS mc_chunk_scope_binding_bi
            BEFORE INSERT ON main.session_projects
            WHEN NOT EXISTS (SELECT 1 FROM session_projects WHERE session_id = NEW.session_id
                AND harness = NEW.harness AND project_path = NEW.project_path)
            BEGIN ${bump} END;
            CREATE TEMP TRIGGER IF NOT EXISTS mc_chunk_scope_binding_au
            AFTER UPDATE ON main.session_projects
            WHEN OLD.session_id IS NOT NEW.session_id OR OLD.harness IS NOT NEW.harness
                OR OLD.project_path IS NOT NEW.project_path
            BEGIN ${bump} END;
            CREATE TEMP TRIGGER IF NOT EXISTS mc_chunk_scope_rows_bi
            BEFORE INSERT ON main.compartment_chunk_embeddings BEGIN ${bump} END;
            CREATE TEMP TRIGGER IF NOT EXISTS mc_chunk_scope_rows_au
            AFTER UPDATE OF project_path, session_id, harness ON main.compartment_chunk_embeddings
            WHEN NOT EXISTS (SELECT 1 FROM session_projects WHERE session_id = NEW.session_id
                AND harness = NEW.harness AND project_path = NEW.project_path)
            BEGIN ${bump} END;`);
        const statement = db.prepare(`SELECT
            (SELECT value FROM schema_migrations_meta WHERE key = '${KEY}') AS local,
            (SELECT data_version FROM pragma_data_version) AS external,
            (SELECT schema_version FROM pragma_schema_version) AS schemaVersion`);
        state = { statement };
        revisions.set(db, state);
    }
    // Other processes, old builds and Rust writers need not install the TEMP
    // triggers. Any external commit invalidates the completed chunk-scope scan,
    // even when it changes unrelated rows.
    const row = state.statement.get() as { schemaVersion: number };
    if (state.schemaVersion !== undefined && state.schemaVersion !== row.schemaVersion) {
        // A table rebuild can remove its TEMP triggers along with the old table.
        revisions.delete(db);
        return readChunkScopeRepairRevision(db);
    }
    state.schemaVersion = row.schemaVersion;
    return JSON.stringify(row);
}
