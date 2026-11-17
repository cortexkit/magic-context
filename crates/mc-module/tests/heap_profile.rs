//! What ck-mc holds in memory once its sessions are set up, by allocation
//! site, measured on a copy of real stores.
//!
//! Opt-in, local and slow: it reads a read-only copy of `context.db` and
//! `mode3.db`, copies the chosen sessions' summaries, project memories and
//! message-index marks into a fresh store pair under the temp directory,
//! seeds each session's saved state the way a session that was already
//! running has it (a first view that cuts through its newest summary), and
//! then, under the dhat heap profiler, runs the module's real paths: a
//! process start, every session's Setup against a stand-in runner, the
//! app reads, a search, the history head rendered from scratch, and each
//! tokenizer family. The stand-in runner makes each transcript entry up when
//! it is read, from the ordinal and the message ids the summaries name, so
//! the runner side holds almost nothing and the heap is ck-mc's own.
//!
//! ```text
//! MC_HEAP_CORPUS=<dir with context.db and mode3.db> \
//! MC_HEAP_OUT=<dir for dhat-heap.json and the report> \
//! nice -n 19 cargo test -p mc-module --release --features heap-profile \
//!     --test heap_profile -- --ignored --nocapture
//! ```
//!
//! `MC_HEAP_SESSIONS` names a file with one `runner harness session` per
//! line; without it the profile sets up the `MC_HEAP_TOP` heads (default 24)
//! with the most summaries among the sessions `mode3.db` holds. Each
//! transcript runs past its newest summary as far as the session's
//! app-replica header last counted; `MC_HEAP_TAIL` sets one length for all.
//!
//! The report prints the module's heap after each step (dhat's counts of
//! requested bytes, before the allocator rounds them up), then the
//! allocation sites of everything still live at the end, grouped by the
//! first frame in this crate, with the allocator-level frame that tells a
//! `serde_json` object node from a string or a vector.

// Built only with the opt-in feature, so that `cargo test --test '*'` passes
// over this target without it.
#![cfg(feature = "heap-profile")]

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cortexkit_role_compaction::part::{PartBody, Seal, ToolPart, ToolStatus};
use cortexkit_role_compaction::read::{
    Cursor, Entry, Head, ReadPage, ReadRequest, Role, Select, SessionRef,
};
use cortexkit_role_compaction::rules::{EditCost, ProviderRules, SignedParts};
use cortexkit_role_compaction::setup::{ModelRef, SetupRequest};
use cortexkit_role_compaction::view::{AppliedViewAnswer, ApplyViewAnswer, ApplyViewRequest, View};
use cortexkit_role_llm_runner::run::{RunResult, RunResultRequest};
use cortexkit_role_llm_runner::send::{SendReply, SendRequest};
use cortexkit_role_routing::report::ReportRequest;
use cortexkit_role_routing::select::{SelectAnswer, SelectRequest};
use mc_mock_runner::transcript::part;
use mc_module::client::{Child, ClientError, RunnerClient};
use mc_module::context_db::ContextDb;
use mc_module::module::Module;
use mc_module::pass::Settings;
use mc_module::route::{Project, Route};
use mc_module::routing::{RouteError, Router};
use mc_module::session::Session;
use mc_module::store::Store;
use rusqlite::{params, Connection, OpenFlags};
use serde_json::{json, Value};

#[global_allocator]
static ALLOC: dhat::Alloc = dhat::Alloc;

/// The runner's clock in every request: the transcript's entries are dated
/// before it, one second apart.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn rules() -> ProviderRules {
    ProviderRules::new(SignedParts::None, EditCost::Suffix)
}

fn cursor(entry: &Entry) -> Cursor {
    Cursor::new(entry.ordinal, entry.mid.clone(), entry.digest.clone())
}

/// One session to set up, as the corpus describes it.
struct Head0 {
    key: SessionRef,
    /// `head` or `worker`, from the session's saved state.
    preset: String,
    project: Option<Project>,
    model: ModelRef,
    window: u64,
    reserve: u64,
    summaries: usize,
    /// The ordinal the newest summary ends on: the seeded view cuts there.
    covered: u64,
    /// Every ordinal a summary starts or ends on, with the message id the
    /// summary names for it.
    ids: HashMap<u64, String>,
    by_id: HashMap<String, u64>,
    /// Entries after `covered`: the session's newest ordinal, as the app
    /// replica's header last recorded it, less `covered`.
    tail: u64,
    /// The runner's clock at Setup, fixed so every read of an entry makes
    /// the same entry.
    clock: u64,
}

impl Head0 {
    fn length(&self) -> u64 {
        self.covered + self.tail
    }

    fn mid(&self, n: u64) -> String {
        self.ids
            .get(&n)
            .cloned()
            .unwrap_or_else(|| format!("hp{n}"))
    }

    fn ordinal(&self, mid: &str) -> Option<u64> {
        self.by_id
            .get(mid)
            .copied()
            .or_else(|| mid.strip_prefix("hp")?.parse().ok())
            .filter(|n| (1..=self.length()).contains(n))
    }

