/*
 * '오늘 쓴 요금'(meter_money_today) 검증 — 실제 device.js를 가상 시계로 구동.
 *
 * 자정 시점의 이번달 요금을 스냅샷으로 잡고 실시간 요금과의 차이를 표시한다.
 * 경계 조건 세 가지가 핵심이다.
 *   1) 최초 설치일에 한 달치가 통째로 찍히지 않는다
 *   2) 자정에 0으로 리셋된다
 *   3) 검침일에 이번달 요금이 0으로 리셋되어도 음수로 튀거나 끊기지 않는다
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { makeDevice, primeDevice, clock } = require('./lib/homey-stub');

clock.install();
test.after(() => clock.restore());

/** 미터값을 갱신하고 '오늘 쓴 요금'을 돌려준다. */
async function tick(dev, [y, m, d, h, mi], meter) {
  clock.setKst(y, m, d, h, mi);
  await dev.updateMeter(meter);
  return dev.capValues.meter_money_today;
}

test('하루 동안 누적되고 자정에 리셋된다', async () => {
  clock.setKst(2026, 6, 9, 0, 5);
  const dev = makeDevice({ settings: { check_day: 8 } });
  await primeDevice(dev, { meter: 0, day: 9, hour: 0 });

  // 1일차 — 설치 당일은 0원에서 시작해야 한다
  const install = await tick(dev, [2026, 6, 9, 0, 5], 0);
  assert.strictEqual(install, 0, '설치 시점 0원');

  const d1morning = await tick(dev, [2026, 6, 9, 8, 0], 8);
  const d1evening = await tick(dev, [2026, 6, 9, 18, 0], 20);
  const d1end = await tick(dev, [2026, 6, 9, 23, 50], 25);
  assert.ok(d1morning > 0, '사용하면 올라간다');
  assert.ok(d1evening > d1morning && d1end > d1evening, '단조 증가');

  // 2일차 — 자정을 넘기면 리셋
  const d2start = await tick(dev, [2026, 6, 10, 0, 10], 26);
  assert.ok(d2start < d1end, `자정 리셋 (${d1end} -> ${d2start})`);
  assert.ok(d2start > 0 && d2start < 1000, '자정 직후 소액');

  const d2end = await tick(dev, [2026, 6, 10, 23, 50], 50);
  assert.ok(d2end > d2start, '2일차 재누적');
});

test('기준점이 오늘 사용량(meter_kwh_today)과 동일한 규약을 따른다', async () => {
  // 자정을 걸친 사용량 증가분은 새 날짜로 귀속된다 — meter_kwh_today가 자정 직전
  // 마지막 검침값을 기준으로 삼기 때문. '오늘 쓴 요금'도 같은 시점을 기준으로 해야
  // 두 센서가 어긋나지 않는다.
  clock.setKst(2026, 6, 9, 0, 5);
  const dev = makeDevice({ settings: { check_day: 8 } });
  await primeDevice(dev, { meter: 0, day: 9, hour: 0 });
  await tick(dev, [2026, 6, 9, 0, 5], 0);

  const beforeMidnight = 30; // 6/9 마지막 검침
  const afterMidnight = 45; // 6/10 첫 검침 (자정 걸친 증가분 포함)
  const endOfDay = 60; // 6/10 저녁

  await tick(dev, [2026, 6, 9, 23, 50], beforeMidnight);
  await tick(dev, [2026, 6, 10, 0, 10], afterMidnight);
  const today = await tick(dev, [2026, 6, 10, 18, 0], endOfDay);

  assert.strictEqual(
    dev.capValues.meter_kwh_today, endOfDay - beforeMidnight,
    '오늘 사용량은 자정 직전 검침값 기준',
  );

  const bill = (kwh) => dev.calculator.getSimpleBill(kwh).total;
  assert.strictEqual(
    today, bill(endOfDay) - bill(beforeMidnight),
    '오늘 쓴 요금도 같은 기준점을 쓴다',
  );
});

