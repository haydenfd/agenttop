import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Provider } from './session.ts';

export interface SourceConfig { name: string; provider: Provider; home: string }
export interface Config { sources: SourceConfig[]; days: number }

export const CONFIG_DIR = join(homedir(), '.config', 'agenttop');
export const CONFIG_PATH = join(CONFIG_DIR, 'config.toml');

const DEFAULT: Config = {
  days: 1,
  sources: [
    { name: 'codex', provider: 'codex', home: '~/.codex' },
    { name: 'claude', provider: 'claude', home: '~/.claude' },
  ],
};

export const expandHome = (p: string) => (p === '~' || p.startsWith('~/') ? homedir() + p.slice(1) : p);

// Minimal TOML subset: `[[sources]]` tables, `key = "string"` and `key = number`, # comments.
export function parseConfig(text: string): Config {
  const cfg: Config = { days: DEFAULT.days, sources: [] };
  let cur: Record<string, string> | null = null;
  const tables: Record<string, string>[] = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\s+#.*$|^#.*$/, '').trim();
    if (!line) return;
    if (line === '[[sources]]') { cur = {}; tables.push(cur); return; }
    const m = line.match(/^([A-Za-z_]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\d+(?:\.\d+)?))$/);
    if (!m) throw new Error(`config line ${i + 1}: cannot parse: ${raw.trim()}`);
    const [, key, dq, sq, num] = m;
    const val = dq ?? sq ?? num;
    if (cur) cur[key] = val;
    else if (key === 'days' && num) cfg.days = Number(num);
    else throw new Error(`config line ${i + 1}: unknown top-level key "${key}"`);
  });
  for (const t of tables) {
    if (!t.name || !t.home) throw new Error(`each [[sources]] needs name and home`);
    if (t.provider !== 'codex' && t.provider !== 'claude')
      throw new Error(`source "${t.name}": provider must be "codex" or "claude"`);
    cfg.sources.push({ name: t.name, provider: t.provider, home: expandHome(t.home) });
  }
  return cfg;
}

export function loadConfig(path = CONFIG_PATH): Config {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
    return { ...DEFAULT, sources: DEFAULT.sources.map((s) => ({ ...s, home: expandHome(s.home) })) };
  }
  return parseConfig(text);
}
