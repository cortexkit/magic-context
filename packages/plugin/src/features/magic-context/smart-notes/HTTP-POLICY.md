# Smart-note HTTP checks

Network responses are streamed, stopped before storing the chunk that crosses the
limit, and bounded to **1 MiB per httpGet**, including redirect bodies and any
container-readability probe. DNS validation, pinned connections, address fanout,
redirect bounds, cancellation and the single wall-clock deadline still apply.
Oversized responses report the URL, observed minimum byte count and limit as a
persistent failure, not as evidence of absence or of a met condition.

The original 64 KiB limit was introduced with compiled checks in commit
34f5ef74c34d7da013f497ff3eb6d4c2a28563a3. Blame and `git log -S` locate it in
the streaming transport alongside timeout and sandbox resource bounds; the commit
contains no explanation of the specific numeric choice. It bounds untrusted
network/memory input, not model input: response bodies go to QuickJS, never to the
compiler or confirmation model. The compiler still limits repair error feedback
to 2 KiB, generated output to 128 Ki characters and compiled code to 64 KiB.
The local readFile limit remains 64 KiB and the sandbox heap remains 8 MiB.

## Check and sweep deadlines

A guarded HTTP call has a 5-second wall-clock deadline, including DNS (whose own
limit is 3 seconds), redirects and readability probes. Compile dry-runs, scheduled
checks and liveness checks share a check deadline derived from that HTTP deadline:
5 seconds plus 1 second of VM entry/resumption margin. The 2-second execution
budget still interrupts busy loops; time suspended in HTTP does not spend it.
Multiple sequential HTTP calls share the check deadline, not a fresh check budget
per call.

The dreamer's due-check sweep still has a 10-second outer budget (standalone timer
sweeps retain 15 seconds). After the first attempt, another note is admitted only
if a full 6-second check budget remains. Fast checks can still fill the existing
10-note cap, but slow sweeps process fewer notes instead of truncating each HTTP
request. The outer deadline covers WASM loading and queuing for the shared VM.
Once admitted to execution, even the first check gets its full 6-second deadline
instead of the sweep's remainder: cold loading cannot deprive JavaScript of its
2-second CPU budget. A sweep may therefore overrun by at most one check deadline;
it admits no more notes after that. Caller/lease cancellation still interrupts an
active check. External cancellation leaves note health unchanged unless running
JavaScript has already exhausted its CPU budget, which remains a logic failure.

The shared sandbox module load has its own 10-second infrastructure deadline,
independent of the guest's CPU/HTTP budget and any caller's cancellation. A stalled
load returns **not run** (a cancelled result), spends no note-health strike, and
evicts the cached attempt so the next sweep can retry. A caller may still give up
earlier at its admission or lease deadline without cancelling other callers' load.
Late load completion/rejection is consumed but cannot publish a module over a
replacement attempt or execute a check that already returned not run.

Every host capability await is bounded at the VM bridge by the run's abort signal,
not just by the transport's cooperation. A promise that never settles cannot keep
the VM or serialization lock suspended beyond the check deadline (plus event-loop
resumption/cleanup). On timeout the bridge rejects, QuickJS resumes into its
interrupt handler, and the context is disposed before another check starts. Late
host fulfillment or rejection is consumed without accessing the disposed context.
The whole evaluation is not raced against cancellation: running JavaScript still
classifies CPU exhaustion itself, and only queued callers can give up immediately.

HTTP/DNS deadlines and a check's own deadline while suspended in HTTP carry a
transient retry time with a five-minute minimum. Storage applies exponential
network backoff on top, without spending compilation/logic strikes or creating
fallback/owner-repair notices. A busy loop, including one after a completed HTTP
call, remains a normal execution failure rather than a transient network failure.
Pi uses the same dream-task executor, compiler and sandbox as OpenCode, so these
bounds and classifications apply to both hosts.

## Absence versus inaccessible data

A watched resource returning 404 or 410 is absent. Normal guest verdicts are
trusted: absence can mean met for a deletion or withdrawal condition. Old compiled
checks sometimes throw on every non-200 status. The shared fetch helper classifies
HTTP access failures, and the sandbox preserves the absence observation outside
guest code: when a check throws after observing absence without a host network
failure, it becomes not met instead of an exception. Host network failures remain
failures even when guest code catches them and returns `met: true`.

GitHub conceals private repositories with 404. For GitHub API, raw-content and web
URLs, an absent resource first requires a readable `/repos/OWNER/REPO` response.
For npm URLs, it requires readable package metadata (including scoped names).
These probes use the same SSRF policy and byte/deadline budgets as the resource.
A 404/410 container response is indistinguishable from a nonexistent container;
both are reported as **not publicly readable**, not claimed to be private or
permanently nonexistent. This is deliberate: missing repositories/packages require
owner repair or a different data source, whereas missing releases/files/versions
inside readable containers are normal waiting states. Inaccessible containers and
non-rate-limited 401/403/451 responses park the note rather than retrying forever.

Generic document origins have no universal container-metadata API, so their
404/410 responses indicate absence without a probe. This cannot detect arbitrary
sites disguising authorization failures as 404. Explicit 401/403 and legal-access
451 responses are persistent access failures. HTTP 401/403/429 with exhausted
rate-limit headers or Retry-After is transient, not an authorization diagnosis.
The host preserves the maximum reset epoch / Retry-After (seconds or HTTP date)
through sandbox and compiler failures into scheduled-check, compilation and
liveness backoff. Retries wait until at least that deadline and the ordinary
backoff, with a five-minute minimum if hints are missing/malformed. Rate limits
never trigger owner notices or reauthor a healthy check. HTTP 408/429, 5xx and transport
failures/timeouts retry later. None constitutes evidence that a condition is met.

Persistent failures in compilation, scheduled checks and liveness checks use the
same stored, deduplicated owner notice, keyed by note and condition. Dismissal of
the notice does not cause another alert for an unchanged condition. The smart note
itself stays pending and visible in `ctx_note read`. Uncheckable sources store
`check_status = 'parked'` and the reason in `ready_reason`; compilation, scheduled
checks, liveness checks and fallback evaluation all skip them. Updating the note's
`surface_condition` to a different condition clears the parked state and reason
and schedules compilation again. Content-only edits do not un-park a note.
Other persistent failures, such as oversized responses after bounded-endpoint
repair, retain the existing week-long recompilation backoff.

## GitHub authentication

The smart-note transport has no configured GitHub-token support. It sends only
Host, User-Agent and Accept; neither GITHUB_TOKEN nor GH_TOKEN nor another
component's configured token is read or sent. Checks therefore share the public
unauthenticated quota. Adding authenticated requests needs a separate explicit
credential policy so redirect targets and unrelated note URLs cannot receive a
token. Header hints prevent quota failures from becoming permanent owner alerts,
but do not increase that quota or coalesce requests from different notes.

GitHub `/search/code` requires authentication even for public repositories. The
compiler refuses literal code-search endpoints before its dry run, and the HTTP
guard refuses them at runtime (including redirects and older compiled checks).
The compiler is instructed to use public contents or bounded commits endpoints
only if they answer the same question, not to silently weaken the condition.
