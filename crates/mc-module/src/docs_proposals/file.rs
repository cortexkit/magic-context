//! The markdown copy of a pending proposal in the project's main checkout,
//! `.cortexkit/magic-context/docs-update-proposals/<id>.md`.
//!
//! A head agent has no tool that reads proposals, and a notice carries no
//! text, so the copy is how an agent reads what to apply: for each document
//! the unified diff, then every kept change with its whole new section and
//! its reason, as the 0.49 plugin wrote them. It exists only while its
//! proposal is pending. Projects that use `.cortexkit/` ignore that folder in
//! git; the module never edits a `.gitignore`. Writing or removing it never
//! fails the run or read that does it: the failure is logged.

use std::io::Write;
use std::path::{Path, PathBuf};

use super::{DocumentResult, NewProposal, DOCUMENTS};

/// The folder of the copies, relative to the main checkout.
pub(crate) const FOLDER: &str = ".cortexkit/magic-context/docs-update-proposals";

/// The copy of proposal `id`, relative to the main checkout.
pub(crate) fn relative(id: i64) -> String {
    format!("{FOLDER}/{id}.md")
}

/// The copy of proposal `id` in `checkout`.
pub(crate) fn path(checkout: &Path, id: i64) -> PathBuf {
    checkout.join(relative(id))
}

/// A code fence longer than any run of backticks in `text`, so the text
/// can't close it early.
fn fence(text: &str) -> String {
    let mut longest = 0;
    let mut run = 0;
    for c in text.chars() {
        if c == '`' {
            run += 1;
            longest = longest.max(run);
        } else {
            run = 0;
        }
    }
    "`".repeat(longest.max(2) + 1)
}

/// The copy's text: the proposal's base, then each changed document's diff
/// and its changes.
pub(crate) fn markdown(id: i64, proposal: &NewProposal, tokens: u64, budget: u64) -> String {
    let mut text = format!(
        "# Docs update proposal {id}\n\nProject: {}\nBase commit: {}\n",
        proposal.project, proposal.base_commit
    );
    for document in &proposal.documents {
        text.push_str(&format!(
            "Base SHA-256 {}: {}\n",
            document.name,
            document.base.as_deref().map_or_else(
                || "(missing)".to_owned(),
                |base| super::sha256(base.as_bytes())
            )
        ));
    }
    text.push_str(&format!("Resulting tokens: {tokens} / {budget}\n"));
    for name in DOCUMENTS {
        let changes: Vec<_> = proposal
            .changes
            .iter()
            .filter(|change| change.file == name)
            .collect();
        if changes.is_empty() {
            continue;
        }
        let diff = proposal
            .documents
            .iter()
            .find(|document| document.name == name)
            .map_or("", |document: &DocumentResult| document.diff.as_str());
        let diff = diff.trim_end_matches('\n');
        let outer = fence(diff);
        text.push_str(&format!("\n## {name}\n\n{outer}diff\n{diff}\n{outer}\n"));
        for change in changes {
            let section = change.text.trim_end_matches('\n');
            let outer = fence(section);
            text.push_str(&format!(
                "\n### {} {}\n\nReason: {}\n",
                change.action, change.heading, change.reason
            ));
            if !section.is_empty() {
                text.push_str(&format!("\n{outer}markdown\n{section}\n{outer}\n"));
            }
        }
    }
    text
}

/// Write `text` as the copy of proposal `id` in `checkout`, creating the
/// folder when missing. The text goes to a temporary file in the same folder
/// first and is renamed into place, so a reader never sees half of it.
pub(crate) fn write(checkout: &Path, id: i64, text: &str) -> Result<PathBuf, String> {
    let target = path(checkout, id);
    let folder = target.parent().expect("the copy has a folder");
    std::fs::create_dir_all(folder).map_err(|error| format!("{}: {error}", folder.display()))?;
    let temporary = folder.join(format!(".{id}.md.{}.tmp", std::process::id()));
    let written = (|| {
        let mut file = std::fs::File::create(&temporary)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        std::fs::rename(&temporary, &target)
    })();
    if let Err(error) = written {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("{}: {error}", target.display()));
    }
    Ok(target)
}

/// Write the copy of a proposal just stored, logging a failure.
pub(crate) fn write_logged(id: i64, proposal: &NewProposal, tokens: u64, budget: u64) {
    let text = markdown(id, proposal, tokens, budget);
    if let Err(error) = write(Path::new(&proposal.checkout), id, &text) {
        tracing::warn!(
            "ck-mc: dreamer: docs proposal {id} of {}: its markdown copy wasn't written: {error}",
            proposal.project
        );
    }
}

/// Remove the copy of proposal `id` from `checkout`, if it is there.
pub(crate) fn remove(checkout: &Path, id: i64) {
    let target = path(checkout, id);
    match std::fs::remove_file(&target) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => tracing::warn!(
            "ck-mc: docs proposal {id}: its markdown copy {} wasn't removed: {error}",
            target.display()
        ),
    }
}
