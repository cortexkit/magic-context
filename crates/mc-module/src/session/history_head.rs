//! The history head (`m[0]`/`m[1]`) and the mural it carries.

use super::*;
use cortexkit_role_compaction::read::Role;

impl Session {
    /// The history head, and the cut when the newest summary's last message
    /// is still in the transcript. Only presets with a summarizer have a
    /// head. A due fold renders `m[0]` again from everything current.
    pub(super) fn history_ops(
        &mut self,
        settings: &Settings,
        flush: bool,
    ) -> (Vec<EditOp>, Option<u64>) {
        let _timing = crate::notice_cost_timing::span("build.history_ops");
        if !self.features.summarizer {
            return (Vec::new(), None);
        }
        let mut ops = self.render_head_for(settings, flush);
        // A head kept as the latest view shows it (a read it needs failed,
        // see `head_as_shown`, which leaves no next baseline) carries no
        // newer summary. The cut then stays where that view has it: moving
        // it would hide messages whose summary the head does not show.
        let held = self.next_baseline.is_none();
        let through = if held {
            self.latest.as_ref().and_then(|view| {
                view.edits.iter().find_map(|edit| match &edit.op {
                    EditOp::Cut { through } => Some(through.clone()),
                    _ => None,
                })
            })
        } else {
            let summarized = self
                .summaries
                .last()
                .map(|last| last.end_message_id.clone());
            // Entries through the numbers floor that render nothing a
            // summary would keep are cut past without one.
            match self.numbers_covered.as_ref().filter(|covered| {
                self.index.ordinal_of(&covered.mid) == Some(covered.ordinal)
                    && self
                        .summarized_through()
                        .is_none_or(|reach| reach < covered.ordinal)
            }) {
                Some(covered) => Some(covered.mid.clone()),
                None => summarized,
            }
        };
        let cut = through.and_then(|through| {
            let entries = self.index.entries();
            let end = entries.iter().position(|entry| entry.mid == through)?;
            // A tool still running can't be cut (compaction contract W6.5),
            // yet the summarizer reads past a call left running long ago, as
            // the plugin does. The cut then stops before it, so views keep
            // landing; the summary may repeat what those messages still show
            // until the runner finishes or fails the call.
            let running = entries[..=end].iter().position(|entry| {
                entry.parts.iter().any(|part| match &part.body {
                    PartBody::Tool(tool) => !crate::neutral::is_finished(&tool.status),
                    _ => false,
                })
            });
            let Some(running) = running else {
                // The message the request ends on is never cut, so the
                // request always ends with a message the runner shows as it
                // is (compaction contract rule PR6; runners refuse such a
                // view). A trailing system note does not replace the final
                // user or tool turn; entries with no parts render nothing.
                let last = entries
                    .iter()
                    .rposition(|entry| !entry.parts.is_empty() && entry.role != Role::System)
                    .or_else(|| entries.iter().rposition(|entry| !entry.parts.is_empty()))
                    .unwrap_or(entries.len() - 1);
                if end >= last {
                    let before = last.checked_sub(1)?;
                    return Some((entries[before].ordinal, entries[before].mid.clone()));
                }
                return Some((entries[end].ordinal, through));
            };
            tracing::info!(
                "ck-mc: session {}: the cut stops before message {}, whose tool call is still running",
                self.key.session, entries[running].ordinal
            );
            // With nothing held before the running call, no new cut: the
            // view carries the cut the runner has now.
            let before = running.checked_sub(1)?;
            Some((entries[before].ordinal, entries[before].mid.clone()))
        });
        if let Some((_, through)) = &cut {
            ops.push(EditOp::Cut {
                through: through.clone(),
            });
        }
        (ops, cut.map(|(ordinal, _)| ordinal))
    }

    /// The history head's edits: `m[0]` (kept unless a fold is due) and
    /// `m[1]` with what changed since. The baseline they set counts once the
    /// runner takes the view.
    ///
    /// When memories cannot be read, the head stays as the latest view shows
    /// it: an empty read would otherwise state every shown memory as removed,
    /// and the next good read as updated again.
    pub(super) fn render_head(&mut self, settings: &Settings) -> Vec<EditOp> {
        self.render_head_for(settings, false)
    }

