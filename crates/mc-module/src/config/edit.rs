//! Edits to the user's settings, addressed by JSON pointer (RFC 6901), as
//! the conversion of a 0.49 settings file produces them
//! ([`super::convert::convert_0_49`]).
//!
//! [`apply`] sends the plan to `subc_jsonc`, which keeps comments and layout
//! outside the edited members.

use serde_json::Value;
use subc_jsonc::Edit as JsoncEdit;

/// One change to the settings.
#[derive(Clone, Debug, PartialEq)]
pub enum Edit {
    /// Write `value` at `pointer`, replacing what is there and creating the
    /// objects on the way that do not exist yet.
    Set { pointer: String, value: Value },
    /// Remove the member at `pointer`; nothing happens when it is absent.
    Remove { pointer: String },
    /// Change the key and value in place, keeping the comments around it.
    RenameAndSet {
        pointer: String,
        to: String,
        value: Value,
    },
}

impl Edit {
    pub fn set(pointer: impl Into<String>, value: Value) -> Self {
        Self::Set {
            pointer: pointer.into(),
            value,
        }
    }

    pub fn remove(pointer: impl Into<String>) -> Self {
        Self::Remove {
            pointer: pointer.into(),
        }
    }

    pub fn rename_and_set(pointer: impl Into<String>, to: impl Into<String>, value: Value) -> Self {
        Self::RenameAndSet {
            pointer: pointer.into(),
            to: to.into(),
            value,
        }
    }

    /// The pointer the edit starts from.
    fn pointer(&self) -> &str {
        match self {
            Self::Set { pointer, .. }
            | Self::Remove { pointer }
            | Self::RenameAndSet { pointer, .. } => pointer,
        }
    }
}

/// The keys a pointer names, unescaped (`~1` is `/`, `~0` is `~`).
pub fn keys(pointer: &str) -> Result<Vec<String>, String> {
    if pointer.is_empty() {
        return Ok(Vec::new());
    }
    let rest = pointer
        .strip_prefix('/')
        .ok_or_else(|| format!("{pointer:?} is not a JSON pointer"))?;
    Ok(rest
        .split('/')
        .map(|key| key.replace("~1", "/").replace("~0", "~"))
        .collect())
}

/// The pointer to `key` inside the member at `parent`.
pub fn child(parent: &str, key: &str) -> String {
    format!("{parent}/{}", key.replace('~', "~0").replace('/', "~1"))
}

/// Return converted text only if the entire plan succeeds.
pub(super) fn apply(text: &str, edits: &[Edit]) -> Result<String, String> {
    // The shared JSONC tokenizer does not accept a leading UTF-8 byte order mark.
    let bom = '\u{feff}';
    let mut document = text.strip_prefix(bom).unwrap_or(text).to_owned();
    for edit in edits {
        let keys = keys(edit.pointer())?;
        let path: Vec<_> = keys.iter().map(String::as_str).collect();
        match edit {
            Edit::Set { value, .. } => subc_jsonc::set_member(&mut document, &path, value)?,
            Edit::Remove { .. } => {
                subc_jsonc::remove_member(&mut document, &path).map_err(|reason| {
                    if reason.ends_with(" is written more than once") {
                        repeated_key(edit.pointer())
                    } else {
                        reason
                    }
                })?;
            }
            Edit::RenameAndSet { to, value, .. } => {
                let mut target = path.clone();
                let last = target.last_mut().ok_or("an edit must name a member")?;
                *last = to;
                subc_jsonc::apply_edits(
                    &mut document,
                    &[
                        JsoncEdit::RenameMember {
                            path: &path,
                            key: to,
                        },
                        JsoncEdit::SetMember {
                            path: &target,
                            value,
                        },
                    ],
                )
                .map_err(|reason| {
                    // The planner only renames to an absent key, so a conflict
                    // means the old key occurs more than once.
                    if reason.ends_with(" has a conflicting key") {
                        repeated_key(edit.pointer())
                    } else {
                        reason
                    }
                })?;
            }
        }
    }
    if text.starts_with(bom) {
        document.insert(0, bom);
    }
    if let Some(issue) = super::jsonc::parse(&document).issue {
        return Err(format!(
            "the converted text would have a syntax issue at {issue}"
        ));
    }
    Ok(document)
}

fn repeated_key(pointer: &str) -> String {
    format!("{pointer} is written more than once; the conversion left the file unchanged. Remove the extra copies and restart Magic Context.")
}
