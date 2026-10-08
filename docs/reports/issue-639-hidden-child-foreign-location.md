# Issue 639: OpenCode 2 hidden dreamer child edited the user's files

## Result

0.46.0 users on OpenCode 2 are affected. Current master (0.46.0 plus one
unrelated dependency bump) reproduces the issue on a real OpenCode 2.0.24
host. A `map-memories` child received the bare `mc:hidden:<uuid>:<uuid>`
marker. It then ran `edit` on `infra/main.tf` (`10.0.0.1` became `6.6.6.6`)
and ran `echo pwned > pwned.txt` through `shell`, both in another
repository. The owning run logged `HiddenCompletionRefusal
hidden_prompt_unrecognized: Host did not dispatch the hidden child context
hook`, which is the reporter's exact line.

OpenCode 1 and Pi are not affected (see "Other harnesses").

## Root cause

Three host facts, each checked on the real host or in its source:

1. **OpenCode 2 builds one plugin instance per location (directory) but
   delivers every location's events to every instance.** I confirmed this
   with a probe plugin in two directories. The instance in directory A saw
   `session.execution.succeeded` (plus `session.created`, the
   `session.step.*` events and the rest) for a session in directory B. The
   event carries no location. The session's context hook ran only in B's
   instance.
2. **A child session takes its parent's location**, and the host runs its
   hooks in that location's plugin instance.
