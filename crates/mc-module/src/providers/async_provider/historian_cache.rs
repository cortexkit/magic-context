//! Resident historian input. Only a proven append can reuse prepared messages;
//! resets, replacements, pruning and changed reminder interpretation go through
//! the same full-input preparation used by the uncached oracle.
use super::*;

const MAX_RETAINED_BYTES: usize = 128 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq)]
pub(super) struct Stamp {
    pub generation: u64,
    pub lineage: Option<String>,
    pub prune: Option<u64>,
    pub rebuild: u64,
    version: u64,
    mutation: Option<u64>,
    echoes: u64,
    first: Option<u64>,
    from: u64,
    ordinal_base: u64,
    codec: codec::Codec,
    prelude: Option<String>,
}

impl Stamp {
    pub(super) fn of(
        state: &State,
        codec: codec::Codec,
        window: historian_tail::InputWindow,
    ) -> Result<Self, HandlerOutcome> {
        // The cut prelude has a fixed byte cap independent of the live window.
        // Its bytes, rather than an Arc address, prove that it is unchanged.
        let prelude = state
            .cut_seed
            .as_ref()
            .and_then(|seed| seed.historian_prelude.as_ref())
            .map(serde_json::to_vec)
            .transpose()
            .map_err(transient)?
            .map(|bytes| sha256_hex(&bytes));
        Ok(Self {
            generation: state.generation,
            lineage: state.lineage.clone(),
            prune: state.reasoning_pruned_generation(),
            rebuild: state.engine.rebuild_epoch,
            version: state.engine.version_high_water,
            mutation: state.input_revision,
            echoes: state.reminder_echoes.preparation_epoch(),
            first: state.cut_first_ordinal,
            from: window.from,
            ordinal_base: window.ordinal_base,
            codec,
            prelude,
        })
    }

    pub(super) fn refresh_head(&mut self, head: &State) {
        self.lineage = head.lineage.clone();
        self.prune = head.reasoning_pruned_generation();
        self.rebuild = head.engine.rebuild_epoch;
        self.version = head.engine.version_high_water;
        self.first = head.cut_first_ordinal;
        self.mutation = head.input_revision;
    }
}

pub(super) struct Source<'a> {
    pub store: &'a McStore,
    pub reference: &'a str,
    pub window: historian_tail::InputWindow,
    pub codec: codec::Codec,
    pub echoes: &'a reminder_echoes::ReminderEchoes,
    pub prelude: Option<&'a cut_seed::HistorianPrelude>,
    pub stamp: Stamp,
}

#[derive(Default)]
pub(super) struct Cache {
    input: Option<Prepared>,
    bytes: usize,
}

pub(super) struct Prepared {
    stamp: Stamp,
    through: Option<u64>,
    native_count: usize,
    messages: Vec<ck_wire::CkIngressMessage>,
    native: Option<Vec<Value>>,
    bytes: usize,
    message_heap_bytes: usize,
    native_heap_bytes: usize,
    pub projection: ck_wire::FlatProjection,
    pub boundary: AsyncHistorianBoundary,
    pub delta: BTreeMap<String, Vec<mc_store::BlockIdentity>>,
    pub known_version: Option<u64>,
    pub reused: bool,
}

impl Cache {
    /// The Arc/Mutex allocation remains even when no reusable input is held.
    pub(super) fn owner_bytes() -> usize {
        crate::retained_size::ARC_ALLOCATION_OVERHEAD_BYTES
            .saturating_add(std::mem::size_of::<std::sync::Mutex<Self>>())
    }

    pub(super) fn clear(&mut self) {
        self.input = None;
        self.bytes = 0;
    }

    pub(super) fn retained_bytes(&self) -> usize {
        self.bytes
    }

