//! The `reflect-events` task: find the mistakes that keep coming back in a
//! project's work, and write each as one learning every later session reads.
//!
//! It replaces 0.49's retrospective, which had a model scan the person's own
//! lines in recent transcripts for corrections. It reads only what the summarizer
//! already stored: the project's `causal_incident` and `trajectory_correction`
//! events (`compartment_events`), from the sessions `session_projects` names
//! as the project's. Events are new when they arrived after the task's
//! watermark (`dream_schedules.watermark_json`, `{"event": <id>}`).
//!
//! The module groups before a model reads: incidents by the surface they
//! happened on, corrections by what made the agent change (the profile's
//! `group_events_by`). A group goes to the model only when it holds a new
//! event and events from at least the profile's `min_proof_count` days.
//! Days, not sessions: an agent that works with the person for weeks keeps
//! its whole history in one long session, so a mistake that keeps coming back
//! there comes back on different days. The day is the event's calendar date
//! in the machine's local time.
//! A run reads only events of the last [`WINDOW_DAYS`] days, new ones
//! included: a first run finds every stored event new, and rules drawn from
//! months-old work describe code and habits that have since moved on. A group
//! shows its new events and fills up to [`GROUP_EVENTS`] with its newest
//! older ones, each with every field the summarizer stored. Next to the groups, a message shows the project's
//! live memories closest to each group's events, by meaning when the
//! embedding provider and stored vectors allow it and by words otherwise,
//! so the model doesn't write a memory that already exists. Groups are
//! packed into messages of about [`REQUEST_TOKENS`] tokens.
//!
//! The model answers one `<learnings>` list ([`learnings`]). The module
//! checks each learning on its own and drops one that fails with its reason
//! ([`ReflectBatch::write`]): it must cite only events of its message, from
//! at least `min_proof_count` days and at least one of them new, name a
//! category of its route, hold no quotation mark, date, frustration phrase
//! or copied run of the events' words, fit the memory size cap, and repeat
//! no live memory. A project memory is written under the project's lock in
//! the batch's transaction, with a history row naming the run, so the run
//! can be undone; an observation about the person joins the queue the global
//! review reads. The watermark moves to the newest event the run read once
//! its last message is applied, or at once when no group was worth sending.

use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{DateTime, Local, NaiveDate};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Value};

use crate::count::Counter;
use crate::dreamer::run::{TaskInput, TaskReply};
use crate::dreamer::store::OwnerKey;
use crate::dreamer::task::{task_prompts, Applied, Batch, Owner, Planning, Task, TaskContext};
use crate::embedding::Provider;
use crate::memory_levels::{created, CreateKind, NewRow, OriginProfile, Placer};
use crate::memory_profile::{Profile, FRAMES};
use crate::memory_writes::{
    history_json, history_snapshot, insert_memory, normalized_hash, now_ms, record_history, History,
};
use crate::summary::fit::Window;

pub(crate) mod learnings;

use learnings::{parse_learnings, text_refusal, Learning};

/// The kind memory profiles name.
pub(crate) const KIND: &str = "reflect-events";
/// Magic Context's frame the task's message fills.
pub(crate) const INPUT_FRAME: &str = "dreamer/reflect-events.input";
/// A group shows at most this many events.
pub(crate) const GROUP_EVENTS: usize = 30;
/// A run reads events from at most this many days back, new or older.
pub(crate) const WINDOW_DAYS: i64 = 90;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;
/// Each group brings at most this many existing memories along.
pub(crate) const EXISTING_EACH: usize = 8;
/// A message holds about this many tokens of groups at most. A group longer
/// than this on its own is a message by itself.
pub(crate) const REQUEST_TOKENS: u64 = 24_000;
/// The longest learning, in UTF-16 units: the most text any dreamer task
/// may write into one memory (the cap the verify task puts on a corrected
/// memory).
pub(crate) const MAX_CONTENT: usize = 20_000;
/// The proof count a declaration without one asks for.
const DEFAULT_MIN_PROOF: usize = 2;

/// One kind of event the task reads, as the profile declares it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct EventKind {
    /// The summarizer's tag for it, as `compartment_events.kind` stores it.
    pub tag: String,
    /// What the message calls it: `incident`, `correction`.
    pub label: String,
    /// The field its events are grouped by (`affected_surface`).
    pub key: String,
    /// Its declared fields, required then optional: the order an event's
    /// fields are shown in.
    pub fields: Vec<String>,
}

