//! Native edits already acknowledged by the runner, independent of engine cache eviction.
use super::*;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
struct FrozenPart {
    mid: String,
    part: String,
    digest: String,
    bytes: Option<String>,
    #[serde(default, skip_serializing_if = "is_zero")]
    ack_version: u64,
}

fn is_zero(value: &u64) -> bool {
    *value == 0
}

impl FrozenPart {
    fn retained_bytes(&self) -> usize {
        192 + self.mid.len() * 2
            + self.part.len() * 2
            + self.digest.len()
            + self.bytes.as_ref().map_or(0, String::len)
    }
}

#[derive(Default, Clone)]
pub(super) struct FrozenEdits {
    parts: BTreeMap<(String, String, String), FrozenPart>,
    pub(super) retained_bytes: usize,
    pub(super) dirty: bool,
}

impl Serialize for FrozenEdits {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_seq(self.parts.values())
    }
}

impl<'de> Deserialize<'de> for FrozenEdits {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let parts = Vec::<FrozenPart>::deserialize(deserializer)?;
        let mut edits = Self::default();
        for part in parts {
            edits.insert(part);
        }
        edits.dirty = false;
        Ok(edits)
    }
}

impl FrozenEdits {
    pub(super) fn from_json(json: &str) -> Result<Self, HandlerOutcome> {
        serde_json::from_str(json).map_err(transient)
    }

    pub(super) fn json(&self) -> Result<String, HandlerOutcome> {
        serde_json::to_string(self).map_err(transient)
    }

    fn insert(&mut self, part: FrozenPart) {
        let key = (part.mid.clone(), part.part.clone(), part.digest.clone());
        // An old cut can replay an older edit of the same surviving source.
        // Public view versions, not archive-read order, select the latest
        // acknowledged bytes for that source.
        if self
            .parts
            .get(&key)
            .is_some_and(|old| old.ack_version > part.ack_version)
        {
            return;
        }
        if self.parts.get(&key) == Some(&part) {
            return;
        }
        self.retained_bytes += part.retained_bytes() + part.digest.len();
        if let Some(old) = self.parts.insert(key, part) {
            self.retained_bytes -= old.retained_bytes() + old.digest.len();
        }
        self.dirty = true;
    }

    /// Record a whole-part drop that was applied before ck-mc served the session:
    /// a reduction the standalone plugin applied before the offline move.
    pub(super) fn insert_drop(&mut self, mid: &str, part: &str, digest: &str) {
        self.insert(FrozenPart {
            mid: mid.to_owned(),
            part: part.to_owned(),
            digest: digest.to_owned(),
            bytes: None,
            ack_version: 0,
        });
    }

    /// Whether this exact source part is dropped whole: the view leaves it out,
    /// so the runner sends none of its bytes.
    pub(super) fn drops_whole(&self, mid: &str, part: &str, digest: &str) -> bool {
        self.parts
            .get(&(mid.to_owned(), part.to_owned(), digest.to_owned()))
            .is_some_and(|frozen| frozen.bytes.is_none())
    }

    pub(super) fn has_whole_drops(&self) -> bool {
        self.parts.values().any(|frozen| frozen.bytes.is_none())
    }

    pub(super) fn merge(&mut self, acknowledged: &Self) {
        for part in acknowledged.parts.values() {
            self.insert(part.clone());
        }
    }

    pub(super) fn matching_sources(
        &self,
        mid_index: &BTreeMap<String, u64>,
        entries: &BTreeMap<u64, Arc<HeldEntry>>,
    ) -> Result<Self, HandlerOutcome> {
        let mut matched = Self::default();
        let mut sources = HashMap::new();
        for part in self.parts.values() {
            let Some(ordinal) = mid_index.get(&part.mid) else {
                continue;
            };
            if !sources.contains_key(ordinal) {
                sources.insert(*ordinal, entries[ordinal].read()?);
            }
            let entry = &sources[ordinal];
            if entry.tags.iter().any(|row| row.part == part.part)
                && served_part_digest(entry, &part.part).ok().as_ref() == Some(&part.digest)
            {
                matched.insert(part.clone());
            }
        }
        Ok(matched)
    }

