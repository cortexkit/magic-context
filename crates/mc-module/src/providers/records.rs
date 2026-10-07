//! Typed provider records and once-per-lineage transcript observation.
use super::*;
use serde::Deserialize;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Key {
    pub project: PathBuf,
    pub session: String,
    pub harness: String,
}

impl Key {
    pub fn new(
        binding: &SessionBinding,
        session: &str,
        harness: &str,
    ) -> Result<Self, HandlerOutcome> {
        if session.trim().is_empty() {
            return Err(session_unresolved_error());
        }
        if harness.trim().is_empty() {
            return Err(invalid("harness must be non-empty"));
        }
        Ok(Self {
            project: binding.project_root.clone(),
            session: session.trim().into(),
            harness: harness.into(),
        })
    }

    pub fn engine_key(&self) -> String {
        // Length-framed JSON avoids collisions between handles containing separators,
        // and separates the legacy engine namespace from runner conversations.
        format!(
            "mc-provider:{}",
            sha256_hex(&serde_json::to_vec(self).expect("session key JSON"))
        )
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Catalog {
    pub compacting: bool,
    pub tools: BTreeSet<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Setup {
    pub request: compact::setup::SetupRequest,
    pub state: transform::compaction::State,
    pub stability: Vec<compact::setup::StabilityRank>,
    pub call_when: compact::setup::CallWhen,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LiveTag {
    pub lineage: String,
    pub ordinal: u64,
    pub block_id: String,
    pub kind: String,
    pub source: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HookRecord {
    pub subject: String,
    pub lineage: Option<String>,
    pub answer: hooks::answer::HookAnswer,
    pub rendered: Vec<String>,
    pub tags: Vec<u64>,
    pub cadence: bool,
    pub observed: bool,
    pub tool_call_id: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct HookState {
    pub high_water: u64,
    pub answers: Vec<HookRecord>,
    pub live: BTreeMap<u64, LiveTag>,
    pub burned: BTreeSet<u64>,
    pub observed_tools: u64,
    pub last_reminder_at: Option<u64>,
    pub observed_users: u64,
    pub last_nudge_at: Option<u64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Record {
    pub catalog: Option<Catalog>,
    pub setup: Option<Setup>,
    pub hook: Option<HookState>,
    pub messages: BTreeMap<String, BTreeMap<u64, compact::status::StatusMessage>>,
    pub pending_drops: BTreeSet<u64>,
    pub last_answer: Option<Value>,
    pub wait_request: Option<String>,
    pub wait_view: Option<transform::compaction::View>,
}

/// A typed adapter over the handler's main store slot. It owns no connection,
/// policy or schema: store open and migrations finish before the slot is filled.
pub struct Storage {
    store: Arc<OnceLock<Arc<McStore>>>,
    /// If storage cannot record admission, the process remembers that fact until
    /// a full successful refetch. Discovery still serves its unchanged bytes.
    catalog_failures: Mutex<BTreeMap<(PathBuf, String), String>>,
}

impl Storage {
    pub fn new(store: Arc<OnceLock<Arc<McStore>>>) -> Self {
        Self {
            store,
            catalog_failures: Mutex::new(BTreeMap::new()),
        }
    }

    pub fn record_catalog_failure(&self, binding: &SessionBinding, error: &HandlerOutcome) {
        let reason = match error {
            HandlerOutcome::Error { code, message }
            | HandlerOutcome::ErrorWithDetail { code, message, .. } => format!("{code}: {message}"),
            _ => "catalog persistence failed".to_string(),
        };
        tracing::warn!(
            reason,
            "mc-module: tool catalog served without durable provider admission"
        );
        self.catalog_failures
            .lock()
            .expect("catalog failures")
            .insert(
                (binding.project_root.clone(), binding.session.trim().into()),
                reason,
            );
    }

    pub fn clear_catalog_failure(&self, binding: &SessionBinding) {
        self.catalog_failures
            .lock()
            .expect("catalog failures")
            .remove(&(binding.project_root.clone(), binding.session.trim().into()));
    }

    pub fn catalog_refusal(
        &self,
        binding: &SessionBinding,
        session: &str,
    ) -> Option<HandlerOutcome> {
        self.catalog_failures.lock().expect("catalog failures").get(&(binding.project_root.clone(),session.trim().into())).map(|reason|HandlerOutcome::ErrorWithDetail {
            code:"provider_catalog_unpersisted".into(),
            message:"The admitted tool catalog was not persisted; fetch tool.catalog again after storage is available".into(),
            detail:json!({"cause":reason}),
        })
    }

    fn store(&self) -> Result<&McStore, HandlerOutcome> {
        self.store
            .get()
            .map(Arc::as_ref)
            .ok_or_else(|| transient("provider store is not open"))
    }

    pub fn load(&self, key: &Key) -> Result<Record, HandlerOutcome> {
        self.store()?
            .load_provider_record(&key.store_key())
            .map_err(transient)?
            .map_or(Ok(Record::default()), |raw| {
                serde_json::from_str(&raw).map_err(transient)
            })
    }

    pub fn save(&self, key: &Key, record: &Record) -> Result<(), HandlerOutcome> {
        let tags = record
            .hook
            .as_ref()
            .map(|hook| {
                hook.live
                    .iter()
                    .map(|(number, tag)| McTagRow {
                        tag_number: *number as i64,
                        block_id: tag.block_id.clone(),
                        kind: tag.kind.clone(),
                        token_count: mc_tokenizer::estimate_tokens(&tag.source) as i64,
                        created_at_ms: now_ms(),
                        source_bytes: tag.source.as_bytes().into(),
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        self.store()?
            .save_provider_record(
                &key.store_key(),
                &serde_json::to_string(record).map_err(transient)?,
                &key.engine_key(),
                &tags,
            )
            .map_err(transient)
    }

    pub fn tool_key(&self, binding: &SessionBinding) -> Result<Key, HandlerOutcome> {
        if let Some(refusal) = self.catalog_refusal(binding, &binding.session) {
            return Err(refusal);
        }
        let rows = self
            .store()?
            .provider_records_for_session(
                &binding.project_root.to_string_lossy(),
                binding.session.trim(),
            )
            .map_err(transient)?;
        let mut found = Vec::new();
        for (harness, raw) in rows {
            let record: Record = serde_json::from_str(&raw).map_err(transient)?;
            if record.setup.is_some() || record.hook.is_some() {
                found.push(harness);
            }
        }
        // A tool call has no caller-harness field. Do not guess among several
        // conversations that happen to share the same project and handle.
        if found.len() != 1 {
            return Err(session_unresolved_error());
        }
        Key::new(binding, &binding.session, &found[0])
    }

    pub fn save_catalog(
        &self,
        binding: &SessionBinding,
        catalog: &Catalog,
    ) -> Result<(), HandlerOutcome> {
        self.store()?
            .save_provider_catalog(
                &binding.project_root.to_string_lossy(),
                binding.session.trim(),
                &serde_json::to_string(catalog).map_err(transient)?,
            )
            .map_err(transient)
    }

    pub fn catalog(&self, binding: &SessionBinding) -> Result<Option<Catalog>, HandlerOutcome> {
        self.store()?
            .load_provider_catalog(
                &binding.project_root.to_string_lossy(),
                binding.session.trim(),
            )
            .map_err(transient)?
            .map(|raw| serde_json::from_str(&raw).map_err(transient))
            .transpose()
    }
}

impl Key {
    fn store_key(&self) -> mc_store::ProviderSessionKey {
        mc_store::ProviderSessionKey {
            project_root: self.project.to_string_lossy().into_owned(),
            session: self.session.clone(),
            harness: self.harness.clone(),
        }
    }
}

fn text_targets(message: &ck_wire::CkIngressMessage) -> Vec<(String, String, String)> {
    let mut targets = Vec::new();
    for (index, block) in message.ck.content.iter().enumerate() {
        let id = format!("{}#{index}", message.mid);
        match &block.kind {
            ck_wire::CkKind::Text { text } => targets.push((id, "text".into(), text.clone())),
            ck_wire::CkKind::ToolResult { output, .. } => {
                let text = match &output.kind {
                    ck_wire::CkOutputKind::Text { text }
                    | ck_wire::CkOutputKind::ErrorText { text } => text.clone(),
                    _ => String::new(),
                };
                targets.push((id, "tool_result".into(), text));
            }
            _ => {}
        }
    }
    targets
}

pub fn ingest(
    record: &mut Record,
    lineage: &str,
    messages: &[compact::status::StatusMessage],
) -> Result<(), HandlerOutcome> {
    for entry in messages {
        let held = record.messages.entry(lineage.into()).or_default();
        if let Some(previous) = held.get(&entry.ordinal) {
            if previous != entry {
                return Err(transient("an ingested ordinal changed"));
            }
            continue;
        }
        let message = decode_message(entry)?;
        if let Some(hook) = &mut record.hook {
            let targets = text_targets(&message);
            if message.ck.role == "user"
                && !targets.iter().any(|(_, kind, _)| kind == "tool_result")
            {
                hook.observed_users += 1;
            }
            if targets.iter().any(|(_, kind, _)| kind == "tool_result") {
                hook.observed_tools += 1;
            }
            for answer in &mut hook.answers {
                if answer.observed || answer.lineage.as_deref().is_some_and(|l| l != lineage) {
                    continue;
                }
                if answer.tool_call_id.as_ref().is_some_and(|id|!message.ck.content.iter().any(|b|matches!(&b.kind,ck_wire::CkKind::ToolResult {id:actual,..} if id==actual))) {continue;}
                let all_seen = !answer.rendered.is_empty()
                    && answer
                        .rendered
                        .iter()
                        .all(|text| targets.iter().any(|(_, _, actual)| actual.contains(text)));
                if !all_seen {
                    continue;
                }
                answer.observed = true;
                for number in &answer.tags {
                    if hook.burned.contains(number) {
                        continue;
                    }
                    let prefix = format!("§{number}§ ");
                    if let Some((id, kind, text)) =
                        targets.iter().find(|(_, _, text)| text.contains(&prefix))
                    {
                        hook.live.insert(
                            *number,
                            LiveTag {
                                lineage: lineage.into(),
                                ordinal: entry.ordinal,
                                block_id: id.clone(),
                                kind: kind.clone(),
                                source: text.strip_prefix(&prefix).unwrap_or(text).into(),
                            },
                        );
                    }
                }
                if answer.cadence {
                    if targets.iter().any(|(_, kind, _)| kind == "tool_result") {
                        hook.last_reminder_at = Some(hook.observed_tools);
                    } else {
                        hook.last_nudge_at = Some(hook.observed_users);
                    }
                }
            }
        }
        held.insert(entry.ordinal, entry.clone());
    }
    Ok(())
}

pub fn frontier(record: &Record, lineage: &str) -> u64 {
    let Some(messages) = record.messages.get(lineage) else {
        return 0;
    };
    let mut next = 0;
    for ordinal in messages.keys() {
        if *ordinal != next {
            break;
        }
        next += 1;
    }
    next
}

/// Reads are bounded by one absolute call deadline, including every page and
/// commit. The in-flight hook subject is never awaited here: reads show only
/// records already durable in the runner.
pub async fn scan(
    storage: &Storage,
    runner: &dyn session_resolver::ProviderRunner,
    key: &Key,
    record: &mut Record,
    lineage: Option<&str>,
    sought: &[u64],
    deadline: Instant,
) -> Result<(), HandlerOutcome> {
    let mut lineage = lineage.map(str::to_string);
    let mut from = lineage.as_deref().map_or(0, |l| frontier(record, l));
    loop {
        let budget = deadline
            .checked_duration_since(Instant::now())
            .filter(|b| !b.is_zero())
            .ok_or_else(|| transient("transcript scan budget exhausted"))?;
        let mut params = json!({"from_ordinal":from,"max_bytes":4*1024*1024});
        if let Some(lineage) = &lineage {
            params["lineage_id"] = json!(lineage);
        }
        let page = tokio::time::timeout(
            budget,
            runner.call(&key.project, &key.session, "session.read", params, budget),
        )
        .await
        .map_err(|_| transient("transcript scan timed out"))?
        .map_err(transient)?;
        let page_lineage = page
            .get("lineage_id")
            .and_then(Value::as_str)
            .ok_or_else(|| transient("transcript page omitted lineage_id"))?;
        if lineage.as_deref().is_some_and(|l| l != page_lineage) {
            return Err(transient("transcript lineage changed"));
        }
        lineage = Some(page_lineage.into());
        let messages: Vec<compact::status::StatusMessage> = decode(
            page.get("messages")
                .ok_or_else(|| transient("transcript page omitted messages"))?,
        )?;
        ingest(record, page_lineage, &messages)?;
        storage.save(key, record)?;
        if Instant::now() >= deadline {
            return Err(transient(
                "transcript scan budget exhausted before its answer",
            ));
        }
        if !sought.is_empty()
            && record.hook.as_ref().is_some_and(|h| {
                sought
                    .iter()
                    .all(|n| h.live.contains_key(n) || h.burned.contains(n))
            })
        {
            return Ok(());
        }
        let next = page.get("next_from_ordinal").and_then(Value::as_u64);
        if let Some(next) = next {
            if next <= from || next > frontier(record, page_lineage) {
                return Err(transient(
                    "transcript scan cursor did not advance contiguously",
                ));
            }
            from = next;
            continue;
        }
        let head = page.get("head").filter(|v| !v.is_null());
        if let Some(head) = head {
            let ordinal = head
                .get("ordinal")
                .and_then(Value::as_u64)
                .ok_or_else(|| transient("transcript head omitted ordinal"))?;
            if frontier(record, page_lineage) <= ordinal {
                return Err(transient("transcript scan did not reach head"));
            }
        } else if !messages.is_empty() {
            return Err(transient("transcript page omitted head"));
        }
        // An allocation absent at the durable head cannot yet be used. Mark
        // it burned so subsequent requests do not repeatedly read for it.
        if let Some(hook) = &mut record.hook {
            for answer in &hook.answers {
                if !answer.observed {
                    hook.burned.extend(answer.tags.iter().copied());
                }
            }
        }
        storage.save(key, record)?;
        return Ok(());
    }
}
