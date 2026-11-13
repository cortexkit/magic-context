//! Derived trigger inputs. Pressure, floor marks, reservations and logging stay
//! in Session; this cache contains only functions of the indexed window.

use cortexkit_role_compaction::{part::PartBody, read::Entry};

use super::{chunk, trigger};
use crate::count::Counter;

#[derive(Clone, Debug, Default)]
struct Fact {
    raw: u64,
    removed: u64,
    body: u64,
    members: u64,
    prompt: Option<usize>,
    opens: Option<usize>,
    visible: Option<usize>,
    role: Option<char>,
    commits: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use cortexkit_role_compaction::{
        part::{Part, ToolPart, ToolStatus},
        read::{NoticeOrigin, Role},
    };

    #[test]
    fn count_refreshes_family_changes_cuts_and_index_replacement_invalidate_derived_inputs() {
        let counter = Counter::for_model(Some("anthropic/claude-opus-5-5"));
        let mut index = crate::index::Index::default();
        let mut window = Window::default();
        let mut counts = chunk::CountCache::default();
        let mut old = chunk::CountCache::default();
        index.extend((1..=40).map(|n| {
            Entry::new(
                n,
                format!("m{n}"),
                if n % 3 == 0 {
                    Role::User
                } else {
                    Role::Assistant
                },
                n,
                vec![Part::new(
                    "p",
                    PartBody::Text {
                        text: "Read the implementation before changing the prefix. "
                            .repeat(10)
                            .into(),
                    },
                )],
            )
        }));
        for step in 0..8 {
            match step {
                1 => {
                    let mut entry = index.entries()[2].clone();
                    entry.parts[0].tokens =
                        Some(cortexkit_role_compaction::tokens::PartTokens::count(90000));
                    index.extend_counted([entry], Some("first"));
                }
                2 => {
                    index.extend_counted([], Some("second"));
                }
                3 => {
                    index.prune_before(9);
                }
                4 => {
                    index.truncate(25);
                }
                5 => {
                    let mut entry = index.entries().last().unwrap().clone();
                    entry.speaks_for = Some(
                        serde_json::from_value(
                            serde_json::json!({"agent_id":"agent-a","name":"Helper"}),
                        )
                        .unwrap(),
                    );
                    index.extend([entry]);
                }
                6 => {
                    index = crate::index::Index::starting_at(1);
                    index.extend([Entry::new(
                        1,
                        "replacement",
                        Role::User,
                        1,
                        vec![Part::new(
                            "p",
                            PartBody::Text {
                                text: "Replacement branch".repeat(1000).into(),
                            },
                        )],
                    )]);
                }
                _ => {}
            }
            let (identity, changed) = index.summary_changes();
            let entries = index.entries();
            window.sync(entries, identity, changed, 1, counter, &mut counts);
            for tail in [0, 1000, 12000] {
                let until = trigger::cap_run(
                    entries,
                    |e| e.parts.iter().map(crate::tokens::removed_by_summary).sum(),
                    1,
                    trigger::tail_start(
                        entries,
                        |e| e.parts.iter().map(crate::tokens::part).sum(),
                        1,
                        tail,
                        true,
                    ),
                    100000,
                );
                assert_eq!(
                    window.bounded(entries, 1, tail, true, 100000),
                    until,
                    "step {step}"
                );
                let high = entries.partition_point(|e| e.ordinal < until);
                let actual = window.scan(entries, 1, until, 1000, counter, &mut counts);
                let expected =
                    old.build(&entries[..high], 1000, counter)
                        .map(|chunk| trigger::Scan {
                            tokens: chunk.token_estimate,
                            messages: chunk.messages,
                            commit_clusters: chunk.commit_clusters,
                            has_more: chunk.has_more,
                            raw_tokens: entries[..high]
                                .iter()
                                .flat_map(|e| &e.parts)
                                .map(crate::tokens::part)
                                .sum(),
                            removed_tokens: entries[..high]
                                .iter()
                                .flat_map(|e| &e.parts)
                                .map(crate::tokens::removed_by_summary)
                                .sum(),
                        });
                assert_eq!(actual, expected, "step {step}");
            }
        }
    }

