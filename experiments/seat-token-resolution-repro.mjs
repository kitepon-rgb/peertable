#!/usr/bin/env node
// 書込トークン解決の再現ハーネス。欠陥版（`process.env.PEERTABLE_POST_TOKEN ?? ''` に丸投げする
// 旧ロジック）で落ちることを先に確認してから green を読む（測定器を先に疑う）。
//
// 固定する実害: 2026-08-10、`~/.config/peertable.env` に `export` が無かったため、それを `source`
// した shell から `nohup node seat-status-bridge.mjs` で起こした常駐がトークンを持たず、
// **4時間 HTTP 403 を撃ち続けた**。参加者一覧には点が1つも出ず、「ブリッジを起こしていない」と
// 見分けがつかなかった。旧ロジックはここで返る値が '' になり、③④が落ちる。
import assert from 'node:assert/strict'

import { decideBridgeContinuation, parsePostTokenEnvFile, resolvePostToken } from '../skill/scripts/seat-usage.mjs'

// ① `export` 付き（正しく書かれた設定ファイル）
assert.equal(parsePostTokenEnvFile('export PEERTABLE_POST_TOKEN=abc123\n'), 'abc123')

// ② `export` 無し —— **今回の実害の形**。ここが null を返すと bridge は無トークンで常駐する
assert.equal(parsePostTokenEnvFile('PEERTABLE_POST_TOKEN=abc123\n'), 'abc123')

// ③ 引用符つき・前後の空白・他の行が混ざっていても拾う
assert.equal(parsePostTokenEnvFile('# comment\nexport PEERTABLE_POST_TOKEN="q u o t e d"\nOTHER=1\n'), 'q u o t e d')
assert.equal(parsePostTokenEnvFile("  PEERTABLE_POST_TOKEN='single'  \n"), 'single')

// ④ 無い・空・非文字列は null（**空文字を「トークンがある」と読ませない**）
assert.equal(parsePostTokenEnvFile('OTHER=1\n'), null)
assert.equal(parsePostTokenEnvFile('PEERTABLE_POST_TOKEN=\n'), null)
assert.equal(parsePostTokenEnvFile(null), null)

// ⑤ 名前の前方一致で誤爆しない（別変数を拾わない）
assert.equal(parsePostTokenEnvFile('PEERTABLE_POST_TOKEN_OLD=zzz\n'), null)

// ⑥ env が在ればそれが勝つ（設定ファイルを読みに行かない）
assert.equal(resolvePostToken({ PEERTABLE_POST_TOKEN: 'from-env', HOME: '/nonexistent' },
  () => { throw new Error('env があるのに設定ファイルを読んだ') }), 'from-env')

// ⑦ env が空なら設定ファイルへ落ちる —— **旧ロジックはここで '' を返していた**
assert.equal(resolvePostToken({ HOME: '/home/x' }, () => 'PEERTABLE_POST_TOKEN=from-file\n'), 'from-file')

// ⑧ どちらも無ければ空文字（黙って偽のトークンを作らない）
assert.equal(resolvePostToken({ HOME: '/home/x' }, () => null), '')

// ⑨ 設定ファイルの path は launch-seat.sh:25-27 と同じ（規則を二重に書かない）
let seen = null
resolvePostToken({ HOME: '/home/x' }, path => { seen = path; return null })
assert.equal(seen, '/home/x/.config/peertable.env')

// ⑩ 送るものが無い tick は失敗ではない（席がまだ立っていない卓・setup 直後に起こした場合）。
//    **ここを failure と数えると、席が立つ前に常駐が死ぬ**
const idle = decideBridgeContinuation({ attempted: 0, failed: 0, provenWritable: false, failedTicks: 0, limit: 10 })
assert.equal(idle.verdict, 'idle')
assert.equal(idle.provenWritable, false)

// ⑪ 一度も書けていないまま全件失敗 → 常駐に入らせない（今回の403の形。席が0でない最初の送信で発火する）
assert.equal(decideBridgeContinuation({ attempted: 3, failed: 3, provenWritable: false, failedTicks: 0, limit: 10 }).verdict,
  'write_denied')

// ⑫ 一度でも書けたら provenWritable が立ち、失敗カウンタは戻る
const ok = decideBridgeContinuation({ attempted: 3, failed: 1, provenWritable: false, failedTicks: 7, limit: 10 })
assert.equal(ok.verdict, 'ok')
assert.equal(ok.provenWritable, true)
assert.equal(ok.failedTicks, 0)

// ⑬ 一度書けた後の全件失敗は degraded（即死させない）→ limit で unreachable
assert.equal(decideBridgeContinuation({ attempted: 2, failed: 2, provenWritable: true, failedTicks: 0, limit: 10 }).verdict,
  'degraded')
assert.equal(decideBridgeContinuation({ attempted: 2, failed: 2, provenWritable: true, failedTicks: 9, limit: 10 }).verdict,
  'unreachable')

console.log('seat token resolution repro: 19/19 green')
