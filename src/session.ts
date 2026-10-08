// Normalized per-session state shared by both parsers and the TUI.

export type Provider = 'codex' | 'claude';

export interface Usage {
  input: number;       // uncached input tokens
  cacheRead: number;   // cached input tokens read
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;      // includes reasoning/thinking tokens
  reasoning: number;   // subset of output, when reported
}

export const zeroUsage = (): Usage =>
  ({ input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0, reasoning: 0 });

export function addUsage(a: Usage, b: Usage, sign = 1): void {
  for (const k of Object.keys(a) as (keyof Usage)[]) a[k] += sign * b[k];
}

export interface Session {
  id: string;
  source: string;            // account name from config
  provider: Provider;
  project: string;           // basename of cwd
  branch: string;            // git branch
  title: string;             // session name (user-set or auto-generated)
  account: string | null;    // codex: creator_account_id from session_meta
  model: string | null;      // latest model seen
  usage: Usage;              // deduplicated session totals
  ctxTokens: number | null;  // tokens in context at the latest request
  ctxWindow: number | null;
  cost: number;              // USD for priced requests
  unpriced: boolean;         // true if any request's model had no price -> show N/A
  lastEvent: number;         // ms epoch of latest usage-bearing event
  lastActive: number;        // ms epoch of latest log file write (drives status + sort)
  reqs: Req[];               // every API request in the session, for TPS
}

export function newSession(id: string, source: string, provider: Provider): Session {
  return {
    id, source, provider, project: '', branch: '', title: '', account: null, model: null, usage: zeroUsage(),
    ctxTokens: null, ctxWindow: null, cost: 0, unpriced: false, lastEvent: 0, lastActive: 0, reqs: [],
  };
}

// One API request: output tokens and the time it was in flight, from the moment its input
// (prompt or tool result) was logged to the moment its response was logged. Tool execution
// and idle time fall outside every request, so they never count.
export interface Req { start: number; end: number; out: number }

// Per-log-file timing state: when the latest request input was logged.
export interface Clock { lastInput: number }

export function recordReq(s: Session, r: Req): void {
  s.reqs.push(r);
}

// Session TPS: total output tokens / total in-flight seconds across every request.
// Includes prompt processing and time-to-first-token, which the logs cannot separate out.
export function tps(s: Session): number | null {
  let out = 0, ms = 0;
  for (const r of s.reqs) {
    if (r.end <= r.start || r.out <= 0) continue;
    out += r.out;
    ms += r.end - r.start;
  }
  return ms < 500 ? null : out / (ms / 1000);
}
