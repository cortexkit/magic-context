//! Transcript reads from the runner and the index they keep current.

use super::*;

impl Session {
    /// Log a failed call to the runner's compaction ops. A
    /// `compaction_not_permitted` refusal suspends the session (see
    /// `suspended`); any other failure leaves it to the next notice.
    pub(super) fn runner_call_failed(&mut self, what: &str, error: &crate::client::ClientError) {
        tracing::warn!(
            session = %self.key.session,
            operation = %what,
            %error,
            "ck-mc: session: runner operation failed"
        );
        if error.not_permitted() && !self.suspended {
            tracing::warn!(
                session = %self.key.session,
                "ck-mc: session: the runner refused ck-mc as its compaction provider; suspended until its next Setup"
            );
            self.suspended = true;
            self.index_ready = false;
        }
    }

    /// Bring the index up to `newest` with reads, from the index's own newest
    /// entry on (which may have changed since). If the transcript diverged
    /// from the index, read it all again.
    /// Read from the oldest held entry that may still change, even though
    /// the index already ends where the runner's transcript does.
    pub(super) async fn sync_from_changeable<C: RunnerClient>(
        &mut self,
        client: &C,
        newest: &Cursor,
    ) -> bool {
        if self.index.changeable_from().is_some() {
            return self.read_until(client, Some(newest), true).await;
        }
        true
    }

    pub(super) async fn sync<C: RunnerClient>(
        &mut self,
        client: &C,
        newest: Option<&Cursor>,
    ) -> bool {
        let force = !self.index_ready
            || self
                .cut
                .is_some_and(|cut| newest.map_or(0, |cursor| cursor.ordinal) < cut);
        self.read_until(client, newest, force).await
    }

    /// Read until the index ends at `newest`; with `force`, read at least
    /// once.
    pub(super) async fn read_until<C: RunnerClient>(
        &mut self,
        client: &C,
        newest: Option<&Cursor>,
        force: bool,
    ) -> bool {
        self.read_until_from(client, newest, force, self.index.read_after())
            .await
    }

    /// Count one transcript read ck-mc made to the runner and the entries it
    /// returned (`None` when it failed), for Setup's closing log line. A
    /// read of messages by id that the `reads` helpers split into several
    /// requests counts once.
    pub(super) fn count_read(&self, entries: Option<usize>) {
        self.runner_reads.reads.fetch_add(1, Ordering::Relaxed);
        if let Some(entries) = entries {
            self.runner_reads
                .entries
                .fetch_add(entries as u64, Ordering::Relaxed);
        }
    }

