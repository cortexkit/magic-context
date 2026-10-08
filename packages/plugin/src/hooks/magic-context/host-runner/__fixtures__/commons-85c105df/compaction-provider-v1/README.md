# `compaction-provider/v1` test vectors

The shared bytes every `compaction-provider/v1` implementation and runner
checks. The role document is
`crates/cortexkit-role-compaction-provider/CONTRACT.md`. This role is a
draft: these vectors change with the contract until it is reviewed.

| File | What it pins | Checked by |
|---|---|---|
| `role-describe.json` | canonical answers, answers a runner accepts (a missing `stability` read as `alpha`, unknown fields and ops tolerated, the runner groups a provider needs met or unmet), and answers it refuses with the problem: not an object, no majors, no `compaction-provider/v1` major, a missing required op | the wire crate's describe test |
| `setup.json` | `compaction.setup` requests (fresh, and with a first message already written), `ready` answers (a two-message head before every message with stability ranks (how rarely each of the provider's own messages changes, which the runner uses to place cache breakpoints) and `call_when` (the share of the model's context window at which the runner calls the provider, with per-model overrides), an empty view, an unknown condition kind), `refuse` answers (plain, with the provider's own `provider_code`, and with a code the role does not name, each with the retryability fixed by its code), a `refuse` still carrying the removed `retryable` member (tolerated and ignored), answers that do not decode (unknown answer, no initial message, no request id, a `refuse` without a code, a negative rank), model matching for `call_when.models` (exact id, then the longest trailing-`*` pattern, then `default`), and `call_when` shares out of range | the wire crate's setup test |
| `status.json` | `compaction.step` statuses (first call with no cursor, a tool step with usage, after an overflow, a prefix rebuild (the runner re-sending the conversation from the start), a refused last answer, a byte-capped message list) with the next version a provider may use; runner extras a provider ignores; statuses that do not decode; statuses whose messages break the cursor rules | the wire crate's status test |
| `answers.json` | each answer (`noop`, two CompactionMessages, `wait`, four `refuse`s, each with the retryability fixed by its code, one with a `provider_code` and one with a code the role does not name, opaque ids and the largest `u64` version), unknown fields tolerated (including a `refuse` still carrying the removed `retryable`, which never decides retry), answers that do not decode (unknown or uppercase `answer`, no request id, no version, a range named by message ids, a negative version, `wait` without a bound, `refuse` without a code), an inverted range, and the model-view `source` each CompactionMessage maps to: `llm-runner/v1`'s half-open replacement source, an insertion for an empty range (Setup's head is `[0, 0)`), none for an inverted range | the wire crate's answer and model-view tests |
| `fence.json` | the runner's decision for an answer given its newest request, last applied version and newest ordinal: act, `superseded_request` for every answer that names any request but the newest issued (each kind of delayed answer, one with a higher version, and one naming a request never issued), `late` for an answer to the newest request at or after its call deadline (with an in-time twin that acts), `stale_version`, `range_beyond_newest`, `range_inverted` | the wire crate's fence test |
| `ready.json` | the `compaction.ready` request, extras the runner ignores, requests that do not decode, and the runner's check: call again, ignored, or refused `not_session_compaction_provider` by the provider at `plan.compaction_item.provider` | the wire crate's ready test, through `llm-runner/v1`'s check |
| `errors.json` | every refusal code a provider answers with, plus one it does not, with whether it is retried; the four role `refuse` codes with their fixed retryability, and a code the role does not name, which decodes and is never retried; the `provider_code`s the runner writes itself (`compaction_unavailable`, `compaction_wait_exceeded`), taken from `llm-runner/v1`; and every named code's fixed retryability (`true` means the runner may retry without the user acting) and the calls after which it may end a run, the same table as CONTRACT.md §14.3 | the wire crate's error test |
| `host-runner.json` | optional inclusive ancestry, the `coverage` field on a `compaction_message` answer (the newest message a summary covers) and retryable history-gap detail, plus malformed new fields; existing vectors still pin absent-field bytes | the wire crate's host-runner tests |
| `host-runner-lane.json` | optional service/burn fields absent and present, part byte limits, named lower-watermark refusal, route/principal admission and runner-principal plan-value refusals; sparse pre-op status, held-history gaps/conflicts and final-page wait handling | proposed host-lane conformance cases; not exercised by the current wire suite |

`host-runner-lane.json` follows the named `requests` and stateful-check format.
Its `requests` are concrete wire params; `checks` and `admission` attach fixture
metadata outside the wire object: `route` is the authenticated principal and
bind, `frozen_plan_params` comes from the admitted plan, and `provider_state`
is pre-call durable state. `host_records` is host-local, never a wire field.
Expected answers/refusals and effects are literal expectations, not codec
round-trips. `plan_value_refusals` carries `{method, params}` envelopes.
Admission cases test the runner-group/ready decision separately from those
provider refusals. The proposed host cases require a host-aware implementation;
older types may decode the extra fields but cannot round-trip or execute their
semantics. Existing canonical vectors remain unchanged. Version/type/setter
and conformance updates belong to the contract owner's implementation revision.

Every request vector carries `harness`, the harness named in the session's
key, which identifies the caller (for example `broca`). The wire crate's
tests also remove it from each request in the `requests` lists of `setup.json` and
`status.json` and check that the
request is refused, naming the missing field.

Every canonical vector round-trips: decoding it and encoding the result gives
back the same JSON. Changing a vector changes the contract: bump the role
crate's version and say why in the commit.
