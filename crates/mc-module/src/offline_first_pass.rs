//! `ck-mc offline first-pass`: run a moved session's first engine pass in the
//! restart window, so its cost is never paid by a live session.
//!
//! ```text
//! ck-mc offline first-pass --session <id> --pages <jsonl> --setup <json>
//!     --opencode-db <p> --context-db <p> --store-db <p>
//! ```
//!
//! It runs after `ck-mc offline move-session` and after THALAMUS's export, with
//! OpenCode, THALAMUS and ck-mc stopped, one session per invocation. Like the
//! move it prints one JSON object on stdout and a one-line verdict on stderr
//! (`SESSION PREPARED|UNCHANGED|REFUSED|INCOMPLETE`). Exit codes: 0 when
//! prepared or unchanged, 2 on a refusal, 1 when a run was interrupted.
//!
//! **Inputs.**
//! - `--pages`: THALAMUS's export, one `session.read` page per line. Each line
//!   is the bare `ReadPage` body (`cortexkit-role-llm-runner` 0.4.0
//!   `read::ReadPage`) that a descriptors-mode `session.read` would answer,
//!   never wrapped in a reply envelope, and the pages chain from the move's
//!   `message_count` to the end of the transcript. Every message carries the
//!   runner's `digest` and `part_digests`.
//! - `--setup`: `{"project_root": <abs path>, "runner_module": <module id>,
//!   "runner_describe": <the runner's role.describe answer>,
//!   "request": <the exact compaction.setup request the runner will send>}`.
//!   The first live Setup must equal `request` (ignoring `request_id` and
//!   `now`) and arrive from `runner_module` on `project_root`, and the live
//!   runner's `role.describe` must equal `runner_describe`, or the prepared
//!   state is discarded.
//!
//! The format contract, with every input the pass reads, is
//! `.cortexkit/internal-docs/designs/mode3-offline-first-pass-contract.md`.
//!
//! **What it does.** It checks that no other process holds a store (the same
//! `lsof` check as the move), that the session was moved, that the pages chain
//! and are bare, that every message carries the runner's digests, and that
//! their tag numbers start right above the moved checkpoint. Then it opens the stores as ck-mc does and drives ck-mc's own
//! lane: Setup, the read of the pages, ingest with the moved-session binding,
//! and the engine's first pass and commit. The record's last save stores the
//! entry input proof (`providers::async_provider::offline_first_pass`).
//!
//! **Rerun.** On a session it already prepared from the same pages, Setup and
//! inputs it writes nothing and answers `unchanged`; anything else is refused
//! by name. An unadopted record with an older proof version is prepared again
//! from the authoritative move checkpoint in a fresh generation.
//!
//! **Refusals.** `usage`, `stores_in_use`, `offline_exclusivity_unproven`,
//! `store_missing`, `store_unreadable`, `session_not_moved`,
//! `moved_session_record_unreadable`, `moved_session_codec_mismatch`,
//! `setup_unreadable`,
//! `setup_session_mismatch`, `pages_unreadable`,
//! `pages_bare_wrapped_mismatch`, `pages_not_chained`, `served_digest_missing`,
//! `checkpoint_mismatch`, `tag_checkpoint_unsupported`, `setup_refused`,
//! `first_pass_refused`, `async_record_exists`,
//! `offline_run_incomplete`, `offline_state_differs`.

use crate::offline_move::{
    self, check_holders, HolderCheck, Lsof, MoveRecord, Refusal, StorePaths,
};
use crate::providers::codec::Codec;
use crate::providers::offline_first_pass_engine::{
    OfflineError, OfflineOutcome, OfflineReport, OfflineSetup, PagesRunner, ServedPage,
};
use cortexkit_role_compaction_provider::setup::SetupRequest;
use cortexkit_role_llm_runner::{read::ReadPage, tags};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

/// The arguments of one run.
#[derive(Debug, Clone)]
pub struct Args {
    pub paths: StorePaths,
    pub session: String,
    pub pages: PathBuf,
    pub setup: PathBuf,
}

/// The `--setup` file.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SetupFile {
    project_root: PathBuf,
    runner_module: String,
    /// The runner's own `role.describe` answer (the answer inside its reply
    /// envelope). The offline Setup reads it where a live Setup asks the
    /// runner, so a moved session's `tag_checkpoint` check runs offline too.
    runner_describe: Value,
    request: Value,
}

