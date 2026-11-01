//! What each session preset enables. The runner only names the preset; which
//! features a preset gets is Magic Context's decision, so a new preset is a
//! change here and nowhere else.

/// The features a session has.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Features {
    /// Summaries of older history and the history head at the start of the
    /// request. A session with a summarizer rebuilds when a summary lands or
    /// the cache is lost anyway; one without rebuilds on every execute pass,
    /// because nothing else will ever make room.
    pub summarizer: bool,
    /// The session's first message is its task, and is never dropped, not
    /// even when the model asks for it.
    pub keep_first_message: bool,
}

/// The features of a preset, or `None` for a preset Magic Context does not
/// know.
pub fn features(preset: &str) -> Option<Features> {
    match preset {
        "head" => Some(Features {
            summarizer: true,
            keep_first_message: false,
        }),
        "worker" | "reader" => Some(Features {
            summarizer: false,
            keep_first_message: true,
        }),
        _ => None,
    }
}
