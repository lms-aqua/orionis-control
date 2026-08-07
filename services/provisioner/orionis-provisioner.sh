#!/usr/bin/env bash
#
# The host-side bridge applier.
#
# The gateway needs helper containers to exist — a lostblink and a MediaMTX for
# Blink, a docker-wyze-bridge for Wyze — and must never be able to create them
# itself. It is a phone-facing service and the Docker socket is root-equivalent
# on the host; ADR 0003/0005 refuses that trade, and this is what replaces it.
#
# The gateway writes a small JSON file naming one of the templates in this
# directory. This script reads it, and the only decision it will make on the
# gateway's behalf is *which of those templates* to run. Everything that would
# make provisioning dangerous — the image, the ports, the volumes, the
# environment, the privileges — is fixed in a file that ships in the repository
# and is changed by a human with a commit.
#
# What an administrator who fully controls the app can therefore cause:
#
#   * up to MAX_INSTANCES compose projects, each one an unmodified copy of a
#     template in ./templates
#   * those projects joined to the gateway's Docker network
#   * a Blink or Wyze credential they already typed being written, 0600 and
#     root-owned, to an env file on this host
#
# What they cannot cause: any other image, any bind mount, any port publication,
# any host path, any privileged flag, any change to a container this script did
# not create, and any deletion of a named volume.
#
# Install: see README.md in this directory.

set -euo pipefail

CONFIG_FILE="${ORIONIS_PROVISIONER_CONFIG:-/etc/orionis-provisioner.conf}"

# Defaults, overridable in the config file.
# The gateway's side of the shared volume. Must match CONNECTIONS_PROVISIONING_DIR.
SHARED_DIR="/var/lib/orionis/provisioning"
# Root-only state: the env files holding whatever a bridge needs to sign in.
STATE_DIR="/var/lib/orionis/bridges"
TEMPLATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/templates"
# The container the bridges must be reachable from.
GATEWAY_CONTAINER="orionis-mobile-api"
# Hard ceiling. A loop in the app cannot fill this host with containers.
MAX_INSTANCES=8
# Prefix on every compose project this script owns, so it can recognise its own
# work and never touch anything else running on the host.
PROJECT_PREFIX="orionis-conn-"

# shellcheck source=/dev/null
[ -r "$CONFIG_FILE" ] && . "$CONFIG_FILE"

REQUEST_DIR="$SHARED_DIR/requests"
STATUS_DIR="$SHARED_DIR/status"

log() { printf '%s orionis-provisioner: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }

need() {
  command -v "$1" >/dev/null 2>&1 || {
    log "FATAL: $1 is required but not installed."
    exit 1
  }
}
need docker
need jq

mkdir -p "$REQUEST_DIR" "$STATUS_DIR"
mkdir -p -m 0700 "$STATE_DIR"

# --- validation -------------------------------------------------------------
#
# Everything below treats the request as hostile input. It arrives through a
# shared volume from a network-facing service; "the gateway wrote it" is not a
# reason to trust a string that is about to become a shell argument.

valid_slug() { [[ "$1" =~ ^[a-z0-9][a-z0-9-]{0,39}$ ]]; }
valid_id() { [[ "$1" =~ ^[A-Za-z0-9_-]{1,64}$ ]]; }
# Template names are matched against the files that exist, but the name is
# pattern-checked first so a traversal never reaches the filesystem at all.
valid_template() { [[ "$1" =~ ^[a-z0-9]{1,32}$ ]] && [ -f "$TEMPLATE_DIR/$1.yml" ]; }

# Where a template publishes, as a JSON object of provider setting keys.
#
# This mapping lives here rather than in the request because it is a property of
# the template — the gateway asks for "a lostblink", and what that turns out to
# be addressable as is this script's business.
resolved_settings() {
  local template="$1" instance="$2" host="orionis-${instance}"
  case "$template" in
    lostblink)
      jq -nc --arg h "$host" \
        '{mediamtxApiUrl: "http://\($h)-mediamtx:9997", rtspBaseUrl: "rtsp://\($h)-mediamtx:8554"}'
      ;;
    wyze)
      jq -nc --arg h "$host" \
        '{baseUrl: "http://\($h)-wyze-bridge:5000", streamBaseUrl: "http://\($h)-wyze-bridge:8888"}'
      ;;
    go2rtc)
      jq -nc --arg h "$host" '{baseUrl: "http://\($h)-go2rtc:1984"}'
      ;;
    *)
      echo '{}'
      ;;
  esac
}

