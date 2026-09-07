/**
 * Shared calendar event color resolution.
 *
 * ICS subscriptions use their calendar colour by default. A manually changed
 * event colour remains authoritative. Other providers retain the existing
 * event -> assignee -> source hierarchy.
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
  // `subscription_id` is the durable source marker. Keep the legacy
  // external_source check as a fallback for old/API-shaped objects, but do not
  // require both fields: the calendar list and the countdown query do not have
  // identical serialization histories.
  const isIcsSubscription = ev.external_source === 'ics' || ev.subscription_id != null;
  if (isIcsSubscription && ev.color_modified !== 1 && ev.cal_color) {
    return ev.cal_color;
  }
  if (ev.color) return ev.color;
  const assignees = ev.assigned_users ?? [];
  if (assignees.length > 0) {
    const primary = assignees.find((user) => user.id === ev.assigned_to) ?? assignees[0];
    return primary.color || null;
  }
  return ev.cal_color || null;
}
