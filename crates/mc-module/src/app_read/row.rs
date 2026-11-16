//! A transcript entry's app row, held typed and rendered to the JSON the
//! apps read (`context.states`) only when a read asks for it.
//!
//! The session worker builds one row per entry, and both the worker and the
//! replica keep every row of a session in memory. As JSON each row was a tree
//! of small maps and short strings; typed it is a few fields per part. A row
//! renders to exactly the JSON the projection used to build, so the apps see
//! the same bytes.
//!
//! Rows saved by older ck-mc versions, or written by fixtures, may have
//! another shape. Such a row is kept as the JSON it was read as
//! ([`Row::Json`]) and renders as that JSON.
//!
//! In `mode3.db` a row is saved in a compact binary form ([`Row::encode`]):
//! no field names, integers as variable-length varints (LEB128: seven bits
//! a byte, low bits first, the top bit set on every byte but the last),
//! strings length-prefixed.

use cortexkit_role_compaction::read::HostPart;
use serde_json::{json, Value};

/// The kind of a message part, as the apps name it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    Text,
    Reasoning,
    Tool,
    File,
    Opaque,
}

impl Kind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Kind::Text => "text",
            Kind::Reasoning => "reasoning",
            Kind::Tool => "tool",
            Kind::File => "file",
            Kind::Opaque => "opaque",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "text" => Kind::Text,
            "reasoning" => Kind::Reasoning,
            "tool" => Kind::Tool,
            "file" => Kind::File,
            "opaque" => Kind::Opaque,
            _ => return None,
        })
    }

    fn code(self) -> u8 {
        self as u8
    }

    fn from_code(code: u8) -> Option<Self> {
        [
            Kind::Text,
            Kind::Reasoning,
            Kind::Tool,
            Kind::File,
            Kind::Opaque,
        ]
        .get(usize::from(code))
        .copied()
    }
}

/// Where a part's token count came from, in increasing order of
/// uncertainty.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum Source {
    Runner,
    Counted,
    Reported,
    #[default]
    Estimate,
}

impl Source {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Source::Runner => "runner",
            Source::Counted => "counted",
            Source::Reported => "reported",
            Source::Estimate => "estimate",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "runner" => Source::Runner,
            "counted" => Source::Counted,
            "reported" => Source::Reported,
            "estimate" => Source::Estimate,
            _ => return None,
        })
    }

    fn from_code(code: u8) -> Option<Self> {
        [
            Source::Runner,
            Source::Counted,
            Source::Reported,
            Source::Estimate,
        ]
        .get(usize::from(code))
        .copied()
    }
}

/// Who wrote a user entry's text: the person, an agent whose words a module
/// carried, or a module's notice.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Origin {
    Person,
    /// A notice from `sender`, which may carry an agent's words: the agent's
    /// id and display name.
    Notice {
        sender: Box<str>,
        speaks_for: Option<(Box<str>, Option<Box<str>>)>,
    },
    /// An agent's words with no notice mark: its id and display name.
    Agent {
        agent_id: Box<str>,
        name: Option<Box<str>>,
    },
}

impl Origin {
    /// Whether the text is the person's own words, which the breakdown
    /// counts apart from notices and other agents' words.
    pub(crate) fn is_person(&self) -> bool {
        matches!(self, Origin::Person)
    }

    fn to_value(&self) -> Value {
        match self {
            Origin::Person => json!({"kind":"person"}),
            Origin::Notice { sender, speaks_for } => {
                let mut origin = json!({"kind":"notice", "sender":sender});
                if let Some((agent_id, name)) = speaks_for {
                    let mut agent = json!({"agent_id":agent_id});
                    if let Some(name) = name {
                        agent["name"] = json!(name);
                    }
                    origin["speaks_for"] = agent;
                }
                origin
            }
            Origin::Agent { agent_id, name } => {
                let mut origin = json!({"kind":"agent", "agent_id":agent_id});
                if let Some(name) = name {
                    origin["name"] = json!(name);
                }
                origin
            }
        }
    }

    fn from_value(value: &Value) -> Option<Self> {
        let origin = value.as_object()?;
        let parsed = match origin.get("kind")?.as_str()? {
            "person" => Origin::Person,
            "notice" => Origin::Notice {
                sender: origin.get("sender")?.as_str()?.into(),
                speaks_for: match origin.get("speaks_for") {
                    None => None,
                    Some(agent) => Some((
                        agent.get("agent_id")?.as_str()?.into(),
                        optional_text(agent.get("name"))?,
                    )),
                },
            },
            "agent" => Origin::Agent {
                agent_id: origin.get("agent_id")?.as_str()?.into(),
                name: optional_text(origin.get("name"))?,
            },
            _ => return None,
        };
        // Any other member makes it a shape this type doesn't hold.
        (parsed.to_value() == *value).then_some(parsed)
    }
}

