import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeLine, newClaudeState } from '../src/claude.ts';
import { codexLine, newCodexState } from '../src/codex.ts';
import { parseConfig } from '../src/config.ts';
import { cost } from '../src/pricing.ts';
import { effectiveTps, newSession } from '../src/session.ts';
import { SourceWatcher } from '../src/watcher.ts';

const claudeMsg = (id: string, ts: string, usage: object, extra: object = {}) => ({
  type: 'assistant', timestamp: ts, cwd: '/x/myproj',
  message: { id, model: 'claude-opus-5-5', usage }, ...extra,
});

const u1 = {
  input_tokens: 2, cache_read_input_tokens: 26464, cache_creation_input_tokens: 9029, output_tokens: 220,
  output_tokens_details: { thinking_tokens: 41 },
  cache_creation: { ephemeral_1h_input_tokens: 9029, ephemeral_5m_input_tokens: 0 },
};
const u2 = { input_tokens: 4, cache_read_input_tokens: 35493, cache_creation_input_tokens: 309, output_tokens: 56 };

test('claude: streaming duplicates of one message are counted once', () => {
  const s = newSession('a', 'claude', 'claude');
  const st = newClaudeState();
  claudeLine(s, st, claudeMsg('m1', '2026-10-08T00:09:01.568Z', u1));
  claudeLine(s, st, claudeMsg('m1', '2026-10-08T00:09:02.820Z', u1)); // duplicate
  claudeLine(s, st, claudeMsg('m2', '2026-10-08T00:09:12.597Z', u2));
  assert.deepEqual(s.usage, {
    input: 6, cacheRead: 26464 + 35493, cacheWrite5m: 309, cacheWrite1h: 9029, output: 276, reasoning: 41,
  });
  assert.equal(s.project, 'myproj');
  // context = latest request's prompt side, not the cumulative total
  assert.equal(s.ctxTokens, 4 + 35493 + 309);
  assert.equal(s.ctxWindow, 1_000_000);
  // $4 in, $20 out, $0.20 cache read, 1h write = 2x input, 5m write = 1.25x input
  const want = (6 * 4 + 276 * 20 + 61957 * 0.2 + 9029 * 8 + 309 * 5) / 1e6;
  assert.ok(Math.abs(s.cost - want) < 1e-12, `${s.cost} vs ${want}`);
  assert.equal(s.unpriced, false);
});

test('claude: unknown model gives N/A cost, synthetic messages ignored, sidechain skips context', () => {
  const s = newSession('a', 'claude', 'claude');
  const st = newClaudeState();
  claudeLine(s, st, { type: 'assistant', timestamp: 't', message: { id: 'x', model: '<synthetic>', usage: u2 } });
  assert.equal(s.usage.output, 0);
  claudeLine(s, st, claudeMsg('m1', '2026-10-08T00:00:00Z', u2));
  claudeLine(s, st, claudeMsg('m2', '2026-10-08T00:00:01Z', u1, { isSidechain: true }));
  assert.equal(s.ctxTokens, 4 + 35493 + 309);
  claudeLine(s, st, { ...claudeMsg('m3', '2026-10-08T00:00:02Z', u2), message: { id: 'm3', model: 'mystery-1', usage: u2 } });
  assert.equal(s.unpriced, true);
});

const tc = (ts: string, total: object, last: object = total) => ({
  timestamp: ts, type: 'event_msg',
  payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last, model_context_window: 475000 } },
});

test('codex: cumulative totals, repeats ignored, cached subtracted from input', () => {
  const s = newSession('c', 'codex', 'codex');
  const st = newCodexState();
  codexLine(s, st, { type: 'session_meta', payload: { cwd: '/a/algovox-mono' } });
  codexLine(s, st, { type: 'turn_context', payload: { model: 'gpt-test' } });
  const t1 = { input_tokens: 28586, cached_input_tokens: 12160, output_tokens: 191, reasoning_output_tokens: 0 };
  const t2 = { input_tokens: 60172, cached_input_tokens: 40576, output_tokens: 276, reasoning_output_tokens: 10 };
  codexLine(s, st, tc('2026-10-08T00:29:06Z', t1));
  codexLine(s, st, tc('2026-10-08T00:29:07Z', t1)); // repeat
  codexLine(s, st, tc('2026-10-08T00:29:09Z', t2, { input_tokens: 31586, output_tokens: 85 }));
  assert.equal(s.project, 'algovox-mono');
  assert.deepEqual(s.usage, { input: 60172 - 40576, cacheRead: 40576, cacheWrite5m: 0, cacheWrite1h: 0, output: 276, reasoning: 10 });
  assert.equal(s.ctxTokens, 31586 + 85);
  assert.equal(s.ctxWindow, 475000);
  assert.equal(s.unpriced, true); // gpt-test has no price
  assert.equal(s.samples.length, 2);
});

