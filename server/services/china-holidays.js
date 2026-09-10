/**
 * 中国大陆年度节假日安排（离线数据）。
 *
 * 日期来自国务院办公厅发布的年度节假日安排。调休工作日保留在数据中，
 * 供后续“工作日”显示能力使用；当前 holiday_cache 只保存假期区间，避免
 * 把补班误显示成休假。没有官方安排的年份不猜测，返回空数据。
 */

const CN = (zh, en) => ({ zh, en });

// 每次修订内置日期时必须递增。holiday sync scope 包含这个值，因此镜像
// 更新后会绕过 30 天节流，把新增或修正的年度安排立即写入 holiday_cache。
export const CHINA_HOLIDAY_DATA_VERSION = '2025-11-04.1';

export const CHINA_HOLIDAY_DATA = Object.freeze({
  2025: Object.freeze({
    public: Object.freeze([
      { key: 'newYear', startDate: '2025-01-01', endDate: '2025-01-01', name: CN('元旦', "New Year's Day") },
      { key: 'springFestival', startDate: '2025-01-28', endDate: '2025-02-04', name: CN('春节', 'Spring Festival') },
      { key: 'tombSweeping', startDate: '2025-04-04', endDate: '2025-04-06', name: CN('清明节', 'Qingming Festival') },
      { key: 'labourDay', startDate: '2025-05-01', endDate: '2025-05-05', name: CN('劳动节', 'Labour Day') },
      { key: 'dragonBoat', startDate: '2025-05-31', endDate: '2025-06-02', name: CN('端午节', 'Dragon Boat Festival') },
      { key: 'nationalDay', startDate: '2025-10-01', endDate: '2025-10-08', name: CN('国庆节、中秋节', 'National Day and Mid-Autumn Festival') },
    ]),
    makeUpWorkdays: Object.freeze(['2025-01-26', '2025-02-08', '2025-04-27', '2025-09-28', '2025-10-11']),
  }),
  2026: Object.freeze({
    public: Object.freeze([
      { key: 'newYear', startDate: '2026-01-01', endDate: '2026-01-03', name: CN('元旦', "New Year's Day") },
      { key: 'springFestival', startDate: '2026-02-15', endDate: '2026-02-23', name: CN('春节', 'Spring Festival') },
      { key: 'tombSweeping', startDate: '2026-04-04', endDate: '2026-04-06', name: CN('清明节', 'Qingming Festival') },
      { key: 'labourDay', startDate: '2026-05-01', endDate: '2026-05-05', name: CN('劳动节', 'Labour Day') },
      { key: 'dragonBoat', startDate: '2026-06-19', endDate: '2026-06-21', name: CN('端午节', 'Dragon Boat Festival') },
      { key: 'midAutumn', startDate: '2026-09-25', endDate: '2026-09-27', name: CN('中秋节', 'Mid-Autumn Festival') },
      { key: 'nationalDay', startDate: '2026-10-01', endDate: '2026-10-07', name: CN('国庆节', 'National Day') },
    ]),
    makeUpWorkdays: Object.freeze(['2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10']),
  }),
});

function holidayName(name, langCode) {
  const lang = String(langCode || '').toUpperCase();
  return lang === 'ZH' || lang.startsWith('ZH-') ? name.zh : name.en;
}

export function chinaPublicHolidays(year, langCode = 'EN') {
  const rows = CHINA_HOLIDAY_DATA[Number(year)]?.public;
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    startDate: row.startDate,
    endDate: row.endDate,
    name: holidayName(row.name, langCode),
  }));
}

export function chinaMakeUpWorkdays(year) {
  return [...(CHINA_HOLIDAY_DATA[Number(year)]?.makeUpWorkdays ?? [])];
}