/// Exported pages that passed every check, ready to serve.
pub(crate) struct Pages {
    pub lineage: String,
    pub served: Vec<ServedPage>,
    pub entries: u64,
    /// The smallest runner tag number in the pages, if any part is tagged.
    pub lowest_tag: Option<u64>,
}

fn refusal(code: &'static str, detail: impl Into<String>) -> Refusal {
    Refusal::new(code, detail)
}

/// Parse and check the export. Each line must be a bare `ReadPage`: a line
/// that holds its page inside another object (a reply envelope) is refused as
/// `pages_bare_wrapped_mismatch`. Every message must carry the runner's
/// content digests, one `part_digests` row per top-level part of the message
/// under `codec`'s serializer profile, keyed exactly as its tag rows are and
/// in the same order, as a live descriptors-mode read requires; a message
/// without them is refused as `served_digest_missing`, because ck-mc never
/// computes them in the runner's place. The pages must chain: the first starts
/// at the move checkpoint's `origin`, ordinals are contiguous inside and across
/// pages, every page but the last names the next page's first ordinal in
/// `next_from_ordinal`, the last names none, and every page carries the same lineage.
pub(crate) fn parse_pages(
    reader: impl BufRead,
    codec: Codec,
    origin: u64,
) -> Result<Pages, Refusal> {
    let mut served: Vec<ServedPage> = Vec::new();
    let mut lineage: Option<String> = None;
    let mut expected = origin;
    let mut pending_next: Option<u64> = None;
    let mut finished = false;
    let mut lowest_tag: Option<u64> = None;
    let mut blank_at = None;
    for (index, line) in reader.lines().enumerate() {
        let number = index + 1;
        let line = line.map_err(|error| refusal("pages_unreadable", error.to_string()))?;
        if line.trim().is_empty() {
            blank_at.get_or_insert(number);
            continue;
        }
        if let Some(blank) = blank_at {
            return Err(refusal(
                "pages_unreadable",
                format!("line {blank} is blank; one page per line, with no blank lines"),
            ));
        }
        let value: Value = serde_json::from_str(&line)
            .map_err(|error| refusal("pages_unreadable", format!("line {number}: {error}")))?;
        let Value::Object(fields) = &value else {
            return Err(refusal(
                "pages_bare_wrapped_mismatch",
                format!("line {number} is not a bare ReadPage object"),
            ));
        };
        if !fields.contains_key("messages") {
            let wrapper = fields
                .iter()
                .find(|(_, member)| member.get("messages").is_some())
                .map(|(name, _)| name.clone());
            return Err(match wrapper {
                Some(name) => refusal(
                    "pages_bare_wrapped_mismatch",
                    format!("line {number} wraps its page in `{name}`; each line must be the bare ReadPage"),
                ),
                None => refusal(
                    "pages_unreadable",
                    format!("line {number} has no `messages`"),
                ),
            });
        }
        let page: ReadPage = serde_json::from_value(value)
            .map_err(|error| refusal("pages_unreadable", format!("line {number}: {error}")))?;
        let chain =
            |detail: String| refusal("pages_not_chained", format!("line {number}: {detail}"));
        if finished {
            return Err(chain(
                "a page follows the last page (one with no next_from_ordinal)".into(),
            ));
        }
        let Some(page_lineage) = page.lineage_id.clone() else {
            return Err(chain("the page has no lineage_id".into()));
        };
        match &lineage {
            None => lineage = Some(page_lineage),
            Some(held) if *held != page_lineage => {
                return Err(chain(format!(
                    "lineage {page_lineage} after lineage {held}"
                )))
            }
            Some(_) => {}
        }
        let (Some(first), Some(last)) = (page.messages.first(), page.messages.last()) else {
            return Err(chain("the page holds no messages".into()));
        };
        if pending_next.is_some_and(|next| next != first.ordinal) {
            return Err(chain(format!(
                "the previous page named {} next, but this page starts at {}",
                pending_next.unwrap_or_default(),
                first.ordinal
            )));
        }
        let (first, last) = (first.ordinal, last.ordinal);
        for message in &page.messages {
            if message.ordinal != expected {
                return Err(chain(format!(
                    "ordinal {} where {expected} was expected",
                    message.ordinal
                )));
            }
            expected += 1;
            message
                .check_descriptor_rows(codec.wire_id())
                .map_err(|reason| {
                    refusal(
                        "served_digest_missing",
                        format!(
                            "line {number}: message {} at ordinal {}: {reason}",
                            message.mid, message.ordinal
                        ),
                    )
                })?;
            for row in &message.tags {
                if let Some(tag) = &row.tag {
                    let number = tags::parse_tag(tag).ok_or_else(|| {
                        refusal(
                            "pages_unreadable",
                            format!("line {number}: malformed tag {tag:?}"),
                        )
                    })?;
                    lowest_tag = Some(lowest_tag.map_or(number, |low| low.min(number)));
                }
            }
        }
        match page.next_from_ordinal {
            Some(next) if next != last + 1 => {
                return Err(chain(format!(
                    "next_from_ordinal {next} after a page ending at {last}"
                )))
            }
            Some(next) => pending_next = Some(next),
            None => {
                pending_next = None;
                finished = true;
            }
        }
        served.push(ServedPage { first, last, line });
    }
    if let Some(next) = pending_next {
        return Err(refusal(
            "pages_not_chained",
            format!("the last page names ordinal {next} next, but no page follows"),
        ));
    }
    let Some(lineage) = lineage else {
        return Err(refusal("pages_not_chained", "the export holds no page"));
    };
    Ok(Pages {
        lineage,
        served,
        entries: expected - origin,
        lowest_tag,
    })
}

