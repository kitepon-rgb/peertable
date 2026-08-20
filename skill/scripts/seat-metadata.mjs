#!/usr/bin/env node
// 着席 metadata を UTF-8 JSON で出す。python stdout の cp932 経由は日本語 roles を壊す。
const [name, vendor, model, effort, sock, sess, rolesRaw, mission, aitermSessionId, tmuxNs] = process.argv.slice(2)
const roles = String(rolesRaw || '').split(',').map((item) => item.trim()).filter(Boolean)
const settings = { vendor, model }
if (effort) settings.effort = effort
const observe = { tmux_socket: sock, tmux_target: sess }
if (tmuxNs) observe.tmux_namespace = tmuxNs
const body = {
  name,
  vendor,
  model,
  role: roles[0] || '',
  roles,
  settings,
  aiterm_session_id: aitermSessionId,
  observe,
}
if (effort) body.effort = effort
if (mission) body.mission = mission
process.stdout.write(`${JSON.stringify(body)}\n`)
