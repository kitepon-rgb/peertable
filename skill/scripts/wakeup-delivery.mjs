import { classifyPaneTail } from './seat-usage.mjs'

export const BROADCAST_RECIPIENT = 'all'
export const ROOM_UPDATE_FALLBACK =
  'room全体の状況が更新された。room.read_logで部屋を読み、状況を把握して次の行動を判断する。'

export function collapseWakeBody(body) {
  return String(body ?? '').replace(/\s*\n+\s*/gu, ' / ')
}

export function formatWakeNotice(msg) {
  const audience = Array.isArray(msg.to_names) ? msg.to_names.join(', ') : msg.to
  const body = collapseWakeBody(msg.body)
  if (msg.to === BROADCAST_RECIPIENT) {
    return body
      ? `[Peertable #${msg.seq}] ${msg.from} → ${BROADCAST_RECIPIENT}: ${body}`
      : `[Peertable #${msg.seq}] ${ROOM_UPDATE_FALLBACK}`
  }
  return `[Peertable DM #${msg.seq}] ${msg.from} → ${audience}: ${body}`
}

/** 親番犬と tmux を持たない member は通常席 bridge の宛先にしない。 */
export function isWakeupBridgeTarget(member) {
  if (!member || typeof member.name !== 'string' || member.name.length === 0) return false
  if (member.delivery?.kind === 'parent_watch') return false
  if (member.observe === null) return false
  const observe = member.observe
  if (!observe || typeof observe !== 'object' || typeof observe.tmux_target !== 'string' || !observe.tmux_target) {
    return false
  }
  return true
}

/** Grok 既定はキュー投入。busy 中に積むと今のターンへ混ざらない。 */
export function shouldDeferGrokWake(vendor, tail) {
  if (vendor !== 'grok') return false
  if (typeof tail !== 'string') return false
  if (classifyPaneTail(tail) === 'busy') return true
  if (tail.includes('send a message to interrupt')) return true
  return tail.includes('Enter:send now') && /#\d+\s+\[/u.test(tail)
}
