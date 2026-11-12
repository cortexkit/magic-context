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

/// The message id a view cuts through, if it has a cut.
fn cut_of(view: &View) -> Option<&str> {
    view.edits.iter().find_map(|edit| match &edit.op {
        EditOp::Cut { through } => Some(through.as_str()),
        _ => None,
    })
}

/// Why a view whose cut is `cut` (its id, and its ordinal where known) may
/// not go to a session moved with `floor`; `None` when it may.
fn breach(floor: &MoveFloor, cut: Option<(&str, Option<u64>)>) -> Option<String> {
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
    /// index may not hold yet: the runner places it.
    pub(super) async fn move_floor_breach_placed<C: RunnerClient>(
        &self,
        client: &C,
        view: &View,
    ) -> Option<String> {
        let floor = self.move_floor.as_ref()?;
        let cut = match cut_of(view) {
            Some(through) => Some((through, self.place(client, through).await)),
            None => None,
        };
        breach(floor, cut)
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
            "ck-mc: session {}: no view: cut_before_move_floor (move floor entry {} ({}), summaries reach {reach}, the view would carry {why}); the runner keeps the view it has",
            self.key.session,
            floor.ordinal,
            floor.mid
        );
    }

    /// A view met the move floor again after views were held below it.
    pub(super) fn release_move_floor_hold(&mut self) {
        if !std::mem::take(&mut self.move_floor_held) {
            return;
        }
        if let Some(floor) = &self.move_floor {
            tracing::info!(
                "ck-mc: session {}: views publish again: the cut reaches the move floor, entry {} ({})",
                self.key.session,
                floor.ordinal,
                floor.mid
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
    /// otherwise from the runner. `None` when neither can place it.
    async fn place<C: RunnerClient>(&self, client: &C, mid: &str) -> Option<u64> {
        if let Some(ordinal) = self.index.ordinal_of(mid) {
            return Some(ordinal);
        }
        match crate::reads::named_detail(
            client,
            &self.key,
            vec![mid.to_owned()],
            self.limits,
            Detail::Compact,
            |mids| Select::Mids { mids },
        )
        .await
        {
            Ok(entries) => entries
                .iter()
                .find(|entry| entry.mid == mid)
                .map(|entry| entry.ordinal),
            Err(error) => {
                if !error.message.starts_with("runner fault:") {
                    tracing::warn!(
                        "ck-mc: session {}: reading entry {mid} to place it against the move floor failed: {error:?}",
                        self.key.session
                    );
                }
                None
            }
        }
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
                    "ck-mc: session {}: reading its move fence failed: {error}; no move floor is known",
                    self.key.session
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
            Some(ordinal) => {
                tracing::info!(
                    "ck-mc: session {}: move floor entry {ordinal} ({mid}), from its move fence",
                    self.key.session
                );
                self.set_move_floor(Some((ordinal, mid)));
            }
            None => tracing::warn!(
                "ck-mc: session {}: its move fence names cut entry {mid}, which the runner cannot place; no move floor is known until a later Setup places it",
                self.key.session
            ),
        }
    }
}
