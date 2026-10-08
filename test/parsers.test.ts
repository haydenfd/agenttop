import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeLine, newClaudeState } from '../src/claude.ts';
import { codexLine, newCodexState } from '../src/codex.ts';
import { parseConfig } from '../src/config.ts';
import { cost } from '../src/pricing.ts';
import { newSession, tps } from '../src/session.ts';
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
});

test('pricing: missing model is null, never 0', () => {
  assert.equal(cost(null, { input: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 1, reasoning: 0 }), null);
  assert.equal(cost('claude-haiku-4-5-20251001', { input: 1e6, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0, reasoning: 0 }), 1);
});

test('claude TPS: timed from tool result / prompt to the last streamed line, tool time excluded', () => {
  const s = newSession('a', 'claude', 'claude');
  const st = newClaudeState();
  const clock = { lastInput: 0 };
  const user = (ts: string) => ({ type: 'user', timestamp: ts });
  claudeLine(s, st, user('2026-10-08T00:00:00Z'), false, clock);
  claudeLine(s, st, claudeMsg('m1', '2026-10-08T00:00:02Z', { output_tokens: 100 }), false, clock);
  claudeLine(s, st, claudeMsg('m1', '2026-10-08T00:00:04Z', { output_tokens: 100 }), false, clock); // same msg, later block
  // 60s of tool execution happens here; it belongs to no request
  claudeLine(s, st, user('2026-10-08T00:01:04Z'), false, clock);
  claudeLine(s, st, claudeMsg('m2', '2026-10-08T00:01:10Z', { output_tokens: 200 }), false, clock);
  assert.equal(s.reqs.length, 2);
  assert.equal(tps(s), 300 / 10); // (100 + 200) tokens / (4s + 6s)
});

test('codex TPS: timed from input to token_usage_record, not the lagging token_count', () => {
  const s = newSession('c', 'codex', 'codex');
  const st = newCodexState();
  const clock = { lastInput: 0 };
  const item = (ts: string, type: string) => ({ timestamp: ts, type: 'response_item', payload: { type, role: 'user' } });
  const rec = (ts: string, id: string, out: number) =>
    ({ timestamp: ts, type: 'token_usage_record', payload: { response_id: id, usage: { output_tokens: out } } });
  codexLine(s, st, item('2026-10-08T00:00:00Z', 'message'), clock);
  codexLine(s, st, rec('2026-10-08T00:00:04Z', 'r1', 100), clock);
  codexLine(s, st, rec('2026-10-08T00:00:04Z', 'r1', 100), clock); // duplicate record
  // tool runs 60s; token_count for r1 is only written after it finishes
  codexLine(s, st, item('2026-10-08T00:01:04Z', 'custom_tool_call_output'), clock);
  codexLine(s, st, tc('2026-10-08T00:01:04Z', { input_tokens: 10, output_tokens: 100 }), clock);
  codexLine(s, st, rec('2026-10-08T00:01:10Z', 'r2', 200), clock);
  assert.equal(s.reqs.length, 2);
  assert.equal(tps(s), 300 / 10); // (100 + 200) / (4s + 6s)
  assert.equal(tps(newSession('x', 'x', 'codex')), null);
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

test('claude: branch from gitBranch, user-set title beats auto title', () => {
  const s = newSession('a', 'claude', 'claude');
  const st = newClaudeState();
  claudeLine(s, st, { type: 'custom-title', customTitle: 'my-name' });
  claudeLine(s, st, { type: 'ai-title', aiTitle: 'Auto name' });
  claudeLine(s, st, { ...claudeMsg('m1', '2026-10-08T00:00:00Z', u2), gitBranch: 'feature-x' });
  assert.equal(s.title, 'my-name');
  assert.equal(s.branch, 'feature-x');
});

test('codex cost: priced per response record, long-prompt tier per request, totals still from token_count', () => {
  const s = newSession('c', 'codex', 'codex');
  const st = newCodexState();
  codexLine(s, st, { type: 'turn_context', payload: { model: 'gpt-6.1-sol' } });
  const rec = (id: string, usage: object) =>
    ({ timestamp: '2026-10-08T00:00:01Z', type: 'token_usage_record', payload: { response_id: id, usage } });
  // small request: 1000 input of which 800 cached, 100 output
  codexLine(s, st, rec('r1', { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 100 }));
  codexLine(s, st, rec('r1', { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 100 })); // duplicate
  const small = (200 * 2 + 800 * 0.1 + 100 * 10) / 1e6;
  assert.ok(Math.abs(s.cost - small) < 1e-12);
  // 300K-token prompt crosses 272K: 2x input/cache, 1.5x output
  codexLine(s, st, rec('r2', { input_tokens: 300_000, cached_input_tokens: 290_000, output_tokens: 1000 }));
  const big = (2 * (10_000 * 2 + 290_000 * 0.1) + 1.5 * 1000 * 10) / 1e6;
  assert.ok(Math.abs(s.cost - small - big) < 1e-12);
  // token_count totals don't add cost again when records exist
  codexLine(s, st, tc('2026-10-08T00:00:02Z', { input_tokens: 301_000, cached_input_tokens: 290_800, output_tokens: 1100 }));
  assert.ok(Math.abs(s.cost - small - big) < 1e-12);
  assert.equal(s.usage.output, 1100);
  assert.equal(s.unpriced, false);
});
