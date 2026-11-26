//! The `ctx_*` tool calls and the `pre_user` hook.

use super::*;

impl Session {
    /// A `ctx_*` tool call.
    pub async fn tool<C: RunnerClient>(
        &mut self,
        client: &C,
        settings: &Settings,
        name: &str,
        input: &Value,
    ) -> Result<String, String> {
        let mut timing = crate::tool_timing::ToolTiming::new(std::time::Instant::now());
        self.tool_timed(client, settings, name, input, false, &mut timing)
            .await
    }

    /// [`Session::tool`] for a call carrying the tool-provider role's
    /// `fork_id`: a quick question a runner forked off this session.
    #[cfg(test)]
    pub async fn tool_on_fork<C: RunnerClient>(
        &mut self,
        client: &C,
        settings: &Settings,
        name: &str,
        input: &Value,
    ) -> Result<String, String> {
        let mut timing = crate::tool_timing::ToolTiming::new(std::time::Instant::now());
        self.tool_timed(client, settings, name, input, true, &mut timing)
            .await
    }

    /// [`Session::tool`], stamping in `timing` the end of each step a
    /// `ctx_search` or `ctx_memory` call takes, for a slow call's log line
    /// ([`crate::tool_timing`]).
    ///
    /// `fork` is set for a call carrying the role's `fork_id`: a quick
    /// question a runner forked off this session. Only the tools the catalog
    /// marks read-only get one (the transport refuses the others), and such
    /// a call changes nothing the person, this session or another session
    /// can observe: `ctx_search` counts no memory retrieval. `ctx_expand`
    /// writes nothing but the cache of tag numbers the runner refused, which
    /// changes no answer (see the `ctx_expand` arm).
    pub async fn tool_timed<C: RunnerClient>(
        &mut self,
        client: &C,
        settings: &Settings,
        name: &str,
        input: &Value,
        fork: bool,
        timing: &mut crate::tool_timing::ToolTiming,
    ) -> Result<String, String> {
        self.tool_unbounded(client, settings, name, input, fork, timing)
            .await
            .map(crate::tool_output::bounded)
            .map_err(crate::tool_output::bounded)
    }

