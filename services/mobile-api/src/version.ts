/** Single source of truth for version negotiation between app and gateway. */
export const API_VERSION = '1.0.0';
// The gateway ships the connections plugin system in this release: camera
// sources are configuration now, not deployment. That is the same change the
// app calls 1.0.0, so the two stay in step.
export const SERVER_VERSION = '1.1.0';

/**
 * Oldest iOS build this gateway will serve. The app compares its own build
 * against this and shows an "update required" state rather than failing with
 * confusing decoding errors.
 */
export const MIN_SUPPORTED_APP_BUILD = 1;