    /// The entry at ordinal `n`, made up the same way on every read: a
    /// person's prompt, then an assistant step with text and a finished
    /// tool call (whose output only its size stands for, as a notice
    /// carries it), then the tool's result row.
    fn entry(&self, n: u64) -> Entry {
        let written = self.clock - (self.length() - n + 1) * 1_000;
        let text = |slot: &str, words: &str| {
            part(
                format!("hp{n}-{slot}"),
                Some(n * 3 + u64::from(slot == "assistant")),
                Seal::None,
                PartBody::Text {
                    text: format!(
                        "{words} {n}. {}",
                        "Keep the cache boundaries and verify the focused tests. ".repeat(3)
                    )
                    .into(),
                },
            )
        };
        let (role, parts) = match n % 3 {
            1 => (Role::User, vec![text("user", "Review component")]),
            2 => {
                let mut tool = ToolPart::new(
                    format!("call-{n}"),
                    "read",
                    json!({"path": format!("src/component-{n}.rs")}),
                    ToolStatus::Completed,
                );
                tool.output_bytes = Some(if n % 64 == 2 { 20_480 } else { 2_048 });
                (
                    Role::Assistant,
                    vec![
                        text("assistant", "Reading component"),
                        part(
                            format!("hp{n}-tool"),
                            Some(n * 3 + 2),
                            Seal::None,
                            PartBody::Tool(tool),
                        ),
                    ],
                )
            }
            _ => (
                Role::Assistant,
                vec![text("assistant", "Checked component")],
            ),
        };
        Entry::new(n, self.mid(n), role, written, parts)
    }
}

/// Each session's made-up transcript, and the view the runner applies for
/// it (none before the first).
type Held = HashMap<SessionRef, (Arc<Head0>, Option<View>)>;

/// The stand-in runner: every session's transcript, made up on each read,
/// and the view it applies.
#[derive(Clone, Default)]
struct Runner(Arc<Mutex<Held>>);

impl Runner {
    fn head(&self, key: &SessionRef) -> Arc<Head0> {
        self.0.lock().unwrap()[key].0.clone()
    }

    fn view(&self, key: &SessionRef) -> Option<View> {
        self.0.lock().unwrap()[key].1.clone()
    }
}

impl RunnerClient for Runner {
    async fn read(&self, key: &SessionRef, request: ReadRequest) -> Result<ReadPage, ClientError> {
        let (head, view) = {
            let held = self.0.lock().unwrap();
            let (head, view) = held
                .get(key)
                .ok_or_else(|| ClientError::new("unknown session"))?;
            (head.clone(), view.as_ref().map(View::applied))
        };
        let ordinals: Vec<u64> = match request.select {
            Select::After {
                after_ordinal,
                limit,
            } => {
                let from = after_ordinal.unwrap_or(0) + 1;
                let to = head.length();
                let count = limit.unwrap_or(u64::MAX).min(to.saturating_sub(from) + 1);
                (from..from + count).collect()
            }
            Select::Mids { mids } => mids.iter().filter_map(|mid| head.ordinal(mid)).collect(),
            Select::Tags { tags } => tags
                .iter()
                .map(|tag| tag / 3)
                .filter(|n| (1..=head.length()).contains(n))
                .collect(),
            other => {
                eprintln!("HEAP_RUNNER unhandled read selector {other:?}");
                Vec::new()
            }
        };
        let mut entries = Vec::new();
        let mut bytes = 0;
        let mut next_after = None;
        for n in ordinals {
            let entry = head.entry(n);
            let size = serde_json::to_vec(&entry).unwrap().len() as u64;
            if !entries.is_empty() && request.max_bytes.is_some_and(|max| bytes + size > max) {
                next_after = entries.last().map(|e: &Entry| e.ordinal);
                break;
            }
            bytes += size;
            entries.push(entry);
        }
        let mut page_head = Head::new();
        page_head.newest = Some(cursor(&head.entry(head.length())));
        page_head.applied_view = view;
        let mut page = ReadPage::new(entries, page_head);
        page.next_after = next_after;
        Ok(page)
    }

    async fn apply_view(
        &self,
        key: &SessionRef,
        request: ApplyViewRequest,
    ) -> Result<ApplyViewAnswer, ClientError> {
        if let Some((_, view)) = self.0.lock().unwrap().get_mut(key) {
            *view = Some(request.view);
        }
        Ok(ApplyViewAnswer::Accepted)
    }

    async fn applied_view(&self, key: &SessionRef) -> Result<AppliedViewAnswer, ClientError> {
        let mut answer = AppliedViewAnswer::new();
        answer.view = self.view(key);
        Ok(answer)
    }

    async fn send(&self, _: &SessionRef, _: SendRequest) -> Result<SendReply, ClientError> {
        Err(ClientError::new("the profile's runner sends no reminders"))
    }

    async fn send_child(&self, _: &Child, _: SendRequest) -> Result<SendReply, ClientError> {
        Err(ClientError::new("the profile's runner runs no summaries"))
    }

    async fn child_result(&self, _: &Child, _: RunResultRequest) -> Result<RunResult, ClientError> {
        Err(ClientError::new("the profile's runner runs no summaries"))
    }
}

impl Router for Runner {
    async fn select(&self, _: SelectRequest) -> Result<SelectAnswer, RouteError> {
        Err(RouteError {
            code: "routing_unavailable".into(),
            message: "the profile routes no summaries".into(),
            detail: None,
        })
    }

    async fn report(&self, _: ReportRequest) {}
}

