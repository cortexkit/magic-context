//! What each session preset enables. The runner only names the preset; which
//! features a preset gets is Magic Context's decision, so a new preset is a
//! change here and nowhere else.

/// The features a session has.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
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
        }),
        "worker" => Some(Features {
            summarizer: false,
            keep_first_message: true,
            ctx_keep: true,
            auto_memory: false,
            time_marker: true,
        }),
        "reader" => Some(Features {
            summarizer: false,
            keep_first_message: true,
            ctx_keep: true,
            auto_memory: false,
            time_marker: false,
        }),
        _ => None,
    }
}