    #[cfg(test)]
    pub(super) fn retained_bytes_walk(&self) -> usize {
        use std::mem::size_of;
        self.input.as_ref().map_or(0, |input| {
            Self::owner_bytes()
                .saturating_add(input.stamp.lineage.as_ref().map_or(0, String::capacity))
                .saturating_add(input.stamp.prelude.as_ref().map_or(0, String::capacity))
                .saturating_add(
                    input
                        .messages
                        .capacity()
                        .saturating_mul(size_of::<ck_wire::CkIngressMessage>()),
                )
                .saturating_add(message_heap_bytes(&input.messages))
                .saturating_add(input.native.as_ref().map_or(0, |native| {
                    native.capacity().saturating_mul(size_of::<Value>())
                }))
                .saturating_add(native_heap_bytes(input.native.as_deref()))
                .saturating_add(
                    input
                        .projection
                        .retained_bytes()
                        .saturating_sub(size_of::<ck_wire::FlatProjection>()),
                )
                .saturating_add(input.boundary.retained_heap_bytes_walk())
        })
    }

    pub(super) fn prepare(
        &mut self,
        source: Source<'_>,
        parsed: &mut TransformRequest,
    ) -> Result<Prepared, HandlerOutcome> {
        let cached = self.input.take().filter(|prior| {
            source.stamp.mutation.is_some()
                && prior.stamp == source.stamp
                && match (prior.through, source.window.through) {
                    (None, _) => true,
                    (Some(old), Some(new)) => old <= new,
                    _ => false,
                }
        });
        self.bytes = 0;
        let mut input = if let Some(prior) = cached {
            // An append that cannot be prepared independently is not trusted.
            // Re-reading the whole window also preserves the oracle's errors.
            Self::append(prior, &source, parsed).or_else(|_| Self::full(&source, parsed))?
        } else {
            Self::full(&source, parsed)?
        };
        input.bytes = input.retained_bytes_for(&parsed.messages, parsed.native_messages.as_ref());
        self.bytes = input.bytes;
        Ok(input)
    }

    pub(super) fn finish(
        &mut self,
        mut input: Prepared,
        parsed: &mut TransformRequest,
        known_version: Option<u64>,
    ) {
        // Trigger evaluation can grow boundary/arc/chunk buffers after input
        // preparation, so admission uses their final retained allocation size.
        input.bytes = input.retained_bytes_for(&parsed.messages, parsed.native_messages.as_ref());
        if input.bytes > MAX_RETAINED_BYTES {
            self.clear();
            return;
        }
        input.messages = std::mem::take(&mut parsed.messages);
        input.native = parsed.native_messages.take();
        input.known_version = known_version;
        input.delta.clear();
        self.bytes = input.bytes;
        self.input = Some(input);
    }

    #[cfg(test)]
    pub(super) fn message_count(&self) -> usize {
        self.input.as_ref().map_or(0, |input| input.messages.len())
    }

    #[cfg(test)]
    pub(super) fn projection_bytes(&self) -> usize {
        self.input
            .as_ref()
            .map_or(0, |input| input.projection.retained_bytes())
    }
}

impl Cache {
    fn full(
        source: &Source<'_>,
        parsed: &mut TransformRequest,
    ) -> Result<Prepared, HandlerOutcome> {
        let messages = historian_tail::input_messages(
            source.store,
            source.reference,
            source.window,
            source.prelude,
        )?;
        let native_count = messages.len();
        historian_tail::prepare_messages(
            source.codec,
            parsed,
            source.echoes,
            &messages,
            source.window.ordinal_base,
        )?;
        let projection = ck_wire::project_messages(&parsed.messages).map_err(transient)?;
        let message_heap_bytes = message_heap_bytes(&parsed.messages);
        let native_heap_bytes = native_heap_bytes(parsed.native_messages.as_deref());
        Ok(Prepared {
            stamp: source.stamp.clone(),
            through: source.window.through,
            native_count,
            messages: Vec::new(),
            native: None,
            bytes: 0,
            message_heap_bytes,
            native_heap_bytes,
            projection,
            boundary: AsyncHistorianBoundary::default(),
            delta: BTreeMap::new(),
            known_version: None,
            reused: false,
        })
    }

