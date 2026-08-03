/*
 * 요금 계산 회귀 매트릭스.
 *
 * 리팩터링이 계산 결과를 바꾸지 않았는지 넓게 확인하기 위한 것이다. 계약종별 전체 ×
 * 계절 경계 × 누진 구간 경계 × 할인 조합을 돌려 모든 출력 필드를 직렬화하고, 그룹별
 * SHA-256으로 고정한다. 그룹을 나눠 두면 해시가 깨졌을 때 어느 영역인지 바로 좁혀진다.
 */

'use strict';

const crypto = require('crypto');

const Calc = require('../../lib/KoreaElecBillCalculator');
const { emptyTouBuckets } = require('../../lib/KoreaElecBillCalculator');
const RATES = require('../../lib/rates_korea.json');

// 결과 객체에서 해시에 넣을 필드 (전부 — 누락되면 회귀를 놓친다)
const TOP = ['energy', 'basicWon', 'kwhWon', 'diffWon', 'climateWon', 'fuelWon',
  'elecBasicDc', 'elecBasic200Dc', 'bigfamDc', 'weakDc', 'welfareDc',
  'elecSumWon', 'vat', 'baseFund', 'total', 'stepRate',
  'checkYear', 'checkMonth', 'monthDays', 'useDays'];
const PER_MONTH = ['yymm', 'season', 'useDays', 'kwhStep', 'basicWon', 'kwhWon',
  'climateWon', 'diffWon', 'elecBasicDc', 'weakDc', 'welfareDc', 'bigfamDc'];

// 누진 구간·슈퍼유저 경계를 모두 건드리는 사용량
const USAGES = [0, 0.5, 1, 99, 100, 199, 200, 201, 299, 300, 350, 400, 401,
  449, 450, 451, 710, 999, 1000, 1001, 1500, 3000];
// 계절 경계(하계 7~8, 동계 11~2, 봄가을)와 검침일 걸침을 covering
const DATES = [
  [1, 15], [2, 28], [3, 8], [5, 31], [6, 9], [6, 30],
  [7, 1], [7, 8], [8, 31], [9, 1], [11, 1], [12, 25],
];
const CHECK_DAYS = [0, 1, 8, 28, 31];
const DISCOUNTS = [[0, 0], [1, 0], [2, 0], [0, 1], [0, 3], [0, 5], [1, 1], [2, 3]];

const dateOf = ([m, d]) => new Date(2026, m - 1, d, 12, 0);
const tag = ([m, d]) => `${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`;

function serialize(label, r) {
  const top = TOP.map((k) => `${k}=${r[k]}`).join(',');
  const mm = ['mm1', 'mm2']
    .map((m) => PER_MONTH.map((k) => `${m}.${k}=${r[m][k]}`).join(','))
    .join(',');
  return `${label}|${top}|${mm}`;
}

/** 주택용 누진 (전압 × 검침일 × 날짜 × 사용량 × 할인) */
function residentialLines() {
  const out = [];
  for (const pressure of ['low', 'high']) {
    for (const checkDay of CHECK_DAYS) {
      for (const dt of DATES) {
        const today = dateOf(dt);
        for (const energy of USAGES) {
          for (const [b, w] of DISCOUNTS) {
            const r = new Calc({
              pressure, checkDay, today, bigfamDcCfg: b, welfareDcCfg: w,
            }).calculate(energy, today);
            out.push(serialize(`R:${pressure}:${checkDay}:${tag(dt)}:${energy}:${b}${w}`, r));
          }
        }
      }
    }
  }
  return out;
}

/** 비주택 정액(계절별 단일요율) 종별 × 계약전력 */
function flatLines() {
  const out = [];
  for (const type of Object.keys(RATES.TARIFF_FLAT)) {
    for (const kw of [0, 1, 5, 12, 100, 325]) {
      for (const dt of DATES) {
        const today = dateOf(dt);
        for (const energy of USAGES) {
          const r = new Calc({
            tariffType: type, contractKw: kw, checkDay: 8, today,
          }).calculate(energy, today);
          out.push(serialize(`F:${type}:${kw}:${tag(dt)}:${energy}`, r));
        }
      }
    }
  }
  return out;
}

/** 시간대별(TOU) 종별 — 부하 배분과 시간대 단가 조회까지 */
function touLines() {
  const out = [];
  for (const type of Object.keys(RATES.TARIFF_TOU)) {
    for (const kw of [0, 1, 100, 300]) {
      for (const dt of DATES) {
        const today = dateOf(dt);
        for (const energy of USAGES) {
          // 계절이 걸치는 기간을 덮기 위해 두 계절에 나눠 적재한다
          const buckets = emptyTouBuckets();
          buckets.summer = { off: energy * 0.3, mid: energy * 0.15, peak: energy * 0.1 };
          buckets.spring_fall = { off: energy * 0.2, mid: energy * 0.15, peak: energy * 0.1 };
          const c = new Calc({
            tariffType: type, contractKw: kw, checkDay: 8, today,
          });
          const r = c.calculate(energy, today, buckets);
          out.push(serialize(`T:${type}:${kw}:${tag(dt)}:${energy}`, r));
          out.push(`TR:${type}:${tag(dt)}|${c.getTouRate('off')},${c.getTouRate('mid')},`
            + `${c.getTouRate('peak')},${c.isTouTariff()},${c.getFirstStepRate()}`);
        }
      }
    }
  }
  return out;
}

const GROUPS = {
  residential: residentialLines,
  flat: flatLines,
  tou: touLines,
};

/** @returns {{group: string, cases: number, sha256: string, body: string}[]} */
function run() {
  return Object.entries(GROUPS).map(([group, fn]) => {
    const lines = fn();
    const body = lines.join('\n');
    return {
      group,
      cases: lines.length,
      sha256: crypto.createHash('sha256').update(body).digest('hex'),
      body,
    };
  });
}

module.exports = { run, GROUPS };
