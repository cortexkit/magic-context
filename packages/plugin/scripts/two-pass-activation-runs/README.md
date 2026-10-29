# Disposable two-pass integrations

These scripts exercise real hosts without using an operator installation or its
stores. They do not enable a production profile. Candidate authorization is
written only into the staged plugin copy by `runActivation` or the mock proof's
`prepare` operation.

## Host transports

`host-adapters.ts` exports `openCode1Adapter`, `openCode2Adapter`, and
`ohMyPiAdapter`, implementing `ActivationTransport` through
`processActivationTransport`. They install pinned releases under `host-dist`,
build the staged plugin, launch a foreground host, and connect its HTTP or JSONL
session API. The releases are OpenCode 1 **1.18.31**, OpenCode 2 **2.0.22**, and
Oh My Pi **18.12.3**. Build and launch are Linux-only; use an explicitly approved,
capped container if necessary.

Create the canonical root under `$TMPDIR/magic-context/`, then supply a fresh
`installRoot` below it. `disposableEnvironment(root)` supplies all six required
storage/configuration roots. Stage/build subprocesses also receive private
HOME, cache, and temporary directories. Staging excludes `.env`, `.npmrc`, and
`.yarnrc` credential files, existing dependencies, symlinks, build output, and
SQLite stores. No host
store is copied, so there is no credential-table sanitization shortcut.

The provider endpoint must be HTTP on `127.0.0.1`. The supplied mock provider is
appropriate for the provider-free proof. A separately authorized run may supply
a scoped, single-attempt loopback provider gateway instead; that gateway must
not add unobserved retries or dispatches. `providerId`, `providerPackage`, and
`piApi` must come from the actual host catalog for a non-mock route. A display
name, a route from another provider, or the mock's settings are not provenance
for a candidate profile.

Every HTTP attempt crosses `meteredDispatch` before forwarding. Each attempt
reserves one step and zero internal retries, because a host retry is another
separately observed HTTP request. Usage comes from all captured responses, not
from the plugin's last-step summary. A dispatch's purpose defaults to
`unclassified`; an optional classifier must use observed metadata, not words in
the prompt. Unknown usage retains its full reservation.

A lazy host reports carrier `unobservable` and store `null` until durable stage
rows and open handles establish them. The store binding requires the host to
hold that exact database (or its WAL) and requires the plugin's schema. The activation driver's receipt/history inspection opens that bound store read-only.

Each `runSession` starts a foreground session. Normal runs send the supplied
prompt unchanged. The explicit `forceWrapup` mock-probe option adds a confirming
turn and `/ctx-wrapup 1` to trigger short synthetic history; it is not a normal
activation or provider-quality trial. The adapter waits for turn one to be
published and turn two to be resolved on the same retained historian child. A timeout or a
terminal failure is not credited as success. Published/resolved rows establish
only those observed lifecycle stages; these APIs do not expose the plugin's
deferred-task queue, so global scheduler idleness remains **unobservable**.
Host events are recorded, but their contracts do not attribute a cache rebuild
to Magic Context. Rebuild status is therefore **unobservable**, not zero.

## Provider-free host proof

`mock-host-proof.ts prepare <lane> <root> <install> [carrier]` writes a mock
candidate into the staged source and seeds contradicted project memory. OpenCode 1
requires its carrier argument explicitly. `reset` uses the same arguments and
recreates only the disposable host/plugin stores before seeding. Build
the plugin after preparation. `run` uses the real host with the mock, requires
Linux with only a loopback network interface, requires actual `lsof` rather than
the `/proc` compatibility fallback, reconciles every captured request with a
settled reservation, and records raw request capture plus read-only store
witnesses. The mock reports distinct synthetic token counts on every request so
a last-step-only total cannot accidentally match.

