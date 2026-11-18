//! A replicated change on the wire: its hub subject, its message id, the
//! body that is sealed, the additional data the seal is bound to, and the
//! envelope the hub stores.
//!
//! The body is a full snapshot of the row's replicated fields, never a
//! diff, so a computer that missed a message still converges on the next:
//! `{kind, global_id, revision, base_revision, change, writer, snapshot}`.
//! A delete carries no snapshot. The body is sealed with the vault's fleet
//! epoch key before it leaves ck-mc ([`super::seal`]), bound to
//! `{"global_id", "revision", "subject", "v": "ck-memory/v1"}` in RFC 8785
//! form, as agreed with the vault (`fleet-epoch-magic-context-vectors-v1`).
//! The hub stores only the envelope: the ids a receiver needs to rebuild
//! that binding, and the ciphertext.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// The version the seal's additional data names.
pub const AAD_VERSION: &str = "ck-memory/v1";

/// A sealed envelope larger than this is not published: the hub's stream
/// takes messages of at most 64 KiB.
pub const MAX_ENVELOPE_BYTES: usize = 60 * 1024;

/// The global id of this store's row `local_id` of `kind`:
/// `<store id>.<table letter><local id>`, the letter `m` for a memory, `o`
/// for an observation and `p` for a primer (`<store>.m42`). The store id is
/// random and made once per `context.db` ([`super::store_id`]), so a store
/// made anew on the same computer never forms an id an earlier store sent.
/// Local ids are unique only within their own table, and the hub's one
/// memory stream deduplicates by message id (`<global id>@<revision>`)
/// across every kind, so without the letter observation 1 and primer 1
/// would be the same message and one of them would never arrive.
pub fn global_id(store_id: &str, kind: &str, local_id: i64) -> String {
    let letter = match kind {
        "observation" => 'o',
        "primer" => 'p',
        _ => 'm',
    };
    format!("{store_id}.{letter}{local_id}")
}

/// The store id a global id was formed under.
pub fn store_of(global_id: &str) -> &str {
    global_id.split_once('.').map_or("", |(store, _)| store)
}

/// The JetStream message id, `<global id>@<revision>`. A publish sent again
/// after an unconfirmed one carries the same id, so the hub stores it once.
pub fn message_id(global_id: &str, revision: i64) -> String {
    format!("{global_id}@{revision}")
}

/// The hub subject of a row: project memories and primers under their
/// project, workspace memories under their workspace, global memories and
/// observations under `all`. `None` when the owner can't be named in a
/// subject (agent-level memories, or an owner id outside the subject
/// lexicon).
pub fn subject(kind: &str, level: Option<&str>, owner: &str) -> Result<String, String> {
    use cortexkit_bus_naming::federation as hub;
    let (kind, owner) = match (kind, level) {
        ("memory", Some("project")) => (hub::MEMORY_KIND_PROJECT, owner),
        ("memory", Some("workspace")) => (hub::MEMORY_KIND_WORKSPACE, owner),
        ("memory", Some("global")) => (hub::MEMORY_KIND_GLOBAL, "all"),
        ("observation", _) => (hub::MEMORY_KIND_OBSERVATION, "all"),
        ("primer", _) => (hub::MEMORY_KIND_PRIMER, owner),
        (kind, level) => {
            return Err(format!(
                "no subject for kind {kind} at level {}",
                level.unwrap_or("none")
            ))
        }
    };
    hub::hub_memory_subject(kind, owner).map_err(|error| error.to_string())
}

/// The additional data a message's seal is bound to, in RFC 8785 form.
pub fn aad(global_id: &str, revision: i64, subject: &str) -> Vec<u8> {
    #[derive(Serialize)]
    struct Aad<'a> {
        global_id: &'a str,
        revision: i64,
        subject: &'a str,
        v: &'static str,
    }
    serde_jcs::to_vec(&Aad {
        global_id,
        revision,
        subject,
        v: AAD_VERSION,
    })
    .expect("the additional data serializes")
}

/// Who wrote a change: the computer's box id, for the journal and the apps,
/// and the writer's actor. `dreamer_epoch` is the dreamer lease's epoch; it
/// is absent until that lease exists.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Writer {
    pub box_id: String,
    pub actor: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dreamer_epoch: Option<i64>,
}

/// The sealed body of one message.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct Body {
    pub kind: String,
    pub global_id: String,
    pub revision: i64,
    pub base_revision: i64,
    /// `create`, `update`, `merge`, `archive`, `restore`, `metadata` or
    /// `delete`, for the journal and the apps; applying never depends on it.
    pub change: String,
    pub writer: Writer,
    /// The row's replicated fields; absent on a delete.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<Map<String, Value>>,
}

/// The body's text is memory content: never printed.
impl std::fmt::Debug for Body {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Body")
            .field("kind", &self.kind)
            .field("global_id", &self.global_id)
            .field("revision", &self.revision)
            .field("change", &self.change)
            .finish_non_exhaustive()
    }
}

impl Body {
    /// The body in RFC 8785 form, the bytes that are sealed.
    pub fn to_bytes(&self) -> Vec<u8> {
        serde_jcs::to_vec(self).expect("a body serializes")
    }
}

/// What the hub stores for one message: the ids that rebuild the seal's
/// binding, in the clear (the message id names them too), and the vault's
/// seal of the body.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub global_id: String,
    pub revision: i64,
    pub epoch: u64,
    pub nonce: String,
    pub ciphertext: String,
}

impl Envelope {
    pub fn to_bytes(&self) -> Vec<u8> {
        serde_jcs::to_vec(self).expect("an envelope serializes")
    }
}

/// Bytes as the vault's wire carries them: canonical unpadded base64url.
pub fn encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn decode(text: &str) -> Result<Vec<u8>, String> {
    URL_SAFE_NO_PAD
        .decode(text)
        .map_err(|_| "not canonical unpadded base64url".to_owned())
}
