use mc_mock_runner::transcript::Transcript;
use mc_module::move_in::{move_in, MoveRequest};
use mc_module::move_renumber::HostMessage;
use std::ffi::{c_void, CStr};

#[derive(Default)]
struct Locks {
    transaction: Option<Instant>,
    statement: Option<Instant>,
    holds_us: Vec<u64>,
}

// SQLite calls this synchronously on the move-in connection. The boxed recorder
// outlives that connection, and the callback never calls back into SQLite SQL.
unsafe extern "C" fn trace(
    event: u32,
    context: *mut c_void,
    statement: *mut c_void,
    _: *mut c_void,
) -> i32 {
    let locks = &mut *context.cast::<Locks>();
    let stmt = statement.cast::<rusqlite::ffi::sqlite3_stmt>();
    let sql = rusqlite::ffi::sqlite3_sql(stmt);
    if sql.is_null() {
        return 0;
    }
    let sql = CStr::from_ptr(sql).to_bytes().trim_ascii_start();
    let starts = |word: &[u8]| {
        sql.get(..word.len())
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case(word))
    };
    if event == rusqlite::ffi::SQLITE_TRACE_STMT as u32 {
        if starts(b"BEGIN") {
            locks.transaction = Some(Instant::now());
        } else if locks.transaction.is_none()
            && [b"INSERT".as_slice(), b"UPDATE", b"DELETE", b"REPLACE"]
                .iter()
                .any(|word| starts(word))
        {
            locks.statement = Some(Instant::now());
        }
    } else if event == rusqlite::ffi::SQLITE_TRACE_PROFILE as u32 {
        let start = if starts(b"COMMIT") || starts(b"ROLLBACK") {
            locks.transaction.take()
        } else {
            locks.statement.take()
        };
        if let Some(start) = start {
            locks.holds_us.push(start.elapsed().as_micros() as u64);
        }
    }
    0
}

fn memory_kib() -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .unwrap()
        .lines()
        .find(|line| line.starts_with("VmHWM:"))
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap()
}

fn start_sample() -> (Instant, u64, u64) {
    // Linux resets the RSS high-water mark to current RSS on clear_refs=5.
    std::fs::write("/proc/self/clear_refs", "5").unwrap();
    let baseline = memory_kib();
    (Instant::now(), cpu_us(), baseline)
}

fn end_sample((wall, cpu, baseline): (Instant, u64, u64)) -> Value {
    let cpu = cpu_us() - cpu;
    let wall = wall.elapsed().as_micros() as u64;
    let peak = memory_kib();
    json!({"wall_us":wall,"cpu_us":cpu,"rss_baseline_kib":baseline,
        "peak_rss_kib":peak,"peak_growth_kib":peak.saturating_sub(baseline)})
}

struct ContactState {
    transcript: Transcript,
    view: View,
    reads: Vec<Value>,
    reconciliation: Option<Instant>,
    reconciliation_us: Option<u64>,
    offered: usize,
}

#[derive(Clone)]
struct ContactClient(Arc<Mutex<ContactState>>);

impl ContactClient {
    fn newest(&self) -> Cursor {
        self.0.lock().unwrap().transcript.cursor().unwrap()
    }

    fn applied(&self) -> cortexkit_role_compaction::view::AppliedView {
        self.0.lock().unwrap().view.applied()
    }
}

impl RunnerClient for ContactClient {
    async fn read(&self, _: &SessionRef, request: ReadRequest) -> Result<ReadPage, ClientError> {
        let mut state = self.0.lock().unwrap();
        let background = std::thread::current().name() == Some("mc-message-index");
        if !background {
            if matches!(request.select, Select::Mids { .. }) {
                state.reconciliation = Some(Instant::now());
            } else if let Some(start) = state.reconciliation.take() {
                state.reconciliation_us = Some(start.elapsed().as_micros() as u64);
            }
        }
        let wall = Instant::now();
        let cpu = cpu_us();
        let (entries, next) = state
            .transcript
            .read(&request.select, request.detail, request.max_bytes)
            .unwrap();
        let mut head = Head::new();
        head.newest = state.transcript.cursor();
        head.applied_view = Some(state.view.applied());
        let mut page = ReadPage::new(entries, head);
        page.next_after = next;
        let record = json!({"select":request.select,"detail":request.detail,
            "max_bytes":request.max_bytes,"entries":page.entries.len(),"next_after":next,
            "background":background,"cpu_us":cpu_us()-cpu,
            "wall_us":wall.elapsed().as_micros() as u64});
        state.reads.push(record);
        Ok(page)
    }