    pub(super) async fn read_until_from<C: RunnerClient>(
        &mut self,
        client: &C,
        newest: Option<&Cursor>,
        mut force: bool,
        mut after: Option<u64>,
    ) -> bool {
        let mut rebuilt = false;
        loop {
            if !std::mem::take(&mut force) && self.index.ends_at(newest) {
                return true;
            }
            let request = self.limits.after(after, None, Detail::Compact);
            let page = client.read(&self.key, request).await;
            self.count_read(page.as_ref().ok().map(|page| page.entries.len()));
            let page = match page {
                Ok(page) => page,
                Err(error) => {
                    self.runner_call_failed("session.entries", &error);
                    return false;
                }
            };
            let runner_newest = page.head.newest.as_ref().map_or(0, |cursor| cursor.ordinal);
            if crate::reads::check_page(&self.key, after, &page).is_err() {
                return false;
            }
            if self.cut.is_some_and(|cut| runner_newest < cut) {
                if rebuilt {
                    tracing::info!(
                        session = %self.key.session,
                        newest = ?page.head.newest,
                        cut = ?self.cut,
                        "ck-mc: session: transcript keeps changing under a read; the runner's newest entry is before the cut"
                    );
                    return false;
                }
                // The transcript ends before the cut, and no revert was
                // reported: the inference is that a revert removed every
                // message after the runner's newest entry. It may forget the
                // summaries that end after that entry only within the bound
                // Setup's check keeps (see `IMPLICIT_FORGET_LIMIT`); past it,
                // they would all fail that check too, and the session is
                // held instead. No read is needed to count them.
                let past = self
                    .summaries
                    .iter()
                    .filter(|summary| summary.end_message as u64 > runner_newest)
                    .count();
                if past > IMPLICIT_FORGET_LIMIT {
                    self.hold_transcript_behind(past, page.head.newest.as_ref());
                    return false;
                }
                self.invalidate_transcript_from(runner_newest + 1);
                self.restart_index(&mut rebuilt, &mut after);
                continue;
            }
            // Which ordinals this page carried, for the give-up log below.
            let page_span = (
                page.entries.first().map(|entry| entry.ordinal),
                page.entries.last().map(|entry| entry.ordinal),
            );
            let read_from = after;
            match self
                .index
                .extend_counted(page.entries, page.token_family.as_deref())
            {
                Extend::Continued => match page.next_after {
                    Some(next) => after = Some(next),
                    None => {
                        if !self.index.ends_at(page.head.newest.as_ref()) {
                            if !rebuilt {
                                self.restart_index(&mut rebuilt, &mut after);
                                continue;
                            }
                            tracing::info!(
                                session = %self.key.session,
                                last_entry = ?self.index.cursor(),
                                newest = ?page.head.newest,
                                "ck-mc: session: transcript keeps changing under a read; the last page ends at a different entry than its head reports"
                            );
                            return false;
                        }
                        return true;
                    }
                },
                Extend::Gap | Extend::Diverged if !rebuilt => {
                    self.restart_index(&mut rebuilt, &mut after)
                }
                outcome @ (Extend::Gap | Extend::Diverged) => {
                    tracing::info!(
                        session = %self.key.session,
                        ?outcome,
                        ?read_from,
                        first_ordinal = ?page_span.0,
                        last_ordinal = ?page_span.1,
                        last_entry = ?self.index.cursor(),
                        "ck-mc: session: transcript keeps changing under a read"
                    );
                    return false;
                }
            }
        }
    }

    /// Read the index again from the cut, the oldest message the model still
    /// sees.
    fn restart_index(&mut self, rebuilt: &mut bool, after: &mut Option<u64>) {
        self.index = Index::starting_at(self.cut.unwrap_or(1));
        *rebuilt = true;
        *after = self.index.read_after();
    }

    /// Record work for the independent search indexer. Its durable watermark
    /// handles ordinary catch-up, including sessions moved from the standalone
    /// plugin with an unfinished search index. The earliest replacement ordinal
    /// invalidates rows from an undone branch before the reader continues.
    pub(crate) fn search_mark(&mut self) -> crate::search::background::Mark {
        crate::search::background::Mark {
            limits: self.limits,
            newest: self.index.cursor(),
            from: self.search_dirty_from.take(),
            reconcile: self.search_reconcile_from.take(),
            base: self.index.base(),
            entries: self.index.snapshot(),
            is_subagent: !self.features.summarizer,
        }
    }

    pub(crate) fn search_enabled(&self) -> bool {
        // Tools can also be served to plugin hosts; only runner compaction
        // sessions may refresh the plugin's shared last-response metadata.
        self.compacting() && !self.suspended && self.index_ready
    }

    pub(super) fn forget_missing(&mut self) {
        self.forget_omitted();
        let index = &self.index;
        let mut removed = Vec::new();
        self.queued.retain(|key| {
            let keep = index.find(&key.0, &key.1).is_some();
            if !keep {
                removed.push(key.clone());
            }
            keep
        });
        self.image_outputs
            .retain(|(mid, part), _| index.find(mid, part).is_some());
        self.caveman.retain_present(index);
        // A keep whose parts have all left the transcript is forgotten. A
        // keep that named nothing keepable from the start still stands: the
        // model was told everything else goes, so its view must still land.
        if let Some(kept) = &mut self.pending_keep {
            let had_parts = !kept.is_empty();
            kept.retain(|(mid, part)| index.find(mid, part).is_some());
            if had_parts && kept.is_empty() {
                self.pending_keep = None;
            }
        }
        self.app_prune_stamps(removed);
    }

