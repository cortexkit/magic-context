//! In-process fixtures shared by mc-module's parity tests.
//!
//! These builders keep test inputs stable across facade and transform tests. They are compiled
//! only for tests so the production crate has no fixture or mutation surface.

use serde_json::{json, Value};

pub struct StoreFixture {
    pub dir: tempfile::TempDir,
    pub store: mc_store::McStore,
}

pub fn descriptor(path: &std::path::Path) -> cortexkit_store_types::StorageDescriptor {
    cortexkit_store_types::StorageDescriptor {
        module_id: "magic-context-test".to_string(),
        storage_namespace: "mc_cache".to_string(),
        isolation: cortexkit_store_types::Isolation::Module,
        backend: cortexkit_store_types::StorageBackend::Sqlite {
            path: path.join("store.db").to_string_lossy().into_owned(),
        },
    }
}

use crate::ck_wire::{
    CkIngressMessage, CkKind, CkWireBlock, CkWireMessage, HarnessMeta, ProviderExtras,
};
use crate::decay_render::DecayRenderCompartment;
use crate::injection::build_synthetic_todo_pair;

#[derive(Debug, Clone)]
pub struct InProcessFixture {
    pub session_id: String,
    pub messages: Vec<CkIngressMessage>,
    pub compartments: Vec<DecayRenderCompartment>,
    pub native_messages: Vec<Value>,
    pub reductions: Vec<Value>,
}

impl InProcessFixture {}

pub struct FixtureBuilder;

impl FixtureBuilder {
    /// Open an isolated module store and retain its directory for project-shaped fixtures.
    pub fn store() -> StoreFixture {
        let dir = tempfile::tempdir().expect("fixture store directory");
        let store =
            mc_store::McStore::open_for_test(&descriptor(dir.path())).expect("fixture store");
        StoreFixture { dir, store }
    }

    pub fn session_with_boundary() -> InProcessFixture {
        let session_id = "fixture-boundary".to_string();
        let messages = vec![
            text_message("boundary-1", 1, "before boundary", false),
            text_message("boundary-2", 2, "after boundary", false),
        ];
        InProcessFixture {
            session_id,
            messages,
            compartments: vec![compartment(1, 1, "Boundary", "boundary summary")],
            native_messages: vec![],
            reductions: vec![],
        }
    }

    pub fn tagged_session() -> InProcessFixture {
        let mut fixture = Self::session_with_boundary();
        fixture.session_id = "fixture-tagged".to_string();
        fixture.messages[0].ck.meta.summary = true;
        fixture.messages[1].ck.meta.ordinal = Some(2);
        fixture
    }

    pub fn frozen_reductions() -> InProcessFixture {
        let mut fixture = Self::session_with_boundary();
        fixture.session_id = "fixture-frozen-reductions".to_string();
        fixture.reductions = vec![json!({
            "target_id": "boundary-1#0",
            "kind": "text",
            "payload": "[dropped 2]"
        })];
        fixture
    }

    pub fn synthetic_todo_armed() -> InProcessFixture {
        let mut fixture = Self::session_with_boundary();
        fixture.session_id = "fixture-todo".to_string();
        let todo = build_synthetic_todo_pair(
            r#"[{"content":"Ship it","status":"in_progress","priority":"high"}]"#,
        )
        .expect("active todo fixture");
        fixture.messages = vec![
            CkIngressMessage {
                mid: "todo-assistant".into(),
                ordinal: 1,
                ck: todo.assistant_msg.clone(),
            },
            CkIngressMessage {
                mid: "todo-tool".into(),
                ordinal: 2,
                ck: todo.tool_msg.clone(),
            },
        ];
        fixture.native_messages = vec![
            serde_json::to_value(todo.assistant_msg).unwrap(),
            serde_json::to_value(todo.tool_msg).unwrap(),
        ];
        fixture
    }
}

fn text_message(mid: &str, ordinal: u64, text: &str, synthetic: bool) -> CkIngressMessage {
    CkIngressMessage {
        mid: mid.to_string(),
        ordinal,
        ck: CkWireMessage::from_parts(
            "user",
            vec![CkWireBlock::bare(CkKind::Text { text: text.into() })],
            None,
            ProviderExtras::new(),
            HarnessMeta {
                harness_id: Some(mid.to_string()),
                synthetic,
                ..Default::default()
            },
        ),
    }
}

fn compartment(start: i64, end: i64, title: &str, content: &str) -> DecayRenderCompartment {
    DecayRenderCompartment {
        start_message: start,
        end_message: end,
        title: title.to_string(),
        content: content.to_string(),
        p1: Some(content.to_string()),
        importance: Some(50),
        ..Default::default()
    }
}
