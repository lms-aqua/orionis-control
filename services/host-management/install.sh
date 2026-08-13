#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
guard_root="${ORIONIS_GUARD_ROOT:-/home/appbox/apps/orionis-guard}"
hls_root="${ORIONIS_HLS_ROOT:-/home/appbox/apps/orionis-hls}"

install -d -m 0755 "$guard_root/scripts" "$guard_root/go2rtc" "$hls_root"
install -m 0755 "$root/scrypted/sync-go2rtc-from-scrypted.mjs" \
  "$guard_root/scripts/sync-go2rtc-from-scrypted.mjs"
install -m 0644 "$root/scrypted/log-redaction.mjs" "$guard_root/scripts/log-redaction.mjs"
install -m 0644 "$root/hls/mediamtx.yml" "$hls_root/mediamtx.yml"

if [[ ! -e "$guard_root/go2rtc/go2rtc.yaml" ]]; then
  install -m 0644 "$root/scrypted/go2rtc.yaml" "$guard_root/go2rtc/go2rtc.yaml"
fi
