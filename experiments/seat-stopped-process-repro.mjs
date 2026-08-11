#!/usr/bin/env node
// f5: pane 自体は生きたまま中の CLI プロセスだけが stopped（SIGSTOP）になる局面を、
// classifyPaneTail だけでは idle と誤判定することの再現ハーネス。
//
// 実測（bell/suzune, 2026-08-11）: Lattice pull run の accept hold が attach 済み worker へ
// SIGSTOP を送ると、tmux pane は生きたまま（pane_dead=0）中の CLI プロセスだけが停止する。
// 画面末尾は停止直前のまま残るため、seat-usage.mjs の classifyPaneTail は idle を返す。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyPaneTail, isPaneProcessStopped, tmuxPanePid } from '../skill/scripts/seat-usage.mjs';

const socketDir = mkdtempSync(join(tmpdir(), 'peertable-seat-stopped-'));
const socket = join(socketDir, 'test.sock');
const session = `peertable-f5-repro-${process.pid}`;

let ok = true;
const check = (name, pass, detail) => { console.log(`  ${pass ? 'pass' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); if (!pass) ok = false; };

try {
  // launch-seat.sh と同じ形（シェルでセッションを作り send-keys でコマンドを送る）。
  // 直接 `new-session ... sleep 100` で exec させると、pane_pid=sleep のフラットな形になり、
  // 実際の運用（pane_pid=shell、CLI はその子としてforeground実行）を再現しない。
  execFileSync('tmux', ['-S', socket, 'new-session', '-d', '-s', session, '-x', '80', '-y', '20']);
  await new Promise((r) => setTimeout(r, 200));
  execFileSync('tmux', ['-S', socket, 'send-keys', '-t', session, 'sleep 100', 'Enter']);
  await new Promise((r) => setTimeout(r, 300));

  const panePid = tmuxPanePid(socket, session);
  check('pane_pid が取得できる', typeof panePid === 'string' && /^[0-9]+$/.test(panePid), `panePid=${panePid}`);

  // running中は stopped ではない
  check('running中は isPaneProcessStopped=false', isPaneProcessStopped(panePid) === false);

  const tailRunning = execFileSync('tmux', ['-S', socket, 'capture-pane', '-t', session, '-p'], { encoding: 'utf8' });
  check('running中の画面は idle 風（sleepは何も出力しない）', classifyPaneTail(tailRunning) === 'idle');

  // 実際に SIGSTOP が届くのは shell（pane_pid）の子である foreground job（sleep）——
  // suzune実測の「pid===pgid」のもの。shell自体は止めない。
  const psOut = execFileSync('ps', ['-o', 'pid=,ppid=', '-A'], { encoding: 'utf8' });
  const childLine = psOut.split('\n').find((line) => {
    const m = /^\s*(\d+)\s+(\d+)/u.exec(line);
    return m && m[2] === panePid;
  });
  const childPid = childLine ? /^\s*(\d+)/u.exec(childLine)[1] : null;
  check('shellの子(sleep job)が見つかる', childPid !== null, `childPid=${childPid}`);

  // SIGSTOP で停止させる（Lattice の accept hold が attach worker へ送るのと同じ操作）
  execFileSync('kill', ['-STOP', childPid]);
  await new Promise((r) => setTimeout(r, 200));

  const dead = execFileSync('tmux', ['-S', socket, 'list-panes', '-t', session, '-F', '#{pane_dead}'], { encoding: 'utf8' }).trim();
  check('SIGSTOP後もtmux paneは生きている(pane_dead=0)', dead === '0', `pane_dead=${dead}`);

  const tailStopped = execFileSync('tmux', ['-S', socket, 'capture-pane', '-t', session, '-p'], { encoding: 'utf8' });
  check('SIGSTOP後も画面はidle風のまま（欠陥の核心: classifyPaneTailだけではidleと誤判定する）', classifyPaneTail(tailStopped) === 'idle');
  check('SIGSTOP後はisPaneProcessStopped=true（本修正の検出）', isPaneProcessStopped(panePid) === true);

  // SIGCONT で再開すれば stopped ではなくなる
  execFileSync('kill', ['-CONT', childPid]);
  await new Promise((r) => setTimeout(r, 200));
  check('SIGCONT後はisPaneProcessStopped=false（解除も検出できる）', isPaneProcessStopped(panePid) === false);
} finally {
  try { execFileSync('tmux', ['-S', socket, 'kill-session', '-t', session]); } catch {}
  rmSync(socketDir, { recursive: true, force: true });
}

console.log(ok ? 'seat stopped-process repro: green' : 'seat stopped-process repro: RED');
process.exit(ok ? 0 : 1);
