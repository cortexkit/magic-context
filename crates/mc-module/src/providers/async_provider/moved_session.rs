//! Sessions the offline move (`crate::offline_move`) brought over from the
//! standalone OpenCode 1 plugin: the setup fence, and binding the imported
//! summaries and drops on the first read after setup.
use super::*;
use crate::offline_move::{self, DropKind, MoveRecord};

/// The harness OpenCode 1 sessions are set up under. Only these can hold
/// standalone plugin state.
const OPENCODE1_HARNESS: &str = "opencode";

/// What the offline move left for this conversation.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub(super) struct StandaloneMove {
    /// The highest tag number standalone allocated. Setup repeats it on every
    /// answer, with the cut, so the runner can number from it even if the
    /// marker's checkpoint key is lost.
    pub tag_checkpoint: u64,
    /// The boundary user message the standalone marker cuts at.
    pub cut: String,
    /// Counted prefix length and the runner-certified last message in that prefix.
    pub message_count: u64,
    pub head_cut: cortexkit_role_llm_runner::read::HeadCut,
    /// The imported summaries and drops, until the first read binds them to held
    /// entries. Cleared once bound; the authoritative move record in
    /// `context.db` is never touched.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending: Option<MoveRecord>,
    /// Drops already bound to a served `(mid, part, digest)`. The pending queue
    /// lives per engine namespace (one per generation), so a fresh generation
    /// replays these instead of reading the move record again.
    #[serde(default, skip_serializing)]
    pub bound_drops: Vec<BoundDrop>,
    /// Cleared by binding so the next save stores the new durable bindings.
    #[serde(default)]
    pub bound_drops_stored: bool,
}

/// One drop the first read bound to the runner's served part, kept so a later
/// lineage can replay it. The digest is the runner's own served digest of that
/// part, so a replay can tell a removed target from changed content: a missing
/// target is skipped, a changed digest is left visible, and only a same-digest
/// target that lost its tag still refuses.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub(super) struct BoundDrop {
    pub mid: String,
    pub part: String,
    pub digest: String,
    pub kind: DropKind,
    #[serde(default)]
    pub queued_at_ms: Option<i64>,
}

pub(super) enum Fence {
    /// No standalone state and no move: an ordinary new conversation.
    Fresh,
    /// The offline move completed; set up from its record.
    Moved(Box<MoveRecord>),
    /// Refuse setup with this answer.
    Refuse(Value),
}

/// Decide whether an OpenCode 1 session may be set up. A session with standalone
/// state in `context.db` and no moved record is refused with
/// `standalone_session_not_migrated`: setting it up would leave two owners.
pub(super) fn setup_fence(
    store: &McStore,
    harness: &str,
    session: &str,
    request_id: &str,
) -> Result<Fence, HandlerOutcome> {
    if harness != OPENCODE1_HARNESS || !store.has_context_domain() {
        return Ok(Fence::Fresh);
    }
    let (raw, record, standalone) = store
        .with_context_read(|conn| {
            Ok((
                offline_move::read_move_record_raw(conn, session)?,
                offline_move::read_move_record(conn, session)?,
                offline_move::has_standalone_state(conn, session)?,
            ))
        })
        .map_err(transient)?;
    Ok(match record {
        Some(Ok(record)) if record.state == offline_move::MoveState::Moved => {
            Fence::Moved(Box::new(record))
        }
        Some(Ok(_)) => Fence::Refuse(setup_refusal(
            request_id,
            "move_in_progress",
            "The offline move has not finished; rerun `ck-mc offline move-session` first.",
        )),
        Some(Err(reason)) => Fence::Refuse(
            serde_json::to_value(contract::setup::SetupAnswer::refuse(
                request_id,
                contract::errors::RefuseCode::from_code(offline_move::classify_record_error(
                    raw.as_deref().unwrap_or_default(),
                )),
                format!("The moved record for this session cannot be read: {reason}"),
            ))
            .map_err(transient)?,
        ),
        None if standalone => Fence::Refuse(
            serde_json::to_value(contract::setup::SetupAnswer::refuse(
                request_id,
                contract::errors::RefuseCode::from_code(
                    offline_move::STANDALONE_SESSION_NOT_MIGRATED,
                ),
                "This session is still managed by the standalone Magic Context plugin. \
             Move it with `ck-mc offline move-session` in a restart window first.",
            ))
            .map_err(transient)?,
        ),
        None => Fence::Fresh,
    })
}

