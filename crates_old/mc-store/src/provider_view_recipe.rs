//! View recipes retain source lineage, ordinal and message IDs rather than
//! duplicate native history bodies. Resolution checks source lifetime and
//! bounds the number and size of ancestor recipes.
use crate::provider_log::{ProviderError, ProviderMessage};
use crate::{McStore, ProviderSessionKey};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

#[cfg(test)]
#[path = "provider_view_recipe_tests.rs"]
mod tests;

pub const MAX_VIEW_BASE_DEPTH: usize = 16;
pub const MAX_VIEW_ANCESTOR_BYTES: usize = 8 * 1024 * 1024;

/// Key in a conversation's `hook_counters_json`: an object mapping each lineage
/// ID to the view version named in that lineage's newest step answer.
///
/// The conversation keeps one step receipt, so when two lineages of one
/// conversation (a fork and its parent) step in turn, the receipt names only
/// the last one. A host reads a view right after the step that answered it,
/// so the version each lineage was last answered must stay readable, and kept
/// by pruning, until that same lineage steps again. The map holds at most one
/// version per lineage. An entry counts only while its lineage row is still
/// held, so removing a lineage releases its view.
pub const LINEAGE_ANSWERED_VIEWS: &str = "lineage_answered_views";

/// Record in parsed hook counters the view a lineage's step answer named.
/// `None` (an answer naming no view) clears the lineage's entry: its earlier
/// answer is superseded by this step.
pub fn record_lineage_answered_view(counters: &mut Value, lineage_id: &str, version: Option<u64>) {
    let Some(fields) = counters.as_object_mut() else {
        return;
    };
    let entry = fields
        .entry(LINEAGE_ANSWERED_VIEWS)
        .or_insert_with(|| Value::Object(Default::default()));
    if !entry.is_object() {
        *entry = Value::Object(Default::default());
    }
    let map = entry.as_object_mut().expect("object");
    match version {
        Some(version) => {
            map.insert(lineage_id.to_string(), Value::from(version));
        }
        None => {
            map.remove(lineage_id);
        }
    }
}

