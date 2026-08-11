#!/usr/bin/env node
import assert from 'node:assert/strict'
import { defaultTmuxSocket, resolveTmuxSocket } from '../skill/scripts/seat-usage.mjs'

const probe = sockets => ({
  serverAlive: socket => sockets.includes(socket),
  listAitermSockets: () => sockets,
})

assert.equal(defaultTmuxSocket({}), '/tmp/claude-tmux-sockets/claude.sock')
assert.equal(defaultTmuxSocket({ TMPDIR: '' }), '/tmp/claude-tmux-sockets/claude.sock')
assert.equal(resolveTmuxSocket({ PEERTABLE_TMUX_SOCKET: '/custom.sock' }, probe([])).socket, '/custom.sock')
assert.deepEqual(resolveTmuxSocket({}, probe(['/tmp/aiterm-one.sock'])), {
  socket: '/tmp/aiterm-one.sock', source: 'discovered', candidates: ['/tmp/aiterm-one.sock'], error: null,
})
const ambiguous = resolveTmuxSocket({}, probe(['/tmp/aiterm-one.sock', '/tmp/aiterm-two.sock']))
assert.equal(ambiguous.socket, null)
assert.equal(ambiguous.error.code, 'PEERTABLE_TMUX_SOCKET_AMBIGUOUS')
assert.deepEqual(ambiguous.candidates, ['/tmp/aiterm-one.sock', '/tmp/aiterm-two.sock'])
assert.equal(resolveTmuxSocket({}, probe([])).socket, '/tmp/claude-tmux-sockets/claude.sock')

console.log('seat socket discovery repro: 7/7 green')
