//! Snapshot adapter for the non-served retrieval method. No writes or live-store opens.

use crate::parity_contract::*;
use crate::retrieval::{compartments::CompartmentChunk, hybrid::*};
use mc_store::McStore;
use rusqlite::{params, types::Value as SqlValue, Connection, OptionalExtension};
use std::collections::BTreeSet;

#[path = "retrieval_search.rs"]
pub(crate) mod search;

pub(crate) trait ReadContext {
    fn context_read<T>(
        &self,
        read: impl FnOnce(&Connection) -> rusqlite::Result<T>,
    ) -> Result<T, String>;

    fn lexical(&self) -> Option<&dyn LexicalRead> {
        None
    }
}

/// App snapshots bound lexical candidates and retain metadata for their replies.
pub(crate) trait LexicalRead {
    fn limit(&self) -> usize;
    fn git_page_limit(&self) -> usize;
    fn memories(
        &self,
        scope: &StoreScope,
        dates: DateBounds,
    ) -> CapabilityResult<Vec<SearchMemory>>;
    fn memory_fts(&self) -> CapabilityResult<Vec<MemoryFtsHit>>;
    fn messages(&self, dates: DateBounds)
        -> CapabilityResult<Vec<mc_store::archive_index::FtsRow>>;
    fn notes(
        &self,
        scope: &StoreScope,
        request: &RetrievalRequest,
        probes: &[String],
        limit: usize,
    ) -> CapabilityResult<(
        Vec<crate::retrieval::note_ranking::NoteHit>,
        Vec<crate::retrieval::note_ranking::NoteRow>,
    )>;
}

impl ReadContext for McStore {
    fn context_read<T>(
        &self,
        read: impl FnOnce(&Connection) -> rusqlite::Result<T>,
    ) -> Result<T, String> {
        self.with_context_read(read).map_err(|e| e.to_string())
    }
}

impl<R: ReadContext> ReadContext for std::sync::Arc<R> {
    fn context_read<T>(
        &self,
        read: impl FnOnce(&Connection) -> rusqlite::Result<T>,
    ) -> Result<T, String> {
        self.as_ref().context_read(read)
    }
}

pub(crate) struct RetrievalStore<'a, R = McStore> {
    pub store: &'a R,
    pub now_ms: i64,
}

