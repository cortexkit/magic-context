//! Conversation identity and durable tool catalogs shared by provider engines.
use super::*;
use serde::Deserialize;

/// A runner conversation's identity: the attested runner, Setup's harness and
/// Setup's session (compaction-provider contract §1). The project folder is
/// route metadata and never part of it, so every spelling of one folder (a
/// symlink, `/var` and `/private/var`, a trailing slash) reaches the same state.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Key {
    /// The bare module id of the daemon-attested runner principal, exactly as
    /// the daemon stamped it, never a `reserved:` display form.
    pub runner: String,
    pub session: String,
    pub harness: String,
}

/// The bare module id of the runner the daemon attested on `binding`'s route,
/// or `None` when the caller is not a reserved module. The id comes only from
/// the daemon-stamped principal, never from a request body.
pub(crate) fn attested_runner(binding: &SessionBinding) -> Option<&str> {
    match &binding.principal {
        Some(subc_protocol::Principal::Reserved { module_id }) => Some(module_id),
        _ => None,
    }
}

impl Key {
    /// `session` and `harness` are kept exactly as given: the session reference
    /// hashes them without normalisation, so trimming here would key the same
    /// session differently from a caller that hashes the raw value.
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
        let runner = attested_runner(binding)
            .ok_or_else(|| invalid_field("compaction_mode", "async requires an attested runner"))?;
        Ok(Self {
            runner: runner.into(),
            session: session.into(),
            harness: harness.into(),
        })
    }

    /// The conversation's session reference (llm-runner §14.1), the key of
    /// every piece of state ck-mc keeps for it.
    pub fn reference(&self) -> String {
        cortexkit_role_llm_runner::session_ref(&cortexkit_role_llm_runner::SessionIdentity {
            runner: &self.runner,
            harness: &self.harness,
            session: &self.session,
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

    /// The engine namespace shared by facade tools and async compaction. A first
    /// Setup uses generation zero, so notes written before Setup remain in scope.
    pub(crate) fn async_namespace(&self, generation: u64) -> String {
        format!("{}:async:{generation}", self.engine_key())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Catalog {
    pub compacting: bool,
    pub tools: BTreeSet<String>,
}

/// A typed adapter over the handler's main store slot. It owns no connection,
/// policy or schema: store open and migrations finish before the slot is filled.
pub struct Storage {
    store: Arc<OnceLock<Arc<McStore>>>,
    /// If storage cannot record admission, the process remembers that fact until
    /// a full successful refetch. Discovery still serves its unchanged bytes.
    catalog_failures: Mutex<BTreeMap<(PathBuf, String), String>>,
    pub(crate) async_runtime: super::async_provider::Runtime,
}

impl Storage {
    pub fn new(store: Arc<OnceLock<Arc<McStore>>>) -> Self {
        Self {
            store,
            catalog_failures: Mutex::new(BTreeMap::new()),
            async_runtime: Default::default(),
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

    pub fn tool_key(&self, binding: &SessionBinding) -> Result<Key, HandlerOutcome> {
        if let Some(refusal) = self.catalog_refusal(binding, &binding.session) {
            return Err(refusal);
        }
        let keys = self
            .store()?
            .provider_session_keys(
                &binding.project_root.to_string_lossy(),
                binding.session.trim(),
            )
            .map_err(transient)?;
        let [key] = keys.as_slice() else {
            return Err(session_unresolved_error());
        };
        Key::new(binding, &binding.session, &key.harness)
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
    /// The store's provider key for this conversation. Its first column is
    /// named `project_root` for the folder-keyed records that share these
    /// tables; a runner conversation stores its runner module id there
    /// instead, so no folder enters the key. A module id is never an absolute
    /// path, so the two kinds of record cannot collide.
    pub fn store_key(&self) -> mc_store::ProviderSessionKey {
        mc_store::ProviderSessionKey {
            project_root: self.runner.clone(),
            session: self.session.clone(),
            harness: self.harness.clone(),
            generation: None,
        }
    }
}