Install host packages and runtime SDKs while registry access is available, then
run the proof container with `--network none`. An approved local container must
also use its agreed CPU/memory/PID caps, niceness, a read-only worktree mount,
and only a disposable scratch mount. Override the image entrypoint explicitly.
Preserve sanitized proof outside build directories before deleting scratch.
Never treat the synthetic tariff, generated usage, or mock replies as paid
provider pricing, cache-reuse evidence, grades, or an activation result.

## Anthropic measurement and grants

`measurementTransport` first invokes its supplied Broca opener. The concrete
`brocaMeasurementRoute` opens one isolated runner route and probes
`role.describe`, but admits no inference send: the pinned TypeScript client
cannot declare the runner role version and no attested retained two-turn
raw-history wire is available. It reports that limitation through its observation
callback and returns `null` for the defined first-party fallback. The relevant
contracts are the client's `RouteOpenOptions` in `@cortexkit/subc-client` 0.11.1,
`crates/mc-module/src/dream_dispatch/broca_port.rs:125-175`, and
`crates/mc-module/src/historian_producer.rs:63-80`. Do not invent a Broca wire
format or infer raw-history preservation from retention flags.

The direct opener starts an isolated Anthropic worker. It retains exactly two
turns, preserves the actual first reply in assistant history, uses identical
first-turn cache breakpoints, serializes requests, and reports
observed input/output/cache counters. The default endpoint is the first-party
Messages API; the only override accepted is HTTP on `127.0.0.1` for a mock.
`runCacheMeasurement` owns the shared meter and reserves before calling `send`.
Byte-prefix extension and a mock cache counter are not proof of real cache reuse.
The named Anthropic key is shared with routing. Each send allows at most two
429 retries, honors `retry-after` seconds or HTTP dates, and stops instead of
shortening a wait longer than 30 seconds. Exhaustion is `credential_rate_limited`.
Credit/billing refusals take precedence over 429, stop immediately as
`credential_no_credit`, and latch the client closed to further sends. No alternate
key is selected. Meter reservations include the three-attempt ceiling; request
attempt evidence records the provider host even for refusals. Serialization is
within this launcher and its client processes, not a cross-application lock on
routing's independently running jobs.

`scopedCredentials` accepts a lazy broker-client constructor and an in-memory
enrollment token. It rejects non-Darwin construction before calling that
constructor. The existing `withCredential` Darwin-only fetch boundary is
unchanged. No enrollment files, host configs, or environment-key fallbacks are
read by this adapter. The trusted Mac orchestrator uses the CortexKit credential vault (CKCRED) and supplies exact grants named
the exact configured Anthropic label for direct measurement and `apikey:cline-pass`
for that OMP provider, and supplies the run-ended callback. Direct measurement
requires an explicit `anthropicGrant`; it has no grant-name default.

Linux workers accept **already-fetched** material only through the host start or
direct-client child-environment seam. Those seams consume the supplied API-key
slots after spawning; host logs and returned evidence mask the material, and
shutdown drops redaction copies. The bridge must give a worker neither an enrollment token
nor a credential-broker connection. Tests use mock material and verify the child
receives it, it is absent from argv and persisted client files, input slots are
cleared, and Linux cannot construct a broker client.

### Mac-to-container stdin bridge

`container-launcher.ts` is the trusted Mac entrypoint. Live mode alone opens the
normal `ClaustrumClient.getScoped` API using an explicitly supplied enrollment
file. It requests the exact configured name with `minTtlMs = runMs + 5000`
(`min_ttl_ms` on the vault wire), validates an optional returned identity, and
stops on any vault refusal without reporting auth failure. Refresh-bearing
responses, including structured refresh/access bundles, are refused by name as
`credential_refresh_token_refused`. Only opaque API keys or expiring access
tokens are admitted; access tokens must cover that TTL. No source is opened on
import, in mock mode, or on Linux.

