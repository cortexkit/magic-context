//! The session's newest messages for a reader outside the session, such as
//! the voice front that speaks for the agent during a call: the lines the
//! summarizer would read of them, built from the transcript index the
//! session already holds.

use super::Session;
use cortexkit_role_compaction::wire::Refusal;
use serde_json::{json, Value};

impl Session {
    /// `context.recent`'s answer: the newest messages the index holds as the
    /// summarizer prints them ([`crate::summary::chunk::newest`]), within
    /// `budget` tokens by the session's counter, and the last message the
    /// session's summaries cover, so the reader can see where the lines
    /// overlap them.
    /// This shows the conversation as the model saw it, without parts the
    /// host never sent.
    ///
    /// It is a read: it changes nothing, reads nothing from the runner, and
    /// builds no view. A session whose transcript is still being read is
    /// asked to retry; a session that only calls tools has no transcript here.
    pub(crate) fn recent(&self, budget: u64) -> Result<Value, Refusal> {
        if self.tools_only {
            return Err(crate::context_read::unknown_session());
        }
        if !self.index_ready {
            return Err(crate::context_read::transcript_pending());
        }
        let counter = self.counter();
        let mut answer = crate::context_read::counted_by(counter);
        match crate::summary::chunk::newest(self.index.entries(), budget, counter) {
            Some(newest) => {
                answer["text"] = json!(newest.text);
                answer["from_message"] = json!(newest.from);
                answer["through_message"] = json!(newest.through);
                answer["tokens"] = json!(newest.tokens);
                if newest.cut {
                    answer["cut"] = json!(true);
                }
            }
            // No message the summarizer would print: nothing to tell yet.
            None => {
                answer["text"] = json!("");
                answer["from_message"] = Value::Null;
                answer["through_message"] = Value::Null;
                answer["tokens"] = json!(0);
            }
        }
        answer["summarized_through"] = json!(self.summarized_through());
        Ok(answer)
    }
}
