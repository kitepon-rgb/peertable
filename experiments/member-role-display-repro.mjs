#!/usr/bin/env node
// 着座メンバー一覧の素性行に role が出ない退行を止める。
// 役割は launch-seat / client が member 欄へ既に載せている。表示だけが vendor / model / effort
// に閉じていると、ホバーと着席ログの読み口が食い違う。
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(process.argv[2] ?? new URL('../room/server.mjs', import.meta.url), 'utf8')

assert.match(
  source,
  /const MEMBER_EVENT_FIELDS = \['status', 'busy_since', 'vendor', 'model', 'effort', 'role'\]/,
  'role 変更は閲覧者が気づく欄として SSE に載る',
)
assert.match(
  source,
  /const idParts=\[m\.vendor,m\.model,m\.effort,m\.role\]\.filter\(Boolean\)/,
  '素性行は vendor / model / effort / role を同じ1行へ畳む',
)

console.log('member role display repro: green')
