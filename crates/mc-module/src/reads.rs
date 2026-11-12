//! Reading messages from the runner in full, page by page.

use cortexkit_role_compaction::read::{
    Detail, Entry, ReadName, ReadPage, ReadRequest, Select, SessionRef,
};

use crate::client::{ClientError, RunnerClient};

/// Effective read ceilings and the diagnostic window budget, fixed at Setup.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Limits {
    pub page_entries: Option<u64>,
    pub page_bytes: Option<u64>,
    pub select_max: Option<u64>,
    pub window_entries: Option<u64>,
    pub window_bytes: Option<u64>,
}

impl Limits {
    pub fn from_setup(limits: Option<&cortexkit_role_compaction::setup::Limits>) -> Self {
        let mut effective = Self::default();
        if let Some(limits) = limits {
            if let Some(page) = &limits.page {
                effective.page_entries = page.max_entries;
                effective.page_bytes = page.max_bytes;
            }
            effective.select_max = limits.select_max;
            if let Some(window) = &limits.window {
                effective.window_entries = window.entries;
                effective.window_bytes = window.bytes;
            }
        }
        effective
    }

    pub fn after(&self, after: Option<u64>, limit: Option<u64>, detail: Detail) -> ReadRequest {
        ReadRequest::new(
            Select::After {
                after_ordinal: after,
                limit: match (limit, self.page_entries) {
                    (Some(a), Some(b)) => Some(a.min(b)),
                    (a, b) => a.or(b),
                },
            },
            detail,
        )
        .with_max_bytes(self.page_bytes.unwrap_or(1 << 20).min(1 << 20))
    }
}

/// A continuing empty page cannot advance a transcript read.
pub fn check_page(
    session: &SessionRef,
    after: Option<u64>,
    page: &ReadPage,
) -> Result<(), ClientError> {
    if page.entries.is_empty() && page.next_after.is_some() {
        tracing::warn!("ck-mc: session {}: runner fault: empty read page after ordinal {:?} carries next_after {:?}", session.session, after, page.next_after);
        return Err(ClientError::new("runner fault: empty continuing read page"));
    }
    Ok(())
}

/// Read any number of names in full, sequentially, retaining reply order.
/// A failed request fails the whole read rather than returning partial entries.
pub async fn named<C: RunnerClient, N: Clone>(
    client: &C,
    session: &SessionRef,
    names: Vec<N>,
    limits: Limits,
    select: impl Fn(Vec<N>) -> Select,
) -> Result<Vec<Entry>, ClientError> {
    named_detail(client, session, names, limits, Detail::Full, select).await
}

pub async fn named_detail<C: RunnerClient, N: Clone>(
    client: &C,
    session: &SessionRef,
    names: Vec<N>,
    limits: Limits,
    detail: Detail,
    select: impl Fn(Vec<N>) -> Select,
) -> Result<Vec<Entry>, ClientError> {
    let mut entries = Vec::new();
    // These are ck-mc's own request sizes, not defaults imposed by the contract.
    let select_max = limits.select_max.unwrap_or(256).min(256) as usize;
    if select_max == 0 && !names.is_empty() {
        return Err(ClientError::new("runner permits no named reads"));
    }
    for chunk in names.chunks(select_max.max(1)) {
        let mut selection = select(chunk.to_vec());
        loop {
            let page = client
                .read(session, ReadRequest::new(selection.clone(), detail))
                .await?;
            let unanswered = page.unanswered.unwrap_or_default();
            if unanswered.is_empty() {
                entries.extend(page.entries);
                break;
            }
            let next = match &selection {
                Select::Mids { .. } => Select::Mids {
                    mids: unanswered
                        .iter()
                        .filter_map(|name| match name {
                            ReadName::Mid(mid) => Some(mid.clone()),
                            _ => None,
                        })
                        .collect(),
                },
                Select::Tags { .. } => Select::Tags {
                    tags: unanswered
                        .iter()
                        .filter_map(|name| match name {
                            ReadName::Tag(tag) => Some(*tag),
                            _ => None,
                        })
                        .collect(),
                },
                _ => return Err(ClientError::new("named read requires mids or tags")),
            };
            let asked = match &selection {
                Select::Mids { mids } => mids.len(),
                Select::Tags { tags } => tags.len(),
                _ => 0,
            };
            if page.entries.is_empty() && unanswered.len() >= asked {
                tracing::warn!("ck-mc: session {}: runner fault: named read answered nothing and left all names unanswered", session.session);
                return Err(ClientError::new(
                    "runner fault: named read made no progress",
                ));
            }
            entries.extend(page.entries);
            selection = next;
        }
    }
    Ok(entries)
}

/// The messages with ordinals from `from` up to, not including, `until`,
/// oldest first. `stop` ends the read early once it returns true for the
/// messages read so far, so a caller with a budget never reads further than
/// it can use.
pub async fn full_range<C: RunnerClient>(
    client: &C,
    session: &SessionRef,
    from: u64,
    until: u64,
    limits: Limits,
    mut stop: impl FnMut(&[Entry]) -> bool,
) -> Result<Vec<Entry>, String> {
    let mut entries = Vec::new();
    let mut after = from.checked_sub(1);
    while after.is_none_or(|ordinal| ordinal + 1 < until) {
        let request = limits.after(after, None, Detail::Full);
        let page = client
            .read(session, request)
            .await
            .map_err(|error| format!("session.read: {error:?}"))?;
        check_page(session, after, &page).map_err(|error| format!("session.read: {error:?}"))?;
        let next = page.next_after;
        for entry in page.entries {
            if entry.ordinal >= until {
                return Ok(entries);
            }
            entries.push(entry);
        }
        if next.is_none() || stop(&entries) {
            break;
        }
        after = next;
    }
    Ok(entries)
}

/// The messages holding these tag numbers, in full.
pub async fn by_tags<C: RunnerClient>(
    client: &C,
    session: &SessionRef,
    tags: Vec<u64>,
    limits: Limits,
) -> Result<Vec<Entry>, String> {
    named(client, session, tags, limits, |tags| Select::Tags { tags })
        .await
        .map_err(|error| format!("session.read: {error:?}"))
}

#[cfg(test)]
#[path = "reads_tests.rs"]
mod tests;
