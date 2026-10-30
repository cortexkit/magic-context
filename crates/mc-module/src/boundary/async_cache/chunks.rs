use super::*;

const MAX_BLOCK_MESSAGES: usize = 128;

struct Group {
    block: ChunkBlock,
}

#[derive(Default)]
struct Stats {
    tokens: f64,
    messages: usize,
    commits: usize,
    max_prefix: f64,
}

pub(crate) struct ChunkCache {
    groups: Vec<Group>,
    tokens: Vec<f64>,
    counts: Vec<usize>,
    commits: Vec<usize>,
    maxima: Vec<f64>,
    current: Option<ChunkBlock>,
    pending: Vec<(u64, String)>,
    last_role: String,
    current_tokens: f64,
    current_max: f64,
    enabled: bool,
}

impl Default for ChunkCache {
    fn default() -> Self {
        Self {
            groups: Vec::new(),
            tokens: vec![0.0],
            counts: vec![0],
            commits: vec![0],
            maxima: vec![0.0],
            current: None,
            pending: Vec::new(),
            last_role: String::new(),
            current_tokens: 0.0,
            current_max: 0.0,
            enabled: true,
        }
    }
}

impl ChunkCache {
    pub(crate) fn append(
        &mut self,
        messages: &[BoundaryMsg],
        estimate: &mut dyn FnMut(&str) -> usize,
    ) {
        if !self.enabled {
            return;
        }
        let mut builder = ChunkBuilder::new(f64::INFINITY, estimate, Vec::new());
        builder.current_block = self.current.take();
        builder.pending_noise_meta = std::mem::take(&mut self.pending);
        builder.last_flushed_role = std::mem::take(&mut self.last_role);
        builder.captured_blocks = Some(Vec::new());
        for message in messages {
            let accepted = builder.push_message(message);
            debug_assert!(accepted);
            let blocks = std::mem::take(
                builder
                    .captured_blocks
                    .as_mut()
                    .expect("captured chunk blocks"),
            );
            let block_tokens = std::mem::take(&mut builder.block_tokens);
            for (block, tokens) in blocks.into_iter().zip(block_tokens) {
                let before = *self.tokens.last().expect("chunk token prefix");
                self.tokens.push(before + tokens);
                self.counts
                    .push(self.counts.last().copied().unwrap_or(0) + block.meta.len());
                self.commits.push(
                    self.commits.last().copied().unwrap_or(0)
                        + usize::from(block.role == "A" && !block.commit_hashes.is_empty()),
                );
                self.maxima.push(
                    self.maxima
                        .last()
                        .copied()
                        .unwrap_or(0.0)
                        .max(before + self.current_max.max(tokens)),
                );
                self.groups.push(Group { block });
                self.current_max = 0.0;
            }
            builder.formatted_blocks.clear();
            if builder
                .current_block
                .as_ref()
                .map_or(0, |block| block.meta.len())
                + builder.pending_noise_meta.len()
                > MAX_BLOCK_MESSAGES
            {
                self.enabled = false;
                self.groups.clear();
                self.tokens.clear();
                self.counts.clear();
                self.commits.clear();
                self.maxima.clear();
                return;
            }
            self.current_tokens = builder.current_block.as_ref().map_or(0.0, |block| {
                (builder.token_estimator)(&format_block(block)) as f64
            });
            self.current_max = self.current_max.max(self.current_tokens);
        }
        self.current = builder.current_block.take();
        self.pending = std::mem::take(&mut builder.pending_noise_meta);
        self.last_role = std::mem::take(&mut builder.last_flushed_role);
    }

    fn block(&self, index: usize) -> &ChunkBlock {
        if index < self.groups.len() {
            &self.groups[index].block
        } else {
            self.current.as_ref().expect("current chunk")
        }
    }

    fn prefix(&self, index: usize) -> Stats {
        let base = index.min(self.groups.len());
        let mut stats = Stats {
            tokens: self.tokens[base],
            messages: self.counts[base],
            commits: self.commits[base],
            max_prefix: self.maxima[base],
        };
        if index > base {
            let block = self.current.as_ref().expect("current chunk");
            stats.max_prefix = stats.max_prefix.max(stats.tokens + self.current_max);
            stats.tokens += self.current_tokens;
            stats.messages += block.meta.len();
            stats.commits += usize::from(block.role == "A" && !block.commit_hashes.is_empty());
        }
        stats
    }

