use sha2::{Digest, Sha256};

use super::ProjectContext;

/// Hash every field in the decoded ProjectContext result object, not the
/// RPC envelope, transport formatting or a subset. Document text is never read.
pub(super) fn digest(project: &ProjectContext) -> String {
    let canonical =
        serde_jcs::to_vec(project).expect("context contains only JCS-compatible fields");
    crate::digest::hex(&Sha256::digest(canonical))
}
