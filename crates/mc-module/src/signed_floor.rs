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
//!   naming an entry the index doesn't hold is left alone: it is either
//!   before the cut, where the model sees nothing anyway, or not on the
//!   transcript ck-mc read, and the next conditions state it again.
//! - A refusal overrides a statement only when the two contradict. A view
//!   refused for keeping a signed part at or before ck-mc's floor shows the
//!   runner does not strip there, since the contract forbids that refusal
//!   under a floor it applies. ck-mc drops its floor at once
//!   (`signed_floor_regressed`), and the refused view's drops are not held
//!   against it: ck-mc's copy was at fault, not the drops. While conditions
//!   keep naming that same floor, the runner contradicts itself, and ck-mc
//!   keeps ignoring it (`signed_floor_contradicted`, logged once). The first
//!   statement of no floor or a different one ends that, as does any Setup;
//!   after that the floor is taken again when stated.
//!
//! The floor ck-mc holds is saved with the session's state, so a restart
//! starts from the value last taken.

use super::*;

/// A floor a refusal showed the runner does not apply, while its conditions
/// keep naming it. Kept in memory only: after a restart a contradicting
/// runner's floor is taken again, and its next refusal drops it again.
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
                        "ck-mc: session {}: signed_floor_contradicted: the runner names signed floor {} again, but it refused a view for keeping signed part {mid}/{part} at or before it; ck-mc takes no floor until the runner states another one or none",
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
        let Some(ordinal) = self.index.ordinal_of(&through) else {
            return;
        };
        let from = match (self.signed_floor.as_deref(), self.signed_floor()) {
            (Some(held), Some(at)) => format!("{held} (message {at})"),
            (Some(held), None) => format!("{held} (not held)"),
            (None, _) => "none".to_owned(),
        };
        tracing::info!(
            "ck-mc: session {}: signed floor moved to {through} (message {ordinal}) from {from}; the runner strips signed reasoning at or before it",
            self.key.session
        );
        self.signed_floor = Some(through);
    }

    /// Whether the runner's refusal of view `version` shows that it does not
    /// apply the floor ck-mc holds: it names a signed part at or before the
    /// floor as invalid, which the contract forbids under a floor the runner
    /// applies. ck-mc then drops its floor, so the next view judges that
    /// reasoning like any other, and remembers the floor as disproved. The
    /// caller rolls the view back without holding its drops against it.
    pub(super) fn refusal_disproves_floor(&mut self, version: u64, refusal: &ViewRefusal) -> bool {
        let ViewRefusal::Rule(RuleBreak::SignedPartInvalid { mid, part }) = refusal else {
            return false;
        };
        let (Some(held_at), Some(ordinal)) = (self.signed_floor(), self.index.ordinal_of(mid))
        else {
            return false;
        };
        if ordinal > held_at {
            return false;
        }
        let Some(held) = self.signed_floor.take() else {
            return false;
        };
        tracing::warn!(
            "ck-mc: session {}: signed_floor_regressed: ck-mc held signed floor {held} (message {held_at}), the runner refused view {version} for keeping signed part {mid}/{part} (message {ordinal}); the runner does not strip there, so ck-mc drops its floor",
            self.key.session
        );
        self.disproved_floor = Some(Disproved {
            floor: held,
            part: (mid.clone(), part.clone()),
            warned: false,
        });
        true
    }

    /// The ordinal of the signed floor's entry, when the index holds it.
    /// Every signed reasoning part at or before it is stripped by the runner.
    pub(crate) fn signed_floor(&self) -> Option<u64> {
        self.index.ordinal_of(self.signed_floor.as_deref()?)
    }
}
