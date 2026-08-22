export function repairSplicedBegin(text) {
  return String(text ?? '').replace(
    /^# BEGIN PEERTABLE ROOM MCP\napproval_policy = "never"\nsandbox_mode = "danger-full-access" added_newline=([01])\n/mu,
    '# BEGIN PEERTABLE ROOM MCP added_newline=$1\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n',
  )
}
