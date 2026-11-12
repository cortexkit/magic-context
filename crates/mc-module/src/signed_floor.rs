//! The runner's signed floor.
//!
//! On a model whose signed reasoning is bound to the request prefix (the
//! rules report `signed_parts: bound`), any change to the request's tool set
//! invalidates the signed reasoning already in the transcript, and the
//! provider rejects a request that keeps it. The runner then records a
//! floor at the session's newest entry and, from the first request carrying
//! the new tools, strips every signed reasoning part in entries at or before
//! it (runner contract §11.1.1). A host relaunch with a changed tool set
//! moves it too. ck-mc declares `compaction-signed-floor/v1`, so Setup and
//! every notice's or ride's conditions name the floor's entry
//! (compaction contract W3.5).
//!
//! That reasoning is never sent again, so nothing ck-mc does may treat it as
//! sent: reasoning clearing neither counts nor drops it
//! ([`lanes::stripped_by_floor`]), the signed-thinking hold has nothing to
//! protect there ([`pass::signed_thinking_hold`]), the apps' reasoning
//! count leaves it out, and ck-mc's own view checks don't judge it
//! invalidated by edits before it (`view_builder`). The floor is runner
//! state: no view carries it and it enters no checksum.
//!
//! ck-mc's floor is only a copy of that runner state, and the runner's own
//! check of each view is the authority on it. A copy that names a floor the
//! runner no longer applies makes ck-mc keep signed reasoning the runner
//! then sends and judges invalid, so the runner refuses every view ck-mc
//! builds. So ck-mc mirrors the runner's latest statement:
//!
//! - Every Setup, notice and ride states the floor in full (W3.5: Setup and
//!   later conditions report the same runner state), and a runner names none
//!   when it applies none, including while the floor's entry is off the
//!   session's active path after an undo. A runner also names none while it
//!   holds a floor that cannot matter to a view: the serving model's signed
//!   parts aren't bound, the floor's entry and every part it covers are
//!   before the window the call covers, or the provider didn't declare the
//!   capability. Once the index has caught up, ck-mc holds exactly the floor
//!   stated, newer or older than before, and none when none is stated. A
//!   floor that goes away is logged as `signed_floor_regressed`. A floor
//!   naming an entry the index doesn't hold is taken too, and covers nothing
//!   ck-mc holds: its entry is before the summary cut (the oldest entries a
//!   view replaces with the history head), where the model sees nothing
//!   anyway, or not on the transcript ck-mc read.
//! - A refusal is judged against the refused view's own edits, not against
//!   the floor ck-mc holds when it arrives, since the floor may have moved
//!   since the view was built. A view refused for keeping a signed part that
//!   its edits invalidate once no floor covers it was built relying on a
//!   floor the runner did not apply at that step, so its drops are not held
//!   against it. If the part is valid under the floor ck-mc holds now, a
//!   runner applying that floor would have taken the view, so it does not
//!   apply it, even though it states it: the contract forbids that refusal
//!   under a floor the runner applies. That refusal overrides the statement,
//!   and ck-mc drops its floor at once (`signed_floor_regressed`). While
//!   conditions keep naming that same floor, the runner contradicts itself,
//!   and ck-mc keeps ignoring it (`signed_floor_contradicted`, logged once).
//!   The first statement of no floor or a different one ends that, as does
//!   any Setup; after that the floor is taken again when stated.
//!
//! The floor ck-mc holds is saved with the session's state, so a restart
//! starts from the value last taken.

use super::*;

/// A floor a refusal showed the runner does not apply, while its conditions
/// keep naming it. Kept in memory only: after a restart a contradicting
/// runner's floor is taken again, and its next refusal drops it again.
#[derive(Clone)]
pub(super) struct Disproved {
    /// The floor the refusal disproved.
    floor: String,
    /// The signed part the runner refused, for the log.
    part: lanes::PartKey,
    /// Whether the contradiction has been logged.
    warned: bool,
}

