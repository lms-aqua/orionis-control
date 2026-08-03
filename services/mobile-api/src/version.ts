/** Single source of truth for version negotiation between app and gateway. */
export const API_VERSION = '1.0.0';
export const SERVER_VERSION = '0.2.4';

/**
 * Oldest iOS build this gateway will serve. The app compares its own build
 * against this and shows an "update required" state rather than failing with
 * confusing decoding errors.
 */
export const MIN_SUPPORTED_APP_BUILD = 1;
