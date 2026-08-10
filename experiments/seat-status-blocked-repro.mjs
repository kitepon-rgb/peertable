#!/usr/bin/env node
// t2(b) 承認待ち(blocked)判定の再現ハーネス。欠陥版（blocked marker を見ない旧ロジック）で
// 落ちることを先に確認してから green を読む（測定器を先に疑う）。
import assert from 'node:assert/strict'

import { classifyPaneTail } from '../skill/scripts/seat-usage.mjs'

// ① 既知ダイアログ文言を含むペイン文字列で blocked が返る
assert.equal(classifyPaneTail('Trust the files in this folder?\n1. Yes, I trust this folder'), 'blocked')
assert.equal(classifyPaneTail('channels warning\n1. I am using this for local development'), 'blocked')
assert.equal(classifyPaneTail('directory trust\n1. Yes, continue'), 'blocked')
assert.equal(classifyPaneTail('rm -rf ./tmp\nDo you want to proceed?'), 'blocked')

// ② `esc to interrupt` が同時に在れば busy が勝つ（承認プロンプトなのに実行中と誤認しない側の確認）
assert.equal(classifyPaneTail('✶ Cogitating… (esc to interrupt)\nDo you want to proceed?'), 'busy')

// ③ どちらも無ければ idle
assert.equal(classifyPaneTail('gpt-5.6-sol high · context 81% left'), 'idle')
assert.equal(classifyPaneTail(''), 'idle')

console.log('seat status blocked repro: 7/7 green')
