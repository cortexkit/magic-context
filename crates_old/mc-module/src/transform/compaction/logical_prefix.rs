//! A covered logical prefix omits source rows only after a successful rebuild
//! certifies them as covered. It retains the live boundary,
//! system sources, and an arc-safe consecutive suffix with original ordinals.
use super::*;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
struct Coverage {
    sequence: i64,
    from: i64,
    to: i64,
    boundary: String,
}

impl From<&StoredCompartment> for Coverage {
    fn from(c: &StoredCompartment) -> Self {
        Self {
            sequence: c.sequence,
            from: c.start_message,
            to: c.end_message,
            boundary: c.end_message_id.clone(),
        }
    }
}

fn coverage_preserved(old: &[Coverage], current: &[StoredCompartment]) -> bool {
    let mut ranges = current.iter().collect::<Vec<_>>();
    ranges.sort_by_key(|c| c.start_message);
    old.iter().all(|old| {
        let mut next = old.from;
        for c in &ranges {
            if c.start_message <= next && c.end_message >= next {
                next = c.end_message.saturating_add(1);
            }
        }
        next > old.to
    })
}

/// A persisted protected tag row: number, block id, kind, tokens, created at.
pub(crate) type ProtectionTag = (i64, String, String, i64, i64);

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct LogicalPrefix {
    pub(crate) lineage: String,
    pub(crate) generation: u64,
    pub(crate) from: u64,
    pub(crate) tail_from: u64,
    /// Authored user turns omitted from the projection. Channel-1 cadence
    /// counts the whole conversation even when its model input is bounded.
    pub(crate) covered_user_turns: u64,
    /// Source extent observed when this rebuild certified the omitted prefix.
    certified_through: u64,
    coverage: u64,
    boundary: String,
    sequence: i64,
    revert_epoch: u64,
    compartments: Vec<Coverage>,
    /// Ordinals of original system messages and the source message containing
    /// the durable lineage anchor; all must remain available before the cut.
    pub(crate) context_ordinals: BTreeSet<u64>,
    /// Native source messages with their content, not just identities: a hard rebuild must
    /// render the covered system content again without decoding covered rows.
    pub(crate) context_sources: BTreeMap<u64, crate::providers::codec::InboundMessage>,
    /// A frozen target can be absent because its source is covered; that absence
    /// alone does not mean a revert removed it from the transcript.
    covered_targets: BTreeSet<String>,
    /// Source invocation and result ordinals for arcs crossing coverage. The
    /// suffix begins before their invocations, so native blocks stay intact.
    crossing_arcs: Vec<(u64, u64)>,
    tag_summary: (u64, usize, i64),
    protection_floor: u64,
    protection_ratio: f64,
    /// Global newest tool-tag suffix, including protected tags whose sources
    /// are no longer live. Protection is based on persisted tags, not messages.
    protection_tags: Vec<(i64, String, String, i64, i64)>,
    /// Set on a prefix built from a cut seed (`for_cut`): the rows below
    /// `tail_from` are gone from the transcript for good, not merely omitted,
    /// and this is the highest tag number any of them carried. See `for_cut`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cut_max_tag: Option<i64>,
    /// For a cut prefix, the creation and completion times of the message
    /// just below `tail_from`, which the temporal walk compares the first
    /// window message against.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) cut_time_basis: Option<(Option<i64>, Option<i64>)>,
    #[serde(default)]
    pub(crate) signature_prefix: Option<crate::tail_hygiene::signature::SignaturePrefix>,
}

/// What a lineage that begins at a cut keeps of the rows below its first
/// ordinal, in the form the engine reads through a logical prefix. The
/// provider builds it from its cut seed; see `LogicalPrefix::for_cut`.
#[derive(Clone, Debug)]
pub(crate) struct CutPrefixFacts {
    pub(crate) signature_prefix: Option<crate::tail_hygiene::signature::SignaturePrefix>,
    /// The ordinal the engine's ranges start at: the first ordinal of the
    /// lineage the cut was taken from, so the engine's view of the
    /// conversation is the one full processing would hold.
    pub lineage_from: u64,
    /// The first ordinal the transcript still has (one past the cut).
    pub first_ordinal: u64,
    pub covered_user_turns: u64,
    pub context_sources: BTreeMap<u64, crate::providers::codec::InboundMessage>,
    pub compartment_seq: i64,
    pub boundary: String,
    /// The revert epoch of the namespace the prefix is used with.
    pub revert_epoch: u64,
    pub protection_floor: u64,
    pub protection_ratio: f64,
    pub protection_tags: Vec<(i64, String, String, i64, i64)>,
    pub max_tag: i64,
    pub time_basis: Option<(Option<i64>, Option<i64>)>,
}

