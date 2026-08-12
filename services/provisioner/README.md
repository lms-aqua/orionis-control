# Bridge provisioning

Some camera sources are not systems you point at. Blink speaks its own
transports and needs a **lostblink** translating them into RTSP; Wyze has no
supported local API and needs **docker-wyze-bridge**. Before this, adding one of
those meant leaving the app, standing a container up by hand, working out what
it was addressable as, and typing that back in — and the Blink form would not
even let you save until you had.

This directory is what replaced that. The gateway asks; a privileged unit on the
host acts.

It lives under `services/` rather than `deploy/` on purpose: `deploy/` is
gitignored local staging, and the entire security argument below rests on the
templates being **version-controlled files changed by a commit**. A template that
could be edited on the host without review would make "an administrator can only
start one of N vetted things" mean nothing.

```
App              "Add Blink" → email + password
  │
Gateway          writes /var/lib/orionis/provisioning/requests/<connection>.json
  │              (no Docker socket, no shell, no choice of image)
  │
This unit        validates the request against the templates in ./templates
  │              docker compose -p orionis-conn-<instance> up -d
  │              joins the gateway's network
  │              writes .../status/<connection>.json
  │
Gateway          reads the status, fills in the addresses itself
```

## Why a systemd unit and not a container

The gateway must never hold the Docker socket. It is phone-facing, and the
socket is root-equivalent on the host — the same reasoning that made retention
changes a request file instead of an in-process action (ADR 0003/0005).

Shipping the applier as a container with the socket mounted would have been
easier, but it puts a root-equivalent capability on a Docker network, one
container escape away from a service that talks to the internet. As a systemd
unit the socket is never on a network at all. The cost is an install step; the
install step is below.

## What an administrator can actually cause

Worth stating exactly, because this is the piece that carries the risk. Someone
with full control of the app — or of a compromised gateway — can cause:

* up to `MAX_INSTANCES` (default 8) compose projects to exist, each an
  **unmodified** copy of a file in `./templates`
* those projects to be joined to the gateway's Docker network
* a credential they already typed to be written, `0600` and root-owned, to
  `/var/lib/orionis/bridges/<instance>.env`

They cannot cause: any other image, any bind mount, any host path, any published
port, any privileged flag, any environment variable the template does not
declare, any change to a container this script did not create, or the removal of
a named volume. The request names a template; it does not describe one. The
template is a file in this repository, changed by a commit.

The two lines that carry that guarantee are `valid_template` (a request may only
name something that already exists here) and the fact that every value
interpolated into compose comes from `${ORIONIS_INSTANCE}` or the handover map,
both of which are pattern-checked before they are written.

## Install

Run from a checkout, in this directory — `cd orionis-control/services/provisioner`.
Reinstall from the same place after pulling, so the host's templates stay the
ones in `main`.

```bash
sudo install -d -m 0755 /usr/local/lib/orionis
sudo install -m 0755 orionis-provisioner.sh /usr/local/lib/orionis/
sudo cp -r templates /usr/local/lib/orionis/
sudo install -d -m 0700 /var/lib/orionis/bridges
sudo install -d -m 0755 /var/lib/orionis/provisioning
sudo install -d -m 0777 /var/lib/orionis/provisioning/requests
sudo install -d -m 0755 /var/lib/orionis/provisioning/status
```

The gateway runs as a non-root user inside its container and must be able to
write requests and read status. Match the ownership to whatever your gateway
container runs as rather than leaving `requests` world-writable:

```bash
sudo chown -R 1000:1000 /var/lib/orionis/provisioning
sudo chmod 0700 /var/lib/orionis/provisioning/requests
```

Configure the applier:

```bash
sudo tee /etc/orionis-provisioner.conf >/dev/null <<'CONF'
SHARED_DIR=/var/lib/orionis/provisioning
STATE_DIR=/var/lib/orionis/bridges
TEMPLATE_DIR=/usr/local/lib/orionis/templates
GATEWAY_CONTAINER=orionis-mobile-api
MAX_INSTANCES=8
CONF
```

Image tags the templates default to can be overridden per host:

```bash
sudo tee /var/lib/orionis/bridges/defaults.env >/dev/null <<'CONF'
ORIONIS_LOSTBLINK_IMAGE=lostblink:local
ORIONIS_WYZE_IMAGE=mrlt8/wyze-bridge:latest
ORIONIS_GO2RTC_IMAGE=alexxit/go2rtc:1.9.9
CONF
```

`lostblink` has no published image — its repository is private and this script
holds no credentials on purpose. Build it once on the host:

```bash
git clone git@github.com:lms-aqua/lostblink.git /opt/lostblink
docker build -t lostblink:local /opt/lostblink
```

**The image must ship blinkpy 0.25.9 or newer.** Blink retired the old
`/api/v5/account/login` endpoint — it answers HTTP 426 "an app update is
required" to force old clients off — and moved sign-in to OAuth2 with PKCE.
blinkpy speaks that from 0.25.0; anything older cannot log in to Blink at all,
whatever this gateway hands it. Check what a built image actually contains:

