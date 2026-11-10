//! Notes are outside the transcript: measured usage already includes the old
//! notes, so predictions need only the change since the previous notice.

use cortexkit_role_compaction::tokens::SurfaceTokens;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Notes {
    /// The previous notice's pending count, already included in measured usage.
    pub measured: Option<SurfaceTokens>,
    /// The newest notice's next-request count. Absence clears known pending notes.
    pub pending: Option<SurfaceTokens>,
    family: Option<String>,
}

impl Notes {
    pub fn is_empty(&self) -> bool {
        self.measured.is_none() && self.pending.is_none()
    }

    pub fn notice(&mut self, pending: Option<SurfaceTokens>, family: Option<&str>) {
        // Omitting the family supplies no new counts, but doesn't invalidate
        // the previous request's notes. Only a named family change does that.
        if let Some(family) = family {
            if self.family.as_deref() != Some(family) {
                self.pending = None;
            }
            self.family = Some(family.to_owned());
        }
        self.measured = self.pending;
        self.pending = pending.filter(|_| family.is_some());
    }

    /// Replace only the notes already included in a predicted fixed part.
    /// Missing or inexact counts cannot justify dropping transcript content.
    pub fn fixed_part(&self, fixed: f64) -> f64 {
        match (self.measured, self.pending) {
            (Some(old), Some(new)) if old.exact && new.exact => {
                (fixed + new.count as f64 - old.count as f64).max(0.0)
            }
            _ => fixed,
        }
    }
}