/// The pages' tag numbers start right above the moved checkpoint: the runner
/// numbers the parts after the cut upward from `tag_checkpoint + 1`. Pages
/// with no tagged part carry no number that could disagree.
pub(crate) fn check_checkpoint(record: &MoveRecord, pages: &Pages) -> Result<(), Refusal> {
    match pages.lowest_tag {
        Some(lowest) if Some(lowest) != record.tag_checkpoint.checked_add(1) => Err(refusal(
            "checkpoint_mismatch",
            format!(
                "the moved checkpoint is {}, but the pages' tags start at {lowest} (checkpoint {})",
                record.tag_checkpoint,
                lowest.saturating_sub(1)
            ),
        )),
        _ => Ok(()),
    }
}

fn read_setup(path: &Path, session: &str) -> Result<OfflineSetup, Refusal> {
    let text = std::fs::read_to_string(path)
        .map_err(|error| refusal("setup_unreadable", format!("{}: {error}", path.display())))?;
    let file: SetupFile = serde_json::from_str(&text)
        .map_err(|error| refusal("setup_unreadable", error.to_string()))?;
    let request: SetupRequest = serde_json::from_value(file.request)
        .map_err(|error| refusal("setup_unreadable", format!("request: {error}")))?;
    if !file.project_root.is_absolute() {
        return Err(refusal("setup_unreadable", "project_root must be absolute"));
    }
    if file.runner_module.trim().is_empty() {
        return Err(refusal("setup_unreadable", "runner_module is empty"));
    }
    // Session handles are compared as exact bytes, as a live Setup compares
    // them with its route.
    if request.session != session {
        return Err(refusal(
            "setup_session_mismatch",
            format!(
                "--session is {session:?}, but the Setup request names {:?}",
                request.session
            ),
        ));
    }
    cortexkit_role_llm_runner::describe::check_describe(&file.runner_describe).map_err(
        |problems| refusal("setup_unreadable", format!("runner_describe: {problems:?}")),
    )?;
    Ok(OfflineSetup {
        project_root: file.project_root,
        runner_module: file.runner_module,
        runner_describe: file.runner_describe,
        request,
    })
}

/// Everything a run needs once the checks passed.
pub(crate) struct Checked {
    pub record: MoveRecord,
    pub setup: OfflineSetup,
    pub pages: Pages,
}