/// The column names `table` has in `schema` (`main` or `src`).
fn columns(conn: &Connection, schema: &str, table: &str) -> Vec<String> {
    let mut statement = conn
        .prepare(&format!("PRAGMA {schema}.table_info(\"{table}\")"))
        .unwrap();
    statement
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
}

/// Copy the rows of `table` that `filter` selects from the attached corpus
/// into the fixture, by the columns both schemas have. Returns how many.
fn copy_rows(
    conn: &Connection,
    table: &str,
    filter: &str,
    values: &[&dyn rusqlite::ToSql],
) -> usize {
    let theirs: HashSet<String> = columns(conn, "src", table).into_iter().collect();
    let shared: Vec<String> = columns(conn, "main", table)
        .into_iter()
        .filter(|column| theirs.contains(column))
        .map(|column| format!("\"{column}\""))
        .collect();
    if shared.is_empty() {
        return 0;
    }
    let list = shared.join(",");
    conn.execute(
        &format!("INSERT OR IGNORE INTO main.\"{table}\" ({list}) SELECT {list} FROM src.\"{table}\" WHERE {filter}"),
        values,
    )
    .unwrap_or_else(|error| panic!("copying {table}: {error}"))
}

/// The sessions to set up: those `MC_HEAP_SESSIONS` lists, or the
/// `MC_HEAP_TOP` heads with the most summaries among those `mode3.db`
/// keeps state for. Each with the preset, model and window its saved state
/// names, and as many entries after its newest summary as its app-replica
/// header last counted (or `tail`, when given).
fn choose_heads(corpus: &Path, tail: Option<u64>, clock: u64) -> Vec<Head0> {
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI;
    let mode3 = Connection::open_with_flags(
        format!(
            "file:{}?mode=ro&immutable=1",
            corpus.join("mode3.db").display()
        ),
        flags,
    )
    .unwrap();
    let context = Connection::open_with_flags(
        format!(
            "file:{}?mode=ro&immutable=1",
            corpus.join("context.db").display()
        ),
        flags,
    )
    .unwrap();
    let mut states: Vec<(SessionRef, Value)> = mode3
        .prepare("SELECT runner, harness, session, state FROM sessions")
        .unwrap()
        .query_map([], |row| {
            Ok((
                SessionRef::new(
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ),
                serde_json::from_str(&row.get::<_, String>(3)?).unwrap_or(Value::Null),
            ))
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let count = |key: &SessionRef| -> usize {
        context
            .query_row(
                "SELECT COUNT(*) FROM compartments WHERE session_id = ?1 AND harness = ?2",
                params![key.session, key.harness],
                |row| row.get::<_, i64>(0),
            )
            .unwrap() as usize
    };
    if let Some(list) = std::env::var_os("MC_HEAP_SESSIONS") {
        let wanted: Vec<SessionRef> = std::fs::read_to_string(list)
            .unwrap()
            .lines()
            .filter_map(|line| {
                let mut words = line.split_whitespace();
                Some(SessionRef::new(words.next()?, words.next()?, words.next()?))
            })
            .collect();
        states.retain(|(key, _)| wanted.contains(key));
    } else {
        let top: usize = std::env::var("MC_HEAP_TOP").map_or(24, |n| n.parse().unwrap());
        let mut counted: Vec<_> = states
            .into_iter()
            .filter(|(_, state)| state["preset"] == "head" || state["preset"].is_null())
            .map(|(key, state)| (count(&key), key, state))
            .filter(|(count, _, _)| *count > 0)
            .collect();
        counted.sort_by_key(|a| std::cmp::Reverse(a.0));
        states = counted
            .into_iter()
            .take(top)
            .map(|(_, key, state)| (key, state))
            .collect();
    }
    states
        .into_iter()
        .map(|(key, state)| {
            // `compaction` is the pair (features, conditions).
            let conditions = &state["compaction"][1];
            let model = ModelRef::new(
                conditions["model"]["provider"].as_str().unwrap_or("anthropic"),
                conditions["model"]["model"].as_str().unwrap_or("claude-opus-5-5"),
            );
            let project = context
                .query_row(
                    "SELECT project_path FROM session_projects WHERE session_id = ?1 AND harness = ?2",
                    params![key.session, key.harness],
                    |row| row.get::<_, String>(0),
                )
                .ok();
            let mut ids = HashMap::new();
            let mut covered = 0u64;
            let mut summaries = 0;
            let mut statement = context
                .prepare(
                    "SELECT start_message, end_message, COALESCE(start_message_id, ''), COALESCE(end_message_id, '')
                       FROM compartments WHERE session_id = ?1 AND harness = ?2 ORDER BY sequence",
                )
                .unwrap();
            let rows = statement
                .query_map(params![key.session, key.harness], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?))
                })
                .unwrap();
            for row in rows {
                let (start, end, start_id, end_id) = row.unwrap();
                summaries += 1;
                for (ordinal, id) in [(start, start_id), (end, end_id)] {
                    if ordinal > 0 && !id.is_empty() {
                        ids.entry(ordinal as u64).or_insert(id);
                    }
                }
                covered = covered.max(end.max(0) as u64);
            }
            let mut by_id = HashMap::new();
            for (ordinal, id) in &ids {
                by_id.entry(id.clone()).or_insert(*ordinal);
            }
            let newest = mode3
                .query_row(
                    "SELECT json_extract(header, '$.newest') FROM app_read_headers WHERE runner = ?1 AND harness = ?2 AND session = ?3",
                    params![key.runner, key.harness, key.session],
                    |row| row.get::<_, Option<i64>>(0),
                )
                .ok()
                .flatten()
                .unwrap_or(0)
                .max(0) as u64;
            Head0 {
                preset: state["preset"].as_str().unwrap_or("head").to_owned(),
                project: project.map(|id| Project {
                    root: id.clone(),
                    id,
                }),
                model,
                window: conditions["context_window"].as_u64().unwrap_or(1_000_000),
                reserve: conditions["output_reserve"].as_u64().unwrap_or(64_000),
                summaries,
                covered,
                ids,
                by_id,
                tail: tail.unwrap_or_else(|| newest.saturating_sub(covered)).max(1),
                clock,
                key,
            }
        })
        .collect()
}