/// Why a Setup answer carries a checkpoint, for the refusal's reason.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum CheckpointSource {
    /// The session was moved from the standalone plugin.
    StandaloneMove,
    /// The Claude Code conversation was served on the full-array route
    /// (`full_array_floor`).
    FullArray,
}

/// Setup refusal for a session with a Setup checkpoint on a runner that does
/// not declare llm-runner's `tag_checkpoint` group: without the checkpoint it
/// would number the session from zero. Terminal (compaction-provider §4).
pub(super) fn tag_checkpoint_refusal(request_id: &str, why: CheckpointSource) -> Value {
    let reason = match why {
        CheckpointSource::StandaloneMove => {
            "This session was moved from the standalone Magic Context plugin, and its \
             runner does not declare tag_checkpoint, so it cannot keep the session's tag numbers."
        }
        CheckpointSource::FullArray => {
            "Magic Context numbered this conversation's parts on the full-array route before, \
             and its runner does not declare tag_checkpoint, so it cannot keep new numbers \
             above the ones the model has seen."
        }
    };
    serde_json::to_value(contract::setup::SetupAnswer::refuse(
        request_id,
        contract::errors::RefuseCode::from_code(
            contract::errors::refuse_codes::TAG_CHECKPOINT_UNSUPPORTED,
        ),
        reason,
    ))
    .expect("Setup refusal serializes")
}

impl StandaloneMove {
    /// The Setup checkpoint every Setup answer for this session carries.
    pub(super) fn checkpoint(&self) -> contract::setup::SetupCheckpoint {
        contract::setup::SetupCheckpoint::new(self.tag_checkpoint, &self.cut)
            .with_message_checkpoint(self.message_count, self.head_cut.clone())
    }

    pub(super) fn from_record(record: MoveRecord) -> Self {
        Self {
            tag_checkpoint: record.tag_checkpoint,
            cut: record.cut.clone(),
            message_count: record.message_count,
            head_cut: certified_head(&record),
            pending: Some(record),
            bound_drops: Vec::new(),
            bound_drops_stored: false,
        }
    }
}

pub(super) fn certified_head(record: &MoveRecord) -> cortexkit_role_llm_runner::read::HeadCut {
    cortexkit_role_llm_runner::read::HeadCut::new(
        &record.head_cut.mid,
        &record.head_cut.digest,
        record.head_cut.written_at,
    )
}

pub(super) fn checkpoint(record: &MoveRecord) -> contract::setup::SetupCheckpoint {
    contract::setup::SetupCheckpoint::new(record.tag_checkpoint, &record.cut)
        .with_message_checkpoint(record.message_count, certified_head(record))
}

/// A moved session's Setup that does not match its offline preparation. The
/// refusal and its log line name which half differs: `setup_differs` (the
/// request) or `runner_describe_differs` (the runner's `role.describe`), so an
/// operator knows whether to re-export the Setup or the runner's describe.
pub(super) fn moved_unprepared_refusal(reference: &str, request_id: &str, why: &str) -> Value {
    tracing::warn!(
        session_ref = %reference,
        why,
        "moved session Setup refused: it differs from the offline preparation"
    );
    setup_refusal(
        request_id,
        "moved_session_unprepared",
        &format!(
            "Setup differs from the preparation ({why}); rerun `ck-mc offline first-pass` with this Setup and the live runner's role.describe."
        ),
    )
}

pub(super) fn setup_refusal(request_id: &str, code: &str, reason: &str) -> Value {
    serde_json::to_value(contract::setup::SetupAnswer::refuse(
        request_id,
        contract::errors::RefuseCode::from_code(code),
        reason,
    ))
    .expect("Setup refusal serializes")
}

