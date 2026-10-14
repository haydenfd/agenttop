import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeLine, newClaudeState } from '../src/claude.ts';
import { codexLine, newCodexState } from '../src/codex.ts';
import { parseConfig } from '../src/config.ts';
import { cost } from '../src/pricing.ts';
import { newSession, tps, tpsStats } from '../src/session.ts';
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

test('codex: request ends use token_usage_record; missing first-token timing gives no TPS', () => {
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
  assert.deepEqual(s.reqs.map((r) => r.end - r.start), [4000, 6000]);
  assert.equal(tps(s), null);
  assert.equal(tps(newSession('x', 'x', 'codex')), null);
});

test('codex generation TPS: first-token timing applies only to the first response of each turn', () => {
  const s = newSession('c', 'codex', 'codex'), st = newCodexState(), clock = { lastInput: 0 };
  const line = (sec: number, type: string, payload: object) =>
    codexLine(s, st, { timestamp: new Date(Date.UTC(2026, 9, 14) + sec * 1000).toISOString(), type, payload }, clock);
  line(0, 'event_msg', { type: 'task_started', turn_id: 'one' });
  line(0, 'response_item', { type: 'message', role: 'user' });
  line(4, 'token_usage_record', { turn_id: 'one', response_id: 'r1', usage: { output_tokens: 100 } });
  line(4, 'token_usage_record', { turn_id: 'one', response_id: 'r1', usage: { output_tokens: 100 } });
  line(64, 'response_item', { type: 'custom_tool_call_output' });
  line(68, 'token_usage_record', { turn_id: 'one', response_id: 'r2', usage: { output_tokens: 200 } });
  line(68, 'event_msg', { type: 'task_complete', turn_id: 'one', time_to_first_token_ms: 2000 });
  assert.deepEqual(tpsStats(s), { rate: 50, requests: 1 });
  assert.equal(s.reqs[1].generationStart, undefined);
  // An agent message starts a new turn after ten minutes idle, without a user prompt.
  line(668, 'event_msg', { type: 'task_started', turn_id: 'two' });
  line(668, 'response_item', { type: 'agent_message' });
  line(674, 'token_usage_record', { turn_id: 'two', response_id: 'r3', usage: { output_tokens: 300 } });
  line(674, 'event_msg', { type: 'task_complete', turn_id: 'two', time_to_first_token_ms: 2000 });
  line(674, 'event_msg', { type: 'task_complete', turn_id: 'two', time_to_first_token_ms: 5000 });
  assert.equal(s.reqs[2].end - s.reqs[2].start, 6000);
  assert.deepEqual(tpsStats(s), { rate: 400 / 6, requests: 2 });
  assert.equal(st.turns.size, 0);
});

test('codex generation TPS: invalid or missing timing is never replaced with an estimate', () => {
  for (const wait of [undefined, null, -1, '2000', NaN, Infinity, 4000, 5000]) {
    const s = newSession('c', 'codex', 'codex'), st = newCodexState();
    const start = Date.UTC(2026, 9, 14);
    const line = (ms: number, type: string, payload: object) =>
      codexLine(s, st, { timestamp: new Date(start + ms).toISOString(), type, payload });
    line(0, 'event_msg', { type: 'task_started', turn_id: 'one' });
    line(4000, 'token_usage_record', { turn_id: 'one', response_id: 'r1', usage: { output_tokens: 100 } });
    line(4000, 'event_msg', { type: 'task_complete', turn_id: 'one', time_to_first_token_ms: wait });
    assert.deepEqual(tpsStats(s), { rate: null, requests: 0 });
  }
  const s = newSession('c', 'codex', 'codex');
  s.reqs.push({ start: 0, generationStart: 2000, end: 2200, out: 10 });
  assert.deepEqual(tpsStats(s), { rate: null, requests: 1 }); // not enough timed data yet
});

test('watcher: Codex generation timing arrives at turn completion and survives duplicate events', () => {
  const home = mkdtempSync(join(tmpdir(), 'agenttop-tps-'));
  const dir = join(home, 'sessions');
  mkdirSync(dir);
  const path = join(dir, 'rollout-2026-10-14T00-00-00-sess.jsonl');
  const line = (sec: number, type: string, payload: object) =>
    JSON.stringify({ timestamp: new Date(Date.UTC(2026, 9, 14) + sec * 1000).toISOString(), type, payload }) + '\n';
  writeFileSync(path, line(0, 'event_msg', { type: 'task_started', turn_id: 'one' })
    + line(4, 'token_usage_record', { turn_id: 'one', response_id: 'r1', usage: { output_tokens: 100 } }));
  const watcher = new SourceWatcher({ name: 'codex', provider: 'codex', home }, 1);
  watcher.scan(); watcher.poll();
  const s = watcher.list()[0];
  assert.equal(tps(s), null);
  const done = line(4, 'event_msg', { type: 'task_complete', turn_id: 'one', time_to_first_token_ms: 2000 });
  appendFileSync(path, done + done);
  watcher.poll();
  assert.deepEqual(tpsStats(s), { rate: 50, requests: 1 });
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
  const meta = (acct: string) => JSON.stringify({ type: 'session_meta', payload: { cwd: '/p', creator_account_id: acct } }) + '\n'
    + JSON.stringify(tc('2026-10-08T00:00:00Z', { input_tokens: 10, output_tokens: 1 })) + '\n';
  writeFileSync(join(day, 'rollout-2026-10-07T00-00-00-aaa.jsonl'), meta('acct-A'));
  writeFileSync(join(day, 'rollout-2026-10-07T00-00-00-bbb.jsonl'), meta('acct-B'));
  const w = new SourceWatcher({ name: 'codex', provider: 'codex', home }, 1);
  w.scan(); w.poll();
  assert.deepEqual(w.list().map((s) => s.id), ['aaa']);
});

