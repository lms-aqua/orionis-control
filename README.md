<div align="center">

# Orionis Control

**One secure, native iOS app for the cameras, the network, and everything keeping them online.**

[![Platform](https://img.shields.io/badge/platform-iOS%20%7C%20iPadOS-000000?style=flat-square&logo=apple&logoColor=white)](#)
[![Swift](https://img.shields.io/badge/Swift-6-F05138?style=flat-square&logo=swift&logoColor=white)](#)
[![SwiftUI](https://img.shields.io/badge/UI-SwiftUI-0071E3?style=flat-square)](#)
[![Auth](https://img.shields.io/badge/auth-OIDC%20%2B%20PKCE-2E7D32?style=flat-square)](#)
[![Status](https://img.shields.io/badge/status-in%20development-F9A825?style=flat-square)](#)
[![License](https://img.shields.io/badge/license-proprietary-6E56CF?style=flat-square)](LICENSE)

</div>

> [!IMPORTANT]
> **Proprietary — All Rights Reserved. © 2026 Lost Media Studios.**
> This repository is public for reference and portfolio purposes only. **No license is granted.** You may not copy, modify, redistribute, or use this software or any part of it. Public visibility is not permission. See [LICENSE](LICENSE).

---

## About

Self-hosted infrastructure tends to sprawl. The cameras live in one web UI, DNS filtering in another, the identity provider in a third, and service health somewhere behind an SSH session. On a phone, that means squinting at three desktop dashboards that were never meant to be touched with a thumb.

**Orionis Control** collapses that into a single native application. It's built for the person who actually runs the system — one place to see whether the cameras are up, whether something moved in the driveway at 3 a.m., whether DNS filtering is still doing its job, and whether the boxes underneath it all are healthy.

It's designed to feel like it shipped with the operating system: native navigation, system typography, real Dynamic Type, honest light and dark appearance, and no interface elements that pretend to do something they don't.

---

## What It Does

### 🎥 Cameras
Every camera the system knows about, discovered automatically — no hand-maintained lists. Live low-latency video, snapshot capture, full-screen and landscape viewing, Picture-in-Picture, and stream diagnostics tucked into an advanced panel where they belong. Supported hardware exposes pan, tilt, zoom, presets, lighting, and privacy controls; unsupported hardware simply doesn't show them.

### 🕒 Events & Recordings
A timeline you can actually navigate. Filter by camera, date, and event type — motion, person, vehicle, package, audio, or system-generated alerts. Each event carries its timestamp, thumbnail, clip, confidence where available, and acknowledgement state.

### 🛡️ Network Filtering
A first-class native interface for DNS filtering, not a web view in a costume. Query volume, block rates, top clients and domains, upstream health, and filter list status across selectable time ranges. A searchable query log with real filtering. Allow and block rules that validate before they're applied. Protection can be paused — deliberately, with a confirmation, a duration, a persistent warning, and an audit trail of who did it and why.

### 📊 System Health
Aggregate status for the services that matter, in plain language: healthy, warning, critical, offline, or unknown — never color alone. A short list of pre-approved operations (restart a defined service, reload filters, run a health check) rather than a shell prompt in your pocket.

### 🔔 Notifications
Push alerts for the things worth waking up for — a camera dropping offline, a person detected, a recording failure, storage running low, protection being disabled. Tunable per camera, per event type, and per severity, with quiet hours. Every notification deep-links to the exact screen it's about, and payloads stay deliberately thin.

---

## How It's Built

- **Native throughout.** Swift and SwiftUI, structured concurrency, and Apple's own frameworks for media, authentication, and secure storage. Third-party dependencies have to earn their place.
- **Adaptive by default.** iPhone, iPhone landscape, iPad, and iPad split-screen are all first-class layouts — not one design stretched to fit.
- **Honest states.** Loading, empty, offline, unauthorized, degraded, and failed each get a designed screen that says what happened, whether the data is stale, and what you can do next. No shrugging "something went wrong."
- **Real data only.** Nothing in the shipping path is a placeholder. If a chart is on screen, it's drawing live numbers.

---

## Security & Privacy

Security here is architectural, not a feature list bolted on at the end.

- Authentication goes through the real identity provider using **OAuth 2.0 Authorization Code Flow with PKCE**, presented in the system authentication session — so existing multi-factor policies, passkeys, TOTP, lockouts, and session rules all continue to apply, untouched.
- **No credentials live in the app.** No embedded passwords, no permanent administrator tokens, no login-form scraping, no mobile-only authentication bypass. Tokens are short-lived and stored in the Keychain.
- **Authorization is enforced server-side.** Viewer, Operator, and Administrator roles gate every privileged action on the server. Hiding a button in the UI is a courtesy, never a control.
- **Sensitive operations are audited.** Configuration changes, protection toggles, and service actions are logged and rate-limited.
- **Privacy is the default.** Optional biometric app lock, an app-switcher privacy shield, no analytics SDK, no advertising SDK, no fingerprinting, and diagnostic exports that strip tokens, cookies, keys, and identifying detail before they ever leave the device.

> This repository is an overview of the project. Infrastructure topology, service endpoints, configuration, and deployment procedures are intentionally not published here.

---

## Accessibility

Treated as a requirement, not a checklist item: full Dynamic Type support, VoiceOver labelling, sufficient contrast, respect for Reduce Motion and Reduce Transparency, and status that is never communicated by color alone.

---

## Status

🚧 **In active development.** Features are tracked honestly — complete, partial, not started, or blocked — and nothing gets marked done because it renders. If a capability isn't supported upstream, that's stated plainly rather than faked.

---

## License

**Copyright © 2026 Lost Media Studios. All rights reserved.**

This project is proprietary. The repository is public for reference and portfolio purposes only — visibility is not permission. No right to copy, modify, redistribute, or use the software is granted. See [LICENSE](LICENSE) for the full terms.

<div align="center">
<sub>Built for people who run their own infrastructure and would like to stop opening four browser tabs to do it.</sub>
</div>