test('누진 단계가 올라가면 같은 사용량에도 오늘 요금이 커진다', async () => {
  clock.setKst(2026, 6, 9, 0, 5);
  const dev = makeDevice({ settings: { check_day: 8 } });
  await primeDevice(dev, { meter: 0, day: 9, hour: 0 });
  await tick(dev, [2026, 6, 9, 0, 5], 0);

  // 1단계 구간에서 하루 20kWh
  await tick(dev, [2026, 6, 10, 0, 0], 30);
  const lowTier = await tick(dev, [2026, 6, 10, 23, 0], 50);

  // 3단계 구간까지 끌어올린 뒤 같은 하루 20kWh
  await tick(dev, [2026, 6, 20, 0, 0], 500);
  const highTier = await tick(dev, [2026, 6, 20, 23, 0], 520);

  assert.ok(highTier > lowTier * 2,
    `3단계 하루 요금(${highTier})이 1단계(${lowTier})보다 훨씬 커야 한다`);
});

test('검침일에 요금이 리셋되어도 음수로 튀지 않는다', async () => {
  clock.setKst(2026, 6, 9, 0, 5);
  const dev = makeDevice({ settings: { check_day: 8 } });
  await primeDevice(dev, { meter: 0, day: 9, hour: 0 });
  await tick(dev, [2026, 6, 9, 0, 5], 0);

  // 검침일(7/8) 직전까지 사용량을 쌓는다
  for (let d = 10; d <= 30; d += 1) await tick(dev, [2026, 6, d, 23, 50], (d - 9) * 24);
  for (let d = 1; d <= 7; d += 1) await tick(dev, [2026, 7, d, 23, 50], 504 + d * 24);

  const onCheckDay = await tick(dev, [2026, 7, 8, 6, 0], 690);
  const later = await tick(dev, [2026, 7, 8, 20, 0], 710);
  assert.ok(onCheckDay >= 0, '검침일 음수 아님');
  assert.ok(later >= onCheckDay, '검침일에도 계속 누적');

  const nextDay = await tick(dev, [2026, 7, 9, 0, 10], 711);
  assert.ok(nextDay < later, '다음날 다시 리셋');
  assert.strictEqual(dev.store.todayBillCarry, 0, '이월분은 자정에 정리된다');
});

test('검침일이 하루 중간에 감지되면 리셋 전 누적분을 이월한다', async () => {
  // 디바이스가 검침일 당일에 재시작되면 날짜 전환과 청구기간 전환이 갈라진다.
  // (lastReadingDay는 이미 8일인데 lastBillingPeriod는 아직 전월)
  clock.setKst(2026, 7, 8, 6, 0);
  const dev = makeDevice({ settings: { check_day: 8 } });
  dev.initCalculator();
  await dev.initMeterValues();

  dev.lastMeterValue = 690;
  dev.monthStartMeter = 0;
  dev.yearStartMeter = 0;
  dev.dayStartMeter = 676;
  dev.todayStartMeter = 676;
  dev.lastReadingDay = { day: 8 };
  dev.lastReadingHour = { hour: 6 };
  dev.lastReadingYear = { year: 2026 };
  dev.lastBillingPeriod = { year: 2026, month: 5 }; // 아직 6월

  const snapshot = dev.calculator.getSimpleBill(676).total; // 자정 시점 요금
  dev.todayStartBill = snapshot;
  dev.currentMonthBill = dev.calculator.getSimpleBill(690).total; // 직전 업데이트 요금
  const expectedCarry = dev.currentMonthBill - snapshot;
  assert.ok(expectedCarry > 0, '이월될 금액이 있는 상황');

  const afterReset = await tick(dev, [2026, 7, 8, 6, 30], 695);
  assert.strictEqual(dev.store.todayBillCarry, expectedCarry, '이월 금액이 정확');
  assert.ok(afterReset >= expectedCarry, '오늘 요금에 이월분이 포함된다');

  const later = await tick(dev, [2026, 7, 8, 20, 0], 710);
  assert.ok(later > afterReset, '리셋 후에도 계속 증가');
});

test('태양광 상계로 요금이 줄어도 0 미만으로 표시되지 않는다', async () => {
  clock.setKst(2026, 6, 9, 0, 5);
  const dev = makeDevice({ settings: { check_day: 8, solar_offset: true } });
  await primeDevice(dev, { meter: 0, day: 9, hour: 0 });
  await tick(dev, [2026, 6, 9, 0, 5], 0);
  await tick(dev, [2026, 6, 10, 0, 0], 100);

  // 송전량이 소비량보다 크게 늘어 순사용량(=요금)이 감소하는 상황
  dev.exportMeterValue = 200;
  const today = await tick(dev, [2026, 6, 10, 12, 0], 105);
  assert.ok(today >= 0, `0 미만이 아니어야 한다 (${today})`);
});
