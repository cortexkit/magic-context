//! Held copies of reasoning the runner pruned at rest (llm-runner
//! `archive_prunes_reasoning`, compaction-provider 0.7.3 §4 and §7).
//!
//! A runner that declares archive pruning may, once a session is archived
//! and idle, empty its stored reasoning, drop opaque reasoning payloads, or
//! drop provider signatures from text and tool calls. It does so only for a
//! session whose latest Setup answer listed `pruned_reasoning` in `accepts`,
//! and it reports each prune with a rising `reasoning_pruned.generation` on
//! `session.head`, on read pages, on notices and on the Setup it calls
//! before the next run.
//!
//! ck-mc holds copies of the messages it read. When the runner's generation
//! differs from the one this record last reconciled, ck-mc reads its held
//! messages again, from its cut (never below it) through the prune's
//! `through_ordinal`, before it builds any view from them. A re-read message
//! replaces the held copy in place only when it differs exactly as the
//! listed prune kinds allow (`accepts`); anything else is a changed
//! transcript, refused as before, and the conversation is read again from
//! scratch.
//!
//! Replacing a held copy changes the message's block identity under the
//! engine. The engine is told so for exactly the messages replaced, until one
//! pass commits the new identities (`pruned_readopt`), and the next engine pass
//! runs once as a rebuild (`pruned_rebuild_pending`), unless a rewrite ride
//! already rebuilt since the last notice (`rode_since_notice`).
//!
//! Bytes ck-mc authors for a pruned message must never carry what the prune
//! removed. Every edit and replacement a view sends is checked, once the
//! runner has reported a prune, with llm-runner's per-profile reference
//! (`restored_by_edit_in`, `restored_part_in`) against the runner's prune
//! record (`pruned_parts`): see `without_restored_content` and
//! `replacement_restores_pruned`.
use super::*;
use cortexkit_role_llm_runner::archive_prunes_reasoning::{self, PrunedPartAt, PrunedReasoning};

/// The runner's prune state, as `session.head` reports it.
pub(super) type PruneState = cortexkit_role_llm_runner::archive_prunes_reasoning::ReasoningPruned;

/// How far a reconciliation got.
pub(super) enum Reconciled {
    /// Every held message the prune can have changed was read again.
    Complete,
    /// The read budget ran out first. Messages already replaced stay
    /// replaced; the generation is not recorded, so the next notice or
    /// Setup carrying it reconciles again (and finds those stable).
    Incomplete,
}

/// The page's `pruned_reasoning` rows, grouped by message id. A page without
/// the member lists nothing; so does one whose member does not decode, so a
/// malformed list can never make a changed message acceptable.
pub(super) fn listed(page: &Value) -> BTreeMap<String, Vec<PrunedReasoning>> {
    let rows = page
        .get("pruned_reasoning")
        .and_then(|rows| serde_json::from_value::<Vec<PrunedReasoning>>(rows.clone()).ok())
        .unwrap_or_default();
    let mut by_mid: BTreeMap<String, Vec<PrunedReasoning>> = BTreeMap::new();
    for row in rows {
        by_mid.entry(row.mid.clone()).or_default().push(row);
    }
    by_mid
}

/// The prune state a page or head reports, when it is a valid one.
pub(super) fn reported(value: &Value) -> Option<PruneState> {
    value
        .get("reasoning_pruned")
        .and_then(|state| serde_json::from_value::<PruneState>(state.clone()).ok())
        .filter(PruneState::valid)
}

/// Where a message's top-level parts live, in the order `parts` looks for
/// them: the whole `content` string of an Anthropic message that has no
/// block array, then `parts`, `content` or `message.content` arrays.
fn parts_pointer(message: &Value) -> Option<(&'static str, bool)> {
    if message.get("parts").is_none() && message.get("content").is_some_and(Value::is_string) {
        return Some(("/content", true));
    }
    ["/parts", "/content", "/message/content"]
        .into_iter()
        .find(|pointer| message.pointer(pointer).is_some_and(Value::is_array))
        .map(|pointer| (pointer, false))
}

fn part_at<'a>(message: &'a Value, pointer: &str, whole: bool, index: usize) -> Option<&'a Value> {
    let parts = message.pointer(pointer)?;
    if whole {
        return (index == 0).then_some(parts);
    }
    parts.as_array()?.get(index)
}