impl McHandler {
    /// Validate the manifest's codec and certified prefix before an engine pass
    /// or import can expose a provider record. Native descents validate their
    /// own newer cut instead of the original adoption boundary.
    pub(super) async fn check_moved_setup(
        &self,
        record: &MoveRecord,
        request: &compact::setup::SetupRequest,
        route: &crate::route_targets::SessionRunnerRoute,
        identity: &session_resolver::RunnerBindIdentity,
    ) -> Result<Option<Value>, HandlerOutcome> {
        let codec_matches = codec::Codec::from_params(&Value::Object(request.params.clone()))
            .is_ok_and(|codec| {
                codec.wire_id() == record.codec_profile.serializer
                    && record.codec_profile.native_index == "part_index"
            });
        if !codec_matches {
            return Ok(Some(setup_refusal(
                &request.request_id,
                "moved_session_codec_mismatch",
                "Setup's codec differs from the offline move manifest.",
            )));
        }
        if request.descends_from.is_some() {
            return Ok(None);
        }
        let raw = self
            .provider_runner
            .call_for_identity(
                route,
                identity,
                "session.head",
                json!({}),
                Duration::from_secs(10),
            )
            .await
            .map_err(runner_error)?;
        let head: cortexkit_role_llm_runner::read::HeadMeta = decode(&raw)?;
        let code = if head.first_ordinal.unwrap_or(0) < record.message_count {
            Some("moved_session_reverted_below_import")
        } else if head.first_ordinal != Some(record.message_count)
            || head.cut.as_ref() != Some(&certified_head(record))
            || head.lineage_id != request.lineage_id
        {
            Some("moved_session_head_mismatch")
        } else {
            None
        };
        Ok(code.map(|code| setup_refusal(
            &request.request_id,
            code,
            "The runner's head does not match the offline-certified prefix; rerun the offline preparation after restoring the moved history.",
        )))
    }
}

impl AsyncRecord {
    /// Place the offline move's compartments before the Setup engine pass, so
    /// the head it renders is the imported history. The runner never serves
    /// anything below the cut, so the import cannot bind by served ordinals: it
    /// places the manifest's compartments at ordinals `0..message_count-1` with
    /// the offline-computed CK block ids and copies only the imported
    /// sequences' retrieval artifacts. No seed is set yet, so this pass still
    /// answers the empty-window head insertion.
    pub(super) fn import_standalone_compartments(
        &mut self,
        store: &McStore,
        record: &MoveRecord,
    ) -> Result<(), HandlerOutcome> {
        let namespace = self.namespace();
        let mut retained = Vec::with_capacity(record.compartments.len());
        for compartment in &record.compartments {
            let start_ordinal = compartment
                .start_position
                .checked_sub(1)
                .ok_or_else(|| transient("move manifest has a zero start position"))?
                as i64;
            let end_ordinal = compartment
                .end_position
                .checked_sub(1)
                .ok_or_else(|| transient("move manifest has a zero end position"))?
                as i64;
            let start_id = match compartment.start_block {
                Some(block) => format!("{}#{block}", compartment.start_message_id),
                None => compartment.start_message_id.clone(),
            };
            let end_id = match compartment.end_block {
                Some(block) => format!("{}#{block}", compartment.end_message_id),
                None => compartment.end_message_id.clone(),
            };
            retained.push(mc_store::StoredCompartment {
                sequence: compartment.sequence,
                start_message: start_ordinal,
                end_message: end_ordinal,
                start_message_id: start_id,
                end_message_id: end_id,
                start_date: None,
                end_date: None,
                title: compartment.title.clone(),
                content: compartment.content.clone(),
                p1: compartment.p1.clone(),
                p2: compartment.p2.clone(),
                p3: compartment.p3.clone(),
                p4: compartment.p4.clone(),
                importance: compartment.importance,
                episode_type: compartment.episode_type.clone(),
                legacy: compartment.legacy,
                created_at: compartment.created_at,
            });
        }
        store
            .replace_compartments(&namespace, &retained)
            .map_err(transient)?;
        let sequences = record
            .compartments
            .iter()
            .map(|compartment| (compartment.sequence, compartment.sequence))
            .collect::<Vec<_>>();
        let _ = store
            .copy_async_history_artifacts(&record.session, &namespace, &sequences)
            .map_err(transient)?;
        // Do not arm a refresh before the Setup engine pass: it renders the
        // head insertion from these rows, and a pending refresh would leave it
        // without its frames. The seed finish arms it for the first notice.
        Ok(())
    }