impl<R: ReadContext> RetrievalStore<'_, R> {
    fn read<T>(
        &self,
        read: impl FnOnce(&Connection) -> rusqlite::Result<T>,
    ) -> CapabilityResult<T> {
        match self.store.context_read(read) {
            Ok(value) => CapabilityResult::Available { value },
            Err(error) => CapabilityResult::Unavailable {
                reason: CapabilityReason {
                    code: "retrieval_store".into(),
                    message: error.to_string(),
                },
            },
        }
    }

    fn memory_filter(
        &self,
        conn: &Connection,
        scope: &StoreScope,
        dates: DateBounds,
    ) -> rusqlite::Result<(String, Vec<SqlValue>)> {
        let workspace: Option<i64> = conn
            .query_row(
                "SELECT workspace_id FROM workspace_members WHERE project_path=?",
                [&scope.project.0],
                |r| r.get(0),
            )
            .optional()?;
        let mut identities = vec![scope.project.0.clone()];
        let mut categories = Vec::<String>::new();
        if let Some(workspace) = workspace {
            identities = conn.prepare("SELECT project_path FROM workspace_members WHERE workspace_id=? ORDER BY project_path")?
                .query_map([workspace], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
            let json: String = conn.query_row(
                "SELECT share_categories FROM workspaces WHERE id=?",
                [workspace],
                |r| r.get(0),
            )?;
            categories = serde_json::from_str(&json)
                .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
        }
        let slots = |n| vec!["?"; n].join(",");
        let mut binds: Vec<SqlValue> = identities.iter().cloned().map(SqlValue::Text).collect();
        let sharing = if workspace.is_some() {
            binds.push(scope.project.0.clone().into());
            binds.extend(categories.iter().cloned().map(SqlValue::Text));
            format!("AND (memories.project_path=? OR (memories.category IN ({}) AND memories.shareable=1 AND memories.scope IN ('project','ecosystem','universe')))", slots(categories.len()))
        } else {
            String::new()
        };
        binds.extend([
            self.now_ms.into(),
            dates.from_ms.unwrap_or(-9_007_199_254_740_991).into(),
            dates.to_ms.unwrap_or(9_007_199_254_740_991).into(),
        ]);
        Ok((format!("memories.project_path IN ({}) {sharing} AND memories.status IN ('active','permanent') AND (memories.expires_at IS NULL OR memories.expires_at > ?) AND memories.created_at BETWEEN ? AND ?", slots(identities.len())), binds))
    }

    pub fn raw_messages(
        &self,
        scope: &StoreScope,
        query: &str,
        dates: DateBounds,
        cutoff: i64,
        limit: usize,
        relaxed: bool,
    ) -> CapabilityResult<Vec<mc_store::archive_index::FtsRow>> {
        if let Some(snapshot) = self.store.lexical() {
            return snapshot.messages(dates);
        }
        self.read(|conn| {
            let sanitized = fts_query(query);
            if sanitized.is_empty() {
                return Ok(Vec::new());
            }
            let mut rows = mc_store::archive_index::search(
                conn,
                &scope.session.0,
                &sanitized,
                cutoff,
                dates.from_ms,
                dates.to_ms,
                limit,
            )?;
            if rows.is_empty() && relaxed {
                let relaxed = relaxed_query(query);
                if !relaxed.is_empty() && relaxed != sanitized {
                    rows = mc_store::archive_index::search(
                        conn,
                        &scope.session.0,
                        &relaxed,
                        cutoff,
                        dates.from_ms,
                        dates.to_ms,
                        limit,
                    )?;
                }
            }
            Ok(rows)
        })
    }

    pub fn corpus_size(&self, scope: &StoreScope, cutoff: i64) -> CapabilityResult<usize> {
        self.read(|conn| {
            conn.query_row(
                "SELECT last_indexed_ordinal FROM message_history_index WHERE session_id=?",
                [&scope.session.0],
                |r| r.get::<_, i64>(0),
            )
            .optional()
            .map(|value| value.unwrap_or(0).min(cutoff).max(0) as usize)
        })
    }

    pub fn compartment_text(
        &self,
        scope: &StoreScope,
        start: i64,
        end: i64,
    ) -> CapabilityResult<String> {
        self.read(|conn| {
            if !mc_store::archive_index::range_is_mapped(conn,&scope.session.0,start,end)? { return Ok(String::new()); }
            let mut stmt=conn.prepare("SELECT m.message_ordinal,f.role,f.content FROM message_fts_rowid_map m JOIN message_history_fts f ON f.rowid=m.fts_rowid WHERE m.session_id=? AND m.message_ordinal BETWEEN ? AND ? ORDER BY m.message_ordinal")?;
            let rows=stmt.query_map(params![scope.session.0,start,end],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
            let mut groups=Vec::<(i64,i64,&str,Vec<String>)>::new();
            let whitespace=regex::Regex::new(r"[\s\u{feff}]+").expect("constant expression");
            for (ordinal,role,content) in rows {
                let prefix=match role.as_str() { "user"=>"U","assistant"=>"A",_=>continue };
                let content=whitespace.replace_all(&content," "); let content=content.trim();
                if content.is_empty() { continue; }
                if let Some(group)=groups.last_mut().filter(|g|g.2==prefix) { group.1=ordinal;group.3.push(content.into()); }
                else { groups.push((ordinal,ordinal,prefix,vec![content.into()])); }
            }
            Ok(groups.into_iter().map(|(start,end,role,parts)|format!("[{}] {role}: {}",if start==end { start.to_string() } else { format!("{start}-{end}") },parts.join(" / "))).collect::<Vec<_>>().join("\n"))
        })
    }

    pub fn probe_frequency(
        &self,
        scope: &StoreScope,
        probe: &str,
        dates: DateBounds,
        cutoff: i64,
    ) -> CapabilityResult<usize> {
        self.read(|conn| conn.query_row("SELECT COUNT(*) FROM message_history_fts f JOIN message_fts_rowid_map m ON m.fts_rowid=f.rowid WHERE f.session_id=?1 AND message_history_fts MATCH ?2 AND m.message_ordinal<=?3 AND (?4 IS NULL OR m.message_time_ms>=?4) AND (?5 IS NULL OR m.message_time_ms<=?5)", params![scope.session.0, format!("content : ({})",fts_query(probe)),cutoff,dates.from_ms,dates.to_ms],|r|r.get(0)))
    }

    pub fn notes(
        &self,
        scope: &StoreScope,
        request: &RetrievalRequest,
        probes: &[String],
        limit: usize,
    ) -> CapabilityResult<(
        Vec<crate::retrieval::note_ranking::NoteHit>,
        Vec<crate::retrieval::note_ranking::NoteRow>,
    )> {
        if let Some(snapshot) = self.store.lexical() {
            return snapshot.notes(scope, request, probes, limit);
        }
        use crate::retrieval::note_ranking::{rank_notes, NoteRow, NoteStatus, NoteType};
        self.read(|conn| {
            let mut stmt = conn.prepare("SELECT id,type,status,content,session_id,project_path,surface_condition,ready_reason,created_at,anchor_ordinal FROM notes WHERE ((type='session' AND session_id=?1) OR (type='smart' AND project_path=?2)) AND status IN ('active','pending','ready') ORDER BY created_at DESC,id ASC")?;
            let rows = stmt.query_map(params![scope.session.0,scope.project.0],|r| Ok(NoteRow {
                id:r.get(0)?, note_type: if r.get::<_,String>(1)? == "session" { NoteType::Session } else { NoteType::Smart },
                status:match r.get::<_,String>(2)?.as_str() { "pending" => NoteStatus::Pending, "ready" => NoteStatus::Ready, _ => NoteStatus::Active },
                content:r.get(3)?,session_id:r.get(4)?,project_path:r.get(5)?,surface_condition:r.get(6)?,ready_reason:r.get(7)?,created_at:r.get(8)?,anchor_ordinal:r.get(9)?,
            }))?.collect::<rusqlite::Result<Vec<_>>>()?;
            let hits = rank_notes(&rows,&scope.session.0,&scope.project.0,&request.query,probes,DateBounds { from_ms:request.start_at_ms,to_ms:request.end_at_ms_inclusive },limit);
            Ok((hits,rows))
        })
    }

    pub fn git_commits(
        &self,
        scope: &StoreScope,
        request: &RetrievalRequest,
        query: Option<(&EmbeddingIdentity, &[f32])>,
        limit: usize,
    ) -> CapabilityResult<mc_store::git_archive::SearchResults> {
        let options = mc_store::git_archive::SearchOptions {
            limit: self.store.lexical().map_or(limit, |s| s.git_page_limit()) as u32,
            from: request.start_at_ms,
            to: request.end_at_ms_inclusive,
            query_embedding: query.map(|(_, v)| v.to_vec()),
            query_model_id: query.map(|(id, _)| id.model.clone()),
            ..Default::default()
        };
        self.read(|conn| {
            mc_store::git_archive::search_with_lanes(
                conn,
                &scope.project.0,
                &request.query,
                &options,
            )
        })
    }
}

pub(crate) fn fts_query(query: &str) -> String {
    query
        .replace('\0', " ")
        .split_whitespace()
        .map(quote)
        .collect::<Vec<_>>()
        .join(" ")
}
fn quote(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}
fn relaxed_query(query: &str) -> String {
    let mut seen = BTreeSet::new();
    regex::Regex::new(r"[\p{L}\p{N}_]+")
        .expect("constant expression")
        .find_iter(query)
        .map(|m| m.as_str())
        .filter(|s| seen.insert(s.to_string()))
        .filter(|s| s.encode_utf16().count() > 2 || s.chars().any(|c| c.is_ascii_digit()))
        .take(16)
        .map(quote)
        .collect::<Vec<_>>()
        .join(" OR ")
}
fn decode_vector(blob: Vec<u8>) -> rusqlite::Result<Vec<f32>> {
    if !blob.len().is_multiple_of(4) {
        return Err(rusqlite::Error::InvalidQuery);
    }
    Ok(blob
        .as_chunks::<4>()
        .0
        .iter()
        .map(|b| f32::from_le_bytes(*b))
        .collect())
}

impl<R: ReadContext> RetrievalStore<'_, R> {
    pub fn read_search_memories(
        &self,
        scope: &StoreScope,
        dates: DateBounds,
    ) -> CapabilityResult<Vec<SearchMemory>> {
        if let Some(snapshot) = self.store.lexical() {
            return snapshot.memories(scope, dates);
        }
        self.read(|conn| {
            let (filter, binds) = self.memory_filter(conn, scope, dates)?;
            let binds = std::iter::once(scope.project.0.clone().into()).chain(binds).collect::<Vec<SqlValue>>();
            let mut stmt = conn.prepare(&format!("SELECT memories.id, memories.category, memories.content, memories.created_at, CASE WHEN memories.project_path=? THEN NULL ELSE workspace_members.display_name END FROM memories LEFT JOIN workspace_members ON workspace_members.project_path=memories.project_path WHERE {filter} ORDER BY memories.id"))?;
            let rows = stmt.query_map(rusqlite::params_from_iter(binds), |r| Ok(SearchMemory {
                id: r.get(0)?, category: r.get(1)?, content: r.get(2)?, created_at_ms: r.get(3)?, source_name: r.get(4)?,
            }))?.collect(); rows
        })
    }
    pub fn search_memory_fts(
        &self,
        scope: &StoreScope,
        query: &str,
        dates: DateBounds,
        limit: usize,
    ) -> CapabilityResult<Vec<MemoryFtsHit>> {
        if let Some(snapshot) = self.store.lexical() {
            return snapshot.memory_fts();
        }
        self.read(|conn| {
            let run = |query: &str| -> rusqlite::Result<Vec<MemoryFtsHit>> {
                let (filter, mut binds) = self.memory_filter(conn, scope, dates)?;
                binds.extend([query.to_string().into(), (limit as i64).into()]);
                let mut stmt = conn.prepare(&format!("SELECT memories.id, bm25(memories_fts) FROM memories_fts INNER JOIN memories ON memories.id=memories_fts.rowid WHERE {filter} AND memories_fts MATCH ? ORDER BY bm25(memories_fts), memories.updated_at DESC, memories.id ASC LIMIT ?"))?;
                let rows = stmt.query_map(rusqlite::params_from_iter(binds), |r| Ok(MemoryFtsHit { memory_id: r.get(0)?, bm25: r.get(1)? }))?.collect(); rows
            };
            let sanitized = fts_query(query);
            if sanitized.is_empty() { return Ok(Vec::new()); }
            let mut hits = run(&sanitized)?;
            if hits.is_empty() {
                let relaxed = relaxed_query(query);
                if !relaxed.is_empty() && relaxed != sanitized { hits = run(&relaxed)?; }
            }
            Ok(hits)
        })
    }
    pub fn read_memory_vectors(
        &self,
        scope: &StoreScope,
        ids: &[i64],
        identity: &EmbeddingIdentity,
    ) -> CapabilityResult<Vec<MemoryVector>> {
        self.read(|conn| {
            // Reapply visibility before reading vectors; request IDs cannot widen project scope.
            let allowed = self.memory_filter(conn, scope, DateBounds::default())?;
            let mut binds = vec![SqlValue::Text(identity.model.clone())]; binds.extend(allowed.1);
            let mut stmt = conn.prepare(&format!("SELECT e.memory_id, e.embedding FROM memory_embeddings e JOIN memories ON memories.id=e.memory_id WHERE e.model_id=? AND {} ORDER BY e.memory_id", allowed.0))?;
            let rows = stmt.query_map(rusqlite::params_from_iter(binds), |r| Ok(MemoryVector {
                memory_id: r.get(0)?, identity: identity.clone(), values: decode_vector(r.get(1)?)?,
            }))?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows.into_iter().filter(|v| ids.contains(&v.memory_id)).collect())
        })
    }
    pub fn read_compartment_chunks(
        &self,
        scope: &StoreScope,
        _: DateBounds,
        identity: &EmbeddingIdentity,
    ) -> CapabilityResult<Vec<CompartmentChunk>> {
        self.read(|conn| {
            let mut stmt = conn.prepare("SELECT e.compartment_id, e.session_id, e.project_path, c.title, c.start_message, c.end_message, start_map.message_time_ms, end_map.message_time_ms, e.vector FROM compartment_chunk_embeddings e JOIN compartments c ON c.id=e.compartment_id LEFT JOIN message_fts_rowid_map start_map ON start_map.session_id=c.session_id AND start_map.message_ordinal=c.start_message LEFT JOIN message_fts_rowid_map end_map ON end_map.session_id=c.session_id AND end_map.message_ordinal=c.end_message WHERE e.session_id=? AND e.project_path=? AND e.model_id=? ORDER BY e.compartment_id ASC, e.window_index ASC")?;
            let rows = stmt.query_map(params![scope.session.0, scope.project.0, identity.model], |r| Ok(CompartmentChunk {
                compartment_id: r.get(0)?, session_id: r.get(1)?, project_path: r.get(2)?, title: r.get(3)?,
                start_ordinal: r.get(4)?, end_ordinal: r.get(5)?, start_time_ms: r.get(6)?, end_time_ms: r.get(7)?,
                identity: identity.clone(), values: decode_vector(r.get(8)?)?,
            }))?.collect(); rows
        })
    }
    pub fn read_visible_memory_ids(&self, scope: &StoreScope) -> CapabilityResult<BTreeSet<i64>> {
        if self.store.lexical().is_some() {
            return CapabilityResult::Available {
                value: BTreeSet::new(),
            };
        }
        self.read(|conn| {
            let mut stmt = conn.prepare("SELECT a.memory_id, a.projected_metadata_json FROM memory_applied_rows a JOIN memories m ON m.id=a.memory_id AND m.content=a.projected_text WHERE a.session_id=? AND a.harness='opencode' AND m.status!='archived'")?;
            let rows = stmt.query_map([&scope.session.0], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows.into_iter().filter_map(|(id, metadata)| {
                let metadata: serde_json::Value = serde_json::from_str(&metadata).ok()?;
                metadata["representations"].as_array()?.iter().any(|v| v == "text" || v == "delta").then_some(id)
            }).collect())
        })
    }
}