Each job starts one `--rm --init --cpus 4 --memory 8g --pids-limit 1024` container
with no mounts, read-only image/root, dropped capabilities and owner-only auth
tmpfs. One bounded stdin payload carries one grant to `container-child.ts`; EOF
ends the handoff and stdin is destroyed before model dispatch. No enrollment,
broker socket, key argument, Docker environment entry, or credential file crosses
the boundary. The reader supplies only its host child's `TWO_PASS_PROVIDER_API_KEY`
(or the direct worker's `ANTHROPIC_API_KEY`), not its own environment or init's.
OpenCode config uses `{env:TWO_PASS_PROVIDER_API_KEY}`; OMP uses the variable name.
OMP auth mode is explicitly `apiKey` for API-key grants (not its custom-provider
OAuth default). OMP's non-official Anthropic-compatible endpoint uses Bearer
authorization even with a static API key; the direct first-party client uses
`x-api-key`.
The authorized credential boundary is the **host process tree**: the host may
pass that variable to its own model-calling descendants, in their environment
only. The evidence lists observed processes, parents, and whether each inherited
the variable. Docker init, the stdin reader, version probe, and unrelated
processes do not receive a credential environment. The reader necessarily holds
transient handoff/redaction material in memory, never in its environment or files.

Immediately before Docker spawn, the launcher rejects raw, base64 or hex key
forms in argv or the restricted spawn environment. Mac attestation is validation
of these exact spawn inputs, **not observation of a Mac process listing**; the
paid path does not require native Mac `ps`. Inside Linux it inspects live Docker
metadata, init `/proc/1/{cmdline,environ}` and `ps -eo args=` before acknowledging
dispatch. It retains clean metadata, checks `--rm` removal, and redacts
stdout/stderr across chunk boundaries before writing logs/evidence. The child
checks host-tree argv and environment slots, provider headers in mock mode, and
the entire writable auth/session tree after host exit, including SQLite files
and SDK dependencies. Symlinks may resolve only within that tree or to the
read-only, credential-free installation image. Any material in an auth, session,
log or other scanned file refuses the adapter. Files are not exported; the report
retains nondependency file names plus the full scanned-file count and path-manifest
hash, rather than dumping dependency trees into oversized log lines. All inherited key copies disappear with the `--rm`
container. The trusted Mac emits `credentialRunEnded` after each job.
Receive/send buffers are zero-filled, environment slots consumed after spawn,
and string references dropped at shutdown. JavaScript cannot guarantee physical
erasure of immutable strings or runtime/OS copies; process exit and tmpfs
destruction are the final lifetime boundary, not a claim of forensic RAM erasure.

Prepare the pinned, credential-free images (registry/OS access only while installing):

```sh
for lane in opencode-1 opencode-2 omp; do
  bash packages/plugin/scripts/two-pass-activation-runs/prepare-container-image.sh "$lane" "two-pass-credential-$lane:mock"
done
```

One command from the Mac runs all three real hosts and the direct cache client
against loopback mocks, with randomized synthetic material and `--network none`:

```sh
bun packages/plugin/scripts/two-pass-activation-runs/container-launcher.ts \
  packages/plugin/scripts/two-pass-activation-runs/mock-credential-run.json \
  .cortexkit/internal-docs/investigations/two-pass-credential-bridge/evidence
```

`paid-credential-run.json` is now a **preparation plan, not an executable
campaign**. It inventories every matrix row plus the cache check, names the two
exact grants, records current sources and proposed grader/budget inputs, and
explicitly excludes only the two dropped Sonnet fallback rows. Other unresolved
jobs stay visible and prevent dispatch with `credential_unresolved_jobs`.
`preparationOnly: true` also refuses with `credential_campaign_driver_required`,
even if all unresolved rows are excluded: the credential probe cannot load a
corpus, run the replay schedule/graders, or share a ledger across containers.
Its `@corpus:` / `@persisted-measurement:` prompt references must never be sent
as literal model prompts. Selected-candidate images, real read-tool/origin
evidence, billing gaps and prior-spend reconciliation are still outstanding.

Run the static, provider-free preparation check from the repository root:

```sh
bun packages/plugin/scripts/two-pass-activation-runs/paid-preflight.ts \
  --mock-preflight packages/plugin/scripts/two-pass-activation-runs/paid-credential-run.json \
  <private-preflight-result.json>
```

Run it on Linux or in a capped offline container with the private corpus mounted
read-only. It uses the native corpus/profile preflight and existing token
counter, emits only case ids/sizes/counts, and exits **1 while anything is
unresolved**. Static profile acceptance is not an effective host-profile report
or live authorization. Grading estimates use recorded-output proxies and full
output allowances; the proposed retry ceiling is conditional on caps a future
campaign driver must enforce. Actual unknown charges remain null, not zero.
The temporary `corpus-readonly` path must be restaged from the authorized bundle
before reproducing the check; the private data is never committed.

For separately prepared credential probes, the launcher accepts config, evidence
directory and explicit enrollment-file path. Network mode must be
`network: "bridge"` for non-mock jobs. Paid jobs require an exact listed grant;
grant-free jobs require provider `opencode` on an OpenCode lane, an explicit zero
tariff with a nonempty `source`, and `checkedAt` equal to today's UTC date.
They receive no secret stdin payload or credential environment and never open
the vault. OpenCode uses its literal `public` API marker for free access; that
marker is not a user credential or a grant. Missing network or paid grants
refuse with `paid_network_bridge_required` or `real_grant_list_required`.
Mock configs can never select bridge networking. The launcher
logs the selected network once per job. The proxy records each upstream host
with every metered host dispatch; the cache worker emits each HTTP attempt's host.
No paid command was executed in the bridge proof.

The six free Zen rows in `../two-pass-candidate-matrix.json`
(three models across two OpenCode versions) use
provider `opencode`, `priceClass: "free"`, and name no vault grant. They therefore
need no grant handoff through this launcher. Historical zero tariffs are not
proof of current billing or origin availability; the preflight below still applies.

## Before an authorized campaign

Resolve or drop every matrix row with unresolved configuration, variant, route,
or tariff provenance; the six explicit zero tariffs are historical free-catalog
evidence, not a fresh billing attestation. Supply independent graders and their
exact tariffs/bounds, reconcile previous spending into one shared ledger, and
verify that the host's real read tool exists but every historian read is blocked,
and record a fresh host-transport send that is not refused at the Zen origin,
before any Zen run. These prerequisites are defined in
`.cortexkit/internal-docs/investigations/two-pass-validation-report.md`,
"Live validation prerequisites", and are not established by the mock endpoint. Hydrate the private corpus only through its authorized process.
Antigravity and grader credential grant names remain unresolved until their
actual auth-plugin/catalog identities are supplied. These mock integrations do
not authorize a row, an exception, a cache-reuse claim, or an allowlist change.

## Guarded OMP retention

The OMP retained/check path is separate from ordinary one-pass print mode.
Before selecting continuation, an eligible profile asks an idle instance of the
resolved OMP executable to advertise RPC v2, successfully negotiate it, and
return an empty `get_state.data.dumpTools` inventory. A missing/failed protocol
falls back to one pass with one diagnostic per runner. The actual retained child
negotiates again before its first provider prompt. Each turn requires its own
correlated `prompt_result` as well as the final assistant state; queued work must
settle before completion is credited. Bounded v2 chunks preserve UTF-8.

Only that new retained/check path disables extension discovery and user-supplied
extension entries. The shipped lean guard entry suppresses all tool registration
under its retained-OMP marker, while retaining budget-finalization refusal and
blocking unexpected tool calls even before finalization. Calibration remains
loaded without adding tools. The real child inventory and captured provider
requests must both have no tools. Plain Pi's existing guarded-RPC capability is
unchanged, and no Pi candidate or production allowlist entry is added.

Ordinary OMP print-mode discovery is deliberately unchanged. A separate released
policy finding is retained under
`.cortexkit/internal-docs/investigations/two-pass-mock-integrations/released-omp-tool-boundary.md`:
`--no-tools` alone does not exclude discovered third-party extension tools on
OMP 18.12.3. The new retained guard must not be mistaken for a released one-pass
backport.
