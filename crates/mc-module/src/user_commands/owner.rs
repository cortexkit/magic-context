//! The person's commands on memories, observations, the dreamer and notes:
//! their declarations, the subject each names, and the shared preview and run
//! flow. A command's subject is the level of what it changes: the person's
//! own (global) memories and observations are the computer's, workspace
//! memories a workspace's, project memories, notes and the dreamer a
//! project's, and agent memories an agent's.
//!
//! Every preview is a bounded read of `context.db`. Its version is a hash of
//! the command, its arguments and the current state of the rows it targets
//! (their revisions, statuses and update times), so it moves only when one of
//! those rows changes. A run plans again, refuses `preview_stale` when the
//! version moved, and otherwise writes through the module's own writers in
//! one transaction that checks the targets again. Its answer is kept in
//! `mode3.db` for a day ([`crate::store::Store::owner_command`]), so a
//! retried request id after a restart replays the answer instead of acting
//! twice.

use std::sync::Arc;

use cortexkit_role_user_commands::{
    Arg, ArgKind, ChoiceOption, Fact, FactValue, Preview, SubjectKind, Table, TableRow,
};
use serde_json::{json, Map};
use sha2::{Digest, Sha256};

use super::*;
use crate::context_db::ContextDb;
use crate::memory_writes::person::{OwnerRef, PersonError};

/// What a command needs from the module.
pub(crate) struct Context<'a, C> {
    /// `None` without `context.db`: nothing can be read or changed.
    pub db: Option<&'a Arc<ContextDb>>,
    /// Where answers are kept. Without it a run is refused as `unavailable`,
    /// because its answer could not be replayed.
    pub store: Option<&'a crate::store::Store>,
    pub dreamer: Option<&'a Arc<crate::dreamer::engine::Engine>>,
    /// The dreamer's settings; `None` while the person's `dreamer.disable`
    /// is set.
    pub dreamer_settings: Option<crate::dreamer::engine::Settings>,
    pub client: &'a Arc<C>,
    /// For a project subject: whether the app reads know the project.
    pub project_known: bool,
}

/// Why a run did not act: an answer to give without storing it, or a
/// refusal.
pub(super) enum Refused {
    Reply(RunReply),
    Error(ErrorBody),
}

/// What a run does once its preview's version matched.
pub(super) type Act<'a> = Box<dyn FnOnce() -> Result<RunReply, Refused> + 'a>;

/// A preview, and the write a run of it makes while it is available.
pub(super) struct Plan<'a> {
    pub preview: Preview,
    pub act: Option<Act<'a>>,
}

impl<'a> Plan<'a> {
    pub(super) fn available(preview: Preview, act: Act<'a>) -> Self {
        Self {
            preview,
            act: Some(act),
        }
    }

    pub(super) fn unavailable(version: String, reason: &str) -> Self {
        let mut preview = Preview::new(version, false);
        preview.reason = Some(reason.to_owned());
        Self { preview, act: None }
    }
}

/// The memory levels, each with the subject kind that names it.
pub(super) const LEVELS: [(&str, SubjectKind); 4] = [
    ("global", SubjectKind::Computer),
    ("workspace", SubjectKind::Workspace),
    ("project", SubjectKind::Project),
    ("agent", SubjectKind::Agent),
];

/// The verbs every level's memories take.
const MEMORY_VERBS: [&str; 5] = ["edit", "archive", "restore", "delete", "undo"];

/// The choice value that keeps a memory's category in an edit.
pub(super) const KEEP: &str = "keep";
/// The importance that keeps a memory's importance in an edit.
pub(super) const KEEP_IMPORTANCE: i64 = -1;
/// The most ids one bulk command takes.
pub(super) const MAX_IDS: usize = 200;

/// A category of the bundled memory profile, in profile order.
pub(super) struct Category {
    pub id: String,
    pub tag: String,
    pub label: String,
    pub levels: Vec<String>,
}

/// A tag as a person reads it: `PROJECT_RULES` is "Project rules".
fn label_of(tag: &str) -> String {
    let words = tag.to_lowercase().replace('_', " ");
    let mut chars = words.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}

/// The bundled profile's categories, in its order. ck-mc installs only this
/// profile, so it is every owner's profile; a describe answer names no
/// subject, so the choices can't follow one owner anyway.
pub(super) fn categories() -> &'static [Category] {
    static CATEGORIES: std::sync::OnceLock<Vec<Category>> = std::sync::OnceLock::new();
    CATEGORIES.get_or_init(|| {
        let profile = crate::memory_profile::bundled_swe().expect("the bundled profile loads");
        profile.body["categories"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|category| {
                let id = category["id"].as_str()?;
                let tag = category["tag"].as_str()?;
                Some(Category {
                    id: id.to_owned(),
                    tag: tag.to_owned(),
                    label: label_of(tag),
                    levels: category["allowed_levels"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect(),
                })
            })
            .collect()
    })
}

