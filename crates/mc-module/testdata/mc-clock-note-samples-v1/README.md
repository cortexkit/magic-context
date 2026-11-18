# mc-clock-note-samples-v1

What a runner sees of ck-mc's clock note: the `session.send` that carries
it, and ck-mc's `role.describe` reply, whose `reminder_templates` publishes
the clock template next to the `ctx_reduce` and `ctx_keep` reminder templates.

The files come from the module's own code. Regenerate them with
`MC_REGENERATE_CLOCK_NOTE_SAMPLES=1 cargo test --locked -p mc-module --lib
clock_note::tests::samples_v1 -- --exact`; the test fails when a file here is
stale. `SHA256SUMS` covers every sample, not this file.

## The note

The template is `{"id": "mc.clock_note.v1", "text": "Now: {now}", "slots":
{"now": {"type": "datetime", "format": "utc_minute"}}}` (llm-runner 0.8.62,
capability group `template_datetime`). ck-mc sends the time as integer Unix
seconds; the runner renders it as `Ddd DD Mon HH:MMZ` in UTC. Nothing else
goes in the note.

- `session-send-turn-system.json`: the send to a runner that declares
  `template_datetime` and `turn_system` (it declares `delivery_order`, and
  its `delivery_order_modes`, if it lists any, name `turn_system`). Delivery
  `[turn_system, tool_result]`: a turn-scoped system message where the route
  takes one, otherwise appended to the next tool result. Both are persistent.
- `session-send-tool-result.json`: the send to a runner that declares
  `template_datetime` but not `turn_system`: delivery `[tool_result]`.

Each file holds `request`, the `session.send` body exactly as ck-mc encodes
it on the session's own route (`{"method", "params"}`), and `rendered`, the
text the runner renders from it. The time is 2026-11-18T22:52:00Z, the
contract's own clock-notice sample, so it renders `Now: Wed 18 Nov 22:52Z`.
`send_id` is `mc.clock_note:counter:<n>`, from the session's reminder
counter; `dedupe_key` is `mc.clock_note`, so a newer note replaces one the
runner still holds queued.

A runner that does not declare `template_datetime` gets no clock note and no
fallback text.

## `role.describe`

`role-describe.json`: ck-mc's `tool-provider/v1` `role.describe` reply. Its
`implementation_version` is replaced with `ck-mc (normalized)`, since the
build's own version line changes with every build; everything else is as
served.

`reminder_templates.sender` is the plan `senders` entry core copies into a
session's plan; its last template is the clock template.
`reminder_templates.templates` lists every template's id, digest and the
delivery modes ck-mc may use; the clock template's are
`["turn_system", "tool_result"]`.

A runner without `template_datetime` refuses a plan holding a datetime
template (`invalid_params {field: "plan.senders"}`), so core must leave the
clock template out of such a runner's plan. When a session's plan lacks the
template anyway, its runner refuses the note with
`invalid_params {field: "template"}`; ck-mc then sends that session no clock
note until its next Setup.
