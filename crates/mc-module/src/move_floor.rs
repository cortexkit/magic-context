//! The move floor of a session moved onto its runner (see [`crate::move_in`]):
//! the entry the session's first view on the runner cut through.
//!
//! Before that entry the runner numbers message parts by their position,
//! while the host the session came from numbered them its own way. A view
//! that cuts before the floor, or carries no cut at all, would show the
//! runner messages it cannot number the way ck-mc's summaries and tags do.
//! A runner refuses such a view. One that predates that refusal sends the
//! session's whole history as it is, without the summaries or drops, and a
//! long session's requests then fail. So for a moved session every view
//! ck-mc publishes cuts at or after the floor. When it can't (an undo or a
//! reconciliation took away the summaries that reached the floor), ck-mc
//! publishes no view at all: the runner keeps serving the view it has, and
//! views publish again once the summaries reach the floor.
//!
//! The floor is kept in the session's saved state. A session moved before
//! ck-mc kept it there has only its move fence, which names the cut entry by
//! id; Setup reads the fence and asks the runner for that entry's ordinal.

use super::*;

/// The entry a moved session's first view cut through.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct MoveFloor {
    /// The entry's ordinal, in the runner's numbering.
    pub ordinal: u64,
    /// The entry's id.
    pub mid: String,
}

/// Where the runner said an entry sits.
pub(super) enum Placed {
    At(u64),
    /// Not on the active path, or the read failed.
    Nowhere,
    /// The runner can't answer yet (`transient`), but will.
    Later,
}

/// The runner can't place a reoffered view's cut yet, so the view is
/// offered again later rather than judged now.
#[derive(Debug)]
pub(super) struct PlaceLater;

/// The message id a view cuts through, if it has a cut.
pub(super) fn cut_of(view: &View) -> Option<&str> {
    view.edits.iter().find_map(|edit| match &edit.op {
        EditOp::Cut { through } => Some(through.as_str()),
        _ => None,
    })
}

/// Why a view whose cut is `cut` (its id, and its ordinal where known) may
/// not go to a session whose views must cut through `floor` or later;
/// `None` when it may.
pub(super) fn breach(floor: &MoveFloor, cut: Option<(&str, Option<u64>)>) -> Option<String> {
    let Some((through, ordinal)) = cut else {
        return Some("no cut".into());
    };
    if through == floor.mid {
        return None;
    }
    match ordinal {
        Some(ordinal) if ordinal >= floor.ordinal => None,
        Some(ordinal) => Some(format!("a cut through entry {ordinal} ({through})")),
        // An entry ck-mc cannot place may lie anywhere, before the floor too.
        None => Some(format!(
            "a cut through {through}, an entry ck-mc cannot place"
        )),
    }
}

impl Session {
    /// Record the cut of a moved session's first view as its floor.
    pub(super) fn set_move_floor(&mut self, cut: Option<(u64, &str)>) {
        self.move_floor = cut.map(|(ordinal, mid)| MoveFloor {
            ordinal,
            mid: mid.to_owned(),
        });
    }

    /// Whether the session's summaries stop short of its move floor. Every
    /// cut ends where a summary ends, so no view can then cut at or after
    /// the floor.
    pub(super) fn short_of_move_floor(&self) -> bool {
        self.move_floor.as_ref().is_some_and(|floor| {
            self.summarized_through()
                .is_none_or(|reach| reach < floor.ordinal)
        })
    }

    /// Why `view`, just built against the index, may not go to the runner;
    /// `None` when it may, or when the session never moved.
    pub(super) fn move_floor_breach(&self, view: &View) -> Option<String> {
        let floor = self.move_floor.as_ref()?;
        breach(
            floor,
            cut_of(view).map(|through| (through, self.index.ordinal_of(through))),
        )
    }

