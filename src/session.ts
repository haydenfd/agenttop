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
  account: string | null;    // codex: creator_account_id from session_meta
  model: string | null;      // latest model seen
  usage: Usage;              // deduplicated session totals
  ctxTokens: number | null;  // tokens in context at the latest request
  ctxWindow: number | null;
  cost: number;              // USD for priced requests
  unpriced: boolean;         // true if any request's model had no price -> show N/A
  lastEvent: number;         // ms epoch of latest usage-bearing event
  lastActive: number;        // ms epoch of latest log file write (drives status + sort)
  // (timestamp ms, cumulative output tokens) for effective TPS
  samples: [number, number][];
}

export function newSession(id: string, source: string, provider: Provider): Session {
  return {
    id, source, provider, project: '', account: null, model: null, usage: zeroUsage(),
    ctxTokens: null, ctxWindow: null, cost: 0, unpriced: false, lastEvent: 0, lastActive: 0, samples: [],
  };
}

export function recordSample(s: Session, ts: number): void {
  const last = s.samples[s.samples.length - 1];
  if (last && ts < last[0]) { last[1] = s.usage.output; return; } // out-of-order (subagent backfill)
  s.samples.push([ts, s.usage.output]);
  // keep ~10 minutes of samples; effective TPS only looks at the last 60s
  while (s.samples.length > 1 && s.samples[0][0] < ts - 600_000) s.samples.shift();
}

// Effective TPS: output tokens / wall-clock seconds over the last 60s of observed activity.
// This is NOT decoding speed: it includes tool time, prefill and idle gaps.
export function effectiveTps(s: Session): number | null {
  if (s.samples.length < 2) return null;
  const [tEnd, oEnd] = s.samples[s.samples.length - 1];
  const start = s.samples.find(([t]) => t >= tEnd - 60_000)!;
  const secs = (tEnd - start[0]) / 1000;
  if (secs < 5) return null;
  return (oEnd - start[1]) / secs;
}