    pub(super) fn stamp_version(&mut self, version: u64) {
        for part in self.parts.values_mut() {
            part.ack_version = part.ack_version.max(version);
        }
        self.dirty = true;
    }

    pub(super) fn message_snapshots(&self) -> Result<Vec<(String, String)>, HandlerOutcome> {
        let mut messages = BTreeMap::<&str, Vec<&FrozenPart>>::new();
        for part in self.parts.values() {
            messages.entry(&part.mid).or_default().push(part);
        }
        messages
            .into_iter()
            .map(|(mid, parts)| {
                Ok((
                    mid.to_owned(),
                    serde_json::to_string(&parts).map_err(transient)?,
                ))
            })
            .collect()
    }

    /// Only the edits of the messages `mids`: a window's acknowledged edits,
    /// carried into a lineage that begins at a cut.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) fn only_mids(&self, mids: &std::collections::HashSet<String>) -> Self {
        let mut kept = Self::default();
        for part in self.parts.values().filter(|part| mids.contains(&part.mid)) {
            kept.insert(part.clone());
        }
        kept
    }

    /// Forget the edits of the messages `mids`: rows below a cut, which no
    /// view renders again.
    // Only cut capture and pruning (`cut_seed`) call this; only tests drive them so far.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) fn forget_mids(&mut self, mids: &std::collections::HashSet<String>) {
        let before = self.parts.len();
        self.parts.retain(|(mid, _, _), _| !mids.contains(mid));
        if self.parts.len() != before {
            self.retained_bytes = self
                .parts
                .values()
                .map(|part| part.retained_bytes() + part.digest.len())
                .sum();
            self.dirty = true;
        }
    }

    /// Capture the actual native bytes, not a newly rendered reduction whose tags may differ.
    pub(super) fn capture(
        &mut self,
        view: &view::CompactionView,
        entries: &BTreeMap<u64, Arc<HeldEntry>>,
    ) -> Result<(), HandlerOutcome> {
        for range in &view.ranges {
            if let view::ViewRange::Keep { edits, .. } = range {
                self.capture_versioned_edits(edits, entries, view.view_version)?;
            }
        }
        Ok(())
    }

    /// Capture part edits that are not in the view's keep ranges: the drops of
    /// a message the view removes whole (`emptied_messages::shape`). A later
    /// pass re-anchors them like any served drop, so the message stays
    /// removed even after the engine forgot the reduction.
    pub(super) fn capture_edits(
        &mut self,
        edits: &[view::PartEdit],
        entries: &BTreeMap<u64, Arc<HeldEntry>>,
    ) -> Result<(), HandlerOutcome> {
        self.capture_versioned_edits(edits, entries, 0)
    }

    fn capture_versioned_edits(
        &mut self,
        edits: &[view::PartEdit],
        entries: &BTreeMap<u64, Arc<HeldEntry>>,
        ack_version: u64,
    ) -> Result<(), HandlerOutcome> {
        let mut source = None;
        for edit in edits {
            if source
                .as_ref()
                .is_none_or(|entry: &ReadMessage| entry.ordinal != edit.ordinal)
            {
                source = entries
                    .get(&edit.ordinal)
                    .map(|entry| entry.read())
                    .transpose()?;
            }
            let Some(entry) = source.as_ref().filter(|entry| entry.mid == edit.mid) else {
                continue;
            };
            if !entry.tags.iter().any(|row| row.part == edit.part) {
                continue;
            }
            let Ok(digest) = served_part_digest(entry, &edit.part) else {
                continue;
            };
            let part = FrozenPart {
                mid: edit.mid.clone(),
                part: edit.part.clone(),
                digest,
                bytes: edit.bytes.clone(),
                ack_version,
            };
            self.insert(part);
        }
        Ok(())
    }

    /// Whether an acknowledged view replaced part `part` of message `mid`
    /// with exactly `bytes`.
    pub(super) fn served(&self, mid: &str, part: &str, bytes: &str) -> bool {
        self.parts
            .range((mid.to_owned(), part.to_owned(), String::new())..)
            .take_while(|((at, key, _), _)| at == mid && key == part)
            .any(|(_, frozen)| frozen.bytes.as_deref() == Some(bytes))
    }

    /// Re-anchor by source identity, never by an ordinal retained from another lineage.
    ///
    /// Parts are filled one at a time. A saved native replacement keeps its
    /// companion source side, so a new drop cannot rewrite the saved bytes.
    /// Remaining dropped arcs are made whole (`tool_arcs::complete_dropped_arcs`):
    /// a re-anchored drop must not leave its other side served. Last, each keep
    /// range's edits are put in the order the contract requires: by ordinal,
    /// then by the part's position in its message (`tool_arcs::sort_edits`).
    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) fn apply(
        &self,
        mid_index: &BTreeMap<String, u64>,
        entries: &BTreeMap<u64, Arc<HeldEntry>>,
        kept: &tool_arcs::KeptMessages,
        ranges: &mut [view::ViewRange],
    ) -> Result<(), HandlerOutcome> {
        self.apply_revised(mid_index, entries, kept, ranges, |edit| Ok(Some(edit)))
    }

    /// `apply`, with each saved edit passed through `revise` first: it
    /// returns the edit to replay, a corrected one (bytes acknowledged before
    /// the runner pruned the part, rewritten as the runner rewrites its own
    /// applied edits; see `pruned_reasoning`), or `None` to replay
    /// nothing for that part, so the view keeps the edit this pass built from
    /// the current held copy.
    pub(super) fn apply_revised(
        &self,
        mid_index: &BTreeMap<String, u64>,
        entries: &BTreeMap<u64, Arc<HeldEntry>>,
        kept: &tool_arcs::KeptMessages,
        ranges: &mut [view::ViewRange],
        revise: impl Fn(view::PartEdit) -> Result<Option<view::PartEdit>, HandlerOutcome>,
    ) -> Result<(), HandlerOutcome> {
        let mut anchored: BTreeMap<u64, Vec<view::PartEdit>> = BTreeMap::new();
        let mut sources = HashMap::new();
        for part in self.parts.values() {
            let Some(ordinal) = mid_index.get(&part.mid) else {
                continue;
            };
            if !sources.contains_key(ordinal) {
                sources.insert(*ordinal, entries[ordinal].read()?);
            }
            let entry = &sources[ordinal];
            if !entry.tags.iter().any(|row| row.part == part.part)
                || served_part_digest(entry, &part.part).ok().as_ref() != Some(&part.digest)
            {
                continue;
            }
            let edit = match &part.bytes {
                Some(bytes) => view::PartEdit::replace(*ordinal, &part.mid, &part.part, bytes),
                None => view::PartEdit::drop(*ordinal, &part.mid, &part.part),
            };
            let Some(edit) = revise(edit)? else {
                continue;
            };
            anchored.entry(*ordinal).or_default().push(edit);
        }
        for range in ranges.iter_mut() {
            let view::ViewRange::Keep { from, to, edits } = range else {
                continue;
            };
            for (_, saved) in anchored.range(*from..*to) {
                for part in saved {
                    // A rebuilt engine may express an old native replacement
                    // as a generic drop. Keep the bytes already acknowledged
                    // for the same source identity instead of rewriting them.
                    if let Some(current) = edits
                        .iter_mut()
                        .find(|edit| edit.ordinal == part.ordinal && edit.part == part.part)
                    {
                        *current = part.clone();
                    } else {
                        edits.push(part.clone());
                    }
                }
            }
        }
        tool_arcs::preserve_acknowledged_arcs(kept, &anchored, ranges);
        tool_arcs::complete_dropped_arcs(kept, ranges);
        for range in ranges.iter_mut() {
            if let view::ViewRange::Keep { edits, .. } = range {
                tool_arcs::sort_edits(kept, edits);
            }
        }
        Ok(())
    }
}