```bash
docker run --rm --entrypoint python lostblink:local \
  -c 'import importlib.metadata as m; print(m.version("blinkpy"))'
```

The credential file described below is written in that version's shape, so the
two move together: bumping blinkpy in the lostblink image is not independent of
this repository.

Enable the units:

```bash
sudo cp orionis-provisioner.service orionis-provisioner.timer orionis-provisioner.path /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now orionis-provisioner.timer orionis-provisioner.path
```

Point the gateway at the shared directory — in its `.env`:

```
CONNECTIONS_PROVISIONING_DIR=/provisioning
CONNECTIONS_MAX_BRIDGES=8
```

and mount it in `docker-compose.yml`, alongside the retention directory that
works the same way:

```yaml
    volumes:
      - /var/lib/orionis/provisioning:/provisioning
```

Without `CONNECTIONS_PROVISIONING_DIR` the gateway reports provisioning as
unavailable and the app hides the button, rather than offering something that
can only fail.

## Operating it

```bash
# What it did last
journalctl -u orionis-provisioner.service -n 50

# What is running
docker compose ls --all | grep orionis-conn-

# One bridge's logs
docker compose -p orionis-conn-<instance> logs -f
```

A failed request leaves a `failed` status the app displays verbatim, including
the last line the container printed. That is usually the whole diagnosis —
a missing image, a rejected password, or Blink asking for a verification code.

## Removing a bridge

Removing the source in the app queues a teardown; the applier stops the project
and deletes the env file. **Named volumes are never removed**, here or anywhere
else in this flow: a bridge's recorded data is not the gateway's to destroy.
Reclaim them deliberately when you mean to:

```bash
docker volume ls | grep orionis-conn-<instance>
docker volume rm orionis-conn-<instance>_working
```

## Blink's second factor, and why there is no second one

Blink binds a verification code to a **client identity**, not to an account. Left
alone, a provisioned `lostblink` would introduce itself as a stranger, be mailed
its own code, and exit with `two-factor authentication required. Run 'lostblink
auth' once from a terminal` — at a console nobody is watching. That is the
failure the in-app code step exists to replace, so having it reappear one layer
down would have made the whole flow pointless.

`seed_lostblink_credentials` closes it. When the gateway's sign-in completes, it
re-sends the provisioning request carrying the finished session, and the applier
writes it into the instance's `config` volume as `.cred.json` — blinkpy's own
credentials file, in blinkpy 0.25's `Auth.login_attributes` shape:

| key | from |
| --- | --- |
| `username` / `password` | the connection's own credentials |
| `token` | the access token the verified sign-in returned |
| `refresh_token` | **the grant that renews it without a new code** |
| `hardware_id` | **the device identity that token was minted against** |
| `expires_in` / `expiration_date` | when Blink said the token dies (epoch seconds) |
| `host` / `region_id` | the account's region tier |
| `client_id` / `account_id` / `user_id` | the identifiers Blink returned |
| `uid` / `device_id` | the client identity Blink already verified |
| `issued_at` | not blinkpy's — see "a seed only moves forward" below |

lostblink prefers this file over an email and password and reads it with
blinkpy's `no_prompt=True`, so it never asks.

**The two bold rows are the whole game.** blinkpy 0.25's `Auth.startup()` has
exactly two paths, and which one it takes is decided by those:

```python
if self.refresh_token and self.hardware_id:   # renews silently, no code
    ...
success = await self._oauth_login_flow()      # full sign-in → 2FA → exits
```

There is no third path, and no partial credit. A file carrying a valid access
token but no `refresh_token` works until that token expires — an hour — and then
the bridge is back at a verification code sent to a container log. A file
carrying both survives restarts and expiry indefinitely. So the gateway captures
Blink's refresh token and the hardware id it was bound to, and hands over both;
`tests/unit/lostblink.test.ts` asserts it still does, because the failure mode
looks exactly like success from the app's side.

Note this differs from the pre-OAuth arrangement, where completeness mattered
because blinkpy 0.23 re-logged-in if *any* value was `None`. That is no longer
the rule — `client_id`, `user_id` and the two legacy `uid` / `device_id` keys are
carried for the fallback login's benefit, but they are not what keeps the bridge
signed in.

**A seed only moves forward.** Refresh tokens rotate: once blinkpy has renewed,
the copy the gateway holds is spent. Every apply pass re-sends the handover, so
seeding unconditionally would eventually overwrite a live session with a dead
one and send the bridge back to a code prompt. `newer_session_present` reads the
`issued_at` stamp already in the volume and declines to seed when it is at least
as new — a routine reconcile leaves a working session alone, while a fresh
sign-in in the app stamps a later time and wins.

The file is built with `jq` and piped straight into the volume: it is never
written to this host's filesystem and never passed as an argument where `ps`
would show it. It lands `0600`, owned by uid 1000, which is what lostblink's own
`secure_credentials_file` expects.

If you ever do need the manual path — a bridge pointed at an account the gateway
has not signed into — it still works:

```bash
docker compose -p orionis-conn-<instance> run --rm lostblink auth
```
