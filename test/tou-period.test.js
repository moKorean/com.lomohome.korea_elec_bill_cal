/*
 * 부하시간대 판정 검증 — device.js의 touPeriod()를 실제 코드로 구동.
 *
 * 한전 「계절별·시간대별 구분」 (docs/2026_kr_bills.pdf):
 *   경부하 22:00~08:00 (전계절)
 *   여름·봄가을: 중간 08~15·21~22 / 최대 15~21
 *   겨울:       중간 08~09·12~16·19~22 / 최대 09~12·16~19
 * 토요일·공휴일 계량 특례 (임시공휴일 제외):
 *   토요일 : 최대부하 사용량 -> 중간부하로 계량
 *   공휴일 : 최대수요전력 및 사용전력량 -> 경부하로 계량
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { makeDevice } = require('./lib/homey-stub');

const dev = makeDevice();
const at = (y, m, d, h) => dev.touPeriod(new Date(y, m - 1, d, h, 0));
const DOW = ['일', '월', '화', '수', '목', '금', '토'];

test('평일 시간대 구분 — 여름철', () => {
  // 2026-07-15 수요일
  assert.strictEqual(at(2026, 7, 15, 2), 'off', '02시 경부하');
  assert.strictEqual(at(2026, 7, 15, 7), 'off', '07시 경부하');
  assert.strictEqual(at(2026, 7, 15, 8), 'mid', '08시 중간부하 시작');
  assert.strictEqual(at(2026, 7, 15, 14), 'mid', '14시 중간부하');
  assert.strictEqual(at(2026, 7, 15, 15), 'peak', '15시 최대부하 시작');
  assert.strictEqual(at(2026, 7, 15, 20), 'peak', '20시 최대부하');
  assert.strictEqual(at(2026, 7, 15, 21), 'mid', '21시 중간부하 복귀');
  assert.strictEqual(at(2026, 7, 15, 22), 'off', '22시 경부하 시작');
});

test('평일 시간대 구분 — 겨울철 (이중 피크)', () => {
  // 2026-01-14 수요일
  assert.strictEqual(at(2026, 1, 14, 8), 'mid', '08시 중간');
  assert.strictEqual(at(2026, 1, 14, 9), 'peak', '09~12 최대');
  assert.strictEqual(at(2026, 1, 14, 11), 'peak');
  assert.strictEqual(at(2026, 1, 14, 12), 'mid', '12~16 중간');
  assert.strictEqual(at(2026, 1, 14, 15), 'mid');
  assert.strictEqual(at(2026, 1, 14, 16), 'peak', '16~19 최대');
  assert.strictEqual(at(2026, 1, 14, 18), 'peak');
  assert.strictEqual(at(2026, 1, 14, 19), 'mid', '19~22 중간');
  assert.strictEqual(at(2026, 1, 14, 22), 'off');
});

test('토요일 특례 — 최대부하가 중간부하로', () => {
  // 2026-07-18 토요일 (공휴일 아님)
  assert.strictEqual(new Date(2026, 6, 18).getDay(), 6);
  assert.strictEqual(at(2026, 7, 18, 17), 'mid', '최대부하 시간대 -> 중간부하');
  assert.strictEqual(at(2026, 7, 18, 10), 'mid', '중간부하는 그대로');
  assert.strictEqual(at(2026, 7, 18, 2), 'off', '경부하는 그대로');
  // 겨울 토요일도 동일
  assert.strictEqual(at(2026, 1, 17, 10), 'mid');
  assert.strictEqual(at(2026, 1, 17, 17), 'mid');
});

test('일요일 특례 — 전 시간대 경부하', () => {
  // 2026-07-19 일요일
  assert.strictEqual(new Date(2026, 6, 19).getDay(), 0);
  for (const h of [0, 8, 10, 15, 17, 20, 21, 23]) {
    assert.strictEqual(at(2026, 7, 19, h), 'off', `${h}시`);
  }
});

test('공휴일 특례 — 전 시간대 경부하', () => {
  const holidays = [
    [2026, 1, 1, '신정'],
    [2026, 2, 17, '설날'],
    [2026, 3, 2, '삼일절 대체'],
    [2026, 5, 5, '어린이날'],
    [2026, 6, 3, '지방선거일'],
    [2026, 8, 17, '광복절 대체'],
    [2026, 9, 25, '추석'],
    [2026, 10, 5, '개천절 대체'],
    [2026, 12, 25, '성탄절'],
  ];
  for (const [y, m, d, name] of holidays) {
    const dow = DOW[new Date(y, m - 1, d).getDay()];
    assert.strictEqual(at(y, m, d, 17), 'off', `${name} ${m}/${d}(${dow}) 17시`);
    assert.strictEqual(at(y, m, d, 10), 'off', `${name} ${m}/${d}(${dow}) 10시`);
  }
});

test('공휴일이 토요일이면 공휴일 규칙이 우선', () => {
  // 2026-06-06 현충일(토) — 토요일 특례(mid)가 아니라 공휴일(off)
  assert.strictEqual(new Date(2026, 5, 6).getDay(), 6);
  assert.strictEqual(at(2026, 6, 6, 17), 'off');
});

test('시(hour) 판정은 특례와 분리되어 있다', () => {
  // touPeriodByHour는 요일·공휴일을 보지 않는다 (특례 적용 전 원본 구분)
  assert.strictEqual(dev.touPeriodByHour(new Date(2026, 6, 19, 17)), 'peak', '일요일도 원본은 peak');
  assert.strictEqual(dev.touPeriodByHour(new Date(2026, 6, 18, 17)), 'peak', '토요일도 원본은 peak');
});
