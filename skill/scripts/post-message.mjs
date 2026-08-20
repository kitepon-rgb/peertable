#!/usr/bin/env node
// room へ送る JSON を UTF-8 で出す。python stdout の cp932 は日本語本文を壊す。
const [from, to, ...rest] = process.argv.slice(2)
const body = rest.join('\n')
if (!from || !to || body.length === 0) {
  process.stderr.write('usage: post-message.mjs <from> <to> <body>\n')
  process.exit(2)
}
process.stdout.write(`${JSON.stringify({ from, to, body })}\n`)