    pub(super) fn forget_omitted(&mut self) {
        fn prune_keep(
            kept: &mut Option<BTreeSet<lanes::PartKey>>,
            carried: impl Fn(&lanes::PartKey) -> bool,
        ) -> bool {
            let Some(parts) = kept.as_mut().filter(|parts| !parts.is_empty()) else {
                return false;
            };
            parts.retain(carried);
            if parts.is_empty() {
                *kept = None;
                return true;
            }
            false
        }

        let index = &self.index;
        let still_eligible = |(mid, part): &lanes::PartKey| {
            index
                .find(mid, part)
                .is_none_or(|(_, part)| crate::neutral::carries_part(part))
        };
        self.queued.retain(still_eligible);
        self.refused_once.retain(still_eligible);
        self.image_outputs.retain(|key, _| still_eligible(key));
        if prune_keep(&mut self.pending_keep, still_eligible) {
            self.pending_keep_after = None;
        }
        // A refusal may restore waiting drops and keeps from an earlier
        // offer. Forget these parts in the rollback copies as well.
        for pending in &mut self.unconfirmed {
            pending.covered.retain(still_eligible);
            pending.cut_covered.retain(still_eligible);
            pending.before.queued.retain(still_eligible);
            pending.before.refused_once.retain(still_eligible);
            if prune_keep(&mut pending.before.pending_keep, still_eligible) {
                pending.before.pending_keep_after = None;
            }
        }
        self.app.stamps.retain(|key, _| {
            let keep = still_eligible(key);
            if !keep {
                self.app_projection.dirty.insert(key.0.clone());
            }
            keep
        });
    }

    /// Read in full the tool results with images whose output the
    /// answered-images lane may need and ck-mc has not read yet, then build.
    /// Only a pass on a notice reads, since it may wait on the runner; a ride
    /// must answer before the runner's request, so it builds with what it
    /// has, and a result whose text is missing waits for a later rebuild.
    pub(super) async fn build_now<C: RunnerClient>(
        &mut self,
        client: &C,
        settings: &Settings,
    ) -> (Option<View>, u64) {
        // `build` makes no view from an index that is not ready (a held
        // session's included), so nothing is read for one.
        if !self.index_ready {
            return (None, 0);
        }
        let edited = self.edited(None);
        let wanted: Vec<lanes::PartKey> = lanes::image_results(&self.index, &edited)
            .into_iter()
            .filter(|key| !self.image_outputs.contains_key(key))
            .collect();
        if !wanted.is_empty() {
            let mids: Vec<String> = wanted
                .iter()
                .map(|(mid, _)| mid.clone())
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();
            let read = crate::reads::named(client, &self.key, mids, self.limits, |mids| {
                Select::Mids { mids }
            })
            .await;
            self.count_read(read.as_ref().ok().map(Vec::len));
            match read {
                Ok(entries) => {
                    for entry in entries {
                        for part in entry.parts {
                            let key = (entry.mid.clone(), part.id.clone());
                            // Only text read from the part the index holds.
                            let same = self
                                .index
                                .find(&key.0, &key.1)
                                .is_some_and(|(_, held)| held.digest == part.digest);
                            if let (PartBody::Tool(tool), true, true) =
                                (part.body, same, wanted.contains(&key))
                            {
                                if let Some(output) = tool.output {
                                    self.image_outputs.insert(key, output);
                                }
                            }
                        }
                    }
                }
                // The reader already logged a runner fault once for this read.
                Err(error) if error.message.starts_with("runner fault:") => {}
                Err(error) => tracing::warn!(
                    session = %self.key.session,
                    ?error,
                    "ck-mc: session: reading tool results with images failed"
                ),
            }
        }
        self.build(settings, None, false, None)
    }
}
