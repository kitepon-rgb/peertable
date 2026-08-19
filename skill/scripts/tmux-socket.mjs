#!/usr/bin/env node
import { aitermPsmuxNamespace, resolveTmuxSocket, tmuxArgv, usesPsmuxNamespace } from './seat-usage.mjs'

const result = resolveTmuxSocket(process.env)
if (result.error?.code === 'PEERTABLE_TMUX_SOCKET_AMBIGUOUS' && !usesPsmuxNamespace(process.env)) {
  console.error(`${result.error.code}: ${result.candidates.join(', ')}`)
  process.exit(1)
}
if (process.argv.includes('--prefix')) {
  console.log(tmuxArgv([], { socket: result.socket }).join(' '))
} else if (process.argv.includes('--namespace')) {
  console.log(usesPsmuxNamespace(process.env) ? aitermPsmuxNamespace(process.env) : '')
} else if (process.argv.includes('--source')) {
  console.log(usesPsmuxNamespace(process.env) ? 'psmux-namespace' : result.source)
} else if (usesPsmuxNamespace(process.env)) {
  console.log(aitermPsmuxNamespace(process.env))
} else {
  console.log(result.socket)
}