/// Distinct authored user messages among `blocks` below `before`, outside
/// `context`: the count a logical prefix carries as `covered_user_turns`.
pub(crate) fn user_turns_below(blocks: &[FlatBlock], before: u64, context: &BTreeSet<u64>) -> u64 {
    blocks
        .iter()
        .filter(|b| {
            b.ordinal < before && !context.contains(&b.ordinal) && b.role == "user" && !b.synthetic
        })
        .map(|b| b.mid.as_str())
        .collect::<HashSet<_>>()
        .len() as u64
}

impl LogicalPrefix {
    pub(crate) fn matches(
        &self,
        lineage: &str,
        generation: u64,
        loaded: &mc_store::LoadedState,
        compartments: &[StoredCompartment],
    ) -> bool {
        if self.cut_max_tag.is_some() {
            // The rows below the cut no longer exist, so there is no certified
            // tail to protect: the prefix holds while the compartments still
            // cover everything below the cut and no revert happened since.
            // The namespace may not be folded yet (a lineage that begins at
            // the cut), or folded past the cut.
            return self.lineage == lineage
                && self.generation == generation
                && loaded.meta.revert_epoch == self.revert_epoch
                && self.from < self.tail_from
                && self.context_sources.keys().eq(self.context_ordinals.iter())
                && loaded
                    .meta
                    .coverage_ordinal
                    .is_none_or(|coverage| coverage.saturating_add(1) >= self.tail_from)
                && coverage_preserved(&self.compartments, compartments);
        }
        self.lineage == lineage
            && self.generation == generation
            && loaded.core.boundary_id == self.boundary
            && loaded.meta.coverage_ordinal == Some(self.coverage)
            && meta_coverage_compartment_seq(&loaded.meta) == self.sequence
            && loaded.meta.revert_epoch == self.revert_epoch
            && self.from < self.tail_from
            && self.tail_from <= self.coverage
            && self.context_sources.keys().eq(self.context_ordinals.iter())
            && coverage_preserved(&self.compartments, compartments)
            && self.crossing_arcs.iter().all(|(call, result)| {
                *call >= self.tail_from && *call <= self.coverage && *result > self.coverage
            })
    }

