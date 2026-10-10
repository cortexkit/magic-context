//! Bounded reads of a conversation's effective policy lineage.
//!
//! The effective lineage is every ancestor's policy rows through that
//! ancestor's cut, where a block's row in a nearer lineage hides older copies,
//! and a consumed tag number makes its part inactive. `all_parts` reads all of
//! it (a summary rebuild); every other read is bounded by the rows it names,
//! so a hook that keeps a summary does work proportional to what changed.
use super::{ancestry_tx, as_i64, parse, sql_json, ProviderError, ProviderPolicyPart};
use rusqlite::{params, Connection, OptionalExtension};
use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet};

/// A policy row that changed since the conversation's summary was taken.
#[derive(Clone, Debug)]
pub struct ProviderPolicyChange {
    pub block_id: String,
    /// The effective row when the summary was taken; `None` for a new row.
    pub previous: Option<ProviderPolicyPart>,
    /// The effective row now; `None` once it is outside the effective lineage.
    pub current: Option<ProviderPolicyPart>,
    /// A new row that hides an older lineage's copy of the same block.
    pub shadows: bool,
}

pub struct ProviderPolicyIndex<'c> {
    conn: &'c Connection,
    conv: String,
    /// The engine namespace whose consumed tag numbers deactivate parts.
    namespace: String,
    /// Leaf first: (lineage id, highest ordinal it contributes), ending with the
    /// legacy empty lineage.
    ancestry: Vec<(String, u64)>,
    rows_read: Cell<u64>,
}

const PART_COLUMNS: &str = "p.lineage_id,p.ordinal,p.policy_json,EXISTS(SELECT 1 FROM mc_provider_consumed_tags_v1 t JOIN mc_provider_conversations_v2 c ON c.engine_namespace=t.engine_namespace WHERE c.conv_key=p.conv_key AND t.tag_number=json_extract(p.policy_json,'$.tag_number'))";