# Hands a finished Blink session to a lostblink instance.
#
# lostblink prefers a saved credentials file over an email and password, and
# reads it with blinkpy's `no_prompt=True` — so a complete one means it never
# asks for a verification code at a console nobody is watching. The gateway has
# already done that sign-in through the app; this is what carries the result
# across.
#
# The shape is blinkpy 0.23's `Auth.login_attributes` exactly, and completeness
# is load-bearing: `Auth.startup()` refreshes the token if **any** value is
# None, which would put the instance straight back at a fresh login. `uid` and
# `device_id` are the client identity Blink verified, so even that fallback
# login is recognised rather than challenged.
#
# Built with jq rather than a shell heredoc because the values include an email
# address the operator typed, and a heredoc would let a quote in it write the
# rest of the document.
seed_lostblink_credentials() {
  local project="$1" handover="$2"
  local token tier
  token="$(jq -r '.authToken // ""' <<<"$handover")"
  # No token yet — the connection has been created but not signed in. The
  # instance falls back to email and password, which is the pre-existing
  # behaviour, and a reseed follows as soon as the sign-in completes.
  [ -n "$token" ] || return 1

  tier="$(jq -r '.tier // "rest-prod"' <<<"$handover")"

  # Piped straight into the volume: never written to this host's filesystem, and
  # never passed as an argument where it would show up in `ps`.
  jq -n --argjson h "$handover" --arg tier "$tier" '
      {
        username:   ($h.email // ""),
        password:   ($h.password // ""),
        uid:        ($h.uniqueId // ""),
        device_id:  ($h.deviceIdentifier // "Orionis Control"),
        token:      $h.authToken,
        host:       ($tier + ".immedia-semi.com"),
        region_id:  $tier,
        client_id:  (($h.clientId  // "") | tonumber? // null),
        account_id: (($h.accountId // "") | tonumber? // null),
        user_id:    (($h.userId    // "") | tonumber? // null)
      }' |
    docker run --rm -i -v "${project}_config:/config" busybox:1.36 \
      sh -c 'cat > /config/.cred.json &&
             chmod 600 /config/.cred.json &&
             chown 1000:1000 /config/.cred.json'
}

write_status() {
  local connection_id="$1" request_id="$2" state="$3" message="$4" settings="${5:-null}"
  local target="$STATUS_DIR/$connection_id.json"
  # Atomic, for the same reason the gateway writes atomically: the other side
  # may read at any moment and half a document is worse than a stale one.
  jq -n \
    --arg id "$request_id" \
    --arg connectionId "$connection_id" \
    --arg state "$state" \
    --arg message "$message" \
    --arg updatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson settings "$settings" \
    '{id: $id, connectionId: $connectionId, state: $state, message: $message, updatedAt: $updatedAt}
     + (if $settings == null then {} else {settings: $settings} end)' \
    >"$target.tmp"
  mv -f "$target.tmp" "$target"
}

instance_count() {
  docker compose ls --all --format json 2>/dev/null |
    jq -r '.[].Name' 2>/dev/null |
    grep -c "^${PROJECT_PREFIX}" || true
}

# Joining is done on every pass, not only at creation. The gateway's own
# `compose up` drops any network it did not declare, and re-attaching here is
# what stops a routine redeploy silently disconnecting every bridge.
join_gateway() {
  local network="$1"
  if ! docker network inspect "$network" >/dev/null 2>&1; then
    return 1
  fi
  if docker network inspect "$network" --format '{{range .Containers}}{{.Name}} {{end}}' |
    grep -qw "$GATEWAY_CONTAINER"; then
    return 0
  fi
  docker network connect "$network" "$GATEWAY_CONTAINER"
}

compose() {
  local project="$1" template="$2" env_file="$3"
  shift 3
  ORIONIS_INSTANCE="${project#"$PROJECT_PREFIX"}" \
    docker compose -p "$project" -f "$TEMPLATE_DIR/$template.yml" --env-file "$env_file" "$@"
}

# --- actions ----------------------------------------------------------------

do_create() {
  local connection_id="$1" request_id="$2" template="$3" instance="$4" handover="$5"
  local project="${PROJECT_PREFIX}${instance}"
  local env_file="$STATE_DIR/$instance.env"

  if [ "$(instance_count)" -ge "$MAX_INSTANCES" ] && ! docker compose ls --all --format json |
    jq -e --arg p "$project" 'any(.[]; .Name == $p)' >/dev/null 2>&1; then
    write_status "$connection_id" "$request_id" failed \
      "This host already runs $MAX_INSTANCES bridges, which is its limit."
    return 0
  fi

  write_status "$connection_id" "$request_id" provisioning "Starting the bridge…"

  # The credential the instance signs in with rests here and nowhere else on
  # this host: root-only, and rewritten rather than appended so a re-request
  # cannot leave a stale password behind.
  local previous_umask
  previous_umask="$(umask)"
  umask 0077
  {
    # Host-level defaults first — image tags, mostly — so an instance value
    # written below wins over them.
    [ -r "$STATE_DIR/defaults.env" ] && cat "$STATE_DIR/defaults.env"
    printf 'ORIONIS_INSTANCE=%s\n' "$instance"
    # Keys are constrained to identifier characters and values are quoted, so a
    # value can never become another assignment.
    jq -r 'to_entries[] | select(.key | test("^[A-Za-z][A-Za-z0-9_]*$")) |
           "ORIONIS_" + (.key | ascii_upcase) + "=" + (.value | @sh)' <<<"$handover"
  } >"$env_file"
  umask "$previous_umask"

  if ! compose "$project" "$template" "$env_file" up -d --remove-orphans; then
    write_status "$connection_id" "$request_id" failed \
      "The bridge did not start. Run: docker compose -p $project logs"
    return 0
  fi

  # After `up`, because the volume has to exist; then a restart, because the
  # credentials file is read once at process start. A repeat request that
  # changes nothing else is exactly how a completed sign-in reaches an instance
  # that is already running.
  if [ "$template" = "lostblink" ] && seed_lostblink_credentials "$project" "$handover"; then
    log "seeded a signed-in Blink session into $project"
    compose "$project" "$template" "$env_file" restart lostblink >/dev/null 2>&1 || true
  fi

  if ! join_gateway "${project}_default"; then
    write_status "$connection_id" "$request_id" failed \
      "The bridge started but could not be joined to the gateway's network."
    return 0
  fi

  # `up -d` returning 0 means the containers were created, not that they stayed
  # up. A bridge that needs a verification code exits within seconds with the
  # reason on stdout, and reporting "ready" over the top of that is how someone
  # ends up staring at an empty camera wall with nothing to read.
  local failure
  if failure="$(first_failure "$project")"; then
    write_status "$connection_id" "$request_id" failed "$failure"
    return 0
  fi

  write_status "$connection_id" "$request_id" ready \
    "The bridge is running." "$(resolved_settings "$template" "$instance")"
}

# Names the first long-running container that has already exited, with the last
# thing it said. Returns non-zero — i.e. "no failure" — when they are all up.
first_failure() {
  local project="$1" ids id state exit_code name reason
  # Long enough for a credential or image problem to surface, short enough that
  # the app is not left on "setting up" for a noticeable time when all is well.
  sleep 6
  ids="$(docker compose -p "$project" ps --all --quiet 2>/dev/null || true)"
  [ -n "$ids" ] || {
    echo "The bridge produced no containers."
    return 0
  }

  for id in $ids; do
    state="$(docker inspect -f '{{.State.Status}}' "$id" 2>/dev/null || echo unknown)"
    exit_code="$(docker inspect -f '{{.State.ExitCode}}' "$id" 2>/dev/null || echo 0)"
    name="$(docker inspect -f '{{.Name}}' "$id" 2>/dev/null | sed 's|^/||')"
    # The config sidecar is *supposed* to exit 0.
    [ "$state" = "exited" ] && [ "$exit_code" = "0" ] && continue
    [ "$state" != "exited" ] && [ "$state" != "dead" ] && continue

    reason="$(docker logs --tail 3 "$id" 2>&1 | tr -d '\r' | grep -v '^\s*$' | tail -1)"
    printf '%s stopped (exit %s). %s' "$name" "$exit_code" "${reason:-No output.}"
    return 0
  done
  return 1
}

do_remove() {
  local connection_id="$1" request_id="$2" template="$3" instance="$4"
  local project="${PROJECT_PREFIX}${instance}"
  local env_file="$STATE_DIR/$instance.env"

  write_status "$connection_id" "$request_id" removing "Stopping the bridge…"

  # Detached first: the gateway sits on this network, and compose cannot remove
  # a network that still has an endpoint on it.
  docker network disconnect -f "${project}_default" "$GATEWAY_CONTAINER" >/dev/null 2>&1 || true

  # No `-v`. Removing a source must not destroy whatever it recorded; reclaiming
  # a volume stays a decision someone makes here, with the whole picture.
  if [ -f "$env_file" ]; then
    compose "$project" "$template" "$env_file" down --remove-orphans >/dev/null 2>&1 || true
  else
    docker compose -p "$project" down --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -f "$env_file"

  write_status "$connection_id" "$request_id" removed "The bridge has been stopped."
}

# --- the pass ---------------------------------------------------------------

process_request() {
  local file="$1"
  local payload connection_id request_id template instance action handover

  if ! payload="$(jq -c . <"$file" 2>/dev/null)"; then
    log "ignoring unreadable request $file"
    rm -f "$file"
    return
  fi

  connection_id="$(jq -r '.connectionId // ""' <<<"$payload")"
  request_id="$(jq -r '.id // ""' <<<"$payload")"
  template="$(jq -r '.template // ""' <<<"$payload")"
  instance="$(jq -r '.instance // ""' <<<"$payload")"
  action="$(jq -r '.action // ""' <<<"$payload")"
  handover="$(jq -c '.handover // {}' <<<"$payload")"

  if ! valid_id "$connection_id" || ! valid_id "$request_id"; then
    log "refusing request with an unusable identifier ($file)"
    rm -f "$file"
    return
  fi
  if ! valid_slug "$instance"; then
    write_status "$connection_id" "$request_id" failed "The instance name is not usable."
    rm -f "$file"
    return
  fi
  if ! valid_template "$template"; then
    # The whole security argument rests on this line. A request may only ever
    # name something that already exists in this directory.
    write_status "$connection_id" "$request_id" failed \
      "This host does not have a template called \"$template\"."
    log "refused unknown template '$template' for $connection_id"
    rm -f "$file"
    return
  fi

  # Consumed before acting: the request carries a credential, and a crash
  # mid-run must not leave it readable in the shared volume. The status file is
  # what the gateway reads from here on.
  rm -f "$file"

  case "$action" in
    create) do_create "$connection_id" "$request_id" "$template" "$instance" "$handover" ;;
    remove) do_remove "$connection_id" "$request_id" "$template" "$instance" ;;
    *)
      write_status "$connection_id" "$request_id" failed "Unknown action \"$action\"."
      ;;
  esac
  log "$action $template/$instance for $connection_id done"
}

main() {
  shopt -s nullglob
  for file in "$REQUEST_DIR"/*.json; do
    # One bad request must not stop the others being served.
    process_request "$file" || log "request $file failed: $?"
  done

  # Re-attach anything that has drifted — see join_gateway.
  for project in $(docker compose ls --all --format json 2>/dev/null |
    jq -r '.[].Name' | grep "^${PROJECT_PREFIX}" || true); do
    join_gateway "${project}_default" >/dev/null 2>&1 || true
  done
}

main "$@"
