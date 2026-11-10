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
//! The floor only moves forward. ck-mc keeps the newest one it took in the
//! session's saved state, so a restart starts from it, and ignores a
//! reported floor at or before the one it holds.

use super::*;

impl Session {
    /// Take the floor the latest conditions report, if it is newer than the
    /// one ck-mc holds. Called once the index has caught up with those
    /// conditions, since the floor names an entry by id.
    ///
    /// A floor naming an entry the index doesn't hold is left alone: it is
    /// either before the cut, where the model sees nothing anyway, or not on
    /// the transcript ck-mc read, and the next conditions report it again.
    pub(super) fn take_signed_floor(&mut self) {
        let Some(through) = self
            .conditions
            .signed_floor
            .as_ref()
            .map(|floor| floor.through.as_str())
        else {
            return;
        };
        if self.signed_floor.as_deref() == Some(through) {
            return;
        }
        let Some(ordinal) = self.index.ordinal_of(through) else {
            return;
        };
        // The floor held now, when its entry is still in the index. One that
        // isn't (an undo removed it, or the cut passed it) no longer covers
        // anything ck-mc holds, so any held entry is ahead of it.
        if let Some(held) = self.signed_floor() {
            if ordinal <= held {
                return;
            }
        }
        tracing::info!(
            "ck-mc: session {}: signed floor moved to {through} (message {ordinal}); the runner strips signed reasoning at or before it",
            self.key.session
        );
        self.signed_floor = Some(through.to_owned());
    }

    /// The ordinal of the signed floor's entry, when the index holds it.
    /// Every signed reasoning part at or before it is stripped by the runner.
    pub(crate) fn signed_floor(&self) -> Option<u64> {
        self.index.ordinal_of(self.signed_floor.as_deref()?)
    }
}