    #[test]
    fn indexed_boundaries_and_scans_match_the_unindexed_evaluator() {
        let mut seed = 0xabc123u64;
        for model in ["test/model", "anthropic/claude-opus-5-5"] {
            let counter = Counter::for_model(Some(model));
            let mut entries = Vec::new();
            let mut window = Window::default();
            let mut counts = chunk::CountCache::default();
            let mut old = chunk::CountCache::default();
            for step in 0..100 {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                if step % 13 == 12 {
                    entries.truncate(entries.len() / 2);
                }
                let n = entries.len() as u64 + 1;
                let body = match seed % 7 {
                    0 => Vec::new(),
                    1 => vec![Part::new(
                        "p",
                        PartBody::Tool(ToolPart::new(
                            "c",
                            "bash",
                            serde_json::json!({"command":"git commit -m fix"}),
                            ToolStatus::Completed,
                        )),
                    )],
                    _ => vec![Part::new(
                        "p",
                        PartBody::Text {
                            text: match seed % 5 {
                                0 => "<system-reminder>ignore this</system-reminder>".to_owned(),
                                1 => "Committed abc1234; review the change".repeat(10),
                                _ => "Read the implementation and preserve the prefix. "
                                    .repeat(if step % 17 == 0 { 800 } else { 5 }),
                            }
                            .into(),
                        },
                    )],
                };
                let mut entry = Entry::new(
                    n,
                    format!("m{step}"),
                    if seed.is_multiple_of(3) {
                        Role::User
                    } else {
                        Role::Assistant
                    },
                    n,
                    body,
                );
                if seed.is_multiple_of(11) {
                    entry = entry.with_notice(NoticeOrigin::new("test"));
                }
                entries.push(entry);
                let from = if step % 19 == 0 { n / 2 + 1 } else { 1 };
                window.sync(&entries, 1, Some(n), from, counter, &mut counts);
                for tail in [0, 1, 256, 2000, 12000, 96000] {
                    for lift in [false, true] {
                        for cap in [0, 2000, 1000000] {
                            let until = trigger::cap_run(
                                &entries,
                                |e| e.parts.iter().map(crate::tokens::removed_by_summary).sum(),
                                from,
                                trigger::tail_start(
                                    &entries,
                                    |e| e.parts.iter().map(crate::tokens::part).sum(),
                                    from,
                                    tail,
                                    lift,
                                ),
                                cap,
                            );
                            assert_eq!(
                                window.bounded(&entries, from, tail, lift, cap),
                                until,
                                "{model} step={step} tail={tail} lift={lift} cap={cap}"
                            );
                            let low = entries.partition_point(|e| e.ordinal < from);
                            let high = entries.partition_point(|e| e.ordinal < until).max(low);
                            for budget in [0, 100, 1000000] {
                                let expected =
                                    old.build(&entries[low..high], budget, counter)
                                        .map(|chunk| trigger::Scan {
                                            tokens: chunk.token_estimate,
                                            has_more: chunk.has_more,
                                            messages: chunk.messages,
                                            commit_clusters: chunk.commit_clusters,
                                            raw_tokens: entries[low..high]
                                                .iter()
                                                .flat_map(|e| &e.parts)
                                                .map(crate::tokens::part)
                                                .sum(),
                                            removed_tokens: entries[low..high]
                                                .iter()
                                                .flat_map(|e| &e.parts)
                                                .map(crate::tokens::removed_by_summary)
                                                .sum(),
                                        });
                                assert_eq!(
                                    window.scan(
                                        &entries,
                                        from,
                                        until,
                                        budget,
                                        counter,
                                        &mut counts
                                    ),
                                    expected,
                                    "{model} step={step} until={until} budget={budget}"
                                );
                            }
                        }
                    }
                }
            }
        }
    }
}

