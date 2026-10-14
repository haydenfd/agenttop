// Codex logs: <home>/sessions/YYYY/MM/DD/rollout-*.jsonl
//
// `event_msg` / `token_count` events carry `info.total_token_usage`, a cumulative counter
// maintained by Codex. Codex re-emits the same totals (e.g. on rate-limit updates), so we
// price only the delta between successive totals and ignore unchanged repeats.
// Codex `input_tokens` INCLUDES cached (and cache-write) input; we subtract them.

import { basename } from 'node:path';
import { cost } from './pricing.ts';
import { type Clock, type Req, type Session, type Usage, zeroUsage, recordReq, recordToolError, shellLabel } from './session.ts';

export interface CodexState {
  prev: Usage; unpricedCount: number; lastEnd: number; responses: Set<string>; excluded: boolean;
  turns: Map<string, { start: number; firstReq: Req | null }>;
}
export const newCodexState = (): CodexState => ({ prev: zeroUsage(), unpricedCount: 0, lastEnd: 0, responses: new Set(), excluded: false, turns: new Map() });

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
  if (d.type === 'event_msg' && p.type === 'task_started') {
    if (p.turn_id && ts && !st.turns.has(p.turn_id)) st.turns.set(p.turn_id, { start: ts, firstReq: null });
    return;
  }
  if (d.type === 'event_msg' && p.type === 'task_complete') {
    const turn = st.turns.get(p.turn_id);
    const wait = p.time_to_first_token_ms;
    // Turn-level timing belongs only to its first response, never later tool continuations.
    if (turn?.firstReq && typeof wait === 'number' && Number.isFinite(wait) && wait >= 0) {
      const start = turn.start + wait;
      if (start >= turn.firstReq.start && start < turn.firstReq.end) turn.firstReq.generationStart = start;
    }
    st.turns.delete(p.turn_id);
    return;
  }
  if (d.type === 'response_item' && (INPUT_ITEMS.has(p.type) || (p.type === 'message' && p.role === 'user'))) {
    if (ts) clock.lastInput = ts;
    return;
  }
  if (d.type === 'session_meta') {
    st.excluded = /^(?:codex[-_])?(?:guardian|auto[-_]review)$/.test(p.source?.subagent?.other ?? '');
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
    const turn = st.turns.get(p.turn_id);
    const start = Math.max(clock.lastInput, st.lastEnd, turn?.start ?? 0);
    if (start) {
      const req = { start, end: ts, out: p.usage?.output_tokens ?? 0 };
      recordReq(s, req);
      if (turn && !turn.firstReq) turn.firstReq = req;
    }
    st.lastEnd = ts;
    return;
  }
  // Finished tool runs: shell commands, patches, MCP calls. Anything not `completed` failed.
  if (d.type === 'event_msg' && p.type === 'item_completed') {
    const it = p.item ?? {};
    const tool = it.type === 'CommandExecution' ? shellLabel('shell', [].concat(it.command ?? []).at(-1) ?? '')
      : it.type === 'FileChange' ? 'apply_patch'
      : it.type === 'McpToolCall' ? `${it.server}.${it.tool}` : null;
    if (!tool) return;
    s.toolCalls++;
    if (it.status && it.status !== 'completed') {
      recordToolError(s, tool, typeof it.exit_code === 'number' && it.exit_code >= 0 ? `exit ${it.exit_code}` : it.status);
    }
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