/// The category with this id, when memories of `level` may be filed under it.
pub(super) fn category_for(level: &str, id: &str) -> Option<&'static Category> {
    categories()
        .iter()
        .find(|category| category.id == id && category.levels.iter().any(|l| l == level))
}

fn category_options(level: &str) -> Vec<ChoiceOption> {
    categories()
        .iter()
        .filter(|category| category.levels.iter().any(|l| l == level))
        .map(|category| ChoiceOption::new(&category.id, &category.label))
        .collect()
}

/// The dreamer task kinds this build runs, in the order it registers them.
pub(super) fn task_kinds() -> Vec<&'static str> {
    crate::dreamer::tasks()
        .iter()
        .map(|task| task.kind())
        .filter(|kind| {
            crate::routing::DREAM_DEMANDS
                .iter()
                .any(|demand| demand.kind == *kind)
        })
        .collect()
}

fn ids_arg(label: &str) -> Arg {
    Arg::new("ids", ArgKind::Text, label)
}

fn command(
    id: String,
    title: String,
    summary: String,
    subject: SubjectKind,
    args: Vec<Arg>,
    effect: &str,
) -> Command {
    Command::new(
        id,
        title,
        summary,
        subject,
        args,
        vec![effect.into()],
        Some(wire::Run::new()),
    )
}

/// The owner commands' declarations, after the session commands.
pub(super) fn declarations() -> Vec<Command> {
    let mut commands = Vec::new();
    for (level, kind) in LEVELS {
        let id = |verb: &str| format!("{level}_memory_{verb}");
        let mut category = Arg::new("category", ArgKind::Choice, "Category");
        let mut options = vec![ChoiceOption::new(KEEP, "Keep current")];
        options.extend(category_options(level));
        category.options = Some(options);
        category.default = Some(KEEP.into());
        let mut content = Arg::new("content", ArgKind::Text, "New text (empty keeps it)");
        content.default = Some("".into());
        let mut importance = Arg::new(
            "importance",
            ArgKind::Number,
            "Importance 0-100 (-1 keeps it)",
        );
        importance.default = Some(KEEP_IMPORTANCE.into());
        for verb in MEMORY_VERBS {
            let (title, summary, args, effect) = match verb {
                "edit" => (
                    format!("Edit {level} memory"),
                    format!("Changes a {level} memory's text, category or importance. History keeps the old row, and undo restores it."),
                    vec![
                        Arg::new("id", ArgKind::Number, "Memory id"),
                        content.clone(),
                        category.clone(),
                        importance.clone(),
                    ],
                    "reversible",
                ),
                "archive" => (
                    format!("Archive {level} memories"),
                    format!("Archives {level} memories, so agents no longer see them. Restore brings them back."),
                    vec![ids_arg("Memory ids, comma-separated")],
                    "reversible",
                ),
                "restore" => (
                    format!("Restore {level} memories"),
                    format!("Brings archived {level} memories back, so agents see them again."),
                    vec![ids_arg("Memory ids, comma-separated")],
                    "reversible",
                ),
                "delete" => (
                    format!("Delete {level} memories"),
                    format!("Deletes {level} memories for good, with their history, embeddings and search entries. There is no undo."),
                    vec![ids_arg("Memory ids, comma-separated")],
                    "destroys",
                ),
                _ => (
                    format!("Undo a {level} memory change"),
                    format!("Restores a {level} memory as it was before one revision in its history."),
                    vec![
                        Arg::new("id", ArgKind::Number, "Memory id"),
                        Arg::new("revision", ArgKind::Number, "Revision to undo"),
                    ],
                    "reversible",
                ),
            };
            commands.push(command(id(verb), title, summary, kind, args, effect));
        }
    }
    let mut promote_category = Arg::new("category", ArgKind::Choice, "Category");
    promote_category.options = Some(category_options("global"));
    commands.push(command(
        "observation_promote".into(),
        "Save observation as memory".into(),
        "Saves an observation about you as a global memory in the category you pick. The review task skips it.".into(),
        SubjectKind::Computer,
        vec![Arg::new("id", ArgKind::Number, "Observation id"), promote_category],
        "reversible",
    ));
    commands.push(command(
        "observation_dismiss".into(),
        "Dismiss observations".into(),
        "Takes observations about you out of review without saving a memory. The review task never sees them.".into(),
        SubjectKind::Computer,
        vec![ids_arg("Observation ids, comma-separated")],
        "reversible",
    ));
    let mut task = Arg::new("task", ArgKind::Choice, "Task");
    task.options = Some(
        task_kinds()
            .into_iter()
            .map(|kind| ChoiceOption::new(kind, label_of(&kind.replace('-', "_"))))
            .collect(),
    );
    commands.push(command(
        "dreamer_run_now".into(),
        "Run dreamer task now".into(),
        "Starts one of the project's dreamer tasks now, unless the project's lock is held. The run counts as the task's scheduled run.".into(),
        SubjectKind::Project,
        vec![task],
        "reversible",
    ));
    commands.push(command(
        "dreamer_undo_run".into(),
        "Undo dreamer run".into(),
        "Reverts every memory change a dreamer run made, as one undo. A memory changed again since the run is left as it is.".into(),
        SubjectKind::Project,
        vec![Arg::new("run_id", ArgKind::Number, "Dreamer run id")],
        "reversible",
    ));
    commands.push(command(
        "note_edit".into(),
        "Edit note".into(),
        "Replaces the text of one of the project's notes.".into(),
        SubjectKind::Project,
        vec![
            Arg::new("id", ArgKind::Number, "Note id"),
            Arg::new("content", ArgKind::Text, "New text"),
        ],
        "reversible",
    ));
    commands.push(command(
        "note_dismiss".into(),
        "Dismiss notes".into(),
        "Dismisses the project's notes, so agents stop seeing them.".into(),
        SubjectKind::Project,
        vec![ids_arg("Note ids, comma-separated")],
        "reversible",
    ));
    commands.push(command(
        "note_delete".into(),
        "Delete notes".into(),
        "Deletes the project's notes for good.".into(),
        SubjectKind::Project,
        vec![ids_arg("Note ids, comma-separated")],
        "destroys",
    ));
    commands
}