/// A missing member is `None`; a present one must be a string.
fn optional_text(value: Option<&Value>) -> Option<Option<Box<str>>> {
    match value {
        None => Some(None),
        Some(value) => value.as_str().map(|text| Some(text.into())),
    }
}

/// Who wrote one part: the entry's user origin for a user entry's text, the
/// runner's host for a host-written part, or nobody the apps name.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub(crate) enum PartOrigin {
    #[default]
    None,
    /// The entry's [`Origin`].
    User,
    /// Written by the runner's host, with the host's presentation code.
    Host(Option<Box<str>>),
}

impl PartOrigin {
    fn to_value(&self, user: Option<&Origin>) -> Option<Value> {
        match self {
            PartOrigin::None => None,
            PartOrigin::User => user.map(Origin::to_value),
            PartOrigin::Host(code) => {
                let mut origin = json!({"kind":"host", "label":host_label(code.as_deref())});
                if let Some(code) = code {
                    origin["host_code"] = json!(code);
                }
                Some(origin)
            }
        }
    }
}

/// The label the apps show for a host-written part, as
/// [`crate::neutral::host_label`] makes it.
fn host_label(code: Option<&str>) -> String {
    code.map_or_else(
        || "[host text]".to_owned(),
        |code| format!("[host text: {code}]"),
    )
}

/// A part's size in a stamped or dropped part list.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Size {
    pub bytes: Option<u64>,
    pub tokens: u64,
}

impl Size {
    fn to_value(self) -> Value {
        json!({"bytes":self.bytes,"tokens":self.tokens,"input_bytes":null,"input_tokens":null})
    }
}

/// Where a part stands in the view the runner applies.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PartState {
    Live,
    /// Queued to drop: listed under `stamped_parts`, with the time it was
    /// queued when that was recorded.
    Stamped {
        at_ms: Option<u64>,
        size: Size,
    },
    /// Dropped, and listed under `dropped_parts`.
    Dropped {
        size: Size,
    },
    /// Dropped because the cut is past its message: not listed.
    Cut,
}

impl PartState {
    fn name(self) -> &'static str {
        match self {
            PartState::Live => "live",
            PartState::Stamped { .. } => "stamped",
            PartState::Dropped { .. } | PartState::Cut => "dropped",
        }
    }
}

/// One part of a typed row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Part {
    pub id: Box<str>,
    pub kind: Kind,
    pub tokens: u64,
    pub source: Source,
    pub state: PartState,
    pub origin: PartOrigin,
    pub tool: Option<Box<str>>,
}

/// A row as the projection builds it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Typed {
    /// How many of the parts carry a tag.
    tagged: u64,
    parts: Box<[Part]>,
    /// The origin of the parts marked [`PartOrigin::User`]; `None` when no
    /// part is, so that two rows that read alike compare equal.
    user_origin: Option<Box<Origin>>,
    host_parts: Box<[HostPart]>,
}

impl Typed {
    pub(crate) fn new(
        tagged: u64,
        parts: Vec<Part>,
        user_origin: Option<&Origin>,
        host_parts: &[HostPart],
    ) -> Self {
        let user_origin = user_origin
            .filter(|_| parts.iter().any(|part| part.origin == PartOrigin::User))
            .map(|origin| Box::new(origin.clone()));
        Self {
            tagged,
            parts: parts.into(),
            user_origin,
            host_parts: host_parts.into(),
        }
    }

