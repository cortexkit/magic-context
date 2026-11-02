//! Runs in child sessions: what a provider starts with `session.send` and
//! reads with `run.result`, such as a summarizer turn.
//!
//! A run finishes at once with the reply of a scripted model. The default
//! answers a summarizer prompt the way a careful model would: one summary per
//! line of the chunk, each covering exactly that line's messages, inside the
//! `<output>` envelope the summarizer's prompt asks for. Scenarios can swap in
//! another responder, for example one that returns malformed output.

use std::collections::HashMap;
use std::sync::Arc;

use ck_contract_draft::send::{RunResult, RunSettings, RunState, SendRequest};

/// A scripted model's reply to one run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reply {
    pub text: String,
    /// `stop`, `length` and so on, as the runner normalizes it.
    pub finish: Option<String>,
}

pub type Responder = Arc<dyn Fn(&RunSettings, &str) -> Reply + Send + Sync>;

/// One run a provider started, kept for scenario assertions.
#[derive(Clone, Debug, PartialEq)]
pub struct ChildRun {
    pub request: SendRequest,
    pub result: RunResult,
}

#[derive(Default)]
pub struct Runs {
    by_send_id: HashMap<String, String>,
    runs: Vec<ChildRun>,
}

impl Runs {
    /// Start a run, or return the run an earlier send with the same key
    /// started.
    pub fn start(&mut self, request: SendRequest, responder: &Responder) -> String {
        if let Some(run_id) = self.by_send_id.get(&request.send_id) {
            return run_id.clone();
        }
        let run_id = format!("run-{}", self.runs.len() + 1);
        let settings = request.run.clone().expect("a run carries its settings");
        let reply = responder(&settings, &request.prompt);
        self.by_send_id
            .insert(request.send_id.clone(), run_id.clone());
        self.runs.push(ChildRun {
            request,
            result: RunResult {
                run_id: run_id.clone(),
                state: RunState::Finished,
                finish: reply.finish,
                text: Some(reply.text),
                error: None,
                usage: None,
            },
        });
        run_id
    }

    pub fn result(&self, run_id: &str) -> Option<RunResult> {
        self.runs
            .iter()
            .find(|run| run.result.run_id == run_id)
            .map(|run| run.result.clone())
    }

    pub fn all(&self) -> &[ChildRun] {
        &self.runs
    }
}

/// The default responder: a summarizer that covers each chunk line with one
/// summary. A prompt without a `<new_messages>` chunk gets an empty reply.
pub fn scripted_summarizer() -> Responder {
    Arc::new(|_: &RunSettings, prompt: &str| {
        if !prompt.contains("<new_messages>") {
            return Reply {
                text: String::new(),
                finish: Some("stop".into()),
            };
        }
        Reply {
            text: summarize(prompt),
            finish: Some("stop".into()),
        }
    })
}

/// Summaries for every `[A]` or `[A-B]` line between `<new_messages>` and
/// `</new_messages>`.
pub fn summarize(prompt: &str) -> String {
    let body = prompt
        .split_once("<new_messages>")
        .and_then(|(_, rest)| rest.split_once("</new_messages>"))
        .map_or("", |(body, _)| body);
    let mut compartments = String::new();
    let mut last = 0;
    for line in body.lines() {
        let Some(range) = line.strip_prefix('[').and_then(|rest| rest.split_once(']')) else {
            continue;
        };
        let (start, end) = match range.0.split_once('-') {
            Some((start, end)) => (start.parse::<u64>(), end.parse::<u64>()),
            None => (range.0.parse::<u64>(), range.0.parse::<u64>()),
        };
        let (Ok(start), Ok(end)) = (start, end) else {
            continue;
        };
        last = end;
        compartments.push_str(&format!(
            "<compartment start=\"{start}\" end=\"{end}\" title=\"Messages {start}-{end}\" episode_type=\"conversation\" importance=\"50\">\n<p1>What happened in messages {start} to {end}.</p1>\n<p2>Messages {start} to {end}.</p2>\n<p3>Messages {start}-{end}.</p3>\n<p4>{start}-{end}</p4>\n</compartment>\n"
        ));
    }
    let first = body
        .lines()
        .find_map(|line| line.strip_prefix("Messages "))
        .and_then(|rest| rest.split_once('-'))
        .and_then(|(start, _)| start.parse::<u64>().ok())
        .unwrap_or(1);
    format!(
        "<output>\n<compartments>\n{compartments}</compartments>\n<meta>\n<messages_processed>{first}-{last}</messages_processed>\n<unprocessed_from>{}</unprocessed_from>\n</meta>\n</output>",
        last + 1
    )
}