    async fn applied_view(&self, _: &SessionRef) -> Result<AppliedViewAnswer, ClientError> {
        let mut answer = AppliedViewAnswer::new();
        answer.view = Some(self.0.lock().unwrap().view.clone());
        Ok(answer)
    }

    async fn apply_view(
        &self,
        _: &SessionRef,
        request: ApplyViewRequest,
    ) -> Result<ApplyViewAnswer, ClientError> {
        let mut state = self.0.lock().unwrap();
        check_view(state.transcript.entries(), &request.view);
        state.view = request.view;
        state.offered += 1;
        Ok(ApplyViewAnswer::Accepted)
    }

    async fn send(&self, _: &SessionRef, _: SendRequest) -> Result<SendReply, ClientError> {
        panic!("first contact must not send reminders")
    }
    async fn send_child(&self, _: &Child, _: SendRequest) -> Result<SendReply, ClientError> {
        panic!("the 50-row live tail must not start the historian")
    }
    async fn child_result(&self, _: &Child, _: RunResultRequest) -> Result<RunResult, ClientError> {
        unreachable!()
    }
}

impl Router for ContactClient {
    async fn select(&self, _: SelectRequest) -> Result<SelectAnswer, RouteError> {
        panic!("the 50-row live tail must not start the historian")
    }
    async fn report(&self, _: ReportRequest) {
        unreachable!()
    }
}

fn check_view(entries: &[Entry], view: &View) {
    assert!(view.verify());
    cortexkit_compaction_view::render::plan(entries, &view.edits).unwrap();
    cortexkit_compaction_view::rules::check(
        entries,
        &view.edits,
        &rules(),
        cortexkit_compaction_view::rules::Floor::none(),
    )
    .unwrap();
    assert!(!view.edits.iter().any(|edit| matches!(&edit.op,
        cortexkit_role_compaction::view::EditOp::Cut { through }
            if Some(through) == entries.last().map(|entry| &entry.mid))));
}

fn body(n: usize) -> String {
    format!(
        "Component {n}: {}",
        "Preserve public API and cache boundaries; focused tests passed. ".repeat(8)
    )
}

async fn contact_drain(module: &Module<ContactClient>, key: &SessionRef) {
    module.idle_foreground(key).await.unwrap();
    module.search_idle(key).await.unwrap();
    let meta = module
        .app_read()
        .read("session_data.read", json!({"section":"meta","session":key}))
        .await
        .unwrap();
    assert_eq!(meta["row"]["compartment_in_progress"], false);
}

fn file_bytes(path: &Path) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