    /// Mint only after Hard, MigrateHard or Soft passed the live coverage and
    /// identity guards. Defer cannot authorize omitting more source input.
    pub(crate) fn certify(
        store: &McStore,
        req: &TransformRequest,
        projection: &FlatProjection,
        loaded: &mc_store::LoadedState,
        compartments: &[StoredCompartment],
        lineage: &str,
        generation: u64,
    ) -> Option<Self> {
        let coverage = loaded.meta.coverage_ordinal?;
        let sequence = meta_coverage_compartment_seq(&loaded.meta);
        let applied = compartments
            .iter()
            .filter(|c| c.sequence <= sequence)
            .cloned()
            .collect::<Vec<_>>();
        // A historian may publish between the engine commit and this read.
        // Certify only the compartments that the engine actually adopted, not
        // the newer catalog head or a replacement that rewound its coverage.
        let boundary = applied.iter().find(|c| c.sequence == sequence)?;
        if boundary.end_message != coverage as i64
            || boundary.end_message_id != loaded.core.boundary_id
            || req.logical_prefix.as_ref().is_some_and(|old| {
                old.coverage > coverage || !coverage_preserved(&old.compartments, &applied)
            })
        {
            return None;
        }
        let live = projection
            .blocks
            .iter()
            .filter(|b| !b.synthetic)
            .collect::<Vec<_>>();
        if first_uncovered_live_block(&applied, &live, Some(coverage)).is_some() {
            return None;
        }
        let protection_floor = loaded.meta.protected_tokens_effective.unwrap_or(0);
        let protection_ratio =
            crate::decision_calibration::DecisionCalibration::for_model(req.model_key.as_deref())
                .tools_ratio;
        let rows = if let Some(prefix) = &req.logical_prefix {
            prefix
                .protection_rows(store, &req.session_id, protection_floor, protection_ratio)
                .ok()??
        } else {
            load_cached_tags(store, &req.session_id)
                .ok()?
                .as_ref()
                .clone()
        };
        let protection = crate::protection_window::ProtectionWindow::from_persisted_rows_calibrated(
            &rows,
            protection_floor,
            protection_ratio,
        );
        let summary = store.tag_cache_summary(&req.session_id).ok()?;
        let from = req.logical_prefix.as_ref().map_or_else(
            || req.messages.first().map_or(0, |m| m.ordinal),
            |prefix| prefix.from,
        );
        let mut tail_from = coverage;
        // Move the cut backwards until no completed tool arc crosses it. This
        // retains entire native invocations, including signed reasoning siblings.
        loop {
            let moved = split_coverage_tool_arcs(projection, tail_from.checked_sub(1))
                .iter()
                .filter_map(|arc| req.messages.iter().find(|m| m.mid == arc.invocation_mid))
                .map(|m| m.ordinal)
                .min()
                .unwrap_or(tail_from);
            if moved == tail_from {
                break;
            }
            tail_from = moved;
        }
        // Exceptional arcs cannot turn the optimization into another full walk.
        // Leave the raw rows authoritative and use the full path for this shape.
        if tail_from <= from || coverage.saturating_sub(tail_from) > 256 {
            tracing::debug!(session_id=%req.session_id, tail_from, coverage, reason="arc_safe_cut_span", "using full-lineage input");
            return None;
        }
        let anchor = loaded
            .meta
            .anchor_block_id
            .as_deref()
            .and_then(split_block_id);
        let context_ordinals: BTreeSet<u64> = req
            .messages
            .iter()
            .filter(|m| {
                m.ordinal < tail_from
                    && (m.ck.role == "system" || anchor.is_some_and(|(mid, _)| mid == m.mid))
            })
            .map(|m| m.ordinal)
            .collect();
        let covered_user_turns = req
            .logical_prefix
            .as_ref()
            .map_or(0, |p| p.covered_user_turns)
            .saturating_add(user_turns_below(
                &projection.blocks,
                tail_from,
                &context_ordinals,
            ));
        let required_targets = loaded
            .core
            .frozen_units
            .iter()
            .filter_map(|unit| {
                unit.key
                    .strip_prefix("red:")
                    .or_else(|| unit.key.strip_prefix(CAV_KEY_PREFIX))
            })
            .collect::<HashSet<_>>();
        let covered_targets = projection
            .blocks
            .iter()
            .filter(|b| b.ordinal < tail_from)
            .filter(|b| required_targets.contains(b.id.as_str()))
            .map(|b| b.id.clone())
            .chain(req.logical_prefix.iter().flat_map(|p| {
                p.covered_targets
                    .iter()
                    .filter(|id| required_targets.contains(id.as_str()))
                    .cloned()
            }))
            .collect();
        let crossing_arcs = split_coverage_tool_arcs(projection, Some(coverage))
            .iter()
            .filter_map(|arc| {
                req.messages
                    .iter()
                    .find(|m| m.mid == arc.invocation_mid)
                    .map(|m| (m.ordinal, arc.result_ordinal))
            })
            .collect::<Vec<_>>();
        if crossing_arcs.len() > 64 || protection.member_rows.len() > 4096 {
            tracing::debug!(session_id=%req.session_id, reason="prefix_exception_limit", "using full-lineage input");
            return None;
        }
        Some(Self {
            lineage: lineage.into(),
            generation,
            from,
            tail_from,
            covered_user_turns,
            certified_through: req.messages.last()?.ordinal,
            coverage,
            boundary: loaded.core.boundary_id.clone(),
            sequence,
            revert_epoch: loaded.meta.revert_epoch,
            compartments: applied.iter().map(Coverage::from).collect(),
            context_ordinals,
            context_sources: BTreeMap::new(),
            covered_targets,
            crossing_arcs,
            tag_summary: (summary.generation, summary.count, summary.max_tag_number),
            protection_floor,
            protection_ratio,
            protection_tags: protection
                .member_rows
                .into_iter()
                .map(|row| {
                    (
                        row.tag_number,
                        row.block_id,
                        row.kind,
                        row.token_count,
                        row.created_at_ms,
                    )
                })
                .collect(),
            cut_max_tag: None,
            cut_time_basis: None,
            signature_prefix: crate::tail_hygiene::signature::SignaturePrefix::capture(
                tail_from,
                req.logical_prefix
                    .as_ref()
                    .and_then(|prefix| prefix.signature_prefix.as_ref()),
                projection,
            ),
        })
    }

