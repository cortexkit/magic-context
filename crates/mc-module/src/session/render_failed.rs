//! Rendering fallback state is separate from accepted views: the runner keeps
//! their version and checksum even when it cannot serve all their edits.

use super::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct State {
    parts: BTreeSet<lanes::PartKey>,
    messages: BTreeSet<String>,
    reasoning_drops: BTreeSet<lanes::PartKey>,
    pub(super) no_view: Option<u64>,
    retry_version: Option<u64>,
    pub(super) repair_pending: bool,
}

impl State {
    pub fn is_empty(&self) -> bool {
        self == &Self::default()
    }

    pub(super) fn excludes(&self, op: &EditOp) -> bool {
        match op {
            EditOp::Replace { mid, part, .. } => {
                self.messages.contains(mid) || self.parts.contains(&(mid.clone(), part.clone()))
            }
            EditOp::Drop { mid, .. } => self.messages.contains(mid),
            // A history cut can be required by a moved session. A coverage
            // mismatch repairs the index, never restores summarized history.
            _ => false,
        }
    }

    pub(super) fn accepted(&mut self, version: u64) {
        if self.repair_pending {
            self.retry_version = Some(version);
            self.repair_pending = false;
        } else if self.retry_version != Some(version) {
            // An independently permitted rebuild ends the immediate retry
            // chain; a later host failure may then get one recovery of its own.
            self.retry_version = None;
        }
    }
}

impl Session {
    /// Record rendering failures without treating an accepted view as refused.
    /// Returns true when this notice reports the failed immediate recovery.
    pub(super) fn take_render_failures(&mut self, events: &[Event]) -> bool {
        let mut repeat = false;
        for event in events {
            let Event::ViewRefused {
                version,
                refusal: ViewRefusal::RenderFailed { mid, part, field },
            } = event
            else {
                continue;
            };
            if let (Some(mid), Some(part)) = (mid, part) {
                self.render_failed.parts.insert((mid.clone(), part.clone()));
                tracing::warn!(
                    "ck-mc: session {}: render_failed view {version}: mid={mid:?} part={part:?} field={field:?}; keeping the view, skipping all replaces of the part",
                    self.key.session
                );
            } else {
                if let Some(mid) = mid {
                    self.render_failed.messages.insert(mid.clone());
                    // The report names only the message, not the failing
                    // edit. Conservatively treat any signed-reasoning drop
                    // already in that view on this message as the failed edit.
                    if let Some(view) = self.latest.as_ref().filter(|v| v.version == *version) {
                        for edit in &view.edits {
                            if let EditOp::Drop {
                                mid: m,
                                part: Some(part),
                            } = &edit.op
                            {
                                if m == mid
                                    && self.index.find(m, part).is_some_and(|(_, p)| {
                                        p.seal == cortexkit_role_compaction::part::Seal::Signed
                                            && matches!(p.body, PartBody::Reasoning { .. })
                                    })
                                {
                                    self.render_failed
                                        .reasoning_drops
                                        .insert((m.clone(), part.clone()));
                                }
                            }
                        }
                    }
                }
                self.index = Index::starting_at(self.cut.unwrap_or(1));
                self.index_ready = false;
                // A delayed report about an older view cannot prove that the
                // runner's current prefix is gone too.
                if self.latest.as_ref().is_some_and(|v| v.version == *version) {
                    self.render_failed.no_view = Some(*version);
                    repeat |= self.render_failed.retry_version == Some(*version);
                    self.render_failed.repair_pending = !repeat;
                }
            }
            // Recompute served-part accounting even though the accepted view
            // and its checksum have not changed.
            self.app_projection.render_changed();
        }
        repeat
    }

    pub(super) fn log_render_location(&self, events: &[Event]) {
        for event in events {
            let Event::ViewRefused {
                version,
                refusal:
                    ViewRefusal::RenderFailed {
                        mid,
                        part: None,
                        field,
                    },
            } = event
            else {
                continue;
            };
            let location = mid.as_ref().map_or("unlocated", |mid| {
                if !self.index_ready {
                    return "re-read unavailable";
                }
                self.index.entries().iter().find(|e| &e.mid == mid).map_or(
                    "not in index after re-read",
                    |entry| {
                        if self.cut.is_some_and(|cut| entry.ordinal <= cut) {
                            "before or at cut"
                        } else {
                            "after cut"
                        }
                    },
                )
            });
            let action = if self.render_failed.retry_version == Some(*version) {
                "repeat of immediate recovery; waiting for the next permitted rebuild"
            } else {
                "reading again from the cut; rebuilding once if still current"
            };
            tracing::warn!(
                "ck-mc: session {}: render_failed view {version}: mid={mid:?} part=None field={field:?}; {location}; {action}",
                self.key.session
            );
        }
    }

    pub(super) fn served_op(&self, op: &EditOp) -> bool {
        !matches!(op, EditOp::Replace { mid, part, .. }
            if self.render_failed.parts.contains(&(mid.clone(), part.clone())))
    }

    pub(super) fn serves_no_view(&self, view: Option<&View>) -> bool {
        self.render_failed.no_view.is_some()
            && self.render_failed.no_view == view.map(|v| v.version)
    }

    pub(super) fn repeats_failed_reasoning_drop(&mut self, view: &View) -> bool {
        let failed = view.edits.iter().find_map(|edit| match &edit.op {
            EditOp::Drop {
                mid,
                part: Some(part),
            } if self
                .render_failed
                .reasoning_drops
                .contains(&(mid.clone(), part.clone())) =>
            {
                Some((mid, part))
            }
            _ => None,
        });
        if let Some((mid, part)) = failed {
            tracing::warn!(
                "ck-mc: session {}: holding view {}: signed reasoning drop mid={mid:?} part={part:?} already failed to render; keeping the runner fallback until a later permitted rebuild no longer needs it",
                self.key.session, view.version
            );
            // The one immediate recovery was attempted. If the failed
            // drop remains necessary, wait for a later permitted rebuild
            // instead of turning the hold into an immediate retry loop.
            self.render_failed.repair_pending = false;
            return true;
        }
        false
    }

    pub(super) fn rendered_view<'a>(
        &self,
        view: Option<&'a View>,
    ) -> Option<std::borrow::Cow<'a, View>> {
        let view = view.filter(|_| !self.serves_no_view(view))?;
        if view.edits.iter().all(|edit| self.served_op(&edit.op)) {
            return Some(std::borrow::Cow::Borrowed(view));
        }
        let mut rendered = view.clone();
        // This projection is for accounting and lane selection only. The
        // accepted view (including its checksum) is never rewritten or sent.
        rendered.edits.retain(|edit| self.served_op(&edit.op));
        Some(std::borrow::Cow::Owned(rendered))
    }

    pub(super) fn edited(&self, cut: Option<u64>) -> lanes::Edited {
        let rendered = self.rendered_view(self.latest.as_ref());
        lanes::Edited::of(rendered.as_deref(), &self.index, cut)
    }
}
