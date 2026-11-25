# Broca capacity-refusal reader samples

All seven response frame bodies and `SHA256SUMS` were copied byte for byte
from `capacity-refusal-1125b/`, the shared Broca reader set that includes the
new paused-continuation status. The SHA-256 of
`SHA256SUMS` is `b49206d72712fec92ab7152f24ae566ef8ab8d45955ae45396ebc64fc52ad5ce`;
all seven entries were checked against it before and after copying.

Broca captured these through a real `ck-subc` daemon in
`account_selection_real_daemon::capture_concurrency_full_reader_replies`
(`crates/broca-module-serve/tests/it/account_selection_real_daemon.rs`). The
rig scripts routing, the vault, and the provider endpoint, and does not
construct or reserialize the replies. IDs and timestamps describe the capture.

The continuation status with `state: paused` is captured before the wake;
the terminal continuation status and result are captured after a second
capacity refusal. The ordered admission bodies describe a separate send
that was refused before any model step. No ordered-admission `run.result`
or nonterminal continuation `run.result` was supplied in this set.
