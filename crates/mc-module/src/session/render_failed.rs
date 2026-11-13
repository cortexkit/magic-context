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
    failed_edits: Option<String>,
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

    pub(super) fn recovery(&self) -> (bool, Option<u64>) {
        (self.repair_pending, self.retry_version)
    }

    pub(super) fn restore_recovery(&mut self, recovery: (bool, Option<u64>)) {
        (self.repair_pending, self.retry_version) = recovery;
    }

    pub(super) fn recorded(&mut self, view: &View) {
        if self.repair_pending {
            self.retry_version.get_or_insert(view.version);
        } else if !self.same_failed_edits(view) {
            // Only changed edits end the retry chain. A new version alone
            // cannot make a host render the same failed operations.
            self.retry_version = None;
        }
    }

    pub(super) fn held(&mut self, version: u64) {
        if self.retry_version == Some(version) {
            self.repair_pending = false;
        }
    }

    fn same_failed_edits(&self, view: &View) -> bool {
        self.failed_edits.as_ref() == Some(&edit_fingerprint(view))
    }
}

/// Compare rendered operations, not view versions or edit provenance. The
/// digest keeps the durable retry guard small even for a large accepted view.
fn edit_fingerprint(view: &View) -> String {
    use sha2::{Digest, Sha256};
    let ops: Vec<_> = view.edits.iter().map(|edit| &edit.op).collect();
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&ops).expect("view edits serialize"))
    )
}

impl Session {
    pub(super) fn recovery_in_flight(&self) -> bool {
        self.render_failed.repair_pending
            && self.render_failed.retry_version.is_some_and(|version| {
                self.unconfirmed
                    .iter()
                    .any(|pending| pending.view.version == version)
            })
    }

    /// Relief estimates and sealing must agree about which requested or
    /// prospective operations the runner can render. A banned replacement
    /// gives no relief, but a whole-part drop may still be allowed.
    pub(super) fn renderable_covered(
        &self,
        ops: &[EditOp],
        covered: &[lanes::PartKey],
    ) -> Vec<lanes::PartKey> {
        covered
            .iter()
            .filter(|(mid, part)| {
                ops.iter().any(|op| {
                    !self.render_failed.excludes(op)
                        && match op {
                            EditOp::Drop { mid: m, part: p } => {
                                m == mid && p.as_ref().is_none_or(|p| p == part)
                            }
                            EditOp::Replace {
                                mid: m, part: p, ..
                            } => m == mid && p == part,
                            _ => false,
                        }
                })
            })
            .cloned()
            .collect()
    }

    /// Record rendering failures without treating an accepted view as refused.
    pub(super) fn take_render_failures(&mut self, events: &[Event]) {
        // Every report must inspect the same transcript. Resetting the index
        // for an older report must not hide a later report's reasoning part.
        self.record_failed_reasoning(events);
        let mut reread = false;
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
                }
                reread = true;
            }
            // Recompute served-part accounting even though the accepted view
            // and its checksum have not changed.
            self.app_projection.render_changed();
        }
        if reread {
            self.index = Index::starting_at(self.cut.unwrap_or(1));
            self.index_ready = false;
        }
    }

    fn record_failed_reasoning(&mut self, events: &[Event]) {
        // The report names only the message, not the failing edit.
        // Conservatively treat any signed-reasoning drop already in that
        // view on this message as the failed edit.
        let mut holds = Vec::new();
        for event in events {
            let Event::ViewRefused {
                version,
                refusal:
                    ViewRefusal::RenderFailed {
                        mid: Some(mid),
                        part: None,
                        ..
                    },
            } = event
            else {
                continue;
            };
            let view = self
                .latest
                .iter()
                .chain(self.unconfirmed.iter().map(|pending| &pending.view))
                .chain(
                    self.unconfirmed
                        .iter()
                        .filter_map(|pending| pending.before.latest.as_ref()),
                )
                .find(|view| view.version == *version);
            if let Some(view) = view {
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
                            holds.push((m.clone(), part.clone()));
                        }
                    }
                }
            }
        }
        self.render_failed.reasoning_drops.extend(holds);
    }

    /// Adoption may replace an older local view in this very notice. Only
    /// after it finishes can the report describe the view the runner serves.
    pub(super) fn settle_render_failures(
        &mut self,
        events: &[Event],
        applied: Option<&AppliedView>,
    ) -> bool {
        self.record_failed_reasoning(events);
        let mut repeat = false;
        for event in events {
            let Event::ViewRefused {
                version,
                refusal: ViewRefusal::RenderFailed { part: None, .. },
            } = event
            else {
                continue;
            };
            if applied.is_some_and(|view| view.version == *version) {
                self.render_failed.no_view = Some(*version);
                self.render_failed.failed_edits = self
                    .latest
                    .as_ref()
                    .filter(|view| view.version == *version)
                    .map(edit_fingerprint);
                repeat |= self.render_failed.retry_version == Some(*version);
                self.render_failed.repair_pending = !repeat;
                self.app_projection.render_changed();
            }
        }
        repeat
    }

    pub(super) fn repeats_failed_edits(&self, view: &View) -> bool {
        !self.render_failed.repair_pending && self.render_failed.same_failed_edits(view)
    }

    pub(super) fn retire_banned_queued(&mut self) {
        let banned: Vec<_> = self
            .queued
            .iter()
            .filter(|(mid, _)| self.render_failed.messages.contains(mid))
            .cloned()
            .collect();
        for key in banned {
            self.queued.remove(&key);
            self.app_projection.dirty.insert(key.0.clone());
            if self.failed_parts.insert(key.clone()) {
                tracing::warn!("ck-mc: session {}: queued drop mid={:?} part={:?} cannot render while its message is excluded; marking the part failed, not landed", self.key.session, key.0, key.1);
            }
        }
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
