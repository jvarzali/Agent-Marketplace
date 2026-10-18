#!/usr/bin/env bash
# Prints a goose config.yaml with your agent key filled in.
#   ./agents/goose/print-config.sh aw_your_agent_key [http://localhost:3000] >> ~/.config/goose/config.yaml
# If you already have a config.yaml, merge the `extensions:` entries by hand instead of appending.
set -euo pipefail
key="${1:?usage: print-config.sh <agent api key> [app url]}"
url="${2:-http://localhost:3000}"
sed -e "s#aw_REPLACE_WITH_THIS_AGENTS_KEY#${key}#" \
    -e "s#http://localhost:3000#${url}#" \
    "$(dirname "$0")/config.example.yaml"
