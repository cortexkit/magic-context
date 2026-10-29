//! The project scope a dream run registers for itself, and the names it mints.
//!
//! A dream run belongs to a project, not to any conversation, so ck-mc
//! registers its own scope for each run with the daemon (`scope.sync`, owner =
//! ck-mc) and selects and sends under it. The rules that scope keeps are the
//! ones the daemon, the runners and routing agreed on:
//!
//! - kind `Ephemeral`, a fresh ref per run and epoch 1;
//! - `project_id` is only ever Entorhinal's answer for that exact folder, never
//!   derived from a path, a git remote or the store's own project key
//!   ([`EntorhinalProjectId`] can only be made from a lookup answer);
//! - `workdir` is the folder the run works in;
//! - no `parent`, and no attributes: a dreamer acts for no agent, so neither
//!   `agent_id` nor `delegates` is set;
//! - when the run calls tools, the chosen runner's principal is listed in
//!   `carriers`, allowed to open routes only to the tool modules the run needs.

use std::hash::{BuildHasher, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use subc_protocol::scope::{ScopeCarrier, ScopeKind, ScopeRecord};
use subc_protocol::Principal;

/// Every routed dream session id starts with this prefix, then
/// `<project_id>:<run>`. Like the older `mc-dream-` prefix, it keeps a route
/// bound to such a session away from the foreground memory facade.
pub const SESSION_PREFIX: &str = "mc-dream:";
/// The ref prefix of a dream run's scope.
pub const SCOPE_REF_PREFIX: &str = "mc-dream-run:";
/// The epoch every dream scope is registered at: each run has a fresh ref, so
/// no ref is ever reused for a second session.
pub const SCOPE_EPOCH: u64 = 1;

/// A project id as Entorhinal answered it for one folder.
///
/// The only constructor takes a lookup answer, so code that has a path or a
/// store key in hand cannot turn it into a scope's project id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntorhinalProjectId(String);

impl EntorhinalProjectId {
    /// Accept Entorhinal's answer for a folder. `None` unless it is a registered
    /// `pj-` id.
    pub fn from_lookup_answer(answer: &str) -> Option<Self> {
        crate::project_identity::is_project_pin(answer).then(|| Self(answer.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// 32 lowercase hex characters, fresh for each call. The standard library's
/// `RandomState` is seeded from the operating system once per process and
/// re-keyed for every instance; mixing in a counter, the clock and the process
/// id makes a collision unlikely even between processes started in the same
/// instant. Unlike reading `/dev/urandom`, this also works on Windows.
pub(crate) fn fresh_id() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let sequence = NEXT.fetch_add(1, Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let half = || {
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_u64(sequence);
        hasher.write_u128(nanos);
        hasher.write_u32(std::process::id());
        hasher.finish()
    };
    format!("{:016x}{:016x}", half(), half())
}

/// The child session one runner run binds: `mc-dream:<project_id>:<run>`, with
/// a fresh run id every time. A runner keys sessions by their name within its
/// harness, so a name reused for a second run (for example a fixed name per
/// task) would land in the earlier run's session.
pub fn session_name(project_id: &EntorhinalProjectId) -> String {
    format!("{SESSION_PREFIX}{}:{}", project_id.as_str(), fresh_id())
}

/// One dream run's scope as ck-mc registers it.
///
/// The record carries the same Entorhinal identity and folder used for binding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DreamScope {
    pub record: ScopeRecord,
    pub project_id: EntorhinalProjectId,
    pub workdir: PathBuf,
}

impl DreamScope {
    /// A fresh scope for one run of a project, in `workdir`.
    pub fn new(project_id: EntorhinalProjectId, workdir: &Path) -> Self {
        Self {
            record: ScopeRecord::new(
                format!("{SCOPE_REF_PREFIX}{}", fresh_id()),
                SCOPE_EPOCH,
                ScopeKind::Ephemeral,
            )
            .with_project_id(Some(project_id.as_str().to_owned()))
            .with_workdir(Some(workdir.to_string_lossy().into_owned())),
            project_id,
            workdir: workdir.to_path_buf(),
        }
    }

    pub fn scope_ref(&self) -> &str {
        &self.record.scope_ref
    }

    /// Let `runner_module` open routes under this scope, only to `tool_modules`.
    /// Replaces any earlier carrier: after a re-select, the runner that was
    /// dropped loses its authority under the scope. No-tool runs list no carrier:
    /// the daemon refuses empty targets, while absent targets grant all modules.
    pub fn carry_for(&mut self, runner_module: &str, tool_modules: Vec<String>) {
        let carriers = if tool_modules.is_empty() {
            Vec::new()
        } else {
            vec![ScopeCarrier::new(Principal::Reserved {
                module_id: runner_module.to_owned(),
            })
            .with_targets(Some(tool_modules))]
        };
        self.record = self.record.clone().with_carriers(carriers);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_tool_runs_have_no_carrier_and_tool_targets_are_exact() {
        let project = EntorhinalProjectId::from_lookup_answer("pj-one").unwrap();
        let mut scope = DreamScope::new(project, Path::new("/project"));
        scope.carry_for("broca", vec![]);
        assert!(scope.record.carriers.is_empty());
        let modules = vec!["code-reader".into(), "magic-context".into()];
        scope.carry_for("broca", modules.clone());
        assert_eq!(scope.record.carriers.len(), 1);
        assert_eq!(
            scope.record.carriers[0].principal,
            Principal::Reserved {
                module_id: "broca".into()
            }
        );
        assert_eq!(scope.record.carriers[0].targets.as_ref(), Some(&modules));
        scope.carry_for("other-runner", vec![]);
        assert!(scope.record.carriers.is_empty());
    }

    #[test]
    fn every_carrier_constructor_sets_explicit_targets() {
        use syn::visit::Visit;
        #[derive(Default)]
        struct Guard {
            constructors: usize,
            fenced: usize,
        }
        fn carrier_new(call: &syn::ExprCall) -> bool {
            let syn::Expr::Path(path) = call.func.as_ref() else {
                return false;
            };
            let names: Vec<_> = path
                .path
                .segments
                .iter()
                .map(|s| s.ident.to_string())
                .collect();
            names == ["ScopeCarrier", "new"]
        }
        impl<'ast> Visit<'ast> for Guard {
            fn visit_macro(&mut self, mac: &'ast syn::Macro) {
                if mac.path.is_ident("vec") {
                    let tokens = &mac.tokens;
                    if let Ok(expression) = syn::parse2::<syn::Expr>(quote::quote!([#tokens])) {
                        let mut nested = Guard::default();
                        nested.visit_expr(&expression);
                        self.constructors += nested.constructors;
                        self.fenced += nested.fenced;
                    }
                }
            }
            fn visit_item_mod(&mut self, module: &'ast syn::ItemMod) {
                if module.ident != "tests" {
                    syn::visit::visit_item_mod(self, module);
                }
            }
            fn visit_expr_call(&mut self, call: &'ast syn::ExprCall) {
                if carrier_new(call) {
                    self.constructors += 1;
                }
                syn::visit::visit_expr_call(self, call);
            }
            fn visit_expr_method_call(&mut self, call: &'ast syn::ExprMethodCall) {
                if call.method == "with_targets"
                    && matches!(call.receiver.as_ref(), syn::Expr::Call(new) if carrier_new(new))
                {
                    let some = matches!(call.args.first(), Some(syn::Expr::Call(arg)) if matches!(arg.func.as_ref(), syn::Expr::Path(path) if path.path.is_ident("Some")));
                    assert!(some, "carrier targets must be explicit, never None");
                    self.fenced += 1;
                }
                syn::visit::visit_expr_method_call(self, call);
            }
        }
        let mut guard = Guard::default();
        for source in [
            include_str!("scope.rs"),
            include_str!("carrier.rs"),
            include_str!("production.rs"),
            include_str!("live.rs"),
            include_str!("runner_port.rs"),
            include_str!("wire.rs"),
            include_str!("fetch_plan.rs"),
            include_str!("registry.rs"),
        ] {
            guard.visit_file(&syn::parse_file(source).unwrap());
        }
        assert!(
            guard.constructors > 0,
            "carrier source guard must inspect a constructor"
        );
        assert_eq!(
            guard.constructors, guard.fenced,
            "every carrier constructor must restrict its targets"
        );
    }

    #[test]
    fn only_a_registered_entorhinal_answer_is_a_project_id() {
        assert!(EntorhinalProjectId::from_lookup_answer("pj-abc_1").is_some());
        for derived in [
            "git:abc",
            "dir:/work/p",
            "/work/p",
            "",
            "pj-",
            "pj-implicit1-x",
        ] {
            assert_eq!(
                EntorhinalProjectId::from_lookup_answer(derived),
                None,
                "{derived}"
            );
        }
    }

    #[test]
    fn session_names_are_fresh_and_carry_the_project() {
        let project = EntorhinalProjectId::from_lookup_answer("pj-one").unwrap();
        let first = session_name(&project);
        let second = session_name(&project);
        assert_ne!(first, second);
        assert!(first.starts_with("mc-dream:pj-one:"), "{first}");
        assert_eq!(first.len(), "mc-dream:pj-one:".len() + 32);
    }
}
