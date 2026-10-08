// Codex logs: <home>/sessions/YYYY/MM/DD/rollout-*.jsonl
//
// `event_msg` / `token_count` events carry `info.total_token_usage`, a cumulative counter
// maintained by Codex. Codex re-emits the same totals (e.g. on rate-limit updates), so we
// price only the delta between successive totals and ignore unchanged repeats.
// Codex `input_tokens` INCLUDES cached (and cache-write) input; we subtract them.

import { basename } from 'node:path';
import { cost } from './pricing.ts';
import { type Clock, type Session, type Usage, zeroUsage, recordReq } from './session.ts';

export interface CodexState { prev: Usage; unpricedCount: number; lastEnd: number; responses: Set<string> }
export const newCodexState = (): CodexState => ({ prev: zeroUsage(), unpricedCount: 0, lastEnd: 0, responses: new Set() });

function toUsage(t: any): Usage {
  const cached = t.cached_input_tokens ?? 0;
  const write = t.cache_write_input_tokens ?? 0;
  return {
    input: Math.max(0, (t.input_tokens ?? 0) - cached - write),
    cacheRead: cached,
    cacheWrite5m: write,
    cacheWrite1h: 0,
    output: t.output_tokens ?? 0,
    reasoning: t.reasoning_output_tokens ?? 0,
  };
}

// Lines that carry a request's input: the response that follows starts here.
const INPUT_ITEMS = new Set(['function_call_output', 'custom_tool_call_output', 'local_shell_call_output']);

export function codexLine(s: Session, st: CodexState, d: any, clock: Clock = { lastInput: 0 }): void {
  const p = d.payload;
  if (!p) return;
  const ts = Date.parse(d.timestamp) || 0;
  if (d.type === 'response_item' && (INPUT_ITEMS.has(p.type) || (p.type === 'message' && p.role === 'user'))) {
    if (ts) clock.lastInput = ts;
    return;
  }
  if (d.type === 'session_meta') {
    if (p.cwd) s.project = basename(p.cwd);
    if (p.creator_account_id) s.account = p.creator_account_id;
    return;
  }
  // Written the moment a response completes, with that response's own usage. (token_count
  // can lag behind it by the whole tool run, so it is only used for totals, not timing.)
  if (d.type === 'token_usage_record') {
    const id = p.response_id;
    if (!id || st.responses.has(id) || !ts) return;
    st.responses.add(id);
    // Price each response on its own, so the long-prompt tier applies per request.
    const c = cost(s.model, toUsage(p.usage ?? {}));
    if (c === null) st.unpricedCount++; else s.cost += c;
    s.unpriced = st.unpricedCount > 0;
    const start = Math.max(clock.lastInput, st.lastEnd);
    if (start) recordReq(s, { start, end: ts, out: p.usage?.output_tokens ?? 0 });
    st.lastEnd = ts;
    return;
  }
  if (d.type === 'turn_context') {
    if (p.model) s.model = p.model;
    return;
  }
  if (d.type !== 'event_msg' || p.type !== 'token_count' || !p.info?.total_token_usage) return;

  const total = toUsage(p.info.total_token_usage);
  const delta = zeroUsage();
  let changed = false;
  for (const k of Object.keys(total) as (keyof Usage)[]) {
    delta[k] = total[k] - st.prev[k];
    if (delta[k] !== 0) changed = true;
  }
  if (p.info.model_context_window) s.ctxWindow = p.info.model_context_window;
  if (!changed) return; // repeated update
  // Counter went backwards (should not happen): resync without pricing negative usage.
  const backwards = Object.values(delta).some((v) => v < 0);

  // Older Codex logs have no token_usage_record: fall back to pricing the change in totals.
  if (!backwards && !st.responses.size) {
    const c = cost(s.model, delta);
    if (c === null) st.unpricedCount++; else s.cost += c;
    s.unpriced = st.unpricedCount > 0;
  }
  st.prev = total;
  s.usage = { ...total };

  const last = p.info.last_token_usage;
  if (last) s.ctxTokens = (last.input_tokens ?? 0) + (last.output_tokens ?? 0);
  if (ts) s.lastEvent = Math.max(s.lastEvent, ts);
}
