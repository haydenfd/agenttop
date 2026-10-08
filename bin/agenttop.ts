#!/usr/bin/env node
import { join } from 'node:path';
import { CONFIG_DIR, loadConfig } from '../src/config.ts';
import { loadPricing } from '../src/pricing.ts';
import { Tui } from '../src/tui.ts';
import { SourceWatcher } from '../src/watcher.ts';

let cfg;
try {
  cfg = loadConfig();
} catch (e: any) {
  console.error(`agenttop: ${e.message}`);
  process.exit(1);
}
const pricingErr = loadPricing(join(CONFIG_DIR, 'pricing.json'));
if (pricingErr) { console.error(`agenttop: ${pricingErr}`); process.exit(1); }

if (!process.stdout.isTTY || !process.stdin.isTTY) {
  console.error('agenttop: needs an interactive terminal');
  process.exit(1);
}

const watchers = cfg.sources.map((s) => new SourceWatcher(s, cfg.days));
const tui = new Tui(watchers);

const restore = () => process.stdout.write('\x1b[?25h\x1b[?1049l');
const quit = () => { restore(); process.exit(0); };
process.on('exit', restore);
process.on('SIGTERM', quit);
process.on('uncaughtException', (e) => { restore(); console.error(e); process.exit(1); });

process.stdout.write('\x1b[?1049h\x1b[?25l'); // alt screen, hide cursor
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', (buf) => {
  const k = buf.toString();
  if (k === 'q' || k === '\x03' || k === '\x1b') quit();
  else if (k === '\x1b[A' || k === 'k') tui.move(-1);
  else if (k === '\x1b[B' || k === 'j') tui.move(1);
  else if (k === '\x1b[5~') tui.move(-10);
  else if (k === '\x1b[6~') tui.move(10);
  else if (k === '\x1b[H' || k === 'g') tui.move(-Infinity);
  else if (k === '\x1b[F' || k === 'G') tui.move(Infinity);
  else if (k === '\r') tui.toggleDetails();
});
process.stdout.on('resize', () => tui.render());

tui.render();

let ticks = 0;
const tick = () => {
  if (ticks++ % 5 === 0) for (const w of watchers) w.scan(); // discover new files every 5s
  for (const w of watchers) w.poll();
  tui.loading = false;
  tui.refreshRows();
  tui.render();
};
setImmediate(() => { tick(); setInterval(tick, 1000); });
