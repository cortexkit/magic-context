use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use rusqlite::{params, Connection};

use super::*;
use crate::context_db::{ContextDb, FRESH_SCHEMA};
use crate::memory_writes::{self, Writer};

fn row(id: i64, level: &str, tag: &str, content: &str) -> Row {
    Row {
        id,
        level: level.into(),
        owner: match level {
            "global" => "self".into(),
            "workspace" => "1".into(),
            _ => "pj-a".into(),
        },
        category: tag.to_ascii_lowercase(),
        tag: tag.into(),
        content: content.into(),
        importance: Some(50),
        status: "active".into(),
        policy: false,
        critical: false,
        decay_class: None,
        last_seen_at: None,
        verified_at: None,
        expires_at: None,
        overrides: None,
        source_project: None,
        superseded_by: None,
        learned: (None, id),
    }
}

#[test]
fn a_fold_renders_each_level_in_its_own_block() {
    let mut late = row(1, "global", "USER", "User prefers short answers");
    late.learned = (Some(2_000), 1);
    let mut early = row(2, "global", "USER", "Reviews <diffs> before merging");
    early.learned = (Some(1_000), 2);
    let rows = vec![
        late,
        early,
        row(3, "project", "NAMING", "snake case"),
        row(4, "project", "PROJECT_RULES", "never push while CI is red"),
        row(
            5,
            "workspace",
            "CONSTRAINTS",
            "the shared store is one file",
        ),
        row(6, "project", "NAMING", "not shown"),
    ];
    let shown: HashSet<i64> = [1, 2, 3, 4, 5].into();
    let blocks = render(&rows, &shown, None);
    // Profile lines in the order they were learned, not by id.
    assert_eq!(
        blocks.user_profile,
        "<user-profile>\n- Reviews &lt;diffs&gt; before merging\n- Prefers short answers\n</user-profile>"
    );
    assert_eq!(
        blocks.workspace,
        "<workspace-memory>\n<CONSTRAINTS>\n#5: the shared store is one file\n</CONSTRAINTS>\n</workspace-memory>"
    );
    assert_eq!(
        blocks.project,
        "<project-memory>\n<PROJECT_RULES>\n#4: never push while CI is red\n</PROJECT_RULES>\n<NAMING>\n#3: snake case\n</NAMING>\n</project-memory>"
    );
    let none = render(&rows, &HashSet::new(), None);
    assert!(none.user_profile.is_empty() && none.workspace.is_empty() && none.project.is_empty());
}

#[test]
fn the_budget_joins_both_settings_and_keeps_the_profiles_minimum() {
    let budget = budget(4_000, 4_000);
    assert_eq!(budget.total_tokens, 8_000);
    assert_eq!(budget.protected_tokens, 8_000);
    assert_eq!(budget.half_life_ms, 180 * 86_400_000);
    assert_eq!(budget.level_minimum_tokens[&Level::Global], 2_500);
    assert_eq!(budget.level_minimum_tokens[&Level::Workspace], 1_000);
    assert_eq!(budget.level_minimum_tokens[&Level::Project], 3_000);
    // A small profile setting caps the profile's minimum.
    assert_eq!(budget_with(12_000, 1_000)[&Level::Global], 1_000);
}

fn budget_with(memory: u64, profile: u64) -> std::collections::BTreeMap<Level, u64> {
    budget(memory, profile).level_minimum_tokens
}

#[test]
fn a_critical_rule_is_chosen_before_a_more_important_one() {
    let counter = Counter::for_model(None);
    let text = "keep the cached prefix byte identical between passes; ".repeat(8);
    let mut critical = row(1, "project", "PROJECT_RULES", &text);
    critical.importance = Some(10);
    critical.critical = true;
    let mut important = row(2, "project", "PROJECT_RULES", &text);
    important.importance = Some(95);
    let rows = vec![critical, important];
    // Room for one of the two lines.
    let one = counter.count(&format!("#1: {text}\n")) + 60;
    let chosen = choose(&rows, None, &HashMap::new(), counter, &budget(one, 0), 0);
    assert_eq!(chosen.ids, vec![1]);
}