/// The name the prompts give an event kind: the two the summarizer records
/// are an incident and a correction; any other is shown by its tag.
fn label(tag: &str) -> String {
    match tag {
        "causal_incident" => "incident",
        "trajectory_correction" => "correction",
        other => other,
    }
    .to_owned()
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

/// The event kinds `declaration` consumes, in its order, each grouped by the
/// first of its `group_events_by` fields the event enumerates. A kind the
/// profile doesn't define, or that no grouping field fits, is left out.
pub(crate) fn event_kinds(profile: &Profile, declaration: &Value) -> Vec<EventKind> {
    let group_by = strings(&declaration["settings"]["group_events_by"]);
    let events = profile.body["extraction"]["events"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    strings(&declaration["event_kinds"])
        .iter()
        .filter_map(|id| {
            let event = events.iter().find(|event| event["id"] == id.as_str())?;
            let tag = event["tag"].as_str()?.to_owned();
            let key = group_by
                .iter()
                .find(|field| event["enums"].get(field.as_str()).is_some())?
                .clone();
            let mut fields = strings(&event["fields"]["required"]);
            fields.extend(strings(&event["fields"]["optional"]));
            Some(EventKind {
                label: label(&tag),
                tag,
                key,
                fields,
            })
        })
        .collect()
}

/// The proof count `declaration` asks for: events from this many days.
pub(crate) fn min_proof(declaration: &Value) -> usize {
    declaration["settings"]["min_proof_count"]
        .as_u64()
        .and_then(|count| usize::try_from(count).ok())
        .filter(|count| *count > 0)
        .unwrap_or(DEFAULT_MIN_PROOF)
}

/// One stored event of the project.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Event {
    /// Its row id, shown as `e<id>`.
    pub id: i64,
    /// The summarizer's tag for its kind.
    pub kind: String,
    /// Every field it stored, by name; a value that is not text is its
    /// JSON.
    pub fields: BTreeMap<String, String>,
    pub created_at: i64,
}

impl Event {
    /// Its fields in the order `kind` declares them, then any others by
    /// name.
    fn ordered_fields<'a>(&'a self, kind: &EventKind) -> Vec<(&'a str, &'a str)> {
        let mut ordered: Vec<(&str, &str)> = kind
            .fields
            .iter()
            .filter_map(|name| {
                self.fields
                    .get_key_value(name)
                    .map(|(name, value)| (name.as_str(), value.as_str()))
            })
            .collect();
        ordered.extend(
            self.fields
                .iter()
                .filter(|(name, _)| !kind.fields.contains(name))
                .map(|(name, value)| (name.as_str(), value.as_str())),
        );
        ordered
    }

    /// Its text, for the copied-words check: every field value.
    fn texts(&self) -> Vec<String> {
        self.fields.values().cloned().collect()
    }

    /// The day it happened: its calendar date in the machine's local time.
    pub(crate) fn day(&self) -> NaiveDate {
        DateTime::from_timestamp_millis(self.created_at)
            .map(|instant| instant.with_timezone(&Local).date_naive())
            .unwrap_or_default()
    }
}

fn fields_of(json: &str) -> BTreeMap<String, String> {
    let Ok(Value::Object(object)) = serde_json::from_str::<Value>(json) else {
        return BTreeMap::new();
    };
    object
        .into_iter()
        .map(|(name, value)| {
            let text = match value {
                Value::String(text) => text,
                other => other.to_string(),
            };
            (name, text)
        })
        .collect()
}

/// The project's events of `kinds` no older than `since`, newest id first. A project's events are those of the
/// sessions `session_projects` names as its.
pub(crate) fn read_events(
    conn: &Connection,
    project: &str,
    kinds: &[EventKind],
    since: i64,
) -> rusqlite::Result<Vec<Event>> {
    let tags: Vec<&str> = kinds.iter().map(|kind| kind.tag.as_str()).collect();
    conn.prepare(
        "SELECT e.id, e.kind, e.fields_json, e.created_at
           FROM compartment_events e
           JOIN session_projects p ON p.session_id = e.session_id AND p.harness = e.harness
          WHERE p.project_path = ?1 AND e.kind IN (SELECT value FROM json_each(?2))
            AND e.created_at >= ?3
          ORDER BY e.id DESC",
    )?
    .query_map(
        params![
            project,
            serde_json::to_string(&tags).expect("tags serialize"),
            since
        ],
        |row| {
            Ok(Event {
                id: row.get(0)?,
                kind: row.get(1)?,
                fields: fields_of(&row.get::<_, String>(2)?),
                created_at: row.get(3)?,
            })
        },
    )?
    .collect()
}

/// The event the task's watermark names: the newest one a finished run read.
pub(crate) fn stored_watermark(
    conn: &Connection,
    project: &str,
    task: &str,
) -> rusqlite::Result<i64> {
    Ok(
        crate::dreamer::store::schedule_of(conn, &OwnerKey::project(project), task)?
            .and_then(|schedule| schedule.watermark)
            .and_then(|watermark| watermark["event"].as_i64())
            .unwrap_or(0),
    )
}

/// Move the task's watermark to `event`.
fn write_watermark(
    conn: &Connection,
    project: &str,
    task: &str,
    event: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE dream_schedules SET watermark_json = ?4
          WHERE level = ?1 AND owner_id = ?2 AND task = ?3",
        params![
            "project",
            project,
            task,
            json!({ "event": event }).to_string()
        ],
    )?;
    Ok(())
}

