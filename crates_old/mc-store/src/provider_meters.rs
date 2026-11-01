//! Provider-store payload meters, scoped to synchronous work after the session lock.
//! Result rows count at the mapper, including rows discarded by lineage filtering.
use serde::Serialize;
use std::cell::{Cell, RefCell};

#[derive(Clone, Debug, Default, Serialize)]
pub struct ProviderStoreMeters {
    pub sql_result_rows: u64,
    pub native_message_rows: u64,
    pub appended_message_bytes: u64,
    pub answer_json_bytes: u64,
    pub tag_row_bytes: u64,
    pub provider_state_bytes: u64,
    pub module_logical_payload_bytes: u64,
}

thread_local! {
    static ACTIVE: RefCell<Option<ProviderStoreMeters>> = const { RefCell::new(None) };
    static WRITING: Cell<bool> = const { Cell::new(false) };
    static TRANSACTION: Cell<(f64, f64, f64)> = const { Cell::new((0.0, 0.0, 0.0)) };
}

/// Wall time before, inside and after the fenced connection callback. The first
/// includes lock acquisition/BEGIN; the last includes commit and fence checks.
pub fn last_transaction_timing() -> (f64, f64, f64) {
    TRANSACTION.with(Cell::get)
}
pub(crate) fn transaction_timing(acquire_ms: f64, callback_ms: f64, finish_ms: f64) {
    TRANSACTION.with(|timing| timing.set((acquire_ms, callback_ms, finish_ms)));
}

pub(crate) fn enabled() -> bool {
    ACTIVE.with(|active| active.borrow().is_some())
}

/// Must not cross an await: an async executor may resume on a different thread.
pub struct ProviderStoreMeter {
    previous: Option<ProviderStoreMeters>,
    session: String,
    harness: String,
    request: String,
    _thread: std::marker::PhantomData<std::rc::Rc<()>>,
}
impl ProviderStoreMeter {
    pub fn start(session: &str, harness: &str, request: &str) -> Self {
        let previous = ACTIVE.with(|active| active.replace(Some(ProviderStoreMeters::default())));
        Self {
            previous,
            session: session.into(),
            harness: harness.into(),
            request: request.into(),
            _thread: std::marker::PhantomData,
        }
    }
    pub fn snapshot(&self) -> ProviderStoreMeters {
        ACTIVE.with(|active| active.borrow().clone().unwrap_or_default())
    }
}
impl Drop for ProviderStoreMeter {
    fn drop(&mut self) {
        let measured = ACTIVE
            .with(|active| active.replace(self.previous.take()))
            .unwrap_or_default();
        tracing::info!(session_id = %self.session, harness = %self.harness, request_id = %self.request,
            sql_rows_complete = false, sql_rows_scope = "provider_log_and_policy_index_result_rows",
            logical_payload_complete = false, logical_payload_scope = "admission_and_hook_payload_cells",
            sql_result_rows = measured.sql_result_rows, native_message_rows = measured.native_message_rows, appended_message_bytes = measured.appended_message_bytes,
            answer_json_bytes = measured.answer_json_bytes, tag_row_bytes = measured.tag_row_bytes,
            provider_state_bytes = measured.provider_state_bytes,
            module_logical_payload_bytes = measured.module_logical_payload_bytes,
            "provider store meters");
    }
}

pub(crate) fn read_message_row<T>(read: impl FnOnce() -> T) -> T {
    ACTIVE.with(|active| {
        if let Some(meters) = active.borrow_mut().as_mut() {
            meters.native_message_rows += 1;
        }
    });
    read_row(read)
}

pub(crate) fn read_row<T>(read: impl FnOnce() -> T) -> T {
    ACTIVE.with(|active| {
        if let Some(meters) = active.borrow_mut().as_mut() {
            meters.sql_result_rows += 1;
        }
    });
    read()
}

/// Writes are provisional until the enclosing fenced transaction commits.
pub(crate) struct WriteMeter {
    before: Option<ProviderStoreMeters>,
    committed: bool,
    previous_writing: Option<bool>,
}
impl WriteMeter {
    pub(crate) fn begin() -> Self {
        let before = ACTIVE.with(|active| active.borrow().clone());
        let previous_writing = before
            .as_ref()
            .map(|_| WRITING.with(|writing| writing.replace(true)));
        Self {
            before,
            committed: false,
            previous_writing,
        }
    }
    pub(crate) fn commit(&mut self) {
        self.committed = true;
    }
}
impl Drop for WriteMeter {
    fn drop(&mut self) {
        if let Some(previous) = self.previous_writing {
            WRITING.with(|writing| writing.set(previous));
        }
        if !self.committed {
            ACTIVE.with(|active| {
                let mut meters = active.borrow_mut();
                if let (Some(current), Some(before)) = (meters.as_mut(), self.before.take()) {
                    let rows = current.sql_result_rows;
                    let native_rows = current.native_message_rows;
                    *current = before;
                    current.sql_result_rows = rows;
                    current.native_message_rows = native_rows;
                }
            });
        }
    }
}

pub(crate) fn payload(bytes: usize) {
    if !WRITING.with(Cell::get) {
        return;
    }
    ACTIVE.with(|active| {
        if let Some(meters) = active.borrow_mut().as_mut() {
            meters.module_logical_payload_bytes += bytes as u64;
        }
    });
}
pub(crate) fn budget(kind: &str, bytes: usize) {
    if !WRITING.with(Cell::get) {
        return;
    }
    ACTIVE.with(|active| {
        if let Some(meters) = active.borrow_mut().as_mut() {
            match kind {
                "message" => meters.appended_message_bytes += bytes as u64,
                "answer" => meters.answer_json_bytes += bytes as u64,
                "tag" => meters.tag_row_bytes += bytes as u64,
                "state" => meters.provider_state_bytes += bytes as u64,
                _ => unreachable!("unknown provider payload category"),
            }
        }
    });
}
