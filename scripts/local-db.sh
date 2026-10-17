#!/usr/bin/env bash
# Starts/stops a throwaway local PostgreSQL cluster in ./.pgdata on port 54329.
# Uses your installed postgres binaries (brew install postgresql@16), or use docker-compose.yml instead.
set -euo pipefail
cd "$(dirname "$0")/.."
PGDATA="$PWD/.pgdata"
PORT="${PGPORT:-54329}"
case "${1:-start}" in
  start)
    if [ ! -d "$PGDATA" ]; then
      initdb -D "$PGDATA" -U postgres --auth=trust >/dev/null
    fi
    if ! pg_ctl -D "$PGDATA" status >/dev/null 2>&1; then
      pg_ctl -D "$PGDATA" -o "-p $PORT -k $PGDATA" -l "$PGDATA/server.log" -w start >/dev/null
    fi
    for db in agent_wallet agent_wallet_test; do
      psql -h localhost -p "$PORT" -U postgres -tc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1 \
        || psql -h localhost -p "$PORT" -U postgres -c "CREATE DATABASE $db" >/dev/null
    done
    echo "postgres running on localhost:$PORT (databases: agent_wallet, agent_wallet_test)"
    ;;
  stop)
    pg_ctl -D "$PGDATA" stop >/dev/null && echo "stopped"
    ;;
  *)
    echo "usage: $0 [start|stop]"; exit 1;;
esac
