#!/usr/bin/env node
import { resolveTmuxSocket } from './seat-usage.mjs'

const result = resolveTmuxSocket(process.env)
if (result.error?.code === 'PEERTABLE_TMUX_SOCKET_AMBIGUOUS') {
  console.error(`${result.error.code}: ${result.candidates.join(', ')}`)
  process.exit(1)
}
if (process.argv.includes('--source')) console.log(result.source)
else console.log(result.socket)
