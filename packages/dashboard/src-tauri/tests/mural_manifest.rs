#[path = "support/isolated_home.rs"]
mod isolated_home;
use isolated_home::isolated_home;

use magic_context_dashboard_lib::db;
use rusqlite::{params, Connection};

#[test]
fn reads_project_mural_and_degrades_without_v64_table() {
    isolated_home();
    let conn = Connection::open_in_memory().expect("open test db");
    assert!(db::get_mural(&conn, Some("/project"))
        .expect("pre-v64 query")
        .is_none());

    conn.execute_batch(
        "CREATE TABLE mural_manifest (
            project_path TEXT PRIMARY KEY,
            image BLOB NOT NULL,
            content_hash TEXT NOT NULL,
            rendered_at INTEGER NOT NULL,
            model TEXT,
            memory_ids_json TEXT NOT NULL DEFAULT '[]',
            width INTEGER NOT NULL DEFAULT 1092,
            height INTEGER NOT NULL DEFAULT 1092
        )",
    )
    .expect("create v64 mural table");
    conn.execute(
        "INSERT INTO mural_manifest (project_path, image, content_hash, rendered_at, width, height)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            "/project",
            vec![137_u8, 80, 78, 71],
            "hash",
            1234_i64,
            1092_i64,
            1092_i64
        ],
    )
    .expect("insert mural");

    let mural = db::get_mural(&conn, Some("/project"))
        .expect("read mural")
        .expect("mural row");
    assert_eq!(mural.project_path, "/project");
    assert_eq!(mural.image, vec![137_u8, 80, 78, 71]);
    assert_eq!(mural.rendered_at, 1234);
    assert_eq!(mural.token_estimate, 1521);
    assert_eq!(mural.width, 1092);
    assert_eq!(mural.height, 1092);
}