/// The per-lineage answered views in parsed hook counters whose lineage is
/// still held by the conversation.
fn lineage_answered_views_tx(
    conn: &rusqlite::Connection,
    conv: &str,
    counters: &Value,
) -> Result<BTreeMap<String, u64>, ProviderError> {
    let mut held = conn.prepare_cached(
        "SELECT EXISTS(SELECT 1 FROM mc_provider_lineages_v1 WHERE conv_key=?1 AND lineage_id=?2)",
    )?;
    let mut answered = BTreeMap::new();
    let Some(map) = counters
        .get(LINEAGE_ANSWERED_VIEWS)
        .and_then(Value::as_object)
    else {
        return Ok(answered);
    };
    for (lineage, version) in map {
        let Some(version) = version.as_u64() else {
            continue;
        };
        if held.query_row(params![conv, lineage], |r| r.get::<_, bool>(0))? {
            answered.insert(lineage.clone(), version);
        }
    }
    Ok(answered)
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProviderViewSegment {
    Synthetic {
        slot: String,
    },
    NativeRange {
        source_lineage_id: String,
        from: u64,
        to: u64,
        first_mid: String,
        last_mid: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ProviderViewTreatment {
    pub source_lineage_id: String,
    pub mid: String,
    pub ordinal: u64,
    pub block_index: i64,
    pub block_id: String,
    pub patch: Option<Value>,
}

#[derive(Clone, Debug)]
pub struct ProviderViewRecipe {
    pub version: u64,
    pub lineage_id: String,
    pub range_from: u64,
    pub range_to: u64,
    pub base_version: Option<u64>,
    pub policy_cut_id: Option<u64>,
    pub metadata: Value,
    pub segments: Vec<ProviderViewSegment>,
    pub synthetic: BTreeMap<String, Value>,
    pub treatments: Vec<ProviderViewTreatment>,
    pub serializer_profile: String,
    pub render_key: String,
    pub tokenizer_key: String,
    pub state: String,
}

/// Replayable view versions and the native `(lineage, from, to)` ordinal
/// ranges they stream, taken from one transaction.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProviderViewSourceRoots {
    pub versions: BTreeSet<u64>,
    pub sources: BTreeSet<(String, u64, u64)>,
}

#[derive(Clone, Debug)]
pub struct ProviderResolvedView {
    pub recipe: ProviderViewRecipe,
    pub messages: Vec<(String, ProviderMessage)>,
    pub depth: usize,
    pub ancestor_bytes: usize,
}

fn invalid(message: impl ToString) -> ProviderError {
    ProviderError::Transient(message.to_string())
}

fn load_recipe_tx(
    conn: &rusqlite::Connection,
    conv: &str,
    version: u64,
) -> Result<Option<ProviderViewRecipe>, ProviderError> {
    let row=conn.query_row("SELECT lineage_id,range_from,range_to,base_version,policy_cut_id,view_meta_json,sequence_json,new_head_history_bytes,serializer_profile,render_key,tokenizer_key,state FROM mc_provider_views_v2 WHERE conv_key=?1 AND version=?2",params![conv,version],|r|Ok((r.get::<_,String>(0)?,r.get::<_,u64>(1)?,r.get::<_,u64>(2)?,r.get::<_,Option<u64>>(3)?,r.get::<_,u64>(4)?,r.get::<_,String>(5)?,r.get::<_,String>(6)?,r.get::<_,Option<Vec<u8>>>(7)?,r.get::<_,String>(8)?,r.get::<_,String>(9)?,r.get::<_,String>(10)?,r.get::<_,String>(11)?))).optional()?;
    let Some((
        lineage_id,
        range_from,
        range_to,
        base_version,
        cut,
        metadata,
        segments,
        synthetic,
        serializer_profile,
        render_key,
        tokenizer_key,
        state,
    )) = row
    else {
        return Ok(None);
    };
    let mut q=conn.prepare_cached("SELECT source_lineage_id,mid,ordinal,block_index,block_id,patch_json FROM mc_provider_view_overrides_v1 WHERE conv_key=?1 AND version=?2 ORDER BY source_lineage_id,mid,block_index")?;
    let mut treatments = Vec::new();
    for row in q.query_map(params![conv, version], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, u64>(2)?,
            r.get::<_, i64>(3)?,
            r.get::<_, String>(4)?,
            r.get::<_, Option<String>>(5)?,
        ))
    })? {
        let (source_lineage_id, mid, ordinal, block_index, block_id, patch) = row?;
        treatments.push(ProviderViewTreatment {
            source_lineage_id,
            mid,
            ordinal,
            block_index,
            block_id,
            patch: patch
                .map(|raw| serde_json::from_str(&raw).map_err(invalid))
                .transpose()?,
        });
    }
    Ok(Some(ProviderViewRecipe {
        version,
        lineage_id,
        range_from,
        range_to,
        base_version,
        policy_cut_id: Some(cut),
        metadata: serde_json::from_str(&metadata).map_err(invalid)?,
        segments: serde_json::from_str(&segments).map_err(invalid)?,
        synthetic: synthetic
            .map(|raw| serde_json::from_slice(&raw).map_err(invalid))
            .transpose()?
            .unwrap_or_default(),
        treatments,
        serializer_profile,
        render_key,
        tokenizer_key,
        state,
    }))
}