3. **Rule precedence.** Rules are evaluated with "the last matching rule
   wins". This is from the 2.0.24 binary: `rules.flat().findLast(r =>
   match(action, r.action) && match(resource, r.resource)) ?? ask`. The rule
   list is the agent's rules followed by the session's rules (`[...agent.permissions,
   ...session.permissions]`, used for permission checks and for the tool
   snapshot). The config loader's agent transform runs after plugin
   transforms and appends the user's global `permissions` to every agent
   (`for (const a of editor.list()) editor.update(a.id, (m) =>
   m.permissions.push(...userRules))`). Magic Context's
   `[*:*:deny, ...allow]` therefore loses to a user's `edit: allow`.

Magic Context's v2 dream trigger (`v2/hooks/dream-trigger.ts`) reacted to
every `session.execution.succeeded` event, including events from other
directories. It ran A's due dream tasks with A's executor and parented the
child to B's session. The child lived in B's location, so B's instance ran
its context hook. `HiddenChildHook.apply` returned `false` for a session it
did not own, and the child went through B's ordinary managed pass: the bare
marker was sent to the model, B was the working tree, and the tools were
whatever the user's rules allowed. A's executor only noticed
`!attempt.shaped` after `prompt`/`wait` had finished, then fell back to the
next model, which the reporter saw as Sonnet followed by Gemini. The
reporter's "ordinary project memories cached" in a hidden session fits this
path: the child was handled as one of B's user sessions.

The first-minute refusal after restart in issue 602 has the same cause.
After a restart, overdue tasks are due, and the first turn that ends in any
other open directory triggers them from the wrong instance. Once those tasks
have run, nothing is due, so it did not recur.

Resolved permissions the host gave every hidden Magic Context agent, with a
user config of `edit: allow` and `shell: allow`, on 2.0.24 (rules for
`external_directory` omitted):

| agent | resolved rules |
|---|---|
| historian | `*:deny, edit:allow, shell:allow, browser:deny` |
| dreamer-classifier | `*:deny, edit:allow, shell:allow, browser:deny` |
| dreamer (curate) | `*:deny, ctx_memory:allow, edit:allow, shell:allow, browser:deny` |
| dreamer-memory-mapper | `*:deny, read/grep/glob:allow, edit:allow, shell:allow, browser:deny` |
| dreamer-primer-investigator | `*:deny, read/grep/glob/ctx_search:allow, edit:allow, shell:allow, browser:deny` |
| dreamer-retrospective | `*:deny, ctx_search:allow, edit:allow, shell:allow, browser:deny` |

Tools the host offered to the mapper child when the hook was missed:
`edit, glob, grep, read, shell, write`.

## Fix: independent guards

Each of the following prevents a tool from running in the regression on its
own (see "Verification").

- **(c) Trigger scope.** The dream trigger runs only for sessions in its own
  location: directory and workspace, checked with `session.get`. A session
  that cannot be read counts as foreign.
- **(b) Refusal before any prompt.** The executor reads back a parented
  child. If the host bound it to another directory, the child is removed
  and the run fails with `hidden_prompt_unrecognized` before anything is
  prompted.
- **(b) Refusal before the provider.** Any Magic Context instance refuses
  the turn or compaction of a session that runs one of the hidden agent ids
  but that it did not register, with `hidden_prompt_unrecognized`. Before,
  such a turn passed through. This also covers a hidden child the user
  opens after a restart.
- **(a) Registration wins.** Each child session is created with the same
  `[*:*:deny, ...allowlist]` rules. Session rules come after every agent
  rule, the user's included, so on the host's own evaluation they decide.
  With every other guard removed, the host neither offered nor ran `edit`
  or `shell` ("No tool named "edit" is currently available").
- **(a) Tool guard.** A `tool.execute.before` hook, registered before any
  hidden run can start, refuses any call from a hidden child that is
  outside that agent's allowlist, whatever the user's permissions say. On
  this host it fires even for a tool that was never offered.
- **(d) Live `dreamer.disable`.** It is now a live key. The turn trigger,
  the shared schedule timer (OpenCode 1, Pi and OpenCode 2), and
  `/ctx-dream` re-read it before every run. A dreamer that was off at boot
  starts on the next context pass after it is turned on.

## Other harnesses (e)

- **OpenCode 1 (1.18.30, real host):** not affected. With a user config that
  allows `*`, `edit`, `bash`, `write` and `task`, every hidden agent's
  resolved ruleset has the agent's own `*: deny` plus allowlist after the
  user's rules. `edit`, `write`, `bash`, `task` and `webfetch` all evaluate
  to `deny`, and each allowlist evaluates to `allow`. The new
  `tests/hidden-agent-user-permissions.test.ts` asserts this.
- **Pi / OMP:** not affected. Children are separate processes with a hard
  `--tools` allowlist, and unknown agents get `--no-tools`. Pi has no
  user-permission layer that could widen the list. OMP's documented caveat
  (discovered extension tools are appended) is unchanged. Existing
  `subagent-runner.test.ts` tests pin the flags.

## Keeping 0.46.0 users safe until the fix ships

- Set `"dreamer": { "disable": true }` in `magic-context.jsonc`, then restart
  OpenCode (on 0.46.0 this key is only read at startup).
- Or set OpenCode's global `edit`, `write` and `shell` permissions to
  `ask` instead of `allow`. A misrouted child then stops at a permission
  prompt instead of changing files.
- Running Magic Context in only one directory per OpenCode 2 server process
  also avoids the trigger. The historian is not affected, because it always
  runs from the user's own session in its own location.

## Verification (summary)

- Reproduced on master and OpenCode 2.0.24 before the fix: the edit landed,
  `pwned.txt` was created, and the run logged "Host did not dispatch".
- New real-host e2e, `tests/opencode2/hidden-child-foreign-location.test.ts`,
  passes on 2.0.24 and on the pinned 2.0.22:
  - Regression: no tool ran and both projects' file hashes are unchanged.
  - Control: the mapper's run in its own directory is offered exactly
    `glob, grep, read`, its `read` returns the file, and all memories are
    mapped.
  - Live disable: off at boot, then on (the run happens), then off with new
    work due (no run).
- Mutation proofs on the real host: with all guards removed, the regression
  goes red (`pwned.txt` created, `Edited infra/main.tf`). Leaving any single
  guard in place keeps it green: trigger scope, executor read-back, context
  refusal, session rules, or the tool guard. Removing the live key or the
  lazy start turns the live-disable test red.
- One unit mutation per guard turns exactly its own named test red.

## Draft bot reply (not posted)

> Thanks for the detailed report, especially the permission list from
> `/api/agent/dreamer-memory-mapper`. It pointed straight at the problem.
>
> We reproduced it on OpenCode 2.0.24 with 0.46.0, so 0.46.0 is affected
> too. Here is what happens. OpenCode 2 runs a separate copy of Magic
> Context for each project directory, but it tells every copy when a
> conversation finishes in any directory. The dreamer reacted to a
> conversation finishing in another project and started its memory-mapping
> run under that conversation. The run's background session therefore
> belonged to the other project, and the copy of Magic Context there had no
> record of it. It let the session through unprepared, so the model got the
> bare `mc:hidden:…` marker and that project's files as its workspace. Your
> own OpenCode permissions applied, because OpenCode adds your global rules
> after a plugin agent's rules and the last match wins. That's how `edit`
> was allowed. This is also the cause of the first-minute
> `Host did not dispatch the hidden child context hook` refusal reported in
> #602.
>
> The fix, now in review, has several layers, and each one would have
> stopped this on its own:
> - the dreamer only reacts to conversations in its own directory;
> - a background session that lands in another directory is removed before
>   anything is sent to it;
> - Magic Context refuses any background-agent turn it didn't start, before
>   the model is called (`hidden_prompt_unrecognized`);
> - each background session carries its own read-only rules, which OpenCode
>   checks after yours;
> - any tool call outside a background agent's read-only list is refused,
>   whatever your permissions say.
>
> `dreamer.disable` will also take effect without a restart.
>
> Until the release, either of these keeps you safe:
> - set `"dreamer": { "disable": true }` in `magic-context.jsonc` and
>   restart OpenCode (on 0.46.0 the setting is only read at startup);
> - or change your global OpenCode `edit`, `write` and `shell` permissions
>   from `allow` to `ask`.
>
> OpenCode 1 and Pi aren't affected: there, Magic Context's background
> agents keep their read-only tool lists no matter what your permissions
> allow. We'll post here when the fix ships. Please check the Terraform
> files the run touched, if you haven't already.
