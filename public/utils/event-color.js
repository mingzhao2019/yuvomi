/**
 * Shared calendar event color resolution.
 *
 * An event's own color wins. If it has no own color, use the primary assignee's
 * color, then the source calendar color, and finally a neutral fallback.
 */

export const EVENT_FALLBACK_COLOR = '#8E8E93';

/**
 * Resolve the display color of an event.
 * The primary assignee is `assigned_to`; `assigned_users` is not ordered.
 */
export function resolveEventColor(ev) {
  return resolveEventColorOrNull(ev) ?? EVENT_FALLBACK_COLOR;
}

/** Resolve the same hierarchy without a final fallback color. */
export function resolveEventColorOrNull(ev) {
  if (!ev) return null;
  if (ev.color) return ev.color;
  const assignees = ev.assigned_users ?? [];
  if (assignees.length > 0) {
    const primary = assignees.find((user) => user.id === ev.assigned_to) ?? assignees[0];
    return primary.color || null;
  }
  return ev.cal_color || null;
}