/// A fresh store pair under the temp directory holding the chosen sessions'
/// rows, each session's state saved as a running session has it, and the
/// view the stand-in runner applies for it.
struct Fixture {
    dir: tempfile::TempDir,
    runner: Runner,
    routes: Vec<(Route, SetupRequest)>,
}

fn fixture(corpus: &Path, heads: Vec<Head0>, root: &str) -> Fixture {
    let base = std::env::temp_dir()
        .join("magic-context")
        .join("ck-mc-memory");
    std::fs::create_dir_all(&base).unwrap();
    let dir = tempfile::Builder::new()
        .prefix("heap-")
        .tempdir_in(&base)
        .unwrap();
    let db = ContextDb::create_for_tests(&dir.path().join("context.db")).unwrap();
    db.with_connection(|conn| {
        conn.pragma_update(None, "synchronous", "OFF").unwrap();
        conn.execute(
            "ATTACH ?1 AS src",
            [format!("file:{}?mode=ro&immutable=1", corpus.join("context.db").display())],
        )
        .unwrap();
        let mut projects = BTreeMap::new();
        for head in &heads {
            let (session, harness) = (&head.key.session, &head.key.harness);
            for table in ["compartments", "session_projects", "session_facts", "message_history_index"] {
                let filter = if columns(conn, "main", table).iter().any(|c| c == "harness") {
                    "session_id = ?1 AND harness = ?2"
                } else {
                    "session_id = ?1 AND ?2 IS NOT NULL"
                };
                let copied = copy_rows(conn, table, filter, &[session as &dyn rusqlite::ToSql, harness]);
                projects.entry(table).and_modify(|n| *n += copied).or_insert(copied);
            }
            // The message index is current up to the newest summary, so the
            // background indexer reads only the tail, as after a restart.
            conn.execute(
                "INSERT INTO message_history_index (session_id, last_indexed_ordinal, dirty_floor_ordinal, updated_at, harness)
                 VALUES (?1, ?2, 0, 0, ?3)
                 ON CONFLICT(session_id) DO UPDATE SET last_indexed_ordinal = excluded.last_indexed_ordinal, dirty_floor_ordinal = 0",
                params![session, head.covered as i64, harness],
            )
            .unwrap();
            // Tags continue after the newest summary's messages.
            conn.execute(
                "INSERT INTO tags (session_id, harness, message_id, type, tag_number) VALUES (?1, ?2, ?3, 'message', ?4)",
                params![session, harness, head.mid(head.covered), head.covered as i64 * 3 + 2],
            )
            .unwrap();
        }
        let owners: Vec<String> = heads
            .iter()
            .filter_map(|head| head.project.as_ref().map(|project| project.id.clone()))
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        for owner in &owners {
            let copied = copy_rows(conn, "memories", "level = 'project' AND owner_id = ?1", &[owner as &dyn rusqlite::ToSql]);
            projects.entry("memories").and_modify(|n| *n += copied).or_insert(copied);
        }
        // Memories above the project level (the person's, an agent's) can
        // reach any session's head.
        let copied = copy_rows(conn, "memories", "level <> 'project'", &[]);
        projects.insert("memories_other_levels", copied);
        for table in ["memory_placement", "memory_embeddings"] {
            let copied = copy_rows(conn, table, "memory_id IN (SELECT id FROM main.memories)", &[]);
            projects.insert(table, copied);
        }
        conn.execute("DETACH src", []).unwrap();
        conn.pragma_update(None, "synchronous", "FULL").unwrap();
        println!("HEAP_FIXTURE rows {}", json!(projects));
    });
    let db = Arc::new(db);
    let store = Store::open(&dir.path().join("mode3.db")).unwrap();
    let settings = Settings::default();
    let runner = Runner::default();
    let mut routes = Vec::new();
    for head in heads {
        let route = Route {
            session: head.key.clone(),
            project: head.project.as_ref().map(|project| Project {
                id: project.id.clone(),
                root: root.to_owned(),
            }),
            workdir: Some(root.to_owned()),
            agent_id: None,
        };
        let newest = cursor(&head.entry(head.length()));
        let mut setup = SetupRequest::new(
            &head.preset,
            head.model.clone(),
            head.window,
            head.reserve,
            rules(),
            vec![],
            head.clock,
        )
        .with_newest(newest);
        // Seed the state a running head saved: its summaries loaded and a
        // first view that cuts through the newest one. A session without
        // summaries starts with no view, as a worker does.
        let view = (head.summaries > 0).then(|| {
            let mut session = Session::new(
                &route,
                &setup,
                mc_module::preset::features(&head.preset).unwrap(),
                Some(db.clone()),
            );
            session.load_summaries();
            let view = session
                .first_view_after_move(
                    &settings,
                    Some((head.covered, head.mid(head.covered).as_str())),
                )
                .unwrap_or_else(|error| panic!("seeding {}: {error}", head.key.session));
            store.save(&head.key, &session.durable()).unwrap();
            view
        });
        setup.applied_view = view.as_ref().map(View::applied);
        runner
            .0
            .lock()
            .unwrap()
            .insert(head.key.clone(), (Arc::new(head), view));
        routes.push((route, setup));
    }
    Fixture {
        dir,
        runner,
        routes,
    }
}