    /// The same check for a view built before a restart, whose cut the
    /// index may not hold yet: the runner places it. A cut through the
    /// floor entry itself, or through an entry the index holds, needs no
    /// read. `Err` when the runner answered that it can't place the entry
    /// yet (`transient`): the view's fate is not decided, and it is offered
    /// again later.
    pub(super) async fn move_floor_breach_placed<C: RunnerClient>(
        &self,
        client: &C,
        view: &View,
    ) -> Result<Option<String>, PlaceLater> {
        let Some(floor) = self.move_floor.as_ref() else {
            return Ok(None);
        };
        let cut = match cut_of(view) {
            Some(through) if through == floor.mid => return Ok(None),
            Some(through) => match self.place(client, through).await {
                Placed::At(ordinal) => Some((through, Some(ordinal))),
                Placed::Nowhere => Some((through, None)),
                Placed::Later => return Err(PlaceLater),
            },
            None => None,
        };
        Ok(breach(floor, cut))
    }

    /// A pass's view stays in ck-mc because of `why`. Logged once per stay
    /// below the floor, not on every pass.
    pub(super) fn hold_below_move_floor(&mut self, why: &str) {
        if std::mem::replace(&mut self.move_floor_held, true) {
            return;
        }
        let Some(floor) = &self.move_floor else {
            return;
        };
        let reach = match (self.summarized_through(), self.last_summary_end()) {
            (Some(ordinal), Some(mid)) => format!("entry {ordinal} ({mid})"),
            _ => "nothing".into(),
        };
        tracing::warn!(
            session = %self.key.session,
            floor_ordinal = %floor.ordinal,
            floor_mid = %floor.mid,
            summary_reach = %reach,
            carried_head = %why,
            "ck-mc: session: cut_before_move_floor; the runner keeps its current view"
        );
    }

    /// A view met the move floor again after views were held below it.
    pub(super) fn release_move_floor_hold(&mut self) {
        if !std::mem::take(&mut self.move_floor_held) {
            return;
        }
        if let Some(floor) = &self.move_floor {
            tracing::info!(
                session = %self.key.session,
                floor_ordinal = %floor.ordinal,
                floor_mid = %floor.mid,
                "ck-mc: session: views publish again because the cut reaches the move floor"
            );
        }
    }

    /// Put back what a pass held below the move floor set aside for its view:
    /// none of it reached the runner. Queued drops stay queued and a
    /// `ctx_keep` waits again, for the first view that meets the floor.
    pub(super) fn discard_held_view(&mut self) {
        self.next_baseline = None;
        self.next_caveman = None;
        self.next_latch = false;
        self.next_rearm = false;
        self.next_covered.clear();
        self.next_reclaim_bookmark = None;
        self.next_notice_reclaim_bookmark = None;
        if let Some(keep) = self.next_keep.take() {
            self.pending_keep = Some(keep);
        }
    }

    /// The ordinal of entry `mid`: from the index when it holds it,
    /// otherwise from the runner.
    pub(super) async fn place<C: RunnerClient>(&self, client: &C, mid: &str) -> Placed {
        self.place_entry(client, mid, true).await
    }

    async fn place_entry<C: RunnerClient>(
        &self,
        client: &C,
        mid: &str,
        log_failures: bool,
    ) -> Placed {
        if let Some(ordinal) = self.index.ordinal_of(mid) {
            return Placed::At(ordinal);
        }
        let read = crate::reads::named_detail(
            client,
            &self.key,
            vec![mid.to_owned()],
            self.limits,
            Detail::Compact,
            |mids| Select::Mids { mids },
        )
        .await;
        self.count_read(read.as_ref().ok().map(Vec::len));
        match read {
            Ok(entries) => entries
                .iter()
                .find(|entry| entry.mid == mid)
                .map_or(Placed::Nowhere, |entry| Placed::At(entry.ordinal)),
            // The runner can't answer this read yet but will, so it proves
            // nothing about where the entry is.
            Err(error)
                if error.code.as_deref()
                    == Some(cortexkit_role_compaction::wire::codes::TRANSIENT) =>
            {
                if log_failures {
                    tracing::info!(
                        session = %self.key.session,
                        %mid,
                        ?error,
                        "ck-mc: session: the runner can't place an entry against the move floor yet"
                    );
                }
                Placed::Later
            }
            Err(error) => {
                if log_failures && !error.message.starts_with("runner fault:") {
                    tracing::warn!(
                        session = %self.key.session,
                        %mid,
                        ?error,
                        "ck-mc: session: reading an entry to place it against the move floor failed"
                    );
                }
                Placed::Nowhere
            }
        }
    }

