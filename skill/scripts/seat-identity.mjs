#!/usr/bin/env node
// pane_pid から Lattice attach 用の pid / lstart / argv を1件に決める。
// POSIX は ps。Windows は Win32_Process（ps -Ao は Git Bash で unknown option -- A）。
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const AGENT = /(?:claude|codex|grok|composer)(?:\.cmd|\.exe)?(?:\s|$)/iu

export function parseWinCreationDate(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error('pid の CreationDate を解釈できない')
    return value.toISOString()
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) throw new Error('pid の CreationDate を解釈できない')
    return parsed.toISOString()
  }
  const text = String(value ?? '').trim()
  const microsoft = /^\/Date\((-?\d+)(?:[+-]\d+)?\)\/$/u.exec(text)
  if (microsoft) return new Date(Number(microsoft[1])).toISOString()
  const parsed = new Date(text)
  if (Number.isNaN(parsed.getTime())) throw new Error(`pid の CreationDate を解釈できない: ${text}`)
  return parsed.toISOString()
}

function posixIdentity(pid) {
  const table = execFileSync('ps', ['-Ao', 'pid=,ppid=,pgid='], { encoding: 'utf8' })
  const leaders = table.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/u.exec(line)
    if (!match) return []
    const [, child, ppid, pgid] = match
    return ppid === String(pid) && child === pgid ? [child] : []
  })
  const chosen = leaders.length === 1 ? leaders[0] : String(pid)
  const started = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', chosen], { encoding: 'utf8' }).trim()
  const argv = execFileSync('/bin/ps', ['-o', 'command=', '-p', chosen], { encoding: 'utf8' }).trim()
  if (!started || !argv) throw new Error('pid の lstart/args を観測できない')
  return { pid: Number(chosen), started_identity: started, argv }
}

function winQuery(filter) {
  const script = `Get-CimInstance Win32_Process -Filter ${JSON.stringify(filter)} | Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress`
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim()
  if (!out) return []
  const parsed = JSON.parse(out)
  return Array.isArray(parsed) ? parsed : [parsed]
}

function winIdentity(pid) {
  const self = winQuery(`ProcessId=${pid}`)[0]
  if (!self) throw new Error('Win32_Process を観測できない')
  const children = winQuery(`ParentProcessId=${pid}`)
  const agentKids = children.filter((row) => AGENT.test(String(row.CommandLine || '')))
  let chosen = self
  if (AGENT.test(String(self.CommandLine || ''))) chosen = self
  else if (agentKids.length === 1) chosen = agentKids[0]
  else if (children.length === 1) chosen = children[0]
  const started = chosen.CreationDate ? parseWinCreationDate(chosen.CreationDate) : ''
  const argv = String(chosen.CommandLine || '').trim()
  if (!started || !argv) throw new Error('pid の CreationDate/CommandLine を観測できない')
  return { pid: Number(chosen.ProcessId), started_identity: started, argv }
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isCli) {
  const panePid = process.argv[2]
  if (!/^\d+$/.test(panePid || '')) {
    console.error('usage: seat-identity.mjs <pane_pid>')
    process.exit(2)
  }
  try {
    const ident = process.platform === 'win32' ? winIdentity(panePid) : posixIdentity(panePid)
    process.stdout.write(`${JSON.stringify(ident)}\n`)
  } catch (error) {
    console.error(error.message || error)
    process.exit(1)
  }
}
