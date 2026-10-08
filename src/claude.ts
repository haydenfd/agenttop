// Claude Code logs: <home>/projects/<slug>/<sessionId>.jsonl, plus subagent logs at
// <home>/projects/<slug>/<sessionId>/subagents/*.jsonl (folded into the parent session).
//
// Each assistant line carries per-request `message.usage`. Streaming writes the same
// message several times (one line per content block) with identical usage, so requests
// are keyed by message.id and the latest copy replaces the earlier one.

import { basename } from 'node:path';
import { cost, contextWindow } from './pricing.ts';
import { type Session, type Usage, addUsage, recordSample } from './session.ts';

interface Req { usage: Usage; cost: number | null }

export interface ClaudeState { reqs: Map<string, Req>; unpricedCount: number }
export const newClaudeState = (): ClaudeState => ({ reqs: new Map(), unpricedCount: 0 });

function toUsage(u: any): Usage {
  const cc = u.cache_creation;
  const w5 = cc ? cc.ephemeral_5m_input_tokens ?? 0 : u.cache_creation_input_tokens ?? 0;
  const w1 = cc ? cc.ephemeral_1h_input_tokens ?? 0 : 0;
  return {
    input: u.input_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite5m: w5,
    cacheWrite1h: w1,
    output: u.output_tokens ?? 0,
    reasoning: u.output_tokens_details?.thinking_tokens ?? 0,
  };
}

// `sub` = line came from a subagent file; it counts toward totals but not main context.
export function claudeLine(s: Session, st: ClaudeState, d: any, sub = false): void {
  if (!s.project && d.cwd) s.project = basename(d.cwd);
  const m = d.message;
  if (d.type !== 'assistant' || !m?.usage) return;
  if (!m.model || m.model === '<synthetic>') return; // local placeholder, not an API call
  const key = m.id ?? d.requestId;
  if (!key) return;

  const usage = toUsage(m.usage);
  const c = cost(m.model, usage);
  const prev = st.reqs.get(key);
  if (prev) {
    addUsage(s.usage, prev.usage, -1);
    if (prev.cost === null) st.unpricedCount--; else s.cost -= prev.cost;
  }
  st.reqs.set(key, { usage, cost: c });
  addUsage(s.usage, usage);
  if (c === null) st.unpricedCount++; else s.cost += c;
  s.unpriced = st.unpricedCount > 0;

  const ts = Date.parse(d.timestamp) || 0;
  if (!sub && !d.isSidechain) {
    s.model = m.model;
    s.ctxTokens = usage.input + usage.cacheRead + usage.cacheWrite5m + usage.cacheWrite1h;
    s.ctxWindow = contextWindow(m.model);
  }
  if (ts) {
    s.lastEvent = Math.max(s.lastEvent, ts);
    if (!prev) recordSample(s, ts);
    else if (s.samples.length) s.samples[s.samples.length - 1][1] = s.usage.output;
  }
}