    /// The adoption seed for the manifest, without touching the record. Setup
    /// stages it before the engine pass so that pass renders the imported head.
    fn standalone_seed(record: &MoveRecord) -> Result<cut_seed::CutSeed, HandlerOutcome> {
        let last = record
            .compartments
            .last()
            .ok_or_else(|| transient("move manifest has no compartments"))?;
        let boundary_id = match last.end_block {
            Some(block) => format!("{}#{block}", last.end_message_id),
            None => last.end_message_id.clone(),
        };
        let mut seed = cut_seed::CutSeed::without_rows(
            record.message_count,
            record.head_cut.mid.clone(),
            last.sequence,
            boundary_id,
        );
        seed.cut_digest = record.head_cut.digest.clone();
        seed.time_basis = Some((i64::try_from(record.head_cut.written_at).ok(), None));
        if record.tag_checkpoint > 0 {
            seed.pre_cut_tags = vec![(1, record.tag_checkpoint)];
        }
        seed.max_tag = record.tag_checkpoint;
        Ok(seed)
    }

    /// Build the adoption seed from the certified head without saving a partial
    /// provider record. Setup commits the seed with the complete answer. It sets
    /// `lineage_first_ordinal`, `cut_digest` and `time_basis` from the certified
    /// `head_cut`, and `pre_cut_tags`/`max_tag` from the tag checkpoint, so an
    /// old `ctx_reduce` tag answers as already in the history summary.
    ///
    /// The caller arms the soft refresh after its Setup engine pass. The Setup
    /// pass renders the head from these imported rows; arming the refresh
    /// before that pass would leave the rendered head without its frames. Armed
    /// after the pass, the first notice refreshes the imported history once.
    pub(super) fn finish_standalone_import(
        &mut self,
        store: &McStore,
        record: &MoveRecord,
    ) -> Result<(), HandlerOutcome> {
        let seed = Self::standalone_seed(record)?;
        self.lineage_first_ordinal = record.message_count;
        self.stage_fresh_cut(store, seed)?;
        Ok(())
    }

    /// Whether this record stopped inside the adoption import: the cut stage is
    /// saved but the Setup answer with a complete `initial` is not. A repeat
    /// Setup restarts from the move record instead of answering the partial
    /// record.
    pub(super) fn is_importing_stage(&self) -> bool {
        let pending = self
            .standalone_move
            .as_ref()
            .is_some_and(|moved| moved.pending.is_some());
        pending
            && self.cut_first_ordinal.is_some()
            && !self.initial_ready
            && !self
                .initial
                .get("answer")
                .and_then(Value::as_str)
                .is_some_and(|answer| answer == "ready")
    }

    /// The drops-only first-read binding. Compartments are already imported at
    /// Setup, so this only carries drops onto the parts the runner served,
    /// taking each digest from that served part, and records the
    /// `(mid, part, digest)` bindings durably for later generations. The
    /// authoritative move record in `context.db` is never cleared; only this
    /// record's pending copy is.
    ///
    /// A target the pass cannot bind, or whose served part has no tag, refuses
    /// `drop_target_unbound` instead of skipping: admission already proved every
    /// carried target resolvable, so a missing binding at runtime is a defect.
    /// A second bind in the same namespace adds no duplicate edit or queue row.
    pub(super) fn bind_standalone_move(
        &mut self,
        store: &McStore,
        codec: codec::Codec,
    ) -> Result<(), HandlerOutcome> {
        let (pending, bound) = match &self.standalone_move {
            None => return Ok(()),
            Some(moved) => (moved.pending.clone(), moved.bound_drops.clone()),
        };
        if let Some(pending) = pending {
            return self.bind_first_drops(store, codec, &pending);
        }
        if bound.is_empty() {
            return Ok(());
        }
        self.replay_bound_drops(store, codec, &bound)
    }

