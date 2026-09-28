#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
session="cat-park-dev"
case "${1:-status}" in
  start) tmux has-session -t "$session" 2>/dev/null || tmux new-session -d -s "$session" -c "$project_root" 'npm start' ;;
  stop) tmux has-session -t "$session" 2>/dev/null && tmux kill-session -t "$session" || true ;;
  restart) "$0" stop; "$0" start ;;
  status) tmux has-session -t "$session" 2>/dev/null && echo running || echo stopped ;;
  attach) exec tmux attach -t "$session" ;;
  health) curl --fail --silent http://127.0.0.1:3000/api/health ;;
  *) echo 'usage: tmux-dev-manager.sh start|stop|restart|status|attach|health' >&2; exit 2 ;;
esac