    async fn tool_unbounded<C: RunnerClient>(
        &mut self,
        client: &C,
        settings: &Settings,
        name: &str,
        input: &Value,
        fork: bool,
        timing: &mut crate::tool_timing::ToolTiming,
    ) -> Result<String, String> {
        if !self.tools_only && !self.index_ready && matches!(name, "ctx_reduce" | "ctx_keep") {
            return Err("transcript catch-up is incomplete; retry after the next notice".into());
        }
        match name {
            // The tools that act on the transcript need a session Magic Context
            // compacts; the catalog never offers them to any other.
            "ctx_reduce" | "ctx_expand" | "ctx_keep" if self.tools_only => Err(format!(
                "{name} works only in a session Magic Context compacts."
            )),
            "ctx_reduce" => self.ctx_reduce(client, input).await,
            "ctx_keep" if self.features.ctx_keep => self.ctx_keep(settings, input),
            "ctx_memory" => {
                let db = self
                    .db
                    .as_ref()
                    .ok_or("ctx_memory needs the context store")?;
                let project = self
                    .project
                    .as_ref()
                    .ok_or("Error: Could not resolve project identity for memory action: the session has no project.")?;
                // A memory the agent saves or rewrites records the git line
                // its session's folder is on now.
                let writes = matches!(
                    input.get("action").and_then(Value::as_str),
                    Some("write" | "update" | "merge")
                );
                let line = if writes {
                    let line =
                        crate::memory_line::of_folder_async(Some(project.root.clone())).await;
                    timing.mark("memory_line");
                    line
                } else {
                    None
                };
                let who = crate::memory_writes::Writer {
                    harness: &self.key.harness,
                    session: &self.key.session,
                    project: &project.id,
                    authority: self.authority.as_ref(),
                    line: line.as_ref(),
                };
                // The newest message the session has seen: a fact the agent
                // passes to the user-profile review names it as its source.
                let ordinal = self.index.entries().last().map(|entry| entry.ordinal);
                // The shared connection may be held by another call; the
                // stamp inside separates waiting for it from the call itself.
                let answer = db.with_connection(|conn| {
                    timing.mark("write_wait");
                    crate::memory_tool::call(conn, &who, input, ordinal)
                });
                timing.mark("memory");
                // A call may change the project's memories, the workspace's,
                // or the person's pending observations; each owner's app
                // pages reload.
                answer.map(|reply| {
                    for change in reply.changed {
                        db.changed(change);
                    }
                    reply.text
                })
            }
            "ctx_search" => {
                let db = Arc::clone(
                    self.db
                        .as_ref()
                        .ok_or("ctx_search needs the context store")?,
                );
                let empty = std::collections::BTreeMap::new();
                let scope = Arc::new(crate::search::OwnedScope::of(
                    &self.search_scope(settings, &empty),
                ));
                timing.mark("scope");
                let (by_ids, stamps) = {
                    let (db, scope, input) = (Arc::clone(&db), Arc::clone(&scope), input.clone());
                    on_blocking_thread(move || {
                        db.with_search_reader(|conn, _| {
                            let mut stamps = crate::tool_timing::Stamps::default();
                            stamps.mark("ids_wait");
                            let answer = crate::search::by_ids(conn, &scope.scope(None), &input);
                            stamps.mark("ids");
                            (answer, stamps)
                        })
                    })
                    .await
                };
                timing.append(&stamps);
                if let Some(answer) = by_ids {
                    return answer;
                }
                // Embedded once, before the store is touched, so the request
                // to the endpoint never holds the connection.
                let query = input.get("query").and_then(Value::as_str).unwrap_or("");
                let embedded = match &settings.embedding {
                    Some(provider)
                        if crate::search::needs_embedding(
                            input,
                            settings.memory_enabled,
                            settings.git_commits_enabled,
                        ) =>
                    {
                        let (vector, outcome) =
                            provider.embed_search_query_traced(query.trim()).await;
                        timing.mark_detail("embed", outcome);
                        vector
                            .map(|vector| (vector, provider.model_id(), provider.chunk_model_id()))
                    }
                    _ => None,
                };
                self.search_reranked(client, settings, db, scope, embedded, input, fork, timing)
                    .await
            }
            "ctx_note" => {
                let db = self.db.as_ref().ok_or("ctx_note needs the context store")?;
                let scope = crate::context_db::NoteScope {
                    harness: self.key.harness.clone(),
                    session: self.key.session.clone(),
                    project: self.project.as_ref().map(|project| project.id.clone()),
                };
                let anchor = self.index.entries().last().map(|entry| entry.ordinal);
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |elapsed| elapsed.as_millis() as i64);
                let answer = crate::notes::run(db, &scope, input, anchor, now);
                if let (Ok(_), Some(project)) = (&answer, scope.project) {
                    if crate::notes::writes(input) {
                        db.changed(crate::app_read::Change::Notes {
                            project,
                            session: Some(self.key.clone()),
                        });
                    }
                }
                answer
            }
            "ctx_expand" => {
                let last_summarized = self
                    .summaries
                    .last()
                    .and_then(|summary| u64::try_from(summary.end_message).ok());
                let summarized = self.summaries_cover_numbers();
                // A fork's call records refused tag numbers too. The runner's
                // `numbers_unknown` refusal is permanent for the session, so the
                // set only caches its answer: `ctx_expand` and `ctx_reduce` give
                // the same refusal for those tags with or without the record,
                // and keeping it honours the compaction contract's rule that
                // ck-mc never asks the runner for those tags again.
                crate::expand::run(
                    client,
                    &self.key,
                    self.limits,
                    input,
                    last_summarized,
                    self.counter(),
                    crate::expand::NumbersUnknown {
                        refused: &mut self.numbers_unknown_tags,
                        summarized,
                    },
                )
                .await
            }
            other => Err(format!("unknown tool {other}")),
        }
    }

    /// An explicit `ctx_search`, reranked when its query reads as prose and a
    /// reranker is configured (see [`crate::search::rerank`]). The store is
    /// not held while the reranker scores, and any failure keeps the ordinary
    /// ranking. Each step's end is stamped in `timing`. A call on a fork
    /// (`fork`) answers the same but counts no memory retrieval.
    #[allow(clippy::too_many_arguments)]
    async fn search_reranked<C: RunnerClient>(
        &self,
        client: &C,
        settings: &Settings,
        db: Arc<ContextDb>,
        scope: Arc<crate::search::OwnedScope>,
        embedded: Option<(Vec<f32>, String, String)>,
        input: &Value,
        fork: bool,
        timing: &mut crate::tool_timing::ToolTiming,
    ) -> Result<String, String> {
        use crate::search::rerank::{self, Reranker, Skipped};
        let query = input
            .get("query")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let prose = settings.rerank != Reranker::Off && rerank::is_prose_query(query);
        // Synapse's model is pinned before any lane is read, so a missing
        // Synapse costs no extra retrieval. Only the module the settings name
        // is asked, here and for the scores.
        let mut pinned = None;
        if let (true, Reranker::Synapse(module)) = (prose, &settings.rerank) {
            match rerank::pin_synapse(
                module,
                client.synapse_call(&self.key, module, "models.list", serde_json::json!({})),
            )
            .await
            {
                Ok(pin) => pinned = Some(pin),
                Err(Skipped(reason)) => rerank::synapse_fell_back(module, &reason),
            }
            timing.mark_detail(
                "pin",
                if pinned.is_some() {
                    "pinned"
                } else {
                    "skipped"
                },
            );
        }
        let pool = match (&settings.rerank, &pinned) {
            (Reranker::Synapse(_), Some(_)) => Some(rerank::POOL),
            (Reranker::Remote(remote), _) if prose => Some(remote.top_n),
            _ => None,
        };
        let (prepared, stamps) = {
            let (db, scope, input) = (Arc::clone(&db), Arc::clone(&scope), input.clone());
            on_blocking_thread(move || {
                db.with_search_reader(|conn, coverage| {
                    let mut stamps = crate::tool_timing::Stamps::default();
                    stamps.mark("read_wait");
                    let scope = scope.scope(embedded.as_ref().map(semantic));
                    let prepared = crate::search::prepare_stamped(
                        conn,
                        coverage,
                        &scope,
                        &input,
                        pool,
                        &mut stamps,
                    );
                    (prepared, stamps)
                })
            })
            .await
        };
        timing.append(&stamps);
        timing.mark("read_end");
        let mut prepared = prepared?;
        let mut skipped_note = None;
        if !prepared.candidates().is_empty() {
            let texts = prepared.candidates().to_vec();
            let scored = match (&settings.rerank, &pinned) {
                (Reranker::Synapse(module), Some(pin)) => client
                    .synapse_call(
                        &self.key,
                        module,
                        "rerank.score",
                        rerank::score_request(pin, prepared.query(), &texts),
                    )
                    .await
                    .map_err(Skipped)
                    .and_then(|reply| rerank::scores(reply, pin, texts.len())),
                (Reranker::Remote(remote), _) => {
                    rerank::remote_scores(remote, prepared.query(), &texts).await
                }
                _ => Err(Skipped("validation".into())),
            };
            timing.mark_detail(
                "rerank",
                match (&settings.rerank, scored.is_ok()) {
                    (Reranker::Synapse(_), true) => "synapse,scored",
                    (Reranker::Synapse(_), false) => "synapse,fallback",
                    (Reranker::Remote(_), true) => "remote,scored",
                    (Reranker::Remote(_), false) => "remote,fallback",
                    (Reranker::Off, _) => "fallback",
                },
            );
            match (scored, &settings.rerank) {
                (Ok(scores), reranker) => {
                    if let Reranker::Synapse(module) = reranker {
                        rerank::synapse_scored(module);
                    }
                    prepared.reorder(&scores);
                }
                (Err(Skipped(reason)), Reranker::Synapse(module)) => {
                    rerank::synapse_fell_back(module, &reason);
                    // A Synapse that refused the scores is asked for its
                    // model again on the next search, in case the pin is
                    // what it refused.
                    rerank::forget_synapse_pin(module);
                }
                (Err(Skipped(reason)), reranker) => {
                    rerank::log_fallback(&reason);
                    // Only a hosted reranker's skip is shown to the model, as
                    // the plugin does.
                    if matches!(reranker, Reranker::Remote(_)) {
                        skipped_note = Some(rerank::skipped_line(&reason));
                    }
                }
            }
        }
        timing.results(prepared.results());
        // Counting retrievals is the reply's one write, and it feeds memory
        // ranking and the dreamer's memory curation; a fork's reply skips it,
        // and so never waits for the shared connection either.
        let (mut answer, stamps) = if fork {
            let answer = crate::search::reply(&scope.scope(None), prepared);
            let mut stamps = crate::tool_timing::Stamps::default();
            stamps.mark("finish");
            (answer, stamps)
        } else {
            on_blocking_thread(move || {
                // The shared connection may be held by another call; the stamp
                // inside separates waiting for it from the reply's own work.
                db.with_connection(|conn| {
                    let mut stamps = crate::tool_timing::Stamps::default();
                    stamps.mark("write_wait");
                    let answer = crate::search::finish(conn, &scope.scope(None), prepared);
                    stamps.mark("finish");
                    (answer, stamps)
                })
            })
            .await
        };
        timing.append(&stamps);
        if let Some(line) = skipped_note {
            answer.push('\n');
            answer.push_str(&line);
        }
        Ok(answer)
    }

    /// What a search may read for this session: messages up to the last
    /// summary (later ones are in the model's view), and the memories of its
    /// project and of its current workspace other than those the history head
    /// shows in full. The head is the two messages a
    /// view inserts at the start of the request: the baseline of summaries,
    /// docs and memories, and what changed since that baseline.
    pub(super) fn search_scope<'a>(
        &'a self,
        settings: &Settings,
        empty: &'a std::collections::BTreeMap<i64, String>,
    ) -> crate::search::Scope<'a> {
        let root = self
            .project
            .as_ref()
            .map(|project| std::path::Path::new(&project.root));
        crate::search::Scope {
            harness: &self.key.harness,
            session: &self.key.session,
            project: self.project.as_ref().map(|project| project.id.as_str()),
            // The workspace the head reads too: Entorhinal's, from the memory
            // context, which follows the project when it moves.
            workspace: self
                .memory_context
                .as_ref()
                .and_then(|context| context.workspace_id.as_deref()),
            cutoff: self
                .summaries
                .last()
                .map_or(i64::MAX, |summary| summary.end_message),
            visible_messages: (self.summaries.is_empty() && !self.tools_only).then(|| {
                let edited = self.edited(self.cut);
                self.index
                    .entries()
                    .iter()
                    .filter(|entry| {
                        entry
                            .parts
                            .iter()
                            .any(|part| !edited.covers(&entry.mid, &part.id))
                    })
                    .map(|entry| entry.ordinal as i64)
                    .collect()
            }),
            seen: self
                .baseline
                .as_ref()
                .map_or(empty, |baseline| &baseline.seen),
            memory_enabled: settings.memory_enabled,
            git_commits_enabled: settings.git_commits_enabled,
            git_repository: root.map(|root| root.join(".git").exists()),
            semantic: None,
        }
    }

    /// The `pre_user` hook: what goes after a person's message as the runner
    /// stores it. A message that is only reminders or notices is not a
    /// person's, and gets nothing. A commit's age in the hint counts to
    /// `now_ms`.
    pub async fn pre_user(
        &self,
        settings: &Settings,
        text: &str,
        now_ms: u64,
    ) -> crate::pre_user::Addition {
        let mut answer = crate::pre_user::Addition::default();
        if !crate::search::text::is_meaningful_user_text(text) {
            return answer;
        }
        let auto = &settings.auto_search;
        let prompt = crate::pre_user::prompt_text(text);
        if !self.features.auto_memory
            || !auto.enabled
            || crate::pre_user::has_hint(text)
            || crate::search::text::utf16_len(&prompt) < auto.min_prompt_chars
        {
            return answer;
        }
        let Some(db) = &self.db else {
            return answer;
        };
        let started = std::time::Instant::now();
        let deadline = std::time::Duration::from_millis(crate::pre_user::AUTO_SEARCH_TIMEOUT_MS);
        let embed_budget = std::time::Duration::from_millis(200);
        let search = async {
            let embedded = match &settings.embedding {
                Some(provider) => tokio::time::timeout(
                    embed_budget,
                    provider.embed_query_with_budget(&prompt, embed_budget),
                )
                .await
                .ok()
                .flatten()
                .map(|vector| (vector, provider.model_id(), provider.chunk_model_id())),
                None => None,
            };
            let empty = std::collections::BTreeMap::new();
            let scope = crate::search::OwnedScope::of(&self.search_scope(settings, &empty));
            let (db, prompt) = (db.clone(), prompt.clone());
            // SQLite and its connections are synchronous. Keep both off
            // the session worker so the deadline can expire during the read.
            tokio::task::spawn_blocking(move || {
                db.with_search_reader(|conn, coverage| {
                    let scope = scope.scope(embedded.as_ref().map(semantic));
                    crate::search::auto_hits(conn, coverage, &scope, &prompt)
                })
            })
            .await
            .unwrap_or_default()
        };
        let Ok(hits) = tokio::time::timeout(deadline, search).await else {
            tracing::info!(
                session = %self.key.session,
                "ck-mc: session: memory search took too long; the message has no hint"
            );
            return answer;
        };
        if started.elapsed() >= deadline {
            return answer;
        }
        answer.append =
            crate::search::build_hint(hits, auto.score_threshold, &prompt, now_ms as i64)
                .map(|hint| format!("\n\n{hint}"));
        answer
    }

    /// `ctx_keep`: the model names what it still needs, in order of
    /// importance. Tags are kept in that order up to `keep_max_percentage`
    /// of the usable window; the rest are named in the answer rather than
    /// refused, since a refusal would only cost another turn.
    fn ctx_keep(&mut self, settings: &Settings, input: &Value) -> Result<String, String> {
        let spec = input.get("tags").and_then(Value::as_str).ok_or(
            "ctx_keep needs `tags`, the tags to keep, most important first, such as \"12,3-5\"",
        )?;
        if input
            .get("note")
            .and_then(Value::as_str)
            .is_none_or(|note| note.trim().is_empty())
        {
            return Err(
                "ctx_keep needs `note`: a few lines on where you are and what comes next".into(),
            );
        }
        let tags = reduce::parse_tags_in_order(spec)?;
        let cap = (pass::usable_window(&self.conditions) as f64 * settings.keep_max_percentage
            / 100.0) as u64;
        let mut kept = BTreeSet::new();
        let (mut kept_tags, mut over, mut missing) = (Vec::new(), Vec::new(), Vec::new());
        let mut used = 0;
        for tag in tags {
            let Some((entry, part)) = self.index.find_tag(tag) else {
                missing.push(tag);
                continue;
            };
            let cost = tokens::part(part);
            if used + cost > cap {
                over.push(tag);
                continue;
            }
            used += cost;
            kept.insert((entry.mid.clone(), part.id.clone()));
            kept_tags.push(tag);
        }
        let mut answer = if kept_tags.is_empty() {
            "Keeping only your task and the newest items.".to_owned()
        } else {
            format!(
                "Keeping {} (about {used} tokens), with your task and the newest items.",
                list(&kept_tags)
            )
        };
        answer.push_str(" Messages from the person also stay. Everything else before this call is removed before your next step.");
        if !over.is_empty() {
            answer.push_str(&format!(
                " Not kept, over the limit of {cap} tokens: {}.",
                list(&over)
            ));
        }
        if !missing.is_empty() {
            answer.push_str(&format!(" Not found: {}.", list(&missing)));
        }
        self.pending_keep = Some(kept);
        // The runner may index the call before invoking the tool. Its stored
        // arguments can differ from the invocation; only a call already used
        // by an earlier keep needs to wait for a new boundary.
        self.pending_keep_after = lanes::keep_call(&self.index)
            .filter(|entry| self.handled_keep_call == Some(entry.ordinal))
            .map(|entry| KeepWait {
                call_ordinal: entry.ordinal,
                indexed_through: self
                    .index
                    .entries()
                    .last()
                    .map_or(entry.ordinal, |last| last.ordinal),
            });
        Ok(answer)
    }

    pub(super) async fn ctx_reduce<C: RunnerClient>(
        &mut self,
        client: &C,
        input: &Value,
    ) -> Result<String, String> {
        let Some(spec) = input
            .get("drop")
            .and_then(Value::as_str)
            .filter(|spec| !spec.is_empty())
        else {
            return Ok("Error: 'drop' must be provided as a string of tag numbers, for example {\"drop\": \"3-5,8\"}.".into());
        };
        let tags = match reduce::parse_tags(spec) {
            Ok(tags) => tags,
            Err(error) => return Ok(format!("Error: Invalid range syntax. {error}")),
        };
        // The bounded live index no longer holds compacted tags. Ask the raw
        // transcript for missing handles before classifying them as unknown.
        let missing: Vec<_> = tags
            .iter()
            .copied()
            .filter(|tag| self.index.find_tag(*tag).is_none())
            .collect();
        // Numbers the runner already refused as unknown are never asked
        // for again (compaction contract W1.3, `numbers_unknown`).
        let refused: Vec<_> = missing
            .iter()
            .copied()
            .filter(|tag| self.numbers_unknown_tags.contains(tag))
            .collect();
        if !refused.is_empty() {
            return Ok(crate::reads::numbers_unknown_error(
                &refused,
                self.summaries_cover_numbers(),
            ));
        }
        let archived = if missing.is_empty() {
            Vec::new()
        } else {
            match crate::reads::by_tags_placed(client, &self.key, missing, self.limits).await {
                Ok(entries) => entries,
                Err(crate::reads::TagsRead::NumbersUnknown(refused)) => {
                    self.numbers_unknown_tags.extend(refused.iter().copied());
                    return Ok(crate::reads::numbers_unknown_error(
                        &refused,
                        self.summaries_cover_numbers(),
                    ));
                }
                Err(crate::reads::TagsRead::Failed(error)) => return Err(error),
            }
        };
        let find = |tag: u64| {
            self.index.find_tag(tag).or_else(|| {
                archived.iter().find_map(|entry| {
                    entry
                        .parts
                        .iter()
                        .find(|part| part.tag == Some(tag))
                        .map(|part| (entry, part))
                })
            })
        };
        let unknown: Vec<_> = tags
            .iter()
            .copied()
            .filter(|tag| find(*tag).is_none())
            .collect();
        if !unknown.is_empty() {
            return Ok(format!(
                "Error: Unknown tag(s) {}. Check available tags in conversation.",
                list(&unknown)
            ));
        }
        let mut self_stamps = 0;
        let mut skipped = Vec::new();
        let mut conflicts = Vec::new();
        let mut selected = Vec::new();
        for tag in tags {
            let (entry, part) = find(tag).expect("all tags resolved");
            if crate::neutral::protects_from_explicit_drop(entry) {
                skipped.push(format!("§{tag}§ is a kept notice from the person"));
            } else if matches!(&part.body, PartBody::File(_))
                && crate::neutral::protects_from_automatic_reclaim(entry)
            {
                skipped.push(format!("§{tag}§ is a file in a protected message"));
            } else if matches!(&part.body, PartBody::Tool(tool) if lanes::normalize_tool_name(&tool.name) == "ctx_reduce")
            {
                self_stamps += 1;
            } else if entry.role == cortexkit_role_compaction::read::Role::Assistant
                && matches!(&part.body, PartBody::Text { text } if text.trim().is_empty())
            {
                skipped.push(format!("§{tag}§ is provider framing, nothing to reclaim"));
            } else if self.cut.is_some_and(|cut| entry.ordinal <= cut) {
                conflicts.push(format!("§{tag}§ is from before compaction"));
            } else {
                selected.push((entry.mid.clone(), part.id.clone()));
            }
        }
        if !conflicts.is_empty() {
            return Ok(format!(
                "Error: Conflicting operations — {}.",
                conflicts.join("; ")
            ));
        }
        let first_mid = self.index.entries().first().map(|entry| entry.mid.clone());
        let edited = self.edited(self.cut);
        let stamped = selected.len();
        let mut added = false;
        for (mid, part) in selected {
            if (self.features.keep_first_message && Some(&mid) == first_mid.as_ref())
                || edited.covers(&mid, &part)
            {
                continue;
            }
            let key = (mid, part);
            if self.queued.insert(key.clone()) {
                self.app_projection.dirty.insert(key.0.clone());
                self.app.stamps.insert(key, crate::app_read::now_ms());
                added = true;
            }
        }
        if added {
            self.nudges.reduced();
        }
        let mut answer = reduce::reply(stamped, self_stamps);
        if !skipped.is_empty() {
            if !answer.is_empty() {
                answer.push(' ');
            }
            answer.push_str(&format!("Skipped: {}.", skipped.join("; ")));
        }
        if answer.is_empty() {
            answer =
                "All requested tags were already queued or processed. No new action is needed."
                    .into();
        }
        Ok(answer)
    }

    pub(super) fn summary_on_its_way(&self) -> bool {
        // A floor mark promises a summary on the next notice, which an
        // account wait would not start: the drops it holds land now instead.
        self.features.summarizer
            && (self.summarizing
                || (self.floor_pending_for.is_some() && !self.summaries_wait_for_account()))
    }
}