/// The checks that come before any store is opened for writing: the holder
/// check, the moved record, the Setup file, and the pages with their
/// checkpoint.
pub(crate) fn check(args: &Args, holders: &dyn HolderCheck) -> Result<Checked, Refusal> {
    check_holders(&args.paths, holders)?;
    for path in [&args.paths.context_db, &args.paths.store_db] {
        if !path.exists() {
            return Err(refusal(
                "store_missing",
                format!("{} does not exist", path.display()),
            ));
        }
    }
    let record = {
        let conn = offline_move::open_read_only(&args.paths.context_db)?;
        match offline_move::read_move_record(&conn, &args.session)
            .map_err(|error| refusal("store_unreadable", error.to_string()))?
        {
            Some(Ok(record)) => record,
            Some(Err(reason)) => return Err(refusal("moved_session_record_unreadable", reason)),
            None => {
                return Err(refusal(
                    "session_not_moved",
                    "run `ck-mc offline move-session` for this session first",
                ))
            }
        }
    };
    let setup = read_setup(&args.setup, &args.session)?;
    // The pages' part counts depend on the serializer profile the Setup
    // names, which selects the codec exactly as a live Setup does.
    let codec =
        Codec::from_params(&Value::Object(setup.request.params.clone())).map_err(|error| {
            refusal(
                "setup_unreadable",
                format!("request.params.serializer_profile: {error:?}"),
            )
        })?;
    if codec.wire_id() != record.codec_profile.serializer
        || record.codec_profile.native_index != "part_index"
    {
        return Err(refusal(
            "moved_session_codec_mismatch",
            "Setup's codec differs from the offline move manifest",
        ));
    }
    let file = std::fs::File::open(&args.pages).map_err(|error| {
        refusal(
            "pages_unreadable",
            format!("{}: {error}", args.pages.display()),
        )
    })?;
    let pages = parse_pages(std::io::BufReader::new(file), codec, record.message_count)?;
    check_checkpoint(&record, &pages)?;
    Ok(Checked {
        record,
        setup,
        pages,
    })
}

/// Open the two ck-mc stores as the module does at startup: `store.db`, with
/// `context.db` attached as its domain.
fn open_store(paths: &StorePaths) -> Result<mc_store::McStore, String> {
    let private = crate::config::private_storage_permissions_enabled();
    let descriptor = cortexkit_store_types::StorageDescriptor {
        module_id: crate::DEFAULT_MODULE_ID.into(),
        storage_namespace: "mc_cache".into(),
        isolation: cortexkit_store_types::Isolation::Module,
        backend: cortexkit_store_types::StorageBackend::Sqlite {
            path: paths.store_db.to_string_lossy().into_owned(),
        },
    };
    let store = mc_store::McStore::open_with_private_permissions(&descriptor, private)
        .map_err(|error| error.to_string())?;
    crate::single_store_reads::attach_with_private_permissions(&store, &paths.context_db, private)
        .map_err(|error| error.to_string())?;
    Ok(store)
}

/// What one run ended in, with what the CLI prints.
#[derive(Debug)]
pub enum RunError {
    Refused(Refusal),
    Interrupted(String),
}

impl From<Refusal> for RunError {
    fn from(refusal: Refusal) -> Self {
        Self::Refused(refusal)
    }
}

fn run_error(error: OfflineError) -> RunError {
    match error {
        OfflineError::Refused(code, detail) => RunError::Refused(Refusal::new(code, detail)),
        OfflineError::Interrupted(reason) => RunError::Interrupted(reason),
    }
}

/// Run the pass on a handler whose store is open and whose runner serves
/// `checked.pages`.
pub(crate) async fn execute(
    handler: &crate::McHandler,
    checked: &Checked,
) -> Result<OfflineOutcome, RunError> {
    handler
        .offline_first_pass(&checked.setup)
        .await
        .map_err(run_error)
}

/// The run the CLI makes: check, open the stores, build a handler with the
/// production configuration and a runner over the pages, and execute.
pub fn run(args: &Args, holders: &dyn HolderCheck) -> Result<Value, RunError> {
    let started = Instant::now();
    let mut checked = check(args, holders)?;
    let store = open_store(&args.paths)
        .map_err(|reason| RunError::Refused(refusal("store_unreadable", reason)))?;
    let mut handler = crate::McHandler::new();
    handler.store.set(Arc::new(store)).ok();
    handler.provider_runner = Arc::new(
        PagesRunner::new(
            std::mem::take(&mut checked.pages.served),
            checked.setup.runner_describe.clone(),
        )
        .with_move_record(&checked.record),
    );
    // The engine pass is synchronous work inside async functions; a runtime of
    // its own on its own thread keeps it apart from the caller's.
    let outcome = std::thread::scope(|scope| {
        scope
            .spawn(|| {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(|error| RunError::Interrupted(error.to_string()))?
                    .block_on(execute(&handler, &checked))
            })
            .join()
            .unwrap_or_else(|_| Err(RunError::Interrupted("the first pass panicked".into())))
    })?;
    Ok(report(&outcome, &checked, started))
}

