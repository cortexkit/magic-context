//! Migration 108 on a store at 107 that the commit sweep and search had
//! already used: every commit, vector and search hit survives, keyed by its
//! project, and a commit two projects index is held by each.

use rusqlite::{params, Connection};

use super::*;
use crate::embedding::encode;
use crate::search::sources::{search_commits, Semantic};

const PLUGIN_SCHEMA: &str = include_str!("../testdata/context-schema.sql");

const ALPHA: &str = "pj-alpha";
const BETA: &str = "pj-beta";
const MODEL: &str = "mock-embed";

/// The store as the module left it at 107, foreign keys on as in every
/// ck-mc connection.
fn store_at_107() -> Connection {
    let mut conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(&PLUGIN_SCHEMA.replace(":applied_at", "0"))
        .unwrap();
    conn.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    let found = crate::context_db::live_schema_version(&conn).unwrap();
    assert_eq!(upgrade_through(&mut conn, found, 107).unwrap(), 107);
    conn
}

fn sha(seed: char) -> String {
    seed.to_string().repeat(40)
}

/// The commit sweep's upsert as it stood at 107 (`upkeep::store_commits`).
fn store_commit_107(conn: &Connection, project: &str, sha: &str, message: &str, at: i64) {
    conn.execute(
        "INSERT INTO git_commits (sha, project_path, short_sha, message, author, committed_at, indexed_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) \
         ON CONFLICT(sha) DO UPDATE SET \
             project_path = excluded.project_path, short_sha = excluded.short_sha, \
             message = excluded.message, author = excluded.author, \
             committed_at = excluded.committed_at, indexed_at = excluded.indexed_at \
         WHERE git_commits.message != excluded.message",
        params![sha, project, &sha[..7], message, "Ada", at, at + 1],
    )
    .unwrap();
}

/// The sweep's eviction past the cap as it stood at 107.
fn evict_107(conn: &Connection, project: &str, max: i64) {
    conn.execute(
        "DELETE FROM git_commits WHERE rowid IN (\
             SELECT rowid FROM git_commits WHERE project_path = ?1 \
             ORDER BY committed_at DESC, sha DESC LIMIT -1 OFFSET ?2)",
        params![project, max],
    )
    .unwrap();
}

/// The sweep's vector write as it stood at 107 (`upkeep::embed_commits`).
fn store_vector_107(conn: &Connection, sha: &str, model: &str, vector: &[f32]) {
    conn.execute(
        "INSERT INTO git_commit_embeddings (sha, embedding, model_id, created_at) \
         VALUES (?1, ?2, ?3, ?4) \
         ON CONFLICT(sha, model_id) DO UPDATE SET \
         embedding = excluded.embedding, created_at = excluded.created_at",
        params![sha, encode(vector), model, 9],
    )
    .unwrap();
}

/// Commit shas full-text search ranks for `query` in `project`, through the
/// 107 reader (`search::sources::search_commits` as it stood).
fn fts_hits_107(conn: &Connection, project: &str, query: &str) -> Vec<String> {
    strings(
        conn,
        "SELECT c.sha FROM git_commits_fts
           INNER JOIN git_commits c ON c.sha = git_commits_fts.sha
          WHERE c.project_path = ?1 AND git_commits_fts MATCH ?2
          ORDER BY bm25(git_commits_fts)",
        params![project, query],
    )
}

/// The project's vectors through the 107 reader's join, with the project
/// they belong to.
fn vectors_107(conn: &Connection, project: &str) -> Vec<String> {
    strings(
        conn,
        "SELECT c.project_path || '|' || e.sha || '|' || e.model_id || '|' || hex(e.embedding)
                || '|' || e.created_at
           FROM git_commit_embeddings e JOIN git_commits c ON c.sha = e.sha
          WHERE c.project_path = ?1 ORDER BY e.sha, e.model_id",
        params![project],
    )
}

fn vectors_108(conn: &Connection, project: &str) -> Vec<String> {
    strings(
        conn,
        "SELECT project_path || '|' || sha || '|' || model_id || '|' || hex(embedding)
                || '|' || created_at
           FROM git_commit_embeddings WHERE project_path = ?1 ORDER BY sha, model_id",
        params![project],
    )
}

fn commits(conn: &Connection) -> Vec<String> {
    strings(
        conn,
        "SELECT rowid || '|' || sha || '|' || project_path || '|' || short_sha || '|' || message
                || '|' || author || '|' || committed_at || '|' || indexed_at
           FROM git_commits ORDER BY rowid",
        [],
    )
}