/// Whether `part`, in serializer profile `profile`'s stored format, carries
/// content a prune of `kind` removes: llm-runner's per-profile reference
/// (`carries_pruned_content_in`). A profile the rules do not name carries
/// nothing ck-mc could check, so it is treated as carrying nothing here and
/// refused where acceptance depends on it (`pruned_as`).
fn carries(profile: &str, kind: &str, part: &Value) -> bool {
    archive_prunes_reasoning::carries_pruned_content_in(profile, kind, part).unwrap_or(false)
}

/// Whether a reference check found restored content. A profile the
/// per-profile rules do not name cannot be checked, so it counts as
/// restoring: nothing is sent that could not be checked.
fn restored<T>(found: Result<Option<T>, archive_prunes_reasoning::UnsupportedProfile>) -> bool {
    !matches!(found, Ok(None))
}

/// One step along a part's members: an object member, an array index, or
/// into the JSON a string holds (owned-broca `redacted_reasoning.data`, pi
/// `thinkingSignature`).
#[derive(Clone, Debug, PartialEq, Eq)]
enum Step {
    Member(String),
    Index(usize),
    Json,
}

/// One way a pruned part differs from the part as written: the member at
/// the path is gone, or the string at the path is now empty.
#[derive(Clone, Debug)]
struct Change {
    path: Vec<Step>,
}

/// Compare `served` with `held`, recording each removed member and each
/// emptied string. Anything else (a new member, a changed value, a resized
/// array) makes the comparison fail. A string that holds a JSON object or
/// array is compared as that JSON, so a member removed inside it is a
/// removal too.
fn compare(held: &Value, served: &Value, path: &mut Vec<Step>, changes: &mut Vec<Change>) -> bool {
    if held == served {
        return true;
    }
    match (held, served) {
        (Value::Object(held), Value::Object(served)) => {
            for (key, value) in served {
                let Some(original) = held.get(key) else {
                    return false;
                };
                path.push(Step::Member(key.clone()));
                let same = compare(original, value, path, changes);
                path.pop();
                if !same {
                    return false;
                }
            }
            for key in held.keys().filter(|key| !served.contains_key(*key)) {
                let mut removed = path.clone();
                removed.push(Step::Member(key.clone()));
                changes.push(Change { path: removed });
            }
            true
        }
        (Value::Array(held), Value::Array(served)) if held.len() == served.len() => {
            for (index, (original, value)) in held.iter().zip(served).enumerate() {
                path.push(Step::Index(index));
                let same = compare(original, value, path, changes);
                path.pop();
                if !same {
                    return false;
                }
            }
            true
        }
        (Value::String(_), Value::String(served)) if served.is_empty() => {
            changes.push(Change { path: path.clone() });
            true
        }
        (Value::String(held), Value::String(served)) => {
            match (
                serde_json::from_str::<Value>(held),
                serde_json::from_str::<Value>(served),
            ) {
                (Ok(held @ (Value::Object(_) | Value::Array(_))), Ok(served)) => {
                    path.push(Step::Json);
                    let same = compare(&held, &served, path, changes);
                    path.pop();
                    same
                }
                _ => false,
            }
        }
        _ => false,
    }
}

/// `target` with the value at `path` set as `source` has it there: copied
/// when `source` has a value, removed when it has none. Strings holding JSON
/// are parsed, changed and written back. `None` when the path does not lead
/// through `target`.
fn take_from(target: &Value, source: &Value, path: &[Step]) -> Option<Value> {
    let Some((step, rest)) = path.split_first() else {
        return Some(source.clone());
    };
    let mut target = target.clone();
    match step {
        Step::Json => {
            let inner: Value = serde_json::from_str(target.as_str()?).ok()?;
            let original: Value = serde_json::from_str(source.as_str()?).ok()?;
            let changed = take_from(&inner, &original, rest)?;
            return Some(Value::String(changed.to_string()));
        }
        Step::Member(key) => {
            let members = target.as_object_mut()?;
            match (rest.is_empty(), source.get(key)) {
                (true, None) => {
                    members.remove(key);
                }
                (true, Some(original)) => {
                    members.insert(key.clone(), original.clone());
                }
                (false, original) => {
                    let changed = take_from(members.get(key)?, original?, rest)?;
                    members.insert(key.clone(), changed);
                }
            }
        }
        Step::Index(index) => {
            let items = target.as_array_mut()?;
            let changed = take_from(items.get(*index)?, source.get(*index)?, rest)?;
            items[*index] = changed;
        }
    }
    Some(target)
}

