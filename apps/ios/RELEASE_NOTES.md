Orionis Control 0.2.4 adds adaptive high-resolution live video without sacrificing recovery. Automatic and High quality now start on a capped 1080p, 20 FPS, half-second-GOP WebRTC rendition. A stale frame or three consecutive severe low-frame-rate samples immediately creates a fresh 720p session; persistent trouble then falls back to live-edge HLS. The app uses the managed stream's known 20 FPS baseline so a connection that starts at 6 FPS can no longer be learned as healthy.

Media incident reports now record the requested and active quality plus an explicit downshift action while remaining bounded, redacted, authenticated, throttled, and readable from the administrator audit log. Existing 0.2.3 reports remain accepted by the gateway.

This release also adds the missing iOS asset catalog and an opaque 1024×1024 Orionis camera-lens/shield app icon, replacing the blank white placeholder.
