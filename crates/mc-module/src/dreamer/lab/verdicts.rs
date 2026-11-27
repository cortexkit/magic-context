use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub(super) type Verdicts = BTreeMap<i64, Recorded>;

#[derive(Clone)]
pub(super) struct Recorded {
    value: Value,
    repeated_once: bool,
}

pub(super) struct Submission {
    pub reply: String,
    pub challenges: BTreeMap<i64, Challenge>,
}

pub(super) enum Challenge {
    Evidence,
    Reminder,
}

pub(super) fn submit(
    out: &Path,
    ids: &[i64],
    current: &mut Verdicts,
    input: Value,
    confirm_record_removals: bool,
    active: impl Fn(i64) -> Result<bool, String>,
) -> Result<Submission, String> {
    let list = input
        .as_object()
        .filter(|object| object.len() == 1)
        .and_then(|object| object.get("verdicts"))
        .and_then(Value::as_array)
        .filter(|list| !list.is_empty())
        .ok_or("submit needs a non-empty verdicts array")?;
    let mut next = current.clone();
    let mut challenges = BTreeMap::new();
    let mut problems = Vec::new();
    for (index, item) in list.iter().enumerate() {
        let checked = serde_json::from_value::<Entry>(item.clone())
            .map_err(|e| e.to_string())
            .and_then(|entry| {
                if item.get("reasoning").is_some_and(Value::is_null) {
                    return Err("reasoning must be a string".into());
                }
                if let Some(confirmed) = item.get("confirmed") {
                    if !confirm_record_removals {
                        return Err(
                            "confirmed is only accepted with confirm_record_removals".into()
                        );
                    }
                    if confirmed.is_null() {
                        return Err("confirmed must be a boolean".into());
                    }
                }
                entry.check(ids)?;
                if let Some(target) = entry.into {
                    if !active(target)? {
                        return Err(format!(
                            "into id {target} is not an active memory of this project"
                        ));
                    }
                }
                Ok(entry)
            });
        match checked {
            Ok(entry) => {
                let id = entry.id;
                let (record, challenge) = if confirm_record_removals {
                    record_removal(current.get(&id), item.clone(), &entry)
                } else {
                    (
                        Recorded {
                            value: item.clone(),
                            repeated_once: false,
                        },
                        None,
                    )
                };
                next.insert(id, record);
                match challenge {
                    Some(challenge) => {
                        challenges.insert(id, challenge);
                    }
                    None => {
                        challenges.remove(&id);
                    }
                }
            }
            Err(error) => problems.push(format!(
                "verdicts[{index}] (id {}): {error}",
                item.get("id").unwrap_or(&Value::Null)
            )),
        }
    }
    let saved = list.len() - problems.len();
    if saved == 0 {
        return Err(problems.join("; "));
    }
    write(out, ids, &next)?;
    *current = next;
    let missing = missing(ids, current);
    let mut reply = format!(
        "recorded {}; {} of {} still open",
        saved,
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
    if !problems.is_empty() {
        reply.push_str("; refused: ");
        reply.push_str(&problems.join("; "));
        reply.push_str(". Send only the refused verdicts again.");
    }
    Ok(Submission { reply, challenges })
}

fn record_removal(
    previous: Option<&Recorded>,
    mut value: Value,
    entry: &Entry,
) -> (Recorded, Option<Challenge>) {
    let previous_state = previous.and_then(|entry| entry.value["confirmation"].as_str());
    let same = previous.is_some_and(|entry| {
        ["verdict", "proof", "into", "new_text"]
            .into_iter()
            .all(|field| entry.value[field] == value[field])
    });
    let (state, repeated_once, challenge) = match previous_state {
        Some(_) if !same => (Some("changed"), false, None),
        Some("unconfirmed") if entry.confirmed == Some(true) => (Some("confirmed"), false, None),
        Some("unconfirmed") if previous.is_some_and(|record| record.repeated_once) => {
            (Some("repeated"), false, None)
        }
        Some("unconfirmed") => (Some("unconfirmed"), true, Some(Challenge::Reminder)),
        Some(state) => (Some(state), false, None),
        None if entry.record_removal() => (Some("unconfirmed"), false, Some(Challenge::Evidence)),
        None => (None, false, None),
    };
    // The flag is a request to confirm, not proof that a challenge occurred.
    let fields = value.as_object_mut().expect("verdict parsed as an object");
    fields.remove("confirmed");
    if let Some(state) = state {
        fields.insert("confirmation".into(), json!(state));
    }
    (
        Recorded {
            value,
            repeated_once,
        },
        challenge,
    )
}

pub(super) fn missing(ids: &[i64], current: &Verdicts) -> Vec<i64> {
    ids.iter()
        .copied()
        .filter(|id| {
            current
                .get(id)
                .is_none_or(|record| record.value["confirmation"] == "unconfirmed")
        })
        .collect()
}

pub(super) fn write(out: &Path, ids: &[i64], current: &Verdicts) -> Result<(), String> {
    write_json(
        out,
        "verdicts.json",
        &ids.iter()
            .filter_map(|id| current.get(id).map(|record| &record.value))
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
    proof: Proof,
    #[serde(rename = "evidence")]
    _evidence: Vec<Evidence>,
    note: String,
    reasoning: Option<String>,
    confirmed: Option<bool>,
}

impl Entry {
    fn check(&self, ids: &[i64]) -> Result<(), String> {
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
        if !matches!(self.verdict, Verdict::Keep)
            && self
                .reasoning
                .as_deref()
                .is_none_or(|s| s.trim().is_empty())
        {
            return Err("reasoning must not be blank except for keep".into());
        }
        if self
            .reasoning
            .as_ref()
            .is_some_and(|s| s.chars().count() > 1_200)
        {
            return Err("reasoning must be at most 1,200 characters".into());
        }
        Ok(())
    }

    fn record_removal(&self) -> bool {
        matches!(self.proof, Proof::Record)
            && matches!(
                self.verdict,
                Verdict::Retire | Verdict::Merge | Verdict::End
            )
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

pub(super) fn schema(confirm_record_removals: bool) -> Value {
    let mut schema = json!({
        "type":"object", "additionalProperties":false, "required":["verdicts"],
        "properties":{"verdicts":{"type":"array","minItems":1,"description":"List of one or more verdict objects to record for lab memories.","items":{
            "type":"object","additionalProperties":false,
            "required":["id","verdict","life","proof","evidence","note"],
            "properties":{
                "id":{"type":"integer","description":"Numeric ID of the lab memory being reviewed."},
                "verdict":{"type":"string","enum":["keep","shorten","rewrite","merge","end","retire","unsure"],"description":"Decision for the memory, from the listed choices."},
                "into":{"type":"integer","description":"Surviving memory ID, for merge only."},
                "new_text":{"type":"string","description":"Revised text, for shorten, rewrite and merge only."},
                "life":{"type":"string","enum":["short","long"],"description":"Expected useful life of the memory, either short or long."},
                "proof":{"type":"string","enum":["code","record","outside","none"],"description":"Type of proof for the decision, from the listed choices."},
                "evidence":{"type":"array","description":"List of evidence objects citing what supports the decision.","items":{
                    "type":"object","additionalProperties":false,"required":["kind","ref","quote"],
                    "properties":{
                        "kind":{"type":"string","enum":["file","commit","memory","history","doc"],"description":"Type of source being cited, from the listed choices."},
                        "ref":{"type":"string","description":"Reference identifying the source, such as a file path, commit ID, memory ID or history ref."},
                        "quote":{"type":"string","description":"Excerpt from the cited source that supports the decision."}
                    }
                }},
                "note":{"type":"string","description":"One-line note summarizing the decision."},
                "reasoning":{"type":"string","maxLength":1200,"description":"What you checked, what you found, and what would make this verdict wrong."}
            }
        }}}
    });
    if confirm_record_removals {
        schema["properties"]["verdicts"]["items"]["properties"]["confirmed"] = json!({
            "type":"boolean", "description":"Set to true when resending a removal after the tool asks for confirmation."
        });
    }
    schema
}