impl Session {
    /// Take the floor the latest conditions state (Setup's, a notice's or a
    /// ride's) as the runner's whole statement: forward, back, or to none.
    /// Called once the index has caught up with those conditions, since the
    /// floor names an entry by id.
    pub(super) fn take_signed_floor(&mut self) {
        let stated = self
            .conditions
            .signed_floor
            .as_ref()
            .map(|floor| floor.through.clone());
        // A floor a refusal disproved stays ignored only while the runner
        // keeps naming that same floor.
        if let Some(disproved) = &mut self.disproved_floor {
            if stated.as_deref() == Some(disproved.floor.as_str()) {
                if !disproved.warned {
                    disproved.warned = true;
                    let (mid, part) = &disproved.part;
                    tracing::warn!(
                        "ck-mc: session {}: signed_floor_contradicted: the runner names signed floor {} again, but it refused a view for keeping signed part {mid}/{part}, which only that floor makes valid; ck-mc takes no floor until the runner states another one or none",
                        self.key.session,
                        disproved.floor
                    );
                }
                return;
            }
            self.disproved_floor = None;
        }
        let Some(through) = stated else {
            if let Some(held) = self.signed_floor.take() {
                let held_at = self
                    .index
                    .ordinal_of(&held)
                    .map_or_else(|| "not held".to_owned(), |at| format!("message {at}"));
                tracing::warn!(
                    "ck-mc: session {}: signed_floor_regressed: ck-mc held signed floor {held} ({held_at}), the runner now states no floor; ck-mc follows it and judges the signed reasoning that floor covered as sent",
                    self.key.session
                );
            }
            return;
        };
        if self.signed_floor.as_deref() == Some(through.as_str()) {
            return;
        }
        // Taken even when the index doesn't hold its entry: such a floor
        // covers nothing ck-mc holds (`signed_floor()` places it nowhere),
        // and it starts to cover the transcript if the index reads its entry.
        let at = |mid: &str| {
            self.index
                .ordinal_of(mid)
                .map_or_else(|| "not held".to_owned(), |at| format!("message {at}"))
        };
        let from = self.signed_floor.as_deref().map_or_else(
            || "none".to_owned(),
            |held| format!("{held} ({})", at(held)),
        );
        tracing::info!(
            "ck-mc: session {}: signed floor moved to {through} ({}) from {from}; the runner strips signed reasoning at or before it",
            self.key.session,
            at(&through)
        );
        self.signed_floor = Some(through);
    }

    /// Whether a `SignedPartInvalid` refusal of a view with `edits` names a
    /// part ck-mc kept only because of a signed floor, current or one held
    /// when the view was built: the part is invalid under the view's own
    /// edits once no floor covers it. Then the view's drops were not at
    /// fault, and the caller rolls it back without holding them against it.
    /// `None` for any other refusal, which keeps the usual handling.
    ///
    /// `Some(true)` when the part is also valid under the floor ck-mc holds
    /// now: a runner applying that floor would have taken the view, so it
    /// does not apply it, and the caller drops it ([`Self::disprove_floor`]).
    /// The part need not be at or before the floor: a runner that keeps the
    /// reasoning the floor covers can see ck-mc's drops after the floor as a
    /// gap between kept signed parts, and name the first kept part after it.
    pub(super) fn kept_for_a_floor(
        &self,
        edits: &[cortexkit_role_compaction::view::Edit],
        refusal: &ViewRefusal,
    ) -> Option<bool> {
        let ViewRefusal::Rule(RuleBreak::SignedPartInvalid { mid, part }) = refusal else {
            return None;
        };
        use cortexkit_compaction_view::rules::{invalid_signed_parts, Floor};
        let names = |floor: Floor<'_>| {
            invalid_signed_parts(self.index.entries(), edits, &self.conditions.rules, floor)
                .iter()
                .any(|(m, p)| m == mid && p == part)
        };
        if !names(Floor::none()) {
            return None;
        }
        // A floor the index can't place covers nothing, so the part is
        // invalid under it too and disproves nothing.
        let held = self.signed_floor.as_deref();
        Some(held.is_some_and(|held| !names(Floor::through(held))))
    }

    /// Judge a refusal of a view with `edits` (version `version`) for a
    /// signed floor's fault (see [`Self::kept_for_a_floor`]), dropping the
    /// held floor when the refusal disproves it. Whether the floor, not the
    /// view's drops, was at fault.
    pub(super) fn judge_floor_refusal(
        &mut self,
        edits: &[cortexkit_role_compaction::view::Edit],
        version: u64,
        refusal: &ViewRefusal,
    ) -> bool {
        let Some(disproves) = self.kept_for_a_floor(edits, refusal) else {
            return false;
        };
        if disproves {
            self.disprove_floor(version, refusal);
        }
        true
    }

    /// Drop the floor ck-mc holds, which the runner's refusal of view
    /// `version` showed it does not apply (see [`Self::kept_for_a_floor`]),
    /// so the next view judges that reasoning like any other, and remember
    /// it as disproved.
    pub(super) fn disprove_floor(&mut self, version: u64, refusal: &ViewRefusal) {
        let ViewRefusal::Rule(RuleBreak::SignedPartInvalid { mid, part }) = refusal else {
            return;
        };
        let held_at = self.signed_floor();
        let Some(held) = self.signed_floor.take() else {
            return;
        };
        let at = |ordinal: Option<u64>| {
            ordinal.map_or_else(|| "not held".to_owned(), |at| format!("message {at}"))
        };
        tracing::warn!(
            "ck-mc: session {}: signed_floor_regressed: ck-mc held signed floor {held} ({}), the runner refused view {version} for keeping signed part {mid}/{part} ({}), which only that floor makes valid; the runner does not apply it, so ck-mc drops its floor",
            self.key.session,
            at(held_at),
            at(self.index.ordinal_of(mid))
        );
        self.disproved_floor = Some(Disproved {
            floor: held,
            part: (mid.clone(), part.clone()),
            warned: false,
        });
    }

    /// The ordinal of the signed floor's entry, when the index holds it.
    /// Every signed reasoning part at or before it is stripped by the runner.
    pub(crate) fn signed_floor(&self) -> Option<u64> {
        self.index.ordinal_of(self.signed_floor.as_deref()?)
    }
}