/// Whether `served` is the part `held` after a prune of `kind` in
/// serializer profile `profile`, and nothing else (llm-runner §9.14.1,
/// per-profile table):
///
/// - the part keeps its type, and differs from `held` only by removed
///   members and emptied strings;
/// - `served` no longer carries the kind's content
///   (`carries_pruned_content_in`);
/// - every one of those changes removes the kind's content: putting any one
///   of them back makes the part carry it again. So a `signature` prune
///   cannot empty text, an `opaque_reasoning` prune cannot touch readable
///   reasoning or a summary, and a kind that does not apply to the part
///   (one the profile cannot carry, or one this crate does not define)
///   accepts no change at all.
fn pruned_as(profile: &str, kind: &str, held: &Value, served: &Value) -> bool {
    if held.get("type") != served.get("type") {
        return false;
    }
    if !archive_prunes_reasoning::kinds_carried(profile)
        .is_ok_and(|carried| carried.contains(&kind))
    {
        return false;
    }
    let mut changes = Vec::new();
    if !compare(held, served, &mut Vec::new(), &mut changes) {
        return false;
    }
    if changes.is_empty() {
        return true;
    }
    !carries(profile, kind, served)
        && changes.iter().all(|change| {
            take_from(served, held, &change.path)
                .is_some_and(|put_back| carries(profile, kind, &put_back))
        })
}

/// Whether `fresh`, a re-read of the held message `held` in serializer
/// profile `profile`, differs from it only as the contract's re-read rule
/// allows: every member but the message body is unchanged, every part the
/// page does not list is byte-identical, and every listed part keeps its
/// index and key, carries its write-time digest, and differs from the held
/// part only as its kind allows (`pruned_as`).
pub(super) fn accepts(
    profile: &str,
    held: &ReadMessage,
    fresh: &ReadMessage,
    listed: &[PrunedReasoning],
) -> bool {
    if listed.is_empty()
        || held.ordinal != fresh.ordinal
        || held.mid != fresh.mid
        || held.digest != fresh.digest
        || held.part_digests != fresh.part_digests
        || held.tags != fresh.tags
        || held.role != fresh.role
        || held.written_at != fresh.written_at
        || held.delivered_as != fresh.delivered_as
    {
        return false;
    }
    let (Some((pointer, whole)), Some(held_parts)) =
        (parts_pointer(&fresh.message), parts_pointer(&held.message))
    else {
        return false;
    };
    if (pointer, whole) != held_parts {
        return false;
    }
    let mut candidate = fresh.message.clone();
    for row in listed {
        if row.mid != fresh.mid {
            return false;
        }
        let Some(index) = fresh.tags.iter().position(|tag| tag.part == row.part) else {
            return false;
        };
        match served_part_digest(held, &row.part) {
            Ok(digest) if digest == row.sha256 => {}
            _ => return false,
        }
        let (Some(served), Some(original)) = (
            part_at(&fresh.message, pointer, whole, index),
            part_at(&held.message, pointer, whole, index),
        ) else {
            return false;
        };
        if !pruned_as(profile, &row.kind, original, served) {
            return false;
        }
        // Put the held part back where the pruned one is served: if the
        // result is the held message, nothing else changed.
        let original = original.clone();
        match candidate.pointer_mut(pointer) {
            Some(slot) if whole => *slot = original,
            Some(Value::Array(parts)) if index < parts.len() => parts[index] = original,
            _ => return false,
        }
    }
    candidate == held.message
}