fn resolve_tx(
    conn: &rusqlite::Connection,
    conv: &str,
    version: u64,
    load_messages: bool,
) -> Result<Option<ProviderResolvedView>, ProviderError> {
    let Some(mut recipe) = load_recipe_tx(conn, conv, version)? else {
        return Ok(None);
    };
    let mut synthetic = recipe.synthetic.clone();
    let mut treatments = BTreeMap::new();
    for treatment in &recipe.treatments {
        treatments.insert(
            (
                treatment.source_lineage_id.clone(),
                treatment.mid.clone(),
                treatment.block_index,
            ),
            treatment.clone(),
        );
    }
    let mut next = recipe.base_version;
    let mut depth = 0;
    let mut ancestor_bytes = 0;
    while let Some(version) = next {
        depth += 1;
        if depth > MAX_VIEW_BASE_DEPTH {
            return Err(invalid("provider view inheritance depth exceeds bound"));
        }
        let base = load_recipe_tx(conn, conv, version)?
            .ok_or_else(|| invalid("provider view base is missing"))?;
        ancestor_bytes += serde_json::to_vec(&base.synthetic).map_err(invalid)?.len()
            + serde_json::to_vec(&base.treatments).map_err(invalid)?.len()
            + serde_json::to_vec(&base.segments).map_err(invalid)?.len()
            + base.metadata.to_string().len();
        if ancestor_bytes > MAX_VIEW_ANCESTOR_BYTES {
            return Err(invalid("provider view inheritance bytes exceed bound"));
        }
        for (slot, value) in base.synthetic {
            synthetic.entry(slot).or_insert(value);
        }
        for treatment in base.treatments {
            treatments
                .entry((
                    treatment.source_lineage_id.clone(),
                    treatment.mid.clone(),
                    treatment.block_index,
                ))
                .or_insert(treatment);
        }
        next = base.base_version;
    }
    recipe.synthetic = synthetic
        .into_iter()
        .filter(|(slot, _)| {
            recipe
                .segments
                .iter()
                .any(|s| matches!(s,ProviderViewSegment::Synthetic {slot:needed} if slot==needed))
        })
        .collect();
    recipe.treatments=treatments.into_values().filter(|t|t.patch.is_some() && recipe.segments.iter().any(|s|matches!(s,ProviderViewSegment::NativeRange {source_lineage_id,from,to,..} if &t.source_lineage_id==source_lineage_id && t.ordinal>=*from && t.ordinal<*to))).collect();
    let mut messages = Vec::new();
    if load_messages {
        for segment in &recipe.segments {
            if let ProviderViewSegment::NativeRange {
                source_lineage_id,
                from,
                to,
                first_mid,
                last_mid,
            } = segment
            {
                let mut q=conn.prepare_cached("SELECT ordinal,mid,message_bytes FROM mc_provider_messages_v1 WHERE conv_key=?1 AND lineage_id=?2 AND ordinal>=?3 AND ordinal<?4 ORDER BY ordinal")?;
                let rows = q
                    .query_map(params![conv, source_lineage_id, from, to], |r| {
                        Ok(ProviderMessage {
                            ordinal: r.get(0)?,
                            mid: r.get(1)?,
                            message_bytes: r.get(2)?,
                        })
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                if rows.first().map(|m| m.mid.as_str()) != Some(first_mid)
                    || rows.last().map(|m| m.mid.as_str()) != Some(last_mid)
                    || rows.len() as u64 != to.saturating_sub(*from)
                {
                    return Err(invalid("provider view native source is missing or changed"));
                }
                messages.extend(rows.into_iter().map(|row| (source_lineage_id.clone(), row)));
            }
        }
    }
    Ok(Some(ProviderResolvedView {
        recipe,
        messages,
        depth,
        ancestor_bytes,
    }))
}

impl McStore {
    pub fn provider_native_view_metadata(
        &self,
        key: &ProviderSessionKey,
        version: u64,
    ) -> Result<Option<Value>, ProviderError> {
        self.inner.with_conn(|conn| {
            let raw:Option<String>=conn.query_row("SELECT view_meta_json FROM mc_provider_views_v2 WHERE conv_key=?1 AND version=?2",
                params![key.conversation_key(),version],|row|row.get(0)).optional()?;
            raw.map(|raw|serde_json::from_str(&raw).map_err(|_|rusqlite::Error::InvalidQuery)).transpose()
        }).map_err(|error|ProviderError::Storage(error.into()))
    }
    /// The view version each still-held lineage of the conversation was named
    /// in its newest step answer. See `LINEAGE_ANSWERED_VIEWS`.
    pub fn provider_lineage_answered_views(
        &self,
        key: &ProviderSessionKey,
    ) -> Result<BTreeMap<String, u64>, ProviderError> {
        let mut refusal = None;
        self.inner
            .with_conn(|conn| {
                let tx = conn.unchecked_transaction()?;
                let conv = key.conversation_key();
                let read = || -> Result<BTreeMap<String, u64>, ProviderError> {
                    let counters: Option<String> = tx
                        .query_row(
                            "SELECT hook_counters_json FROM mc_provider_conversations_v2 WHERE conv_key=?1",
                            [&conv],
                            |r| r.get(0),
                        )
                        .optional()?;
                    let Some(counters) = counters else {
                        return Ok(BTreeMap::new());
                    };
                    let counters: Value = serde_json::from_str(&counters).map_err(invalid)?;
                    lineage_answered_views_tx(&tx, &conv, &counters)
                };
                let answered = read().map_err(|e| {
                    refusal = Some(e);
                    rusqlite::Error::InvalidQuery
                })?;
                tx.commit()?;
                Ok(answered)
            })
            .map_err(|e| refusal.unwrap_or_else(|| ProviderError::Storage(e.into())))
    }

    /// List stored model-view recipe versions without decoding native message bodies.
    pub fn load_provider_view_recipe_versions(
        &self,
        key: &ProviderSessionKey,
    ) -> Result<Vec<u64>, ProviderError> {
        self.inner
            .with_conn(|conn| {
                let mut query = conn.prepare_cached(
                    "SELECT version FROM mc_provider_views_v2 WHERE conv_key=?1 ORDER BY version",
                )?;
                let versions = query
                    .query_map([key.conversation_key()], |row| row.get(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(versions)
            })
            .map_err(|error| ProviderError::Storage(error.into()))
    }

    /// Prune with roots read in the same fenced transaction as the deletion, so
    /// an acknowledgement, receipt or record write cannot slip between the
    /// snapshot of references and the removal of the recipes they name.
    pub fn prune_provider_views_from_conversation(
        &self,
        key: &ProviderSessionKey,
    ) -> Result<usize, ProviderError> {
        let mut refusal = None;
        self.inner
            .with_conn_fenced(|conn| {
                let conv = key.conversation_key();
                let prune = || -> Result<usize, ProviderError> {
                    let roots = view_roots_tx(conn, &conv)?;
                    if roots.is_empty() {
                        return Ok(0);
                    }
                    prune_tx(conn, &conv, &roots)
                };
                prune().map_err(|e| {
                    refusal = Some(e);
                    rusqlite::Error::InvalidQuery
                })
            })
            .map_err(|e| refusal.unwrap_or_else(|| ProviderError::Storage(e.into())))
    }

    /// One read snapshot of the view versions that can still be replayed and the
    /// stored native message ranges those views read their bytes from. Any later
    /// rewrite of stored native messages must leave every row in `sources`
    /// unchanged while a version in `versions` can still be served.
    pub fn provider_view_source_roots(
        &self,
        key: &ProviderSessionKey,
    ) -> Result<ProviderViewSourceRoots, ProviderError> {
        let mut refusal = None;
        self.inner
            .with_conn(|conn| {
                let tx = conn.unchecked_transaction()?;
                let conv = key.conversation_key();
                let read = || -> Result<ProviderViewSourceRoots, ProviderError> {
                    let versions = view_roots_tx(&tx, &conv)?;
                    let mut sources = BTreeSet::new();
                    for version in &versions {
                        if let Some(recipe) = load_recipe_tx(&tx, &conv, *version)? {
                            for segment in recipe.segments {
                                if let ProviderViewSegment::NativeRange {
                                    source_lineage_id,
                                    from,
                                    to,
                                    ..
                                } = segment
                                {
                                    sources.insert((source_lineage_id, from, to));
                                }
                            }
                        }
                    }
                    Ok(ProviderViewSourceRoots { versions, sources })
                };
                let roots = read().map_err(|e| {
                    refusal = Some(e);
                    rusqlite::Error::InvalidQuery
                })?;
                tx.commit()?;
                Ok(roots)
            })
            .map_err(|e| refusal.unwrap_or_else(|| ProviderError::Storage(e.into())))
    }

    pub fn resolve_provider_view(
        &self,
        key: &ProviderSessionKey,
        version: u64,
    ) -> Result<Option<ProviderResolvedView>, ProviderError> {
        let mut refusal = None;
        self.inner
            .with_conn(|conn| {
                resolve_tx(conn, &key.conversation_key(), version, true).map_err(|e| {
                    refusal = Some(e);
                    rusqlite::Error::InvalidQuery
                })
            })
            .map_err(|e| refusal.unwrap_or_else(|| ProviderError::Storage(e.into())))
    }

    /// Resolve bounded recipe dependencies without loading native message bodies.
    /// Fold writers use this catalog; serving readers validate/materialize sources.
    pub fn resolve_provider_view_catalog(
        &self,
        key: &ProviderSessionKey,
        version: u64,
    ) -> Result<Option<ProviderResolvedView>, ProviderError> {
        let mut refusal = None;
        self.inner
            .with_conn(|conn| {
                resolve_tx(conn, &key.conversation_key(), version, false).map_err(|e| {
                    refusal = Some(e);
                    rusqlite::Error::InvalidQuery
                })
            })
            .map_err(|e| refusal.unwrap_or_else(|| ProviderError::Storage(e.into())))
    }

    pub fn save_provider_view_recipe(
        &self,
        key: &ProviderSessionKey,
        recipe: &ProviderViewRecipe,
    ) -> Result<usize, ProviderError> {
        let mut refusal = None;
        self.inner
            .with_conn_fenced(|conn| {
                save_recipe_tx(conn, &key.conversation_key(), recipe).map_err(|e| {
                    refusal = Some(e);
                    rusqlite::Error::InvalidQuery
                })
            })
            .map_err(|e| refusal.unwrap_or_else(|| ProviderError::Storage(e.into())))
    }

    /// Reachability, not age, controls retention. Callers pass applied, produced,
    /// last-known-good request and receipt versions; ancestor recipes and current
    /// policy exceptions remain live until those roots no longer refer to them.
    pub fn prune_provider_view_recipes(
        &self,
        key: &ProviderSessionKey,
        roots: &BTreeSet<u64>,
    ) -> Result<usize, ProviderError> {
        let mut refusal = None;
        self.inner
            .with_conn_fenced(|conn| {
                prune_tx(conn, &key.conversation_key(), roots).map_err(|e| {
                    refusal = Some(e);
                    rusqlite::Error::InvalidQuery
                })
            })
            .map_err(|e| refusal.unwrap_or_else(|| ProviderError::Storage(e.into())))
    }
}

/// Insert one immutable recipe. Shared by the host view writer and the runner
/// record writer so both commit the view in the caller's transaction.
pub(crate) fn save_recipe_tx(
    conn: &rusqlite::Connection,
    conv: &str,
    recipe: &ProviderViewRecipe,
) -> Result<usize, ProviderError> {
    let conv = conv.to_string();
    let mut recipe = recipe.clone();
    if let Some(base) = recipe.base_version {
        let resolved = resolve_tx(conn, &conv, base, false)?
            .ok_or_else(|| invalid("provider view base is missing"))?;
        let new_bytes = serde_json::to_vec(&recipe.synthetic)
            .map_err(invalid)?
            .len()
            + serde_json::to_vec(&recipe.treatments)
                .map_err(invalid)?
                .len();
        let base_bytes = serde_json::to_vec(&resolved.recipe.synthetic)
            .map_err(invalid)?
            .len()
            + serde_json::to_vec(&resolved.recipe.treatments)
                .map_err(invalid)?
                .len()
            + serde_json::to_vec(&resolved.recipe.segments)
                .map_err(invalid)?
                .len()
            + resolved.recipe.metadata.to_string().len();
        let old_native: u64 = resolved
            .recipe
            .segments
            .iter()
            .map(|s| match s {
                ProviderViewSegment::NativeRange { from, to, .. } => to - from,
                _ => 0,
            })
            .sum();
        let new_native: u64 = recipe
            .segments
            .iter()
            .map(|s| match s {
                ProviderViewSegment::NativeRange { from, to, .. } => to - from,
                _ => 0,
            })
            .sum();
        if resolved.depth + 1 > MAX_VIEW_BASE_DEPTH
            || resolved.ancestor_bytes + base_bytes + new_bytes > MAX_VIEW_ANCESTOR_BYTES
            || old_native > new_native.saturating_mul(2).max(1)
        {
            for (slot, value) in resolved.recipe.synthetic {
                recipe.synthetic.entry(slot).or_insert(value);
            }
            let mut treatments = BTreeMap::new();
            for t in recipe.treatments {
                treatments.insert(
                    (t.source_lineage_id.clone(), t.mid.clone(), t.block_index),
                    t,
                );
            }
            for t in resolved.recipe.treatments {
                treatments
                    .entry((t.source_lineage_id.clone(), t.mid.clone(), t.block_index))
                    .or_insert(t);
            }
            recipe.treatments=treatments.into_values().filter(|t|t.patch.is_some() && recipe.segments.iter().any(|s|matches!(s,ProviderViewSegment::NativeRange {source_lineage_id,from,to,..} if &t.source_lineage_id==source_lineage_id && t.ordinal>=*from && t.ordinal<*to))).collect();
            recipe.synthetic.retain(|slot, _| {
                recipe.segments.iter().any(
                    |s| matches!(s,ProviderViewSegment::Synthetic {slot:needed} if slot==needed),
                )
            });
            recipe.base_version = None;
        }
    }
    // Every recipe row must name a policy cut. A view saved without the
    // conversation's baseline cut links to its newest cut instead. Only a
    // conversation with no cut gets a new placeholder "setup" cut: the
    // newest cut is the one policy and fold reads treat as current, so
    // adding one on every view save would change what they read.
    let current = match recipe.policy_cut_id {
        Some(cut) => Some(cut),
        None => crate::provider_policy_overlay::current_cut_tx(conn, &conv)?,
    };
    if current.is_some() {
        let held:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM mc_provider_lineages_v1 WHERE conv_key=?1 AND lineage_id=?2)",params![conv,recipe.lineage_id],|r|r.get(0))?;
        if !held {
            conn.execute("INSERT INTO mc_provider_lineages_v1 SELECT ?1,'',0,NULL,NULL,json_extract(?1,'$[1]') WHERE NOT EXISTS(SELECT 1 FROM mc_provider_lineages_v1 WHERE conv_key=?1 AND lineage_id='')",[&conv])?;
            recipe.lineage_id = String::new();
        }
    }
    let cut = if let Some(cut) = current {
        cut
    } else {
        // Setup creates a synthetic head before receiving native messages.
        // Its empty lineage ID cannot be supplied by host ingest.
        conn.execute("INSERT INTO mc_provider_lineages_v1 SELECT ?1,'',0,NULL,NULL,json_extract(?1,'$[1]') WHERE NOT EXISTS(SELECT 1 FROM mc_provider_lineages_v1 WHERE conv_key=?1 AND lineage_id='')",[&conv])?;
        let cut: u64 = conn.query_row(
            "SELECT coalesce(max(cut_id),-1)+1 FROM mc_provider_policy_cuts_v1 WHERE conv_key=?1",
            [&conv],
            |r| r.get(0),
        )?;
        conn.execute("INSERT INTO mc_provider_policy_cuts_v1 VALUES (?1,?2,'',NULL,0,'{}','{}','{}','setup',json_extract(?1,'$[1]'))",params![conv,cut])?;
        recipe.lineage_id = String::new();
        cut
    };
    let metadata = recipe.metadata.to_string();
    let sequence = serde_json::to_string(&recipe.segments).map_err(invalid)?;
    let synthetic = (!recipe.synthetic.is_empty())
        .then(|| serde_json::to_vec(&recipe.synthetic))
        .transpose()
        .map_err(invalid)?;
    let mut bytes = metadata.len() + sequence.len() + synthetic.as_ref().map_or(0, Vec::len);
    conn.execute("INSERT INTO mc_provider_views_v2 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,1,?11,?12,?13,?14,json_extract(?1,'$[1]'))",params![conv,recipe.version,recipe.lineage_id,recipe.range_from,recipe.range_to,recipe.base_version,cut,metadata,sequence,synthetic,recipe.serializer_profile,recipe.render_key,recipe.tokenizer_key,recipe.state])?;
    for treatment in recipe.treatments {
        let patch = treatment.patch.map(|v| v.to_string());
        bytes += patch.as_ref().map_or(0, String::len);
        conn.execute("INSERT INTO mc_provider_view_overrides_v1 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,json_extract(?1,'$[1]'))",params![conv,recipe.version,treatment.source_lineage_id,treatment.mid,treatment.ordinal,treatment.block_index,treatment.block_id,if patch.is_some(){"set"}else{"reset"},patch])?;
    }
    Ok(bytes)
}

/// Delete recipes that no root reaches through its base chain, then delete the
/// policy cuts that no remaining recipe or policy override references. See
/// `prune_provider_view_recipes`.
pub(crate) fn prune_tx(
    conn: &rusqlite::Connection,
    conv: &str,
    roots: &BTreeSet<u64>,
) -> Result<usize, ProviderError> {
    let conv = conv.to_string();
    let mut keep = roots.clone();
    for root in roots {
        let mut current = Some(*root);
        let mut depth = 0;
        while let Some(version) = current {
            if depth > MAX_VIEW_BASE_DEPTH {
                return Err(invalid("provider view retention inheritance exceeds bound"));
            }
            let base = conn.prepare_cached("SELECT base_version FROM mc_provider_views_v2 WHERE conv_key=?1 AND version=?2")?
                            .query_row(params![conv,version], |row| row.get::<_,Option<u64>>(0)).optional()?
                            .ok_or_else(||invalid("still-referenced provider view is missing"))?;
            keep.insert(version);
            current = base;
            depth += 1;
        }
    }
    let mut q = conn.prepare_cached(
        "SELECT version FROM mc_provider_views_v2 WHERE conv_key=?1 ORDER BY version DESC",
    )?;
    let versions = q
        .query_map([&conv], |r| r.get::<_, u64>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut removed = 0;
    for version in versions.into_iter().filter(|v| !keep.contains(v)) {
        conn.execute(
            "DELETE FROM mc_provider_view_overrides_v1 WHERE conv_key=?1 AND version=?2",
            params![conv, version],
        )?;
        removed += conn.execute(
            "DELETE FROM mc_provider_views_v2 WHERE conv_key=?1 AND version=?2",
            params![conv, version],
        )?;
    }
    let current = crate::provider_policy_overlay::current_cut_tx(conn, &conv)?;
    let namespace: String = conn.query_row(
        "SELECT engine_namespace FROM mc_provider_conversations_v2 WHERE conv_key=?1",
        [&conv],
        |row| row.get(0),
    )?;
    let cache_cut = crate::cache_codec::native_tail_cut(conn, &namespace)?;
    conn.execute("DELETE FROM mc_provider_policy_cuts_v1 WHERE conv_key=?1 AND (?2 IS NULL OR cut_id<>?2) AND NOT EXISTS(SELECT 1 FROM mc_provider_views_v2 v WHERE v.conv_key=?1 AND v.policy_cut_id=mc_provider_policy_cuts_v1.cut_id) AND NOT EXISTS(SELECT 1 FROM mc_provider_policy_overrides_v1 o WHERE o.conv_key=?1 AND o.cut_id=mc_provider_policy_cuts_v1.cut_id) AND (?3 IS NULL OR cut_id<>?3)",params![conv,current,cache_cut])?;
    Ok(removed)
}

/// Every view version that something outside the recipe table can still ask to
/// replay, read inside the caller's transaction:
/// - host Setup's applied and produced summaries (acknowledgements and the
///   not-applied replay of the produced view);
/// - the last step or Setup receipt (a retried request answers from it);
/// - the view each still-held lineage was named in its newest step answer
///   (`LINEAGE_ANSWERED_VIEWS`), which the receipt alone loses once a sibling
///   lineage of the same conversation steps;
/// - the two newest applied rows, because the host keeps the previous applied
///   request until it saves the newly acknowledged one;
/// - the runner record's produced, applied and waiting views.
pub(crate) fn view_roots_tx(
    conn: &rusqlite::Connection,
    conv: &str,
) -> Result<BTreeSet<u64>, ProviderError> {
    let mut roots = BTreeSet::new();
    let row: Option<(Option<String>, Option<String>, String, String)> = conn
        .query_row(
            "SELECT setup_json,last_answer_json,hook_counters_json,legacy_shape_json FROM mc_provider_conversations_v2 WHERE conv_key=?1",
            [conv],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let Some((setup, receipt, counters, shape)) = row else {
        return Ok(roots);
    };
    let mut collect = |raw: &str, paths: &[&str]| -> Result<(), ProviderError> {
        let value: Value = serde_json::from_str(raw).map_err(invalid)?;
        for path in paths {
            if let Some(version) = value.pointer(path).and_then(Value::as_u64) {
                roots.insert(version);
            }
        }
        Ok(())
    };
    if let Some(raw) = setup {
        collect(&raw, &["/applied/version", "/produced/version"])?;
    }
    if let Some(raw) = receipt {
        collect(&raw, &["/compaction/version", "/initial/version"])?;
    }
    collect(
        &shape,
        &["/produced_version", "/applied_version", "/wait_version"],
    )?;
    let counters: Value = serde_json::from_str(&counters).map_err(invalid)?;
    roots.extend(lineage_answered_views_tx(conn, conv, &counters)?.into_values());
    let mut q = conn.prepare_cached("SELECT version FROM mc_provider_views_v2 WHERE conv_key=?1 AND state='applied' ORDER BY version DESC LIMIT 2")?;
    for version in q.query_map([conv], |r| r.get::<_, u64>(0))? {
        roots.insert(version?);
    }
    // A version named by a reference but never stored has nothing to protect.
    // Leave it out: `prune_tx` refuses a root whose recipe is missing, and the
    // record and view readers already treat that version as absent.
    let mut exists = conn.prepare_cached(
        "SELECT EXISTS(SELECT 1 FROM mc_provider_views_v2 WHERE conv_key=?1 AND version=?2)",
    )?;
    let mut held = BTreeSet::new();
    for version in roots {
        if exists.query_row(params![conv, version], |r| r.get::<_, bool>(0))? {
            held.insert(version);
        }
    }
    Ok(held)
}