test('pricing: missing model is null, never 0', () => {
  assert.equal(cost(null, { input: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 1, reasoning: 0 }), null);
  assert.equal(cost('claude-haiku-4-5-20251001', { input: 1e6, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0, reasoning: 0 }), 1);
});

test('effective TPS uses last 60s of samples, N/A when too short', () => {
  const s = newSession('a', 'x', 'codex');
  assert.equal(effectiveTps(s), null);
  s.samples = [[0, 0], [100_000, 1000], [110_000, 1500], [130_000, 2500]];
  assert.equal(effectiveTps(s), (2500 - 1000) / 30); // window starts at the 100s sample
});

test('config: parses sources, expands ~, rejects bad provider', () => {
  const c = parseConfig(`# hi\ndays = 3\n[[sources]]\nname = "codex-burner" # alt\nprovider = "codex"\nhome = "~/.codex-burner"\n`);
  assert.equal(c.days, 3);
  assert.equal(c.sources[0].name, 'codex-burner');
  assert.ok(!c.sources[0].home.startsWith('~'));
  assert.throws(() => parseConfig(`[[sources]]\nname="x"\nprovider="gemini"\nhome="/"`));
});

test('watcher: discovers new sessions, tails appends, holds partial lines', () => {
  const home = mkdtempSync(join(tmpdir(), 'agenttop-'));
  const dir = join(home, 'projects', '-x-myproj');
  mkdirSync(join(dir, 'sess1', 'subagents'), { recursive: true });
  const main = join(dir, 'sess1.jsonl');
  writeFileSync(main, JSON.stringify(claudeMsg('m1', '2026-10-08T00:00:00Z', u2)) + '\n');
  const w = new SourceWatcher({ name: 'claude', provider: 'claude', home }, 1);
  w.scan(); w.poll();
  assert.equal(w.list().length, 1);
  assert.equal(w.list()[0].usage.output, 56);

  // half a line, then the rest
  const line = JSON.stringify(claudeMsg('m2', '2026-10-08T00:00:05Z', u2)) + '\n';
  appendFileSync(main, line.slice(0, 40));
  w.poll();
  assert.equal(w.list()[0].usage.output, 56);
  appendFileSync(main, line.slice(40));
  w.poll();
  assert.equal(w.list()[0].usage.output, 112);

  // subagent file folds into the parent; new session file appears without restart
  writeFileSync(join(dir, 'sess1', 'subagents', 'agent-1.jsonl'), JSON.stringify(claudeMsg('s1', '2026-10-08T00:00:06Z', u2)) + '\n');
  writeFileSync(join(dir, 'sess2.jsonl'), JSON.stringify(claudeMsg('m9', '2026-10-08T00:00:07Z', u2)) + '\n');
  w.scan(); w.poll();
  const byId = Object.fromEntries(w.list().map((s) => [s.id, s]));
  assert.equal(byId.sess1.usage.output, 168);
  assert.equal(byId.sess2.usage.output, 56);
});

test('watcher: codex homes sharing a sessions dir are split by account id', () => {
  const home = mkdtempSync(join(tmpdir(), 'agenttop-codex-'));
  const day = join(home, 'sessions', '2026', '10', '07');
  mkdirSync(day, { recursive: true });
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ tokens: { account_id: 'acct-A' } }));
  const meta = (acct: string) => JSON.stringify({ type: 'session_meta', payload: { cwd: '/p', creator_account_id: acct } }) + '\n';
  writeFileSync(join(day, 'rollout-2026-10-07T00-00-00-aaa.jsonl'), meta('acct-A'));
  writeFileSync(join(day, 'rollout-2026-10-07T00-00-00-bbb.jsonl'), meta('acct-B'));
  const w = new SourceWatcher({ name: 'codex', provider: 'codex', home }, 1);
  w.scan(); w.poll();
  assert.deepEqual(w.list().map((s) => s.id), ['aaa']);
});
