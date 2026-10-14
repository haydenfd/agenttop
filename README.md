# agenttop

See your Codex and Claude Code sessions in the terminal.

Shows token usage, context size, tokens per second, tool errors, and estimated
API cost. Supports multiple accounts. No dependencies. Requires Node.js 23.6 or newer.

## Run

```sh
git clone https://github.com/haydenfd/agenttop.git
cd agenttop
npm start
```

To run it from any directory:

```sh
npm link
agenttop
```

## Keys

- `Tab`, `←` / `→`, or `1`–`9`: switch accounts.
- `↑` / `↓` or `j` / `k`: select a session.
- `PgUp` / `PgDn` or `g` / `G`: move through the list.
- `Enter`: show session details.
- `q`, `Esc`, or `Ctrl+C`: quit.

## Config

By default, agenttop reads `~/.codex` and `~/.claude`.

To change accounts, create `~/.config/agenttop/config.toml`:

```toml
days = 1 # load sessions with log files changed in the last day

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

## Columns

| Column | Meaning |
|---|---|
| ACCOUNT / SESSION / PROJECT / MODEL | Which account, session, project, and model you're viewing |
| TOKENS / IN / OUT | Total, uncached input, and output tokens; output includes reasoning |
| CACHE / CTX | Share of input served from cache, and share of context space used |
| TPS | Tokens per second; see below |
| ERR / COST / LAST | Failed tool calls, estimated API cost, and time since the log changed |

### Tokens per second

**Codex:** output tokens divided by generation time, from the first model token
to the end of that response. This excludes the initial wait and includes reasoning.
Fast mode uses the same calculation, so its measured speed appears directly.

Codex reports first-token timing only for the first response in each turn, when
the turn finishes. Other responses do not count toward TPS. Session details show
how many requests were measured. Missing or insufficient timing shows `--`.

**Claude Code:** output tokens divided by time from a prompt or tool result to
the last response block. This includes the initial wait and prompt processing,
so it is a different measure from Codex generation TPS.

Both rates use total tokens divided by total measured seconds across the session.

### Cost estimates

Costs use built-in model prices. Unknown prices show `N/A`. These are API cost
estimates, not your subscription bill. Calls missing from session logs are not counted.

To add or change prices, create `~/.config/agenttop/pricing.json`. Rates are USD
per million tokens. Example values only; use your provider's published prices:

```json
{ "my-model": { "input": 1, "output": 5, "cacheRead": 0.1, "context": 200000 } }
```

## Local files

agenttop reads local session logs. It does not send data anywhere or write to
agent directories. Repeated usage records are counted once. Claude subagent
usage is added to the parent session. Internal Codex reviewers are hidden.

If Codex accounts share a log directory, agenttop reads only `tokens.account_id`
from each account's `auth.json` to match sessions to accounts.

## Tests

```sh
npm test
```

## License

[MIT](LICENSE).