/// One group of events: one kind, one value of its grouping field.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Group {
    /// Its kind's place among the task's kinds.
    pub kind: usize,
    /// The value of the kind's grouping field its events share.
    pub value: String,
    /// The events it shows: its new ones, newest first, then its newest
    /// older ones.
    pub events: Vec<Event>,
    /// Which of them are new.
    pub new: HashSet<i64>,
}

impl Group {
    /// The days its events happened on.
    pub(crate) fn days(&self) -> usize {
        self.events
            .iter()
            .map(Event::day)
            .collect::<HashSet<_>>()
            .len()
    }
}

/// Newest first: by time, then by id.
fn newest_first(events: &mut [Event]) {
    events.sort_by(|left, right| {
        right
            .created_at
            .cmp(&left.created_at)
            .then(right.id.cmp(&left.id))
    });
}

/// The groups worth sending among `events`, in the kinds' order and then by
/// value: each holds a new event (id after `after`) and events from at least
/// `min_proof` days. Only events no older than `since` count, new ones too.
/// A group shows all its new events (at most [`GROUP_EVENTS`], newest first)
/// and fills up to that many with its newest older events. An event without
/// its kind's grouping field belongs to no group.
pub(crate) fn groups(
    kinds: &[EventKind],
    events: &[Event],
    after: i64,
    since: i64,
    min_proof: usize,
) -> Vec<Group> {
    let mut by_group: BTreeMap<(usize, String), (Vec<Event>, Vec<Event>)> = BTreeMap::new();
    for event in events {
        if event.created_at < since {
            continue;
        }
        let Some(kind) = kinds.iter().position(|kind| kind.tag == event.kind) else {
            continue;
        };
        let Some(value) = event
            .fields
            .get(&kinds[kind].key)
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let (new, older) = by_group.entry((kind, value.to_owned())).or_default();
        if event.id > after {
            new.push(event.clone());
        } else {
            older.push(event.clone());
        }
    }
    by_group
        .into_iter()
        .filter_map(|((kind, value), (mut new, mut older))| {
            if new.is_empty() {
                return None;
            }
            newest_first(&mut new);
            newest_first(&mut older);
            new.truncate(GROUP_EVENTS);
            let room = GROUP_EVENTS - new.len();
            let fresh: HashSet<i64> = new.iter().map(|event| event.id).collect();
            new.extend(older.into_iter().take(room));
            let group = Group {
                kind,
                value,
                events: new,
                new: fresh,
            };
            (group.days() >= min_proof).then_some(group)
        })
        .collect()
}

/// A live memory a message shows as already existing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Existing {
    pub id: i64,
    /// The tag of its category, as the prompts name categories.
    pub tag: String,
    pub content: String,
}

/// The live memories of `project` and of `workspace`, the project's
/// workspace when it shares memories: id, category id, the tag it was
/// written under, and text.
fn live_memories(
    conn: &Connection,
    project: &str,
    workspace: Option<&str>,
    now: i64,
) -> rusqlite::Result<Vec<(i64, String, String, String)>> {
    conn.prepare(
        "SELECT m.id, m.category, m.origin_category, m.content FROM memories m
          WHERE ((m.level = 'project' AND m.owner_id = ?1)
                 OR (m.level = 'workspace' AND m.owner_id = ?2))
            AND COALESCE(m.status, 'active') IN ('active', 'permanent')
            AND m.superseded_by_memory_id IS NULL
            AND (m.expires_at IS NULL OR m.expires_at > ?3)
          ORDER BY m.id",
    )?
    .query_map(params![project, workspace, now], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
    })?
    .collect()
}