impl<R: ReadContext + Send + Sync> RetrievalInputStore for RetrievalStore<'_, R> {
    fn read_search_memories(
        &self,
        scope: &StoreScope,
        dates: DateBounds,
    ) -> CapabilityResult<Vec<SearchMemory>> {
        RetrievalStore::read_search_memories(self, scope, dates)
    }
    fn search_memory_fts(
        &self,
        scope: &StoreScope,
        query: &str,
        dates: DateBounds,
        limit: usize,
    ) -> CapabilityResult<Vec<MemoryFtsHit>> {
        RetrievalStore::search_memory_fts(self, scope, query, dates, limit)
    }
    fn read_memory_vectors(
        &self,
        scope: &StoreScope,
        ids: &[i64],
        identity: &EmbeddingIdentity,
    ) -> CapabilityResult<Vec<MemoryVector>> {
        RetrievalStore::read_memory_vectors(self, scope, ids, identity)
    }
    fn read_compartment_chunks(
        &self,
        scope: &StoreScope,
        dates: DateBounds,
        identity: &EmbeddingIdentity,
    ) -> CapabilityResult<Vec<CompartmentChunk>> {
        RetrievalStore::read_compartment_chunks(self, scope, dates, identity)
    }
    fn read_visible_memory_ids(&self, scope: &StoreScope) -> CapabilityResult<BTreeSet<i64>> {
        RetrievalStore::read_visible_memory_ids(self, scope)
    }
}

/// Connect only when a search calls Synapse, so ck-mc can register and serve
/// requests even when no Synapse module is loaded.
pub(crate) struct RerankTransport {
    pub connection_file: std::path::PathBuf,
    pub target: subc_protocol::RouteTarget,
}
#[subc_client_rs::async_trait]
impl RerankClient for RerankTransport {
    async fn call(
        &self,
        module: &str,
        method: &str,
        params: serde_json::Value,
        options: RerankCallOptions,
    ) -> Result<serde_json::Value, String> {
        use subc_client_rs::{ConsumerOptions, SubcConsumer};
        let budget = std::time::Duration::from_millis(options.timeout_ms);
        let consumer = SubcConsumer::connect(
            &self.connection_file,
            ConsumerOptions {
                handshake_timeout: budget,
                call_timeout: budget,
                ..ConsumerOptions::default()
            },
        )
        .await
        .map_err(|e| e.to_string())?;
        let response = SubcRerankClient {
            consumer: &consumer,
            target: self.target.clone(),
        }
        .call(module, method, params, options)
        .await;
        consumer.close().await;
        response
    }
}
