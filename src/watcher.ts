// Finds session logs under each source's home and tails them incrementally.
// Read-only: files are opened with 'r' and never written. Polling (no fs.watch) keeps it
// portable; each poll is one stat() per tracked file plus a read of only the new bytes.

import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { type ClaudeState, claudeLine, newClaudeState } from './claude.ts';
import { type CodexState, codexLine, newCodexState } from './codex.ts';
import type { SourceConfig } from './config.ts';
import { type Session, newSession } from './session.ts';

interface Entry { session: Session; state: ClaudeState | CodexState; files: string[] }
interface FileState { key: string; sub: boolean; offset: number; partial: Buffer | null; mtime: number }

const CHUNK = 4 << 20;

export class SourceWatcher {
  readonly cfg: SourceConfig;
  readonly sessions = new Map<string, Entry>();
  private files = new Map<string, FileState>();
  warning: string | null = null;
  private maxAgeMs: number;

  constructor(cfg: SourceConfig, days: number) {
    this.cfg = cfg;
    this.maxAgeMs = days * 86_400_000;
  }

  // Discover new log files. Cheap enough to run every few seconds.
  scan(now = Date.now()): void {
    const { home, provider } = this.cfg;
    if (!existsSync(home)) { this.warning = `${this.cfg.name}: ${home} not found`; return; }
    this.warning = null;
    const found: [string, string, boolean][] = []; // [path, sessionKey, isSubagent]
    if (provider === 'claude') {
      const root = join(home, 'projects');
      for (const slug of ls(root)) {
        const dir = join(root, slug);
        for (const f of ls(dir)) {
          if (f.endsWith('.jsonl')) found.push([join(dir, f), `${slug}/${f.slice(0, -6)}`, false]);
          else for (const a of ls(join(dir, f, 'subagents')))
            if (a.endsWith('.jsonl')) found.push([join(dir, f, 'subagents', a), `${slug}/${f}`, true]);
        }
      }
    } else {
      const walk = (dir: string): void => {
        for (const f of ls(dir)) {
          const p = join(dir, f);
          if (f.endsWith('.jsonl')) found.push([p, f, false]);
          else if (!f.includes('.')) walk(p);
        }
      };
      walk(join(home, 'sessions'));
    }
    for (const [path, key, sub] of found) {
      if (this.files.has(path)) continue;
      let mtime: number;
      try { mtime = statSync(path).mtimeMs; } catch { continue; }
      if (now - mtime > this.maxAgeMs) continue;
      this.files.set(path, { key, sub, offset: 0, partial: null, mtime });
      let e = this.sessions.get(key);
      if (!e) {
        const id = provider === 'claude' ? basename(key) : codexId(key);
        e = {
          session: newSession(id, this.cfg.name, provider),
          state: provider === 'claude' ? newClaudeState() : newCodexState(),
          files: [],
        };
        this.sessions.set(key, e);
      }
      e.files.push(path);
    }
  }

  // Read new bytes from every tracked file.
  poll(): void {
    for (const [path, f] of this.files) {
      let st;
      try { st = statSync(path); } catch { continue; }
      const e = this.sessions.get(f.key)!;
      if (st.size < f.offset) { this.reset(e); }
      if (st.size === f.offset) continue;
      f.mtime = st.mtimeMs;
      e.session.lastActive = Math.max(e.session.lastActive, st.mtimeMs);
      this.read(path, f, e, st.size);
    }
  }

  // A log shrank (rewritten): rebuild that session from scratch.
  private reset(e: Entry): void {
    const s = e.session;
    e.session = newSession(s.id, s.source, s.provider);
    e.state = s.provider === 'claude' ? newClaudeState() : newCodexState();
    for (const p of e.files) { const f = this.files.get(p)!; f.offset = 0; f.partial = null; }
  }

  private read(path: string, f: FileState, e: Entry, size: number): void {
    let fd: number;
    try { fd = openSync(path, 'r'); } catch { return; }
    try {
      const buf = Buffer.allocUnsafe(Math.min(CHUNK, size - f.offset));
      while (f.offset < size) {
        const n = readSync(fd, buf, 0, Math.min(buf.length, size - f.offset), f.offset);
        if (n <= 0) break;
        f.offset += n;
        let data = buf.subarray(0, n);
        if (f.partial) { data = Buffer.concat([f.partial, data]); f.partial = null; }
        let start = 0;
        for (let nl = data.indexOf(10); nl !== -1; nl = data.indexOf(10, start)) {
          this.line(data.toString('utf8', start, nl), f, e);
          start = nl + 1;
        }
        // Keep an incomplete trailing line until the writer finishes it.
        if (start < data.length) f.partial = Buffer.from(data.subarray(start));
      }
    } finally {
      closeSync(fd);
    }
  }

  private line(text: string, f: FileState, e: Entry): void {
    // Skip JSON.parse for lines that cannot matter (most of a log is message content).
    if (e.session.provider === 'claude') {
      if (!text.includes('"usage"') && (e.session.project || !text.includes('"cwd"'))) return;
    } else if (!text.includes('"token_count"') && !text.includes('"turn_context"') && !text.includes('"session_meta"')) {
      return;
    }
    let d: any;
    try { d = JSON.parse(text); } catch { return; }
    if (e.session.provider === 'claude') claudeLine(e.session, e.state as ClaudeState, d, f.sub);
    else codexLine(e.session, e.state as CodexState, d);
  }

  list(): Session[] {
    return [...this.sessions.values()].map((e) => e.session);
  }
}

function ls(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

// rollout-2026-10-07T17-24-01-<uuid>.jsonl -> <uuid>
function codexId(file: string): string {
  return file.replace(/^rollout-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-/, '').replace(/\.jsonl$/, '');
}