    /// A prefix standing for the rows below a cut, which the transcript no
    /// longer has. The engine reads it like a certificate: the context sources
    /// render as before, `covered_user_turns` carries the Channel-1 count and
    /// the protection rows carry the protected tags below the cut. A pass
    /// over the window with it certifies an ordinary prefix in turn (`certify`
    /// accumulates from it), so the cut prefix is needed again only when that
    /// certificate goes stale.
    pub(crate) fn for_cut(facts: CutPrefixFacts, lineage: &str, generation: u64) -> Self {
        let first = facts.first_ordinal;
        let coverage = first.saturating_sub(1);
        Self {
            lineage: lineage.into(),
            generation,
            from: facts.lineage_from,
            tail_from: first,
            covered_user_turns: facts.covered_user_turns,
            certified_through: first,
            coverage,
            boundary: facts.boundary.clone(),
            sequence: facts.compartment_seq,
            revert_epoch: facts.revert_epoch,
            compartments: vec![Coverage {
                sequence: facts.compartment_seq,
                from: facts.lineage_from as i64,
                to: coverage as i64,
                boundary: facts.boundary,
            }],
            context_ordinals: facts.context_sources.keys().copied().collect(),
            context_sources: facts.context_sources,
            covered_targets: BTreeSet::new(),
            crossing_arcs: Vec::new(),
            tag_summary: (0, 0, facts.max_tag),
            protection_floor: facts.protection_floor,
            protection_ratio: facts.protection_ratio,
            protection_tags: facts.protection_tags,
            cut_max_tag: Some(facts.max_tag),
            cut_time_basis: facts.time_basis,
            signature_prefix: facts.signature_prefix,
        }
    }

    /// Take the namespace's current tag summary as the one this certificate
    /// was made under, keeping its highest certified tag. For a namespace
    /// whose tag rows below a cut were removed (or never written), so that
    /// only tags appended after the certificate count as new.
    pub(crate) fn rebase_tag_summary(
        &mut self,
        store: &McStore,
        session: &str,
    ) -> Result<(), TransformError> {
        let summary = store.tag_cache_summary(session)?;
        self.tag_summary = (summary.generation, summary.count, self.tag_summary.2);
        Ok(())
    }

    /// True for a prefix built by `for_cut`.
    pub(crate) fn is_cut(&self) -> bool {
        self.cut_max_tag.is_some()
    }

    pub(crate) fn certifies_omitted_boundary(
        &self,
        core: &CoreState,
        meta: &ModuleMeta,
        first_window_ordinal: Option<u64>,
    ) -> bool {
        // A cut prefix with no live-tail row (its Setup's initial pass) still
        // certifies the omitted boundary: `None` means no message at or after
        // the cut, while the cut prefix and imported boundary prove the trim.
        // Certification still requires the matching cut and coverage, the
        // unchanged revert epoch, and the same boundary identity, so allowing
        // `None` for the missing live tail does not bypass those checks.
        let window_ok = first_window_ordinal.is_none_or(|first| first == self.tail_from);
        self.is_cut()
            && self.coverage.checked_add(1) == Some(self.tail_from)
            && meta.coverage_ordinal == Some(self.coverage)
            && meta.revert_epoch == self.revert_epoch
            && !self.boundary.is_empty()
            && core.boundary_id == self.boundary
            && window_ok
    }

    pub(crate) fn declared_cut_trim(&self) -> Option<DeclaredTrim> {
        if !self.is_cut()
            || self.coverage.checked_add(1) != Some(self.tail_from)
            || self.boundary.is_empty()
        {
            return None;
        }
        Some(DeclaredTrim {
            flat_boundary_id: self.boundary.clone(),
            boundary_bare_message_id: split_block_id(&self.boundary)
                .map_or_else(|| self.boundary.clone(), |(mid, _)| mid.to_owned()),
            boundary_absolute_ordinal: self.coverage,
            next_absolute_ordinal: self.tail_from,
        })
    }

