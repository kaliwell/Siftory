// ── Main-session permission hardening (VAL-029) ──
// The renderer never asks for privileged web permissions (no Notification,
// getUserMedia, clipboard, geolocation, fullscreen usage anywhere in src/),
// so the default session fails closed: every permission request and every
// permission check is denied unless it is explicitly whitelisted below. The
// GPU thumbnail session already applies the same deny-by-default policy; this
// extends it to the main window session. Kept free of runtime electron
// imports so the policy stays unit-testable.

// Compatibility facade for focused session-policy tests.
export {
  MAIN_SESSION_ALLOWED_PERMISSIONS,
  hardenMainSession,
  isMainSessionPermissionAllowed,
} from './startupSecurity'
