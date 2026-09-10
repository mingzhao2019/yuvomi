/**
 * 中国农历显示工具。
 *
 * 农历不是一个可由固定公历偏移推导的日历，所以交给浏览器自带的
 * Intl/ICU 计算。这里固定使用 zh-CN 的 chinese calendar，只返回适合
 * Yuvomi 小尺寸日期标记的中文月份和日期；没有支持时返回空字符串，调用者
 * 可以据此隐藏开关或继续显示公历。
 */

const CHINESE_LUNAR_LOCALE = 'zh-CN-u-ca-chinese';
const CHINESE_DIGITS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

let formatter;
let supportChecked = false;
let supported = false;

function getFormatter() {
  if (supportChecked) return formatter;
  supportChecked = true;
  try {
    const candidate = new Intl.DateTimeFormat(CHINESE_LUNAR_LOCALE, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    });
    const options = candidate.resolvedOptions();
    if (options.calendar !== 'chinese' || typeof candidate.formatToParts !== 'function') return null;
    formatter = candidate;
    supported = true;
  } catch {
    formatter = null;
  }
  return formatter;
}

export function isChineseLunarSupported() {
  getFormatter();
  return supported;
}

export function isChineseLunarContext(region = null, locale = '') {
  const language = String(locale || '').toLowerCase();
  return region === 'zh-CN' || language === 'zh' || language.startsWith('zh-');
}

export function shouldDisplayChineseLunar({ enabled = false, region = null, locale = '' } = {}) {
  return enabled === true
    && isChineseLunarContext(region, locale)
    && isChineseLunarSupported();
}

function dateForKey(dateKey) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey ?? '').trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) return null;
  return date;
}

function lunarDayLabel(day) {
  if (!Number.isInteger(day) || day < 1 || day > 30) return '';
  if (day <= 10) return `初${day === 10 ? '十' : CHINESE_DIGITS[day]}`;
  if (day < 20) return `十${CHINESE_DIGITS[day - 10]}`;
  if (day === 20) return '二十';
  if (day < 30) return `廿${CHINESE_DIGITS[day - 20]}`;
  return '三十';
}

/**
 * 将 YYYY-MM-DD 转为“正月初一”这样的中国农历日期。
 *
 * `includeYear` 只用于需要完整上下文的首页文字；日历网格默认不带年份，
 * 以免每个日期单元格变得拥挤。
 */
export function formatChineseLunarDate(dateKey, { includeYear = false } = {}) {
  const date = dateForKey(dateKey);
  const intl = getFormatter();
  if (!date || !intl) return '';

  const parts = intl.formatToParts(date);
  const month = parts.find((part) => part.type === 'month')?.value ?? '';
  const day = Number(parts.find((part) => part.type === 'day')?.value);
  const dayLabel = lunarDayLabel(day);
  if (!month || !dayLabel) return '';

  const yearName = parts.find((part) => part.type === 'yearName')?.value ?? '';
  const yearPrefix = includeYear && yearName ? `农历${yearName}年` : '';
  return `${yearPrefix}${month}${dayLabel}`;
}

export const __test = { dateForKey, lunarDayLabel };
