#!/usr/bin/env node
// 席の書込credentialを、秘密値をargv/envへ載せず作成・利用・撤去する境界。
import { createHash } from 'node:crypto'
import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { parsePostTokenEnvFile } from './seat-usage.mjs'

const fail = (code, message) => {
  process.stderr.write(`${code}: ${message}\n`)
  process.exit(1)
}

const credentialRoot = project => resolve(project, '.team', 'credentials')
const memberKey = member => createHash('sha256').update(member).digest('hex').slice(0, 12)
const credentialPath = (project, room, member) => {
  const roomKey = createHash('sha256').update(room).digest('hex').slice(0, 12)
  return join(credentialRoot(project), `${memberKey(member)}-${roomKey}.token`)
}

const assertOwnedPath = (project, path) => {
  const root = credentialRoot(project)
  const target = resolve(path)
  const rel = relative(root, target)
  if (!rel || rel.startsWith('..') || rel.includes('/../'))
    fail('SEAT_CREDENTIAL_PATH_INVALID', 'credential pathが対象projectの所有範囲外')
  return { root, target }
}

const readCredential = path => {
  let token
  try { token = readFileSync(path, 'utf8').trim() } catch {
    fail('SEAT_CREDENTIAL_UNREADABLE', 'credential fileを読めない')
  }
  if (!token) fail('SEAT_CREDENTIAL_INVALID', 'credential fileが空')
  return token
}

const [action, ...args] = process.argv.slice(2)
switch (action) {
  case 'path': {
    const [project, room, member] = args
    if (!project || !room || !member) fail('SEAT_CREDENTIAL_ARGS_INVALID', 'path <project> <room> <member>')
    process.stdout.write(credentialPath(project, room, member) + '\n')
    break
  }
  case 'prepare': {
    const [project, room, member] = args
    if (!project || !room || !member) fail('SEAT_CREDENTIAL_ARGS_INVALID', 'prepare <project> <room> <member>')
    const source = process.env.PEERTABLE_TOKEN_SOURCE_FILE
      || join(process.env.HOME || homedir(), '.config', 'peertable.env')
    let sourceText
    try { sourceText = readFileSync(source, 'utf8') } catch {
      fail('SEAT_CREDENTIAL_SOURCE_UNREADABLE', '書込トークン設定fileを読めない')
    }
    const token = parsePostTokenEnvFile(sourceText)
    if (!token) fail('SEAT_CREDENTIAL_TOKEN_MISSING', '書込トークン設定fileに値が無い')

    const root = credentialRoot(project)
    mkdirSync(root, { recursive: true, mode: 0o700 })
    chmodSync(root, 0o700)
    const target = credentialPath(project, room, member)
    for (const entry of readdirSync(root)) {
      if (entry.startsWith(`${memberKey(member)}-`) && entry.endsWith('.token') && join(root, entry) !== target)
        unlinkSync(join(root, entry))
    }
    const temporary = join(root, `.${process.pid}.${Date.now()}.tmp`)
    let fd
    try {
      fd = openSync(temporary, 'wx', 0o600)
      writeFileSync(fd, token + '\n', 'utf8')
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      chmodSync(temporary, 0o600)
      renameSync(temporary, target)
      chmodSync(target, 0o600)
    } catch (error) {
      if (fd !== undefined) closeSync(fd)
      if (existsSync(temporary)) unlinkSync(temporary)
      fail('SEAT_CREDENTIAL_PREPARE_FAILED', error.message)
    }
    process.stdout.write(target + '\n')
    break
  }
  case 'request': {
    const [credential, method, url, body = ''] = args
    if (!credential || !method || !url) fail('SEAT_CREDENTIAL_ARGS_INVALID', 'request <credential> <method> <url> [json-body]')
    const token = readCredential(credential)
    let response
    try {
      response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Peertable-Token': token },
        ...(body ? { body } : {}),
      })
    } catch {
      fail('SEAT_CREDENTIAL_REQUEST_UNREACHABLE', 'roomへ到達できない')
    }
    const responseBody = await response.text()
    if (!response.ok) fail('SEAT_CREDENTIAL_REQUEST_FAILED', `HTTP ${response.status}`)
    process.stdout.write(responseBody)
    break
  }
  case 'remove': {
    const [project, path] = args
    if (!project || !path) fail('SEAT_CREDENTIAL_ARGS_INVALID', 'remove <project> <credential>')
    const { root, target } = assertOwnedPath(project, path)
    if (existsSync(target)) unlinkSync(target)
    if (existsSync(root) && readdirSync(root).length === 0) rmdirSync(root)
    break
  }
  default:
    fail('SEAT_CREDENTIAL_ARGS_INVALID', 'prepare|path|request|remove を指定する')
}