fn scratch(name: &str) -> PathBuf {
    let dir =
        std::env::temp_dir().join(format!("ck-mc-head-memories-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create the scratch folder");
    dir
}

fn save(db: &ContextDb, project: &str, tag: &str, content: &str) -> i64 {
    let writer = Writer {
        harness: "opencode",
        session: "ses-head-memories",
        project,
        authority: None,
    };
    db.with_connection(|conn| memory_writes::save(conn, &writer, tag, content))
        .expect("save a memory")
        .memory_id
        .expect("the saved memory's id")
}

#[test]
fn a_head_reads_its_project_its_workspaces_and_the_person() {
    let dir = scratch("read");
    let path = dir.join("context.db");
    let conn = Connection::open(&path).expect("create the store");
    conn.execute_batch(&FRESH_SCHEMA.replace(":applied_at", "0"))
        .expect("the plugin's schema");
    conn.execute(
        "INSERT INTO user_memories (content, status, promoted_at, created_at, updated_at)
         VALUES ('User prefers short answers', 'active', 1, 1, 1)",
        [],
    )
    .expect("a user memory");
    drop(conn);
    let db = ContextDb::open(&path).expect("the module opens and migrates the store");
    let own = save(&db, "pj-a", "NAMING", "snake case");
    let other = save(&db, "pj-b", "NAMING", "camel case");
    let archived = save(&db, "pj-a", "NAMING", "kebab case");
    let expired = save(&db, "pj-a", "CONSTRAINTS", "frozen until Friday");
    let shared = save(&db, "pj-b", "CONSTRAINTS", "one store file");
    let foreign = save(&db, "pj-c", "CONSTRAINTS", "a workspace pj-a is not in");
    db.with_connection(|conn| {
        conn.execute_batch(
            "INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (1, 'team', 0, 0), (2, 'other', 0, 0);
             INSERT INTO workspace_members VALUES (1, 'pj-a', 'A', '/a', 0), (1, 'pj-b', 'B', '/b', 0),
                                                  (2, 'pj-c', 'C', '/c', 0);",
        )?;
        conn.execute(
            "UPDATE memories SET status = 'archived' WHERE id = ?1",
            params![archived],
        )?;
        conn.execute(
            "UPDATE memories SET expires_at = 50 WHERE id = ?1",
            params![expired],
        )?;
        conn.execute(
            "UPDATE memories SET level = 'workspace', owner_id = '1', source_project_id = 'pj-b' WHERE id = ?1",
            params![shared],
        )?;
        conn.execute(
            "UPDATE memories SET level = 'workspace', owner_id = '2', source_project_id = 'pj-c' WHERE id = ?1",
            params![foreign],
        )
    })
    .expect("shape the store");
    let rows = db
        .with_connection(|conn| read_rows(conn, Some("pj-a"), 100))
        .expect("read the head's rows");
    let mut by_level: Vec<(String, i64)> =
        rows.iter().map(|row| (row.level.clone(), row.id)).collect();
    by_level.sort();
    let global = rows
        .iter()
        .find(|row| row.level == "global")
        .expect("the profile line")
        .id;
    assert_eq!(
        by_level,
        vec![
            ("global".into(), global),
            ("project".into(), own),
            ("workspace".into(), shared),
        ]
    );
    assert!(!rows.iter().any(|row| row.id == other));
    // Without a project, only the person's memories.
    let alone = db
        .with_connection(|conn| read_rows(conn, None, 100))
        .expect("read without a project");
    assert_eq!(
        alone.iter().map(|row| row.id).collect::<Vec<_>>(),
        vec![global]
    );
    // A memory the head stopped seeing is read back with its status.
    let gone = db
        .with_connection(|conn| rows_by_ids(conn, &[archived]))
        .expect("read a gone row");
    assert_eq!(gone[0].status, "archived");
    let _ = std::fs::remove_dir_all(&dir);
}
