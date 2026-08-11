#!/usr/bin/env node
// f5 追加監査（suzune, room[94]）: 部品テスト（tmuxPanePid/isPaneProcessStopped）だけでは
// readSeat の override（`tentativeStatus === 'idle' && isPaneProcessStopped(...) ? 'dead' : ...`）
// を消しても検出できない。room が実際に受け取る status（bridge を --once で走らせた送信結果）を
// 直接見る e2e ハーネスを追加する。
//
// usage: [SEAT_STATUS_BRIDGE=/path] node experiments/seat-stopped-status-e2e-repro.mjs
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = process.env.SEAT_STATUS_BRIDGE ?? path.join(ROOT, 'skill', 'scripts', 'seat-status-bridge.mjs');
const ROOM_SERVER = path.join(ROOT, 'room', 'server.mjs');

const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

let ok = true;
const check = (name, pass, detail) => { console.log(`  ${pass ? 'pass' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); if (!pass) ok = false; };

const port = Number(process.env.PORT) || await freePort();
const data = await mkdtemp(path.join(tmpdir(), 'peertable-seat-stopped-e2e-data-'));
const base = `http://127.0.0.1:${port}/api/f5repro`;
const childEnv = { ...process.env, PEERTABLE_PORT: String(port), PEERTABLE_DATA: data };
delete childEnv.PEERTABLE_POST_TOKEN;
const server = spawn('node', [ROOM_SERVER], { env: childEnv, stdio: ['ignore', 'ignore', 'pipe'] });
let serverErr = '';
server.stderr.on('data', (d) => { serverErr += d; });

const proj = await mkdtemp(path.join(tmpdir(), 'peertable-seat-stopped-e2e-proj-'));
const sockDir = await mkdtemp(path.join(tmpdir(), 'peertable-seat-stopped-e2e-sock-'));
const socket = path.join(sockDir, 'test.sock');
const session = `peertable-f5-e2e-${process.pid}`;

async function waitListening() {
  for (let i = 0; i < 50; i += 1) {
    try { await fetch(`${base}/members`); return true; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  return false;
}

try {
  const listening = await waitListening();
  check('fixture room server が起動する', listening, serverErr.trim().slice(-300));

  await mkdir(path.join(proj, '.team'), { recursive: true });
  await writeFile(path.join(proj, '.team/setup-state.json'), JSON.stringify({ room: 'f5repro', server_url: `http://127.0.0.1:${port}`, mode: 'standalone' }));

  execFileSync('tmux', ['-S', socket, 'new-session', '-d', '-s', session, '-x', '80', '-y', '20']);
  await new Promise((r) => setTimeout(r, 200));
  execFileSync('tmux', ['-S', socket, 'send-keys', '-t', session, 'sleep 100', 'Enter']);
  await new Promise((r) => setTimeout(r, 300));

  const panePid = execFileSync('tmux', ['-S', socket, 'list-panes', '-t', session, '-F', '#{pane_pid}'], { encoding: 'utf8' }).trim();
  const psOut = execFileSync('ps', ['-o', 'pid=,ppid=', '-A'], { encoding: 'utf8' });
  const childLine = psOut.split('\n').find((line) => { const m = /^\s*(\d+)\s+(\d+)/u.exec(line); return m && m[2] === panePid; });
  const childPid = childLine ? /^\s*(\d+)/u.exec(childLine)[1] : null;
  check('shellの子(sleep job)が見つかる', childPid !== null);

  // member を observe 記述子つきで登録する（resolveSeatObservation が読む形）
  await fetch(`${base}/members`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'fixture-seat', observe: { tmux_socket: socket, tmux_target: session } }),
  });

  const runOnce = async () => execFileP('node', [BRIDGE, proj, '--once'], { env: { ...process.env, PEERTABLE_TMUX_SOCKET: socket } });
  const memberStatus = async () => {
    const res = await fetch(`${base}/members`);
    const { members } = await res.json();
    return members.find((m) => m.name === 'fixture-seat')?.status;
  };

  await runOnce();
  check('running中はroomへidleが送られる', (await memberStatus()) === 'idle', `status=${await memberStatus()}`);

  execFileSync('kill', ['-STOP', childPid]);
  await new Promise((r) => setTimeout(r, 200));
  await runOnce();
  const stoppedStatus = await memberStatus();
  check('SIGSTOP後はroomへdeadが送られる（idleのまま送らない）', stoppedStatus === 'dead', `status=${stoppedStatus}`);

  execFileSync('kill', ['-CONT', childPid]);
  await new Promise((r) => setTimeout(r, 200));
} finally {
  try { execFileSync('tmux', ['-S', socket, 'kill-session', '-t', session]); } catch { /* already gone */ }
  server.kill();
  await rm(proj, { recursive: true, force: true });
  await rm(sockDir, { recursive: true, force: true });
  await rm(data, { recursive: true, force: true });
}

console.log(ok ? 'seat stopped-status e2e repro: green' : 'seat stopped-status e2e repro: RED');
process.exit(ok ? 0 : 1);
