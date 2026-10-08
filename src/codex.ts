// Codex logs: <home>/sessions/YYYY/MM/DD/rollout-*.jsonl
//
// `event_msg` / `token_count` events carry `info.total_token_usage`, a cumulative counter
// maintained by Codex. Codex re-emits the same totals (e.g. on rate-limit updates), so we
// price only the delta between successive totals and ignore unchanged repeats.
// Codex `input_tokens` INCLUDES cached (and cache-write) input; we subtract them.

import { basename } from 'node:path';
import { cost } from './pricing.ts';
import { type Session, type Usage, zeroUsage, recordSample } from './session.ts';

export interface CodexState { prev: Usage; unpricedCount: number }
export const newCodexState = (): CodexState => ({ prev: zeroUsage(), unpricedCount: 0 });

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

export function codexLine(s: Session, st: CodexState, d: any): void {
  const p = d.payload;
  if (!p) return;
  if (d.type === 'session_meta') {
    if (p.cwd) s.project = basename(p.cwd);
    if (p.creator_account_id) s.account = p.creator_account_id;
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

  if (!backwards) {
    const c = cost(s.model, delta);
    if (c === null) st.unpricedCount++; else s.cost += c;
    s.unpriced = st.unpricedCount > 0;
  }
  st.prev = total;
  s.usage = { ...total };

  const last = p.info.last_token_usage;
  if (last) s.ctxTokens = (last.input_tokens ?? 0) + (last.output_tokens ?? 0);
  const ts = Date.parse(d.timestamp) || 0;
  if (ts) {
    s.lastEvent = Math.max(s.lastEvent, ts);
    recordSample(s, ts);
  }
}
