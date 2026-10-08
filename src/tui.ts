// Full-screen terminal UI with plain ANSI escapes (no dependencies).

import { type Session, effectiveTps } from './session.ts';
import type { SourceWatcher } from './watcher.ts';

const ESC = '\x1b[';
const c = {
  dim: (s: string) => `${ESC}2m${s}${ESC}22m`,
  bold: (s: string) => `${ESC}1m${s}${ESC}22m`,
  inv: (s: string) => `${ESC}7m${s}${ESC}27m`,
  fg: (n: number, s: string) => `${ESC}38;5;${n}m${s}${ESC}39m`,
};
const PROVIDER_COLOR = { codex: 39, claude: 209 } as const; // blue, orange
const STATUS_COLOR = { active: 82, idle: 220, done: 245, unknown: 245 } as const;
const NA = '--';

type Status = keyof typeof STATUS_COLOR;
export function status(s: Session, now: number): Status {
  if (!s.lastEvent) return 'unknown';
  const age = now - s.lastActive;
  return age < 30_000 ? 'active' : age < 30 * 60_000 ? 'idle' : 'done';
}

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}K`;
  return `${(n / 1e6).toFixed(n < 1e7 ? 2 : 1)}M`;
}

function fmtAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const totalTokens = (s: Session) =>
  s.usage.input + s.usage.cacheRead + s.usage.cacheWrite5m + s.usage.cacheWrite1h + s.usage.output;
const fmtCost = (s: Session) => (s.unpriced || !s.lastEvent ? 'N/A' : `$${s.cost.toFixed(2)}`);
const fmtCtx = (s: Session) =>
  s.ctxTokens === null || !s.ctxWindow ? NA : `${Math.round((100 * s.ctxTokens) / s.ctxWindow)}%`;
const fmtTps = (s: Session) => { const t = effectiveTps(s); return t === null ? NA : t.toFixed(1); };

interface Col { title: string; width: number; right?: boolean; prio: number; get: (s: Session, now: number) => string }
// prio: lower = more important; columns with the highest prio are dropped first on narrow terminals.
const COLS: Col[] = [
  { title: 'ACCOUNT', width: 14, prio: 0, get: (s) => s.source },
  { title: 'PROJECT', width: 18, prio: 1, get: (s) => s.project || NA },
  { title: 'MODEL', width: 18, prio: 5, get: (s) => s.model ?? NA },
  { title: 'STATUS', width: 7, prio: 3, get: (s, now) => status(s, now) },
  { title: 'TOKENS', width: 7, right: true, prio: 0, get: (s) => fmtTokens(totalTokens(s)) },
  { title: 'IN', width: 7, right: true, prio: 7, get: (s) => fmtTokens(s.usage.input) },
  { title: 'CACHED', width: 7, right: true, prio: 7, get: (s) => fmtTokens(s.usage.cacheRead) },
  { title: 'OUT', width: 7, right: true, prio: 6, get: (s) => fmtTokens(s.usage.output) },
  { title: 'CTX', width: 5, right: true, prio: 2, get: fmtCtx },
  { title: 'eTPS', width: 6, right: true, prio: 2, get: fmtTps },
  { title: 'COST', width: 8, right: true, prio: 0, get: fmtCost },
  { title: 'LAST', width: 5, right: true, prio: 4, get: (s, now) => fmtAge(now - s.lastActive) },
];

function fit(text: string, w: number, right = false): string {
  if (text.length > w) text = w > 1 ? text.slice(0, w - 1) + '…' : text.slice(0, w);
  return right ? text.padStart(w) : text.padEnd(w);
}

function visibleCols(width: number): Col[] {
  let cols = COLS;
  const need = (cs: Col[]) => 2 + cs.reduce((a, col) => a + col.width + 1, 0);
  while (need(cols) > width && cols.length > 1) {
    const worst = Math.max(...cols.map((col) => col.prio));
    const i = cols.findLastIndex((col) => col.prio === worst);
    cols = cols.filter((_, j) => j !== i);
  }
  return cols;
}

export class Tui {
  private sel = 0;           // index into sorted rows
  private selKey = '';       // keeps the selection on the same session across re-sorts
  private top = 0;           // first visible row
  private details = false;
  private rows: Session[] = [];
  private watchers: SourceWatcher[];
  private out = process.stdout;
  loading = true;

  constructor(watchers: SourceWatcher[]) {
    this.watchers = watchers;
  }

  private key = (s: Session) => `${s.source}/${s.id}`;

  refreshRows(): void {
    this.rows = this.watchers.flatMap((w) => w.list())
      .sort((a, b) => b.lastActive - a.lastActive || a.id.localeCompare(b.id));
    const i = this.rows.findIndex((s) => this.key(s) === this.selKey);
    this.sel = i >= 0 ? i : Math.min(this.sel, Math.max(0, this.rows.length - 1));
    if (this.rows[this.sel]) this.selKey = this.key(this.rows[this.sel]);
  }

  move(delta: number): void {
    if (!this.rows.length) return;
    this.sel = Math.max(0, Math.min(this.rows.length - 1, this.sel + delta));
    this.selKey = this.key(this.rows[this.sel]);
    this.render();
  }

  toggleDetails(): void { this.details = !this.details; this.render(); }

  render(): void {
    const width = this.out.columns || 80;
    const height = this.out.rows || 24;
    const now = Date.now();
    const lines: string[] = [];
    const sources = this.watchers.length;
    lines.push(c.bold('agenttop') + c.dim(`  ${this.rows.length} sessions · ${sources} sources`) +
      (this.loading ? c.dim('  · loading…') : ''));
    const warnings = this.watchers.map((w) => w.warning).filter(Boolean) as string[];
    for (const w of warnings) lines.push(c.fg(220, `! ${w}`));
    lines.push('');

    const cols = visibleCols(width);
    lines.push(c.dim('  ' + cols.map((col) => fit(col.title, col.width, col.right)).join(' ')));

    const detailLines = this.details && this.rows[this.sel] ? this.detailLines(this.rows[this.sel], now) : [];
    const footer = 2;
    const avail = Math.max(1, height - lines.length - footer - detailLines.length);
    if (this.sel < this.top) this.top = this.sel;
    if (this.sel >= this.top + avail) this.top = this.sel - avail + 1;
    this.top = Math.max(0, Math.min(this.top, Math.max(0, this.rows.length - avail)));

    for (const s of this.rows.slice(this.top, this.top + avail)) {
      const st = status(s, now);
      const cells = cols.map((col) => {
        const text = fit(col.get(s, now), col.width, col.right);
        if (col.title === 'STATUS') return c.fg(STATUS_COLOR[st], text);
        if (text.trim() === NA || text.trim() === 'N/A') return c.dim(text);
        return text;
      });
      const dot = c.fg(PROVIDER_COLOR[s.provider], '●');
      const row = `${dot} ${cells.join(' ')}`;
      lines.push(this.key(s) === this.selKey ? c.inv(row) : row);
    }
    if (!this.rows.length && !this.loading) lines.push(c.dim('  no sessions in the configured time window'));
    while (lines.length < height - footer - detailLines.length) lines.push('');
    lines.push(...detailLines);
    lines.push('');
    lines.push(c.dim(fit('↑↓/jk navigate · PgUp/PgDn · Enter details · q/Esc/Ctrl+C exit · eTPS = output tok/s over recent activity (not decode speed)', width)));

    this.out.write(`${ESC}H` + lines.slice(0, height).map((l) => l + `${ESC}K`).join('\r\n') + `${ESC}J`);
  }

  private detailLines(s: Session, now: number): string[] {
    const u = s.usage;
    return [
      c.dim('─'.repeat(Math.min(this.out.columns || 80, 100))),
      `${c.bold(s.source)} · ${s.project || NA} · ${s.model ?? NA} · ${status(s, now)} · session ${s.id}`,
      `input ${fmtTokens(u.input)}  cache read ${fmtTokens(u.cacheRead)}  cache write ${fmtTokens(u.cacheWrite5m + u.cacheWrite1h)}  ` +
        `output ${fmtTokens(u.output)}  reasoning ${u.reasoning ? fmtTokens(u.reasoning) : NA}`,
      `context ${s.ctxTokens === null ? NA : fmtTokens(s.ctxTokens)} / ${s.ctxWindow ? fmtTokens(s.ctxWindow) : NA}  ` +
        `effective TPS ${fmtTps(s)}  generation TPS N/A (logs carry no decode timing)  cost ${fmtCost(s)}`,
    ];
  }
}