/// The text a group's existing memories are compared with: its events'
/// summaries, or every field of an event that has none.
pub(crate) fn group_query(group: &Group) -> String {
    group
        .events
        .iter()
        .map(|event| match event.fields.get("summary") {
            Some(summary) if !summary.trim().is_empty() => summary.clone(),
            _ => event.texts().join(" "),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Up to [`EXISTING_EACH`] of `live` (memory ids), the closest to `query`:
/// by meaning when `vector` (the query's, with the model id memory vectors
/// are stored under) is given and some of them have a stored vector of that
/// model, and otherwise by words. Best first.
fn closest(
    conn: &Connection,
    live: &[i64],
    query: &str,
    vector: Option<(&[f32], &str)>,
) -> rusqlite::Result<Vec<i64>> {
    if live.is_empty() {
        return Ok(Vec::new());
    }
    let ids = serde_json::to_string(live).expect("ids serialize");
    if let Some((vector, model)) = vector {
        let mut scored: Vec<(f64, i64)> = Vec::new();
        let mut statement = conn.prepare(
            "SELECT memory_id, embedding FROM memory_embeddings
              WHERE model_id = ?1 AND memory_id IN (SELECT value FROM json_each(?2))",
        )?;
        let rows = statement.query_map(params![model, ids], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
        })?;
        for row in rows {
            let (id, blob) = row?;
            if let Some(stored) = crate::embedding::decode(&blob) {
                scored.push((crate::embedding::similarity(vector, &stored), id));
            }
        }
        if !scored.is_empty() {
            scored.sort_by(|left, right| right.0.total_cmp(&left.0).then(left.1.cmp(&right.1)));
            return Ok(scored
                .into_iter()
                .take(EXISTING_EACH)
                .map(|(_, id)| id)
                .collect());
        }
    }
    let words = crate::search::text::relaxed_fts_query(query);
    if words.is_empty() {
        return Ok(Vec::new());
    }
    conn.prepare(
        "SELECT memories_fts.rowid FROM memories_fts
          WHERE memories_fts MATCH ?1 AND memories_fts.rowid IN (SELECT value FROM json_each(?2))
          ORDER BY bm25(memories_fts), memories_fts.rowid LIMIT ?3",
    )?
    .query_map(params![words, ids, EXISTING_EACH as i64], |row| row.get(0))?
    .collect()
}

/// The line of the input frame right after the line `open`: a block's
/// standing instruction.
fn frame_line_after(open: &str) -> &'static str {
    let (_, text) = FRAMES
        .iter()
        .find(|(name, _)| *name == INPUT_FRAME)
        .expect("the reflect input frame is bundled");
    text.lines()
        .skip_while(|line| *line != open)
        .nth(1)
        .unwrap_or_default()
}

/// An attribute value with the characters XML reserves written as entities.
fn attribute(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// The short names one message gives the days of its events (`d1`, `d2`,
/// …), in the order the message first shows each. The model sees which
/// events share a day, but never a date it could copy into a learning.
#[derive(Default)]
pub(crate) struct Aliases {
    seen: Vec<NaiveDate>,
}

impl Aliases {
    fn of(&mut self, day: NaiveDate) -> String {
        let at = match self.seen.iter().position(|seen| *seen == day) {
            Some(at) => at,
            None => {
                self.seen.push(day);
                self.seen.len() - 1
            }
        };
        format!("d{}", at + 1)
    }
}

/// One group in the input frame's shape.
fn group_text(kind: &EventKind, group: &Group, aliases: &mut Aliases) -> String {
    let events: Vec<String> = group
        .events
        .iter()
        .map(|event| {
            let fields: Vec<String> = event
                .ordered_fields(kind)
                .into_iter()
                .map(|(name, value)| format!("{name}: {value}"))
                .collect();
            format!(
                "<event id=\"e{}\" day=\"{}\" new=\"{}\">\n{}\n</event>",
                event.id,
                aliases.of(event.day()),
                if group.new.contains(&event.id) {
                    "yes"
                } else {
                    "no"
                },
                fields.join("\n")
            )
        })
        .collect();
    format!(
        "<group kind=\"{}\" {}=\"{}\" days=\"{}\">\n{}\n</group>",
        attribute(&kind.label),
        kind.key,
        attribute(&group.value),
        group.days(),
        events.join("\n")
    )
}

/// The text that fills the task's input frame, in the frame's own layout:
/// the existing memories (left out when there are none), then each group.
pub(crate) fn input(kinds: &[EventKind], groups: &[&Group], existing: &[Existing]) -> String {
    let mut blocks = Vec::new();
    if !existing.is_empty() {
        let lines: Vec<String> = existing
            .iter()
            .map(|memory| format!("[{}] {}: {}", memory.id, memory.tag, memory.content))
            .collect();
        blocks.push(format!(
            "<existing-memories>\n{}\n{}\n</existing-memories>",
            frame_line_after("<existing-memories>"),
            lines.join("\n")
        ));
    }
    let mut aliases = Aliases::default();
    for group in groups {
        blocks.push(group_text(&kinds[group.kind], group, &mut aliases));
    }
    blocks.join("\n\n")
}

/// `groups` packed into messages, in order: each holds about
/// [`REQUEST_TOKENS`] tokens of groups at most, and a longer group goes
/// alone. Returns each message's group positions.
pub(crate) fn pack(kinds: &[EventKind], groups: &[Group], counter: Counter) -> Vec<Vec<usize>> {
    let mut requests: Vec<Vec<usize>> = Vec::new();
    let mut tokens = 0;
    for (at, group) in groups.iter().enumerate() {
        let cost = counter.count(&group_text(
            &kinds[group.kind],
            group,
            &mut Aliases::default(),
        ));
        let full = requests
            .last()
            .is_none_or(|request| !request.is_empty() && tokens + cost > REQUEST_TOKENS);
        if full {
            requests.push(Vec::new());
            tokens = 0;
        }
        tokens += cost;
        requests
            .last_mut()
            .expect("a message was just made")
            .push(at);
    }
    requests
}

/// A run's reading of the project before its messages are built.
pub(crate) struct Prepared {
    project: String,
    task: String,
    kinds: Vec<EventKind>,
    pub(crate) groups: Vec<Group>,
    /// Each message's group positions.
    requests: Vec<Vec<usize>>,
    /// The newest new event the run read; `None` when none arrived.
    newest: Option<i64>,
    workspace: Option<String>,
}

impl Prepared {
    /// The text each group's existing memories are compared with.
    pub(crate) fn queries(&self) -> Vec<String> {
        self.groups.iter().map(group_query).collect()
    }
}

/// The task kind.
pub(crate) struct ReflectEvents;

impl ReflectEvents {
    /// Read the project's events at `now` and choose the groups worth
    /// sending. When none is, a run that read new events moves the
    /// watermark past them now: there is nothing to apply first.
    pub(crate) fn prepare(&self, context: &TaskContext<'_>, now: i64) -> Result<Prepared, String> {
        let Owner::Project { id: project, .. } = context.owner else {
            return Err(format!("{KIND} works on a project's memories only"));
        };
        let task = context.task_id().to_owned();
        let kinds = event_kinds(context.profile, context.declaration);
        if kinds.is_empty() {
            return Err(format!(
                "{task} declares no event kind the module can group"
            ));
        }
        let since = now - WINDOW_DAYS * DAY_MS;
        let (after, events) = context
            .db
            .with_connection(|conn| {
                let after = stored_watermark(conn, project, &task)?;
                Ok::<_, rusqlite::Error>((after, read_events(conn, project, &kinds, since)?))
            })
            .map_err(|error| format!("reading the events of {project}: {error}"))?;
        let newest = events
            .iter()
            .map(|event| event.id)
            .filter(|id| *id > after)
            .max();
        let groups = groups(
            &kinds,
            &events,
            after,
            since,
            min_proof(context.declaration),
        );
        if groups.is_empty() {
            if let Some(newest) = newest {
                context
                    .db
                    .with_connection(|conn| write_watermark(conn, project, &task, newest))
                    .map_err(|error| format!("moving {task}'s watermark: {error}"))?;
            }
        }
        let requests = pack(&kinds, &groups, Counter::for_model(None));
        Ok(Prepared {
            project: project.clone(),
            task,
            kinds,
            groups,
            requests,
            newest,
            workspace: context
                .workspace
                .filter(|workspace| workspace.members.len() >= 2)
                .map(|workspace| workspace.workspace_id.clone()),
        })
    }

    /// The run's messages for `prepared`. `vectors` holds each group's
    /// query vector, in group order, with the model id memory vectors are
    /// stored under; a group without one finds its existing memories by
    /// words.
    pub(crate) fn finish(
        &self,
        context: &TaskContext<'_>,
        prepared: Prepared,
        vectors: &[Option<Vec<f32>>],
        model: Option<&str>,
        now: i64,
    ) -> Result<Vec<ReflectBatch>, String> {
        let project = prepared.project.as_str();
        let tags: HashMap<String, String> = context.profile.body["categories"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|category| {
                Some((
                    category["id"].as_str()?.to_owned(),
                    category["tag"].as_str()?.to_owned(),
                ))
            })
            .collect();
        let (live, closest_ids) = context
            .db
            .with_connection(|conn| {
                let live = live_memories(conn, project, prepared.workspace.as_deref(), now)?;
                let ids: Vec<i64> = live.iter().map(|(id, ..)| *id).collect();
                let closest_ids = prepared
                    .groups
                    .iter()
                    .enumerate()
                    .map(|(at, group)| {
                        let vector = vectors.get(at).and_then(Option::as_deref).zip(model);
                        closest(conn, &ids, &group_query(group), vector)
                    })
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok::<_, rusqlite::Error>((live, closest_ids))
            })
            .map_err(|error| format!("reading the memories of {project}: {error}"))?;
        let by_id: HashMap<i64, Existing> = live
            .into_iter()
            .map(|(id, category, origin, content)| {
                let tag = tags.get(&category).cloned().unwrap_or(origin);
                (id, Existing { id, tag, content })
            })
            .collect();
        let categories = categories(context.profile, context.declaration);
        let actions = strings(&context.declaration["actions"]);
        let min_proof = min_proof(context.declaration);
        let profile = OriginProfile {
            name: context.profile.name.clone(),
            version: context.profile.version.clone(),
            digest: context.profile.digest.clone(),
        };
        let last = prepared.requests.len().saturating_sub(1);
        prepared
            .requests
            .iter()
            .enumerate()
            .map(|(index, positions)| {
                let groups: Vec<&Group> = positions.iter().map(|at| &prepared.groups[*at]).collect();
                let mut existing: Vec<Existing> = Vec::new();
                for at in positions {
                    for id in &closest_ids[*at] {
                        if existing.iter().any(|memory| memory.id == *id) {
                            continue;
                        }
                        if let Some(memory) = by_id.get(id) {
                            existing.push(memory.clone());
                        }
                    }
                }
                let text = input(&prepared.kinds, &groups, &existing);
                let (system, message) = task_prompts(
                    context.profile,
                    &prepared.task,
                    "user",
                    &[(INPUT_FRAME, text.as_str())],
                    &[("projectIdentity", project)],
                )?;
                let mut shown = HashMap::new();
                for group in &groups {
                    for event in &group.events {
                        shown.insert(
                            event.id,
                            Shown {
                                day: event.day(),
                                new: group.new.contains(&event.id),
                                texts: event.texts(),
                            },
                        );
                    }
                }
                Ok(ReflectBatch {
                    index,
                    project: project.to_owned(),
                    task: prepared.task.clone(),
                    system,
                    message,
                    shown,
                    min_proof,
                    actions: actions.clone(),
                    categories: categories.clone(),
                    profile: profile.clone(),
                    workspace: prepared.workspace.clone(),
                    watermark: if index == last {
                        prepared.newest
                    } else {
                        None
                    },
                    groups: groups
                        .iter()
                        .map(|group| {
                            let kind = &prepared.kinds[group.kind];
                            json!({
                                "kind": kind.label,
                                "key": kind.key,
                                "value": group.value,
                                "days": group.days(),
                                "events": group.events.iter().map(|event| event.id).collect::<Vec<_>>(),
                                "new": group.events.iter().filter(|event| group.new.contains(&event.id)).map(|event| event.id).collect::<Vec<_>>(),
                            })
                        })
                        .collect(),
                    existing: existing.iter().map(|memory| memory.id).collect(),
                })
            })
            .collect()
    }

    /// The run's messages, existing memories found by words only.
    pub(crate) fn plan_batches(
        &self,
        context: &TaskContext<'_>,
    ) -> Result<Vec<ReflectBatch>, String> {
        let now = now_ms();
        let prepared = self.prepare(context, now)?;
        self.finish(context, prepared, &[], None, now)
    }
}

impl Task for ReflectEvents {
    fn kind(&self) -> &'static str {
        KIND
    }

    /// The memories a learning must not repeat include the workspace's.
    fn sees_workspace(&self) -> bool {
        true
    }

    fn batches(&self, context: &TaskContext<'_>) -> Result<Vec<Box<dyn Batch>>, String> {
        Ok(self
            .plan_batches(context)?
            .into_iter()
            .map(|batch| Box::new(batch) as Box<dyn Batch>)
            .collect())
    }

    /// With an embedding provider, each group's existing memories are found
    /// by meaning: its summaries are embedded as a query and compared with
    /// the memories' stored vectors.
    fn plan<'a>(
        &'a self,
        context: &'a TaskContext<'a>,
        embedding: Option<&'a Provider>,
    ) -> Planning<'a> {
        Box::pin(async move {
            let now = now_ms();
            let prepared = self.prepare(context, now)?;
            let mut vectors = Vec::new();
            if let Some(provider) = embedding.filter(|_| !prepared.groups.is_empty()) {
                for query in prepared.queries() {
                    vectors.push(provider.embed_query(&query).await);
                }
            }
            let model = embedding.map(Provider::model_id);
            let batches: Vec<Box<dyn Batch>> = self
                .finish(context, prepared, &vectors, model.as_deref(), now)?
                .into_iter()
                .map(|batch| Box::new(batch) as Box<dyn Batch>)
                .collect();
            Ok::<_, String>(batches)
        })
    }
}