/// The module's heap now, as dhat counts it (requested bytes).
fn heap() -> dhat::HeapStats {
    dhat::HeapStats::get()
}

/// One line of the step report: the live heap after the step, what the step
/// added to it, and what it allocated in all (live or freed since).
fn step(name: &str, before: &dhat::HeapStats, extra: Value) -> dhat::HeapStats {
    let now = heap();
    println!(
        "HEAP_STEP {}",
        json!({
            "step": name,
            "live_bytes": now.curr_bytes,
            "live_blocks": now.curr_blocks,
            "added_bytes": now.curr_bytes as i64 - before.curr_bytes as i64,
            "added_blocks": now.curr_blocks as i64 - before.curr_blocks as i64,
            "allocated_bytes": now.total_bytes - before.total_bytes,
            "allocated_blocks": now.total_blocks - before.total_blocks,
            "peak_bytes_so_far": now.max_bytes,
            // SQLite allocates with the system allocator, which dhat does not
            // see: its page caches and statements are counted here instead.
            "sqlite_bytes": unsafe { rusqlite::ffi::sqlite3_memory_used() },
            "detail": extra,
        })
    );
    now
}

/// Wait until the session's worker and its app projection have handled
/// everything queued: the worker's idle answer, then a read through the app
/// projection's own queue.
async fn drain(module: &Module<Runner>, key: &SessionRef) {
    module.idle_foreground(key).await.unwrap();
    let _ = module
        .app_read()
        .read(
            "session_data.read",
            json!({"section": "meta", "session": key}),
        )
        .await;
}

/// How long loading a session's summaries from `context.db` takes, cold
/// (first read of its pages in this connection) and then warm.
fn time_loads(db: &ContextDb, key: &SessionRef) -> Value {
    let mut runs = Vec::new();
    let mut bytes = 0;
    let mut count = 0;
    for _ in 0..7 {
        let started = Instant::now();
        let summaries = db.compartments(&key.harness, &key.session).unwrap();
        runs.push(started.elapsed());
        count = summaries.len();
        bytes = summaries
            .iter()
            .map(|s| {
                s.content.len()
                    + s.title.len()
                    + s.p1.as_ref().map_or(0, |text| text.len())
                    + [&s.p2, &s.p3, &s.p4]
                        .iter()
                        .map(|p| p.as_ref().map_or(0, String::len))
                        .sum::<usize>()
            })
            .sum::<usize>();
    }
    let ms = |d: &Duration| d.as_secs_f64() * 1000.0;
    let mut warm: Vec<f64> = runs[1..].iter().map(ms).collect();
    warm.sort_by(|a, b| a.partial_cmp(b).unwrap());
    json!({
        "session": key.session, "summaries": count, "text_bytes": bytes,
        "first_ms": ms(&runs[0]), "warm_median_ms": warm[warm.len() / 2],
        "warm_min_ms": warm[0], "warm_max_ms": warm[warm.len() - 1],
    })
}

