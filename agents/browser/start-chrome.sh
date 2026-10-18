#!/usr/bin/env bash
# Starts the agent's shopping browser: Google Chrome with its own profile and remote debugging
# on 127.0.0.1:9222. The agent drives it (Playwright MCP with --cdp-endpoint), and the wallet
# connects to the same browser to type approved cards into the checkout page.
#
#   ./agents/browser/start-chrome.sh            (leave it running while the agent shops)
#
# The profile is separate from your everyday Chrome. Card saving and address/card autofill are
# turned off in it, so the only card the agent can pay with is the one the wallet enters.
set -euo pipefail
port="${AGENT_BROWSER_PORT:-9222}"
profile="${AGENT_BROWSER_PROFILE:-$HOME/.paysafe/chrome-profile}"
chrome="${CHROME_PATH:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

if curl -fs "http://127.0.0.1:${port}/json/version" >/dev/null 2>&1; then
  echo "The shopping browser is already running on port ${port}."
  exit 0
fi
if [ ! -x "$chrome" ]; then
  echo "Google Chrome not found at: $chrome" >&2
  echo "Install Chrome, or set CHROME_PATH to its binary." >&2
  exit 1
fi

# Profiles made before the rename to PaySafe lived in ~/.agent-wallet; move it so logins carry over.
legacy="$HOME/.agent-wallet/chrome-profile"
if [ -z "${AGENT_BROWSER_PROFILE:-}" ] && [ ! -e "$profile" ] && [ -d "$legacy" ]; then
  mkdir -p "$(dirname "$profile")"
  mv "$legacy" "$profile"
  echo "Moved your shopping profile from $legacy to $profile."
fi

if [ ! -f "$profile/Default/Preferences" ]; then
  mkdir -p "$profile/Default"
  cat > "$profile/Default/Preferences" <<'JSON'
{"autofill":{"credit_card_enabled":false,"profile_enabled":false},"credentials_enable_service":false,"payments":{"can_make_payment_enabled":false}}
JSON
fi

echo "Starting the shopping browser (profile: $profile, debugging on 127.0.0.1:${port})."
echo "Keep this window open while the agent shops. Close Chrome's window to stop it."
exec "$chrome" \
  --remote-debugging-port="$port" \
  --remote-debugging-address=127.0.0.1 \
  --user-data-dir="$profile" \
  --no-first-run \
  --no-default-browser-check \
  about:blank