/// A category a learning may name: its profile id, its tag, and whether it
/// holds observations about the person (`user-observation`) rather than
/// project facts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CategoryRef {
    pub id: String,
    pub tag: String,
    pub user: bool,
}

/// The categories `declaration` lets the task write, from `profile`.
pub(crate) fn categories(profile: &Profile, declaration: &Value) -> Vec<CategoryRef> {
    let declared = strings(&declaration["categories"]);
    profile.body["categories"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|category| {
            let id = category["id"].as_str()?;
            if !declared.iter().any(|name| name == id) {
                return None;
            }
            let user = match category["stream"].as_str()? {
                "fact" => false,
                "user-observation" => true,
                _ => return None,
            };
            Some(CategoryRef {
                id: id.to_owned(),
                tag: category["tag"].as_str().unwrap_or(id).to_owned(),
                user,
            })
        })
        .collect()
}

/// An event a message shows, as a learning citing it is checked.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Shown {
    day: NaiveDate,
    new: bool,
    /// Its field values, for the copied-words check.
    texts: Vec<String>,
}

/// One message of a reflect run: some groups of the project's events.
pub(crate) struct ReflectBatch {
    /// Its place in the run, which names its decisions in the undo history.
    index: usize,
    project: String,
    /// The profile's id for the task, which keys its schedule.
    task: String,
    system: String,
    message: String,
    /// Every event the message shows, by id.
    shown: HashMap<i64, Shown>,
    min_proof: usize,
    /// The actions the task's declaration allows.
    actions: Vec<String>,
    categories: Vec<CategoryRef>,
    /// The profile whose prompt asked for the learnings, which a new memory
    /// and an observation name as their origin.
    profile: OriginProfile,
    /// The project's workspace, when it shares memories; an observation
    /// records its id, as the observations the summarizer stores do.
    workspace: Option<String>,
    /// The newest event the run read, where the watermark moves once this
    /// message is applied. Only the run's last message carries it, so a run
    /// that stops early reads the same events again next time.
    pub(crate) watermark: Option<i64>,
    /// The groups the message shows, for the replay harness: kind, grouping
    /// field and value, session count, and event ids.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) groups: Vec<Value>,
    /// The ids of the existing memories it shows.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) existing: Vec<i64>,
}

