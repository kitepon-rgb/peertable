#!/usr/bin/env node
// f1: seat-status-bridge が tmux ソケットを渡さず全席を dead 誤判定していた欠陥の再現ハーネス。
// 2026-08-10 bell 実測: 立てたばかりの3席すべてが status=dead で本番へ保存された
// （`grep -c socket skill/scripts/seat-status-bridge.mjs` が0件だったのが根本原因）。
// 欠陥版で落ちることを先に確認してから green を読む（測定器を先に疑う）。
import assert from 'node:assert/strict'

import { deriveMissingSession, resolveTmuxSocket } from '../skill/scripts/seat-usage.mjs'

// (a) socket 解決が launch-seat.sh:14 と同じ規則になっている
assert.equal(
  resolveTmuxSocket({ PEERTABLE_TMUX_SOCKET: '/custom/claude.sock', TMPDIR: '/tmp/' }),
  '/custom/claude.sock',
)
assert.equal(
  resolveTmuxSocket({ TMPDIR: '/tmp/' }),
  '/tmp/claude-tmux-sockets/claude.sock',
)

// (b) 席でない member（tmux セッションを一度も持たない＝ previous が undefined）は観測しない
assert.equal(deriveMissingSession(undefined), null)

// (c) 過去に観測できていた席（busy/idle で送信済み＝ previous が在る）が消えたら実際に dead
assert.deepEqual(
  deriveMissingSession({ status: 'idle', busySince: null, at: 0 }),
  { status: 'dead', busySince: null, paneTokenHint: null },
)

console.log('seat status socket repro: 4/4 green')
