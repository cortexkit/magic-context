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
    let blocks = render(&rows, &shown);
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
    let none = render(&rows, &HashSet::new());
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
    let chosen = choose(&rows, &HashMap::new(), counter, &budget(one, 0), 0);
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
fn a_head_reads_its_project_its_workspace_and_the_person() {
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
    let foreign = save(&db, "pj-c", "CONSTRAINTS", "another workspace's memory");
    // Workspace memories are owned by Entorhinal's workspace id; the session
    // below is in workspace "1".
    db.with_connection(|conn| {
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
        .with_connection(|conn| read_rows(conn, Some("pj-a"), Some("1"), 100))
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
        .with_connection(|conn| read_rows(conn, None, None, 100))
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

// What the head should do once one selection picks the memories of every
// level (global, workspace, project) for `m[0]` and profile lines become
// global memories in `m[1]`'s update lines. Each test below states one such
// expectation that the selection's first version did not meet.

static NO_CLASSES: std::sync::LazyLock<HashMap<String, String>> =
    std::sync::LazyLock::new(Default::default);

/// The head's inputs for `rows` alone: no summaries, no docs, no workspace,
/// and the default memory and profile budgets.
fn head_inputs(rows: &[Row]) -> crate::summary::head::Inputs<'_> {
    crate::summary::head::Inputs {
        counter: Counter::for_model(None),
        summaries: &[],
        docs: "",
        rows,
        workspace: None,
        classes: &NO_CLASSES,
        now_ms: 0,
        gone: &[],
        history_budget_tokens: 60_000,
        history_local_budget_tokens: 60_000,
        memory_budget_tokens: 4_000,
        profile_budget_tokens: 4_000,
    }
}

/// `m[0]` lists the user profile as bare bullets, with no memory ids. When
/// the person archives a profile line after the fold, `m[0]` keeps showing
/// that bullet until the next fold, so `m[1]` must tell the model which
/// bullet no longer holds. A line that names only the memory id leaves the
/// model with no way to match it to a bullet.
#[test]
fn review_an_archived_profile_line_is_identifiable_in_m1() {
    use crate::summary::head::{delta, fold};
    let at_fold = [
        row(1, "global", "USER", "prefers tea"),
        row(2, "global", "USER", "works late"),
    ];
    let baseline = fold(&head_inputs(&at_fold), None);
    assert!(
        baseline
            .m0
            .contains("<user-profile>\n- prefers tea\n- works late\n</user-profile>"),
        "{}",
        baseline.m0
    );
    let mut archived = at_fold[0].clone();
    archived.status = "archived".into();
    let gone = [archived];
    let still = [at_fold[1].clone()];
    let mut later = head_inputs(&still);
    later.gone = &gone;
    let (m1, _, _) = delta(&baseline, &later);
    assert!(
        baseline.m0.contains("#1") || m1.contains("prefers tea"),
        "m[1] retracts profile line 1 by id only, and m[0]'s bullets carry no ids:\nm0:\n{}\nm1:\n{m1}",
        baseline.m0
    );
}

/// A profile line deleted for good (the person's delete in the apps removes
/// the row) leaves no row to read back. Its removal line must still name the
/// level `m[0]` showed it at, the user profile, not the project block.
#[test]
fn review_a_deleted_profile_line_is_removed_at_the_global_level() {
    use crate::summary::head::{delta, fold};
    let baseline = fold(
        &head_inputs(&[row(1, "global", "USER", "prefers tea")]),
        None,
    );
    let (m1, _, _) = delta(&baseline, &head_inputs(&[]));
    assert!(
        m1.contains(r#"<removed id="1" level="global"/>"#),
        "a deleted profile line is reported at the wrong level:\n{m1}"
    );
}

/// With memory off, `m[0]` holds no memory blocks in either format, so the
/// new memory format gives it nothing to re-render: a head rendered with
/// memory off before memory levels must not fold for the format alone.
#[test]
fn review_the_memory_format_alone_does_not_fold_a_head_with_memory_off() {
    use crate::summary::head::{Shape, MEMORY_FORMAT};
    let rendered = Shape {
        memory_enabled: false,
        memory_budget_tokens: 4_000,
        history_budget_tokens: 9_652,
        history_budget_percentage_bp: Some(1_500),
        memory_format: 0,
        profile_budget_tokens: None,
    };
    let now = Shape {
        memory_format: MEMORY_FORMAT,
        profile_budget_tokens: Some(4_000),
        ..rendered.clone()
    };
    assert!(
        !rendered.requires_fold(&now),
        "a memory-off head folds for the memory format alone"
    );
}

/// A baseline saved by the build before memory levels, read back and used
/// for `m[1]` before its format fold (a `/ctx-flush`, which never folds, or
/// an execute pass that rebuilds while the fold waits out heavy thinking).
/// Its `m[0]` already shows the user profile, so `m[1]` must not announce
/// the same profile line as a new memory.
#[test]
fn review_an_old_baseline_used_before_its_fold_adds_no_profile_line_m0_shows() {
    use crate::summary::head::{delta, Baseline};
    let old: Baseline = serde_json::from_str(
        r#"{"through_sequence":-1,"max_memory_id":3,"withheld":[],
            "shown":{"3":{"state":"text","text":"Files are kebab-case."}},
            "profile_max_id":1,
            "profile_digest":"fc194943a86ff851fc97659dbea6028c18feef8baa8281ceafbd4bea107492c1",
            "m0":"<user-profile>\n- Prefers short answers\n</user-profile>\n\n<project-memory>\n<NAMING>\n#3: Files are kebab-case.\n</NAMING>\n</project-memory>",
            "committed":[],"seen":{"3":"Files are kebab-case."},
            "shape":{"memory_enabled":true,"memory_budget_tokens":4000,
                     "history_budget_tokens":60000,"history_budget_percentage_bp":1500},
            "mural":null}"#,
    )
    .expect("a baseline the previous build saved");
    let mut profile = row(100, "global", "USER_MEMORY", "User prefers short answers");
    profile.learned = (Some(1), 1);
    let rows = [
        row(3, "project", "NAMING", "Files are kebab-case."),
        profile,
    ];
    let (m1, _, _) = delta(&old, &head_inputs(&rows));
    assert!(
        !m1.contains(r#"<added id="100" level="global""#),
        "m[1] announces a profile line m[0] already shows:\n{m1}"
    );
}

/// The mural draws the project memories the head's text leaves out for
/// room. A memory the selection hides because a newer one overrides it is
/// not left out for room, so the mural must not draw it either.
#[test]
fn review_the_mural_leaves_out_a_memory_the_head_hides_by_override() {
    let replaced = row(1, "project", "NAMING", "snake case");
    let mut replacing = row(2, "project", "NAMING", "kebab case");
    replacing.overrides = Some(1);
    let rows = [replaced, replacing];
    let shown = crate::summary::head::shown_at_fold(&head_inputs(&rows));
    assert_eq!(shown, HashSet::from([2]));
    let memories: Vec<StoredMemory> = rows.iter().map(Row::stored).collect();
    let cues: HashMap<i64, crate::mural::Cue> = memories
        .iter()
        .map(|memory| {
            (
                memory.id,
                crate::mural::Cue {
                    text: Some(format!("cue {}", memory.id)),
                    hash: Some(crate::mural::content_hash(&memory.content)),
                },
            )
        })
        .collect();
    let drawn: Vec<i64> = crate::mural::entries(&memories, &cues, &shown)
        .iter()
        .map(|entry| entry.id)
        .collect();
    assert!(
        !drawn.contains(&1),
        "the mural draws memory 1, which memory 2 overrides: {drawn:?}"
    );
}
