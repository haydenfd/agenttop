# agenttop

Read-only terminal UI showing token usage, context, throughput and API-equivalent cost for
Codex and Claude Code sessions across multiple accounts. No dependencies; needs Node ≥ 23.6
(runs the TypeScript directly).

```sh
npm link        # once: puts `agenttop` on your PATH
agenttop
```

Keys: `↑↓`/`jk` move · `PgUp`/`PgDn` · `g`/`G` top/bottom · `Enter` details · `q`/`Esc`/`Ctrl+C` exit.

## Config

`~/.config/agenttop/config.toml` (if missing, defaults to `~/.codex` and `~/.claude`):

```toml
days = 1   # load sessions whose log changed in the last N days

[[sources]]
name = "codex"
provider = "codex"
home = "~/.codex"

[[sources]]
name = "codex-burner"
provider = "codex"
home = "~/.codex-burner"

[[sources]]
name = "claude"
provider = "claude"
home = "~/.claude"
```

Prices: Claude models and `gpt-6.1-sol` are built in ($2 in / $0.10 cached / $10 out per 1M, and 2× input / 1.5× output for requests with prompts over 272K tokens; that tier is from third-party guides). Add or override any model in
`~/.config/agenttop/pricing.json` (USD per 1M tokens; `context` optional):

```json
{ "gpt-6.1-sol": { "input": 1.25, "output": 10, "cacheRead": 0.125, "context": 475000 } }
```

(Example numbers only. Use your provider's published prices.) Models without a price show `N/A`, never `$0`.

## Columns

| Column | Meaning |
|---|---|
| ● | blue = Codex, orange = Claude |
| SESSION | the name you gave the session, else the auto-generated title (Claude `customTitle`/`aiTitle`, Codex `thread_name` from `session_index.jsonl`) |
| BRANCH | git branch the session is on |
| TOKENS | input + cache read + cache write + output, deduplicated |
| CTX | tokens in context at the latest request ÷ model context window |
| TPS | output tokens ÷ seconds in flight, summed over every API request in the session. A request runs from when its input (your prompt or a tool result) was logged to when its response finished logging, so tool execution and idle time are excluded. It still includes prompt processing and time to first token, so it reads a bit below pure decode speed. `--` when there is not enough data |
| COST | API-equivalent USD; `N/A` if any request's model has no price |


## How the numbers are counted

**Claude Code**: `<home>/projects/<project>/<session>.jsonl`, plus subagent logs in
`<session>/subagents/*.jsonl`, which are added to the parent session.
- Every assistant line has per-request `message.usage`. Streaming writes the same message
  once per content block with the same usage, so requests are keyed by `message.id` and
  later copies **replace** earlier ones instead of adding.
- Cost = input × in + output × out + cache read × read + 5-min cache write × 1.25 in +
  1-hour cache write × 2 in. Output includes thinking tokens.
- Context = input + cache read + cache write of the latest main-thread request.
- `<synthetic>` placeholder messages are ignored.

**Codex**: `<home>/sessions/YYYY/MM/DD/rollout-*.jsonl`
- Request timing uses `token_usage_record`, written the moment each response completes (deduplicated by `response_id`). `token_count` can lag by a whole tool run, so it is not used for timing.
- Cost is computed per response from `token_usage_record`, so the long-prompt tier applies to each request. These records add up exactly to Codex's own `token_count` totals.
- `token_count` events carry `total_token_usage`, a running total kept by Codex. The latest
  total is the session total. Repeated events with the same total are ignored, and each
  increase is priced with the model active at that point (`turn_context.model`).
- Codex's `input_tokens` already includes cached input, so cached tokens are subtracted
  before pricing to avoid charging them twice.
- Context = latest `last_token_usage` input + output ÷ `model_context_window`.
- If two Codex homes share one `sessions` directory (e.g. a symlink), sessions are assigned
  by matching the log's `creator_account_id` to `tokens.account_id` in that home's
  `auth.json`. That is the only field read from `auth.json`.

**Files**: polled every second; only bytes appended since the last read are parsed, and an
unfinished last line is held until it is complete. New session files are found every 5 s.
Nothing is ever written to agent directories.

## Tests

```sh
npm test
```