    fn to_value(&self, mid: &str) -> Value {
        let mut stamped = Vec::new();
        let mut gone = Vec::new();
        let mut items = Vec::with_capacity(self.parts.len());
        for part in self.parts.iter() {
            let part_ref = json!({"part_key":part.id});
            let mut item = json!({"part_ref":part_ref,"kind":part.kind.as_str(),"tokens":part.tokens,"source":part.source.as_str(),"state":part.state.name()});
            if let Some(origin) = part.origin.to_value(self.user_origin.as_deref()) {
                item["origin"] = origin;
            }
            if let Some(tool) = &part.tool {
                item["tool"] = json!(tool);
            }
            items.push(item);
            match part.state {
                PartState::Stamped { at_ms, size } => stamped.push(json!({"kind":part.kind.as_str(),"part_ref":part_ref,"size":size.to_value(),"stage":"queued","stamped_at_ms":at_ms,"stamped_at_source":"recorded"})),
                PartState::Dropped { size } => gone.push(json!({"kind":part.kind.as_str(),"part_ref":part_ref,"size":size.to_value(),"dropped_at_ms":null,"dropped_at_source":"not_recorded","drop_mode":null})),
                PartState::Live | PartState::Cut => {}
            }
        }
        let state = if !self.parts.is_empty() && gone.len() == self.parts.len() {
            "dropped"
        } else {
            "raw"
        };
        let mut row = json!({"message_id":mid,"state":state,"compartment_id":null,"outside_reason":null,"split":null,"parts":{"tagged":self.tagged,"stamped":stamped.len(),"dropped":gone.len()},"stamped_parts":stamped,"dropped_parts":gone,"items":items});
        if !self.host_parts.is_empty() {
            row["host_parts"] = json!(self.host_parts);
        }
        row
    }

    /// The typed row that renders as `value`, if there is one.
    fn from_value(mid: &str, value: &Value) -> Option<Self> {
        let row = value.as_object()?;
        let tagged = row.get("parts")?.get("tagged")?.as_u64()?;
        let mut stamped = row.get("stamped_parts")?.as_array()?.iter();
        let dropped = row.get("dropped_parts")?.as_array()?;
        let items = row.get("items")?.as_array()?;
        let dropped_items = items
            .iter()
            .filter(|item| item.get("state").and_then(Value::as_str) == Some("dropped"))
            .count();
        // A row's dropped parts are all listed, or none are: its message is
        // past the cut.
        let cut = dropped.is_empty() && dropped_items > 0;
        let mut dropped = dropped.iter();
        let mut user_origin = None;
        let mut parts = Vec::with_capacity(items.len());
        for item in items {
            let id = item.get("part_ref")?.get("part_key")?.as_str()?;
            let kind = Kind::parse(item.get("kind")?.as_str()?)?;
            let size = |entry: &Value| -> Option<Size> {
                let size = entry.get("size")?;
                Some(Size {
                    bytes: match size.get("bytes")? {
                        Value::Null => None,
                        bytes => Some(bytes.as_u64()?),
                    },
                    tokens: size.get("tokens")?.as_u64()?,
                })
            };
            let state = match item.get("state")?.as_str()? {
                "live" => PartState::Live,
                "stamped" => {
                    let entry = stamped.next()?;
                    PartState::Stamped {
                        at_ms: match entry.get("stamped_at_ms")? {
                            Value::Null => None,
                            at => Some(at.as_u64()?),
                        },
                        size: size(entry)?,
                    }
                }
                "dropped" if cut => PartState::Cut,
                "dropped" => PartState::Dropped {
                    size: size(dropped.next()?)?,
                },
                _ => return None,
            };
            let origin = match item.get("origin") {
                None => PartOrigin::None,
                Some(origin) if origin.get("kind") == Some(&json!("host")) => {
                    PartOrigin::Host(optional_text(origin.get("host_code"))?)
                }
                Some(origin) => {
                    let origin = Origin::from_value(origin)?;
                    if user_origin.get_or_insert_with(|| origin.clone()) != &origin {
                        return None;
                    }
                    PartOrigin::User
                }
            };
            parts.push(Part {
                id: id.into(),
                kind,
                tokens: item.get("tokens")?.as_u64()?,
                source: Source::parse(item.get("source")?.as_str()?)?,
                state,
                origin,
                tool: optional_text(item.get("tool"))?,
            });
        }
        let host_parts: Vec<HostPart> = match row.get("host_parts") {
            None => Vec::new(),
            Some(parts) => serde_json::from_value(parts.clone()).ok()?,
        };
        let typed = Typed::new(tagged, parts, user_origin.as_ref(), &host_parts);
        // Every member must be one this type renders, with the same value.
        (typed.to_value(mid) == *value).then_some(typed)
    }
}

/// A transcript entry's app row.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Row {
    Typed(Typed),
    /// A row of a shape [`Typed`] doesn't hold, kept as read.
    Json(Box<Value>),
}

impl From<Value> for Row {
    /// Keep `value` as it is. A row read from storage is typed when it can
    /// be ([`Row::from_json`]).
    fn from(value: Value) -> Self {
        Row::Json(Box::new(value))
    }
}

