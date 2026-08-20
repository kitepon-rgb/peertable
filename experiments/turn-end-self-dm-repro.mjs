#!/usr/bin/env node
// 席がターン終了時に自己DMを出さないと idle で固まる。
// 原因は member.md だけに書いて MCP の毎回見える面（instructions / post description）に無かったこと。
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const client = readFileSync(join(REPO, 'room/client.mjs'), 'utf8')
const member = readFileSync(join(REPO, 'skill/templates/member.md'), 'utf8')

assert.match(client, /\[次の行動\]/)
assert.match(client, /post\(to: "\$\{ME\}"/)
assert.match(client, /ターンを終える直前に必ず post/)
assert.match(client, /ターン終了時は to を自分の名前/)
assert.match(member, /ターンを終える直前に `post\(to: "<自分の名前>"/)

console.log('turn-end-self-dm-repro: ok')