    /// The runner's key for a carried drop's part. The offline move records
    /// each target by the host's own part id (OpenCode's `prt_…`), but a tag
    /// row's `part` is the runner's opaque key for the part, which may be its
    /// position instead (llm-runner `PartTag`). Rows come in the message's
    /// part order, so a host id resolves through the held message's parts to
    /// the row at the same position. A target already named by the runner's
    /// key is returned as is; `None` when the message or the part isn't held.
    fn runner_part_key(&self, mid: &str, part: &str) -> Result<Option<String>, HandlerOutcome> {
        let Some(held) = self
            .mid_index
            .get(mid)
            .and_then(|ordinal| self.entries.get(ordinal))
        else {
            return Ok(None);
        };
        let entry = held.read()?;
        if entry.tags.iter().any(|row| row.part == part) {
            return Ok(Some(part.to_owned()));
        }
        let native = parts(&entry.message)?;
        let Some(index) = native
            .iter()
            .position(|value| value.get("id").and_then(Value::as_str) == Some(part))
        else {
            return Ok(None);
        };
        Ok(entry.tags.get(index).map(|row| row.part.clone()))
    }

    /// Bind the move record's carried drops on the first read, fail closed.
    /// Every target must resolve to a served tagged part with a droppable block
    /// for queued drops; anything else refuses `drop_target_unbound`. Success
    /// clears this record's pending copy and stores the served digests durably,
    /// so later generations replay them without the move record.
    fn bind_first_drops(
        &mut self,
        store: &McStore,
        codec: codec::Codec,
        pending: &MoveRecord,
    ) -> Result<(), HandlerOutcome> {
        let reference = self.reference();
        let refuse = |code: &str, reason: String| {
            tracing::error!(session_ref=%reference, code, reason, "moved session drop refused");
            error(PROTOCOL_ERROR, format!("{code}: {reason}"))
        };
        let served: HashMap<(String, String), (String, String)> = self
            .tag_index
            .iter()
            .map(|(tag, address)| {
                (
                    (address.mid.clone(), address.part.clone()),
                    (tag.clone(), address.digest.clone()),
                )
            })
            .collect();
        let namespace = self.namespace();
        let mut bound = Vec::with_capacity(pending.drops.len());
        let (mut applied, mut queued) = (0, 0);
        for drop in &pending.drops {
            let part = self
                .runner_part_key(&drop.mid, &drop.part)?
                .unwrap_or_else(|| drop.part.clone());
            let Some((tag, digest)) = served.get(&(drop.mid.clone(), part.clone())) else {
                return Err(refuse(
                    "drop_target_unbound",
                    format!("drop target {}:{} has no served tag", drop.mid, drop.part),
                ));
            };
            match drop.kind {
                DropKind::Applied => {
                    self.frozen_edits.insert_drop(&drop.mid, &part, digest);
                    applied += 1;
                }
                DropKind::Queued => {
                    let number = tags::parse_tag(tag).ok_or_else(|| {
                        refuse(
                            "drop_target_unbound",
                            format!("drop target {}:{} has a malformed tag", drop.mid, drop.part),
                        )
                    })?;
                    let row = tag_row(self, codec, number)?.ok_or_else(|| {
                        refuse(
                            "drop_target_unbound",
                            format!(
                                "queued drop target {}:{} has no droppable block",
                                drop.mid, drop.part
                            ),
                        )
                    })?;
                    store
                        .append_pending_agent_drops(
                            &namespace,
                            std::slice::from_ref(&row.block_id),
                            drop.queued_at_ms.unwrap_or_else(now_ms),
                        )
                        .map_err(transient)?;
                    queued += 1;
                }
            }
            // Bound under the runner's key, so later generations replay against
            // the served rows without resolving host ids again.
            bound.push(BoundDrop {
                mid: drop.mid.clone(),
                part,
                digest: digest.clone(),
                kind: drop.kind,
                queued_at_ms: drop.queued_at_ms,
            });
        }
        tracing::info!(session_ref=%reference, applied_drops=applied, queued_drops=queued, tag_checkpoint=pending.tag_checkpoint, "moved standalone drops bound");
        if let Some(moved) = &mut self.standalone_move {
            moved.pending = None;
            moved.bound_drops = bound;
            moved.bound_drops_stored = false;
        }
        Ok(())
    }