    /// A `cut_before_move` refusal describes a cut the runner cannot serve,
    /// regardless of the drops the view carried. Use its floor from now on
    /// if we can place it and it is later than the floor already held.
    pub(super) async fn take_move_refusal<C: RunnerClient>(
        &mut self,
        client: &C,
        version: u64,
        refusal: &ViewRefusal,
    ) -> bool {
        let ViewRefusal::CutBeforeMove { moved_through } = refusal else {
            return false;
        };
        let placed = match self
            .move_floor
            .as_ref()
            .filter(|floor| floor.mid == *moved_through)
        {
            Some(floor) => Placed::At(floor.ordinal),
            None => self.place_entry(client, moved_through, false).await,
        };
        let previous = self.move_floor.as_ref().map_or_else(
            || "none".into(),
            |floor| format!("entry {} ({})", floor.ordinal, floor.mid),
        );
        let outcome = match placed {
            Placed::At(ordinal)
                if self
                    .move_floor
                    .as_ref()
                    .is_none_or(|floor| ordinal > floor.ordinal) =>
            {
                self.set_move_floor(Some((ordinal, moved_through)));
                format!("adopting move floor at entry {ordinal}")
            }
            Placed::At(_) => "keeping the previous move floor".into(),
            Placed::Nowhere | Placed::Later => {
                // Retry placement on the next refusal, but don't keep
                // reporting the same missing ordinal.
                if !self
                    .move_floor_unplaced_logged
                    .insert(moved_through.clone())
                {
                    return true;
                }
                "cannot place the runner's move floor; leaving the floor unchanged".into()
            }
        };
        tracing::warn!(
            session = %self.key.session,
            view_version = %version,
            %moved_through,
            previous_floor = %previous,
            %outcome,
            "ck-mc: session: runner refused a view with cut_before_move"
        );
        true
    }

    /// Setup: take the move floor from the session's move fence when its
    /// saved state has none, as for a session moved before ck-mc kept the
    /// floor there. The fence names the cut entry by id only, so the runner
    /// places it. A session never moved, or one moved with no cut, has no
    /// floor. If the entry can't be placed, views publish as they did
    /// before the floor existed, and the next Setup tries again.
    pub(super) async fn load_move_floor<C: RunnerClient>(&mut self, client: &C) {
        if self.move_floor.is_some() {
            return;
        }
        let Some(db) = self.db.clone() else {
            return;
        };
        let fence = crate::move_in::fence_key(&self.key.harness, &self.key.session);
        let record = match db.with_connection(|conn| crate::move_batches::record(conn, &fence)) {
            Ok(Some(record)) => record,
            Ok(None) => return,
            Err(error) => {
                tracing::warn!(
                    session = %self.key.session,
                    %error,
                    "ck-mc: session: reading its move fence failed; no move floor is known"
                );
                return;
            }
        };
        // A runner-to-runner move also fences the session it left, with a
        // record naming the session it moved to: that floor is not this
        // session's.
        let names_this_session = record["state"] == "moved"
            && record["session"] == self.key.session.as_str()
            && record["harness"] == self.key.harness.as_str()
            && record["runner"]
                .as_str()
                .is_none_or(|runner| runner == self.key.runner);
        if !names_this_session {
            return;
        }
        let Some(mid) = record["cut"].as_str() else {
            return;
        };
        match self.place(client, mid).await {
            Placed::At(ordinal) => {
                tracing::info!(
                    session = %self.key.session,
                    %ordinal,
                    %mid,
                    "ck-mc: session: read the move floor entry from its move fence"
                );
                self.set_move_floor(Some((ordinal, mid)));
            }
            Placed::Nowhere | Placed::Later => tracing::warn!(
                session = %self.key.session,
                %mid,
                "ck-mc: session: the runner cannot place the cut entry named by the move fence; no move floor is known until a later Setup places it"
            ),
        }
    }
}
