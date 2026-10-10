# Issue 649: real-host system-prompt verification

This report checks the Pi section-injection change from PR 648 against the pinned host releases below. No product-source changes were made.

## Method and isolation

Each case used a real host process in persistent RPC mode and two turns in the same session. A local `MockProvider` captured the provider request bodies. The small probe extension registered a `before_agent_start` handler that wrote `event.systemPromptOptions.sections.probe_ext = "<probe>"` when the sections API existed. For each Pi release it loaded both before and after Magic Context. Oh My Pi cases loaded Magic Context alone.

Host packages were installed at exact versions under a task-specific temporary install root and selected by package JSON: `@earendil-works/pi-coding-agent` (Pi) and `@oh-my-pi/pi-coding-agent` (Oh My Pi). Pi 0.83.0 was added as the pre-0.87 control. The tests used no external provider or credentials.

Each host received its own throwaway root under:

`/private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/issue-649-post-merge/`

For each run, `HOME`, Pi/OMP agent directory, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`, `XDG_RUNTIME_DIR`, `OPENCODE_DB`, `MAGIC_CONTEXT_STORAGE_DIR`, and the host temporary directory pointed inside this task root. The launcher itself also used a separate `launcher/` root there. No live Pi, OMP, OpenCode, or Magic Context stores were opened.

The probe captured `lsof -p <host pid>` while every host was alive, saved it as `<run-root>/lsof.txt`, and refused a run unless at least one `.db` path was listed and every `.db`, `.db-wal`, or `.db-shm` path was beneath that run's isolated host root. Pi opened only `data/cortexkit/magic-context/context.db` and its SQLite sidecars. OMP also opened its isolated `.omp/agent/agent.db`, `models.db`, and `cache/legacy-pi-extension-cache.db` (18.8.7 additionally opened `skill-descriptions.db`). `results.json` records each run directory and all captured database paths.

## Results

“Prompt content identical” compares the complete JSON serialization of the provider's `system` value across the two turns. Oh My Pi prepends one host-owned `x-anthropic-billing-header` system item whose `cch` changes every request; that item is reported separately and is not removed from the full-field result. The prompt-content comparison removes only that exact OMP billing item. Consequently, the OMP prompt content is stable, but its literal `body.system` field is not byte-identical.

| Host | Version | Load order | Magic Context in both bodies | `<probe>` in both bodies | Prompt content identical on turn 2 | Entire `body.system` identical | Handler errors |
|---|---:|---|---|---|---|---|---|
| Pi | 0.87.1 | probe → Magic Context | yes | yes | yes | yes | none |
| Pi | 0.87.1 | Magic Context → probe | yes | yes | yes | yes | none |
| Pi | 1.1.0 | probe → Magic Context | yes | yes | yes | yes | none |
| Pi | 1.1.0 | Magic Context → probe | yes | yes | yes | yes | none |
| Oh My Pi | 18.2.6 | Magic Context only | yes | n/a | yes¹ | **no¹** | none |
| Oh My Pi | 18.8.7 | Magic Context only | yes | n/a | yes¹ | **no¹** | none |
| Pi (pre-0.87 control) | 0.83.0 | Magic Context → probe | yes | no (sections absent) | yes | yes | none |

¹ On OMP 18.2.6, the two system fields started with these different host-generated items:

```text
turn 1: x-anthropic-billing-header: cc_version=2.1.257.efd; cc_entrypoint=cli; cch=e82aa;
turn 2: x-anthropic-billing-header: cc_version=2.1.257.efd; cc_entrypoint=cli; cch=c8edf;
```

OMP 18.8.7 did the same with `cc_version=2.1.280.096`, `cch=ba7fd` on turn 1 and `cch=04108` on turn 2. After removing only this billing-header item, every remaining system block was byte-identical within each OMP session; the Magic Context block itself was present and unchanged on both requests. Thus OMP's effective prompt content did not churn, but literal byte equality of the whole provider `body.system` is not met because the host metadata changes.

The harness checks extension-error events after each turn. All seven host sessions completed both turns with no extension errors, including both OMP versions.

## Captured provider-body excerpts

These excerpts are from the captured provider `body.system` values. The Pi excerpt from the probe-before load order shows the probe section and Magic Context together; the reverse load order placed the same probe section after the Magic Context section.

```text
Pi 0.87.1, probe before Magic Context:
</cwd>

<probe_ext>
<probe>
</probe_ext>

<magic_context>
## Magic Context

### You are the user's long-term partner on this project — not a one-off hire
```

```text
Pi 1.1.0, Magic Context before probe:
## Magic Context
...
</magic_context>

<probe_ext>
<probe>
</probe_ext>
```

```text
Oh My Pi 18.2.6, first request:
x-anthropic-billing-header: cc_version=2.1.257.efd; cc_entrypoint=cli; cch=e82aa;
...
## Magic Context

### You are the user's long-term partner on this project — not a one-off hire
```

```text
Oh My Pi 18.8.7, first request:
x-anthropic-billing-header: cc_version=2.1.280.096; cc_entrypoint=cli; cch=ba7fd;
...
## Magic Context

### You are the user's long-term partner on this project — not a one-off hire
```

```text
Pi 0.83.0 control:
## Magic Context

### You are the user's long-term partner on this project — not a one-off hire
```

On Pi 0.83.0, the probe extension observed `hasSections: false` on both turns and did not set a probe section. The provider still received the Magic Context block. This is the forced-prompt fallback described by the current handler: when `hostSections` is absent, it returns `{ systemPrompt: composedPrompt }` before a session exists and `{ systemPrompt: result.systemPrompt }` after it does (`packages/pi-plugin/src/index.ts:2465-2470, 2502-2512`).

## Reproducibility artifacts

The reusable probe is `packages/e2e-tests/scripts/issue-649-real-host-probe.ts`. It uses `PiTestHarness` with exact package-JSON overrides, and the e2e RPC client supports an extension after Magic Context for the reverse load-order case.

The final run's retained scratch artifacts are in `/private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/issue-649-post-merge/`:

- `results.json`: version, order, assertions, system-content hashes, per-run evidence directory, and inspected database paths.
- `<run-root>/provider-bodies.json`: the two selected turn bodies.
- `<run-root>/all-captured-requests.json`: all mock-provider captures, including raw bodies.
- `<run-root>/lsof.txt` and `database-paths.json`: the live-process open-file listing and checked database paths.
- `pi-*-events.jsonl`: probe-extension section observations.
