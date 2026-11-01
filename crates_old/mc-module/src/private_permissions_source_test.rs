use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use quote::ToTokens;
use syn::spanned::Spanned;
use syn::visit::{self, Visit};
use syn::{
    Attribute, Expr, ExprCall, ExprMethodCall, ImplItemFn, Item, ItemFn, ItemMod, Local, Pat,
};

#[derive(Default)]
struct DirectCreatorScan {
    calls: Vec<String>,
}

fn cfg_test(attrs: &[Attribute]) -> bool {
    attrs.iter().any(|attribute| {
        let tokens = attribute.meta.to_token_stream().to_string();
        attribute.path().is_ident("test")
            || (attribute.path().is_ident("cfg") && tokens.contains("test"))
    })
}

impl<'ast> Visit<'ast> for DirectCreatorScan {
    fn visit_item_mod(&mut self, item: &'ast ItemMod) {
        if cfg_test(&item.attrs) {
            return;
        }
        visit::visit_item_mod(self, item);
    }

    fn visit_item_fn(&mut self, item: &'ast ItemFn) {
        if cfg_test(&item.attrs) {
            return;
        }
        visit::visit_item_fn(self, item);
    }

    fn visit_impl_item_fn(&mut self, item: &'ast ImplItemFn) {
        if cfg_test(&item.attrs) {
            return;
        }
        visit::visit_impl_item_fn(self, item);
    }

    fn visit_expr_call(&mut self, call: &'ast ExprCall) {
        if let Expr::Path(path) = call.func.as_ref() {
            let names = path
                .path
                .segments
                .iter()
                .map(|segment| segment.ident.to_string())
                .collect::<Vec<_>>();
            let last = names.last().map(String::as_str).unwrap_or_default();
            let filesystem_path = names.first().is_some_and(|first| first == "fs")
                || names.starts_with(&["std".to_string(), "fs".to_string()]);
            if filesystem_path && matches!(last, "create_dir" | "create_dir_all" | "write")
                || (last == "create" && names.iter().any(|name| name == "File"))
            {
                self.calls.push(names.join("::"));
            }
        }
        visit::visit_expr_call(self, call);
    }

    fn visit_expr_method_call(&mut self, call: &'ast ExprMethodCall) {
        if matches!(call.method.to_string().as_str(), "create" | "create_new") {
            self.calls
                .push(format!("file-creator::{method}", method = call.method));
        }
        visit::visit_expr_method_call(self, call);
    }
}

fn rust_sources(root: &Path, output: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if path.file_name().is_some_and(|name| name == "tests") {
                continue;
            }
            rust_sources(&path, output);
        } else if path.extension().is_some_and(|extension| extension == "rs")
            && !path
                .file_name()
                .is_some_and(|name| name.to_string_lossy().contains("test"))
        {
            output.push(path);
        }
    }
}

#[test]
fn data_store_creators_use_the_private_permission_helper() {
    let mc_module = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mc_store = Path::new(env!("CARGO_MANIFEST_DIR")).join("../mc-store/src");
    let dashboard =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/dashboard/src-tauri/src");
    let mut sources = Vec::new();
    for root in [&mc_module, &mc_store, &dashboard] {
        rust_sources(root, &mut sources);
    }

    let mut offenders = Vec::new();
    for path in sources {
        // These files are themselves permission helpers. Dashboard config is a
        // separate atomic config writer whose OpenOptionsExt mode is applied at create.
        if path.ends_with("mc-store/src/private_permissions.rs")
            || path.ends_with("packages/dashboard/src-tauri/src/config.rs")
        {
            continue;
        }
        let Ok(source) = fs::read_to_string(&path) else {
            continue;
        };
        let calls = direct_store_creators(&source);
        if !calls.is_empty() {
            offenders.push(format!("{}: {}", path.display(), calls.join(", ")));
        }
    }

    assert!(
        offenders.is_empty(),
        "direct store creators bypass helper: {offenders:#?}"
    );
}

/// The direct filesystem creators in one storage-related source file, outside
/// test code. A file that names no store location is not scanned.
fn direct_store_creators(source: &str) -> Vec<String> {
    if ![
        "context.db",
        "store.db",
        "backup_dir",
        "storage_dir",
        "project-identities",
    ]
    .iter()
    .any(|marker| source.contains(marker))
    {
        return Vec::new();
    }
    let Ok(parsed) = syn::parse_file(source) else {
        return Vec::new();
    };
    let mut scan = DirectCreatorScan::default();
    for item in &parsed.items {
        if let Item::Mod(module) = item {
            if cfg_test(&module.attrs) {
                continue;
            }
        }
        scan.visit_item(item);
    }
    scan.calls
}

/// The shipped sources hold no violation, so the scan above would pass even if
/// it could no longer see one. This planted file proves it still flags every
/// kind of direct creator, and still ignores the same calls in test code.
#[test]
fn the_creator_scan_flags_planted_direct_store_creators() {
    let planted = r#"
        const STORE: &str = "context.db";
        fn open_store(dir: &std::path::Path) {
            std::fs::create_dir_all(dir).unwrap();
            std::fs::write(dir.join(STORE), b"").unwrap();
            let _ = std::fs::File::create(dir.join("store.db"));
            let _ = std::fs::OpenOptions::new().write(true).create_new(true).open(dir);
        }
        #[cfg(test)]
        mod tests {
            fn fixture() {
                std::fs::write("context.db", b"").unwrap();
            }
        }
    "#;
    assert_eq!(
        direct_store_creators(planted),
        vec![
            "std::fs::create_dir_all".to_string(),
            "std::fs::write".to_string(),
            "std::fs::File::create".to_string(),
            "file-creator::create_new".to_string(),
        ],
        "the scan must flag each planted direct creator and nothing in test code"
    );
}