impl Row {
    /// The JSON the apps read for the row of message `mid`.
    pub(crate) fn to_value(&self, mid: &str) -> Value {
        match self {
            Row::Typed(typed) => typed.to_value(mid),
            Row::Json(value) => (**value).clone(),
        }
    }

    /// The row of message `mid` that renders as `value`: typed when its
    /// shape is the one the projection builds, otherwise as it is.
    pub(crate) fn from_json(mid: &str, value: Value) -> Self {
        match Typed::from_value(mid, &value) {
            Some(typed) => Row::Typed(typed),
            None => Row::Json(Box::new(value)),
        }
    }

    /// The row's compact binary form for `mode3.db`.
    pub(crate) fn encode(&self) -> Vec<u8> {
        let mut out = Vec::new();
        match self {
            Row::Typed(typed) => {
                out.push(TYPED);
                put_varint(&mut out, typed.tagged);
                match typed.user_origin.as_deref() {
                    None => out.push(0),
                    Some(Origin::Person) => out.push(1),
                    Some(Origin::Notice { sender, speaks_for }) => {
                        out.push(2);
                        put_text(&mut out, sender);
                        match speaks_for {
                            None => out.push(0),
                            Some((agent_id, name)) => {
                                out.push(1);
                                put_text(&mut out, agent_id);
                                put_optional_text(&mut out, name.as_deref());
                            }
                        }
                    }
                    Some(Origin::Agent { agent_id, name }) => {
                        out.push(3);
                        put_text(&mut out, agent_id);
                        put_optional_text(&mut out, name.as_deref());
                    }
                }
                put_varint(&mut out, typed.parts.len() as u64);
                for part in typed.parts.iter() {
                    put_text(&mut out, &part.id);
                    out.push(part.kind.code());
                    out.push(part.source as u8);
                    put_varint(&mut out, part.tokens);
                    match part.state {
                        PartState::Live => out.push(0),
                        PartState::Stamped { at_ms, size } => {
                            out.push(1);
                            put_optional_varint(&mut out, at_ms);
                            put_size(&mut out, size);
                        }
                        PartState::Dropped { size } => {
                            out.push(2);
                            put_size(&mut out, size);
                        }
                        PartState::Cut => out.push(3),
                    }
                    match &part.origin {
                        PartOrigin::None => out.push(0),
                        PartOrigin::User => out.push(1),
                        PartOrigin::Host(code) => {
                            out.push(2);
                            put_optional_text(&mut out, code.as_deref());
                        }
                    }
                    put_optional_text(&mut out, part.tool.as_deref());
                }
                put_varint(&mut out, typed.host_parts.len() as u64);
                for fact in typed.host_parts.iter() {
                    put_text(&mut out, &fact.part);
                    put_optional_text(&mut out, fact.host_code.as_deref());
                }
            }
            Row::Json(value) => {
                out.push(JSON);
                out.extend_from_slice(value.to_string().as_bytes());
            }
        }
        out
    }

    /// The compact form of a stored row that was not JSON: it is kept, marked
    /// as JSON, so that loading it fails as it did before.
    pub(crate) fn unreadable(text: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(text.len() + 1);
        out.push(JSON);
        out.extend_from_slice(text);
        out
    }

    /// The row [`Row::encode`] wrote, or why `bytes` is not one.
    pub(crate) fn decode(bytes: &[u8]) -> Result<Self, String> {
        let (&format, rest) = bytes.split_first().ok_or("an empty app row")?;
        match format {
            TYPED => {
                let mut input = Input(rest);
                let row = input.typed().ok_or("a truncated or malformed app row")?;
                if !input.0.is_empty() {
                    return Err("an app row with trailing bytes".into());
                }
                Ok(Row::Typed(row))
            }
            JSON => serde_json::from_slice(rest)
                .map(|value| Row::Json(Box::new(value)))
                .map_err(|error| format!("an app row's JSON: {error}")),
            other => Err(format!("an app row of unknown format {other}")),
        }
    }
}

/// The first byte of an encoded row: what follows.
const TYPED: u8 = 1;
const JSON: u8 = 2;

