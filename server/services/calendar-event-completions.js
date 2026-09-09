/**
 * Persönliche Abschlussmarkierungen für Kalendertermine.
 *
 * Kalender-Provider kennen bei VEVENTs keinen gemeinsamen „completed“-Zustand.
 * Deshalb bleibt diese Information vollständig in Yuvomi. Die occurrence_key
 * trennt die virtuellen Instanzen einer Wiederholungsserie, während einzelne
 * (auch mehrtägige) Termine den festen Schlüssel `single` verwenden.
 */

export const SINGLE_EVENT_OCCURRENCE_KEY = 'single';
export const RECURRENCE_OCCURRENCE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function completionKeyForEvent(event) {
  if (!event?.recurrence_rule) return SINGLE_EVENT_OCCURRENCE_KEY;
  const value = event.completion_key ?? event.occurrence_key;
  if (value && RECURRENCE_OCCURRENCE_KEY_RE.test(String(value))) return String(value);
  return String(event.start_datetime ?? '').slice(0, 10);
}

/**
 * Fügt einer bereits expandierten Eventliste den persönlichen Zustand hinzu.
 * Eine Abfrage für das gesamte Fenster verhindert N+1-Abfragen bei Monats- und
 * Agendaansichten.
 */
export function decorateEventCompletions(database, events, userId) {
  const list = Array.isArray(events) ? events : [];
  const parsedUserId = Number(userId);
  const ids = [...new Set(list
    .map((event) => Number(event?.id))
    .filter((id) => Number.isInteger(id) && id > 0))];

  const completed = new Map();
  if (Number.isInteger(parsedUserId) && parsedUserId > 0 && ids.length) {
    // A few isolated read-only test databases intentionally stop before the
    // append-only migration that introduced this table. Production databases
    // always have it; treating the absent table as "nothing completed" keeps
    // those reduced fixtures compatible without changing the real schema.
    const hasTable = database.prepare(`
      SELECT 1
      FROM sqlite_master
      WHERE type = 'table' AND name = 'calendar_event_completions'
    `).get();
    if (hasTable) {
      const placeholders = ids.map(() => '?').join(',');
      const rows = database.prepare(`
        SELECT event_id, occurrence_key, completed_at
        FROM calendar_event_completions
        WHERE user_id = ? AND event_id IN (${placeholders})
      `).all(parsedUserId, ...ids);
      for (const row of rows) {
        completed.set(`${row.event_id}\u0000${row.occurrence_key}`, row.completed_at);
      }
    }
  }

  return list.map((event) => {
    const completionKey = completionKeyForEvent(event);
    const completedAt = completed.get(`${event.id}\u0000${completionKey}`) ?? null;
    return {
      ...event,
      completion_key: completionKey,
      completed: completedAt !== null,
      completed_at: completedAt,
    };
  });
}

export function setEventCompletion(database, { eventId, occurrenceKey, userId, completed }) {
  const id = Number(eventId);
  const key = String(occurrenceKey ?? '');
  const actor = Number(userId);
  if (!Number.isInteger(id) || id < 1) throw new Error('eventId must be a positive integer');
  if (!key) throw new Error('occurrenceKey is required');
  if (!Number.isInteger(actor) || actor < 1) throw new Error('userId must be a positive integer');

  if (completed) {
    // Idempotent by design: a repeated click/request does not change the
    // original completion timestamp.
    database.prepare(`
      INSERT OR IGNORE INTO calendar_event_completions
        (event_id, occurrence_key, user_id)
      VALUES (?, ?, ?)
    `).run(id, key, actor);
  } else {
    database.prepare(`
      DELETE FROM calendar_event_completions
      WHERE event_id = ? AND occurrence_key = ? AND user_id = ?
    `).run(id, key, actor);
  }

  const row = database.prepare(`
    SELECT completed_at
    FROM calendar_event_completions
    WHERE event_id = ? AND occurrence_key = ? AND user_id = ?
  `).get(id, key, actor);

  return {
    event_id: id,
    completion_key: key,
    completed: !!row,
    completed_at: row?.completed_at ?? null,
  };
}
