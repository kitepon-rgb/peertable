#!/usr/bin/env node
import assert from 'node:assert/strict'
import { parseWinCreationDate } from '../skill/scripts/seat-identity.mjs'

assert.equal(parseWinCreationDate('/Date(1787183412912)/'), new Date(1787183412912).toISOString())
assert.equal(parseWinCreationDate(1787183412912), new Date(1787183412912).toISOString())
assert.equal(
  parseWinCreationDate('2026-08-20T00:00:00.000Z'),
  '2026-08-20T00:00:00.000Z',
)
assert.throws(() => parseWinCreationDate('not-a-date'), /CreationDate を解釈できない/)
assert.throws(() => new Date('/Date(1787183412912)/').toISOString(), /Invalid time value/)

console.log('seat-identity win date: 5/5 green')
