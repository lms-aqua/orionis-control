# Host-managed camera pipeline

These files are the repository source of truth for the host services that sit
outside the phone-facing gateway container. They intentionally contain no
camera names, credentials, internal addresses, or dynamic Scrypted stream
hashes.

- `scrypted/go2rtc.yaml` is the empty, safe baseline for a new go2rtc hub.
- `scrypted/sync-go2rtc-from-scrypted.mjs` discovers current Scrypted streams,
  preserves streams owned by connection bridges, writes atomically, and
  restarts go2rtc only when its owned streams changed.
- `hls/mediamtx.yml` creates HLS paths on demand. Numeric Scrypted ids select
  the generated `_aac` rendition; bridge-owned names pass through unchanged.

`install.sh` updates the live scripts and HLS configuration. It installs the
go2rtc baseline only when no config exists, because overwriting a live config
would erase runtime registrations. Run the sync once after a first install.
