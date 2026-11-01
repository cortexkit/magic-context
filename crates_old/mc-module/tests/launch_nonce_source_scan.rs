//! Census of Rust files under every `crates/*/src` tree in this workspace.
//! Comments, items marked `#[cfg(test)]`, and files under `tests/` are excluded.

use proc_macro2::{TokenStream, TokenTree};
use quote::ToTokens;
use std::{
    fs,
    path::{Path, PathBuf},
};
use syn::{spanned::Spanned, visit::Visit};

const FORBIDDEN: [&str; 4] = [
    "SUBC_LAUNCH_NONCE",
    "SUBC_LAUNCH_NONCE_ENV",
    "LAUNCH_NONCE_FD_ENV",
    "SUBC_LAUNCH_NONCE_FD",
];

#[derive(Default)]
struct TestItems(Vec<(usize, usize)>);
impl<'ast> Visit<'ast> for TestItems {
    fn visit_item(&mut self, item: &'ast syn::Item) {
        // Only the item's own attributes can exclude it. A nested test
        // attribute must not exclude the containing production item.
        let tokens: Vec<_> = item.to_token_stream().into_iter().collect();
        for pair in tokens.chunks(2) {
            if pair.len() != 2 || !matches!(&pair[0], TokenTree::Punct(p) if p.as_char() == '#') {
                break;
            }
            if pair[1].to_string() == "[cfg (test)]" {
                let span = item.span();
                self.0.push((span.start().line, span.end().line));
                return;
            }
        }
        syn::visit::visit_item(self, item);
    }
}

fn tokens_hits(
    tokens: TokenStream,
    excluded: &[(usize, usize)],
    source_lines: &[&str],
    path: &Path,
    hits: &mut Vec<String>,
) {
    let mut tokens = tokens.into_iter().peekable();
    while let Some(token) = tokens.next() {
        // Rust's lexer lowers doc comments to #[doc = "..."]. Check the
        // original source so explicit doc attributes remain subject to the scan.
        let start = token.span().start();
        let is_comment = source_lines[start.line - 1]
            .get(start.column..)
            .is_some_and(|text| text.starts_with("//") || text.starts_with("/*"));
        if is_comment && matches!(&token, TokenTree::Punct(p) if p.as_char() == '#') {
            if matches!(tokens.peek(), Some(TokenTree::Punct(p)) if p.as_char() == '!') {
                tokens.next();
            }
            if matches!(tokens.peek(), Some(TokenTree::Group(g)) if g.stream().to_string().starts_with("doc ="))
            {
                tokens.next();
                continue;
            }
        }
        let line = token.span().start().line;
        if excluded
            .iter()
            .any(|&(start, end)| start <= line && line <= end)
        {
            continue;
        }
        match token {
            TokenTree::Group(group) => {
                tokens_hits(group.stream(), excluded, source_lines, path, hits)
            }
            token => {
                let text = token.to_string();
                if FORBIDDEN.iter().any(|name| text.contains(name)) {
                    hits.push(format!("{}:{line}: {text}", path.display()));
                }
            }
        }
    }
}

fn scan_file(path: &Path) -> Vec<String> {
    let source = fs::read_to_string(path).unwrap();
    let parsed = syn::parse_file(&source).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let mut excluded = TestItems::default();
    excluded.visit_file(&parsed);
    let mut hits = Vec::new();
    // The original token stream preserves source lines; doc comments become
    // attributes in the AST, so scan the lexer output, not the AST's reprinting.
    tokens_hits(
        source.parse().unwrap(),
        &excluded.0,
        &source.lines().collect::<Vec<_>>(),
        path,
        &mut hits,
    );
    hits
}

fn source_files(dir: &Path, files: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            if path.file_name().unwrap() != "tests" {
                source_files(&path, files);
            }
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            files.push(path);
        }
    }
}

fn census(root: &Path) -> (Vec<PathBuf>, Vec<String>) {
    let mut files = Vec::new();
    // Enumerate crate roots, so a new shipped crate cannot silently escape the census.
    for entry in fs::read_dir(root.join("crates")).unwrap() {
        let src = entry.unwrap().path().join("src");
        if src.is_dir() {
            source_files(&src, &mut files);
        }
    }
    files.sort();
    let hits = files.iter().flat_map(|path| scan_file(path)).collect();
    (files, hits)
}

#[test]
fn shipped_source_uses_only_launch_nonce_accessors() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap();
    let (files, hits) = census(root);
    for required in [
        "crates/mc-module/src/historian_producer.rs",
        "crates/mc-module/src/lib.rs",
    ] {
        assert!(
            files.contains(&root.join(required)),
            "census did not visit {required}"
        );
    }
    assert!(
        hits.is_empty(),
        "direct launch nonce names in shipped source (use the SDK launch_nonce accessor):\n{}",
        hits.join("\n")
    );
}

#[test]
fn temp_copy_direct_read_is_found() {
    let temp = tempfile::tempdir().unwrap();
    let src = temp.path().join("crates/mc-module/src");
    fs::create_dir_all(&src).unwrap();
    let original = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/historian_producer.rs");
    fs::copy(original, src.join("historian_producer.rs")).unwrap();
    fs::write(src.join("lib.rs"), "// SUBC_LAUNCH_NONCE\n/// SUBC_LAUNCH_NONCE_ENV\n/* LAUNCH_NONCE_FD_ENV */\n#[cfg(test)]\nmod tests { const NAME: &str = \"SUBC_LAUNCH_NONCE_FD\"; }\nfn planted() { let _ = std::env::var(\"SUBC_LAUNCH_NONCE\"); }\n").unwrap();
    fs::create_dir(src.join("tests")).unwrap();
    fs::write(src.join("tests/fixture.rs"), "SUBC_LAUNCH_NONCE").unwrap();
    let (_, hits) = census(temp.path());
    assert_eq!(hits.len(), 1, "{hits:?}");
    assert!(hits[0].contains("lib.rs:6:"), "{hits:?}");
}