fn put_varint(out: &mut Vec<u8>, mut value: u64) {
    while value >= 0x80 {
        out.push((value as u8) | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
}

fn put_optional_varint(out: &mut Vec<u8>, value: Option<u64>) {
    match value {
        None => out.push(0),
        Some(value) => {
            out.push(1);
            put_varint(out, value);
        }
    }
}

fn put_text(out: &mut Vec<u8>, text: &str) {
    put_varint(out, text.len() as u64);
    out.extend_from_slice(text.as_bytes());
}

fn put_optional_text(out: &mut Vec<u8>, text: Option<&str>) {
    match text {
        None => out.push(0),
        Some(text) => {
            out.push(1);
            put_text(out, text);
        }
    }
}

fn put_size(out: &mut Vec<u8>, size: Size) {
    put_optional_varint(out, size.bytes);
    put_varint(out, size.tokens);
}

/// The bytes of an encoded row not read yet.
struct Input<'a>(&'a [u8]);

impl Input<'_> {
    fn byte(&mut self) -> Option<u8> {
        let (&byte, rest) = self.0.split_first()?;
        self.0 = rest;
        Some(byte)
    }

    fn varint(&mut self) -> Option<u64> {
        let mut value = 0u64;
        for shift in (0..64).step_by(7) {
            let byte = self.byte()?;
            value |= u64::from(byte & 0x7f).checked_shl(shift)?;
            if byte & 0x80 == 0 {
                return Some(value);
            }
        }
        None
    }

    fn flag(&mut self) -> Option<bool> {
        match self.byte()? {
            0 => Some(false),
            1 => Some(true),
            _ => None,
        }
    }

    fn optional_varint(&mut self) -> Option<Option<u64>> {
        Some(if self.flag()? {
            Some(self.varint()?)
        } else {
            None
        })
    }

    fn text(&mut self) -> Option<Box<str>> {
        let len = usize::try_from(self.varint()?).ok()?;
        if len > self.0.len() {
            return None;
        }
        let (text, rest) = self.0.split_at(len);
        self.0 = rest;
        std::str::from_utf8(text).ok().map(Into::into)
    }

    fn optional_text(&mut self) -> Option<Option<Box<str>>> {
        Some(if self.flag()? {
            Some(self.text()?)
        } else {
            None
        })
    }

    fn size(&mut self) -> Option<Size> {
        Some(Size {
            bytes: self.optional_varint()?,
            tokens: self.varint()?,
        })
    }

    /// A count of items still to read, each taking at least one byte: a
    /// larger count can only be corruption.
    fn count(&mut self) -> Option<usize> {
        usize::try_from(self.varint()?)
            .ok()
            .filter(|count| *count <= self.0.len())
    }

    fn typed(&mut self) -> Option<Typed> {
        let tagged = self.varint()?;
        let user_origin = match self.byte()? {
            0 => None,
            1 => Some(Origin::Person),
            2 => Some(Origin::Notice {
                sender: self.text()?,
                speaks_for: if self.flag()? {
                    Some((self.text()?, self.optional_text()?))
                } else {
                    None
                },
            }),
            3 => Some(Origin::Agent {
                agent_id: self.text()?,
                name: self.optional_text()?,
            }),
            _ => return None,
        };
        let count = self.count()?;
        let mut parts = Vec::with_capacity(count);
        for _ in 0..count {
            let id = self.text()?;
            let kind = Kind::from_code(self.byte()?)?;
            let source = Source::from_code(self.byte()?)?;
            let tokens = self.varint()?;
            let state = match self.byte()? {
                0 => PartState::Live,
                1 => PartState::Stamped {
                    at_ms: self.optional_varint()?,
                    size: self.size()?,
                },
                2 => PartState::Dropped { size: self.size()? },
                3 => PartState::Cut,
                _ => return None,
            };
            let origin = match self.byte()? {
                0 => PartOrigin::None,
                1 => PartOrigin::User,
                2 => PartOrigin::Host(self.optional_text()?),
                _ => return None,
            };
            parts.push(Part {
                id,
                kind,
                tokens,
                source,
                state,
                origin,
                tool: self.optional_text()?,
            });
        }
        let count = self.count()?;
        let mut host_parts = Vec::with_capacity(count);
        for _ in 0..count {
            let mut fact = HostPart::new(String::from(self.text()?));
            if let Some(code) = self.optional_text()? {
                fact = fact.with_host_code(String::from(code));
            }
            host_parts.push(fact);
        }
        let user_origin = user_origin.map(Box::new);
        // `Typed::new` keeps a user origin exactly when some part names it,
        // so every row `encode` wrote has one exactly then; a row without
        // that was not written by `encode`.
        (user_origin.is_none() == !parts.iter().any(|part| part.origin == PartOrigin::User)).then(
            || Typed {
                tagged,
                parts: parts.into(),
                user_origin,
                host_parts: host_parts.into(),
            },
        )
    }
}
