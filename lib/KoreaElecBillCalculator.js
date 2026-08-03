/*
 * Korea Electricity Bill Calculator
 * Based on kwh_to_won by dugurs (https://github.com/dugurs/kwh_to_won)
 * Ported to JavaScript for Homey by Geunwon Mo
 *
 * 한국전력(KEPCO) 주거용 전기요금 계산
 * https://online.kepco.co.kr/PRM033D00
 */

'use strict';

const path = require('path');
const fs = require('fs');

const { resolveBillingPeriod } = require('./billing_period');

// Load rates data
let RATES_DATA = null;
try {
  const ratesPath = path.join(__dirname, 'rates_korea.json');
  const ratesContent = fs.readFileSync(ratesPath, 'utf8');
  RATES_DATA = JSON.parse(ratesContent);
} catch (e) {
  // 이 모듈은 Homey 런타임 밖(스크립트·테스트)에서도 쓰이므로 주입된 로거가 없다.
  // eslint-disable-next-line no-console
  console.error('Failed to load rates_korea.json:', e);
}

/**
 * Deep merge two objects
 */
function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(result[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

/**
 * 계절별 x 부하시간대별 TOU 사용량 누적 구조. device.js가 이 모양으로 적재한다.
 * @returns {{summer:{off:number,mid:number,peak:number}, spring_fall:{off:number,mid:number,peak:number}, winter:{off:number,mid:number,peak:number}}}
 */
function emptyTouBuckets() {
  return {
    summer: { off: 0, mid: 0, peak: 0 },
    spring_fall: { off: 0, mid: 0, peak: 0 },
    winter: { off: 0, mid: 0, peak: 0 },
  };
}

/**
 * 원 단위 합계를 floor 하기 전 부동소수 잔재를 털어낸다.
 * (예: 251299.99999999997 을 그대로 floor 하면 1원이 사라진다)
 */
function round2(value) {
  return Math.round(value * 100) / 100;
}

class KoreaElecBillCalculator {
  /**
   * @param {Object} options
   * @param {string} options.pressure - 'low' (저압) or 'high' (고압)
   * @param {number} options.checkDay - 검침일 (0=말일, 1-31=해당 일자, 월 길이로 클램프)
   * @param {Date} options.today - 계산 기준일
   * @param {number} options.bigfamDcCfg - 대가족 할인 (0: 없음, 1: 5인이상/출산/3자녀, 2: 생명유지장치)
   * @param {number} options.welfareDcCfg - 복지 할인 (0: 없음, 1: 유공자/장애인, 2: 사회복지시설, 3: 기초생활(생계/의료), 4: 기초생활(주거/교육), 5: 차상위계층)
   */
  constructor(options = {}) {
    if (!RATES_DATA) {
      throw new Error('요금 정보(RATES_DATA)가 유효하지 않습니다.');
    }
    this.RATES = RATES_DATA;

    const {
      pressure = 'low',
      checkDay = 1,
      today = new Date(),
      bigfamDcCfg = 0,
      welfareDcCfg = 0,
      tariffType = 'residential',
      contractKw = 0,
      climatePrice = null,
      fuelPrice = null,
    } = options;

    this._ret = {
      pressure,
      checkDay,
      today,
      bigfamDcCfg,
      welfareDcCfg,
      tariffType,
      contractKw,
      climatePrice,
      fuelPrice,
      energy: 0.0001,
      checkYear: 0,
      checkMonth: 0,
      monthDays: 0,
      useDays: 0,
      mm1: this._createMonthData(),
      mm2: this._createMonthData(),
      basicWon: 0,
      kwhWon: 0,
      diffWon: 0,
      climateWon: 0,
      fuelWon: 0,
      elecBasicDc: 0,
      elecBasic200Dc: 0,
      bigfamDc: 0,
      weakDc: 0,
      welfareDc: 0,
      elecSumWon: 0,
      vat: 0,
      baseFund: 0,
      total: 0,
    };

    this._priceCache = {};
    this.calcLengthDays();
  }

  _createMonthData() {
    return {
      yymm: '',
      season: 'etc',
      energy: 0,
      basicWon: 0,
      kwhWon: 0,
      diffWon: 0,
      climateWon: 0,
      useDays: 0,
      kwhStep: 0,
      weakDc: 0,
      welfareDc: 0,
      bigfamDc: 0,
      elecBasicDc: 0,
      price: {},
    };
  }

  /**
   * Find price for given year-month
   */
  priceFind(prices, yymm) {
    const cacheKey = `${JSON.stringify(prices)}_${yymm}`;
    if (this._priceCache[cacheKey]) {
      return this._priceCache[cacheKey];
    }

    const listYm = Object.keys(prices).sort();
    let result = listYm[0];
    for (const ym of listYm) {
      if (ym <= yymm) {
        result = ym;
      } else {
        break;
      }
    }

    this._priceCache[cacheKey] = result;
    return result;
  }

  /**
   * 산출기간(청구기간) 해석. 경계 정의는 lib/billing_period.js가 유일한 출처다.
   * checkDay는 0만 말일을 뜻하고 1~31은 월 길이로 클램프된 실제 일자다
   * (이전 구현의 `checkDay >= 28`을 말일로 보는 휴리스틱은 제거됨).
   */
  calcLengthDays() {
    const period = resolveBillingPeriod(this._ret.checkDay, this._ret.today);
    this._ret.checkYear = period.checkYear;
    this._ret.checkMonth = period.checkMonth;
    this._ret.monthDays = period.monthDays;
    this._ret.useDays = period.useDays;
    this._ret.period = period;
  }

  /**
   * Calculate season usage days
   */
  calcLengthUseDays() {
    const { checkYear, checkMonth, energy } = this._ret;
    const superSection = this.RATES.PRICE_BASE.low.kwhSection.winter[2];

    // 달별 일수 분할은 resolveBillingPeriod가 준다. 기간이 한 달 안에 다 들어가면
    // 항목이 하나뿐이므로, 남는 mm2 슬롯은 0일로 두되 요율 조회가 빈 yymm을 보지
    // 않도록 다음 달로 라벨은 채워 둔다.
    const parts = this._ret.period.months;
    const nextYear = checkMonth === 12 ? checkYear + 1 : checkYear;
    const nextMonth = checkMonth === 12 ? 1 : checkMonth + 1;

    const months = [
      {
        mm: 'mm1',
        year: parts[0].year,
        month: parts[0].month,
        days: parts[0].days,
      },
      {
        mm: 'mm2',
        year: parts[1] ? parts[1].year : nextYear,
        month: parts[1] ? parts[1].month : nextMonth,
        days: parts[1] ? parts[1].days : 0,
      },
    ];

    const mmDiff = [];

    for (const {
      mm, year, month, days,
    } of months) {
      let season;
      if ([7, 8].includes(month)) {
        season = 'summer';
      } else if ([12, 1, 2].includes(month) && energy >= superSection) {
        season = 'winter';
      } else {
        season = 'etc';
      }

      const yymm = String((year - 2000) * 100 + month);
      this._ret[mm].yymm = yymm;
      this._ret[mm].season = season;
      this._ret[mm].useDays = days;

      const adjustYymm = this.priceFind(this.RATES.PRICE_ADJUSTMENT, yymm);
      const kwhYymm = this.priceFind(this.RATES.PRICE_KWH, yymm);
      const elecBasicYymm = this.priceFind(this.RATES.PRICE_ELECBASIC, yymm);
      const dcYymm = this.priceFind(this.RATES.PRICE_DC, yymm);

      mmDiff.push(season + adjustYymm + kwhYymm + elecBasicYymm + dcYymm);
    }

    // 시즌이 같고, 단가가 같으면 사용일을 하나로 합치기
    if (mmDiff[0] === mmDiff[1]) {
      this._ret.mm1.useDays += this._ret.mm2.useDays;
      this._ret.mm2.useDays = 0;
    }
  }

  /**
   * Set price for each month
   */
  setPrice() {
    for (const mm of ['mm1', 'mm2']) {
      const { yymm } = this._ret[mm];

      const priceYymmAdjust = this.priceFind(this.RATES.PRICE_ADJUSTMENT, yymm);
      let calcPrice = deepMerge(this.RATES.PRICE_BASE, this.RATES.PRICE_ADJUSTMENT[priceYymmAdjust]);

      const priceYymmKwh = this.priceFind(this.RATES.PRICE_KWH, yymm);
      calcPrice = deepMerge(calcPrice, this.RATES.PRICE_KWH[priceYymmKwh]);

      const priceYymmElec = this.priceFind(this.RATES.PRICE_ELECBASIC, yymm);
      calcPrice = deepMerge(calcPrice, this.RATES.PRICE_ELECBASIC[priceYymmElec]);

      const priceYymmDc = this.priceFind(this.RATES.PRICE_DC, yymm);
      calcPrice = deepMerge(calcPrice, this.RATES.PRICE_DC[priceYymmDc]);

      const priceYymmFund = this.priceFind(this.RATES.BASE_FUND, yymm);
      this._ret[mm].price = deepMerge(calcPrice, this.RATES.BASE_FUND[priceYymmFund]);
    }
  }

  /**
   * Calculate progressive rate (누진요금)
   */
  calcProg() {
    const { energy, pressure, monthDays } = this._ret;
    const { basicPrice } = this.RATES.PRICE_BASE[pressure];

    let basicWonSum = 0;
    let kwhWonSum = 0;
    let climateWonSum = 0;

    for (const mm of ['mm1', 'mm2']) {
      const seasonDays = this._ret[mm].useDays;
      if (seasonDays === 0) continue;

      const calcPrice = this._ret[mm].price;
      const climatePrice = this._ret.climatePrice != null ? this._ret.climatePrice : calcPrice.adjustment[1];
      const { kwhPrice } = calcPrice[pressure];
      const { season } = this._ret[mm];
      const kwhSection = calcPrice[pressure].kwhSection[season];

      let kwhStep = 0;
      let restEnergy = energy;
      let kwhWonSeason = 0;
      let stepEnergyCalcSum = 0;

      for (const stepKwh of kwhSection) {
        if (restEnergy <= 0) break;

        let stepEnergy;
        let stepEnergyCalc;

        if (energy > stepKwh) {
          stepEnergy = stepKwh - (energy - restEnergy);
          restEnergy = energy - stepKwh;
          stepEnergyCalc = (stepEnergy / monthDays) * seasonDays;
        } else {
          stepEnergy = restEnergy;
          restEnergy = 0;
          stepEnergyCalc = ((energy / monthDays) * seasonDays) - stepEnergyCalcSum;
        }

        kwhStep += 1;
        stepEnergyCalcSum += stepEnergyCalc;
        const kwhWon = Math.round(stepEnergyCalc * kwhPrice[kwhStep - 1] * 100) / 100;
        kwhWonSeason += kwhWon;
        kwhWonSum += kwhWon;
      }

      const basicWon = (basicPrice[kwhStep - 1] * seasonDays) / monthDays;
      basicWonSum += basicWon;

      const climateWon = Math.round(((energy * climatePrice * seasonDays) / monthDays) * 100) / 100;
      climateWonSum += climateWon;

      this._ret[mm].basicWon = Math.round(basicWon);
      this._ret[mm].kwhWon = kwhWonSeason;
      this._ret[mm].kwhStep = kwhStep;
      this._ret[mm].stepRate = kwhPrice[kwhStep - 1];
      this._ret[mm].climateWon = climateWon;
    }

    this._ret.basicWon = Math.floor(round2(basicWonSum));
    this._ret.kwhWon = Math.floor(round2(kwhWonSum));
    this._ret.diffWon = 0;
    this._ret.climateWon = Math.floor(round2(climateWonSum));
    // Marginal energy rate of the current progressive step (fixed per tier)
    this._ret.stepRate = this._ret.mm1.useDays > 0 ? this._ret.mm1.stepRate : this._ret.mm2.stepRate;
  }

  /**
   * Calculate fuel adjustment fee (연료비조정액)
   */
  calcFuelWon() {
    const { energy } = this._ret;
    const calcPrice = this._ret.mm1.price;
    const fuelPrice = this._ret.fuelPrice != null ? this._ret.fuelPrice : calcPrice.adjustment[2];
    this._ret.fuelWon = Math.floor(energy * fuelPrice);
  }

  /**
   * Calculate 200kWh or less reduction (200kWh 이하 감액)
   */
  calcElecBasic200() {
    const calcPrice = this._ret.mm1.price;
    const { energy, pressure } = this._ret;
    const { elecBasic200Limit } = calcPrice[pressure];

    if (energy <= 200) {
      this._ret.elecBasicDc = 0;
      let elecBasic200Dc = Math.floor(
        this._ret.basicWon + this._ret.kwhWon + this._ret.climateWon + this._ret.fuelWon,
      );
      if (elecBasic200Dc > elecBasic200Limit) {
        elecBasic200Dc = elecBasic200Limit;
      }
      this._ret.elecBasic200Dc = elecBasic200Dc;
    } else {
      this._ret.elecBasic200Dc = 0;
    }
  }

  /**
   * Calculate vulnerable class reduction (취약계층 경감액)
   */
  calcWeakDc() {
    const {
      energy, monthDays, bigfamDcCfg, welfareDcCfg,
    } = this._ret;

    if (bigfamDcCfg > 0 || welfareDcCfg > 0) {
      for (const mm of ['mm1', 'mm2']) {
        const seasonDays = this._ret[mm].useDays;
        if (seasonDays === 0) continue;

        const { yymm } = this._ret[mm];
        const calcPrice = this._ret[mm].price;
        // 하계 = 7/1~8/31 (요금표 주석 "하계 : 7월 1일~8월 31일"). 이전에는 06을 포함했으나
        // 요금표에 6월을 하계로 보는 근거가 없고, 주택용 누진 계절 구분과도 어긋났다.
        const season = ['07', '08'].includes(yymm.slice(-2)) ? 'summer' : 'etc';
        const dc = calcPrice.dc[season];
        const { weak } = dc;

        if (weak && weak[0] > 0) {
          const weakDc = Math.floor(
            Math.round((Math.min(energy, weak[1]) / monthDays) * seasonDays) * weak[0],
          );
          this._ret[mm].weakDc = weakDc;
        }
      }
      this._ret.weakDc = this._ret.mm1.weakDc + this._ret.mm2.weakDc;
    } else {
      this._ret.mm1.weakDc = 0;
      this._ret.mm2.weakDc = 0;
      this._ret.weakDc = 0;
    }
  }

  /**
   * Calculate welfare discount (복지 요금할인)
   */
  calcWelfareDc() {
    const { welfareDcCfg, monthDays } = this._ret;

    if (welfareDcCfg > 0) {
      for (const mm of ['mm1', 'mm2']) {
        let welfareDc = Math.floor(
          this._ret.basicWon + this._ret.kwhWon + this._ret.climateWon + this._ret.fuelWon,
        );

        const seasonDays = this._ret[mm].useDays;
        if (seasonDays === 0) continue;

        const { yymm } = this._ret[mm];
        const calcPrice = this._ret[mm].price;
        // 하계 = 7/1~8/31 (요금표 주석 "하계 : 7월 1일~8월 31일"). 이전에는 06을 포함했으나
        // 요금표에 6월을 하계로 보는 근거가 없고, 주택용 누진 계절 구분과도 어긋났다.
        const season = ['07', '08'].includes(yymm.slice(-2)) ? 'summer' : 'etc';
        const dc = calcPrice.dc[season];

        switch (welfareDcCfg) {
          case 1: // 유공자, 장애인
            if (welfareDc > dc.b1) welfareDc = dc.b1;
            break;
          case 2: // 사회복지시설
            welfareDc *= dc.b2;
            break;
          case 3: // 기초생활(생계/의료)
            if (welfareDc > dc.b3) welfareDc = dc.b3;
            break;
          case 4: // 기초생활(주거/교육)
            if (welfareDc > dc.b4) welfareDc = dc.b4;
            break;
          case 5: // 차상위계층
            if (welfareDc > dc.b5) welfareDc = dc.b5;
            break;
          default:
            break;
        }

        this._ret[mm].welfareDc = Math.round(((welfareDc / monthDays) * seasonDays * 100)) / 100;
      }
      this._ret.welfareDc = Math.floor(this._ret.mm1.welfareDc + this._ret.mm2.welfareDc);
    } else {
      this._ret.mm1.welfareDc = 0;
      this._ret.mm2.welfareDc = 0;
      this._ret.welfareDc = 0;
    }
  }

  /**
   * Calculate large family discount (대가족 요금할인)
   */
  calcBigfamDc() {
    const {
      bigfamDcCfg, welfareDcCfg, monthDays, elecBasic200Dc,
    } = this._ret;

    if (bigfamDcCfg > 0) {
      for (const mm of ['mm1', 'mm2']) {
        const seasonDays = this._ret[mm].useDays;
        if (seasonDays === 0) continue;

        const { yymm } = this._ret[mm];
        const calcPrice = this._ret[mm].price;
        // 하계 = 7/1~8/31 (요금표 주석 "하계 : 7월 1일~8월 31일"). 이전에는 06을 포함했으나
        // 요금표에 6월을 하계로 보는 근거가 없고, 주택용 누진 계절 구분과도 어긋났다.
        const season = ['07', '08'].includes(yymm.slice(-2)) ? 'summer' : 'etc';
        const dc = calcPrice.dc[season];

        let welfareDcTemp = 0;
        if (welfareDcCfg >= 2) {
          welfareDcTemp = this._ret[mm].welfareDc;
        }

        const { weakDc } = this._ret[mm];
        const fuelWon = Math.floor((this._ret.fuelWon * this._ret[mm].useDays) / this._ret.monthDays);
        const kwhWonDcLimit = Math.floor(this._ret[mm].basicWon)
          + Math.floor(this._ret[mm].kwhWon)
          + Math.floor(this._ret[mm].climateWon)
          + fuelWon;

        const bigfamDc2 = Math.round(((dc.a1[0] / monthDays) * seasonDays * 100)) / 100;
        let bigfamDc1 = Math.round((kwhWonDcLimit - elecBasic200Dc - welfareDcTemp - weakDc) * dc.a1[1]);

        if (bigfamDcCfg === 1) {
          // 5인이상/출산/3자녀
          if (bigfamDc1 > bigfamDc2) {
            bigfamDc1 = bigfamDc2;
          }
        }

        if (bigfamDc1 < 0) {
          bigfamDc1 = 0;
        }

        this._ret[mm].bigfamDc = bigfamDc1;
      }
      this._ret.bigfamDc = Math.floor(this._ret.mm1.bigfamDc + this._ret.mm2.bigfamDc);
    } else {
      this._ret.mm1.bigfamDc = 0;
      this._ret.mm2.bigfamDc = 0;
      this._ret.bigfamDc = 0;
    }
  }

  /**
   * Calculate discount overlap (복지할인 중복계산)
   */
  calcDc() {
    const { welfareDcCfg, bigfamDc, welfareDc } = this._ret;

    // 기초생활(생계·의료/주거·교육)·차상위계층은 대가족 할인과 중복 적용되므로
    // 둘 다 그대로 둔다.
    if (welfareDcCfg >= 3) return;

    // 그 밖의 복지할인은 대가족 할인과 중복되지 않아 더 큰 쪽만 남긴다.
    if (bigfamDc > welfareDc) {
      this._ret.welfareDc = 0;
    } else {
      this._ret.bigfamDc = 0;
    }
  }

  /**
   * 전력산업기반기금 = 전기요금계 x 요율, 10원 미만 절사.
   * 이전에는 누진 경로만 달별로 나눠 floor한 뒤 합산해서 정액·TOU 경로와 결과가
   * 어긋날 수 있었다. 약관상 기금은 전기요금계 총액에 한 번 적용된다.
   */
  baseFund(elecSumWon) {
    const yymm = this._ret.mm1.yymm || this._ret.mm2.yymm;
    const fundKey = this.priceFind(this.RATES.BASE_FUND, yymm);
    const fundP = this.RATES.BASE_FUND[fundKey].baseFundp;
    this._ret.baseFund = Math.floor((elecSumWon * fundP) / 10) * 10;
    return this._ret.baseFund;
  }

  /**
   * Calculate total bill (청구금액)
   */
  calcTotal() {
    const {
      basicWon,
      kwhWon,
      climateWon,
      fuelWon,
      elecBasicDc,
      elecBasic200Dc,
      bigfamDc,
      welfareDc,
      weakDc,
    } = this._ret;

    // 전기요금계
    const elecSumWon = basicWon + kwhWon - elecBasicDc + climateWon + fuelWon
      - elecBasic200Dc - bigfamDc - welfareDc - weakDc;

    let vat; let baseFund; let
      total;
    if (elecSumWon > 0) {
      vat = Math.round(elecSumWon * 0.1); // 부가가치세
      baseFund = this.baseFund(elecSumWon);
      total = Math.floor((elecSumWon + vat + baseFund) / 10) * 10; // 청구금액
    } else {
      vat = 0;
      baseFund = 0;
      total = 0;
    }

    this._ret.elecSumWon = elecSumWon;
    this._ret.vat = vat;
    this._ret.baseFund = baseFund;
    this._ret.total = total;
  }

  /**
   * Commercial/industrial season for a given month (다름: 주택용과 구분).
   * 여름철 6~8월, 겨울철 11~2월, 봄·가을철 3~5월·9~10월.
   */
  commercialSeason(month) {
    if ([6, 7, 8].includes(month)) return 'summer';
    if ([11, 12, 1, 2].includes(month)) return 'winter';
    return 'spring_fall';
  }

  /**
   * Calculate a non-residential flat (계절별 단일요율) bill:
   * 기본요금(원/kW × 계약전력) + 전력량요금(계절별 단일요율 × kWh)
   * + 기후환경요금 + 연료비조정 + 부가세 + 전력기반기금.
   * 누진/시간대별(TOU) 없음. 대가족·복지 할인 미적용.
   */
  calcFlat() {
    const {
      monthDays, energy, contractKw, tariffType,
    } = this._ret;
    const tariff = this.RATES.TARIFF_FLAT[tariffType];
    if (!tariff) {
      throw new Error(`알 수 없는 계약종별: ${tariffType}`);
    }

    const { months } = this._ret.period;

    let basicSum = 0;
    let kwhSum = 0;
    let climateSum = 0;
    let fuelSum = 0;
    let minFloorSum = 0;
    let firstYymm = null;

    for (const { year, month, days } of months) {
      if (days <= 0) continue;

      const season = this.commercialSeason(month);
      const rate = (tariff.kwhFlat != null) ? tariff.kwhFlat : tariff.kwh[season];
      const yymm = String((year - 2000) * 100 + month);
      if (!firstYymm) {
        firstYymm = yymm;
        this._ret.stepRate = rate; // current seasonal energy rate (fixed)
      }

      const adjKey = this.priceFind(this.RATES.PRICE_ADJUSTMENT, yymm);
      const adj = this.RATES.PRICE_ADJUSTMENT[adjKey].adjustment;
      const climatePrice = this._ret.climatePrice != null ? this._ret.climatePrice : adj[1];
      const fuelPrice = this._ret.fuelPrice != null ? this._ret.fuelPrice : adj[2];

      const kwhSeason = (energy * days) / monthDays;

      basicSum += (tariff.basic * contractKw * days) / monthDays;
      kwhSum += kwhSeason * rate;
      climateSum += kwhSeason * climatePrice;
      fuelSum += kwhSeason * fuelPrice;

      // 심야전력(갑) 월 최저요금 (minKwh에 해당하는 전력량요금), 일할 적용
      if (tariff.minKwh) {
        minFloorSum += (tariff.minKwh * rate * days) / monthDays;
      }
    }

    let kwhWon = Math.floor(kwhSum);
    if (tariff.minKwh && kwhWon < Math.floor(minFloorSum)) {
      kwhWon = Math.floor(minFloorSum);
    }

    this._ret.basicWon = Math.floor(basicSum);
    this._ret.kwhWon = kwhWon;
    this._ret.climateWon = Math.floor(climateSum);
    this._ret.fuelWon = Math.floor(fuelSum);
    this._ret.diffWon = 0;
    this._ret.mm1.kwhStep = 0;

    // 전기요금계 (할인 없음)
    const elecSumWon = this._ret.basicWon + this._ret.kwhWon
      + this._ret.climateWon + this._ret.fuelWon;

    let vat = 0;
    let baseFund = 0;
    let total = 0;
    if (elecSumWon > 0) {
      vat = Math.round(elecSumWon * 0.1);
      const fundKey = this.priceFind(this.RATES.BASE_FUND, firstYymm || '9999');
      const fundP = this.RATES.BASE_FUND[fundKey].baseFundp;
      baseFund = Math.floor((elecSumWon * fundP) / 10) * 10;
      total = Math.floor((elecSumWon + vat + baseFund) / 10) * 10;
    }

    this._ret.elecSumWon = elecSumWon;
    this._ret.vat = vat;
    this._ret.baseFund = baseFund;
    this._ret.total = total;
  }

  /**
   * Calculate a time-of-use (시간대별) bill from load-period buckets.
   * @param {{off:number, mid:number, peak:number}} buckets - 경/중/최대부하 kWh
   * 전력량요금 = Σ(부하별 kWh × 계절별 시간대 단가) + 기본요금(원/kW × 계약전력)
   * + 기후환경요금 + 연료비조정 + 부가세 + 전력기반기금. 누진/할인 없음.
   * 계절은 청구기간 시작월 기준(계절 경계에 걸치는 소수 기간은 근사).
   */
  calcTou(buckets) {
    const { contractKw, tariffType } = this._ret;
    const tariff = this.RATES.TARIFF_TOU[tariffType];
    if (!tariff) {
      throw new Error(`알 수 없는 TOU 계약종별: ${tariffType}`);
    }

    // 계절별 x 부하시간대별로 적재된 사용량에 각각의 단가를 적용한다. 이전에는 산출기간
    // 시작월 하나로 계절을 정해 기간 전체에 적용했는데, 계절이 걸치는 기간(예: 5/9~6/8)은
    // 여름철 사용량이 봄·가을철 단가로 계산됐다. 최대부하는 계절 간 단가 차이가 50%를
    // 넘는다.
    let kwhSum = 0;
    let totalKwh = 0;
    for (const season of ['summer', 'spring_fall', 'winter']) {
      const bySeason = buckets[season];
      if (!bySeason) continue;
      for (const period of ['off', 'mid', 'peak']) {
        const kwh = bySeason[period] || 0;
        if (!kwh) continue;
        kwhSum += kwh * tariff[period][season];
        totalKwh += kwh;
      }
    }

    const yymm = this._ret.mm1.yymm || String((this._ret.checkYear - 2000) * 100 + this._ret.checkMonth);
    const adjKey = this.priceFind(this.RATES.PRICE_ADJUSTMENT, yymm);
    const adj = this.RATES.PRICE_ADJUSTMENT[adjKey].adjustment;
    const climatePrice = this._ret.climatePrice != null ? this._ret.climatePrice : adj[1];
    const fuelPrice = this._ret.fuelPrice != null ? this._ret.fuelPrice : adj[2];

    this._ret.basicWon = Math.floor(tariff.basic * contractKw);
    this._ret.kwhWon = Math.floor(round2(kwhSum));
    this._ret.climateWon = Math.floor(round2(totalKwh * climatePrice));
    this._ret.fuelWon = Math.floor(round2(totalKwh * fuelPrice));
    this._ret.diffWon = 0;
    this._ret.mm1.kwhStep = 0;

    const elecSumWon = this._ret.basicWon + this._ret.kwhWon
      + this._ret.climateWon + this._ret.fuelWon;

    let vat = 0;
    let baseFund = 0;
    let total = 0;
    if (elecSumWon > 0) {
      vat = Math.round(elecSumWon * 0.1);
      baseFund = this.baseFund(elecSumWon);
      total = Math.floor((elecSumWon + vat + baseFund) / 10) * 10;
    }

    this._ret.elecSumWon = elecSumWon;
    this._ret.vat = vat;
    this._ret.baseFund = baseFund;
    this._ret.total = total;
  }

  /**
   * Calculate electricity bill from kWh usage
   * @param {number} energy - 전기 사용량 (kWh)
   * @param {Date} today - 계산 기준일 (optional)
   * @returns {Object} 계산된 요금 정보
   */
  calculate(energy, today = null, touBuckets = null) {
    try {
      const energyValue = parseFloat(energy);
      this._ret.energy = energyValue === 0 ? 0.0001 : energyValue;

      if (today) {
        this._ret.today = today;
      }

      this.calcLengthDays();

      // Non-residential tariffs use separate engines.
      if (this._ret.tariffType && this._ret.tariffType !== 'residential') {
        // 비주택 종별도 달별 라벨이 필요하다(기금·기후환경 요율 버전 조회에 쓰인다).
        const first = this._ret.period.months[0];
        this._ret.mm1.yymm = String((first.year - 2000) * 100 + first.month);
        if (this.RATES.TARIFF_TOU && this.RATES.TARIFF_TOU[this._ret.tariffType]) {
          this.calcTou(touBuckets || emptyTouBuckets());
        } else {
          this.calcFlat();
        }
        return this._ret;
      }

      this.calcLengthUseDays();
      this.setPrice();
      this.calcProg();
      this.calcFuelWon();

      if (this._ret.bigfamDcCfg || this._ret.welfareDcCfg) {
        this.calcWeakDc();
        this.calcElecBasic200();
        this.calcWelfareDc();
        this.calcBigfamDc();
        this.calcDc();
      }

      this.calcTotal();
      return this._ret;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('전기요금 계산 중 오류 발생:', error);
      throw error;
    }
  }

  /**
   * Get simple bill summary
   * @param {number} energy - 전기 사용량 (kWh)
   * @returns {Object} 간단한 요금 정보
   */
  getSimpleBill(energy, touBuckets = null) {
    const result = this.calculate(energy, null, touBuckets);
    return {
      energy: result.energy,
      basicWon: result.basicWon,
      kwhWon: result.kwhWon,
      climateWon: result.climateWon,
      fuelWon: result.fuelWon,
      elecSumWon: result.elecSumWon,
      vat: result.vat,
      baseFund: result.baseFund,
      total: result.total,
      kwhStep: result.mm1.kwhStep || result.mm2.kwhStep,
      stepRate: result.stepRate,
    };
  }

  /**
   * Get first step kWh rate (1단계 전력량 요금)
   * @returns {number} 1단계 전력량 요금 (원/kWh)
   */
  getFirstStepRate() {
    const pressure = this._ret.pressure || 'low';
    const { kwhPrice } = this.RATES.PRICE_BASE[pressure];
    return kwhPrice[0] || 0;
  }

  /** 현재 계약종별이 시간대별(TOU) 요금제인지 여부 */
  isTouTariff() {
    return !!(this.RATES.TARIFF_TOU && this.RATES.TARIFF_TOU[this._ret.tariffType]);
  }

  /**
   * TOU 요금제에서 특정 부하시간대(off/mid/peak)의 현재 계절 단가.
   * 시각에 따라만 바뀌므로 시간대 내에서는 고정.
   * @param {string} period - 'off' | 'mid' | 'peak'
   * @returns {number|null} 원/kWh
   */
  getTouRate(period) {
    const tariff = this.RATES.TARIFF_TOU && this.RATES.TARIFF_TOU[this._ret.tariffType];
    if (!tariff || !tariff[period]) return null;
    const season = this.commercialSeason(this._ret.checkMonth || (new Date()).getMonth() + 1);
    return tariff[period][season];
  }
}

module.exports = KoreaElecBillCalculator;
module.exports.emptyTouBuckets = emptyTouBuckets;
