//! Whether a `verified` verdict is a confirmation the module accepts. The
//! reply cites the lines that state the memory's claim ([`super::spans`]);
//! the module reads them itself, at the commit the batch checked, and checks
//! them together:
//! - every cited span exists: its file is at that commit and has those lines;
//! - every path the memory states, and every name it states that looks like
//!   code ([`super::cites::code_cites`]), appears in some span, a path also
//!   by being a span's file or a folder above it. A product named in prose
//!   (`OpenCode`, `macOS`) need not;
//! - every number the memory states ([`super::numbers`]) appears in some
//!   span in an equal form, or is the left side of a `derive` step whose
//!   arithmetic holds and whose every number appears in some span.
//!
//! A verdict that fails a check counts as a skip, with the failed check as
//! its reason. The live-branch check of a memory without a line of its own
//! runs after these, in the batch ([`super::live`]).

use std::collections::BTreeSet;

use super::cites::{code_cites, Cite};
use super::numbers::{derivations, quantities, same, Quantity};
use super::spans::{lines_of, parse_cites, Cited, Confirmation};
use crate::dreamer::branches::{names, short};
use crate::dreamer::checkout::clean_path;

/// A file read at the checked commit by its cited path: the path from the
/// repository's top and the text, `Ok(None)` when the commit has no such
/// file, `Err` when git could not tell.
pub(crate) type Committed = Result<Option<(String, String)>, String>;

/// How [`confirm`] reads a file at the checked commit.
pub(crate) type ReadFile<'a> = dyn Fn(&str) -> Committed + 'a;

/// The evidence a `verified` verdict rests on, when the module accepts it:
/// `content` is the memory's text as the batch sent it, `top_level` the
/// checkout's top-level names, `cites` and `derive` the verdict's attributes,
/// `commit` the commit the batch checked, and `read` reads a file there.
/// `Err` is the reason it counts as a skip.
pub(crate) fn confirm(
    content: &str,
    top_level: &BTreeSet<String>,
    cites: Option<&str>,
    derive: Option<&str>,
    commit: Option<&str>,
    read: &ReadFile<'_>,
) -> Result<Confirmation, String> {
    let cites = cites
        .map(str::trim)
        .filter(|cites| !cites.is_empty())
        .ok_or("a verified verdict needs cites, the lines that state the claim")?;
    let spans = parse_cites(cites)?;
    let commit = commit.ok_or("the checkout has no commit to read the cited lines at")?;
    let mut cited: Vec<Cited> = Vec::new();
    for span in spans {
        let (path, file) = read(&span.path)
            .map_err(|why| format!("reading {} failed: {why}", span.path))?
            .ok_or_else(|| format!("{} is not a file at {}", span.path, short(commit)))?;
        let text = lines_of(&file, span.start, span.end).map_err(|lines| {
            format!(
                "{}:{}-{} runs past the end of the file, which has {lines} lines",
                span.path, span.start, span.end
            )
        })?;
        cited.push(Cited {
            path,
            start: span.start,
            end: span.end,
            text,
        });
    }
    check_names(content, top_level, &cited)?;
    let derive = derive.map(str::trim).filter(|derive| !derive.is_empty());
    check_numbers(content, derive, &cited)?;
    Ok(Confirmation {
        commit: commit.to_owned(),
        spans: cited,
        derive: derive.map(str::to_owned),
    })
}

/// Every path `content` states, and every name in it that looks like code,
/// appears in some span of `cited`; `Err` names the first that doesn't.
fn check_names(content: &str, top_level: &BTreeSet<String>, cited: &[Cited]) -> Result<(), String> {
    for cite in code_cites(content, top_level) {
        let found = match &cite {
            Cite::Name(name) => cited
                .iter()
                .any(|span| span.text.contains(name.as_str()) || span.path.contains(name.as_str())),
            Cite::Path(path) => cited.iter().any(|span| {
                span.text.contains(path.as_str())
                    || clean_path(path).is_some_and(|path| names(&path, &span.path))
            }),
        };
        if !found {
            return Err(format!(
                "{}, which the memory names, is in none of the cited lines",
                cite.text()
            ));
        }
    }
    Ok(())
}

/// Every number `content` states appears in some span of `cited` in an
/// equal form, or is computed by a step of `derive` from numbers the spans
/// hold; `Err` says which check failed.
fn check_numbers(content: &str, derive: Option<&str>, cited: &[Cited]) -> Result<(), String> {
    let stated = quantities(content);
    let held: Vec<Quantity> = cited
        .iter()
        .flat_map(|span| quantities(&span.text))
        .collect();
    let in_spans = |quantity: &Quantity| held.iter().any(|found| same(quantity, found));
    let steps = match derive {
        Some(derive) => derivations(derive)?,
        None => Vec::new(),
    };
    for step in &steps {
        if !stated.iter().any(|quantity| same(quantity, &step.result)) {
            return Err(format!(
                "derive computes {}, which is not a number the memory states",
                step.result.raw
            ));
        }
        if let Some(input) = step.inputs.iter().find(|input| !in_spans(input)) {
            return Err(format!(
                "derive uses {}, which is in none of the cited lines",
                input.raw
            ));
        }
    }
    for quantity in &stated {
        if !in_spans(quantity) && !steps.iter().any(|step| same(quantity, &step.result)) {
            return Err(format!(
                "the number {} the memory states is in none of the cited lines, in any equal form",
                quantity.raw
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "confirm_tests.rs"]
mod tests;
