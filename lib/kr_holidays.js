/*
 * 한국 공휴일 판정 — 「관공서의 공휴일에 관한 규정」 기준
 * Copyright 2024, Geunwon Mo (mokorean@gmail.com)
 *
 * 용도: 시간대별(TOU) 요금제의 토요일·공휴일 계량 특례.
 *   출처 docs/2026_kr_bills.pdf (한전, 2026-06-01 시행) 「계절별·시간대별 구분」 주석
 *     ※ 토요일 및 공휴일 계산기준(임시공휴일 제외)
 *       - 토요일 : 최대부하 시간대의 사용전력량 → 중간부하 시간대로 계량
 *       - 공휴일 : 최대수요전력 및 사용전력량 → 경부하 시간대로 계량
 *
 * 음력 공휴일(설날·부처님오신날·추석)은 ICU의 dangi(단기) 달력으로 매년 계산하므로
 * 연도별 날짜표를 관리할 필요가 없다. ICU가 dangi를 지원하지 않는 런타임에서는
 * 음력 공휴일만 빠지고 주말·양력 공휴일 판정은 그대로 동작한다(안전한 축소 동작).
 *
 * 미반영 항목:
 *  - 임시공휴일: 정부가 개별 지정하며 한전 특례에서도 명시적으로 제외된다.
 *  - ELECTION_DAYS에 없는 임기만료 선거일: 그 하루만 평일로 계산된다.
 */

'use strict';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 양력 고정 공휴일.
 * sub=true 이면 토·일요일 또는 다른 공휴일과 겹칠 때 대체공휴일이 생긴다.
 * 신정·현충일은 대체공휴일 대상이 아니다.
 */
const SOLAR_HOLIDAYS = [
  { m: 1, d: 1, sub: false }, // 신정 — 대체공휴일 대상 아님
  { m: 3, d: 1, sub: true }, // 삼일절
  { m: 5, d: 5, sub: true }, // 어린이날
  { m: 6, d: 6, sub: false }, // 현충일 — 대체공휴일 대상 아님
  { m: 8, d: 15, sub: true }, // 광복절
  { m: 10, d: 3, sub: true }, // 개천절
  { m: 10, d: 9, sub: true }, // 한글날
  { m: 12, d: 25, sub: true }, // 성탄절
];

/**
 * 음력 공휴일. 설날·추석은 앞뒤 하루를 포함한 3일 연휴(spread=1)다.
 * 연휴는 일요일과 겹칠 때만 대체공휴일이 생기고(subOn='sun'),
 * 부처님오신날은 토·일요일 또는 다른 공휴일과 겹칠 때 생긴다(subOn='satsun').
 * search: 해당 음력일이 들어올 수 있는 양력 구간 [[시작월, 일], [끝월, 일]].
 */
const LUNAR_HOLIDAYS = [
  {
    name: '설날', month: '1', day: 1, spread: 1, subOn: 'sun', search: [[1, 15], [2, 25]],
  },
  {
    name: '부처님오신날', month: '4', day: 8, spread: 0, subOn: 'satsun', search: [[4, 20], [6, 5]],
  },
  {
    name: '추석', month: '8', day: 15, spread: 1, subOn: 'sun', search: [[9, 1], [10, 15]],
  },
];

/**
 * 임기만료에 의한 선거일(공직선거법 제34조)도 공휴일이다. 선거 종류별 산정 규칙이
 * 복잡하고 사전에 확정되지 않는 경우가 있어 확인된 날짜만 명시한다.
 */
const ELECTION_DAYS = new Set([
  '2026-06-03', // 제9회 전국동시지방선거
]);

function keyOf(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** UTC 정오 기준 Date — 시간대·DST 영향 없이 달력 날짜만 다루기 위함. */
function utcNoon(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day, 12));
}