#[test]
#[ignore = "opt-in heap profile over a local copy of real stores; see the module docs"]
fn heap_profile() {
    let corpus = PathBuf::from(std::env::var_os("MC_HEAP_CORPUS").expect("MC_HEAP_CORPUS"));
    let out = PathBuf::from(std::env::var_os("MC_HEAP_OUT").expect("MC_HEAP_OUT"));
    std::fs::create_dir_all(&out).unwrap();
    let tail: Option<u64> = std::env::var("MC_HEAP_TAIL")
        .ok()
        .map(|n| n.parse().unwrap());
    // Settings and config come from scratch homes, never the person's own.
    let homes = tempfile::Builder::new()
        .prefix("homes-")
        .tempdir_in(std::env::temp_dir())
        .unwrap();
    for (name, sub) in [
        ("HOME", "home"),
        ("XDG_CONFIG_HOME", "config"),
        ("XDG_DATA_HOME", "data"),
        ("XDG_STATE_HOME", "state"),
        ("XDG_CACHE_HOME", "cache"),
    ] {
        let path = homes.path().join(sub);
        std::fs::create_dir_all(&path).unwrap();
        std::env::set_var(name, path);
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap();
    let clock = now_ms();
    let heads = choose_heads(&corpus, tail, clock);
    assert!(!heads.is_empty(), "no session to set up");
    let mut largest: Vec<(usize, SessionRef)> =
        heads.iter().map(|h| (h.summaries, h.key.clone())).collect();
    largest.sort_by_key(|a| std::cmp::Reverse(a.0));
    println!(
        "HEAP_HEADS {}",
        json!(heads.iter().map(|h| json!({"session": h.key.session, "harness": h.key.harness, "runner": h.key.runner,
            "model": format!("{}/{}", h.model.provider, h.model.model), "summaries": h.summaries, "covered": h.covered,
            "project": h.project.as_ref().map(|p| p.id.clone())})).collect::<Vec<_>>())
    );
    let built = Instant::now();
    let fixture = fixture(&corpus, heads, root.to_str().unwrap());
    println!(
        "HEAP_FIXTURE built in {:.1}s",
        built.elapsed().as_secs_f64()
    );

    // How long a summary load and a history head rendered from scratch take,
    // outside the profiler (dhat slows every allocation while it records).
    let timing_db = ContextDb::open(&fixture.dir.path().join("context.db")).unwrap();
    for (_, key) in largest.iter().take(3) {
        println!("HEAP_LOAD_TIMING {}", time_loads(&timing_db, key));
    }
    drop(timing_db);
    for (_, key) in largest.iter().take(3) {
        let (route, setup) = fixture
            .routes
            .iter()
            .find(|(route, _)| &route.session == key)
            .unwrap();
        let head = fixture.runner.head(key);
        let db = Arc::new(ContextDb::open(&fixture.dir.path().join("context.db")).unwrap());
        let mut runs = Vec::new();
        for _ in 0..3 {
            let mut session = Session::new(
                route,
                setup,
                mc_module::preset::features("head").unwrap(),
                Some(db.clone()),
            );
            let started = Instant::now();
            session.load_summaries();
            let loaded = started.elapsed();
            session
                .first_view_after_move(
                    &Settings::default(),
                    Some((head.covered, head.mid(head.covered).as_str())),
                )
                .unwrap();
            runs.push((
                loaded.as_secs_f64() * 1000.0,
                (started.elapsed() - loaded).as_secs_f64() * 1000.0,
            ));
        }
        println!(
            "HEAP_RENDER_TIMING {}",
            json!({"session": key.session, "summaries": head.summaries, "load_then_render_ms": runs})
        );
    }
    if std::env::var_os("MC_HEAP_TIMING_ONLY").is_some() {
        return;
    }

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let profiler = dhat::Profiler::builder()
        .file_name(out.join("dhat-heap.json"))
        .build();
    let start = heap();
    // The module spawns its tasks on the runtime it is made in.
    let entered = runtime.enter();
    let module = Module::new(
        fixture.runner.clone(),
        Settings::default(),
        Some(ContextDb::open(&fixture.dir.path().join("context.db")).unwrap()),
        Some(Store::open(&fixture.dir.path().join("mode3.db")).unwrap()),
    );
    let mut last = step("module_new", &start, Value::Null);
    runtime.block_on(async {
        for (route, setup) in &fixture.routes {
            module.setup(route.clone(), setup.clone()).unwrap();
            drain(&module, &route.session).await;
            let head = fixture.runner.head(&route.session);
            last = step(
                "setup",
                &last,
                json!({"session": route.session.session, "summaries": head.summaries}),
            );
        }
        for (route, _) in &fixture.routes {
            module.search_idle(&route.session).await.unwrap();
        }
        last = step("search_index_tail", &last, Value::Null);
        // The app reads a dashboard makes of one session: its metadata,
        // token breakdown, history head, one summary and a page of states.
        for (route, _) in &fixture.routes {
            let key = &route.session;
            for section in ["meta", "token_breakdown"] {
                let _ = module
                    .app_read()
                    .read("session_data.read", json!({"section": section, "session": key}))
                    .await;
            }
            let _ = module.app_read().read("context.head", json!({"session": key})).await;
            let head = fixture.runner.head(key);
            let _ = module
                .app_read()
                .read("context.compartment", json!({"session": key, "compartment_id": "0"}))
                .await;
            let ids: Vec<String> = (head.covered.saturating_sub(20)..=head.covered).map(|n| head.mid(n)).collect();
            let _ = module
                .app_read()
                .read("context.states", json!({"session": key, "message_ids": ids}))
                .await;
        }
        last = step("app_reads", &last, Value::Null);
        // One search per project, as `ctx_search` runs it.
        let mut searched = HashSet::new();
        for (route, _) in &fixture.routes {
            if searched.insert(route.project.as_ref().map(|p| p.id.clone())) {
                let _ = module
                    .tool(route, "ctx_search", json!({"query": "how is the history head rendered and cached"}))
                    .await;
            }
        }
        last = step("ctx_search", &last, Value::Null);
        // Every tokenizer family the binary holds, loaded once each: the
        // tables stay for the life of the process.
        let mut families = Vec::new();
        for family in cortexkit_tokens::Family::ALL {
            if !family.is_built() {
                continue;
            }
            let before = heap();
            let _ = cortexkit_tokens::count(family, "Measure how much this family's tables hold.");
            let now = heap();
            families.push(json!({"family": family.name(), "added_bytes": now.curr_bytes as i64 - before.curr_bytes as i64,
                "added_blocks": now.curr_blocks as i64 - before.curr_blocks as i64}));
        }
        step("tokenizer_families", &last, json!(families));
        // The history head of the largest session rendered from scratch, as a
        // fold renders it: the summaries loaded, then both head messages
        // (`m[0]`, the frozen baseline, and `m[1]`, the delta since it).
        let (_, key) = &largest[0];
        let (route, setup) = fixture.routes.iter().find(|(route, _)| &route.session == key).unwrap();
        let head = fixture.runner.head(key);
        let before = heap();
        let db = Arc::new(ContextDb::open(&fixture.dir.path().join("context.db")).unwrap());
        let mut session = Session::new(route, setup, mc_module::preset::features("head").unwrap(), Some(db));
        session.load_summaries();
        let loaded = step("render_loaded_summaries", &before, json!({"session": key.session}));
        let started = Instant::now();
        let view = session
            .first_view_after_move(&Settings::default(), Some((head.covered, head.mid(head.covered).as_str())))
            .unwrap();
        let render_ms = started.elapsed().as_secs_f64() * 1000.0;
        let view_bytes = serde_json::to_vec(&view).unwrap().len();
        step("render_head", &loaded, json!({"view_json_bytes": view_bytes, "render_ms_under_dhat": render_ms}));
        drop(view);
        drop(session);
        step("render_dropped", &before, Value::Null);
    });
    // Everything live now is what the module holds between passes; dhat's
    // end-of-run counts are taken here, with the module still alive.
    drop(profiler);
    drop(module);
    drop(entered);
    drop(runtime);
    report(&out.join("dhat-heap.json"), &out.join("heap-sites.txt"));
}

/// The function and source location of a dhat frame, without its address:
/// `0x1234: name (file:line:col)` gives `name (file:line:col)`.
fn frame_text(frame: &str) -> &str {
    frame.split_once(": ").map_or(frame, |(_, rest)| rest)
}

/// The source file a frame names, if any: `src/app_read/mod.rs` in
/// `apply_update (src/app_read/mod.rs:802:53)`.
fn frame_file(frame: &str) -> Option<&str> {
    let location = frame_text(frame).rsplit_once(" (")?.1;
    let file = location.split(':').next()?;
    (file != "???").then_some(file)
}

/// Whether a frame is code of this crate. Inlined frames name their file
/// relative to the crate that holds it, so `src/app_read/mod.rs` may be
/// ours or a dependency's: it counts as ours when this crate has that file
/// (no dependency's inlined path collides with one, `lib.rs` aside).
/// Frames without a location count by their function's path.
fn ours(frame: &str, crate_src: &Path) -> bool {
    if frame_text(frame).contains("mc_module::") && frame_file(frame).is_none() {
        return true;
    }
    let Some(file) = frame_file(frame) else {
        return false;
    };
    let file = file.strip_prefix("mc-module/").unwrap_or(file);
    let Some(relative) = file.strip_prefix("src/") else {
        return false;
    };
    relative != "lib.rs" && relative != "main.rs" && crate_src.join(relative).is_file()
}

/// What kind of block a program point allocates, from the frames between
/// the allocator and the first frame of this crate. Bytes (`Vec<u8>`, a
/// `String`) are text; a B-tree frame without them is a node (a JSON
/// object's `Map` when `serde_json` is on the path).
fn kind(frames: &[&str]) -> &'static str {
    let json = frames.iter().any(|frame| {
        let text = frame_text(frame);
        text.contains("serde_json")
            || frame_file(frame).is_some_and(|file| {
                file.starts_with("src/value/") || file.starts_with("serde_json")
            })
    });
    let has = |needle: &str| {
        frames
            .iter()
            .any(|frame| frame_text(frame).contains(needle))
    };
    let text = has("string.rs") || has("str.rs") || has("<u8") || has("Vec<u8>") || has("fmt.rs");
    if has("hashbrown") || has("RawTable") {
        return "hash table";
    }
    if !text && has("btree") {
        return if json {
            "JSON object node (BTreeMap)"
        } else {
            "BTreeMap/BTreeSet node"
        };
    }
    if has("alloc/src/sync.rs") {
        return "Arc";
    }
    match (json, text) {
        (true, true) => "JSON string or key",
        (true, false) => "JSON array (Vec<Value>) or other",
        (false, true) => "String",
        (false, false) if has("raw_vec") => "Vec",
        _ => "other",
    }
}

