//! Pure served-occurrence admission. Callers supply the retained replay view; this module
//! neither applies edits nor records held work or release obligations.
use std::collections::HashSet;

#[derive(Debug, Clone)]
pub struct Part {
    pub retained: bool,
    pub anchor: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Message {
    pub id: Option<String>,
    pub real_user: bool,
    pub parts: Vec<Part>,
}

#[derive(Debug, Clone, Copy)]
pub enum BlockPos {
    Whole,
    Index(usize),
}

#[derive(Debug, Clone, Copy)]
pub enum EditCoord<'a> {
    Prefix,
    Message {
        mid: Option<&'a str>,
        block: BlockPos,
    },
    Append {
        after_mid: Option<&'a str>,
    },
}

#[derive(Debug)]
pub enum Frame {
    None,
    Boundary {
        mid: Option<String>,
        anchor: Option<String>,
        tail: HashSet<String>,
    },
}

pub struct EditAdmission {
    pub frame: Frame,
    prefix_bound: bool,
    boundary_parts: Vec<Part>,
}

fn stable(id: Option<&str>) -> Option<&str> {
    id.filter(|id| !id.is_empty() && !id.starts_with("pi-msg-") && !id.starts_with("synth-user-"))
}

impl EditAdmission {
    /// Visit only the tail through its last retained block, or through the real user request.
    pub fn new(messages: &[Message], prefix_bound: bool) -> Self {
        Self::from_reverse(messages.iter().rev().cloned(), prefix_bound)
    }

    /// A lazy replay adapter avoids cloning messages before the boundary is reached.
    pub fn from_reverse(messages: impl Iterator<Item = Message>, prefix_bound: bool) -> Self {
        let mut tail = HashSet::new();
        let mut frame = Frame::None;
        let mut boundary_parts = Vec::new();
        for message in messages {
            if message.real_user {
                break;
            }
            let id = stable(message.id.as_deref()).map(str::to_owned);
            if let Some(part) = message.parts.iter().rev().find(|p| p.retained) {
                frame = Frame::Boundary {
                    mid: id,
                    anchor: part.anchor.clone(),
                    tail,
                };
                boundary_parts = message.parts;
                break;
            }
            if let Some(id) = id {
                tail.insert(id);
            }
        }
        Self {
            frame,
            prefix_bound,
            boundary_parts,
        }
    }

    pub fn admit(&self, coord: EditCoord<'_>) -> bool {
        if !self.prefix_bound {
            return true;
        }
        let Frame::Boundary { mid, anchor, tail } = &self.frame else {
            return true;
        };
        let id = match coord {
            EditCoord::Prefix => return false,
            EditCoord::Message { mid, .. } => stable(mid),
            EditCoord::Append { after_mid } => stable(after_mid),
        };
        let Some(id) = id else {
            return false;
        };
        if tail.contains(id) {
            return true;
        }
        if mid.as_deref() != Some(id) {
            return false;
        }
        match coord {
            EditCoord::Append { .. } => true,
            EditCoord::Message {
                block: BlockPos::Index(index),
                ..
            } => anchor
                .as_ref()
                .and_then(|anchor| {
                    self.boundary_parts
                        .iter()
                        .rposition(|p| p.anchor.as_ref() == Some(anchor))
                })
                .is_some_and(|boundary| index > boundary),
            _ => false,
        }
    }

    /// A parallel batch or folded carrier is admitted only when all its source positions are.
    pub fn admit_compound(&self, sources: &[EditCoord<'_>]) -> bool {
        !sources.is_empty() && sources.iter().all(|coord| self.admit(*coord))
    }
}
