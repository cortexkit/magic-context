use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub(super) type Verdicts = BTreeMap<i64, Value>;

pub(super) fn submit(
    out: &Path,
    ids: &[i64],
    current: &mut Verdicts,
    input: Value,
) -> Result<String, String> {
    let list = input
        .as_object()
        .filter(|object| object.len() == 1)
        .and_then(|object| object.get("verdicts"))
        .and_then(Value::as_array)
        .filter(|list| !list.is_empty())
        .ok_or("submit needs a non-empty verdicts array")?;
    let mut next = current.clone();
    let mut problems = Vec::new();
    for (index, item) in list.iter().enumerate() {
        let checked = serde_json::from_value::<Entry>(item.clone())
            .map_err(|e| e.to_string())
            .and_then(|entry| entry.check(ids));
        match checked {
            Ok(id) => {
                next.insert(id, item.clone());
            }
            Err(error) => problems.push(format!(
                "verdicts[{index}] (id {}): {error}",
                item.get("id").unwrap_or(&Value::Null)
            )),
        }
    }
    if !problems.is_empty() {
        return Err(problems.join("; "));
    }
    write(out, ids, &next)?;
    *current = next;
    let missing = missing(ids, current);
    let mut reply = format!(
        "recorded {}; {} of {} still open",
        list.len(),
        missing.len(),
        ids.len()
    );
    if !missing.is_empty() && missing.len() <= 20 {
        reply.push_str(&format!(
            "; missing ids: {}",
            missing
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    Ok(reply)
}

pub(super) fn missing(ids: &[i64], current: &Verdicts) -> Vec<i64> {
    ids.iter()
        .copied()
        .filter(|id| !current.contains_key(id))
        .collect()
}

pub(super) fn write(out: &Path, ids: &[i64], current: &Verdicts) -> Result<(), String> {
    write_json(
        out,
        "verdicts.json",
        &ids.iter()
            .filter_map(|id| current.get(id))
            .collect::<Vec<_>>(),
    )
}

pub(super) fn write_json(out: &Path, name: &str, value: &impl Serialize) -> Result<(), String> {
    let path = out.join(name);
    let staging = out.join(format!(".{name}.new"));
    let file = File::create_new(&staging).map_err(|e| format!("{}: {e}", staging.display()))?;
    // The previous answer stays valid if the process dies during a write.
    let mut writer = BufWriter::new(file);
    let result = serde_json::to_writer_pretty(&mut writer, value)
        .map_err(|e| e.to_string())
        .and_then(|()| {
            writer
                .write_all(b"\n")
                .and_then(|()| writer.flush())
                .and_then(|()| writer.get_ref().sync_all())
                .map_err(|e| e.to_string())
        });
    drop(writer);
    let result = result.and_then(|()| fs::rename(&staging, &path).map_err(|e| e.to_string()));
    if let Err(error) = result {
        let _ = fs::remove_file(staging);
        return Err(format!("{}: {error}", path.display()));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    id: i64,
    verdict: Verdict,
    into: Option<i64>,
    new_text: Option<String>,
    #[serde(rename = "life")]
    _life: Life,
    #[serde(rename = "proof")]
    _proof: Proof,
    #[serde(rename = "evidence")]
    _evidence: Vec<Evidence>,
    note: String,
}

impl Entry {
    fn check(self, ids: &[i64]) -> Result<i64, String> {
        if !ids.contains(&self.id) {
            return Err(format!("unknown memory id {}", self.id));
        }
        match (self.verdict, self.into) {
            (Verdict::Merge, Some(id)) if id > 0 && id != self.id => {}
            (Verdict::Merge, _) => {
                return Err("into must name a different surviving memory for merge".into())
            }
            (_, None) => {}
            _ => return Err("into is only allowed for merge".into()),
        }
        let needs_text = matches!(
            self.verdict,
            Verdict::Shorten | Verdict::Rewrite | Verdict::Merge
        );
        if needs_text
            && !self
                .new_text
                .as_deref()
                .is_some_and(|s| !s.trim().is_empty())
        {
            return Err("new_text must not be blank for shorten, rewrite or merge".into());
        }
        if !needs_text && self.new_text.is_some() {
            return Err("new_text is only allowed for shorten, rewrite or merge".into());
        }
        if self.note.contains(['\n', '\r']) {
            return Err("note must be one line".into());
        }
        Ok(self.id)
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Verdict {
    Keep,
    Shorten,
    Rewrite,
    Merge,
    End,
    Retire,
    Unsure,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Life {
    Short,
    Long,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Proof {
    Code,
    Record,
    Outside,
    None,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Evidence {
    #[serde(rename = "kind")]
    _kind: Kind,
    #[serde(rename = "ref")]
    _reference: String,
    #[serde(rename = "quote")]
    _quote: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum Kind {
    File,
    Commit,
    Memory,
    History,
    Doc,
}

pub(super) fn schema() -> Value {
    json!({
        "type":"object", "additionalProperties":false, "required":["verdicts"],
        "properties":{"verdicts":{"type":"array","minItems":1,"items":{
            "type":"object","additionalProperties":false,
            "required":["id","verdict","life","proof","evidence","note"],
            "properties":{
                "id":{"type":"integer"},
                "verdict":{"type":"string","enum":["keep","shorten","rewrite","merge","end","retire","unsure"]},
                "into":{"type":"integer","description":"Surviving memory ID, for merge only."},
                "new_text":{"type":"string","description":"Revised text, for shorten, rewrite and merge only."},
                "life":{"type":"string","enum":["short","long"]},
                "proof":{"type":"string","enum":["code","record","outside","none"]},
                "evidence":{"type":"array","items":{
                    "type":"object","additionalProperties":false,"required":["kind","ref","quote"],
                    "properties":{
                        "kind":{"type":"string","enum":["file","commit","memory","history","doc"]},
                        "ref":{"type":"string"},"quote":{"type":"string"}
                    }
                }},
                "note":{"type":"string"}
            }
        }}}
    })
}
