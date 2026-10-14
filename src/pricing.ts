import { readFileSync } from 'node:fs';
import type { Usage } from './session.ts';

// USD per 1M tokens. cacheWrite5m/1h default to 1.25x / 2x input, cacheRead to 0.1x input.
export interface Price {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  context?: number; // context window in tokens
  // Requests whose prompt (input incl. cached) exceeds `above` are billed at higher rates.
  long?: { above: number; input: number; output: number }; // multipliers
  fast?: number; // fast-mode multiplier on every rate; unset = fast requests are unpriced
}

// Anthropic first-party API list prices (cached 2026-10-06).
// ponytail: Haiku 5.5's >100K-prompt tier ($0.50/$2.50) is not modeled.
// OpenAI: standard rates from OpenAI's GPT-6.1 Sol announcement. The cache-write rate and
// the >272K long-prompt tier come from third-party guides; override in pricing.json if wrong.
const BUILTIN: Record<string, Price> = {
  'gpt-6.1-sol': { input: 2, output: 10, cacheRead: 0.1, cacheWrite5m: 2.5, long: { above: 272_000, input: 2, output: 1.5 } },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, context: 1_000_000 },
  'claude-fable-5': { input: 10, output: 50, context: 1_000_000 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, context: 1_000_000, fast: 2 },
  'claude-opus-5': { input: 5, output: 25, context: 1_000_000, fast: 2 },
  'claude-opus-4-8': { input: 5, output: 25, context: 1_000_000 },
  'claude-opus-4-7': { input: 5, output: 25, context: 1_000_000 },
  'claude-opus-4-6': { input: 5, output: 25, context: 1_000_000 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, context: 1_000_000 },
  'claude-sonnet-5': { input: 2, output: 10, context: 1_000_000 },
  'claude-sonnet-4-6': { input: 3, output: 15, context: 1_000_000 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, context: 1_000_000 },
  'claude-haiku-4-5': { input: 1, output: 5, context: 200_000 },
};

let catalog: Record<string, Price> = { ...BUILTIN };

export function loadPricing(path: string): string | null {
  try {
    catalog = { ...BUILTIN, ...JSON.parse(readFileSync(path, 'utf8')) };
    return null;
  } catch (e: any) {
    return e.code === 'ENOENT' ? null : `pricing.json: ${e.message}`;
  }
}

// Strip date suffixes like claude-haiku-4-5-20251001 and [1m] markers.
function lookup(model: string): Price | undefined {
  const m = model.replace(/\[.*\]$/, '');
  return catalog[m] ?? catalog[m.replace(/-\d{8}$/, '')];
}

export function contextWindow(model: string): number | null {
  return lookup(model)?.context ?? null;
}

// Prices ONE request (the long-prompt tier depends on request size). Returns null when the
// model has no price: callers must show N/A, never $0.
export function cost(model: string | null, u: Usage, fast = false): number | null {
  const p = model ? lookup(model) : undefined;
  if (!p || (fast && !p.fast)) return null;
  const f = fast ? p.fast! : 1;
  const prompt = u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
  const long = p.long && prompt > p.long.above;
  const im = long ? p.long!.input : 1;
  const om = long ? p.long!.output : 1;
  return f * (
    im * (u.input * p.input +
      u.cacheRead * (p.cacheRead ?? p.input * 0.1) +
      u.cacheWrite5m * (p.cacheWrite5m ?? p.input * 1.25) +
      u.cacheWrite1h * (p.cacheWrite1h ?? p.input * 2)) +
    om * u.output * p.output
  ) / 1e6;
}
