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
    /// entries. Cleared once bound.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending: Option<MoveRecord>,
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
    /// On the first read after a moved session's setup, bind the imported
    /// compartments to held ordinals by message id and carry the drops onto the
    /// parts the runner served, taking each digest from that served part. A
    /// compartment that cannot be placed refuses the import by name, as a protocol
    /// error; nothing partial is imported. A carried drop whose part was not served
    /// is dropped with a log line.
    pub(super) fn bind_standalone_move(
        &mut self,
        store: &McStore,
        codec: codec::Codec,
    ) -> Result<(), HandlerOutcome> {
        let Some(pending) = self
            .standalone_move
            .as_ref()
            .and_then(|moved| moved.pending.clone())
        else {
            return Ok(());
        };
        let Some(first) = self
            .entries
            .first_key_value()
            .map(|(n, e)| (*n, e.mid.clone()))
        else {
            return Ok(());
        };
        let reference = self.reference();
        let refuse = |code: &str, reason: String| {
            tracing::error!(session_ref=%reference, code, reason, "moved session import refused");
            error(PROTOCOL_ERROR, format!("{code}: {reason}"))
        };
        if let Some(compartment) = pending.compartments.first() {
            if compartment.start_message_id != first.1 {
                return Err(refuse(
                    "moved_session_read_starts_after_history",
                    format!(
                        "the first held message is {}, but the first summary starts at {}",
                        first.1, compartment.start_message_id
                    ),
                ));
            }
        }
        let mut retained = Vec::new();
        let mut sequences = Vec::new();
        let mut previous: Option<(u64, bool)> = None;
        for compartment in &pending.compartments {
            let ordinal = |mid: &str| {
                self.mid_index.get(mid).copied().ok_or_else(|| {
                    refuse(
                        "moved_session_history_unrepresentable",
                        format!(
                            "summary {} names message {mid}, which the runner did not serve",
                            compartment.sequence
                        ),
                    )
                })
            };
            let start = ordinal(&compartment.start_message_id)?;
            let end = ordinal(&compartment.end_message_id)?;
            let contiguous = match previous {
                None => start == first.0,
                Some((prior_end, prior_partial)) => {
                    prior_end.checked_add(1) == Some(start)
                        || (prior_partial && compartment.start_part.is_some() && prior_end == start)
                }
            };
            if !contiguous || end < start {
                return Err(refuse(
                    "moved_session_history_unrepresentable",
                    format!(
                        "summary {} covers held ordinals {start}..={end}, which do not follow the previous summary",
                        compartment.sequence
                    ),
                ));
            }
            let start_block = self
                .edge_block(codec, start, compartment.start_part.as_deref(), false)?
                .ok_or_else(|| {
                    refuse(
                        "moved_session_history_unrepresentable",
                        format!(
                            "summary {} starts where no block is served",
                            compartment.sequence
                        ),
                    )
                })?;
            let end_block = self
                .edge_block(codec, end, compartment.end_part.as_deref(), true)?
                .ok_or_else(|| {
                    refuse(
                        "moved_session_history_unrepresentable",
                        format!(
                            "summary {} ends where no block is served",
                            compartment.sequence
                        ),
                    )
                })?;
            retained.push(mc_store::StoredCompartment {
                sequence: compartment.sequence,
                start_message: start as i64,
                end_message: end as i64,
                start_message_id: format!("{}#{start_block}", compartment.start_message_id),
                end_message_id: format!("{}#{end_block}", compartment.end_message_id),
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
            sequences.push((compartment.sequence, compartment.sequence));
            previous = Some((end, compartment.end_part.is_some()));
        }
        let namespace = self.namespace();
        store
            .replace_compartments(&namespace, &retained)
            .map_err(transient)?;
        // The standalone rows keep their chunk embeddings; copy them so retrieval
        // over the imported summaries needs no embedding call.
        let copied = store
            .copy_async_history_artifacts(&pending.session, &namespace, &sequences)
            .map_err(transient)?;
        if !retained.is_empty() {
            store.arm_soft_refresh(&namespace).map_err(transient)?;
        }
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
        let (mut applied, mut queued, mut missing) = (0, 0, 0);
        for drop in &pending.drops {
            let Some((tag, digest)) = served.get(&(drop.mid.clone(), drop.part.clone())) else {
                missing += 1;
                tracing::warn!(session_ref=%reference, mid=%drop.mid, part=%drop.part, kind=?drop.kind, source_tag=drop.source_tag, "moved session drop not carried: the runner did not serve its part with a tag");
                continue;
            };
            match drop.kind {
                DropKind::Applied => {
                    self.frozen_edits.insert_drop(&drop.mid, &drop.part, digest);
                    applied += 1;
                }
                DropKind::Queued => {
                    let row = tags::parse_tag(tag)
                        .map(|number| tag_row(self, codec, number))
                        .transpose()?
                        .flatten();
                    let Some(row) = row else {
                        missing += 1;
                        tracing::warn!(session_ref=%reference, mid=%drop.mid, part=%drop.part, "moved session queued drop not carried: its part has no droppable block");
                        continue;
                    };
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
        }
        tracing::info!(session_ref=%reference, compartments=retained.len(), copied_chunk_embeddings=copied, applied_drops=applied, queued_drops=queued, missing_drops=missing, tag_checkpoint=pending.tag_checkpoint, "moved standalone session imported");
        if let Some(moved) = &mut self.standalone_move {
            moved.pending = None;
        }
        Ok(())
    }

    /// The CK block index where a summary starts (`end == false`) or ends inside
    /// the held entry at `ordinal`. `part` names the OpenCode part of a partial
    /// edge; without it the edge is the message's first or last block. Blocks map
    /// to the served parts through the codec's native part index, so parts the
    /// runner leaves out (the compaction part) never shift the edge.
    fn edge_block(
        &self,
        codec: codec::Codec,
        ordinal: u64,
        part: Option<&str>,
        end: bool,
    ) -> Result<Option<usize>, HandlerOutcome> {
        let entry = self
            .entries
            .get(&ordinal)
            .ok_or_else(|| transient("held entry missing"))?
            .read()?;
        let limit = match part {
            None => None,
            Some(part) => match entry.tags.iter().position(|row| row.part == part) {
                Some(index) => Some(index),
                None => return Ok(None),
            },
        };
        let decoded = decoded_entry(
            codec,
            &InboundMessage {
                ordinal,
                mid: entry.mid.clone(),
                message: entry.message.clone(),
            },
        )?;
        let blocks = decoded.ck.content.iter().enumerate().map(|(index, block)| {
            let native = block
                .provider_extras
                .get("_cortexkit_codec")
                .and_then(|extras| extras.get("nativeIndex"))
                .and_then(Value::as_u64)
                .map_or(index, |native| native as usize);
            (index, native)
        });
        Ok(if end {
            blocks
                .filter(|(_, native)| limit.is_none_or(|limit| *native <= limit))
                .map(|(index, _)| index)
                .next_back()
        } else {
            let mut blocks = blocks;
            blocks
                .find(|(_, native)| limit.is_none_or(|limit| *native >= limit))
                .map(|(index, _)| index)
        })
    }
}
