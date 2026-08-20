export function latticeStaffingChanged(previous, next) {
  if (!next || next.error) return false
  if (!previous || previous.error) return true
  return previous.ready !== next.ready || previous.active !== next.active
}

export function addressedToParent(message, parent) {
  return message?.from !== parent
    && (message?.to === 'all' || message?.to === parent
      || (Array.isArray(message?.to_names) && message.to_names.includes(parent)))
}