/// Every place in `sent` where the held part has an empty string or no
/// member at all: the only places an edit built from a pre-prune copy can
/// differ from the reconciled one in what a prune removed. Paths stop at
/// the first member the held part lacks.
fn missing_in_held(
    held: Option<&Value>,
    sent: &Value,
    path: &mut Vec<Step>,
    out: &mut Vec<Vec<Step>>,
) {
    let Some(held) = held else {
        out.push(path.clone());
        return;
    };
    match (held, sent) {
        (Value::String(held), Value::String(sent)) if held.is_empty() && !sent.is_empty() => {
            out.push(path.clone());
        }
        (Value::String(held), Value::String(sent)) if held != sent => {
            if let (Ok(held @ (Value::Object(_) | Value::Array(_))), Ok(sent)) = (
                serde_json::from_str::<Value>(held),
                serde_json::from_str::<Value>(sent),
            ) {
                path.push(Step::Json);
                missing_in_held(Some(&held), &sent, path, out);
                path.pop();
            }
        }
        (Value::Object(held), Value::Object(sent)) => {
            for (key, value) in sent {
                path.push(Step::Member(key.clone()));
                missing_in_held(held.get(key), value, path, out);
                path.pop();
            }
        }
        (Value::Array(held), Value::Array(sent)) => {
            for (index, value) in sent.iter().enumerate() {
                path.push(Step::Index(index));
                missing_in_held(held.get(index), value, path, out);
                path.pop();
            }
        }
        _ => {}
    }
}

impl AsyncRecord {
    /// The prune generation these held copies were last reconciled with.
    pub(super) fn reasoning_pruned_generation(&self) -> Option<u64> {
        self.reasoning_pruned.map(|state| state.generation)
    }

