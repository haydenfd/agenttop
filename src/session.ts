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
  toolCalls: number;
  toolErrors: Record<string, number>; // "<tool>: <reason>" -> count
}

export function newSession(id: string, source: string, provider: Provider): Session {
  return {
    id, source, provider, project: '', title: '', account: null, model: null, usage: zeroUsage(),
    ctxTokens: null, ctxWindow: null, cost: 0, unpriced: false, lastEvent: 0, lastActive: 0, reqs: [],
    toolCalls: 0, toolErrors: {},
  };
}

// One API request. Codex can also report when the first model token arrived.
export interface Req { start: number; end: number; out: number; generationStart?: number }

// Per-log-file timing state: when the latest request input was logged.
export interface Clock { lastInput: number }

export function recordReq(s: Session, r: Req): void {
  s.reqs.push(r);
}

// Codex uses only requests with first-token timing; Claude includes prompt processing.
export function tpsStats(s: Session): { rate: number | null; requests: number } {
  let out = 0, ms = 0, requests = 0;
  for (const r of s.reqs) {
    const start = s.provider === 'codex' ? r.generationStart : r.start;
    if (start === undefined || !Number.isFinite(start) || !Number.isFinite(r.end)
      || r.end <= start || !Number.isFinite(r.out) || r.out <= 0) continue;
    out += r.out;
    ms += r.end - start;
    requests++;
  }
  return { rate: ms < 500 ? null : out / (ms / 1000), requests };
}

export const tps = (s: Session): number | null => tpsStats(s).rate;

export function recordToolError(s: Session, tool: string, reason: string): void {
  const k = `${tool}: ${reason}`;
  s.toolErrors[k] = (s.toolErrors[k] ?? 0) + 1;
}

// Shell commands are labeled by program, so `gh` failing 13 times stands out from `cat`.
// Skips a leading `cd dir &&` and VAR=value assignments.
export function shellLabel(tool: string, cmd: string): string {
  const m = /^\s*(?:cd\s+\S+\s*&&\s*)?(?:\w+=\S*\s+)*([^\s;|&()]+)/.exec(cmd ?? '');
  return m ? `${tool}(${m[1].split('/').pop()})` : tool;
}