#[derive(Clone, Debug)]
struct Block {
    low: usize,
    high: usize,
    role: char,
    commits: Vec<(usize, String)>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct Window {
    identity: u64,
    base: u64,
    facts: Vec<Fact>,
    blocks: Vec<Block>,
    from: u64,
    family: Option<Option<cortexkit_tokens::Family>>,
    // Prefix totals answer changing tail, cap and scan-budget queries without
    // constructing the summarizer's full prompt or walking the unchanged window.
    tokens: Vec<u64>,
    clusters: Vec<u64>,
    partial: Option<(usize, usize, u64)>,
}

impl Window {
    pub(crate) fn sync(
        &mut self,
        entries: &[Entry],
        identity: u64,
        changed: Option<u64>,
        from: u64,
        counter: Counter,
        counts: &mut chunk::CountCache,
    ) {
        let base = entries.first().map_or(0, |entry| entry.ordinal);
        let reset =
            self.identity != identity || self.base != base || self.family != Some(counter.family());
        let low = if reset {
            0
        } else {
            changed
                .map_or(self.facts.len(), |ordinal| {
                    entries.partition_point(|entry| entry.ordinal < ordinal)
                })
                .min(self.facts.len())
                .min(entries.len())
        };
        self.identity = identity;
        self.base = base;
        self.family = Some(counter.family());
        let old_len = self.facts.len();
        counts.set_family(counter);
        self.facts.truncate(low);
        for (i, entry) in entries.iter().enumerate().skip(low) {
            let before = self.facts.last();
            let meaningful = trigger::is_meaningful_user(entry);
            let opens = meaningful
                || entry
                    .parts
                    .iter()
                    .any(|part| matches!(part.body, PartBody::Tool(_)));
            let rendered = chunk::render_entry(entry, false);
            let body = rendered
                .as_ref()
                .filter(|_| counter.family().is_some())
                .map_or(0, |(_, parts, _, _)| {
                    #[cfg(test)]
                    {
                        counts.misses += 1;
                    }
                    counter.count(&parts.join(" / "))
                });
            self.facts.push(Fact {
                raw: before.map_or(0, |fact| fact.raw)
                    + entry.parts.iter().map(crate::tokens::part).sum::<u64>(),
                removed: before.map_or(0, |fact| fact.removed)
                    + entry
                        .parts
                        .iter()
                        .map(crate::tokens::removed_by_summary)
                        .sum::<u64>(),
                body: before.map_or(0, |fact| fact.body) + body,
                members: before.map_or(0, |fact| fact.members) + u64::from(rendered.is_some()),
                prompt: if meaningful {
                    Some(i)
                } else {
                    before.and_then(|fact| fact.prompt)
                },
                opens: if opens {
                    Some(i)
                } else {
                    before.and_then(|fact| fact.opens)
                },
                visible: if rendered.is_some() {
                    Some(i)
                } else {
                    before.and_then(|fact| fact.visible)
                },
                role: rendered.as_ref().map(|rendered| rendered.0),
                commits: rendered.map_or_else(Vec::new, |rendered| rendered.2),
            });
        }
        if !reset && low == old_len && old_len == entries.len() && self.from == from {
            return;
        }
        self.partial = None;
        let start = entries.partition_point(|entry| entry.ordinal < from);
        let mut resume = low;
        let keep = if reset || self.from != from {
            resume = start;
            0
        } else if low == old_len && low <= entries.len() {
            self.blocks.len()
        } else {
            let keep = self.blocks.partition_point(|block| block.high <= low);
            resume = self.blocks.get(keep).map_or(low, |block| block.low);
            keep
        };
        self.from = from;
        self.blocks.truncate(keep);
        let prefix_keep = if self.blocks.last().is_some_and(|block| block.role != 'R') {
            keep.saturating_sub(1)
        } else {
            keep
        };
        for i in resume.max(start)..entries.len() {
            let Some(role) = self.facts[i].role else {
                continue;
            };
            if self
                .blocks
                .last()
                .is_none_or(|block| block.role != role || role == 'R')
            {
                let low = self.blocks.last().map_or(start, |block| block.high);
                self.blocks.push(Block {
                    low,
                    high: i + 1,
                    role,
                    commits: Vec::new(),
                });
            }
            let block = self.blocks.last_mut().expect("visible block");
            block.high = i + 1;
            for hash in &self.facts[i].commits {
                if block.commits.len() < 5 && !block.commits.iter().any(|(_, old)| old == hash) {
                    block.commits.push((i, hash.clone()));
                }
            }
        }
        self.tokens.truncate(prefix_keep + 1);
        self.clusters.truncate(prefix_keep + 1);
        if self.tokens.is_empty() {
            self.tokens.push(0);
            self.clusters.push(0);
        }
    }

