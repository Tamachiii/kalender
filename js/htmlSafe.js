// Safety helpers used by every HTML render path. Kept in their own module so
// that anything writing user-controlled data into the DOM has one obvious
// import to reach for, and so the helpers themselves are unit-testable
// without standing up the rest of ui.js.

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

// Defense-in-depth: every color value that reaches a renderer is interpolated
// into a `style="--foo:VALUE"` attribute. The DB enforces a strict hex format
// on tags.color/calendars.color (see 2026-05-color-format-check.sql), but
// safeColor re-validates at render time so a regression on the DB side — or a
// row that pre-dates the constraint — can't escape the attribute and inject
// script. Every color interpolation in ui.js MUST go through this helper.
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
export const DEFAULT_SAFE_COLOR = '#94a3b8';
export function safeColor(value, fallback = DEFAULT_SAFE_COLOR) {
  return HEX_COLOR_RE.test(value) ? value : fallback;
}
