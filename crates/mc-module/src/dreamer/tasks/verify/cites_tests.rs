use super::*;

fn texts(content: &str) -> Vec<String> {
    cites(content)
        .iter()
        .map(|cite| match cite {
            Cite::Path(text) => format!("path:{text}"),
            Cite::Name(text) => format!("name:{text}"),
        })
        .collect()
}

#[test]
fn a_memory_cites_spans_paths_and_code_names_in_order() {
    assert_eq!(
        texts(
            "Use `transform_route_retired` from crates/mc-module/src/dreamer/task.rs and \
             `ContextDb::open()`; the McStore type, the run_git helper and the mc-module \
             crate, see verify.rs."
        ),
        [
            "name:transform_route_retired",
            "path:crates/mc-module/src/dreamer/task.rs",
            "name:ContextDb::open",
            "name:McStore",
            "name:run_git",
            "name:mc-module",
            "path:verify.rs",
        ]
    );
}

#[test]
fn plain_english_ids_urls_and_placeholders_are_not_citations() {
    for content in [
        "A read-only, long-lived and built-in rule. Never ask twice.",
        "Ufuk ruled it (ask_a0ff68d975ba1b60) at commit ad354a36fa.",
        "See https://docs.example.com/guide/a.md and ~/.local/share/cortexkit/x.db.",
        "Keys look like `dream-run:<id>:…` and `ctx_reduce(drop=…)`; use `never`.",
        "It works and/or fails on 2026-11-13 with node.js.",
        "The package @cortexkit/claustrum-client",
    ] {
        let found = texts(content);
        assert!(
            found.iter().all(|cite| !cite.contains("read-only")
                && !cite.contains("ask_")
                && !cite.contains("docs.example")
                && !cite.contains(".local")
                && !cite.contains('<')
                && !cite.contains("name:never")
                && !cite.contains("and/or")
                && !cite.contains("2026")
                && !cite.contains("node.js")
                && !cite.contains("path:@cortexkit")),
            "{content}: {found:?}"
        );
    }
    // Tokens inside a skipped span are still read on their own.
    assert_eq!(
        texts("Keys look like `dream-run:<id>:…`."),
        ["name:dream-run"]
    );
    assert_eq!(
        texts("The package @cortexkit/claustrum-client"),
        ["name:claustrum-client"]
    );
}

#[test]
fn a_memory_cites_each_thing_once_and_at_most_sixteen() {
    assert_eq!(
        texts("`run_git` and run_git and `run_git`"),
        ["name:run_git"]
    );
    let many: String = (0..30).map(|n| format!("name_{n} ")).collect();
    assert_eq!(cites(&many).len(), MAX_CITES);
}

#[test]
fn shapes_for_a_missing_citation() {
    for path in [
        "src/old/module.rs",
        "Cargo.toml",
        "crates/mc-module",
        "a/b/c",
    ] {
        assert!(path_shaped(path), "{path}");
    }
    for not_path in ["and/or", "src/shared", "/etc/x.rs", "node.js", "@x/y-z"] {
        assert!(!path_shaped(not_path), "{not_path}");
    }
    for name in ["transform_route_retired", "McStore", "mc-module", "$ref_x"] {
        assert!(name_shaped(name), "{name}");
    }
    for not_name in [
        "ContextDb::open",
        "m.revision",
        "the old module",
        "abc",
        "9lives",
        "ask_a0ff68d975ba1b60",
    ] {
        assert!(!name_shaped(not_name), "{not_name}");
    }
}