    fn render_head_for(&mut self, settings: &Settings, flush: bool) -> Vec<EditOp> {
        let _timing = crate::notice_cost_timing::span("head.render");
        self.release_summary_bodies();
        // A manual flush refreshes only the delta. A missing baseline waits
        // for the normal first render, which is the path allowed to create it.
        if flush && self.baseline.is_none() {
            return self.head_as_shown("a flush cannot create a baseline");
        }
        let docs = self
            .project
            .as_ref()
            .map(|project| {
                crate::project_docs::read_project_docs_canonical(&project.root).rendered_block
            })
            .unwrap_or_default();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_millis() as i64);
        let shape = self.head_shape(settings);
        // With memory off, the history head shows no memories and no user
        // profile, as the standalone plugin's does. The user profile is the
        // person's, read whatever the session's project.
        let mut rows = Vec::new();
        if let (Some(db), true) = (&self.db, shape.memory_enabled) {
            let project = self.project.as_ref().map(|project| project.id.as_str());
            // The session's workspace is Entorhinal's, from its memory context.
            let workspace_id = self
                .memory_context
                .as_ref()
                .and_then(|context| context.workspace_id.as_deref());
            match db.with_connection(|conn| {
                crate::head_memories::read_rows(conn, project, workspace_id, now)
            }) {
                Ok(read) => rows = read,
                Err(error) => return self.head_as_shown(&format!("reading memories: {error}")),
            }
        }
        let classes = self
            .head_classes
            .get_or_insert_with(|| crate::head_memories::classes_for(self.memory_context.as_ref()))
            .clone();
        let model_key = format!(
            "{}/{}",
            self.conditions.model.provider, self.conditions.model.model
        );
        // Put back below; a head that stays as shown leaves it unset, so the
        // next build computes it again.
        let mut head_summaries = self.head_summaries.take();
        let history_budget_tokens = shape.history_budget_tokens;
        // A fold reads every summary's row (see below); between folds the
        // head needs only the summaries newer than its baseline.
        let fold_inputs = head::Inputs {
            counter: crate::count::Counter::for_model(Some(&model_key)),
            summaries: &[],
            docs: &docs,
            rows: &rows,
            classes: &classes,
            now_ms: now,
            gone: &[],
            history_budget_tokens,
            history_local_budget_tokens: crate::summary::render::history_local_budget(
                history_budget_tokens as f64,
                Some(&model_key),
            ) as u64,
            memory_budget_tokens: settings.memory_budget_tokens,
            profile_budget_tokens: settings.profile_budget_tokens,
        };
        let active: std::collections::HashSet<i64> = rows.iter().map(|row| row.id).collect();
        // Shown memories that left the active set get their rows, which say
        // whether they were archived or merged.
        let gone_from = |base: &Baseline| -> Result<Vec<crate::head_memories::Row>, String> {
            let missing: Vec<i64> = base
                .shown_ids()
                .into_iter()
                .filter(|id| !active.contains(id))
                .collect();
            match &self.db {
                Some(db) => db
                    .with_connection(|conn| crate::head_memories::rows_by_ids(conn, &missing))
                    .map_err(|error| error.to_string()),
                None => Ok(Vec::new()),
            }
        };
        // A fold draws the mural afresh; between folds `m[0]` keeps the one
        // it was folded with, as in the plugin.
        let mut drawn: Option<Option<crate::mural::Mural>> = None;
        let mut folded = |inputs: &head::Inputs| {
            let chosen = head::chosen_at_fold(inputs);
            let mural = drawn.get_or_insert_with(|| {
                self.draw_mural(
                    settings,
                    shape.memory_enabled,
                    inputs.rows,
                    &chosen.left_out(inputs.rows),
                )
            });
            let mut base = head::fold_with(
                inputs,
                &chosen.shown,
                mural.as_ref().map(|mural| mural.content_hash.as_str()),
            );
            base.shape = Some(shape.clone());
            base
        };
        let mut fresh_fold = true;
        let mut base = match (&self.baseline, self.fold_due && !flush) {
            (Some(baseline), false) => {
                fresh_fold = false;
                baseline.as_ref().clone()
            }
            _ => match self.summary_rows() {
                Ok(mut summaries) => {
                    self.date_summaries(&mut summaries, self.shown_days());
                    folded(&head::Inputs {
                        summaries: &summaries,
                        ..fold_inputs
                    })
                }
                Err(unread) => return self.head_as_shown_for(unread),
            },
        };
        // A baseline in the memory format before levels records what its
        // m[0] shows for the project block only. Building an m[1] on it
        // would announce profile lines m[0] already shows and drop the
        // profile block an earlier m[1] showed, so the head stays as shown
        // until its format fold, which the next permitted notice runs.
        if !fresh_fold && base.format_fold_due(shape.memory_enabled) {
            return self.head_as_shown("the head waits for its memory-format fold");
        }
        let gone = match gone_from(&base) {
            Ok(gone) => gone,
            Err(error) => return self.head_as_shown(&format!("reading memory rows: {error}")),
        };
        let newer = match HeadSummaries::for_base(
            &mut head_summaries,
            &base,
            &self.summaries,
            self.summary_store(),
            &model_key,
            fold_inputs.counter,
            |rows| self.date_summaries(rows, None),
        ) {
            Ok(newer) => newer,
            Err(unread) => return self.head_as_shown_for(unread),
        };
        let (mut m1, mut next, pressure) = head::delta_with(
            &base,
            &head::Inputs {
                gone: &gone,
                ..fold_inputs
            },
            &newer,
        );
        if !flush
            && self.baseline.is_some()
            && !self.fold_due
            && head::needs_refold(&base, pressure, history_budget_tokens, fold_inputs.counter)
        {
            let mut summaries = match self.summary_rows() {
                Ok(summaries) => summaries,
                Err(unread) => return self.head_as_shown_for(unread),
            };
            self.date_summaries(&mut summaries, self.shown_days());
            base = folded(&head::Inputs {
                summaries: &summaries,
                ..fold_inputs
            });
            fresh_fold = true;
            // A fresh fold shows every summary in `m[0]`, so none is newer.
            let newer = match HeadSummaries::for_base(
                &mut head_summaries,
                &base,
                &self.summaries,
                self.summary_store(),
                &model_key,
                fold_inputs.counter,
                |rows| self.date_summaries(rows, None),
            ) {
                Ok(newer) => newer,
                Err(unread) => return self.head_as_shown_for(unread),
            };
            // A fresh fold shows every current memory, so none is gone.
            (m1, next, _) = head::delta_with(&base, &fold_inputs, &newer);
        }
        self.head_summaries = head_summaries;
        if let Some(Some(mural)) = drawn {
            self.keep_mural(mural);
        }
        let image = next.mural.as_deref().and_then(|hash| self.mural_png(hash));
        let mut ops = head::head_ops(&next.m0, &m1, image);
        // Between folds `m[0]` is exactly what the runner last applied. That
        // is normally what the baseline renders, but not after ck-mc adopted
        // a newer view from the runner (its own saved state was older, as
        // after a restore): re-rendering the older baseline would rewrite
        // the cached prefix from its start. The older baseline still drives
        // `m[1]`, which may then repeat what `m[0]` shows until the next fold.
        if !fresh_fold {
            if let Some(shown) = self.latest.as_ref().and_then(|view| {
                view.edits.iter().find_map(|edit| match &edit.op {
                    EditOp::Insert { message, .. } if message.id == head::M0_ID => {
                        Some(edit.op.clone())
                    }
                    _ => None,
                })
            }) {
                if let Some(m0) = ops.iter_mut().find(
                    |op| matches!(op, EditOp::Insert { message, .. } if message.id == head::M0_ID),
                ) {
                    *m0 = shown;
                }
            }
        }
        self.next_baseline = Some(match &self.baseline {
            Some(held) if held.as_ref() == &next => held.clone(),
            _ => Arc::new(next),
        });
        ops
    }

    /// The days the served `m[1]` heads its summaries with, which a fold
    /// falls back on ([`Session::date_summaries`]).
    fn shown_days(&self) -> Option<&head::NewerDays> {
        self.baseline
            .as_ref()
            .and_then(|baseline| baseline.newer_days.as_ref())
    }

    /// Fill in the days each of `rows` shows in its heading: the UTC days
    /// its first and last message were written ([`crate::summary::dates`]).
    /// Each time comes from the first place that knows it: the transcript
    /// index, while it still holds the message; the times saved for the
    /// messages the index let go at a cut; the message search index, which
    /// also holds the standalone plugin's times for a session moved from
    /// it (the messages before the move never enter this session's index).
    /// Each store is read once, for every time the places before it left
    /// unknown. When none knows a time, a fold passes the days `m[1]`
    /// showed (`shown`), and the row takes the day its own entry there
    /// records, so dates `m[1]` showed stay in `m[0]`. A row with either
    /// day still unknown keeps no date. Only a render that writes headings
    /// anew calls this: a fold, or `m[1]` showing a summary for the first
    /// time.
    pub(super) fn date_summaries(
        &self,
        rows: &mut [StoredCompartment],
        shown: Option<&head::NewerDays>,
    ) {
        use std::collections::{BTreeSet, HashMap};
        let _timing = crate::notice_cost_timing::span("head.dates");
        let held = |mid: &str| {
            self.index
                .ordinal_of(mid)
                .and_then(|ordinal| self.index.at(ordinal))
                .map(|entry| entry.written_at)
                .filter(|written| *written > 0)
        };
        let unheld: BTreeSet<(i64, &str)> = rows
            .iter()
            .flat_map(|row| {
                [
                    (row.start_message, row.start_message_id.as_str()),
                    (row.end_message, row.end_message_id.as_str()),
                ]
            })
            .filter(|(_, mid)| held(mid).is_none())
            .collect();
        let saved: HashMap<String, u64> = match &self.store {
            Some(store) if !unheld.is_empty() => {
                let mids: BTreeSet<&str> = unheld
                    .iter()
                    .map(|(_, mid)| *mid)
                    .filter(|mid| !mid.is_empty())
                    .collect();
                store.message_times(&self.key, &mids.into_iter().collect::<Vec<_>>())
            }
            _ => HashMap::new(),
        };
        let unsaved: Vec<(i64, &str)> = unheld
            .iter()
            .filter(|(_, mid)| !saved.contains_key(*mid))
            .copied()
            .collect();
        let searched: HashMap<(i64, String), u64> = match &self.db {
            Some(db) if !unsaved.is_empty() => db.with_connection(|conn| {
                crate::summary::dates::search_times(
                    conn,
                    &self.key.harness,
                    &self.key.session,
                    &unsaved,
                )
            }),
            _ => HashMap::new(),
        };
        let day = |number: i64, mid: &str| {
            held(mid)
                .or_else(|| saved.get(mid).copied())
                .or_else(|| searched.get(&(number, mid.to_owned())).copied())
                .and_then(crate::summary::dates::utc_day)
        };
        let days: Vec<(Option<String>, Option<String>)> = rows
            .iter()
            .map(|row| {
                let recorded = shown
                    .and_then(|shown| shown.get(&row.sequence))
                    .filter(|recorded| recorded.belongs_to(row))
                    .and_then(head::ShownDays::days);
                let start = day(row.start_message, &row.start_message_id)
                    .or_else(|| recorded.map(|days| days.start.clone()));
                let end = day(row.end_message, &row.end_message_id)
                    .or_else(|| recorded.map(|days| days.end.clone()));
                match (start, end) {
                    (Some(start), Some(end)) => (Some(start), Some(end)),
                    _ => (None, None),
                }
            })
            .collect();
        for (row, (start, end)) in rows.iter_mut().zip(days) {
            (row.start_date, row.end_date) = (start, end);
        }
    }

    /// The memory mural for a fold, or `None` when it is off, the model
    /// doesn't read images, or there is nothing worth drawing. It shows the
    /// project's own memories among `rows` that the fold's text left out for
    /// room (`left_out`). A failure to draw is logged and leaves the mural
    /// out of this fold.
    fn draw_mural(
        &self,
        settings: &Settings,
        memory_enabled: bool,
        rows: &[crate::head_memories::Row],
        left_out: &std::collections::HashSet<i64>,
    ) -> Option<crate::mural::Mural> {
        if !settings.mural_enabled
            || !memory_enabled
            || self.conditions.accepts_images != Some(true)
        {
            return None;
        }
        let (db, project) = (self.db.as_ref()?, self.project.as_ref()?);
        let memories: Vec<StoredMemory> = rows
            .iter()
            .filter(|row| row.level == "project" && row.owner == project.id)
            .map(crate::head_memories::Row::stored)
            .collect();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_millis() as i64);
        let drawn = db
            .with_connection(|conn| {
                crate::mural::ensure(conn, &project.id, &memories, left_out, now)
            })
            .map_err(|error| error.to_string());
        drawn.unwrap_or_else(|error| {
            tracing::warn!(
                "ck-mc: session {}: the memory mural was left out of this fold: {error}",
                self.key.session
            );
            None
        })
    }

    /// Keep a newly drawn mural: in memory for the views that repeat `m[0]`,
    /// and in the store for after a restart.
    pub(super) fn keep_mural(&mut self, mural: crate::mural::Mural) {
        use base64::Engine as _;
        if let Some(store) = &self.store {
            if let Err(error) = store.save_head_mural(&self.key, &mural.content_hash, &mural.png) {
                tracing::warn!("ck-mc: {error}");
            }
        }
        let data = base64::engine::general_purpose::STANDARD.encode(&mural.png);
        self.mural_image = Some((mural.content_hash, data));
    }

    /// The image for the mural with checksum `hash`, as a view carries it.
    /// After a restart it comes from the store, so `m[0]` keeps its bytes.
    pub(super) fn mural_png(&mut self, hash: &str) -> Option<InsertedImage> {
        use base64::Engine as _;
        if self
            .mural_image
            .as_ref()
            .is_none_or(|(kept, _)| kept != hash)
        {
            let png = self
                .store
                .as_ref()
                .and_then(|store| store.head_mural(&self.key, hash));
            let Some(png) = png else {
                tracing::info!(
                    "ck-mc: session {}: the mural image m[0] shows is gone; m[0] goes without it",
                    self.key.session
                );
                return None;
            };
            let data = base64::engine::general_purpose::STANDARD.encode(&png);
            self.mural_image = Some((hash.to_owned(), data));
        }
        let (_, data) = self.mural_image.as_ref()?;
        Some(InsertedImage::new("image/png", data.clone()))
    }

    /// The history head as the latest view shows it, after a read the head
    /// needs failed: nothing about it changes on this pass.
    /// The held entries with the full output of each tool part whose output
    /// `ops` replace, when ck-mc read it (the answered-images lane does).
    /// The index holds tool output in compact form, so the view checks could
    /// otherwise allow only the part's own number in the replacement and
    /// refuse any other tag its original text quotes (`foreign_tag`), as the
    /// runner, which checks against the full text, would not. `None` when no
    /// op replaces such an output.
    pub(super) fn with_replaced_outputs(
        &self,
        ops: &[EditOp],
    ) -> Option<Vec<cortexkit_role_compaction::read::Entry>> {
        let wanted: BTreeSet<lanes::PartKey> = ops
            .iter()
            .filter_map(|op| match op {
                EditOp::Replace {
                    mid, part, field, ..
                } if field == "output" => Some((mid.clone(), part.clone())),
                _ => None,
            })
            .filter(|key| self.image_outputs.contains_key(key))
            .collect();
        if wanted.is_empty() {
            return None;
        }
        let mut entries = self.index.entries().to_vec();
        for entry in &mut entries {
            for part in &mut entry.parts {
                let key = (entry.mid.clone(), part.id.clone());
                if let (true, PartBody::Tool(tool)) = (wanted.contains(&key), &mut part.body) {
                    tool.output = self.image_outputs.get(&key).cloned();
                }
            }
        }
        Some(entries)
    }

    /// After an undo, removed numbers go to new parts (compaction contract
    /// T4), so the age-sweep bookmark can't stay above the highest number
    /// still held: a new output under it would count as far behind at once.
    pub(super) fn clamp_bookmark_to_held(&mut self) {
        self.clamp_bookmark_to(self.index.entries().len());
    }

    /// Clamp the bookmark to the highest number among the first `count`
    /// held entries.
    pub(super) fn clamp_bookmark_to(&mut self, count: usize) {
        let held = self.index.entries()[..count]
            .iter()
            .flat_map(|entry| entry.parts.iter())
            .filter_map(|part| part.tag)
            .max()
            .unwrap_or(0);
        self.reclaim_bookmark = self.reclaim_bookmark.min(held);
        self.notice_reclaim_bookmark = self.notice_reclaim_bookmark.min(held);
    }

    /// Whether the history head and cut in `history` differ from the latest
    /// view's only in `m[1]`.
    pub(super) fn only_m1_changes(&self, history: &[EditOp]) -> bool {
        let Some(latest) = &self.latest else {
            return false;
        };
        let shown = |wanted: &EditOp| latest.edits.iter().any(|edit| edit.op == *wanted);
        let mut m1_changed = false;
        for op in history {
            match op {
                EditOp::Insert { message, .. } if message.id == head::M1_ID => {
                    m1_changed |= !shown(op);
                }
                _ if !shown(op) => return false,
                _ => {}
            }
        }
        m1_changed
    }

    /// The head as shown, when the summaries a render needs couldn't all be
    /// read. Summaries missing from `context.db` are read from there again
    /// before the next build ([`Session::reload_changed_summaries`]); a
    /// failed read is simply tried again.
    fn head_as_shown_for(&mut self, unread: UnreadSummaries) -> Vec<EditOp> {
        match unread {
            UnreadSummaries::Failed(error) => {
                self.head_as_shown(&format!("reading summaries: {error}"))
            }
            UnreadSummaries::Missing(missing) => {
                let why = format!("summaries {missing:?} are not in context.db");
                self.summaries_missing = Some(missing);
                self.head_as_shown(&why)
            }
        }
    }

    pub(super) fn head_as_shown(&mut self, why: &str) -> Vec<EditOp> {
        tracing::info!(
            "ck-mc: session {}: history head kept as shown, {why}",
            self.key.session
        );
        self.next_baseline = None;
        self.latest
            .as_ref()
            .map(|view| {
                view.edits
                    .iter()
                    .filter(|edit| head::is_head(&edit.op))
                    .map(|edit| edit.op.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The settings the history head's baseline (`m[0]`) is rendered under,
    /// as they are now.
    pub(super) fn head_shape(&self, settings: &Settings) -> head::Shape {
        head::Shape {
            memory_enabled: settings.memory_enabled,
            memory_budget_tokens: settings.memory_budget_tokens,
            history_budget_tokens: (crate::pass::usable_window(&self.conditions) as f64
                * settings.execute_threshold_percentage
                / 100.0
                * settings.history_budget_percentage) as u64,
            history_budget_percentage_bp: Some(
                (settings.history_budget_percentage * 10_000.0).round() as u64,
            ),
            profile_budget_tokens: Some(settings.profile_budget_tokens),
        }
    }

    /// Whether the baseline must be rendered again: under different settings
    /// than these, with memory blocks in an older format
    /// ([`head::MEMORY_FORMAT`]), or from before the settings were recorded.
    pub(super) fn head_shape_changed(&self, settings: &Settings) -> bool {
        self.baseline.as_ref().is_some_and(|baseline| {
            let now = self.head_shape(settings);
            baseline.format_fold_due(now.memory_enabled)
                || baseline
                    .shape
                    .as_ref()
                    .is_none_or(|shape| shape.requires_fold(&now))
        })
    }
}