/// What writing one reply's list did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Written {
    /// The run's record of it.
    pub applied: Applied,
    /// For each entry of the list, in order, why it was dropped; `None` for
    /// a learning that was written.
    pub refusals: Vec<Option<String>>,
    /// The memories and observations written, by id: `memory 12`,
    /// `observation 4`.
    pub written: Vec<String>,
}

/// A learning that passed every check.
struct Checked<'a> {
    learning: &'a Learning,
    category: &'a CategoryRef,
    hash: String,
}

impl ReflectBatch {
    /// The message the batch sends.
    #[cfg(test)]
    pub(crate) fn message(&self) -> &str {
        &self.message
    }

    /// The decision key of the list's learning `number`.
    fn decision_key(&self, run: i64, number: usize) -> String {
        format!("dream-run:{run}:{KIND}:{}:{number}", self.index)
    }

    /// The category `named` means for `route`: a project category for a
    /// memory, a person's category for an observation, by tag or id.
    fn category(&self, named: &str, observation: bool) -> Option<&CategoryRef> {
        self.categories.iter().find(|category| {
            category.user == observation
                && (category.tag.eq_ignore_ascii_case(named) || category.id == named)
        })
    }

    /// Check each learning of `entries` and write the ones that pass, in
    /// list order, then move the watermark when this is the run's last
    /// message.
    pub(crate) fn write(
        &self,
        tx: &Transaction<'_>,
        entries: &[Result<Learning, String>],
        child: &str,
        run: i64,
    ) -> rusqlite::Result<Written> {
        let mut written = Written {
            applied: Applied {
                proposed: entries.len(),
                ..Applied::default()
            },
            ..Written::default()
        };
        let mut accepted: HashSet<(bool, String)> = HashSet::new();
        for (number, entry) in entries.iter().enumerate() {
            let refusal = match entry {
                Err(reason) => Some(reason.clone()),
                Ok(learning) => match self.check(tx, learning, &accepted)? {
                    Err(reason) => Some(reason),
                    Ok(checked) => {
                        accepted.insert((checked.category.user, checked.hash.clone()));
                        let id = if checked.category.user {
                            format!("observation {}", self.observe(tx, &checked, child)?)
                        } else {
                            let key = self.decision_key(run, number);
                            format!("memory {}", self.remember(tx, &checked, child, run, &key)?)
                        };
                        written.applied.applied += 1;
                        written.written.push(id);
                        None
                    }
                },
            };
            if let Some(reason) = &refusal {
                let what = match entry {
                    Ok(learning) => format!(
                        "learning {} ({} {}, {})",
                        number + 1,
                        learning.route,
                        learning.category,
                        learning
                            .events
                            .iter()
                            .map(|id| format!("e{id}"))
                            .collect::<Vec<_>>()
                            .join(",")
                    ),
                    Err(_) => format!("learning {}", number + 1),
                };
                written.applied.dropped.push(format!("{what}: {reason}"));
            }
            written.refusals.push(refusal);
        }
        if let Some(event) = self.watermark {
            write_watermark(tx, &self.project, &self.task, event)?;
        }
        Ok(written)
    }