fn strings(conn: &Connection, sql: &str, params: impl rusqlite::Params) -> Vec<String> {
    conn.prepare(sql)
        .unwrap()
        .query_map(params, |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

/// Commit shas the module's search finds for `query` in `project` by words.
fn found_by_words(conn: &Connection, project: &str, query: &str) -> Vec<String> {
    search_commits(conn, project, query, 10, None, None, None)
        .into_iter()
        .map(|hit| hit.sha)
        .collect()
}

/// Commit shas the module's search finds in `project` by meaning alone.
fn found_by_meaning(conn: &Connection, project: &str) -> Vec<String> {
    let semantic = Semantic {
        vector: &[1.0, 0.0],
        model_id: MODEL,
        chunk_model_id: "",
    };
    let mut found: Vec<String> =
        search_commits(conn, project, "zebra", 10, None, Some(semantic), None)
            .into_iter()
            .map(|hit| hit.sha)
            .collect();
    found.sort();
    found
}

/// Searches whose words only full-text stemming matches, so the substring
/// fallback can't stand in for a lost index: "parsers" finds "parser".
const SEARCHES: [(&str, &str); 7] = [
    (ALPHA, "parsers"),
    (ALPHA, "checklists"),
    (ALPHA, "crashes"),
    // Only the rewritten message says "notes".
    (ALPHA, "noted"),
    (BETA, "parsers"),
    (BETA, "crashes"),
    (BETA, "lexers"),
];

#[test]
fn every_commit_vector_and_search_hit_survives_migration_108() {
    let mut conn = store_at_107();
    // What the sweep leaves: commits of two projects, one message rewritten
    // in place, one commit evicted past the cap, and vectors under two
    // models.
    store_commit_107(
        &conn,
        ALPHA,
        &sha('a'),
        "Fix the parser crash on empty input",
        100,
    );
    store_commit_107(&conn, ALPHA, &sha('b'), "Add the release checklist", 200);
    store_commit_107(
        &conn,
        ALPHA,
        &sha('c'),
        "Parser speedup for long files",
        300,
    );
    store_commit_107(&conn, ALPHA, &sha('d'), "Remove the old parser", 50);
    store_commit_107(
        &conn,
        ALPHA,
        &sha('b'),
        "Add the release checklist and notes",
        200,
    );
    evict_107(&conn, ALPHA, 3);
    store_commit_107(
        &conn,
        BETA,
        &sha('e'),
        "Fix the parser crash in the lexer",
        400,
    );
    store_vector_107(&conn, &sha('a'), MODEL, &[1.0, 0.5]);
    store_vector_107(&conn, &sha('a'), "other-model", &[0.0, 1.0]);
    store_vector_107(&conn, &sha('c'), MODEL, &[1.0, 1.0]);
    store_vector_107(&conn, &sha('e'), MODEL, &[1.0, 0.25]);
    // A vector a store kept after its commit went while foreign keys were
    // off: no reader reaches it.
    conn.execute_batch("PRAGMA foreign_keys=OFF").unwrap();
    store_vector_107(&conn, &sha('f'), MODEL, &[1.0, 0.0]);
    conn.execute_batch("PRAGMA foreign_keys=ON").unwrap();

    let commits_before = commits(&conn);
    assert_eq!(commits_before.len(), 4, "{commits_before:?}");
    let hits_before: Vec<Vec<String>> = SEARCHES
        .iter()
        .map(|(project, query)| fts_hits_107(&conn, project, query))
        .collect();
    assert!(
        hits_before.iter().all(|hits| !hits.is_empty()),
        "{hits_before:?}"
    );
    // The evicted commit is found by nothing.
    assert!(fts_hits_107(&conn, ALPHA, "removed").is_empty());
    let vectors_before: Vec<Vec<String>> = [ALPHA, BETA]
        .iter()
        .map(|project| vectors_107(&conn, project))
        .collect();
    assert_eq!(vectors_before[0].len() + vectors_before[1].len(), 4);

    assert_eq!(upgrade(&mut conn, 107).unwrap(), i64::from(SCHEMA_VERSION));
    assert_eq!(SCHEMA_VERSION, 108);

    // Every commit keeps its project, its rowid and every column.
    assert_eq!(commits(&conn), commits_before);
    // Every vector keeps its commit's project; the unreachable one is gone.
    for (index, project) in [ALPHA, BETA].iter().enumerate() {
        assert_eq!(
            vectors_108(&conn, project),
            vectors_before[index],
            "{project}"
        );
    }
    let vectors: i64 = conn
        .query_row("SELECT COUNT(*) FROM git_commit_embeddings", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(vectors, 4);
    // The module's search finds every hit the 107 reader found, in order,
    // and still nothing for the evicted commit.
    let hits_after: Vec<Vec<String>> = SEARCHES
        .iter()
        .map(|(project, query)| found_by_words(&conn, project, query))
        .collect();
    assert_eq!(hits_after, hits_before);
    assert_eq!(
        found_by_words(&conn, ALPHA, "removed"),
        Vec::<String>::new()
    );
    assert_eq!(found_by_meaning(&conn, ALPHA), [sha('a'), sha('c')]);
    assert_eq!(found_by_meaning(&conn, BETA), [sha('e')]);
    // One full-text entry per commit, each mapped to its project and sha.
    let entries = strings(
        &conn,
        "SELECT m.project_path || '|' || m.sha FROM git_commit_fts_rowid_map m
           JOIN git_commits_fts f ON f.rowid = m.fts_rowid
          WHERE f.project_path = m.project_path AND f.sha = m.sha
          ORDER BY m.project_path, m.sha",
        [],
    );
    assert_eq!(
        entries,
        [
            format!("{ALPHA}|{}", sha('a')),
            format!("{ALPHA}|{}", sha('b')),
            format!("{ALPHA}|{}", sha('c')),
            format!("{BETA}|{}", sha('e')),
        ]
    );
    let index: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index'
                AND name = 'idx_git_commits_project_time'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(index, 1);
    let on: bool = conn
        .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
        .unwrap();
    assert!(on);
    let dangling: i64 = conn
        .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(dangling, 0);
}

#[test]
fn after_108_two_projects_hold_one_commit_each_on_its_own() {
    let mut conn = store_at_107();
    store_commit_107(
        &conn,
        ALPHA,
        &sha('a'),
        "Fix the parser crash on empty input",
        100,
    );
    store_vector_107(&conn, &sha('a'), MODEL, &[1.0, 0.0]);
    upgrade(&mut conn, 107).unwrap();

    // The second project indexes the same commit beside the first's.
    conn.execute(
        "INSERT INTO git_commits (sha, project_path, short_sha, message, author, committed_at, indexed_at)
         VALUES (?1, ?2, 'aaaaaaa', 'Fix the parser crash on empty input', 'Ada', 100, 101)",
        params![sha('a'), BETA],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO git_commit_embeddings (project_path, sha, embedding, model_id, created_at)
         VALUES (?1, ?2, ?3, ?4, 9)",
        params![BETA, sha('a'), encode(&[1.0, 0.0]), MODEL],
    )
    .unwrap();
    for project in [ALPHA, BETA] {
        assert_eq!(
            found_by_words(&conn, project, "parsers"),
            [sha('a')],
            "{project}"
        );
        assert_eq!(found_by_meaning(&conn, project), [sha('a')], "{project}");
    }

    // A project's commit moving to another project takes its vector and
    // its search entry along, as a legacy move re-keys it.
    conn.execute(
        "UPDATE git_commits SET project_path = 'pj-gamma' WHERE project_path = ?1 AND sha = ?2",
        params![BETA, sha('a')],
    )
    .unwrap();
    assert_eq!(found_by_words(&conn, BETA, "parsers"), Vec::<String>::new());
    assert_eq!(found_by_words(&conn, "pj-gamma", "parsers"), [sha('a')]);
    assert_eq!(found_by_meaning(&conn, "pj-gamma"), [sha('a')]);

    // Evicting it from one project leaves the other's row, vector and
    // search entry alone.
    conn.execute(
        "DELETE FROM git_commits WHERE project_path = ?1 AND sha = ?2",
        params![ALPHA, sha('a')],
    )
    .unwrap();
    assert_eq!(
        found_by_words(&conn, ALPHA, "parsers"),
        Vec::<String>::new()
    );
    assert_eq!(found_by_meaning(&conn, ALPHA), Vec::<String>::new());
    assert_eq!(found_by_words(&conn, "pj-gamma", "parsers"), [sha('a')]);
    assert_eq!(found_by_meaning(&conn, "pj-gamma"), [sha('a')]);
    let left: Vec<String> = strings(
        &conn,
        "SELECT project_path FROM git_commit_embeddings ORDER BY project_path",
        [],
    );
    assert_eq!(left, ["pj-gamma"]);
    let entries: i64 = conn
        .query_row("SELECT COUNT(*) FROM git_commit_fts_rowid_map", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(entries, 1);
}
