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
//! removed: `restores_pruned` and `replacement_restores` check every edit and
//! replacement a view sends once the runner has reported a prune.
use super::*;
use cortexkit_role_llm_runner::archive_prunes_reasoning::{kinds, PrunedReasoning};

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

/// A reasoning part in any of the formats ck-mc reads: owned-broca and
/// OpenCode `reasoning`, owned-broca `redacted_reasoning`, Anthropic and Pi
/// `thinking` and `redacted_thinking`.
fn reasoning_like(part: &Value) -> bool {
    matches!(
        part.get("type").and_then(Value::as_str),
        Some("reasoning" | "redacted_reasoning" | "thinking" | "redacted_thinking")
    )
}

/// A member that holds a provider signature: `signature`,
/// `thought_signature`, OpenCode's `thoughtSignature`, and the like.
fn signature_key(key: &str) -> bool {
    key.to_ascii_lowercase().contains("signature")
}

/// One way a pruned part differs from the part as written.
enum Change {
    /// A member is gone.
    Removed(Vec<String>),
    /// A string is now empty.
    Emptied(Vec<String>),
}

impl Change {
    fn path(&self) -> &[String] {
        match self {
            Self::Removed(path) | Self::Emptied(path) => path,
        }
    }
}

/// Compare `served` with `held`, recording each removed member and each
/// emptied string. Anything else (a new member, a changed value, a reordered
/// or resized array) makes the comparison fail. A string that holds JSON
/// (owned-broca's `redacted_reasoning.data`) is compared as that JSON, so a
/// member removed inside it is a removal too.
fn compare(
    held: &Value,
    served: &Value,
    path: &mut Vec<String>,
    changes: &mut Vec<Change>,
) -> bool {
    if held == served {
        return true;
    }
    match (held, served) {
        (Value::Object(held), Value::Object(served)) => {
            for (key, value) in served {
                let Some(original) = held.get(key) else {
                    return false;
                };
                path.push(key.clone());
                let same = compare(original, value, path, changes);
                path.pop();
                if !same {
                    return false;
                }
            }
            for key in held.keys().filter(|key| !served.contains_key(*key)) {
                let mut removed = path.clone();
                removed.push(key.clone());
                changes.push(Change::Removed(removed));
            }
            true
        }
        (Value::Array(held), Value::Array(served)) if held.len() == served.len() => {
            for (index, (original, value)) in held.iter().zip(served).enumerate() {
                path.push(index.to_string());
                let same = compare(original, value, path, changes);
                path.pop();
                if !same {
                    return false;
                }
            }
            true
        }
        (Value::String(_), Value::String(served)) if served.is_empty() => {
            changes.push(Change::Emptied(path.clone()));
            true
        }
        (Value::String(held), Value::String(served)) => {
            match (
                serde_json::from_str::<Value>(held),
                serde_json::from_str::<Value>(served),
            ) {
                (Ok(held @ (Value::Object(_) | Value::Array(_))), Ok(served)) => {
                    path.push("<json>".into());
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

/// Whether `served` is the part `held` after a prune of `kind`, and nothing
/// else (llm-runner §9.14.1):
///
/// - `reasoning` empties a reasoning part: strings emptied, optional members
///   such as a signature removed;
/// - `opaque_reasoning` removes only encrypted or opaque members of a
///   reasoning part, so its readable summary stays byte-identical;
/// - `signature` removes or empties only a provider signature on a part that
///   is not reasoning, so its text and call arguments stay byte-identical.
///
/// A part's type never changes. A kind the contract does not define is not
/// trusted, so a part listed with one is never accepted.
fn pruned_as(kind: &str, held: &Value, served: &Value) -> bool {
    if held.get("type") != served.get("type") {
        return false;
    }
    let mut changes = Vec::new();
    if !compare(held, served, &mut Vec::new(), &mut changes) {
        return false;
    }
    match kind {
        kinds::REASONING => reasoning_like(held),
        kinds::OPAQUE_REASONING => {
            reasoning_like(held)
                && changes.iter().all(|change| {
                    !change
                        .path()
                        .iter()
                        .any(|key| key.to_ascii_lowercase().contains("summary"))
                })
        }
        kinds::SIGNATURE => {
            !reasoning_like(held)
                && changes
                    .iter()
                    .all(|change| change.path().iter().any(|key| signature_key(key)))
        }
        _ => false,
    }
}

/// Whether `fresh`, a re-read of the held message `held`, differs from it
/// only as the contract's re-read rule allows: every member but the message
/// body is unchanged, every part the page does not list is byte-identical,
/// and every listed part keeps its index and key, carries its write-time
/// digest, and differs from the held part only as its kind allows
/// (`pruned_as`).
pub(super) fn accepts(held: &ReadMessage, fresh: &ReadMessage, listed: &[PrunedReasoning]) -> bool {
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
        if !pruned_as(&row.kind, original, served) {
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

/// Every string a part holds, with the member path that leads to it. A
/// string that holds JSON is walked as that JSON too.
fn strings(value: &Value, path: &mut Vec<String>, out: &mut Vec<(Vec<String>, String)>) {
    match value {
        Value::Object(members) => {
            for (key, member) in members {
                path.push(key.clone());
                strings(member, path, out);
                path.pop();
            }
        }
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                path.push(index.to_string());
                strings(item, path, out);
                path.pop();
            }
        }
        Value::String(text) => {
            out.push((path.clone(), text.clone()));
            if let Ok(inner @ (Value::Object(_) | Value::Array(_))) = serde_json::from_str(text) {
                path.push("<json>".into());
                strings(&inner, path, out);
                path.pop();
            }
        }
        _ => {}
    }
}

/// The string at `path` in `value`, following the paths `strings` records.
fn string_at(value: &Value, path: &[String]) -> Option<String> {
    let Some((first, rest)) = path.split_first() else {
        return value.as_str().map(str::to_owned);
    };
    if first == "<json>" {
        let inner: Value = serde_json::from_str(value.as_str()?).ok()?;
        return string_at(&inner, rest);
    }
    let next = match value {
        Value::Object(members) => members.get(first)?,
        Value::Array(items) => items.get(first.parse::<usize>().ok()?)?,
        _ => return None,
    };
    string_at(next, rest)
}

/// Whether `sent`, the bytes a part edit sends for the held part `held`,
/// puts back content a prune removed from it: a provider signature the held
/// copy no longer carries (a call's thought signature, a text part's
/// provider-state signature), or reasoning content where the held reasoning
/// part is now empty. A held copy is the runner's current one once ck-mc
/// reconciled it, so an edit built from it never trips this; one replayed
/// from bytes captured before the prune does.
pub(super) fn restores_pruned(held: &Value, sent: &Value) -> bool {
    let mut found = Vec::new();
    strings(sent, &mut Vec::new(), &mut found);
    let reasoning = reasoning_like(held) || reasoning_like(sent);
    found.into_iter().any(|(path, text)| {
        if text.is_empty() {
            return false;
        }
        let kept = string_at(held, &path);
        if path.iter().any(|key| signature_key(key)) {
            return kept.as_deref() != Some(text.as_str());
        }
        reasoning && kept.as_deref().is_none_or(str::is_empty)
    })
}

/// `sent` with every provider signature the held copy no longer carries
/// put back as the held copy has it: emptied where the held part keeps an
/// empty one, removed where it has none. What the edit changes on purpose
/// (an output, a text) stays as it is. `None` when the bytes still restore
/// pruned content after that (reasoning content in a pruned reasoning part).
fn without_restored(held: &Value, sent: &Value) -> Option<Value> {
    fn repair(held: Option<&Value>, sent: &mut Value) {
        let Value::Object(members) = sent else {
            if let Value::Array(items) = sent {
                for (index, item) in items.iter_mut().enumerate() {
                    repair(held.and_then(|held| held.get(index)), item);
                }
            }
            return;
        };
        let keys = members.keys().cloned().collect::<Vec<_>>();
        for key in keys {
            let original = held.and_then(|held| held.get(&key));
            if signature_key(&key) && members.get(&key) != original {
                match original {
                    Some(original) => {
                        members.insert(key, original.clone());
                    }
                    None => {
                        members.remove(&key);
                    }
                }
            } else if let Some(member) = members.get_mut(&key) {
                repair(original, member);
            }
        }
    }
    let mut repaired = sent.clone();
    repair(Some(held), &mut repaired);
    (!restores_pruned(held, &repaired)).then_some(repaired)
}

/// Whether replacement messages ck-mc authored carry content of the kinds a
/// prune removes: a reasoning part with any payload, or any provider
/// signature. ck-mc authors history heads, emptied messages and cut splits;
/// none of them carries either, so this holds only if held bytes leaked in.
pub(super) fn replacement_restores(bytes: &str) -> bool {
    let Ok(messages) = serde_json::from_str::<Value>(bytes) else {
        return false;
    };
    let mut found = Vec::new();
    strings(&messages, &mut Vec::new(), &mut found);
    if found
        .iter()
        .any(|(path, text)| !text.is_empty() && path.iter().any(|key| signature_key(key)))
    {
        return true;
    }
    fn reasoning_with_payload(value: &Value) -> bool {
        match value {
            Value::Object(members) => {
                (reasoning_like(value)
                    && members.iter().any(|(key, member)| {
                        key != "type" && member.as_str().is_some_and(|text| !text.is_empty())
                    }))
                    || members.values().any(reasoning_with_payload)
            }
            Value::Array(items) => items.iter().any(reasoning_with_payload),
            _ => false,
        }
    }
    reasoning_with_payload(&messages)
}

impl AsyncRecord {
    /// The prune generation these held copies were last reconciled with.
    pub(super) fn reasoning_pruned_generation(&self) -> Option<u64> {
        self.reasoning_pruned.map(|state| state.generation)
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
        if !accepts(held, fresh, listed) {
            return Ok(false);
        }
        let entry = HeldEntry::from_read(fresh)?;
        #[cfg(test)]
        let entry = entry.counted_as(self.reference());
        self.entries.insert(fresh.ordinal, Arc::new(entry));
        self.journal.replaced.insert(fresh.ordinal);
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
    /// removed (see `restores_pruned`): its signatures are taken from the
    /// held copy, and what the edit changes on purpose stays. An edit that
    /// cannot be repaired is dropped, so its part goes out as the runner's
    /// own bytes. Only a session the runner reported pruned is checked.
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

    /// `edit`, or the same edit with the signatures its held part no longer
    /// carries taken out, when its bytes would put back what a prune removed;
    /// `None` when they cannot be taken out. A drop, and an edit of a part
    /// whose bytes carry nothing pruned, are returned unchanged.
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
        let Some(entry) = self.entries.get(&edit.ordinal) else {
            return Ok(Some(edit));
        };
        let entry = entry.read()?;
        let Some(index) = entry.tags.iter().position(|row| row.part == edit.part) else {
            return Ok(Some(edit));
        };
        let Some(held) = parts(&entry.message)?.get(index).cloned() else {
            return Ok(Some(edit));
        };
        let sent: Value = serde_json::from_str(bytes).map_err(transient)?;
        if !restores_pruned(&held, &sent) {
            return Ok(Some(edit));
        }
        Ok(without_restored(&held, &sent)
            .map(|repaired| {
                serde_json::to_string(&repaired).map(|bytes| {
                    view::PartEdit::replace(edit.ordinal, &edit.mid, &edit.part, bytes)
                })
            })
            .transpose()
            .map_err(transient)?)
    }

    /// Whether a replace range of this view would carry content of the kinds
    /// a prune removes for an ordinal the runner pruned through. The first
    /// range of a lineage that begins above 0 stands for every ordinal below
    /// it as well.
    pub(super) fn replacement_restores_pruned(&self, ranges: &[view::ViewRange]) -> bool {
        let Some(state) = self.reasoning_pruned else {
            return false;
        };
        ranges.iter().enumerate().any(|(index, range)| match range {
            view::ViewRange::Replace { from, bytes, .. } => {
                let start = if index == 0 { 0 } else { *from };
                start <= state.through_ordinal && replacement_restores(bytes)
            }
            _ => false,
        })
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
                    if stable_entry(&held, &entry) {
                        continue;
                    }
                    let rows = pruned.get(&entry.mid).map_or(&[][..], Vec::as_slice);
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