    /// `learning` with its category when every check passes, or why not.
    fn check<'a>(
        &'a self,
        tx: &Transaction<'_>,
        learning: &'a Learning,
        accepted: &HashSet<(bool, String)>,
    ) -> rusqlite::Result<Result<Checked<'a>, String>> {
        let (observation, action) = match learning.route.as_str() {
            "memory" => (false, "write-memory"),
            "observation" => (true, "write-observation-candidate"),
            "" => return Ok(Err("the learning names no route".into())),
            other => {
                return Ok(Err(format!(
                    "{other} is not a route (memory or observation)"
                )))
            }
        };
        if !self.actions.iter().any(|allowed| allowed == action) {
            return Ok(Err(format!(
                "the task's declaration does not allow {action}"
            )));
        }
        let Some(category) = self.category(&learning.category, observation) else {
            return Ok(Err(format!(
                "{} is not a {} category",
                if learning.category.is_empty() {
                    "(none)"
                } else {
                    &learning.category
                },
                if observation { "user" } else { "project" }
            )));
        };
        let mut cited = Vec::with_capacity(learning.events.len());
        for id in &learning.events {
            match self.shown.get(id) {
                Some(shown) => cited.push(shown),
                None => return Ok(Err(format!("e{id} is not an event of this message"))),
            }
        }
        let days = cited
            .iter()
            .map(|shown| shown.day)
            .collect::<HashSet<_>>()
            .len();
        if days < self.min_proof {
            return Ok(Err(format!(
                "the cited events come from {days} day(s), fewer than {}",
                self.min_proof
            )));
        }
        if !cited.iter().any(|shown| shown.new) {
            return Ok(Err("no cited event is new".into()));
        }
        let length = learning.text.encode_utf16().count();
        if length > MAX_CONTENT {
            return Ok(Err(format!(
                "the text is longer than {MAX_CONTENT} characters ({length})"
            )));
        }
        let sources: Vec<&str> = cited
            .iter()
            .flat_map(|shown| shown.texts.iter().map(String::as_str))
            .collect();
        if let Some(reason) = text_refusal(&learning.text, &sources) {
            return Ok(Err(reason));
        }
        let hash = normalized_hash(&learning.text);
        if accepted.contains(&(observation, hash.clone())) {
            return Ok(Err("it repeats an earlier learning of this list".into()));
        }
        let repeated = if observation {
            live_global_with_hash(tx, &hash)?
        } else {
            super::curate::live_with_hash(
                tx,
                &super::curate::Scope::project(&self.project),
                &hash,
                &[],
            )?
        };
        if let Some(other) = repeated {
            return Ok(Err(format!("it repeats live memory {other}")));
        }
        Ok(Ok(Checked {
            learning,
            category,
            hash,
        }))
    }

    /// Write a project memory, with its provenance (the run and the events
    /// it rests on) and one undo-history decision under `key`. Returns its
    /// id.
    fn remember(
        &self,
        tx: &Transaction<'_>,
        checked: &Checked<'_>,
        child: &str,
        run: i64,
        key: &str,
    ) -> rusqlite::Result<i64> {
        let now = now_ms();
        let row = NewRow {
            level: "project".into(),
            owner_id: self.project.clone(),
            category_id: checked.category.id.clone(),
            origin_profile: Some(self.profile.clone()),
            source_ordinals_json: None,
        };
        let memory = insert_memory(
            tx,
            &row,
            &self.project,
            &checked.category.tag,
            &checked.learning.text,
            child,
            "dreamer",
            None,
        )?;
        let provenance = json!({
            "source": KIND,
            "run": run,
            "events": checked.learning.events,
        });
        tx.execute(
            "UPDATE memories SET metadata_json = ?2 WHERE id = ?1",
            params![memory.id, provenance.to_string()],
        )?;
        created(tx, &Placer::unplaced(), memory.id, CreateKind::Create, now)?;
        let after = [history_snapshot(tx, memory.id)?];
        let recorded = record_history(
            tx,
            &History {
                key,
                project: &self.project,
                writer: "dreamer:reflect-events",
                operation: "create",
                reason: "reflect",
                now,
                before: &[None],
                after: &after,
                source_ids: &[],
                survivor_id: None,
                evidence: provenance,
            },
        )?;
        tx.execute(
            "INSERT INTO memory_journal(project_path, decision_key, operation, receipt_json, applied_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                self.project,
                key,
                "reflect_events_create",
                json!({"state": "applied", "reason": "create", "memoryIds": [memory.id]}).to_string(),
                now
            ],
        )?;
        tx.execute(
            "UPDATE memory_journal SET before_json = ?2, after_json = ?2 WHERE decision_key = ?1",
            params![key, history_json(&recorded)],
        )?;
        Ok(memory.id)
    }

    /// Leave an observation about the person for the global review, as the
    /// summarizer leaves one (`memory_observations`). Its session is
    /// `child`, the run's child that proposed it, which names the run.
    /// Returns its id.
    fn observe(
        &self,
        tx: &Transaction<'_>,
        checked: &Checked<'_>,
        child: &str,
    ) -> rusqlite::Result<i64> {
        tx.execute(
            "INSERT INTO memory_observations (content, proposed_category, origin_profile,
                 origin_profile_version, origin_profile_digest, session_id, project_id,
                 workspace_id, source_start_ordinal, source_end_ordinal, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, NULL, ?9)",
            params![
                checked.learning.text,
                checked.category.tag,
                self.profile.name,
                self.profile.version,
                self.profile.digest,
                child,
                self.project,
                self.workspace,
                now_ms(),
            ],
        )?;
        Ok(tx.last_insert_rowid())
    }
}

