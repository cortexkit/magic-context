use quote::ToTokens;
use std::{collections::HashSet, path::Path};
use syn::visit::{self, Visit};

#[derive(Default)]
struct WireReads {
    aliases: HashSet<String>,
    reads: Vec<String>,
}

fn test_only(attrs: &[syn::Attribute]) -> bool {
    attrs.iter().any(|attr| {
        attr.path().is_ident("test")
            || (attr.path().is_ident("cfg")
                && attr.meta.to_token_stream().to_string().contains("test"))
    })
}

fn wire_identity(expr: &syn::Expr) -> bool {
    match expr {
        syn::Expr::Reference(expr) => wire_identity(&expr.expr),
        syn::Expr::MethodCall(expr) if expr.method == "clone" => wire_identity(&expr.receiver),
        syn::Expr::Field(expr) => {
            matches!(&expr.member, syn::Member::Named(name) if name == "identity")
                && matches!(&*expr.base, syn::Expr::Path(path) if !path.path.is_ident("self"))
        }
        _ => false,
    }
}

impl<'ast> Visit<'ast> for WireReads {
    fn visit_item_mod(&mut self, item: &'ast syn::ItemMod) {
        if !test_only(&item.attrs) {
            visit::visit_item_mod(self, item);
        }
    }
    fn visit_item_fn(&mut self, item: &'ast syn::ItemFn) {
        if !test_only(&item.attrs) {
            self.function(&item.sig, &item.block);
        }
    }
    fn visit_impl_item_fn(&mut self, item: &'ast syn::ImplItemFn) {
        if !test_only(&item.attrs) {
            self.function(&item.sig, &item.block);
        }
    }
    fn visit_local(&mut self, local: &'ast syn::Local) {
        if let (syn::Pat::Ident(name), Some(init)) = (&local.pat, &local.init) {
            if wire_identity(&init.expr) {
                self.aliases.insert(name.ident.to_string());
            }
        }
        visit::visit_local(self, local);
    }
    fn visit_expr_field(&mut self, field: &'ast syn::ExprField) {
        let project = matches!(&field.member, syn::Member::Named(name) if name == "project_root" || name == "project_id");
        let alias = matches!(&*field.base, syn::Expr::Path(path) if path.path.get_ident().is_some_and(|name| self.aliases.contains(&name.to_string())));
        if project && (wire_identity(&field.base) || alias) {
            self.reads.push(field.to_token_stream().to_string());
        }
        visit::visit_expr_field(self, field);
    }
}

impl WireReads {
    fn function(&mut self, sig: &syn::Signature, block: &syn::Block) {
        let previous = std::mem::take(&mut self.aliases);
        for arg in &sig.inputs {
            if let syn::FnArg::Typed(arg) = arg {
                if arg
                    .ty
                    .to_token_stream()
                    .to_string()
                    .contains("BindIdentity")
                    && !arg
                        .ty
                        .to_token_stream()
                        .to_string()
                        .contains("RunnerBindIdentity")
                {
                    if let syn::Pat::Ident(name) = &*arg.pat {
                        self.aliases.insert(name.ident.to_string());
                    }
                }
            }
        }
        self.visit_block(block);
        self.aliases = previous;
    }
}

fn scan(path: &Path, failures: &mut Vec<String>) {
    for entry in std::fs::read_dir(path).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            if path.file_name().unwrap() != "tests" {
                scan(&path, failures);
            }
        } else if path.extension().is_some_and(|ext| ext == "rs")
            && !path.file_name().unwrap().to_string_lossy().contains("test")
        {
            let parsed = syn::parse_file(&std::fs::read_to_string(&path).unwrap()).unwrap();
            let mut visitor = WireReads::default();
            visitor.visit_file(&parsed);
            for read in visitor.reads {
                failures.push(format!("{}: {read}", path.display()));
            }
        }
    }
}

#[test]
fn shipped_code_never_reads_connection_identity_project_fields() {
    let mut failures = Vec::new();
    scan(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
        &mut failures,
    );
    assert!(
        failures.is_empty(),
        "connection project reads: {failures:#?}"
    );
}

#[test]
fn project_read_scan_catches_direct_reads_aliases_and_typed_wire_arguments() {
    let parsed = syn::parse_file("fn direct(req: &RouteBindRequest) { use_root(&req.identity.project_root); let alias = &req.identity; use_root(&alias.project_id); } fn typed(identity: &BindIdentity) { use_root(&identity.project_root); } #[cfg(test)] fn fixture(req: &RouteBindRequest) { use_root(&req.identity.project_root); }").unwrap();
    let mut scan = WireReads::default();
    scan.visit_file(&parsed);
    assert_eq!(scan.reads.len(), 3);
}
