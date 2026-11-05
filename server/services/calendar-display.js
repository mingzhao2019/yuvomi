// Local presentation only: provider metadata and outbound event fields stay intact.
const PREFIX = 'calendar_display:';

export function calendarDisplaySql(field, sourceKeySql) {
  if (!['name', 'color'].includes(field)) throw new Error('Unknown calendar display field');
  return `(SELECT json_extract(CASE WHEN json_valid(cd.value) THEN cd.value ELSE '{}' END, '$.${field}')
    FROM sync_config cd WHERE cd.key = '${PREFIX}' || (${sourceKeySql}))`;
}

export function calendarDisplaySettings(database, key) {
  const value = database.prepare('SELECT value FROM sync_config WHERE key = ?').get(PREFIX + key)?.value;
  try {
    const parsed = JSON.parse(value ?? '{}');
    return {
      name: typeof parsed?.name === 'string' && parsed.name.trim() ? parsed.name : null,
      color: /^#[0-9a-f]{6}$/i.test(parsed?.color ?? '') ? parsed.color : null,
    };
  } catch {
    return { name: null, color: null };
  }
}

export function saveCalendarDisplay(database, key, changes) {
  const settings = { ...calendarDisplaySettings(database, key), ...changes };
  if (!settings.name && !settings.color) {
    database.prepare('DELETE FROM sync_config WHERE key = ?').run(PREFIX + key);
  } else {
    database.prepare(`
      INSERT INTO sync_config (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value,
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    `).run(PREFIX + key, JSON.stringify(settings));
  }
}
