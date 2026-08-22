export function latticeStaffingChanged(previous, next) {
  if (!next || next.error) return false
  if (!previous || previous.error) return true
  return previous.ready !== next.ready || previous.active !== next.active
}

const STATUS_LABEL = { busy: '作業中', blocked: '承認待ち', idle: '待機', dead: '停止' }

// 「工程があるのに作業中の席が1つも無い」が holdMs 続いたら1回だけ警報を出す。
// observation: { ready, active, workers: [{name, status}] }（membersを読めた時だけ渡す）
// previous: 保存済み stall 状態（{ since, alerted } | null | undefined）
// 返り値: { stall, event }。event が非null なら親へ届ける。
export function tableStallUpdate(previous, observation, nowMs, holdMs) {
  if (!observation) return { stall: previous ?? null, event: null }
  const { ready, active, workers } = observation
  const workExists = ready + active > 0
  const anyoneBusy = workers.some(w => w.status === 'busy')
  if (!workExists || anyoneBusy) return { stall: null, event: null }
  const since = previous?.since ?? nowMs
  const alerted = previous?.alerted === true
  if (alerted || nowMs - since < holdMs) {
    return { stall: { since, alerted }, event: null }
  }
  const seatList = workers.length === 0
    ? '席が1つもありません'
    : workers.map(w => `${w.name}=${STATUS_LABEL[w.status] ?? w.status ?? '未報告'}`).join('、')
  return {
    stall: { since, alerted: true },
    event: {
      type: 'parent_table_stalled',
      ready,
      active,
      workers,
      body: `警報: 着手可能 ${ready} 件・着手中 ${active} 件の工程があるのに、作業中の席が1つもありません`
        + `（${Math.round(holdMs / 60000)}分継続）。席: ${seatList}。各席の状態を確認して動かしてください。`,
    },
  }
}

export function addressedToParent(message, parent) {
  return message?.from !== parent
    && (message?.to === 'all' || message?.to === parent
      || (Array.isArray(message?.to_names) && message.to_names.includes(parent)))
}
