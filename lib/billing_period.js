/*
 * 청구기간 해석 — 앱 전체에서 유일한 기간 경계 정의
 * Copyright 2024, Geunwon Mo (mokorean@gmail.com)
 *
 * 한전 요금계산기간은 "전월 정기검침일 다음날 ~ 당월 정기검침일"이다. 즉 검침일이 d일이면
 * M월에 열린 기간은 (M월 d일, M+1월 d일] 이며, 시작일은 d+1일, 종료일은 다음 달 d일이다.
 * 말일 검침(checkDay=0)은 기간이 곧 역월(calendar month)과 같아진다.
 *
 * 이 규약에서 따라오는 결과:
 *  - 기간 길이 = (시작월 일수 - d) + d = 시작월 일수. 그래서 monthDays는 시작월 기준이다.
 *  - 검침일 당일은 그 기간의 '마지막' 날이므로, 다음 기간으로 넘어가는 전환은 d일이 아니라
 *    d+1일에 일어난다. 즉 판정은 `day > d` 이며 `>=` 가 아니다.
 *
 * 이전 구현은 이 두 가지를 모두 어겼다(분할이 하루씩 밀리고, 검침일 당일에 이미 다음 기간으로
 * 넘어갔다). 또 계산기와 device.js가 서로 다른 규약으로 각각 기간을 유도해 말일 사용자에서
 * 어긋났다. 기간 관련 계산은 전부 이 모듈을 거쳐야 한다.
 */

'use strict';

/** 해당 연·월의 일수. month는 1-12. */
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * 검침일을 그 달에 실제로 존재하는 날짜로 클램프한다.
 * 예: 검침일 31일 + 30일인 달 => 30일. (0은 말일을 뜻하므로 호출부에서 따로 처리)
 */
function readingDayOf(year, month, checkDay) {
  return Math.min(checkDay, daysInMonth(year, month));
}

/**
 * 주어진 시각이 속한 청구기간을 해석한다.
 *
 * @param {number} checkDay 0 = 말일, 1-31 = 해당 일자(월 길이로 클램프)
 * @param {Date} now 사용자 시간대의 벽시계 시각. UTC Date를 그대로 넘기면 안 된다.
 * @returns {{
 *   checkYear: number, checkMonth: number, monthDays: number, useDays: number,
 *   startDay: number, endDay: number,
 *   months: Array<{ year: number, month: number, days: number }>
 * }}
 *   checkYear/checkMonth = 기간이 열린 달(시작월). monthDays = 기간 전체 일수.
 *   useDays = 기간 시작부터 now까지 경과 일수(당일 포함). months = 달별 일수 분할.
 */
function resolveBillingPeriod(checkDay, now) {
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const day = now.getDate();

  // 말일 검침: 기간이 역월과 일치한다. 시작월/종료월이 같아 분할이 없다.
  if (!checkDay) {
    const monthDays = daysInMonth(year, month);
    return {
      checkYear: year,
      checkMonth: month,
      monthDays,
      useDays: day,
      startDay: 1,
      endDay: monthDays,
      months: [{ year, month, days: monthDays }],
    };
  }

  // 이번 달 검침일을 아직 지나지 않았으면(당일 포함) 기간은 지난 달에 열린 것이다.
  const inCurrentMonth = day > readingDayOf(year, month, checkDay);
  let startYear = year;
  let startMonth = month;
  if (!inCurrentMonth) {
    startMonth = month === 1 ? 12 : month - 1;
    if (month === 1) startYear = year - 1;
  }

  const startMonthDays = daysInMonth(startYear, startMonth);
  const startReading = readingDayOf(startYear, startMonth, checkDay);

  const endYear = startMonth === 12 ? startYear + 1 : startYear;
  const endMonth = startMonth === 12 ? 1 : startMonth + 1;
  const endReading = readingDayOf(endYear, endMonth, checkDay);

  const startMonthPart = startMonthDays - startReading; // 시작월의 검침일 다음날부터 말일까지
  const endMonthPart = endReading; // 다음 달 1일부터 검침일까지

  // 0일짜리 항목은 넘기지 않는다. 검침일이 짧은 달의 말일과 겹치면(예: 검침일 28 + 2월)
  // 기간이 (2/28, 3/28] 이 되어 시작월 몫이 0일이 되는데, 이때 mm1 자리에 0일 항목이
  // 들어가면 계절·요율 판정이 실제로는 하루도 없는 달을 보게 된다.
  const months = [];
  if (startMonthPart > 0) {
    months.push({ year: startYear, month: startMonth, days: startMonthPart });
  }
  if (endMonthPart > 0) {
    months.push({ year: endYear, month: endMonth, days: endMonthPart });
  }

  return {
    checkYear: startYear,
    checkMonth: startMonth,
    monthDays: startMonthPart + endMonthPart,
    // 경과 일수: 시작월 안이면 검침일 이후 며칠째인지, 다음 달로 넘어갔으면 시작월 잔여 + 이번 달 일수
    useDays: inCurrentMonth ? day - startReading : startMonthPart + day,
    startDay: startReading + 1,
    endDay: endReading,
    months,
  };
}

/**
 * 직전 청구기간. 검침일 롤오버 시 '끝난 기간'의 요율로 요금을 확정하기 위해 필요하다.
 * (그냥 현재 기간을 쓰면 새 기간의 계절·요율로 지난 달 요금이 계산된다.)
 */
function resolvePreviousBillingPeriod(checkDay, now) {
  const current = resolveBillingPeriod(checkDay, now);
  // 현재 기간 시작일의 하루 전 = 직전 기간의 종료일(= 직전 검침일)
  const dayBeforeStart = new Date(
    current.checkYear,
    current.checkMonth - 1,
    current.startDay - 1,
    12,
    0,
    0,
  );
  return resolveBillingPeriod(checkDay, dayBeforeStart);
}

module.exports = { resolveBillingPeriod, resolvePreviousBillingPeriod, daysInMonth };
