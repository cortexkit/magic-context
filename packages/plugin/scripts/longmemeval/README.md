# LongMemEval benchmark runner

This runner executes LongMemEval against a live OpenCode instance with the magic-context plugin enabled.

It uses the real OpenCode HTTP API via `@opencode-ai/sdk`, creates real sessions, replays dataset user turns, asks the benchmark question in a new session, and judges the answer with the official LongMemEval prompt logic.

## What it benchmarks

- One OpenCode session per haystack conversation session
- All sessions share the same project/directory so magic-context shares project identity and memory state
- Final benchmark question is asked in a new session to test cross-session memory retrieval
- No dataset assistant responses are injected
- All user messages go through the real OpenCode API

## Files

- `runner.ts` — end-to-end orchestration, replay, resume, logging, summary
- `judge.ts` — official LongMemEval judge prompt templates and GPT-4o evaluation
- `types.ts` — dataset, state, and result types
- `config.ts` — CLI parsing and runtime configuration

## Prerequisites

1. OpenCode running locally with magic-context enabled
2. Dataset JSON downloaded locally
3. Judge API key available in `OPENAI_API_KEY` by default

Default OpenCode URL: `http://127.0.0.1:21354`

## Run

From `packages/plugin/`:

```bash
# Full run
bun run scripts/longmemeval/runner.ts --dataset ./longmemeval_s_cleaned.json

# Subset by index
bun run scripts/longmemeval/runner.ts --dataset ./longmemeval_s_cleaned.json --start 0 --end 10

# Specific categories
bun run scripts/longmemeval/runner.ts --dataset ./longmemeval_s_cleaned.json --types temporal-reasoning,knowledge-update

# Resume
bun run scripts/longmemeval/runner.ts --dataset ./longmemeval_s_cleaned.json --resume

# Fast mode
bun run scripts/longmemeval/runner.ts --dataset ./longmemeval_s_cleaned.json --fast
```

## Important flags

```bash
--parallel <n>                # questions in parallel, default 1
--cleanup                     # delete OpenCode sessions after judging
--output-dir <path>           # override run artifact directory
--opencode-url <url>          # override OpenCode base URL
--turn-delay-ms <ms>          # delay between replayed user turns
--session-delay-ms <ms>       # delay between haystack sessions
--final-delay-ms <ms>         # delay before asking final question
--question-ids <a,b>          # explicit question id filter
--max-attempts <n>            # retry attempts for request failures
--retry-base-delay-ms <ms>    # base exponential backoff delay
```

## Resumability

The runner is crash-safe at per-question execution granularity and persists state after each meaningful step.

Saved state includes:

- created OpenCode session IDs
- current haystack session index
- current turn index within the active haystack session
- whether per-session banner/date marker was sent
- whether the final question session exists
- whether the final question banner was sent
- whether the final question was asked
- captured hypothesis text
- accumulated OpenCode token usage and costs
- accumulated judge token usage and costs
- last error snapshot

Artifacts written under the run output directory:

- `runner-state.json` — resumable in-progress state
- `results.jsonl` — append-only completed results
- `summary.json` — latest aggregated summary
- `runner.log` — timestamped runner log

On `--resume`, the runner validates that the saved selection matches the current dataset/filter selection.

## Question prompt

The final benchmark question is wrapped as:

```text
Based on our previous conversations, please answer this question. Do not search files or use tools — answer purely from what you remember about our past interactions.

Question: {question}
```

The final question also sends a system instruction reinforcing that it must answer from conversational memory only.

## Judge behavior

`judge.ts` implements the official LongMemEval category-specific prompts for:

- `single-session-user`
- `single-session-assistant`
- `single-session-preference`
- `multi-session`
- `temporal-reasoning`
- `knowledge-update`
- `_abs` abstention questions

Scoring follows the official evaluator behavior: the label is `true` if the judge response contains `yes` case-insensitively.

## Cost tracking

The runner records:

- actual OpenCode cost reported by assistant messages
- estimated OpenCode cost from optional CLI pricing inputs
- estimated judge cost from configured judge pricing

If OpenCode pricing flags are omitted, OpenCode estimated cost defaults to zero while actual OpenCode cost still uses the API-reported value.

## Notes

- This runner is designed to build the benchmark harness; it does not modify plugin runtime code.
- It does not inject dataset assistant messages.
- It does not bypass the OpenCode API.