    fn append(
        mut prior: Prepared,
        source: &Source<'_>,
        parsed: &mut TransformRequest,
    ) -> Result<Prepared, HandlerOutcome> {
        let delta_window = historian_tail::InputWindow {
            from: prior
                .through
                .map_or(source.window.from, |n| n.saturating_add(1))
                .max(source.window.from),
            ordinal_base: source
                .window
                .ordinal_base
                .saturating_add(prior.native_count as u64),
            through: source.window.through,
        };
        let messages = if prior.through == source.window.through {
            Vec::new()
        } else {
            historian_tail::input_messages(
                source.store,
                source.reference,
                delta_window,
                source.prelude,
            )?
        };
        let native_count = prior.native_count + messages.len();
        historian_tail::prepare_messages(
            source.codec,
            parsed,
            source.echoes,
            &messages,
            delta_window.ordinal_base,
        )?;
        let message_heap_bytes = prior
            .message_heap_bytes
            .saturating_add(message_heap_bytes(&parsed.messages));
        let native_heap_bytes = prior
            .native_heap_bytes
            .saturating_add(native_heap_bytes(parsed.native_messages.as_deref()));
        let projection = ck_wire::append_projected_messages(prior.projection, &parsed.messages)
            .map_err(transient)?;
        let delta = parsed
            .messages
            .iter()
            .filter_map(|message| {
                projection
                    .identity_by_mid
                    .get(&message.mid)
                    .map(|identities| (message.mid.clone(), identities.clone()))
            })
            .collect();
        prior.messages.append(&mut parsed.messages);
        parsed.messages = prior.messages;
        parsed.native_messages = match (prior.native, parsed.native_messages.take()) {
            (Some(mut old), Some(mut new)) => {
                old.append(&mut new);
                Some(old)
            }
            (None, None) => None,
            _ => return Err(transient("historian input sidecar changed")),
        };
        Ok(Prepared {
            stamp: source.stamp.clone(),
            through: source.window.through,
            native_count,
            messages: Vec::new(),
            native: None,
            bytes: 0,
            message_heap_bytes,
            native_heap_bytes,
            projection,
            boundary: prior.boundary,
            delta,
            known_version: prior.known_version,
            reused: true,
        })
    }
}

fn message_heap_bytes(messages: &[ck_wire::CkIngressMessage]) -> usize {
    use crate::retained_size::ck_wire_message_retained_bytes;
    messages
        .iter()
        .map(|message| {
            message.mid.capacity().saturating_add(
                ck_wire_message_retained_bytes(&message.ck)
                    .saturating_sub(std::mem::size_of::<ck_wire::CkWireMessage>()),
            )
        })
        .sum()
}

fn native_heap_bytes(messages: Option<&[Value]>) -> usize {
    messages.map_or(0, |messages| {
        messages
            .iter()
            .map(crate::retained_size::value_heap_bytes)
            .sum()
    })
}

impl Prepared {
    fn retained_bytes_for(
        &self,
        messages: &Vec<ck_wire::CkIngressMessage>,
        native: Option<&Vec<Value>>,
    ) -> usize {
        use std::mem::size_of;
        // The temporary delta map is cleared before storage; the other owned buffers
        // and their spare capacities survive in the retained preparation.
        Cache::owner_bytes()
            .saturating_add(self.stamp.lineage.as_ref().map_or(0, String::capacity))
            .saturating_add(self.stamp.prelude.as_ref().map_or(0, String::capacity))
            .saturating_add(
                messages
                    .capacity()
                    .saturating_mul(size_of::<ck_wire::CkIngressMessage>()),
            )
            .saturating_add(self.message_heap_bytes)
            .saturating_add(native.map_or(0, |messages| {
                messages.capacity().saturating_mul(size_of::<Value>())
            }))
            .saturating_add(self.native_heap_bytes)
            .saturating_add(
                self.projection
                    .retained_bytes_cached()
                    .saturating_sub(size_of::<ck_wire::FlatProjection>()),
            )
            .saturating_add(self.boundary.retained_heap_bytes())
    }
}