impl<'c> ProviderPolicyIndex<'c> {
    pub(crate) fn new(conn: &'c Connection, conv: &str, lineage: &str) -> rusqlite::Result<Self> {
        let rows = ancestry_tx(conn, conv, lineage)?;
        // Rows migrated from the single-record format carry an empty lineage id
        // and precede the root lineage's first ordinal.
        let legacy = rows
            .last()
            .map_or(u64::MAX, |(root, _)| root.first_ordinal.saturating_sub(1));
        let ancestry = rows
            .into_iter()
            .map(|(row, cut)| (row.lineage_id, cut))
            .chain(std::iter::once((String::new(), legacy)))
            .collect();
        let namespace = conn
            .query_row(
                "SELECT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key=?1",
                [conv],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or_default();
        Ok(Self {
            conn,
            conv: conv.to_string(),
            namespace,
            ancestry,
            rows_read: Cell::new(0),
        })
    }

    /// Leaf first: each lineage and the highest ordinal it contributes, ending
    /// with the legacy empty lineage.
    pub fn ancestry(&self) -> &[(String, u64)] {
        &self.ancestry
    }

    /// The conversation's engine namespace. Consumed tag numbers are recorded
    /// per namespace, so a summary is valid only for the namespace it was taken in.
    pub fn engine_namespace(&self) -> &str {
        &self.namespace
    }

    /// Policy rows read through this index so far. Tests use it to show that a
    /// hook's reads do not grow with the session.
    pub fn rows_read(&self) -> u64 {
        self.rows_read.get()
    }

    fn count(&self, rows: usize) {
        self.rows_read.set(self.rows_read.get() + rows as u64);
    }

    fn depth(&self, lineage: &str) -> Option<usize> {
        self.ancestry.iter().position(|(id, _)| id == lineage)
    }

    /// Whether a nearer lineage than `depth` holds its own row for the block.
    fn shadowed(&self, depth: usize, block_id: &str) -> rusqlite::Result<bool> {
        for (lineage, _) in &self.ancestry[..depth] {
            let held: bool = self.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM mc_provider_policy_parts_v1 WHERE conv_key=?1 AND lineage_id=?2 AND block_id=?3)",
                params![self.conv, lineage, block_id],
                |r| r.get(0),
            )?;
            self.count(1);
            if held {
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// The effective part for a raw row, or `None` if the row is outside the
    /// effective lineage.
    fn effective(
        &self,
        lineage: &str,
        ordinal: u64,
        raw: &str,
        consumed: bool,
    ) -> rusqlite::Result<Option<ProviderPolicyPart>> {
        let Some(depth) = self.depth(lineage) else {
            return Ok(None);
        };
        if ordinal > self.ancestry[depth].1 {
            return Ok(None);
        }
        let mut part: ProviderPolicyPart = serde_json::from_str(raw).map_err(sql_json)?;
        if self.shadowed(depth, &part.block_id)? {
            return Ok(None);
        }
        if consumed {
            part.active = false;
        }
        Ok(Some(part))
    }

    fn select(
        &self,
        predicate: &str,
        parameters: impl rusqlite::Params,
        limit: Option<usize>,
    ) -> rusqlite::Result<Option<Vec<ProviderPolicyPart>>> {
        let limit_sql = limit.map_or(String::new(), |n| format!(" LIMIT {}", n + 1));
        let mut q = self.conn.prepare_cached(&format!(
            "SELECT {PART_COLUMNS} FROM mc_provider_policy_parts_v1 p WHERE p.conv_key=?1 AND {predicate}{limit_sql}"
        ))?;
        let rows = q
            .query_map(parameters, |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, u64>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, bool>(3)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        self.count(rows.len());
        if limit.is_some_and(|n| rows.len() > n) {
            return Ok(None);
        }
        let mut parts = Vec::new();
        for (lineage, ordinal, raw, consumed) in rows {
            if let Some(part) = self.effective(&lineage, ordinal, &raw, consumed)? {
                parts.push(part);
            }
        }
        Ok(Some(parts))
    }

    /// Every effective part, ordered by ordinal then block index.
    pub fn all_parts(&self) -> Result<Vec<ProviderPolicyPart>, ProviderError> {
        let mut parts = BTreeMap::new();
        for (lineage, cut) in &self.ancestry {
            let mut q = self.conn.prepare_cached(&format!("SELECT {PART_COLUMNS} FROM mc_provider_policy_parts_v1 p WHERE p.conv_key=?1 AND p.lineage_id=?2 AND p.ordinal<=?3 ORDER BY p.ordinal,p.block_id"))?;
            let rows = q
                .query_map(
                    params![self.conv, lineage, as_i64((*cut).min(i64::MAX as u64))?],
                    |r| Ok((r.get::<_, String>(2)?, r.get::<_, bool>(3)?)),
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            self.count(rows.len());
            for (raw, consumed) in rows {
                let mut part: ProviderPolicyPart = serde_json::from_str(&raw).map_err(sql_json)?;
                if consumed {
                    part.active = false;
                }
                parts.entry(part.block_id.clone()).or_insert(part);
            }
        }
        let mut parts = parts.into_values().collect::<Vec<_>>();
        parts.sort_by(|a, b| {
            a.ordinal
                .cmp(&b.ordinal)
                .then_with(|| a.block_index.cmp(&b.block_index))
        });
        Ok(parts)
    }

    /// The stored summary, if any.
    pub fn summary(&self) -> Result<Option<String>, ProviderError> {
        Ok(self
            .conn
            .query_row(
                "SELECT summary_json FROM mc_provider_policy_summaries_v1 WHERE conv_key=?1",
                [&self.conv],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// Rows changed since the summary was taken, or `None` when there are more
    /// than `cap` (a rebuild is then cheaper than replaying them).
    pub fn changes(&self, cap: usize) -> Result<Option<Vec<ProviderPolicyChange>>, ProviderError> {
        let mut q = self.conn.prepare_cached(&format!("SELECT d.lineage_id,d.block_id,d.previous_json,d.previous_consumed,p.ordinal,p.policy_json,EXISTS(SELECT 1 FROM mc_provider_consumed_tags_v1 t JOIN mc_provider_conversations_v2 c ON c.engine_namespace=t.engine_namespace WHERE c.conv_key=d.conv_key AND t.tag_number=json_extract(p.policy_json,'$.tag_number')) FROM mc_provider_policy_changes_v1 d LEFT JOIN mc_provider_policy_parts_v1 p ON p.conv_key=d.conv_key AND p.lineage_id=d.lineage_id AND p.block_id=d.block_id WHERE d.conv_key=?1 LIMIT {}", cap + 1))?;
        let rows = q
            .query_map([&self.conv], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, bool>(3)?,
                    r.get::<_, Option<u64>>(4)?,
                    r.get::<_, Option<String>>(5)?,
                    r.get::<_, bool>(6)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        self.count(rows.len());
        if rows.len() > cap {
            return Ok(None);
        }
        let mut changes = Vec::new();
        for (lineage, block_id, previous, previous_consumed, ordinal, current, consumed) in rows {
            let Some(depth) = self.depth(&lineage) else {
                continue;
            };
            let current = match (ordinal, current) {
                (Some(ordinal), Some(raw)) => self.effective(&lineage, ordinal, &raw, consumed)?,
                _ => None,
            };
            let previous = match previous {
                Some(raw) => {
                    let mut part: ProviderPolicyPart =
                        serde_json::from_str(&raw).map_err(sql_json)?;
                    if part.ordinal > self.ancestry[depth].1
                        || self.shadowed(depth, &part.block_id)?
                    {
                        None
                    } else {
                        if previous_consumed {
                            part.active = false;
                        }
                        Some(part)
                    }
                }
                None => None,
            };
            let mut shadows = false;
            if previous.is_none() && current.is_some() {
                for (older, _) in &self.ancestry[depth + 1..] {
                    let held: bool = self.conn.query_row(
                        "SELECT EXISTS(SELECT 1 FROM mc_provider_policy_parts_v1 WHERE conv_key=?1 AND lineage_id=?2 AND block_id=?3)",
                        params![self.conv, older, block_id],
                        |r| r.get(0),
                    )?;
                    self.count(1);
                    shadows |= held;
                }
            }
            if previous.is_some() || current.is_some() {
                changes.push(ProviderPolicyChange {
                    block_id,
                    previous,
                    current,
                    shadows,
                });
            }
        }
        Ok(Some(changes))
    }

    /// Effective parts carrying any of these tag numbers.
    pub fn parts_with_tag_numbers(
        &self,
        numbers: &BTreeSet<i64>,
    ) -> Result<Vec<ProviderPolicyPart>, ProviderError> {
        let mut parts = Vec::new();
        for number in numbers {
            parts.extend(
                self.select(
                    "json_extract(p.policy_json,'$.tag_number')=?2",
                    params![self.conv, number],
                    None,
                )?
                .unwrap_or_default(),
            );
        }
        Ok(parts)
    }

    /// Effective parts whose tag number is in `[from, before)`, in tag order, or
    /// `None` when more than `cap` rows hold numbers in that range.
    pub fn parts_with_tag_range(
        &self,
        from: i64,
        before: i64,
        cap: usize,
    ) -> Result<Option<Vec<ProviderPolicyPart>>, ProviderError> {
        if from >= before {
            return Ok(Some(Vec::new()));
        }
        Ok(self.select(
            "json_extract(p.policy_json,'$.tag_number')>=?2 AND json_extract(p.policy_json,'$.tag_number')<?3 ORDER BY json_extract(p.policy_json,'$.tag_number'),p.block_id",
            params![self.conv, from, before],
            Some(cap),
        )?)
    }

    /// Effective parts belonging to any of these tool arcs.
    pub fn parts_with_arcs(
        &self,
        arcs: &BTreeSet<String>,
    ) -> Result<Vec<ProviderPolicyPart>, ProviderError> {
        let mut parts = Vec::new();
        for arc in arcs {
            parts.extend(
                self.select(
                    "json_extract(p.policy_json,'$.arc_id')=?2",
                    params![self.conv, arc],
                    None,
                )?
                .unwrap_or_default(),
            );
        }
        Ok(parts)
    }

    /// Effective parts of these messages. Block ids are `{mid}#{index}` (the
    /// header is `{mid}#@message`), so one identity-index range covers a message.
    pub fn parts_for_mids(
        &self,
        mids: &BTreeSet<String>,
    ) -> Result<Vec<ProviderPolicyPart>, ProviderError> {
        let mut parts = Vec::new();
        for mid in mids {
            parts.extend(
                self.select(
                    "p.block_id>=?2 AND p.block_id<?3",
                    params![self.conv, format!("{mid}#"), format!("{mid}$")],
                    None,
                )?
                .unwrap_or_default(),
            );
        }
        Ok(parts)
    }

    /// The effective message header with the highest ordinal below `ordinal`.
    pub fn previous_header(
        &self,
        ordinal: u64,
    ) -> Result<Option<ProviderPolicyPart>, ProviderError> {
        let mut best: Option<ProviderPolicyPart> = None;
        for (depth, (lineage, cut)) in self.ancestry.iter().enumerate() {
            let below = ordinal.min(cut.saturating_add(1));
            let mut q = self.conn.prepare_cached(&format!("SELECT {PART_COLUMNS} FROM mc_provider_policy_parts_v1 p WHERE p.conv_key=?1 AND p.lineage_id=?2 AND p.ordinal<?3 ORDER BY p.ordinal DESC"))?;
            let mut rows = q.query(params![self.conv, lineage, as_i64(below)?])?;
            while let Some(row) = rows.next()? {
                self.count(1);
                let row_ordinal: u64 = row.get(1)?;
                if best.as_ref().is_some_and(|b| b.ordinal > row_ordinal) {
                    break;
                }
                let raw: String = row.get(2)?;
                let part: ProviderPolicyPart = serde_json::from_str(&raw).map_err(sql_json)?;
                if part.kind != "header" || self.shadowed(depth, &part.block_id)? {
                    continue;
                }
                let mut part = part;
                if row.get::<_, bool>(3)? {
                    part.active = false;
                }
                if best.as_ref().is_none_or(|b| part.ordinal >= b.ordinal) {
                    best = Some(part);
                }
                break;
            }
        }
        Ok(best)
    }
}

/// Persist a summary and forget the changes it now accounts for.
pub(crate) fn save_policy_summary_tx(
    conn: &Connection,
    conv: &str,
    summary: &str,
) -> rusqlite::Result<()> {
    parse(summary)?;
    conn.execute(
        "INSERT INTO mc_provider_policy_summaries_v1 VALUES (?1,?2,json_extract(?1,'$[1]')) ON CONFLICT(conv_key) DO UPDATE SET summary_json=excluded.summary_json",
        params![conv, summary],
    )?;
    conn.execute(
        "DELETE FROM mc_provider_policy_changes_v1 WHERE conv_key=?1",
        [conv],
    )?;
    Ok(())
}

/// Drop a summary so the next hook rebuilds it; used before bulk rewrites so
/// the change triggers record nothing.
pub(crate) fn drop_policy_summary_tx(conn: &Connection, conv: &str) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM mc_provider_policy_summaries_v1 WHERE conv_key=?1",
        [conv],
    )?;
    conn.execute(
        "DELETE FROM mc_provider_policy_changes_v1 WHERE conv_key=?1",
        [conv],
    )?;
    Ok(())
}