    pub(crate) fn estimate(
        &self,
        messages: &[BoundaryMsg],
        start: u64,
        end: Option<u64>,
        budget: f64,
        estimate: &mut dyn FnMut(&str) -> usize,
    ) -> Option<ChunkEstimate> {
        if !self.enabled || self.tokens.last().copied().unwrap_or(0.0) > 9_007_199_254_740_992.0 {
            return None;
        }
        let len = self.groups.len() + usize::from(self.current.is_some());
        let mut first = self
            .groups
            .partition_point(|group| group.block.end_ordinal < start);
        if first == self.groups.len()
            && self
                .current
                .as_ref()
                .is_some_and(|block| block.end_ordinal < start)
        {
            first += 1;
        }
        let mut last = self
            .groups
            .partition_point(|group| end.is_none_or(|end| group.block.start_ordinal < end));
        if last == self.groups.len()
            && self
                .current
                .as_ref()
                .is_some_and(|block| end.is_none_or(|end| block.start_ordinal < end))
        {
            last += 1;
        }
        first = first.min(len);
        last = last.min(len);
        let mut total = Stats::default();
        if first < last && !complete(self.block(first), start, end) {
            total = partial(messages, self.block(first), start, end, estimate);
            first += 1;
        }
        let tail = if first < last && !complete(self.block(last - 1), start, end) {
            last -= 1;
            Some(partial(messages, self.block(last), start, end, estimate))
        } else {
            None
        };
        if first < last {
            let before = self.prefix(first);
            let after = self.prefix(last);
            // Prefix maxima from before this range can only overestimate the
            // bound. If that prevents a proof, use the ordinary budget walk.
            total.max_prefix = total
                .max_prefix
                .max(total.tokens + (after.max_prefix - before.tokens).max(0.0));
            total.tokens += after.tokens - before.tokens;
            total.messages += after.messages - before.messages;
            total.commits += after.commits - before.commits;
        }
        if let Some(tail) = tail {
            total.max_prefix = total.max_prefix.max(total.tokens + tail.max_prefix);
            total.tokens += tail.tokens;
            total.messages += tail.messages;
            total.commits += tail.commits;
        }
        if total.max_prefix > budget || total.tokens > 9_007_199_254_740_992.0 {
            return None;
        }
        Some(ChunkEstimate {
            tokens: total.tokens,
            has_more: false,
            formatted_blocks: Vec::new(),
            block_tokens: Vec::new(),
            message_count: total.messages,
            commit_cluster_count: total.commits,
        })
    }
}

fn complete(block: &ChunkBlock, start: u64, end: Option<u64>) -> bool {
    block.start_ordinal >= start && end.is_none_or(|end| block.end_ordinal < end)
}

fn partial(
    messages: &[BoundaryMsg],
    block: &ChunkBlock,
    start: u64,
    end: Option<u64>,
    estimate: &mut dyn FnMut(&str) -> usize,
) -> Stats {
    let first = messages
        .partition_point(|message| message.message_ordinal < start.max(block.start_ordinal));
    let last = messages.partition_point(|message| {
        message.message_ordinal <= block.end_ordinal
            && end.is_none_or(|end| message.message_ordinal < end)
    });
    let mut builder = ChunkBuilder::new(f64::INFINITY, estimate, Vec::new());
    let mut maximum: f64 = 0.0;
    for message in &messages[first..last] {
        let accepted = builder.push_message(message);
        debug_assert!(accepted);
        let current = builder.current_block.as_ref().map_or(0.0, |block| {
            (builder.token_estimator)(&format_block(block)) as f64
        });
        maximum = maximum.max(builder.total_tokens + current);
    }
    let finished = builder.finish();
    Stats {
        tokens: finished.tokens,
        messages: finished.message_count,
        commits: finished.commit_cluster_count,
        max_prefix: maximum.max(finished.tokens),
    }
}