fn contact(size: usize) -> Value {
    assert!(size >= 1_000);
    let load = std::process::Command::new("uptime").output().unwrap();
    let load = String::from_utf8(load.stdout).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let context_path = dir.path().join("context.db");
    let store_path = dir.path().join("mode3.db");
    let archive = size - 49;
    let cut = archive - 1;
    let key = SessionRef::new("thalamus-opencode2", "opencode2", "first-contact");
    let db = ContextDb::create_for_tests(&context_path).unwrap();
    let mut old = Transcript::new(0);
    for n in 1..=archive {
        old.append_unnumbered(
            if n % 2 == 1 {
                Role::User
            } else {
                Role::Assistant
            },
            &body(n),
            n as u64 * 2000,
        );
    }
    let mut messages = vec![
        HostMessage {
            source_entry: None,
            mid: "opener".into(),
            entry: None,
            finished_summary: false,
            added: false,
            pi: None,
        },
        HostMessage {
            source_entry: None,
            mid: "native-summary".into(),
            entry: None,
            finished_summary: true,
            added: false,
            pi: None,
        },
    ];
    messages.extend(old.entries().iter().map(|entry| HostMessage {
        source_entry: None,
        mid: entry.mid.clone(),
        entry: Some(entry.ordinal),
        finished_summary: false,
        added: false,
        pi: None,
    }));
    db.with_connection(|conn| {
        conn.pragma_update(None, "synchronous", "OFF").unwrap();
        let tx = conn.transaction().unwrap();
        for entry in old.entries() {
            tx.execute("INSERT INTO tags (session_id,harness,message_id,type,tag_number,byte_size) VALUES (?1,'opencode',?2,'text',?3,512)", params![key.session,entry.mid,entry.ordinal]).unwrap();
            tx.execute("INSERT INTO source_contents (session_id,harness,tag_id,content,created_at) VALUES (?1,'opencode',?2,?3,1)", params![key.session,entry.ordinal,body(entry.ordinal as usize)]).unwrap();
            tx.execute("INSERT INTO compression_depth (session_id,harness,message_ordinal,depth) VALUES (?1,'opencode',?2,1)", params![key.session,entry.ordinal+1]).unwrap();
        }
        for (sequence, start) in (1..=archive).step_by(100).enumerate() {
            let end = (start + 99).min(archive);
            tx.execute("INSERT INTO compartments (session_id,harness,sequence,start_message,end_message,start_message_id,end_message_id,title,content,p1,p2,p3,p4,created_at) VALUES (?1,'opencode',?2,?3,?4,?5,?6,?7,?8,?8,?9,?10,?11,?12)",
                params![key.session,sequence+1,start+1,end+1,old.entries()[start-1].mid,old.entries()[end-1].mid,
                    format!("Reviewed component batch {sequence}"),
                    "Inspected implementation, preserved cache boundaries, and verified focused tests. ".repeat(20),
                    "Compatible implementation with focused verification. ".repeat(12),
                    "Preserved the public API and verified focused tests. ".repeat(4),
                    "Reviewed implementation; public API and cache boundaries preserved.",end as u64*2000]).unwrap();
        }
        tx.commit().unwrap();
        mc_module::search::messages::index(conn, "opencode", &key.session, old.entries()).unwrap();
        conn.execute("UPDATE message_history_source SET message_ordinal=message_ordinal+1", []).unwrap();
        conn.execute("UPDATE message_history_fts SET message_ordinal=message_ordinal+1", []).unwrap();
        conn.execute_batch("UPDATE message_fts_rowid_map SET message_ordinal=-message_ordinal;
            UPDATE message_fts_rowid_map SET message_ordinal=-message_ordinal+1;").unwrap();
        conn.execute("UPDATE message_history_index SET last_indexed_ordinal=last_indexed_ordinal+1", []).unwrap();
        conn.pragma_update(None,"synchronous","FULL").unwrap();
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").unwrap();
    });
    let request = MoveRequest {
        session: key.clone(),
        preset: "head".into(),
        project: None,
        model: model(),
        context_window: WINDOW,
        output_reserve: RESERVE,
        rules: rules(),
        newest: old.cursor().unwrap(),
        now: size as u64 * 2000,
        messages: Some(messages),
        source_harness: Some("opencode".into()),
        source_session: None,
        source_runner_entries: false,
        tag_floor: None,
        before_newest: None,
    };
    // Compare the traced library call with the real offline executable on an
    // identical, checkpointed copy. CLI parsing, printing and process startup
    // are included here but not in the traced move_in library call below.
    let cli_context = dir.path().join("context-cli.db");
    std::fs::copy(&context_path, &cli_context).unwrap();
    let input = json!({"session":request.session,"preset":request.preset,"project":request.project,
        "model":request.model,"context_window":request.context_window,"output_reserve":request.output_reserve,
        "rules":request.rules,"newest":request.newest,"now":request.now,"messages":request.messages,
        "source_harness":request.source_harness});
    let input = serde_json::to_vec(&input).unwrap();
    let cli_wall = Instant::now();
    let cli_cpu = child_cpu_us();
    let mut child = std::process::Command::new("/usr/bin/time")
        .args(["-f", "%M", "-o"])
        .arg(dir.path().join("cli-rss.txt"))
        .arg(env!("CARGO_BIN_EXE_ck-mc"))
        .arg("move-in")
        .current_dir(dir.path())
        .env("HOME", dir.path())
        .env("XDG_CONFIG_HOME", dir.path())
        .env("XDG_DATA_HOME", dir.path())
        .env("MAGIC_CONTEXT_DB", &cli_context)
        .env("MAGIC_CONTEXT_MODE3_STORE", dir.path().join("mode3-cli.db"))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    use std::io::Write;
    child.stdin.take().unwrap().write_all(&input).unwrap();
    let output = child.wait_with_output().unwrap();
    let cli_cpu = child_cpu_us() - cli_cpu;
    let cli_wall = cli_wall.elapsed().as_micros() as u64;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let cli_peak: u64 = std::fs::read_to_string(dir.path().join("cli-rss.txt"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let cli_moved: Value = serde_json::from_slice(&output.stdout).unwrap();
    let cli_sample = json!({"wall_us":cli_wall,"cpu_us":cli_cpu,"peak_rss_kib":cli_peak,
        "input_bytes":input.len(),"output_bytes":output.stdout.len(),"stderr":String::from_utf8_lossy(&output.stderr)});
    let mut locks = Box::<Locks>::default();
    db.with_connection(|conn| unsafe {
        assert_eq!(
            rusqlite::ffi::sqlite3_trace_v2(
                conn.handle(),
                (rusqlite::ffi::SQLITE_TRACE_STMT | rusqlite::ffi::SQLITE_TRACE_PROFILE) as u32,
                Some(trace),
                (&mut *locks as *mut Locks).cast()
            ),
            rusqlite::ffi::SQLITE_OK
        );
    });
    let sample = start_sample();
    let moved = move_in(
        db,
        &Store::open(&store_path).unwrap(),
        &Settings::default().into(),
        &request,
    )
    .unwrap();
    assert_eq!(
        serde_json::to_value(&moved.view).unwrap(),
        cli_moved["view"]
    );
    let move_sample = end_sample(sample);
    assert!(locks.transaction.is_none());
    assert!(!locks.holds_us.is_empty());
    let route = Route {
        session: key.clone(),
        project: None,
        workdir: None,
        agent_id: None,
    };
    let features = mc_module::preset::features("head").unwrap();
    let setup = SetupRequest::new(
        "head",
        model(),
        WINDOW,
        RESERVE,
        rules(),
        vec![],
        size as u64 * 2000,
    )
    .with_newest(request.newest.clone());
    let mut session = Session::new(
        &route,
        &setup,
        features,
        Some(Arc::new(ContextDb::open(&context_path).unwrap())),
    );
    session.load_summaries();
    let sample = start_sample();
    let view = session
        .first_view_after_move(
            &Settings::default(),
            Some((cut as u64, old.entries()[cut - 1].mid.as_str())),
        )
        .unwrap();
    let build_sample = end_sample(sample);
    assert_eq!(view, moved.view);
    drop(session);
    drop(request);
    drop(old);
    let mut transcript = Transcript::new(moved.tag_checkpoint);
    for n in 1..=size {
        let role = if n % 2 == 1 {
            Role::User
        } else {
            Role::Assistant
        };
        if n <= cut {
            transcript.append_unnumbered(role, &body(n), n as u64 * 2000);
        } else {
            transcript.append(
                role,
                None,
                vec![(Seal::None, PartBody::Text { text: body(n).into() })],
                None,
                None,
                n as u64 * 2000,
            );
        }
    }
    let sample = start_sample();
    check_view(transcript.entries(), &view);
    let check_sample = end_sample(sample);
    let view_bytes = serde_json::to_vec(&view).unwrap().len();
    let client = ContactClient(Arc::new(Mutex::new(ContactState {
        transcript,
        view,
        reads: vec![],
        reconciliation: None,
        reconciliation_us: None,
        offered: 0,
    })));
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        // Keep a read connection open: closing the last connection checkpoints
        // and removes the WAL, hiding the bytes generated during Setup.
        let probe = Connection::open(&store_path).unwrap();
        probe.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").unwrap();
        let db_before = file_bytes(&store_path);
        let io_trace = std::env::var_os("FIRST_CONTACT_IO").is_some();
        if io_trace {
            eprintln!("FIRST_CONTACT_SETUP_BEGIN");
        }
        let sample = start_sample();
        let module = Module::new(client.clone(),Settings::default(),Some(ContextDb::open(&context_path).unwrap()),Some(Store::open(&store_path).unwrap()));
        let mut setup = SetupRequest::new("head",model(),WINDOW,RESERVE,rules(),vec![],size as u64*2000).with_newest(client.newest());
        setup.applied_view = Some(client.applied());
        module.setup(route,setup).unwrap();
        contact_drain(&module,&key).await;
        let setup_sample = end_sample(sample);
        if io_trace {
            eprintln!("FIRST_CONTACT_SETUP_END");
        }
        let mode3_wal = file_bytes(&dir.path().join("mode3.db-wal"));
        let db_after = file_bytes(&store_path);
        let (reads,reconciliation) = {
            let mut state = client.0.lock().unwrap();
            assert_eq!(state.offered,0,"Setup should adopt the installed move view");
            (std::mem::take(&mut state.reads),state.reconciliation_us)
        };
        let entries = {
            let mut state = client.0.lock().unwrap();
            vec![state.transcript.append(Role::Assistant,None,
                vec![(Seal::None,PartBody::Text{text:body(size+1).into()})],None,None,(size+1) as u64*2000).clone()]
        };
        let conditions: Conditions = serde_json::from_value(json!({"model":model(),"context_window":WINDOW,
            "output_reserve":RESERVE,"rules":rules(),"now":(size+1)*2000,"last_prompt_tokens":20_000})).unwrap();
        let mut notice = NoticeRequest::new(1,conditions).with_newest(client.newest());
        notice.entries=entries;
        notice.applied_view=Some(client.applied());
        let sample = start_sample();
        assert_eq!(module.notice(&key,notice).unwrap(),NoticeAnswer::Received);
        contact_drain(&module,&key).await;
        let notice_sample = end_sample(sample);
        let state = client.0.lock().unwrap();
        assert_eq!(state.offered,0,"ordinary notice must not rebuild");
        assert!(state.reads.is_empty(),"contiguous notice must share its new entry with search");
        json!({"size":size,"archive":archive,"cut":cut,"summaries":archive.div_ceil(100),"load":load.trim(),
            "move_in":move_sample,"move_in_cli":cli_sample,"write_transactions":locks.holds_us.len(),"lock_holds_us":locks.holds_us,
            "view_build":build_sample,"view_check":check_sample,"view_bytes":view_bytes,"view_edits":moved.view.edits.len(),
            "setup":setup_sample,"setup_reads":reads,"reconciliation_boundary_us":reconciliation,
            "mode3_setup_wal_bytes":mode3_wal,"mode3_main_growth_bytes":db_after.saturating_sub(db_before),
            "notice":notice_sample})
    })
}

#[test]
fn first_contact_fixture_smoke() {
    let result = contact(1_000);
    assert_eq!(result["view_edits"], 3);
    let reads = result["setup_reads"].as_array().unwrap();
    assert_eq!(
        reads
            .iter()
            .map(|r| r["entries"].as_u64().unwrap())
            .sum::<u64>(),
        52
    );
}

#[test]
#[ignore = "release first-contact measurement, one size per process"]
#[allow(clippy::assertions_on_constants)]
fn first_contact_cost() {
    assert!(!cfg!(debug_assertions), "measure an optimized build");
    let size = std::env::var("FIRST_CONTACT_SIZE")
        .unwrap()
        .parse()
        .unwrap();
    println!("FIRST_CONTACT {}", contact(size));
}