test('watcher: hides Codex internal reviewers and sessions without model usage', () => {
  const home = mkdtempSync(join(tmpdir(), 'agenttop-codex-'));
  const day = join(home, 'sessions');
  mkdirSync(day);
  const usage = JSON.stringify(tc('2026-10-08T00:00:00Z', { input_tokens: 10, output_tokens: 1 })) + '\n';
  for (const kind of ['guardian', 'codex-guardian', 'auto_review', 'auto-review', 'codex-auto-review', 'worker', 'empty']) {
    writeFileSync(join(day, `${kind}.jsonl`), JSON.stringify({ type: 'session_meta', payload: {
      source: { subagent: { other: kind } },
    } }) + '\n' + (kind === 'empty' ? '' : usage));
  }
  const w = new SourceWatcher({ name: 'codex', provider: 'codex', home }, 1);
  w.scan(); w.poll();
  assert.deepEqual(w.list().map((s) => s.id), ['worker']);

  // A normal session becomes visible as soon as a response's usage is recorded,
  // even when the cumulative token_count has not arrived yet.
  appendFileSync(join(day, 'empty.jsonl'), JSON.stringify({ type: 'token_usage_record',
    timestamp: '2026-10-08T00:00:01Z', payload: { response_id: 'r1', usage: { output_tokens: 5 } },
  }) + '\n');
  w.poll();
  assert.deepEqual(w.list().map((s) => s.id).sort(), ['empty', 'worker']);
});

test('claude: user-set title beats auto title', () => {
  const s = newSession('a', 'claude', 'claude');
  const st = newClaudeState();
  claudeLine(s, st, { type: 'custom-title', customTitle: 'my-name' });
  claudeLine(s, st, { type: 'ai-title', aiTitle: 'Auto name' });
  claudeLine(s, st, claudeMsg('m1', '2026-10-08T00:00:00Z', u2));
  assert.equal(s.title, 'my-name');
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

test('tool errors: claude results attributed to their tool, codex failed items counted', () => {
  const s = newSession('c', 'claude', 'claude');
  const st = newClaudeState();
  const use = (id: string, name: string, input: object) =>
    ({ ...claudeMsg('m-' + id, '2026-10-08T00:00:00Z', u2), message: { id: 'm-' + id, model: 'claude-opus-5-5', usage: u2, content: [{ type: 'tool_use', id, name, input }] } });
  const result = (id: string, content: any) =>
    ({ type: 'user', timestamp: '2026-10-08T00:00:01Z', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content }] } });
  claudeLine(s, st, use('t1', 'Bash', { command: 'cd /repo && FOO=1 gh pr list' }));
  claudeLine(s, st, use('t1', 'Bash', { command: 'cd /repo && FOO=1 gh pr list' })); // streamed duplicate
  claudeLine(s, st, use('t2', 'Read', { file_path: '/nope' }));
  claudeLine(s, st, use('t3', 'Edit', {}));
  claudeLine(s, st, result('t1', 'Exit code 1\nGraphQL: deprecated'));
  claudeLine(s, st, result('t2', '<tool_use_error>File does not exist. Note: cwd is /repo</tool_use_error>'));
  claudeLine(s, st, result('t3', [{ type: 'text', text: "The user doesn't want to proceed with this tool use." }]));
  assert.equal(s.toolCalls, 3);
  assert.deepEqual(s.toolErrors, { 'Bash(gh): exit 1': 1, 'Read: File does not exist': 1, 'Edit: rejected by user': 1 });

  const x = newSession('x', 'codex', 'codex');
  const xs = newCodexState();
  const item = (item: object) => ({ type: 'event_msg', payload: { type: 'item_completed', item } });
  codexLine(x, xs, item({ type: 'CommandExecution', command: ['/bin/zsh', '-lc', 'cat missing.ts'], status: 'failed', exit_code: 1 }));
  codexLine(x, xs, item({ type: 'CommandExecution', command: ['/bin/zsh', '-lc', 'ls'], status: 'completed', exit_code: 0 }));
  codexLine(x, xs, item({ type: 'McpToolCall', server: 'gh', tool: 'search', status: 'failed' }));
  codexLine(x, xs, item({ type: 'Reasoning' }));
  assert.equal(x.toolCalls, 3);
  assert.deepEqual(x.toolErrors, { 'shell(cat): exit 1': 1, 'gh.search: failed': 1 });
});

test('pricing: fast mode is 2x on Opus 5.5, N/A where the fast rate is unknown', () => {
  const u = { input: 1e6, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0, reasoning: 0 };
  assert.equal(cost('claude-opus-5-5', u, true), 8);
  assert.equal(cost('claude-opus-4-8', u, true), null);
});
