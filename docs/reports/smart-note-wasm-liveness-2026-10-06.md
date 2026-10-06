# Smart-note WASM liveness and ownership

## Findings

The Linux failures waited on the native `WebAssembly.instantiate` promise inside
QuickJS module initialization, before VM lock entry or any capability call.
The shared pending load had no independent deadline. A slow load could therefore
block every later check without ever reaching the existing guest deadline.

On Bun 1.4.2 (`744846f84`), a serial isolated smart-note run also reproduced the
problem. Its later load took 98.280 seconds wall, 293.955 seconds user CPU and
3.024 seconds system CPU. Multiple test workers are not required, and the high
user CPU rules out simply idle promise delivery. Disabling only the optimizing
WASM tier (`BUN_JSC_useOMGJIT=0`) changed that run from 150 pass / 9 fail to
159 pass / 0 fail; real load times were 8.860–50.728 milliseconds.

Thirty plain constructions in one stable realm were fast on actual Linux CI:
36.778 milliseconds initially and 12.157–18.068 milliseconds thereafter. Bun's
file isolation resets module caches, global/process symbols, environment changes
and even mutable preload holders. The apparent process-wide source cache does not
survive that test-file reset.

The optimizing tail also affects a stable real host after hot guest loops. After
three correctly interrupted two-second checks and prompt resource disposal,
native Linux spent approximately one core for another 50 seconds. CPU fell below
10% in the 50–55 second window and was effectively idle in the 55–60 second window.
The repaired control reported zero surviving runtimes. Correct ownership thus
repairs a leak but does not cancel JSC's background optimization.

Native pure-guest option controls showed:

| Interpreter / guest budget | Idle CPU after hot checks |
|---|---|
| Asyncify / 2 seconds | About one core for 50 seconds; quiet by 60 seconds |
| Sync-only / 2 seconds | 0.361%, then 0.085%; quiet within 10 seconds |
| Asyncify / 50 milliseconds | About one core for 55 seconds; still 18.7% in the final 55–60 second window |

The sync-only interpreter cannot directly suspend the existing asynchronous host
capability API. Shortening guest compute does not remove the tail and would not
preserve the two-second allowance. A synchronous initialization experiment was
removed after a native run reported a 180-second main-thread load.

## Repairs and immediate test policy

Shared initialization now has a separate ten-second wait. Timeout returns a
cancelled **not run** result, spends no note-health strike, evicts the failed
cached attempt and allows a later sweep to retry. Late completion/rejection cannot
publish over a replacement or execute an already-cancelled check.

Each check explicitly owns its runtime and context. In quickjs-emscripten 0.32,
the async module helper passes runtime ownership that the async context constructor
discards. Context disposal alone left the runtime alive. Cleanup now detaches the
private native capability functions while HostRef callbacks remain registered,
releases the final capability-object handle, disposes the context, then disposes
the runtime. A local evaluation scope avoids global lexical roots. Tests cover
retained wrappers in globals/prototypes/pending jobs, guest failure, CPU and heap
exhaustion, and prove both lifetimes are dead without disposal errors.

Plugin and Pi package test scripts disable OMG only for their test subprocesses.
This prevents per-file isolation from repeatedly paying the optimizing-tier cost.
It is **not a production setting**, and no host launcher or product code sets it.
Production native optimization remains a separate issue; the agreed follow-up is
a short-lived sandbox child per sweep, with capability IPC and exit bounding the
optimizer tail. Node 22/V8 must be measured before deciding which hosts need that
backend.

## Sources and limits of attribution

- Bun's pinned initialization applies `BUN_JSC_*` before `.env` loading and warns
  that these are unstable debugging options:
  [initialization](https://github.com/oven-sh/bun/blob/744846f844374847c902b5e7fd59b4342a51ef99/src/jsc/bindings/ZigGlobalObject.cpp#L283-L379)
  and [option warning](https://github.com/oven-sh/bun/blob/744846f844374847c902b5e7fd59b4342a51ef99/src/jsc/lib.rs#L541-L550).
- [JSC option names](https://github.com/oven-sh/WebKit/blob/main/Source/JavaScriptCore/runtime/OptionsList.h)
  define `useBBQJIT`, `useOMGJIT` and `useWasmIPInt`. Installed Bun 1.4.2 accepts
  `useOMGJIT=0`; an invalid-name control exits with an error rather than ignoring it.
- [Bun #127](https://github.com/oven-sh/bun/issues/127) documents an old task-queue
  bug leaving instantiate pending; it was fixed in 2022 and is not evidence that
  this modern CPU-heavy failure is the same bug.
- [Bun #31158](https://github.com/oven-sh/bun/issues/31158) documents a Linux WASM /
  foreign-runtime signal interaction. Its follow-up corrected the initial thread
  attribution. No Go library or matching signal mechanism was demonstrated here.
- [Bun 1.4.2 release notes](https://bun.sh/blog/bun-v1.4.2#upgraded-javascriptcore)
  list about 350 upstream JSC commits, but no matching asyncify/isolate CPU-cliff
  fix. Tracker searches found no exact report of this measured interaction.

The tier-off control is causal evidence for the optimizing tier, not a claim to
have identified a particular upstream compiler function or fixed native JSC.