    fn prefix(&self, index: usize, select: impl Fn(&Fact) -> u64) -> u64 {
        index.checked_sub(1).map_or(0, |i| select(&self.facts[i]))
    }

    pub(crate) fn prompt<'a>(&self, entries: &'a [Entry]) -> Option<&'a Entry> {
        self.facts.last()?.prompt.map(|i| &entries[i])
    }

    pub(crate) fn bounded(
        &self,
        entries: &[Entry],
        from: u64,
        tail: u64,
        lift: bool,
        cap: u64,
    ) -> u64 {
        let low = entries.partition_point(|entry| entry.ordinal < from);
        if low == entries.len() {
            return from;
        }
        let total = self.prefix(entries.len(), |fact| fact.raw);
        let mut i =
            self.facts[low..].partition_point(|fact| total.saturating_sub(fact.raw) >= tail) + low;
        i = i.min(entries.len() - 1);
        let mut boundary = entries[i].ordinal;
        let weight = self.prefix(i + 1, |fact| fact.raw) - self.prefix(i, |fact| fact.raw);
        if total - self.prefix(i, |fact| fact.raw) >= tail
            && weight > (2 * tail).max(64_000)
            && i + 1 < entries.len()
        {
            boundary += 1;
        }
        let at = entries.partition_point(|entry| entry.ordinal <= boundary);
        if let Some(snap) = at
            .checked_sub(1)
            .and_then(|i| self.facts[i].opens)
            .filter(|i| *i >= low)
        {
            let end = entries.partition_point(|entry| entry.ordinal < boundary);
            let extra = self.prefix(end, |fact| fact.raw) - self.prefix(snap, |fact| fact.raw);
            let huge = self.facts[snap].prompt == Some(snap)
                && self.prefix(snap + 1, |fact| fact.raw) - self.prefix(snap, |fact| fact.raw)
                    > (2 * tail).max(64_000);
            if extra <= ((1.5 * tail as f64).round() as u64).min(48_000) && !huge {
                boundary = entries[snap].ordinal;
            }
        }
        if !lift {
            if let Some(prompt) = self.prompt(entries).filter(|entry| entry.ordinal >= from) {
                boundary = boundary.min(prompt.ordinal);
            }
        }
        let high = entries.partition_point(|entry| entry.ordinal < boundary);
        if self.prefix(high, |fact| fact.raw) - self.prefix(low, |fact| fact.raw) <= 256 {
            return from;
        }
        let start = self.prefix(low, |fact| fact.removed);
        let over = self.facts[low..high].partition_point(|fact| fact.removed - start <= cap) + low;
        if over < high {
            let over = if entries[over].ordinal == from {
                over + 1
            } else {
                over
            };
            if over < high {
                return entries[over].ordinal;
            }
        }
        boundary.max(from)
    }

    fn block_tokens(
        &self,
        entries: &[Entry],
        block: &Block,
        high: usize,
        counter: Counter,
        counts: &mut chunk::CountCache,
    ) -> u64 {
        if counter.family().is_none() {
            // Estimated models historically tokenize the merged spelling. Keep
            // that contract, but only re-render a block whose contents changed.
            return counts
                .build(&entries[block.low..high], u64::MAX, counter)
                .map_or(0, |chunk| chunk.token_estimate);
        }
        let end = entries[high - 1].ordinal;
        let start = if block.role == 'R' {
            end
        } else {
            entries[block.low].ordinal
        };
        let hashes: Vec<_> = block
            .commits
            .iter()
            .filter(|(i, _)| *i < high)
            .map(|(_, hash)| hash.as_str())
            .collect();
        let header = chunk::count_header(block.role, start, end, &hashes, counter, counts);
        let members =
            self.prefix(high, |fact| fact.members) - self.prefix(block.low, |fact| fact.members);
        header + self.prefix(high, |fact| fact.body) - self.prefix(block.low, |fact| fact.body)
            + members.saturating_sub(1) * counts.separator(counter)
    }

    pub(crate) fn scan(
        &mut self,
        entries: &[Entry],
        from: u64,
        until: u64,
        budget: u64,
        counter: Counter,
        counts: &mut chunk::CountCache,
    ) -> Option<trigger::Scan> {
        let low = entries.partition_point(|entry| entry.ordinal < from);
        let high = entries
            .partition_point(|entry| entry.ordinal < until)
            .max(low);
        let complete = self.blocks.partition_point(|block| block.high <= high);
        for b in self.tokens.len() - 1..complete {
            let block = &self.blocks[b];
            let tokens = self.block_tokens(entries, block, block.high, counter, counts);
            self.tokens.push(self.tokens.last().unwrap() + tokens);
            self.clusters.push(
                self.clusters.last().unwrap()
                    + u64::from(block.role == 'A' && !block.commits.is_empty()),
            );
        }
        let first_positive = self.tokens[1..=complete].partition_point(|tokens| *tokens == 0) + 1;
        let fit = self.tokens[..=complete]
            .partition_point(|tokens| *tokens <= budget)
            .saturating_sub(1);
        let accepted = fit.max(first_positive.min(complete));
        let mut tokens = self.tokens[accepted];
        let mut clusters = self.clusters[accepted];
        let mut messages = self
            .blocks
            .get(accepted.wrapping_sub(1))
            .map_or(0, |block| block.high - low);
        let mut stopped = accepted < complete;
        if !stopped {
            let start = self
                .blocks
                .get(complete.wrapping_sub(1))
                .map_or(low, |block| block.high);
            if let Some(block) = self.blocks.get(complete).filter(|block| block.low < high) {
                let visible = high
                    .checked_sub(1)
                    .and_then(|i| self.facts[i].visible)
                    .filter(|i| *i >= start);
                if let Some(end) = visible.map(|i| i + 1) {
                    if self.partial.as_ref().map(|(low, high, _)| (*low, *high))
                        != Some((start, end))
                    {
                        self.partial = Some((
                            start,
                            end,
                            self.block_tokens(entries, block, end, counter, counts),
                        ));
                    }
                    let more = self.partial.unwrap().2;
                    if tokens + more > budget && tokens > 0 {
                        stopped = true;
                    } else {
                        tokens += more;
                        clusters += u64::from(
                            block.role == 'A' && block.commits.iter().any(|(i, _)| *i < end),
                        );
                        messages = high - low;
                    }
                } else if messages > 0 {
                    messages = high - low;
                }
            } else if messages > 0 {
                messages = high - low;
            }
        }
        (messages > 0).then(|| trigger::Scan {
            tokens,
            commit_clusters: clusters,
            messages,
            has_more: stopped,
            raw_tokens: self.prefix(high, |fact| fact.raw) - self.prefix(low, |fact| fact.raw),
            removed_tokens: self.prefix(high, |fact| fact.removed)
                - self.prefix(low, |fact| fact.removed),
        })
    }
}