    /// The protected tool-tag rows this certificate recorded, with the floor
    /// and calibration ratio they were computed at.
    // Only cut capture and pruning (`cut_seed`) call this; only tests drive them so far.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn protection(&self) -> (u64, f64, &[ProtectionTag]) {
        (
            self.protection_floor,
            self.protection_ratio,
            &self.protection_tags,
        )
    }

    pub(crate) fn protection_rows(
        &self,
        store: &McStore,
        session: &str,
        floor: u64,
        ratio: f64,
    ) -> Result<Option<Vec<mc_store::McTagRow>>, TransformError> {
        if let Some(max) = self.cut_max_tag {
            // Every tag row the namespace holds was numbered after the cut, so
            // the protected rows below it plus the rows after them are the
            // whole persisted set full processing would read.
            if floor > self.protection_floor || ratio < self.protection_ratio {
                return Ok(None);
            }
            let mut rows = self.persisted_protection_rows();
            rows.extend(store.load_tags_after(session, max)?);
            return Ok(Some(rows));
        }
        let summary = store.tag_cache_summary(session)?;
        let (generation, count, max) = self.tag_summary;
        if floor > self.protection_floor
            || ratio < self.protection_ratio
            || summary.generation < generation
            || summary.count < count
            || summary.max_tag_number < max
            || summary.generation.saturating_sub(generation)
                != summary.count.saturating_sub(count) as u64
        {
            return Ok(None);
        }
        let mut rows = self.persisted_protection_rows();
        if summary.generation != generation {
            rows.extend(store.load_tags_after(session, max)?);
        }
        Ok(Some(rows))
    }

    fn persisted_protection_rows(&self) -> Vec<mc_store::McTagRow> {
        self.protection_tags
            .iter()
            .map(|(number, id, kind, tokens, created)| mc_store::McTagRow {
                tag_number: *number,
                block_id: id.clone(),
                kind: kind.clone(),
                token_count: *tokens,
                created_at_ms: *created,
                source_bytes: Arc::from([]),
            })
            .collect()
    }

    pub(super) fn working_range(
        &self,
        status: &Status,
        messages: &[CkIngressMessage],
    ) -> Result<Range, TransformError> {
        // A lineage that begins at a cut with no live rows yet (its Setup's
        // initial pass) has nothing to fold: the head insertion at the cut.
        // The imported compartments already cover everything below the cut,
        // so there is no anchor to miss. The served insertion is re-anchored
        // to the cut by the caller; the engine keeps its origin-based range.
        if messages.is_empty()
            && status.newest_ordinal.is_none()
            && self.is_cut()
            && self.lineage == status.lineage_id
        {
            return Ok(Range {
                lineage_id: status.lineage_id.clone(),
                from: self.from,
                to: self.from,
            });
        }
        if self.lineage != status.lineage_id
            || status
                .newest_ordinal
                .is_none_or(|newest| newest < self.certified_through)
            || messages
                .iter()
                .filter(|m| m.ordinal < self.tail_from)
                .any(|m| !self.context_ordinals.contains(&m.ordinal))
        {
            return Err(TransformError::OrdinalViolation);
        }
        let start = messages.partition_point(|m| m.ordinal < self.tail_from);
        if messages.get(start).map(|m| m.ordinal) != Some(self.tail_from)
            || !messages[..start]
                .iter()
                .map(|m| &m.ordinal)
                .eq(self.context_ordinals.iter())
        {
            return Err(TransformError::OrdinalViolation);
        }
        let mut range = super::working_range(status, &messages[start..])?;
        range.from = self.from;
        Ok(range)
    }

    pub(crate) fn prune_covered_units(&self, core: &mut CoreState) {
        core.frozen_units.retain(|unit| {
            !unit
                .key
                .strip_prefix("red:")
                .or_else(|| unit.key.strip_prefix(CAV_KEY_PREFIX))
                .is_some_and(|target| self.covered_targets.contains(target))
        });
    }

    pub(crate) fn prove_membership(&mut self, source: &CkIngressMessage) -> bool {
        // Normalization can remove synthetic rows from the live projection.
        // Their raw block ids cannot prove live coverage; recover membership
        // from the complete transcript instead.
        if source.ck.meta.synthetic
            || source.ck.content.iter().any(|block| match &block.kind {
                ck_wire::CkKind::ToolCall { id, .. } | ck_wire::CkKind::ToolResult { id, .. } => {
                    is_synthetic_todo_id(id)
                }
                _ => false,
            })
        {
            return false;
        }
        if source.ordinal < self.tail_from {
            self.covered_targets.extend(
                source
                    .ck
                    .content
                    .iter()
                    .enumerate()
                    .map(|(index, _)| format!("{}#{index}", source.mid)),
            );
        }
        true
    }

    pub(crate) fn covers_target(&self, target: &str) -> bool {
        self.covered_targets.contains(target)
    }

    pub(crate) fn retained_bytes(&self) -> usize {
        std::mem::size_of::<Self>()
            + self.lineage.capacity()
            + self.boundary.capacity()
            + self
                .context_sources
                .values()
                .map(|source| {
                    128 + source.mid.capacity()
                        + crate::retained_size::value_retained_bytes(&source.message)
                })
                .sum::<usize>()
            + self.context_ordinals.len() * 40
            + self
                .covered_targets
                .iter()
                .map(|id| 64 + id.capacity())
                .sum::<usize>()
            + self
                .compartments
                .iter()
                .map(|c| 64 + c.boundary.capacity())
                .sum::<usize>()
            + self.crossing_arcs.capacity() * 16
            + self
                .protection_tags
                .iter()
                .map(|(_, id, kind, _, _)| 64 + id.capacity() + kind.capacity())
                .sum::<usize>()
    }
}
