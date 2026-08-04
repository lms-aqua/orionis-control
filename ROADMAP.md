<div align="center">

# 🛰️ Orionis Control

### Your self-hosted world, in one native app.

A privacy-first iOS app for the infrastructure you run yourself — **live cameras, a scrubbable DVR, DNS filtering, system health, and edge configuration** — reached over your own identity provider. No third-party cloud in the middle.

`v0.2.5` · actively developed · sideloaded via AltStore

</div>

---

## ✨ At a glance

| | |
|---|---|
| 🎥 **Sub-second live view** | Native WebRTC with a per-session relay, plus automatic HLS fallback so there's always a picture. |
| ⏪ **Scrubbable DVR** | Drag through a week of continuous recording, jump to any instant — with audio. |
| 🔊 **Camera audio** | Live and recorded audio, transcoded on the fly to play everywhere. |
| 🛡️ **DNS filtering** | AdGuard query log, allow/block rules, client management, one-tap protection. |
| 📊 **System health** | A live dashboard of your services and hosts. |
| ⚙️ **Edge configuration** | Manage your reverse proxy and identity provider safely, with guard rails. |
| 💾 **Storage & retention** | See what recordings cost against a quota and tune retention. |
| 🔐 **Least-privilege access** | Server-side RBAC, biometric confirmation, short-lived scoped tokens. |

---

## 🧭 How it fits together

The app never talks to your cameras or services directly. A **gateway you control** mediates everything — authorizing each request, minting short-lived tokens, and keeping internal services off the public internet.

```
 iOS app  ──▶  OIDC + PKCE  ──▶  Gateway  ──▶  Your stack
(SwiftUI,      (your identity     (authorizes ·   (cameras · DVR ·
 WebRTC)        provider)          relays ·        DNS · services)
                                   tokenizes)
```

> 🔒 **Privacy by design.** Video is proxied through the gateway over per-session relay credentials, so the streaming layer is never exposed and needs no public IP allowlist. Recorded footage is served only to the authenticated owner, never shared-cached.

---

## 🚀 What's new

Recent work has been about making the fast path *reliable* — smoother video, trustworthy data, and releases that can't ship broken.

| Version | Theme | Highlights |
|:--:|---|---|
| **0.2.5** | 🏎️ performance | Backend hot-path & upstream hardening; CI publishes only intended release artifacts. |
| **0.2.4** | 📶 streaming | **Adaptive 1080p** — the live view scales to the connection instead of stalling on a fixed bitrate. |
| **0.2.0–0.2.3** | 🛠️ reliability | WebRTC TURN fallback prioritization, deinit-safe stream observation, clearer "gateway unreachable" states, serialized/validated iOS releases gated on real device tests. |
| **0.2.1** | 🛡️ adguard | Made AdGuard query activity trustworthy — precise allowed / blocked / unknown classification. |
| **0.1.7–0.1.9** | 🧱 foundation | Smoother camera playback, AdGuard usability, broad reliability improvements. |
| **0.1.x** | 🏗️ the big build-out | Native WebRTC player + automatic HLS fallback, camera audio (AAC transcode), the scrubbable recordings timeline, offline-camera handling, tolerant permission decoding, an infrastructure-management screen, and reliable AltStore delivery. |

---

## 🗺️ Roadmap

> Directional, not a commitment on dates. Near-term is polish & trust; the middle distance adds intelligence and control; the horizon widens what *your stack* can mean.

### 🟢 Now — polish & trust
- 🎬 **Rock-steady live video** — eliminate the last WebRTC stutter and low-FPS dips on weak links (short-keyframe streaming + an always-warm feed).
- ⚡ **Snappier backend calls** — tight, bounded timeouts so a slow or dead endpoint never leaves you waiting.
- 📱 **Home-screen app icon** — ship the app icon into the build so the installed app is unmistakably Orionis.
- 🛡️ **Query-log accuracy** — guarantee the AdGuard log reflects real allow/block reality.

### 🔵 Next — bigger, smarter cameras
- 📺 **4K support — soon** — end-to-end 4K: full-resolution live view and recording for higher-detail cameras, with quality that adapts to your connection.
- ⏬ **Full recording control & downloads** — download clips straight to your device, trim & export any moment, **lock footage so it survives retention**, and manage recordings in bulk.
- 🔔 **Motion & object events** — a real event feed (person / vehicle / motion) from on-device detection, feeding the events tab and timeline markers.
- 📩 **Push notifications** — APNs alerts for the events that matter, the moment they happen.
- 🌊 **Low-latency HLS fallback** — a buttery, ~1.5s smooth fallback for when the network is too rough for real-time.

### 🟠 Later — wider horizon
- 🧱 **Richer camera wall** — multi-camera layouts, grouping, and faster switching for larger installs.
- 🔌 **More integrations** — bring additional self-hosted services under the same secure roof.
- 👥 **Multi-user & sharing** — scoped access for household members and guests, with per-role limits.
- 🖥️ **Beyond iPhone** — explore iPad and desktop surfaces for the same trusted control plane.

*…and more new features landing continuously as the platform grows.*

---

## 🧰 Built with

`Swift` · `SwiftUI` · `WebRTC` · `AVFoundation / HLS` · `Node` · `Fastify` · `TypeScript` · `SQLite` · `OIDC (Authelia)` · `go2rtc` · `MediaMTX` · `coturn` · `Docker` · `Caddy` · `Cloudflare` · `AltStore`

Distributed as an unsigned, self-re-signed build through **AltStore / SideStore** — no App Store gatekeeper, no distribution certificate, and updates that land the moment they're built.

---

<div align="center">
<sub>Built & maintained by <b>Lost Media Studios</b>. This document describes the product and its direction and intentionally contains no operational, network, or credential details.</sub>
</div>