#[derive(Default)]
struct Site {
    end_bytes: u64,
    end_blocks: u64,
    peak_bytes: u64,
    peak_blocks: u64,
    total_bytes: u64,
    total_blocks: u64,
    kinds: BTreeMap<&'static str, (u64, u64)>,
    /// This crate's frames above the owner, nearest first.
    via: String,
}

/// Group dhat's program points by the first frame of this crate (the
/// owner), and write: live bytes at the end by kind of block and by owning
/// file, then the top owners live at the end, at the global peak, and by
/// everything they allocated.
fn report(json_path: &Path, out: &Path) {
    let crate_src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let data: Value = serde_json::from_slice(&std::fs::read(json_path).unwrap()).unwrap();
    let table: Vec<&str> = data["ftbl"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f.as_str().unwrap())
        .collect();
    let mut sites: HashMap<String, Site> = HashMap::new();
    let mut files: BTreeMap<String, (u64, u64)> = BTreeMap::new();
    let mut kinds: BTreeMap<&'static str, (u64, u64)> = BTreeMap::new();
    for point in data["pps"].as_array().unwrap() {
        let frames: Vec<&str> = point["fs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|index| table[index.as_u64().unwrap() as usize])
            .collect();
        let owner_at = frames.iter().position(|frame| ours(frame, &crate_src));
        let (owner, file) = match owner_at {
            Some(at) => (
                frame_text(frames[at]).to_owned(),
                frame_file(frames[at])
                    .unwrap_or("(no location)")
                    .trim_start_matches("mc-module/")
                    .to_owned(),
            ),
            None => {
                // Not ours: name it by the outermost frame with a location,
                // such as a dependency's own thread or static.
                let outer = frames
                    .iter()
                    .rev()
                    .find(|frame| frame_file(frame).is_some())
                    .copied()
                    .unwrap_or("[root]");
                (
                    format!("(outside mc-module) {}", frame_text(outer)),
                    "(outside mc-module)".to_owned(),
                )
            }
        };
        let below = &frames[..owner_at.unwrap_or(frames.len())];
        let kind = kind(below);
        let number = |key: &str| point[key].as_u64().unwrap_or(0);
        let site = sites.entry(owner).or_default();
        site.end_bytes += number("eb");
        site.end_blocks += number("ebk");
        site.peak_bytes += number("gb");
        site.peak_blocks += number("gbk");
        site.total_bytes += number("tb");
        site.total_blocks += number("tbk");
        let entry = site.kinds.entry(kind).or_default();
        entry.0 += number("eb");
        entry.1 += number("ebk");
        if site.via.is_empty() {
            if let Some(at) = owner_at {
                site.via = frames[at + 1..]
                    .iter()
                    .filter(|frame| ours(frame, &crate_src))
                    .take(4)
                    .map(|frame| frame_text(frame))
                    .collect::<Vec<_>>()
                    .join("  <-  ");
            }
        }
        let entry = files.entry(file).or_default();
        entry.0 += number("eb");
        entry.1 += number("ebk");
        let entry = kinds.entry(kind).or_default();
        entry.0 += number("eb");
        entry.1 += number("ebk");
    }
    let mut text = String::new();
    use std::fmt::Write;
    let mb = |bytes: u64| bytes as f64 / 1_048_576.0;
    let _ = writeln!(
        text,
        "dhat: global peak at {} µs, end at {} µs (sizes are requested bytes)\n\n== live at end, by kind of block ==",
        data["tg"], data["te"]
    );
    let mut by_kind: Vec<_> = kinds.into_iter().collect();
    by_kind.sort_by_key(|a| std::cmp::Reverse(a.1 .0));
    for (kind, (bytes, blocks)) in &by_kind {
        let _ = writeln!(
            text,
            "{:>10.2} MiB {:>10} blocks  avg {:>6} B  {kind}",
            mb(*bytes),
            blocks,
            bytes / (*blocks).max(1)
        );
    }
    let _ = writeln!(text, "\n== live at end, by the owning frame's file ==");
    let mut by_file: Vec<_> = files
        .into_iter()
        .filter(|(_, (bytes, _))| *bytes > 0)
        .collect();
    by_file.sort_by_key(|a| std::cmp::Reverse(a.1 .0));
    for (file, (bytes, blocks)) in by_file.iter().take(40) {
        let _ = writeln!(
            text,
            "{:>10.2} MiB {:>10} blocks  {file}",
            mb(*bytes),
            blocks
        );
    }
    for (title, rank) in [
        ("live at end", 0),
        ("live at the global peak", 1),
        ("allocated in all (churn)", 2),
    ] {
        let _ = writeln!(text, "\n== top owners, {title} ==");
        let value = |site: &Site| match rank {
            0 => (site.end_bytes, site.end_blocks),
            1 => (site.peak_bytes, site.peak_blocks),
            _ => (site.total_bytes, site.total_blocks),
        };
        let mut ranked: Vec<(&String, &Site)> = sites.iter().collect();
        ranked.sort_by_key(|(_, site)| std::cmp::Reverse(value(site).0));
        for (name, site) in ranked.into_iter().take(if rank == 2 { 25 } else { 60 }) {
            let (bytes, blocks) = value(site);
            if bytes == 0 {
                break;
            }
            let kinds: Vec<String> = site
                .kinds
                .iter()
                .filter(|(_, (b, _))| *b > 0)
                .map(|(kind, (b, n))| format!("{kind} {:.1} MiB/{n}", mb(*b)))
                .collect();
            let _ = writeln!(
                text,
                "{:>9.2} MiB {:>9} blocks avg {:>6} B (live at end {:.1} MiB/{}; allocated in all {:.1} MiB/{})  {name}\n      live kinds: {}\n      via: {}",
                mb(bytes),
                blocks,
                bytes / blocks.max(1),
                mb(site.end_bytes),
                site.end_blocks,
                mb(site.total_bytes),
                site.total_blocks,
                kinds.join(", "),
                site.via
            );
        }
    }
    std::fs::write(out, &text).unwrap();
    println!("{text}");
}

/// The report again from a saved profile, without running the profile.
#[test]
#[ignore = "reads MC_HEAP_OUT/dhat-heap.json from an earlier heap_profile run"]
fn heap_report() {
    let out = PathBuf::from(std::env::var_os("MC_HEAP_OUT").expect("MC_HEAP_OUT"));
    report(&out.join("dhat-heap.json"), &out.join("heap-sites.txt"));
}
