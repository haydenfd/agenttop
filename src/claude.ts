// Claude Code logs: <home>/projects/<slug>/<sessionId>.jsonl, plus subagent logs at
// <home>/projects/<slug>/<sessionId>/subagents/*.jsonl (folded into the parent session).
//
// Each assistant line carries per-request `message.usage`. Streaming writes the same
// message several times (one line per content block) with identical usage, so requests
// are keyed by message.id and the latest copy replaces the earlier one.

import { basename } from 'node:path';
import { cost, contextWindow } from './pricing.ts';
import { type Clock, type Req, type Session, type Usage, addUsage, recordReq, recordToolError, shellLabel } from './session.ts';

interface Entry { usage: Usage; cost: number | null; req: Req | null }

// tools: tool_use id -> label, so a later error result can be attributed to its tool.
export interface ClaudeState { reqs: Map<string, Entry>; unpricedCount: number; customTitle: boolean; tools: Map<string, string> }
export const newClaudeState = (): ClaudeState => ({ reqs: new Map(), unpricedCount: 0, customTitle: false, tools: new Map() });

// Short, groupable reason for a failed tool result.
export function errorReason(content: any): string {
  const text: string = typeof content === 'string' ? content
    : Array.isArray(content) ? content.map((b: any) => b.text ?? '').join(' ') : '';
  if (text.includes("doesn't want to proceed")) return 'rejected by user';
  if (text.includes('auto mode classifier')) return 'denied by classifier';
  const exit = /^Exit code (\d+)/.exec(text);
  if (exit) return `exit ${exit[1]}`;
  const first = text.replace(/<\/?tool_use_error>/g, '').trim().split(/\.\s|\n/)[0];
  return first.replace(/\/\S+/g, '…').slice(0, 60) || 'error';
}

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
export function claudeLine(s: Session, st: ClaudeState, d: any, sub = false, clock: Clock = { lastInput: 0 }): void {
  if (!s.project && d.cwd) s.project = basename(d.cwd);
  // A name you set (/rename) wins over the auto-generated one.
  if (d.type === 'custom-title' && d.customTitle) { s.title = d.customTitle; st.customTitle = true; return; }
  if (d.type === 'ai-title' && d.aiTitle) { if (!st.customTitle) s.title = d.aiTitle; return; }
  const ts = Date.parse(d.timestamp) || 0;
  // Prompts and tool results are both "user" lines: each one starts the next request.
  if (d.type === 'user') {
    if (ts && !d.isSidechain) clock.lastInput = ts;
    if (Array.isArray(d.message?.content)) for (const b of d.message.content) {
      if (b.type === 'tool_result' && b.is_error) recordToolError(s, st.tools.get(b.tool_use_id) ?? 'unknown', errorReason(b.content));
    }
    return;
  }
  const m = d.message;
  if (d.type === 'assistant' && Array.isArray(m?.content)) for (const b of m.content) {
    if (b.type !== 'tool_use' || st.tools.has(b.id)) continue;
    st.tools.set(b.id, b.name === 'Bash' ? shellLabel('Bash', b.input?.command) : b.name);
    s.toolCalls++;
  }
  if (d.type !== 'assistant' || !m?.usage) return;
  if (!m.model || m.model === '<synthetic>') return; // local placeholder, not an API call
  const key = m.id ?? d.requestId;
  if (!key) return;

  const usage = toUsage(m.usage);
  const c = cost(m.model, usage, m.usage.speed === 'fast');
  const prev = st.reqs.get(key);
  if (prev) {
    addUsage(s.usage, prev.usage, -1);
    if (prev.cost === null) st.unpricedCount--; else s.cost -= prev.cost;
  }
  // Streaming writes one line per content block; the last line marks the end of the response.
  let req = prev?.req ?? null;
  if (req) { req.end = Math.max(req.end, ts); req.out = usage.output; }
  else if (ts && clock.lastInput && !d.isSidechain) {
    req = { start: clock.lastInput, end: ts, out: usage.output };
    recordReq(s, req);
  }
  st.reqs.set(key, { usage, cost: c, req });
  addUsage(s.usage, usage);
  if (c === null) st.unpricedCount++; else s.cost += c;
  s.unpriced = st.unpricedCount > 0;

  if (!sub && !d.isSidechain) {
    s.model = m.model;
    s.ctxTokens = usage.input + usage.cacheRead + usage.cacheWrite5m + usage.cacheWrite1h;
    s.ctxWindow = contextWindow(m.model);
  }
  if (ts) s.lastEvent = Math.max(s.lastEvent, ts);
}
