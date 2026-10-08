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
}

// Anthropic first-party API list prices (cached 2026-10-06).
// ponytail: Haiku 5.5's >100K-prompt tier ($0.50/$2.50) is not modeled.
// Codex/OpenAI models are not built in; add them in ~/.config/agenttop/pricing.json.
const BUILTIN: Record<string, Price> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, context: 1_000_000 },
  'claude-fable-5': { input: 10, output: 50, context: 1_000_000 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, context: 1_000_000 },
  'claude-opus-5': { input: 5, output: 25, context: 1_000_000 },
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

// Returns null when the model has no price: callers must show N/A, never $0.
export function cost(model: string | null, u: Usage): number | null {
  const p = model ? lookup(model) : undefined;
  if (!p) return null;
  return (
    u.input * p.input +
    u.output * p.output +
    u.cacheRead * (p.cacheRead ?? p.input * 0.1) +
    u.cacheWrite5m * (p.cacheWrite5m ?? p.input * 1.25) +
    u.cacheWrite1h * (p.cacheWrite1h ?? p.input * 2)
  ) / 1e6;
}
