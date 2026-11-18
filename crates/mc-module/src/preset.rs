//! What each session preset enables. The runner only names the preset; which
//! features a preset gets is Magic Context's decision, so a new preset is a
//! change here and nowhere else.

/// The features a session has.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Features {
    /// Summaries of older history, rendered as messages at the start of the
    /// request in place of the messages they cover. A session with a summarizer rebuilds when a summary lands or
    /// the request's prefix changes anyway; one without rebuilds on every execute pass,
    /// because nothing else will ever make room.
    pub summarizer: bool,
    /// The session's first message is its task, and is never dropped, not
    /// even when the model asks for it.
    pub keep_first_message: bool,
    /// When the automatic lanes cannot free enough, the model is asked to
    /// call `ctx_keep`: it names what it still needs, and everything else
    /// goes. For sessions with no summarizer, whose own reasoning and replies
    /// otherwise pile up.
    pub ctx_keep: bool,
    /// A person's message gets a hint when memories, earlier history or
    /// commits look relevant to it. Not for sessions another agent started:
    /// their prompts come from that agent, not from a person's question.
    pub auto_memory: bool,
    /// Saved as `"time_marker": false`, where earlier builds kept the switch
    /// for the time markers they put in a person's message. Those markers
    /// are gone (the clock note took their place, [`crate::clock_note`]);
    /// the member stays in the saved state so a build from before can still
    /// read it.
    #[serde(rename = "time_marker", default)]
    pub retired_time_marker: Retired,
    /// Older long text is compressed by age when the user turns
    /// `caveman_text_compression` on. Never for a session another agent
    /// started, as in the plugin.
    pub caveman: bool,
}

/// A saved switch no build reads any more: always written as `false`, and
/// any boolean is accepted when read.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Retired;

impl serde::Serialize for Retired {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bool(false)
    }
}

impl<'de> serde::Deserialize<'de> for Retired {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        bool::deserialize(deserializer).map(|_| Self)
    }
}

impl Features {
    /// A session Magic Context does not compact, whose tools it only serves.
    /// As in the plugin with compaction off: no summaries, no reminders, no
    /// clock notes or memory hints.
    pub const NONE: Self = Self {
        summarizer: false,
        keep_first_message: false,
        ctx_keep: false,
        auto_memory: false,
        retired_time_marker: Retired,
        caveman: false,
    };
}

/// The features of a preset, or `None` for a preset Magic Context does not
/// know.
pub fn features(preset: &str) -> Option<Features> {
    match preset {
        "head" => Some(Features {
            summarizer: true,
            keep_first_message: false,
            ctx_keep: false,
            auto_memory: true,
            retired_time_marker: Retired,
            caveman: true,
        }),
        "worker" => Some(Features {
            summarizer: false,
            keep_first_message: true,
            ctx_keep: true,
            auto_memory: false,
            retired_time_marker: Retired,
            caveman: false,
        }),
        "reader" => Some(Features {
            summarizer: false,
            keep_first_message: true,
            ctx_keep: true,
            auto_memory: false,
            retired_time_marker: Retired,
            caveman: false,
        }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    /// Saved state keeps the retired `time_marker` member as `false` in its
    /// old place, so an older build still reads it, and a saved `true` from
    /// an older build reads back.
    #[test]
    fn saved_features_keep_the_retired_time_marker_member() {
        let head = super::features("head").unwrap();
        let saved = serde_json::to_string(&head).unwrap();
        assert_eq!(
            saved,
            r#"{"summarizer":true,"keep_first_message":false,"ctx_keep":false,"auto_memory":true,"time_marker":false,"caveman":true}"#
        );
        let older = saved.replace(r#""time_marker":false"#, r#""time_marker":true"#);
        assert_eq!(
            serde_json::from_str::<super::Features>(&older).unwrap(),
            head
        );
        let without = saved.replace(r#""time_marker":false,"#, "");
        assert_eq!(
            serde_json::from_str::<super::Features>(&without).unwrap(),
            head
        );
    }

    /// Every gate reads a preset's [`super::Features`], never the preset's
    /// name, so a new preset is a change in this file alone. Only the files
    /// that map a name to its settings may spell one: this one, the tool
    /// catalog and its tests (which tools a preset gets) and the transport (the default
    /// preset of a tools-only route).
    /// Test-only modules ending in `_tests.rs` may also name presets in the
    /// Setup requests they construct; they do not define production gates.
    /// The dreamer's guidance reader spells `"head"` as core's audience role
    /// for workspace guidance, which is not a preset of this module.
    #[test]
    fn no_gate_outside_the_preset_tables_names_a_preset() {
        const ALLOWED: &[&str] = &[
            "preset.rs",
            "catalog.rs",
            "transport.rs",
            "dreamer/guidance.rs",
        ];
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut offenders = Vec::new();
        let mut folders = vec![root.clone()];
        while let Some(folder) = folders.pop() {
            for entry in std::fs::read_dir(&folder).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    folders.push(path);
                    continue;
                }
                let relative = path
                    .strip_prefix(&root)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned();
                let allowed = ALLOWED
                    .iter()
                    .any(|file| relative == *file || relative.starts_with("catalog/"));
                if !relative.ends_with(".rs") || relative.ends_with("_tests.rs") || allowed {
                    continue;
                }
                let text = std::fs::read_to_string(&path).unwrap();
                for (number, line) in text.lines().enumerate() {
                    if ["\"head\"", "\"worker\"", "\"reader\""]
                        .iter()
                        .any(|preset| line.contains(preset))
                    {
                        offenders.push(format!(
                            "{}:{}: {}",
                            path.strip_prefix(&root).unwrap().display(),
                            number + 1,
                            line.trim()
                        ));
                    }
                }
            }
        }
        assert!(offenders.is_empty(), "{offenders:#?}");
    }
}