/// Keep publication-time provenance for versions whose engine baselines are
/// retired during a resync before acknowledgement. Native views remain immutable.
#[derive(Default)]
pub(super) struct RetiredViews {
    pub(super) views: BTreeMap<u64, Arc<FrozenEdits>>,
    pub(super) dirty: bool,
}

impl RetiredViews {
    pub(super) fn from_json(json: &str) -> Result<Self, HandlerOutcome> {
        let views: BTreeMap<u64, FrozenEdits> = serde_json::from_str(json).map_err(transient)?;
        Ok(Self {
            views: views
                .into_iter()
                .map(|(n, edits)| (n, Arc::new(edits)))
                .collect(),
            dirty: false,
        })
    }

    pub(super) fn json(&self) -> Result<String, HandlerOutcome> {
        serde_json::to_string(
            &self
                .views
                .iter()
                .map(|(n, edits)| (n, edits.as_ref()))
                .collect::<BTreeMap<_, _>>(),
        )
        .map_err(transient)
    }

    pub(super) fn retain_from(&mut self, floor: u64) {
        let before = self.views.len();
        self.views.retain(|version, _| *version >= floor);
        self.dirty |= self.views.len() != before;
    }

    /// Forget edits of the messages `mids` in every retired view.
    // Only cut capture and pruning (`cut_seed`) call this; only tests drive them so far.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) fn forget_mids(&mut self, mids: &std::collections::HashSet<String>) {
        for edits in self.views.values_mut() {
            if edits.parts.keys().any(|(mid, _, _)| mids.contains(mid)) {
                Arc::make_mut(edits).forget_mids(mids);
                self.dirty = true;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_older_cut_cannot_overwrite_newer_acknowledged_bytes() {
        let snapshot = |version, bytes| {
            FrozenEdits::from_json(&json!([{
            "mid":"m104", "part":"1", "digest":"same-source", "bytes":bytes, "ack_version":version
        }]).to_string()).unwrap()
        };
        let old = snapshot(1, "old-cut");
        let current = snapshot(6, "acknowledged");
        let mut merged = current.clone();
        merged.merge(&old);
        assert!(merged.served("m104", "1", "acknowledged"));
        assert!(!merged.served("m104", "1", "old-cut"));
        let mut reversed = old;
        reversed.merge(&current);
        assert_eq!(merged.json().unwrap(), reversed.json().unwrap());
    }

    /// An Anthropic assistant message of `count` text parts keyed "0", "1",
    /// ..., with a `tool_use` as its last part when `call` names one.
    fn message(ordinal: u64, count: usize, call: Option<&str>) -> ReadMessage {
        let mut content: Vec<Value> = (0..count)
            .map(|index| json!({"type":"text","text":format!("part {index}")}))
            .collect();
        if let Some(id) = call {
            content.push(json!({"type":"tool_use","id":id,"name":"read","input":{}}));
        }
        let tags = (0..content.len())
            .map(|index| tags::PartTag::untagged(index.to_string()))
            .collect();
        ReadMessage::new(
            ordinal,
            format!("m{ordinal}"),
            json!({"role":"assistant","content":content}),
        )
        .with_tags(tags)
    }

    fn result(ordinal: u64, call: &str) -> ReadMessage {
        ReadMessage::new(
            ordinal,
            format!("m{ordinal}"),
            json!({"role":"user","content":[{"type":"tool_result","tool_use_id":call,"content":"out"}]}),
        )
        .with_tags(vec![tags::PartTag::untagged("0")])
    }

    struct Fixture {
        entries: BTreeMap<u64, Arc<HeldEntry>>,
        mid_index: BTreeMap<String, u64>,
        kept: tool_arcs::KeptMessages,
        frozen: FrozenEdits,
    }

    impl Fixture {
        fn new(messages: &[ReadMessage]) -> Self {
            let mut fixture = Self {
                entries: BTreeMap::new(),
                mid_index: BTreeMap::new(),
                kept: BTreeMap::new(),
                frozen: FrozenEdits::default(),
            };
            for entry in messages {
                fixture.entries.insert(
                    entry.ordinal,
                    Arc::new(HeldEntry::from_read(entry).unwrap()),
                );
                fixture.mid_index.insert(entry.mid.clone(), entry.ordinal);
                fixture.kept.insert(
                    entry.ordinal,
                    tool_arcs::KeptMessage::new(codec::Codec::AnthropicMessages, entry).unwrap(),
                );
            }
            fixture
        }

        /// Record that an acknowledged view dropped part `index` of `entry`.
        fn acknowledged_drop(&mut self, entry: &ReadMessage, index: usize) {
            let native = parts(&entry.message).unwrap();
            self.frozen.insert_drop(
                &entry.mid,
                &entry.tags[index].part,
                &contract::digest::content_digest(&native[index]),
            );
        }

        fn apply(&self, ranges: &mut [view::ViewRange]) {
            self.frozen
                .apply(&self.mid_index, &self.entries, &self.kept, ranges)
                .unwrap();
        }

        /// The contract's own check that every message's edits follow its
        /// part order (`rejected:edit_order` on the runner).
        fn part_order(
            &self,
            ranges: Vec<view::ViewRange>,
        ) -> Result<(), Option<view::ViewProblem>> {
            let last = *self.entries.keys().last().unwrap();
            let view = view::CompactionView::new(
                "00000000000000000000000000000000",
                1,
                "L",
                compact::lineage::MessageRef {
                    ordinal: last,
                    mid: format!("m{last}"),
                },
                ranges,
            );
            view.check().unwrap();
            view.check_parts(|ordinal| {
                self.entries.get(&ordinal).map(|entry| {
                    entry
                        .read()
                        .unwrap()
                        .tags
                        .iter()
                        .map(|row| row.part.clone())
                        .collect()
                })
            })
        }
    }

    /// Part keys "0" to "11": an acknowledged drop of part "10" re-anchored
    /// next to this pass's edit of part "2" must follow it, although "10"
    /// sorts before "2" as a string.
    #[test]
    fn re_anchored_edits_follow_part_position_past_ten_parts() {
        let entry = message(0, 12, None);
        let mut fixture = Fixture::new(std::slice::from_ref(&entry));
        fixture.acknowledged_drop(&entry, 10);
        let replace = view::PartEdit::replace(0, "m0", "2", r#"{"type":"text","text":"short"}"#);
        let mut ranges = vec![view::ViewRange::keep_with_edits(
            0,
            1,
            vec![replace.clone()],
        )];
        fixture.apply(&mut ranges);
        assert_eq!(
            ranges,
            vec![view::ViewRange::keep_with_edits(
                0,
                1,
                vec![replace, view::PartEdit::drop(0, "m0", "10")]
            )]
        );
        assert_eq!(fixture.part_order(ranges), Ok(()));
    }

    /// A drop that completes a tool arc is added after the per-part fill and
    /// lands in part order too: part "12" (the `tool_use`) after "2" and "10".
    #[test]
    fn a_completed_arc_drop_follows_part_position() {
        let call = message(0, 12, Some("call1"));
        let answer = result(1, "call1");
        let mut fixture = Fixture::new(&[call.clone(), answer.clone()]);
        fixture.acknowledged_drop(&call, 10);
        fixture.acknowledged_drop(&answer, 0);
        let replace = view::PartEdit::replace(0, "m0", "2", r#"{"type":"text","text":"short"}"#);
        let mut ranges = vec![view::ViewRange::keep_with_edits(
            0,
            2,
            vec![replace.clone()],
        )];
        fixture.apply(&mut ranges);
        assert_eq!(
            ranges,
            vec![view::ViewRange::keep_with_edits(
                0,
                2,
                vec![
                    replace,
                    view::PartEdit::drop(0, "m0", "10"),
                    view::PartEdit::drop(0, "m0", "12"),
                    view::PartEdit::drop(1, "m1", "0"),
                ]
            )]
        );
        assert_eq!(fixture.part_order(ranges), Ok(()));
    }
}