/// A refusal for arguments that name rows outside the subject. It names the
/// ids, so the app can say which rows it no longer holds.
pub(super) fn not_here(field: &str, message: String, ids: &[i64]) -> ErrorBody {
    ErrorBody::new(wire::INVALID_PARAMS, message)
        .with_detail(json!({"field": format!("args.{field}"), "ids": ids}))
}

/// Read `context.db` for a preview or a run's planning. A failed read is
/// refused as `unavailable`: nothing ran.
pub(super) fn read<T>(
    db: &ContextDb,
    read: impl FnOnce(&rusqlite::Connection) -> rusqlite::Result<T>,
) -> Result<T, ErrorBody> {
    db.with_connection(|conn| read(conn)).map_err(|error| {
        tracing::warn!("ck-mc: user command read failed: {error}");
        unavailable_error()
    })
}

/// `ids` as English: `12`, `12 and 14`, `12, 14 and 15`.
pub(super) fn joined(ids: &[i64]) -> String {
    let text: Vec<String> = ids.iter().map(i64::to_string).collect();
    match text.as_slice() {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// A positive integer id argument.
pub(super) fn id(args: &Map<String, Value>, key: &str) -> Result<i64, ErrorBody> {
    args.get(key)
        .and_then(Value::as_f64)
        .filter(|value| value.fract() == 0.0 && *value >= 1.0 && *value <= 9_007_199_254_740_991.0)
        .map(|value| value as i64)
        .ok_or_else(|| invalid(&format!("args.{key}")))
}

/// A comma-separated list of 1 to [`MAX_IDS`] distinct positive integer ids.
pub(super) fn ids(args: &Map<String, Value>, key: &str) -> Result<Vec<i64>, ErrorBody> {
    let field = format!("args.{key}");
    let text = args
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(&field))?;
    let mut ids = Vec::new();
    for part in text.split(',') {
        let part = part.trim();
        let id = Some(part)
            .filter(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
            .and_then(|part| part.parse::<i64>().ok())
            .filter(|id| *id > 0 && !ids.contains(id))
            .ok_or_else(|| invalid(&field))?;
        ids.push(id);
    }
    if !(1..=MAX_IDS).contains(&ids.len()) {
        return Err(invalid(&field));
    }
    Ok(ids)
}

/// A count fact.
pub(super) fn count(label: &str, value: usize, noun: Option<&str>) -> Fact {
    let mut data = FactValue::number(value as f64);
    data.unit = Some("count".into());
    data.noun = noun.map(str::to_owned);
    Fact::new(label, data)
}

/// A plain number cell or fact value, with no unit word.
pub(super) fn plain(value: i64) -> FactValue {
    let mut data = FactValue::number(value as f64);
    data.unit = Some("count".into());
    data
}

/// A table of rows the command changes, each with its value now and after.
pub(super) fn before_after(rows: Vec<(String, FactValue, FactValue)>) -> Option<Table> {
    (!rows.is_empty()).then(|| {
        Table::new(
            vec!["Now".into(), "After".into()],
            rows.into_iter()
                .take(32)
                .map(|(label, now, after)| TableRow::new(label, vec![now, after]))
                .collect(),
        )
    })
}

/// The version of a preview: the command, its subject and arguments, and
/// what the state of the rows it targets is now. Nothing else, so other
/// rows changing (or time passing) never makes a preview stale.
pub(super) fn version(
    id: &str,
    subject: &Subject,
    args: &Map<String, Value>,
    state: Value,
) -> String {
    let stamp = json!([id, subject, args, state]);
    format!(
        "{:x}",
        Sha256::digest(serde_jcs::to_vec(&stamp).unwrap_or_default())
    )
}

/// The refusal for a run that could not take its write now: nothing ran, so
/// repeating the same request is safe.
pub(super) fn unavailable_error() -> ErrorBody {
    ErrorBody::new(
        "unavailable",
        "The command could not run now; nothing changed. Retry with the same request_id.",
    )
}

/// A person's write that did not happen, as its run answers it.
pub(super) fn person_refused(command: &str, error: PersonError) -> Refused {
    match error {
        PersonError::Stale => Refused::Reply(RunReply::new("preview_stale")),
        PersonError::Duplicate => Refused::Reply(RunReply::new("duplicate_content")),
        PersonError::Unrecordable => Refused::Reply(RunReply::new("history_unavailable")),
        PersonError::Store(error) => store_failed(command, &error),
    }
}

/// A store error during a run's write: its transaction rolled back.
pub(super) fn store_failed(command: &str, error: &str) -> Refused {
    tracing::warn!("ck-mc: user command {command} failed: {error}");
    Refused::Error(unavailable_error())
}

/// The level and owner a memory command's subject names, once the store is
/// known to hold it.
fn memory_owner(
    db: &ContextDb,
    subject: &Subject,
    project_known: bool,
) -> Result<OwnerRef, ErrorBody> {
    let unknown = || ErrorBody::new(wire::UNKNOWN_SUBJECT, "The store holds no such subject.");
    let held = |level: &str, owner: &str, also: &str| {
        db.with_connection(|conn| {
            conn.query_row(
                &format!(
                    "SELECT EXISTS(SELECT 1 FROM memories WHERE level = ?1 AND owner_id = ?2){also}"
                ),
                rusqlite::params![level, owner],
                |row| row.get::<_, bool>(0),
            )
        })
        .unwrap_or(false)
    };
    let (level, owner) = match subject {
        Subject::Computer {} => return Ok(crate::memory_writes::person::global()),
        Subject::Project { project_id } => {
            if !project_known {
                return Err(unknown());
            }
            ("project", project_id.as_str())
        }
        Subject::Workspace { workspace_id } => {
            // A workspace is known by its memories, or by Entorhinal's
            // workspace rows when it has none yet.
            if !held(
                "workspace",
                workspace_id,
                " OR EXISTS(SELECT 1 FROM workspaces WHERE CAST(id AS TEXT) = ?2 OR name = ?2)",
            ) {
                return Err(unknown());
            }
            ("workspace", workspace_id.as_str())
        }
        Subject::Agent { agent_id } => {
            if !held("agent", agent_id, "") {
                return Err(unknown());
            }
            ("agent", agent_id.as_str())
        }
        _ => return Err(unknown()),
    };
    Ok(OwnerRef {
        level: level.into(),
        owner_id: owner.into(),
    })
}

/// The project a project command names, when the app reads know it.
fn project_of(subject: &Subject, project_known: bool) -> Result<String, ErrorBody> {
    match subject {
        Subject::Project { project_id } if project_known => Ok(project_id.clone()),
        _ => Err(ErrorBody::new(
            wire::UNKNOWN_SUBJECT,
            "The store holds no such subject.",
        )),
    }
}

/// The command's own declaration.
fn declared(id: &str) -> Result<Command, ErrorBody> {
    describe()
        .commands
        .into_iter()
        .find(|command| command.id == id)
        .ok_or_else(|| ErrorBody::new(wire::UNKNOWN_COMMAND, "Unknown command."))
}

/// Plan a command: its preview, and the write a run makes while available.
fn plan<'a, C: crate::client::RunnerClient + crate::routing::Router + Send + Sync + 'static>(
    context: &'a Context<'a, C>,
    id: &str,
    subject: &Subject,
    args: &Map<String, Value>,
) -> Result<Plan<'a>, ErrorBody> {
    let project = match id {
        "dreamer_run_now" | "dreamer_undo_run" | "note_edit" | "note_dismiss" | "note_delete" => {
            Some(project_of(subject, context.project_known)?)
        }
        _ => {
            // A project memory command names the project too.
            if matches!(subject, Subject::Project { .. }) {
                project_of(subject, context.project_known)?;
            }
            None
        }
    };
    let Some(db) = context.db else {
        return Ok(Plan::unavailable(
            version(id, subject, args, Value::Null),
            "store_unavailable",
        ));
    };
    let stamp = |state: Value| version(id, subject, args, state);
    match (id, project) {
        ("observation_promote", _) => super::memories::promote(db, args, &stamp),
        ("observation_dismiss", _) => super::memories::dismiss(db, args, &stamp),
        ("dreamer_run_now", Some(project)) => {
            super::dreamer::run_now(context, db, project, args, &stamp)
        }
        ("dreamer_undo_run", Some(project)) => super::dreamer::undo_run(db, project, args, &stamp),
        ("note_edit" | "note_dismiss" | "note_delete", Some(project)) => {
            super::notes::plan(db, id, project, args, &stamp)
        }
        _ => {
            let verb = LEVELS
                .iter()
                .find_map(|(level, _)| id.strip_prefix(&format!("{level}_memory_")))
                .ok_or_else(|| ErrorBody::new(wire::UNKNOWN_COMMAND, "Unknown command."))?;
            let owner = memory_owner(db, subject, context.project_known)?;
            super::memories::plan(db, owner, verb, args, &stamp)
        }
    }
}

/// `commands.preview` for an owner command.
pub(crate) fn preview<
    C: crate::client::RunnerClient + crate::routing::Router + Send + Sync + 'static,
>(
    context: &Context<'_, C>,
    request: &ModulePreviewRequest,
) -> Result<Preview, ErrorBody> {
    let command = declared(&request.id)?;
    let args = command
        .resolve_args(&request.args)
        .map_err(|e| e.refusal())?;
    Ok(plan(context, &request.id, &request.subject, &args)?.preview)
}

/// `commands.run` for an owner command: replay a stored answer, or plan
/// again, check the preview's version and write.
pub(crate) fn run<
    C: crate::client::RunnerClient + crate::routing::Router + Send + Sync + 'static,
>(
    context: &Context<'_, C>,
    request: &ModuleRunRequest,
) -> Result<RunReply, ErrorBody> {
    let command = declared(&request.id)?;
    let args = command
        .resolve_args(&request.args)
        .map_err(|e| e.refusal())?;
    let digest = format!(
        "{:x}",
        Sha256::digest(serde_jcs::to_vec(request).map_err(|_| invalid("request"))?)
    );
    let subject =
        String::from_utf8(serde_jcs::to_vec(&request.subject).map_err(|_| invalid("subject"))?)
            .map_err(|_| invalid("subject"))?;
    let Some(store) = context.store else {
        return Err(unavailable_error());
    };
    let key = crate::store::OwnerRequest {
        subject: &subject,
        request_id: &request.request_id,
        digest: &digest,
        principal: wire::ADMITTED_CALLER,
        caller: &request.caller,
    };
    let answer = store.owner_command(&key, crate::memory_writes::now_ms(), || {
        let plan = plan(context, &request.id, &request.subject, &args).map_err(Refused::Error)?;
        if plan.preview.version != request.preview_version {
            return Err(Refused::Reply(RunReply::new("preview_stale")));
        }
        if let Some(reason) = &plan.preview.reason {
            return Err(Refused::Reply(RunReply::new(reason.clone())));
        }
        let act = plan
            .act
            .ok_or_else(|| store_failed(&request.id, "an available preview had no write"))?;
        act()
    });
    use crate::store::OwnerAnswer;
    match answer {
        OwnerAnswer::Replayed(reply)
        | OwnerAnswer::Ran(reply)
        | OwnerAnswer::RanUnrecorded(reply) => Ok(reply),
        OwnerAnswer::NotRun(Some(Refused::Reply(reply))) => Ok(reply),
        OwnerAnswer::NotRun(Some(Refused::Error(error))) => Err(error),
        OwnerAnswer::NotRun(None) => Err(unavailable_error()),
    }
}