    /// The serializer profile this conversation's stored messages follow.
    pub(super) fn serializer_profile(&self) -> Result<&'static str, HandlerOutcome> {
        Ok(codec::Codec::from_params(&Value::Object(self.setup.params.clone()))?.wire_id())
    }

    /// Whether the session's Setup answer lets the runner prune it.
    pub(super) fn accepts_pruning(&self) -> bool {
        self.initial
            .get("accepts")
            .and_then(Value::as_array)
            .is_some_and(|accepts| {
                accepts
                    .iter()
                    .any(|value| value == compact::setup::ACCEPTS_PRUNED_REASONING)
            })
    }

    /// Answer Setup without the pruning permission (a session set up before
    /// ck-mc accepted pruning keeps answering as it did).
    pub(super) fn withdraw_pruning_permission(&mut self) -> Result<(), HandlerOutcome> {
        self.set_pruning_permission(false)
    }

    pub(super) fn set_pruning_permission(&mut self, accepts: bool) -> Result<(), HandlerOutcome> {
        let answer: compact::setup::SetupAnswer = decode(&self.initial)?;
        let profile = self.initial.get("serializer_profile").cloned();
        let answer = answer.with_accepts(if accepts {
            vec![compact::setup::ACCEPTS_PRUNED_REASONING.into()]
        } else {
            Vec::new()
        });
        self.initial = serde_json::to_value(answer).map_err(transient)?;
        if let Some(profile) = profile {
            self.initial["serializer_profile"] = profile;
        }
        Ok(())
    }

    /// Record the parts a page lists as pruned for the held message at
    /// `ordinal`: the runner's prune record, which the view checks follow
    /// (`restored_by_edit_in`, `restored_part_in`).
    pub(super) fn record_pruned_parts(&mut self, ordinal: u64, listed: &[PrunedReasoning]) {
        if listed.is_empty() {
            return;
        }
        let parts = self.pruned_parts.entry(ordinal).or_default();
        for row in listed {
            parts.insert(row.part.clone(), row.kind.clone());
        }
    }

    /// The runner's prune record for the held messages, as llm-runner's
    /// reference functions take it.
    fn pruned_part_list(&self, ordinal: Option<u64>) -> Vec<PrunedPartAt> {
        let range = match ordinal {
            Some(ordinal) => self.pruned_parts.range(ordinal..=ordinal),
            None => self.pruned_parts.range(..),
        };
        range
            .flat_map(|(ordinal, parts)| {
                parts
                    .iter()
                    .map(|(part, kind)| PrunedPartAt::new(*ordinal, part.clone(), kind.clone()))
            })
            .collect()
    }

    /// Hold `fresh` in place of `held`, the held copy of the same message,
    /// when it differs only as the page's listed prunes allow (`accepts`).
    /// The stored row is rewritten on the next save. Everything this record
    /// derived from the held bytes is dropped so it is derived again, the
    /// engine adopts the message's new block identity on its next pass, and
    /// that pass runs once as a rebuild unless a rewrite ride already rebuilt
    /// since the last notice. `Ok(false)` leaves the record unchanged.
    pub(super) fn accept_pruned_reread(
        &mut self,
        held: &ReadMessage,
        fresh: &ReadMessage,
        listed: &[PrunedReasoning],
    ) -> Result<bool, HandlerOutcome> {
        if !accepts(self.serializer_profile()?, held, fresh, listed) {
            return Ok(false);
        }
        let entry = HeldEntry::from_read(fresh)?;
        #[cfg(test)]
        let entry = entry.counted_as(self.reference());
        self.entries.insert(fresh.ordinal, Arc::new(entry));
        self.journal.replaced.insert(fresh.ordinal);
        self.record_pruned_parts(fresh.ordinal, listed);
        self.logical_prefix = None;
        self.prefix_input_proof = None;
        self.cut_signature = None;
        self.reminder_hint_state = None;
        self.cache_state = None;
        self.aggregates = self.base_aggregates();
        self.entry_bytes = (None, 0);
        self.pruned_readopt.insert(fresh.mid.clone());
        if !self.rode_since_notice {
            self.pruned_rebuild_pending = true;
        }
        tracing::info!(
            session_ref = %self.reference(),
            ordinal = fresh.ordinal,
            mid = %fresh.mid,
            pruned_parts = listed.len(),
            rebuild = self.pruned_rebuild_pending,
            "async held copy replaced by the runner's pruned copy"
        );
        Ok(true)
    }

    /// The lowest ordinal a reconciliation may read: the first ordinal of a
    /// lineage that begins at a cut, else 0.
    fn reconcile_floor(&self) -> u64 {
        self.cut_first_ordinal
            .unwrap_or(0)
            .max(self.lineage_first_ordinal)
            .max(self.cut_seed.as_ref().map_or(0, |seed| seed.first_ordinal))
    }

    /// Repair every keep-range edit that would put back what a prune
    /// removed (see `without_restored_content`). An edit that cannot be
    /// repaired is dropped, so its part goes out as the runner's own bytes.
    /// Only a session the runner reported pruned is checked.
    pub(super) fn repair_restoring_edits(
        &self,
        ranges: &mut [view::ViewRange],
    ) -> Result<(), HandlerOutcome> {
        if self.reasoning_pruned.is_none() {
            return Ok(());
        }
        for range in ranges.iter_mut() {
            let view::ViewRange::Keep { edits, .. } = range else {
                continue;
            };
            let mut kept = Vec::with_capacity(edits.len());
            for edit in edits.drain(..) {
                match self.without_restored_content(edit.clone())? {
                    Some(repaired) => kept.push(repaired),
                    None => {
                        tracing::warn!(session_ref=%self.reference(), ordinal=edit.ordinal, part=%edit.part, reason="pruned_reasoning_restored", "async edit withheld: it would send back what the runner pruned");
                    }
                }
            }
            *edits = kept;
        }
        Ok(())
    }

    /// `edit` unchanged when it puts back nothing the runner pruned from its
    /// message (llm-runner's `restored_by_edit_in` for this conversation's
    /// serializer profile, over the runner's prune record). Otherwise the
    /// same edit with the pruned members taken from the reconciled held part
    /// (emptied or removed as the runner serves them), keeping everything
    /// the edit changes on purpose, such as a trimmed output; `None` when
    /// that still puts pruned content back.
    pub(super) fn without_restored_content(
        &self,
        edit: view::PartEdit,
    ) -> Result<Option<view::PartEdit>, HandlerOutcome> {
        if self.reasoning_pruned.is_none() {
            return Ok(Some(edit));
        }
        let Some(bytes) = &edit.bytes else {
            return Ok(Some(edit));
        };
        let pruned = self.pruned_part_list(Some(edit.ordinal));
        if pruned.is_empty() {
            return Ok(Some(edit));
        }
        let profile = self.serializer_profile()?;
        let restores = |part: &Value| {
            restored(archive_prunes_reasoning::restored_by_edit_in(
                profile,
                &pruned,
                edit.ordinal,
                &edit.part,
                part,
            ))
        };
        let sent: Value = serde_json::from_str(bytes).map_err(transient)?;
        if !restores(&sent) {
            return Ok(Some(edit));
        }
        let held = self
            .entries
            .get(&edit.ordinal)
            .map(|entry| entry.read())
            .transpose()?
            .and_then(|entry| {
                let index = entry.tags.iter().position(|row| row.part == edit.part)?;
                parts(&entry.message).ok()?.get(index).cloned()
            });
        let Some(held) = held else {
            return Ok(None);
        };
        // Take every candidate member from the held part, then put back each
        // one whose own value does not restore pruned content, so the edit
        // keeps all it changes on purpose.
        let mut candidates = Vec::new();
        missing_in_held(Some(&held), &sent, &mut Vec::new(), &mut candidates);
        let mut repaired = sent.clone();
        for path in &candidates {
            repaired = take_from(&repaired, &held, path).unwrap_or(repaired);
        }
        if restores(&repaired) {
            return Ok(None);
        }
        for path in &candidates {
            if let Some(trial) = take_from(&repaired, &sent, path).filter(|trial| !restores(trial))
            {
                repaired = trial;
            }
        }
        Ok(Some(view::PartEdit::replace(
            edit.ordinal,
            &edit.mid,
            &edit.part,
            serde_json::to_string(&repaired).map_err(transient)?,
        )))
    }

    /// Whether a replace range of this view would carry content of the kinds
    /// a prune removes, for an ordinal at or below the runner's
    /// `through_ordinal` (llm-runner's `restored_part_in` for this
    /// conversation's serializer profile). The first range of a lineage that
    /// begins above 0 stands for every ordinal below it as well. ck-mc does
    /// not hold the prune record for copies below its cut, so a range is
    /// checked against every kind the profile can carry.
    pub(super) fn replacement_restores_pruned(
        &self,
        ranges: &[view::ViewRange],
    ) -> Result<bool, HandlerOutcome> {
        let Some(state) = self.reasoning_pruned else {
            return Ok(false);
        };
        let profile = self.serializer_profile()?;
        let carried = archive_prunes_reasoning::kinds_carried(profile).unwrap_or(&[]);
        for (index, range) in ranges.iter().enumerate() {
            let view::ViewRange::Replace { from, to, bytes } = range else {
                continue;
            };
            let start = if index == 0 { 0 } else { *from };
            if start > state.through_ordinal {
                continue;
            }
            let Ok(messages) = serde_json::from_str::<Value>(bytes) else {
                continue;
            };
            let pruned = carried
                .iter()
                .map(|kind| PrunedPartAt::new(start, "", *kind))
                .chain(self.pruned_part_list(None))
                .collect::<Vec<_>>();
            let stands_for = start..(*to).max(start + 1);
            if restored(archive_prunes_reasoning::restored_part_in(
                profile, &pruned, stands_for, &messages,
            )) {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

impl McHandler {
    /// Bring the held copies in line with the runner's prune state `seen`
    /// when its generation differs from the one this record reconciled.
    /// Reads, with `session.read` and never below the cut, every held message
    /// from max(cut, the lowest held ordinal) through the lower of the newest
    /// held ordinal and `through_ordinal`. A message that differs is accepted
    /// in place only as a pruning (`accept_pruned_reread`); any other
    /// difference is refused as a changed transcript (`async entry changed
    /// on re-read`), and the caller reads the conversation again from scratch.
    pub(super) async fn reconcile_pruned_reasoning(
        &self,
        state: &mut State,
        seen: PruneState,
        budget: Duration,
    ) -> Result<Reconciled, HandlerOutcome> {
        if !seen.valid() || state.reasoning_pruned_generation() == Some(seen.generation) {
            return Ok(Reconciled::Complete);
        }
        let deadline = Instant::now() + budget;
        let floor = state.reconcile_floor();
        let first_held = state.entries.range(floor..).next().map(|(n, _)| *n);
        let last_held = state.entries.last_key_value().map(|(n, _)| *n);
        let mut replaced = 0usize;
        let mut read = 0usize;
        if let (Some(first), Some(last)) = (first_held, last_held) {
            let through = last.min(seen.through_ordinal);
            let mut from = first;
            while from <= through {
                if Instant::now() >= deadline {
                    tracing::info!(session_ref=%state.reference(), generation=seen.generation, next=from, "async prune reconcile incomplete; the next notice continues it");
                    return Ok(Reconciled::Incomplete);
                }
                let mut params = json!({
                    "from_ordinal": from,
                    "limit": through - from + 1,
                    "max_bytes": 1_048_576,
                    "media": "descriptors",
                });
                if let Some(lineage) = &state.lineage {
                    params["lineage_id"] = json!(lineage);
                }
                let page = self
                    .provider_runner
                    .call_for_identity(
                        &state.runner()?,
                        &state.runner_identity(),
                        "session.read",
                        params,
                        deadline.saturating_duration_since(Instant::now()),
                    )
                    .await
                    .map_err(runner_error)?;
                if page["lineage_id"].as_str() != state.lineage.as_deref() {
                    return Err(transient("async lineage changed"));
                }
                let pruned = listed(&page);
                let entries: Vec<ReadMessage> = decode(&page["messages"])?;
                let mut expected = from;
                for entry in entries {
                    if entry.ordinal != expected {
                        return Err(transient("async transcript gap"));
                    }
                    if entry.ordinal > through {
                        break;
                    }
                    expected += 1;
                    read += 1;
                    let Some(held) = state.entries.get(&entry.ordinal) else {
                        return Err(transient("async transcript gap"));
                    };
                    let held = held.read()?;
                    let rows = pruned.get(&entry.mid).map_or(&[][..], Vec::as_slice);
                    if stable_entry(&held, &entry) {
                        // Already held as pruned (read after the prune).
                        state.record_pruned_parts(entry.ordinal, rows);
                        continue;
                    }
                    if !state.accept_pruned_reread(&held, &entry, rows)? {
                        return Err(transient("async entry changed on re-read"));
                    }
                    replaced += 1;
                }
                if expected == from {
                    return Err(transient("async transcript shortened"));
                }
                from = expected;
                if from <= through && page["next_from_ordinal"].as_u64() != Some(from) {
                    return Err(transient("async paging did not advance"));
                }
            }
        }
        tracing::info!(
            session_ref = %state.reference(),
            generation = seen.generation,
            through_ordinal = seen.through_ordinal,
            read,
            replaced,
            rebuild = state.pruned_rebuild_pending,
            "async held copies reconciled with the runner's prune"
        );
        state.reasoning_pruned = Some(seen);
        Ok(Reconciled::Complete)
    }

    /// Reconcile at Setup (compaction-provider §4, the post-prune Setup) and
    /// return the stored Setup answer, which now names the pruning
    /// permission. A held copy that differs other than as a prune resets the
    /// conversation; it is read again from scratch at the next notice, and
    /// what it reads then is the runner's pruned bytes.
    pub(super) async fn reconcile_at_setup(
        &self,
        store: &McStore,
        reference: &str,
        seen: PruneState,
    ) -> Result<Value, HandlerOutcome> {
        let mut state = self
            .checkout(store, reference)?
            .ok_or_else(|| transient("async session disappeared"))?;
        match self
            .reconcile_pruned_reasoning(&mut state, seen, self.notice_read_budget())
            .await
        {
            Ok(_) => {}
            Err(error) => {
                tracing::warn!(session_ref=%reference, ?error, "async prune reconcile refused; reading the conversation again");
                state.reset(store)?;
                state.reasoning_pruned = Some(seen);
            }
        }
        state.set_pruning_permission(true)?;
        state.save(store, &[])?;
        let initial = state.initial.clone();
        self.checkin(state);
        Ok(initial)
    }

    /// The runner's current prune state, from `session.head` (the authority).
    pub(super) async fn runner_prune_state(
        &self,
        state: &State,
        budget: Duration,
    ) -> Result<Option<PruneState>, HandlerOutcome> {
        let head = self
            .provider_runner
            .call_for_identity(
                &state.runner()?,
                &state.runner_identity(),
                "session.head",
                json!({}),
                budget,
            )
            .await
            .map_err(runner_error)?;
        Ok(reported(&head))
    }
}