#[derive(Default)]
struct DirectBuildBinarySpawnScan {
    offenders: Vec<String>,
    unsafe_locals: Vec<HashSet<String>>,
}

impl<'ast> Visit<'ast> for DirectBuildBinarySpawnScan {
    fn visit_block(&mut self, block: &'ast syn::Block) {
        self.unsafe_locals.push(HashSet::new());
        visit::visit_block(self, block);
        self.unsafe_locals.pop();
    }

    fn visit_local(&mut self, local: &'ast Local) {
        if let (Pat::Ident(binding), Some(initializer)) = (&local.pat, &local.init) {
            if !self.is_staging_expression(&initializer.expr)
                && self.is_unsafe_executable_expression(&initializer.expr)
            {
                if let Some(scope) = self.unsafe_locals.last_mut() {
                    scope.insert(binding.ident.to_string());
                }
            }
        }
        visit::visit_local(self, local);
    }

    fn visit_expr_call(&mut self, call: &'ast ExprCall) {
        if let Expr::Path(path) = call.func.as_ref() {
            let names = path
                .path
                .segments
                .iter()
                .map(|segment| segment.ident.to_string())
                .collect::<Vec<_>>();
            if names.last().is_some_and(|name| name == "new")
                && names.iter().any(|name| name == "Command")
            {
                if let Some(executable) = call.args.first() {
                    let tokens = executable.to_token_stream().to_string();
                    if self.is_unsafe_executable_expression(executable) {
                        let line = executable.span().start().line;
                        self.offenders.push(format!("line {line}: {tokens}"));
                    }
                }
            }
        }
        visit::visit_expr_call(self, call);
    }
}

impl DirectBuildBinarySpawnScan {
    fn is_staging_expression(&self, expression: &Expr) -> bool {
        if let Expr::MethodCall(call) = expression {
            return self.is_staging_expression(&call.receiver);
        }
        let Expr::Call(call) = expression else {
            return false;
        };
        matches!(
            call.func.as_ref(),
            Expr::Path(path)
                if path.path.segments.last().is_some_and(|segment| {
                    matches!(
                        segment.ident.to_string().as_str(),
                        "stage_executable" | "ensure_binary" | "dev_named_binary" | "dev_named_binary_as"
                    )
                })
        )
    }

    fn is_unsafe_executable_expression(&self, expression: &Expr) -> bool {
        if self.is_staging_expression(expression) {
            return false;
        }
        let tokens = expression.to_token_stream().to_string();
        let is_cargo_binary = tokens.contains("CARGO_BIN_EXE_");
        let is_target_binary = tokens.contains("target")
            && ["ck-mc", "ck-subc", "ckdev-", "slow_transform_probe"]
                .iter()
                .any(|binary| tokens.contains(binary));
        is_cargo_binary
            || is_target_binary
            || self.unsafe_locals.iter().any(|scope| {
                scope.iter().any(|name| {
                    tokens
                        .split(|character: char| {
                            !character.is_ascii_alphanumeric() && character != '_'
                        })
                        .any(|token| token == name)
                })
            })
    }
}

fn rust_sources_including_tests(root: &Path, output: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if !matches!(
                path.file_name().and_then(|name| name.to_str()),
                Some("target" | ".git")
            ) {
                rust_sources_including_tests(&path, output);
            }
        } else if path.extension().is_some_and(|extension| extension == "rs") {
            output.push(path);
        }
    }
}

fn direct_build_binary_spawns(source: &str) -> Vec<String> {
    let Ok(parsed) = syn::parse_file(source) else {
        return vec!["source did not parse as Rust".to_string()];
    };
    let mut scan = DirectBuildBinarySpawnScan::default();
    scan.visit_file(&parsed);
    scan.offenders
}

#[test]
fn binary_spawn_paths_are_staged_before_exec() {
    let repository = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap();
    let mut sources = Vec::new();
    rust_sources_including_tests(&repository.join("crates"), &mut sources);
    let mut offenders = Vec::new();
    for path in sources {
        let source = fs::read_to_string(&path).expect("read Rust source for executable scan");
        offenders.extend(
            direct_build_binary_spawns(&source)
                .into_iter()
                .map(|finding| format!("{}: {finding}", path.display())),
        );
    }
    assert!(
        offenders.is_empty(),
        "child processes must not execute a Cargo binary or target path directly: {offenders:#?}"
    );
}

#[test]
fn binary_spawn_scan_rejects_direct_build_artifacts() {
    let planted = r#"
        fn bad(cargo_target: &std::path::Path) {
            let _ = std::process::Command::new(env!("CARGO_BIN_EXE_ck-mc")).spawn();
            let _ = std::process::Command::new(cargo_target.join("debug/ck-subc")).spawn();
            let cargo_binary = env!("CARGO_BIN_EXE_ck-mc");
            let _ = std::process::Command::new(cargo_binary).spawn();
            let target_binary = cargo_target.join("debug/ck-subc");
            let _ = std::process::Command::new(target_binary).spawn();
        }
    "#;
    assert_eq!(
        direct_build_binary_spawns(planted).len(),
        4,
        "the guard must see Cargo-provided binaries and target-directory paths"
    );
}
