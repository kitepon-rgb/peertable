# sourced by launch-seat / leave-seat / teardown / ensure-bridge / change-seat
# POSIX は tmux -S <sock>。Windows psmux は -L <aiterm-ns>（-S は既定 namespace へ落ちる）。
_peertable_tmux_scripts=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
tmux_at() {
  local prefix
  prefix=$(node "$_peertable_tmux_scripts/tmux-socket.mjs" --prefix) || return 1
  # shellcheck disable=SC2206
  local -a conn=($prefix)
  command tmux "${conn[@]}" "$@"
}
