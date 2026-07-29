/*
 * 한전 요금표(docs/2026_kr_bills.pdf, 2026-06-01 시행)에서 직접 손계산한 값과 대조.
 *
 * 골든 해시는 "변했는지"만 알려주므로, 애초에 값이 맞는지는 이 테스트가 담당한다.
 * 기대값은 모두 요금표에서 유도한 것이고 코드 출력을 베낀 것이 아니다.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const Calc = require('../lib/KoreaElecBillCalculator');

const bill = (opts, energy, today) => new Calc({ ...opts, today }).calculate(energy, today);

test('주택용 저압 710kWh 기타계절 — 구성요소까지 요금표와 일치', () => {
  // 기타계절(1/1~6/30, 9/1~12/31) 누진: 200/400kWh 경계, 단가 120.0 / 214.6 / 307.3
  //   기본요금 400kWh초과 = 7,300원
  //   전력량   200×120.0 + 200×214.6 + 310×307.3 = 24,000 + 42,920 + 95,263 = 162,183
  //   기후환경 710×9 = 6,390 / 연료비조정 710×5 = 3,550
  //   전기요금계 179,423 -> 부가세 17,942, 기반기금 4,840 -> 청구 202,200
  const today = new Date(2026, 5, 30, 12, 0);
  const r = bill({ pressure: 'low', checkDay: 1 }, 710, today);

  assert.strictEqual(r.mm1.season, 'etc');
  assert.strictEqual(r.basicWon, 7300, '기본요금');
  assert.strictEqual(r.kwhWon, 162183, '전력량요금');
  assert.strictEqual(r.climateWon, 6390, '기후환경요금');
  assert.strictEqual(r.fuelWon, 3550, '연료비조정');
  assert.strictEqual(r.elecSumWon, 179423, '전기요금계');
  assert.strictEqual(r.vat, 17942, '부가가치세');
  assert.strictEqual(r.baseFund, 4840, '전력산업기반기금');
  assert.strictEqual(r.total, 202200, '청구금액');
  assert.strictEqual(r.mm1.kwhStep, 3, '누진 3단계');
  assert.strictEqual(r.stepRate, 307.3, '3단계 한계단가');
});

test('주택용 고압 710kWh 기타계절 — 아파트 요율', () => {
  // 고압 기타계절: 기본 6,060 / 단가 105.0, 174.0, 242.3
  //   전력량 200×105 + 200×174 + 310×242.3 = 21,000 + 34,800 + 75,113 = 130,913
  //   전기요금계 6,060 + 130,913 + 6,390 + 3,550 = 146,913 -> 청구 165,560
  const today = new Date(2026, 5, 30, 12, 0);
  const r = bill({ pressure: 'high', checkDay: 1 }, 710, today);

  assert.strictEqual(r.basicWon, 6060);
  assert.strictEqual(r.kwhWon, 130913);
  assert.strictEqual(r.elecSumWon, 146913);
  assert.strictEqual(r.total, 165560);
  assert.strictEqual(r.stepRate, 242.3);
});

test('주택용 저압 710kWh 하계 — 300/450kWh 경계 적용', () => {
  // 하계(7/1~8/31) 누진: 300/450kWh 경계
  //   전력량 300×120.0 + 150×214.6 + 260×307.3 = 36,000 + 32,190 + 79,898 = 148,088
  //   전기요금계 7,300 + 148,088 + 6,390 + 3,550 = 165,328 -> 청구 186,320
  const today = new Date(2026, 6, 31, 12, 0);
  const r = bill({ pressure: 'low', checkDay: 1 }, 710, today);

  assert.strictEqual(r.mm1.season, 'summer');
  assert.strictEqual(r.kwhWon, 148088);
  assert.strictEqual(r.elecSumWon, 165328);
  assert.strictEqual(r.total, 186320);
});

test('주택용 저압 200kWh — 1단계만 적용', () => {
  // 기본 910 + 200×120.0 = 24,000 + 기후 1,800 + 연료 1,000 = 27,710
  //   -> 부가세 2,771, 기금 740 -> 청구 31,220
  const today = new Date(2026, 5, 30, 12, 0);
  const r = bill({ pressure: 'low', checkDay: 1 }, 200, today);

  assert.strictEqual(r.basicWon, 910);
  assert.strictEqual(r.kwhWon, 24000);
  assert.strictEqual(r.elecSumWon, 27710);
  assert.strictEqual(r.total, 31220);
  assert.strictEqual(r.mm1.kwhStep, 1);
  assert.strictEqual(r.stepRate, 120.0);
});

test('슈퍼유저요금 — 1,000kWh 초과 단가', () => {
  // 요금표 주석: 하계 1,000kWh 초과 전력량요금 저압 736.2 / 고압 601.3원/kWh
  const summer = new Date(2026, 6, 31, 12, 0);
  assert.strictEqual(bill({ pressure: 'low', checkDay: 1 }, 1001, summer).stepRate, 736.2);
  assert.strictEqual(bill({ pressure: 'high', checkDay: 1 }, 1001, summer).stepRate, 601.3);

  // 동계(12~2월)도 1,000kWh 초과 시 슈퍼유저 구간에 진입한다
  const winter = new Date(2026, 11, 25, 12, 0);
  const w = bill({ pressure: 'low', checkDay: 1 }, 1001, winter);
  assert.strictEqual(w.mm1.season, 'winter');
  assert.strictEqual(w.stepRate, 736.2);

  // 1,000kWh 이하는 슈퍼유저가 아니다
  assert.strictEqual(bill({ pressure: 'low', checkDay: 1 }, 1000, summer).stepRate, 307.3);
});

test('계절이 걸친 산출기간 (검침일 8일, 6/9~7/8) — 일할계산', () => {
  // 기타계절 + 하계가 섞이므로 두 계절 단독 청구액 사이에 들어와야 한다
  const today = new Date(2026, 6, 7, 12, 0);
  const low = bill({ pressure: 'low', checkDay: 8 }, 710, today);
  const high = bill({ pressure: 'high', checkDay: 8 }, 710, today);

  assert.strictEqual(low.checkMonth, 6, '6월 기준 산출기간');
  assert.strictEqual(low.mm1.season, 'etc');
  assert.strictEqual(low.mm2.season, 'summer');
  assert.strictEqual(low.mm1.useDays + low.mm2.useDays, low.monthDays, '일수 합 = 산출기간 일수');

  assert.strictEqual(low.total, 198600);
  assert.strictEqual(high.total, 162930);
  assert.ok(low.total > high.total, '저압이 고압보다 비싸다');

  // 하계 단독(186,320) < 걸친 기간 < 기타계절 단독(202,200)
  assert.ok(low.total > 186320 && low.total < 202200, '두 계절 단독 청구액 사이');
});

test('대가족 할인 — 월 16,000원 한도', () => {
  const today = new Date(2026, 6, 7, 12, 0);
  const base = bill({ pressure: 'low', checkDay: 8 }, 710, today);
  const dc = bill({ pressure: 'low', checkDay: 8, bigfamDcCfg: 1 }, 710, today);

  assert.strictEqual(dc.bigfamDc, 16000, '30%가 한도를 넘으므로 16,000원으로 제한');
  assert.strictEqual(dc.elecSumWon, base.elecSumWon - 16000);
  assert.strictEqual(dc.total, 180570);
});

test('일반용(갑)Ⅰ 저압 — 계절별 단일요율, 누진 없음', () => {
  // 요금표: 기본 6,160원/kW, 여름철 132.4 / 봄·가을철 91.9 / 겨울철 119.0원/kWh
  const opts = { tariffType: 'general_gap1_low', contractKw: 10, checkDay: 1 };

  const summer = bill(opts, 1000, new Date(2026, 6, 31, 12, 0));
  assert.strictEqual(summer.basicWon, 61600, '6,160 × 10kW');
  assert.strictEqual(summer.kwhWon, 132400, '1,000 × 132.4');
  assert.strictEqual(summer.stepRate, 132.4);
  assert.strictEqual(summer.mm1.kwhStep, 0, '누진 단계 없음');

  const springFall = bill(opts, 1000, new Date(2026, 4, 31, 12, 0));
  assert.strictEqual(springFall.kwhWon, 91900, '1,000 × 91.9');

  const winter = bill(opts, 1000, new Date(2026, 10, 1, 12, 0));
  assert.strictEqual(winter.kwhWon, 119000, '1,000 × 119.0');

  // 사용량이 2배면 전력량요금도 정확히 2배 (누진 없음 확인)
  const doubled = bill(opts, 2000, new Date(2026, 6, 31, 12, 0));
  assert.strictEqual(doubled.kwhWon, summer.kwhWon * 2);
});

test('시간대별(TOU) 일반용(갑)Ⅱ 고압A 선택Ⅰ — 부하별 단가', () => {
  // 요금표 여름철: 경부하 89.4 / 중간부하 140.6 / 최대부하 163.1원/kWh, 기본 7,170원/kW
  const today = new Date(2026, 6, 31, 12, 0);
  const c = new Calc({
    tariffType: 'general_gap2_highA_s1', contractKw: 100, checkDay: 1, today,
  });

  assert.strictEqual(c.isTouTariff(), true);
  assert.strictEqual(c.getTouRate('off'), 89.4);
  assert.strictEqual(c.getTouRate('mid'), 140.6);
  assert.strictEqual(c.getTouRate('peak'), 163.1);

  const r = c.calculate(1000, today, { off: 500, mid: 300, peak: 200 });
  assert.strictEqual(r.basicWon, 717000, '7,170 × 100kW');
  // 500×89.4 + 300×140.6 + 200×163.1 = 44,700 + 42,180 + 32,620 = 119,500
  assert.strictEqual(r.kwhWon, 119500);
  assert.strictEqual(r.climateWon, 9000, '1,000 × 9');
  assert.strictEqual(r.fuelWon, 5000, '1,000 × 5');
});

test('심야전력(갑) — 월 최저요금 20kWh 상당', () => {
  // 요금표: 기타계절 82.1원/kWh, 월 최저요금은 20kWh에 해당하는 금액
  const today = new Date(2026, 4, 31, 12, 0);
  const tiny = bill({ tariffType: 'night_gap', contractKw: 0, checkDay: 1 }, 1, today);
  assert.strictEqual(tiny.kwhWon, Math.floor(20 * 82.1), '1kWh만 써도 20kWh 상당 청구');

  const over = bill({ tariffType: 'night_gap', contractKw: 0, checkDay: 1 }, 100, today);
  assert.strictEqual(over.kwhWon, Math.floor(100 * 82.1), '최저요금 초과분은 실사용 기준');
});

test('사용량 0이어도 기본요금은 부과된다', () => {
  // 기본요금은 사용량과 무관하게 붙는다. 저압 1단계 910원
  //   -> 부가세 91, 기금 20 -> 청구 1,020원
  const today = new Date(2026, 5, 30, 12, 0);
  const r = bill({ pressure: 'low', checkDay: 1 }, 0, today);

  assert.strictEqual(r.basicWon, 910);
  assert.strictEqual(r.kwhWon, 0);
  assert.strictEqual(r.elecSumWon, 910);
  assert.strictEqual(r.total, 1020);
});

test('전력산업기반기금은 2.7% (2025-07-01 인하 반영)', () => {
  const today = new Date(2026, 5, 30, 12, 0);
  const r = bill({ pressure: 'low', checkDay: 1 }, 710, today);
  // 기금 = floor(floor(전기요금계 × 0.027) / 10) × 10
  assert.strictEqual(r.baseFund, Math.floor(Math.floor(r.elecSumWon * 0.027) / 10) * 10);
  assert.strictEqual(r.vat, Math.round(r.elecSumWon * 0.1), '부가세 10%');
});
