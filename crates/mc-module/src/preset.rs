//! What each session preset enables. The runner only names the preset; which
//! features a preset gets is Magic Context's decision, so a new preset is a
//! change here and nowhere else.

/// The features a session has.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Features {
    /// Summaries of older history, rendered as messages at the start of the
    /// request in place of the messages they cover. A session with a summarizer rebuilds when a summary lands or
    /// the cache is lost anyway; one without rebuilds on every execute pass,
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
    /// A person's message gets a marker of the time since the previous
    /// message after a long gap. A reader runs one short task and gets none.
    pub time_marker: bool,
    /// Older long text is compressed by age when the user turns
    /// `caveman_text_compression` on. Never for a session another agent
    /// started, as in the plugin.
    pub caveman: bool,
}

impl Features {
    /// A session Magic Context does not compact, whose tools it only serves.
    /// As in the plugin with compaction off: no summaries, no reminders, no
    /// time markers or memory hints.
    pub const NONE: Self = Self {
        summarizer: false,
        keep_first_message: false,
        ctx_keep: false,
        auto_memory: false,
        time_marker: false,
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
            time_marker: true,
            caveman: true,
        }),
        "worker" => Some(Features {
            summarizer: false,
            keep_first_message: true,
            ctx_keep: true,
            auto_memory: false,
            time_marker: true,
            caveman: false,
        }),
        "reader" => Some(Features {
            summarizer: false,
            keep_first_message: true,
            ctx_keep: true,
            auto_memory: false,
            time_marker: false,
            caveman: false,
        }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    /// Every gate reads a preset's [`super::Features`], never the preset's
    /// name, so a new preset is a change in this file alone. Only the files
    /// that map a name to its settings may spell one: this one, the tool
    /// catalog and its tests (which tools a preset gets) and the transport (the default
    /// preset of a tools-only route).
    #[test]
    fn no_gate_outside_the_preset_tables_names_a_preset() {
        const ALLOWED: &[&str] = &["preset.rs", "catalog.rs", "transport.rs"];
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
                if !relative.ends_with(".rs") || allowed {
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