/// Peak resident memory of this process (Linux `VmHWM`), in KiB.
pub(crate) fn peak_rss_kib() -> Option<u64> {
    std::fs::read_to_string("/proc/self/status")
        .ok()?
        .lines()
        .find_map(|line| line.strip_prefix("VmHWM:"))?
        .trim()
        .trim_end_matches("kB")
        .trim()
        .parse()
        .ok()
}

fn report(outcome: &OfflineOutcome, checked: &Checked, started: Instant) -> Value {
    let (status, report): (&str, &OfflineReport) = match outcome {
        OfflineOutcome::Prepared(report) => ("prepared", report),
        OfflineOutcome::Unchanged(report) => ("unchanged", report),
    };
    json!({
        "status": status,
        "session": checked.record.session,
        "session_ref": report.reference,
        "generation": report.generation,
        "entries": report.proof.count,
        "exported_entries": checked.pages.entries,
        "lineage": report.proof.lineage,
        "exported_lineage": checked.pages.lineage,
        "proof": report.proof.digest,
        "published_views": report.published_views,
        "certified": report.certified,
        "tag_checkpoint": checked.record.tag_checkpoint,
        "wall_ms": started.elapsed().as_millis() as u64,
        "peak_rss_kib": peak_rss_kib(),
    })
}

const USAGE: &str = "usage: ck-mc offline first-pass --session <id> --pages <jsonl> \
     --setup <json> --opencode-db <path> --context-db <path> --store-db <path>";

fn parse_args(args: &[String]) -> Result<Args, String> {
    let (mut session, mut pages, mut setup) = (None, None, None);
    let (mut opencode_db, mut context_db, mut store_db) = (None, None, None);
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        let mut value = || {
            iter.next()
                .cloned()
                .ok_or_else(|| format!("{arg} needs a value"))
        };
        match arg.as_str() {
            "--session" => session = Some(value()?),
            "--pages" => pages = Some(PathBuf::from(value()?)),
            "--setup" => setup = Some(PathBuf::from(value()?)),
            "--opencode-db" => opencode_db = Some(PathBuf::from(value()?)),
            "--context-db" => context_db = Some(PathBuf::from(value()?)),
            "--store-db" => store_db = Some(PathBuf::from(value()?)),
            other => return Err(format!("unknown argument {other:?}; {USAGE}")),
        }
    }
    match (session, pages, setup, opencode_db, context_db, store_db) {
        (
            Some(session),
            Some(pages),
            Some(setup),
            Some(opencode_db),
            Some(context_db),
            Some(store_db),
        ) => Ok(Args {
            paths: StorePaths {
                opencode_db,
                context_db,
                store_db,
            },
            session,
            pages,
            setup,
        }),
        _ => Err(USAGE.into()),
    }
}

/// `ck-mc offline first-pass <args>`.
pub fn cli_main(args: &[String]) -> i32 {
    let args = match parse_args(args) {
        Ok(args) => args,
        Err(usage) => {
            println!(
                "{}",
                json!({"status":"refused","refusal":{"code":"usage","detail":usage}})
            );
            return 2;
        }
    };
    let session = args.session.clone();
    match run(&args, &Lsof) {
        Ok(report) => {
            let verdict = if report["status"] == "unchanged" {
                "SESSION UNCHANGED"
            } else {
                "SESSION PREPARED"
            };
            eprintln!(
                "{verdict} {session} entries={} proof={} wall_ms={} peak_rss_kib={}",
                report["entries"], report["proof"], report["wall_ms"], report["peak_rss_kib"]
            );
            println!("{report}");
            0
        }
        Err(RunError::Refused(refusal)) => {
            println!(
                "{}",
                json!({"status":"refused","session":session,"refusal":{"code":refusal.code,"detail":refusal.detail}})
            );
            eprintln!(
                "SESSION REFUSED {session} code={}: {}. No first pass was stored; the first live read runs the ordinary one.",
                refusal.code, refusal.detail
            );
            2
        }
        Err(RunError::Interrupted(reason)) => {
            println!(
                "{}",
                json!({"status":"interrupted","session":session,"error":reason})
            );
            eprintln!(
                "SESSION INCOMPLETE {session}: {reason}. No proof was stored, so the first live read never adopts this run; restore the window's backups to run it again."
            );
            1
        }
    }
}

#[cfg(test)]
#[path = "offline_first_pass_tests.rs"]
pub(crate) mod tests;
