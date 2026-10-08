# `step-transform-provider/v1` test vectors

The shared bytes every `step-transform-provider/v1` implementation and
runner checks. The role document is
`crates/cortexkit-role-step-transform-provider/CONTRACT.md`. This role is a
draft: these vectors change with the contract until it is reviewed.

| File | What it pins | Checked by |
|---|---|---|
| `role-describe.json` | canonical answers, answers a runner accepts, and answers it refuses with the problem | the wire crate's describe test |
| `declare.json` | `transform.declare` requests; declarations (tags, recall and cleanup with the reduction owner's `replace`; a guard in every `pre_tool` phase; an empty one) with the `on_unavailable` each subscription takes in effect; malformed declarations with the problem; declarations that do not decode (unknown or camel-case hook, unknown phase, op or `on_unavailable`, no budget) | the wire crate's declaration test |
| `subscriptions.json` | one declaration and planned subscriptions (each with its frozen `on_unavailable` and `budget_ms`) with the declared entry that bounds each, equal or tightened, or the problem (`subscription_missing`, tools not covered, op not declared, `subscription_loosened` with the field, `ops` on `pre_tool`, no phase, `refuse` on `post_assistant`, a zero budget); subscriptions that do not decode; the reduction rule for `replace`; the order the runner calls providers in (always the frozen plan's order) and whether the plan composer placed the reduction owner (the session's compaction provider) first; whole items with the admission answer (`plan_stale` differences including `preset_missing`, or `invalid_params` detail); and the plan composer's own `fetch-plan-v1` step-transform admission cases, copied with their expected answers so both sides must give the same admission result (each case's `source` names the upstream file and commit) | the wire crate's subscription, item and fetch-plan tests |
| `hook-requests.json` | a `transform.hook` request per hook, text subjects as `blocks` (with and without a lineage, a steered prompt's mark, a deferred call's key, an assistant message and a tool result with two text blocks), extras a provider ignores, and requests that do not decode (unknown hook, no hook, `pre_tool` without or with an unknown phase, `post_tool` without `is_error`, no session, the removed flat `text`, `blocks` that is not an array) | the wire crate's hook-request test |
| `hook-answers.json` | each answer (operations addressed by `block`, including two blocks of one message; asks with absolute `expires_at_ms`), extras tolerated, answers that do not decode (unknown answer or op, `replace` carrying `text`, `deny` without text, `ask` without expiry, an operation without or with a negative `block`, the removed relative `expiry_ms`, an unknown `on_expiry` or `late_execution` named in the error, options that are not strings), and the runner's check of an answer against its hook, phase, subscription, the tool's accepted operations and the subject's block count (`block_out_of_range`) | the wire crate's answer test |
| `grants.json` | plans whose user-tier `replace` grants are read only from the dedicated `user_grants` field (a grant in an item's params, the composition or another field grants nothing; a grant on another hook or with no tools allows nothing), and malformed `user_grants` fields | the wire crate's grant test |
| `errors.json` | every refusal code a provider answers with, plus one it does not, with whether it is retried, and the tool-result reasons the runner writes | the wire crate's error test |
| `host-runner.json` | optional whole message and paired subject identity, inclusive ancestry, pairing validation failures, history-gap hints and named refusals; existing vectors still pin absent-field bytes | the wire crate's host-runner tests |

Every request vector carries `harness`, the harness named in the session's
key, which identifies the caller (for example `broca`). The wire crate's
tests also remove it from each request in the `requests` list of `hook-requests.json` and check that the
request is refused, naming the missing field.

Every canonical vector round-trips: decoding it and encoding the result gives
back the same JSON. Changing a vector changes the contract: bump the role
crate's version and say why in the commit.
