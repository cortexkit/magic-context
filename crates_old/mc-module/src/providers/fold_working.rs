//! The live tail retains its decoded ingress and exact native values. Cloning the
//! decoder's result preserves field-presence identity without decoding it again.
use super::resident_bytes::ByteArena;
use super::*;

#[derive(Clone, PartialEq, Eq)]
pub struct TailKey {
    pub through: u64,
    pub newest: Option<u64>,
    pub answers: (u64, u64),
}

pub struct FoldWorking {
    pub key: TailKey,
    pub messages: Vec<ck_wire::CkIngressMessage>,
    pub native: Vec<Value>,
    projection: Arc<ck_wire::FlatProjection>,
    prefix_messages: usize,
    serve_native: bool,
}

impl FoldWorking {
    pub fn build(
        _arena: &mut ByteArena,
        key: TailKey,
        request: &TransformRequest,
        prefix_messages: usize,
    ) -> Result<Self, HandlerOutcome> {
        let messages = request.messages.clone();
        let native = request.native_messages.clone().unwrap_or_default();
        let projection = Arc::new(ck_wire::project_messages(&messages).map_err(transient)?);
        Ok(Self {
            key,
            messages,
            native,
            projection,
            prefix_messages,
            serve_native: request.serve_native,
        })
    }

    pub fn install(
        &self,
        _arena: &ByteArena,
        request: &mut TransformRequest,
    ) -> Result<(), HandlerOutcome> {
        // Re-parsing CK JSON marks omitted optional fields as present and changes
        // source hashes. Retain the original decoder output, not a JSON round trip.
        request.messages.clone_from(&self.messages);
        request.native_messages = (!self.native.is_empty()).then(|| self.native.clone());
        request.native_fold_projection = Some(self.projection.clone());
        request.native_fold_sidecar = None;
        request.serve_native = self.serve_native;
        Ok(())
    }

    pub fn sidecar(
        &self,
        _arena: &ByteArena,
    ) -> Result<Arc<crate::codec::DecodeSidecar>, HandlerOutcome> {
        Ok(Arc::new(
            crate::codec::opencode::decode_opencode_with_sidecar_and_base(
                &self.native,
                None,
                self.prefix_messages as u64,
            )
            .sidecar,
        ))
    }

    pub fn release(self, _arena: &mut ByteArena) {}

    pub fn retained_bytes(&self) -> usize {
        use crate::retained_size::{ck_wire_message_retained_bytes, value_heap_bytes};
        std::mem::size_of::<Self>()
            + crate::retained_size::ARC_ALLOCATION_OVERHEAD_BYTES
            + self.projection.retained_bytes()
            + self.messages.capacity() * std::mem::size_of::<ck_wire::CkIngressMessage>()
            + self.native.capacity() * std::mem::size_of::<Value>()
            + self
                .messages
                .iter()
                .map(|message| {
                    message.mid.capacity() + ck_wire_message_retained_bytes(&message.ck)
                        - std::mem::size_of::<ck_wire::CkWireMessage>()
                })
                .sum::<usize>()
            + self.native.iter().map(value_heap_bytes).sum::<usize>()
    }

    #[cfg(test)]
    pub fn charges(&self) -> Value {
        json!({"template_bytes":self.messages.capacity()*std::mem::size_of::<ck_wire::CkIngressMessage>(),
            "native_bytes":self.native.capacity()*std::mem::size_of::<Value>(),"sidecar_owned_bytes":0,"owned_parsed_trees":self.retained_bytes()})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_tail_clone_preserves_decoder_identity_and_projection() {
        let source = codec::InboundMessage {
            mid: "m11".into(),
            ordinal: 11,

            message: json!({"info":{"id":"m11","role":"assistant"},"parts":[{"type":"tool","tool":"bash",
                "state":{"status":"completed","input":{"command":"inspect"},"output":"café 🦀 \\\"exact\\\""}}]}),
        };
        let mut request: TransformRequest = decode(&json!({"v":2,"kind":"compaction.step",
            "serializer_profile":"opencode-aisdk","session_id":"s","render_config":"fixture","messages":[],
            "tool_present":true,"auto_search_enabled":false})).unwrap();
        super::super::codec::Codec::OpencodeAiSdk
            .prepare_request(&mut request, &[source])
            .unwrap();
        let mut arena = ByteArena::default();
        let working = FoldWorking::build(
            &mut arena,
            TailKey {
                through: 10,
                newest: Some(11),
                answers: (0, 0),
            },
            &request,
            10,
        )
        .unwrap();
        let mut installed = request.clone();
        installed.messages.clear();
        installed.native_messages = None;
        working.install(&arena, &mut installed).unwrap();
        assert_eq!(installed.native_messages, request.native_messages);
        assert_eq!(
            installed.messages[0].ck.to_canonical_json_vec().unwrap(),
            request.messages[0].ck.to_canonical_json_vec().unwrap()
        );
        assert_eq!(
            installed.native_fold_projection.as_ref().unwrap().as_ref(),
            &ck_wire::project_messages(&request.messages).unwrap()
        );
        assert!(
            working.retained_bytes()
                > crate::retained_size::value_retained_bytes(
                    &request.native_messages.as_ref().unwrap()[0]
                )
        );
    }
}