    /// Replay durable `(mid, part, digest)` bindings in the current namespace.
    /// A target the new lineage no longer serves is skipped and logged; a
    /// target whose digest changed is not dropped, so its new content stays
    /// visible, and that is logged too. An old drop is never applied to changed
    /// content. A same-digest target that lost its tag or its droppable block
    /// refuses `drop_target_unbound` before any model call, as the first bind
    /// would. The pending queue insert ignores existing rows, so a second bind
    /// adds no duplicate.
    fn replay_bound_drops(
        &mut self,
        store: &McStore,
        codec: codec::Codec,
        bound: &[BoundDrop],
    ) -> Result<(), HandlerOutcome> {
        let reference = self.reference();
        let refuse = |code: &str, reason: String| {
            tracing::error!(session_ref=%reference, code, reason, "moved session drop replay refused");
            error(PROTOCOL_ERROR, format!("{code}: {reason}"))
        };
        let namespace = self.namespace();
        let served: HashMap<(String, String), (String, String)> = self
            .tag_index
            .iter()
            .map(|(tag, address)| {
                (
                    (address.mid.clone(), address.part.clone()),
                    (tag.clone(), address.digest.clone()),
                )
            })
            .collect();
        let (mut applied, mut queued, mut skipped) = (0, 0, 0);
        for drop in bound {
            if let Some((tag, digest)) = served.get(&(drop.mid.clone(), drop.part.clone())) {
                if digest != &drop.digest {
                    skipped += 1;
                    tracing::warn!(session_ref=%reference, mid=%drop.mid, part=%drop.part, "moved session drop not replayed: the served digest changed, leaving the new content visible");
                    continue;
                }
                match drop.kind {
                    DropKind::Applied => {
                        self.frozen_edits.insert_drop(&drop.mid, &drop.part, digest);
                        applied += 1;
                    }
                    DropKind::Queued => {
                        let number = tags::parse_tag(tag).ok_or_else(|| {
                            refuse(
                                "drop_target_unbound",
                                format!(
                                    "replayed drop target {}:{} has a malformed tag",
                                    drop.mid, drop.part
                                ),
                            )
                        })?;
                        let row = tag_row(self, codec, number)?.ok_or_else(|| {
                            refuse(
                                "drop_target_unbound",
                                format!(
                                    "replayed queued drop target {}:{} has no droppable block",
                                    drop.mid, drop.part
                                ),
                            )
                        })?;
                        store
                            .append_pending_agent_drops(
                                &namespace,
                                std::slice::from_ref(&row.block_id),
                                drop.queued_at_ms.unwrap_or_else(now_ms),
                            )
                            .map_err(transient)?;
                        queued += 1;
                    }
                }
                continue;
            }
            let held = self
                .mid_index
                .get(&drop.mid)
                .and_then(|ordinal| self.entries.get(ordinal));
            let Some(held) = held else {
                skipped += 1;
                tracing::warn!(session_ref=%reference, mid=%drop.mid, part=%drop.part, "moved session drop not replayed: its target is gone");
                continue;
            };
            let entry = held.read()?;
            let Some(_row) = entry.tags.iter().find(|row| row.part == drop.part) else {
                skipped += 1;
                tracing::warn!(session_ref=%reference, mid=%drop.mid, part=%drop.part, "moved session drop not replayed: its target is gone");
                continue;
            };
            let current = served_part_digest(&entry, &drop.part).map_err(|_| {
                refuse(
                    "drop_target_unbound",
                    format!(
                        "replayed drop target {}:{} has no served digest",
                        drop.mid, drop.part
                    ),
                )
            })?;
            if current != drop.digest {
                skipped += 1;
                tracing::warn!(session_ref=%reference, mid=%drop.mid, part=%drop.part, "moved session drop not replayed: the served digest changed, leaving the new content visible");
                continue;
            }
            return Err(refuse(
                "drop_target_unbound",
                format!(
                    "replayed drop target {}:{} has no served tag",
                    drop.mid, drop.part
                ),
            ));
        }
        if skipped > 0 || applied > 0 || queued > 0 {
            tracing::info!(session_ref=%reference, applied_drops=applied, queued_drops=queued, skipped_drops=skipped, "moved standalone drops replayed");
        }
        Ok(())
    }
}