/// A live memory of the person (global level) whose text has `hash`.
fn live_global_with_hash(tx: &Transaction<'_>, hash: &str) -> rusqlite::Result<Option<i64>> {
    tx.query_row(
        "SELECT id FROM memories
          WHERE level = 'global' AND normalized_hash = ?1
            AND COALESCE(status, 'active') IN ('active', 'permanent')
          ORDER BY id LIMIT 1",
        [hash],
        |row| row.get(0),
    )
    .optional()
}

impl TaskInput for ReflectBatch {
    fn system(&self) -> &str {
        &self.system
    }

    fn prompt(&self, window: Window, output_tokens: u64) -> Option<String> {
        window
            .admits(output_tokens, &self.system, &self.message)
            .then(|| self.message.clone())
    }

    fn accepts(&self, reply: &str) -> Result<(), String> {
        parse_learnings(reply).map(drop)
    }
}

impl Batch for ReflectBatch {
    fn apply(&self, tx: &Transaction<'_>, reply: &TaskReply, run: i64) -> Result<Applied, String> {
        let entries = parse_learnings(&reply.text)?;
        self.write(tx, &entries, &reply.child, run)
            .map(|written| written.applied)
            .map_err(|error| format!("writing learnings: {error}"))
    }
}

#[cfg(test)]
#[path = "reflect_events_tests.rs"]
pub(crate) mod tests;
