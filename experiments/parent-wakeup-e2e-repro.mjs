#!/usr/bin/env node
// t3 追加実測（tsubaki, room[95]）: parent-join.sh が observe 記述子を自己申告し、
// wakeup-bridge.mjs をその記述子経由で親（Codex 想定）へ実際に起こせることを、
// 実 room server（SSE 対応）＋実 tmux pane で確認する。
//
// これは「入口が配線されていること」の実測であり、実 Codex CLI セッションを親として動かす
// 検証（Desktop/CLI の wake 差の区別を含む）はこの host では別途 t4 で行う
// （campaign文書t3: 「外部注入面が存在しない host は、制約と継続監視の正規手順を明示して止める」）。
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOM_SERVER = path.join(ROOT, 'room', 'server.mjs');
const WAKEUP_BRIDGE = path.join(ROOT, 'skill', 'scripts', 'wakeup-bridge.mjs');

const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

let ok = true;
const check = (name, pass, detail) => { console.log(`  ${pass ? 'pass' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); if (!pass) ok = false; };

const port = Number(process.env.PORT) || await freePort();
const data = await mkdtemp(path.join(tmpdir(), 'peertable-parent-wakeup-data-'));
const room = 'parentwake';
const base = `http://127.0.0.1:${port}/api/${room}`;
const childEnv = { ...process.env, PEERTABLE_PORT: String(port), PEERTABLE_DATA: data };
delete childEnv.PEERTABLE_POST_TOKEN;
const server = spawn('node', [ROOM_SERVER], { env: childEnv, stdio: ['ignore', 'ignore', 'pipe'] });
let serverErr = '';
server.stderr.on('data', (d) => { serverErr += d; });

const proj = await mkdtemp(path.join(tmpdir(), 'peertable-parent-wakeup-proj-'));
const sockDir = await mkdtemp(path.join(tmpdir(), 'peertable-parent-wakeup-sock-'));
const socket = path.join(sockDir, 'test.sock');
const session = `peertable-parent-wakeup-${process.pid}`;
const parentName = 'parent-e2e';
let bridge = null;

async function waitListening() {
  for (let i = 0; i < 50; i += 1) {
    try { await fetch(`${base}/members`); return true; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  return false;
}

try {
  check('fixture room server が起動する', await waitListening(), serverErr.trim().slice(-300));

  await mkdir(path.join(proj, '.team'), { recursive: true });
  await writeFile(path.join(proj, '.team/setup-state.json'), JSON.stringify({ room, server_url: `http://127.0.0.1:${port}`, mode: 'standalone' }));

  // 親のペインを模す（launch-seat.sh と同じくシェルでセッションを作る。素の shell のまま置く）
  execFileSync('tmux', ['-S', socket, 'new-session', '-d', '-s', session, '-x', '80', '-y', '20']);
  await new Promise((r) => setTimeout(r, 200));
  const paneId = execFileSync('tmux', ['-S', socket, 'list-panes', '-t', session, '-F', '#{pane_id}'], { encoding: 'utf8' }).trim();

  // parent-join.sh が実際に送るのと同じ形（observe つき member 登録）
  await fetch(`${base}/members`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: parentName, vendor: 'codex', observe: { tmux_socket: socket, tmux_target: paneId } }),
  });

  bridge = spawn('node', [WAKEUP_BRIDGE, proj, parentName], { env: { ...process.env, PEERTABLE_TMUX_SOCKET: socket }, stdio: ['ignore', 'pipe', 'pipe'] });
  let bridgeOut = '';
  bridge.stdout.on('data', (d) => { bridgeOut += d; });
  bridge.stderr.on('data', (d) => { bridgeOut += d; });
  // ready_at が立つまで待つ
  let ready = false;
  for (let i = 0; i < 50; i += 1) {
    try {
      const rec = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(proj, '.team/wakeup-bridge.json'), 'utf8'));
      if (rec.ready_at) { ready = true; break; }
    } catch { /* not written yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  check('wakeup-bridge が起動しready_atを立てる', ready, bridgeOut.trim().slice(-300));

  // 他席から親宛に投げる（親自身の発言は除外されるので from を変える）
  await fetch(`${base}/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: 'tsubaki-fixture', to: parentName, body: 'テスト通知' }),
  });

  let delivered = null;
  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    const pane = execFileSync('tmux', ['-S', socket, 'capture-pane', '-t', session, '-p'], { encoding: 'utf8' });
    if (pane.includes('room に新着あり')) { delivered = pane; break; }
  }
  check('親宛メッセージが実際にpaneへsend-keysで届く（wakeup-bridge経由）', delivered !== null, delivered ? delivered.split('\n').filter((l) => l.includes('room に新着あり')).pop() : bridgeOut.trim().slice(-300));
} finally {
  if (bridge) { bridge.kill(); }
  try { execFileSync('tmux', ['-S', socket, 'kill-session', '-t', session]); } catch { /* already gone */ }
  server.kill();
  await rm(proj, { recursive: true, force: true });
  await rm(sockDir, { recursive: true, force: true });
  await rm(data, { recursive: true, force: true });
}

console.log(ok ? 'parent wakeup e2e repro: green' : 'parent wakeup e2e repro: RED');
process.exit(ok ? 0 : 1);
