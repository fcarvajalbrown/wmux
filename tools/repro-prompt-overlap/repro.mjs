import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function parseArgs(argv) {
  const opts = {
    shell: 'powershell.exe',
    cwd: os.homedir(),
    sizes: '120x30,60x30,120x30,40x30,120x30,120x15,120x30',
    type: 'codex',
    settleMs: 600,
    out: '',
    integration: true,
    reflowCursorLine: true,
    windowsPty: true,
    bundledConpty: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const next = () => argv[++i];
    if (key === '--shell') opts.shell = next();
    else if (key === '--cwd') opts.cwd = next();
    else if (key === '--sizes') opts.sizes = next();
    else if (key === '--type') opts.type = next();
    else if (key === '--settle-ms') opts.settleMs = Number(next());
    else if (key === '--out') opts.out = next();
    else if (key === '--no-integration') opts.integration = false;
    else if (key === '--no-reflow-cursor-line') opts.reflowCursorLine = false;
    else if (key === '--no-windows-pty') opts.windowsPty = false;
    else if (key === '--inbox-conpty') opts.bundledConpty = false;
    else if (key === '--help') {
      console.log('usage: node tools/repro-prompt-overlap/repro.mjs [--cwd DIR] [--sizes 120x30,60x30,...] [--type TEXT] [--settle-ms N] [--shell EXE] [--no-integration] [--no-reflow-cursor-line] [--no-windows-pty] [--inbox-conpty] [--out FILE.json]');
      process.exit(0);
    }
  }
  opts.sizeList = opts.sizes.split(',').map((s) => {
    const [cols, rows] = s.toLowerCase().split('x').map(Number);
    return { cols, rows };
  });
  return opts;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function shellLaunch(opts, env) {
  if (!opts.integration) return ['-NoLogo'];
  env.WMUX_PS1_SCRIPT = path.join(repoRoot, 'resources', 'shell-integration', 'wmux-powershell-integration.ps1');
  return ['-NoLogo', '-ExecutionPolicy', 'Bypass', '-NoExit', '-Command', '. $env:WMUX_PS1_SCRIPT'];
}

function viewport(term) {
  const buf = term.buffer.active;
  const rows = [];
  for (let y = 0; y < term.rows; y++) {
    const line = buf.getLine(buf.viewportY + y);
    rows.push(line ? line.translateToString(true) : '');
  }
  return rows;
}

function logicalCursorLine(term) {
  const buf = term.buffer.active;
  let y = buf.baseY + buf.cursorY;
  let end = y;
  while (buf.getLine(end + 1)?.isWrapped) end++;
  while (y > 0 && buf.getLine(y)?.isWrapped) y--;
  let text = '';
  for (let i = y; i <= end; i++) text += buf.getLine(i).translateToString(i === end);
  return text.trimEnd();
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const env = { ...process.env, TERM_PROGRAM: 'wmux' };
  const args = shellLaunch(opts, env);
  const build = Number(os.release().split('.')[2]);
  const first = opts.sizeList[0];

  const term = new Terminal({
    cols: first.cols,
    rows: first.rows,
    allowProposedApi: true,
    scrollback: 10000,
    windowsPty: !opts.windowsPty ? undefined
      : Number.isInteger(build) && build > 0 ? { backend: 'conpty', buildNumber: build } : { backend: 'conpty' },
    reflowCursorLine: opts.reflowCursorLine,
  });

  const proc = pty.spawn(opts.shell, args, {
    name: 'xterm-256color',
    cols: first.cols,
    rows: first.rows,
    cwd: opts.cwd,
    env,
    useConpty: true,
    useConptyDll: opts.bundledConpty,
  });

  let lastData = Date.now();
  proc.onData((d) => { lastData = Date.now(); term.write(d); });
  term.onData((d) => proc.write(d));

  const quiet = async (maxMs = 8000) => {
    const start = Date.now();
    await sleep(opts.settleMs);
    while (Date.now() - lastData < opts.settleMs && Date.now() - start < maxMs) await sleep(50);
    await new Promise((r) => term.write('', r));
  };

  const results = [];
  let exitCode = 0;
  try {
    await quiet(20000);
    const prompt = logicalCursorLine(term);
    const expected = `${prompt} ${opts.type}`.replace(/\s+$/, '');
    const record = (label, size) => {
      const line = logicalCursorLine(term);
      const pass = line === expected;
      if (!pass) exitCode = 1;
      const entry = { step: label, cols: size.cols, rows: size.rows, expected, got: line, pass, viewport: viewport(term) };
      results.push(entry);
      console.log(`${pass ? 'PASS' : 'FAIL'}  ${label.padEnd(18)} ${size.cols}x${size.rows}  got: ${JSON.stringify(line)}`);
    };

    for (let i = 0; i < opts.sizeList.length; i++) {
      const size = opts.sizeList[i];
      if (i > 0) {
        term.resize(size.cols, size.rows);
        proc.resize(size.cols, size.rows);
        await quiet();
      }
      proc.write(opts.type);
      await quiet();
      record(i === 0 ? 'initial' : `after resize ${i}`, size);
      proc.write('\x1b');
      await quiet();
    }
    console.log(`expected: ${JSON.stringify(expected)}`);
  } finally {
    try { proc.kill(); } catch { exitCode = exitCode || 2; }
    term.dispose();
  }

  if (opts.out) fs.writeFileSync(opts.out, JSON.stringify({ opts: { ...opts, sizeList: undefined }, results }, null, 2));
  const failed = results.filter((r) => !r.pass);
  for (const r of failed) {
    console.log(`\n--- ${r.step} ${r.cols}x${r.rows} viewport ---`);
    for (const row of r.viewport) if (row) console.log(`|${row}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
  process.exit(exitCode);
}

main().catch((err) => { console.error(err); process.exit(2); });