function keyOfDate(date) {
  return keyOf(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/** 윤달은 month가 '6bis' 형태로 오므로 문자열 비교로 평월만 매칭한다. */
function lunarOf(fmt, date) {
  let month = null;
  let day = null;
  for (const part of fmt.formatToParts(date)) {
    if (part.type === 'month') month = part.value;
    else if (part.type === 'day') day = parseInt(part.value, 10);
  }
  return { month, day };
}

let dangiFmt;

/** dangi 달력 지원 여부를 실제 값으로 검증한다. 미지원이면 null. */
function dangiFormatter() {
  if (dangiFmt !== undefined) return dangiFmt;
  dangiFmt = null;
  try {
    const fmt = new Intl.DateTimeFormat('en-u-ca-dangi', {
      timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric',
    });
    // 2026-02-17은 음력 1월 1일(설날)이다. 달력이 없거나 무시되면 값이 달라진다.
    const probe = lunarOf(fmt, utcNoon(2026, 2, 17));
    if (probe.month === '1' && probe.day === 1) dangiFmt = fmt;
  } catch (e) {
    dangiFmt = null;
  }
  return dangiFmt;
}

/** 주어진 연도에서 음력 month/day에 해당하는 양력 날짜를 찾는다. */
function findLunarDate(fmt, year, spec) {
  const [[fromM, fromD], [toM, toD]] = spec.search;
  const end = utcNoon(year, toM, toD).getTime();
  for (let t = utcNoon(year, fromM, fromD).getTime(); t <= end; t += MS_PER_DAY) {
    const date = new Date(t);
    const lunar = lunarOf(fmt, date);
    if (lunar.month === spec.month && lunar.day === spec.day) return date;
  }
  return null;
}

/**
 * 연도별 공휴일 그룹 목록. 그룹은 대체공휴일 판정 단위(설날/추석은 3일 연휴가 한 그룹).
 */
function groupsOf(year) {
  const groups = [];

  for (const h of SOLAR_HOLIDAYS) {
    groups.push({ keys: [keyOf(year, h.m, h.d)], subOn: h.sub ? 'satsun' : null });
  }

  const fmt = dangiFormatter();
  if (fmt) {
    for (const spec of LUNAR_HOLIDAYS) {
      const date = findLunarDate(fmt, year, spec);
      if (!date) continue;
      const keys = [];
      for (let offset = -spec.spread; offset <= spec.spread; offset += 1) {
        keys.push(keyOfDate(new Date(date.getTime() + offset * MS_PER_DAY)));
      }
      groups.push({ keys, subOn: spec.subOn });
    }
  }

  for (const key of ELECTION_DAYS) {
    if (key.startsWith(`${year}-`)) groups.push({ keys: [key], subOn: null });
  }

  return groups;
}

function dayOfWeekOf(key) {
  const [y, m, d] = key.split('-').map(Number);
  return utcNoon(y, m, d).getUTCDay();
}

/**
 * 대체공휴일: 요건에 해당하면 그 공휴일(연휴) 다음의 첫 번째 비공휴일을 공휴일로 한다.
 * 일요일은 그 자체로 공휴일이므로 후보에서 제외된다.
 */
function substitutesOf(groups, baseKeys) {
  const subs = new Set();
  const occupied = new Map();
  for (const group of groups) {
    for (const key of group.keys) occupied.set(key, (occupied.get(key) || 0) + 1);
  }

  const isOff = (key) => baseKeys.has(key) || subs.has(key) || dayOfWeekOf(key) === 0;

  // 같은 날에 겹친 공휴일(예: 2025년 어린이날=부처님오신날)은 대체공휴일도 하루만
  // 생기므로, 그룹이 아니라 연휴 마지막 날(anchor) 기준으로 중복을 제거한다.
  const anchors = new Set();
  for (const group of groups) {
    if (!group.subOn) continue;

    let triggered = false;
    for (const key of group.keys) {
      const dow = dayOfWeekOf(key);
      if (dow === 0) triggered = true;
      if (group.subOn === 'satsun' && (dow === 6 || occupied.get(key) > 1)) triggered = true;
    }
    if (triggered) anchors.add(group.keys[group.keys.length - 1]);
  }

  for (const anchor of [...anchors].sort()) {
    const [y, m, d] = anchor.split('-').map(Number);
    let t = utcNoon(y, m, d).getTime();
    for (let i = 0; i < 10; i += 1) {
      t += MS_PER_DAY;
      const key = keyOfDate(new Date(t));
      if (!isOff(key)) {
        subs.add(key);
        break;
      }
    }
  }

  return subs;
}

const cache = new Map();

function holidaysOf(year) {
  const cached = cache.get(year);
  if (cached) return cached;

  const groups = groupsOf(year);
  const keys = new Set();
  for (const group of groups) {
    for (const key of group.keys) keys.add(key);
  }
  for (const key of substitutesOf(groups, keys)) keys.add(key);

  cache.set(year, keys);
  return keys;
}

/**
 * 법정공휴일 여부. 일요일은 포함하지 않으므로 호출부에서 따로 판정한다
 * (일요일은 달력 계산 없이 알 수 있고, 공휴일 표에 넣으면 캐시가 커진다).
 * @param {number} year 양력 연도
 * @param {number} month 1-12
 * @param {number} day 1-31
 * @returns {boolean}
 */
function isPublicHoliday(year, month, day) {
  return holidaysOf(year).has(keyOf(year, month, day));
}

/** 음력 공휴일 계산이 가능한 런타임인지 여부 (진단·로그용). */
function lunarSupported() {
  return dangiFormatter() !== null;
}

/** 해당 연도 공휴일 목록(정렬된 'YYYY-MM-DD' 배열). 진단·테스트용. */
function listHolidays(year) {
  return [...holidaysOf(year)].sort();
}

module.exports = { isPublicHoliday, lunarSupported, listHolidays };
