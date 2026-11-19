//! Edits to the user's settings, addressed by JSON pointer (RFC 6901), as
//! the conversion of a 0.49 settings file produces them
//! ([`super::convert::convert_0_49`]).
//!
//! [`apply`] changes a parsed value; [`super::jsonc::edit`] makes the same
//! change to the file's text, keeping its comments and layout.

use serde_json::{Map, Value};

/// One change to the settings.
#[derive(Clone, Debug, PartialEq)]
pub enum Edit {
    /// Write `value` at `pointer`, replacing what is there and creating the
    /// objects on the way that do not exist yet.
    Set { pointer: String, value: Value },
    /// Remove the member at `pointer`; nothing happens when it is absent.
    Remove { pointer: String },
    /// Give the member at `pointer` the key `to` in the same object, keeping
    /// its value (and, in a file, the comments around it).
    Rename { pointer: String, to: String },
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

    pub fn rename(pointer: impl Into<String>, to: impl Into<String>) -> Self {
        Self::Rename {
            pointer: pointer.into(),
            to: to.into(),
        }
    }

    /// The pointer the edit starts from.
    pub fn pointer(&self) -> &str {
        match self {
            Self::Set { pointer, .. } | Self::Remove { pointer } | Self::Rename { pointer, .. } => {
                pointer
            }
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

/// Make `edit` on `value`, an object.
pub fn apply(value: &mut Value, edit: &Edit) -> Result<(), String> {
    let keys = keys(edit.pointer())?;
    let Some((last, parents)) = keys.split_last() else {
        return Err("an edit must name a member, not the whole file".into());
    };
    match edit {
        Edit::Set { value: new, .. } => {
            let mut object = as_object(value, edit.pointer())?;
            for key in parents {
                let entry = object
                    .entry(key.clone())
                    .or_insert_with(|| Value::Object(Map::new()));
                object = as_object(entry, edit.pointer())?;
            }
            object.insert(last.clone(), new.clone());
        }
        Edit::Remove { .. } => {
            if let Some(object) = parent_object(value, parents) {
                object.remove(last);
            }
        }
        Edit::Rename { to, .. } => {
            let object = parent_object(value, parents)
                .ok_or_else(|| format!("{} does not exist", edit.pointer()))?;
            if object.contains_key(to) {
                return Err(format!("{} already has a member {to:?}", edit.pointer()));
            }
            let moved = object
                .remove(last)
                .ok_or_else(|| format!("{} does not exist", edit.pointer()))?;
            object.insert(to.clone(), moved);
        }
    }
    Ok(())
}

/// Make every edit, in order, on a copy of `value`.
pub fn applied(value: &Value, edits: &[Edit]) -> Result<Value, String> {
    let mut value = value.clone();
    for edit in edits {
        apply(&mut value, edit)?;
    }
    Ok(value)
}

fn as_object<'a>(
    value: &'a mut Value,
    pointer: &str,
) -> Result<&'a mut Map<String, Value>, String> {
    value
        .as_object_mut()
        .ok_or_else(|| format!("{pointer} passes through a value that is not an object"))
}

fn parent_object<'a>(
    value: &'a mut Value,
    parents: &[String],
) -> Option<&'a mut Map<String, Value>> {
    let mut object = value.as_object_mut()?;
    for key in parents {
        object = object.get_mut(key)?.as_object_mut()?;
    }
    Some(object)
}
