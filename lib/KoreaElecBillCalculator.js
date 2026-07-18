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

// Load rates data
let RATES_DATA = null;
try {
  const ratesPath = path.join(__dirname, 'rates_korea.json');
  const ratesContent = fs.readFileSync(ratesPath, 'utf8');
  RATES_DATA = JSON.parse(ratesContent);
} catch (e) {
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
 * Get last day of month
 */
function lastDayOfMonth(date) {
  const nextMonth = new Date(date.getFullYear(), date.getMonth() + 1, 1);
  return new Date(nextMonth - 1).getDate();
}

class KoreaElecBillCalculator {
  /**
   * @param {Object} options
   * @param {string} options.pressure - 'low' (저압) or 'high' (고압)
   * @param {number} options.checkDay - 검침일 (1-31, 0 or >=28 for 말일)
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
   * Calculate forecast energy usage
   */
  energyForecast(energy, today = null) {
    if (today) {
      this._ret.today = today;
    }
    this.calcLengthDays();

    const { useDays, monthDays, checkMonth, checkDay } = this._ret;
    const currentToday = this._ret.today;

    const minutesUsed = ((useDays - 1) * 24 + currentToday.getHours()) * 60 + currentToday.getMinutes() + 1;
    const totalMinutes = monthDays * 24 * 60;
    const forecast = Math.round((energy / minutesUsed) * totalMinutes * 10) / 10;

    return {
      forecast,
      monthDays,
      useDays,
      checkMonth,
      checkDay,
      today: currentToday.getDate(),
    };
  }

  /**
   * Calculate month length and usage days
   */
  calcLengthDays() {
    const today = this._ret.today;
    let { checkDay } = this._ret;
    let checkYear; let checkMonth; let monthDays; let
      useDays;

    if (checkDay === 0 || checkDay >= 28) {
      // 검침일이 말일
      const lastDay = lastDayOfMonth(today);
      if (today.getDate() === lastDay) {
        // 오늘이 말일 = 시작일
        const nextMonth = new Date(today.getFullYear(), today.getMonth() + 1, 1);
        checkYear = today.getFullYear();
        checkMonth = today.getMonth() + 1;
        monthDays = lastDayOfMonth(nextMonth);
        useDays = 1;
        checkDay = today.getDate();
      } else {
        const prevLastDay = new Date(today.getFullYear(), today.getMonth(), 0);
        checkYear = prevLastDay.getFullYear();
        checkMonth = prevLastDay.getMonth() + 1;
        monthDays = lastDay;
        useDays = today.getDate() + 1;
        checkDay = prevLastDay.getDate();
      }
    } else if (today.getDate() >= checkDay) {
      // 오늘이 검침일보다 크면
      monthDays = lastDayOfMonth(today);
      useDays = today.getDate() - checkDay + 1;
      checkYear = today.getFullYear();
      checkMonth = today.getMonth() + 1;
    } else {
      // 오늘이 검침일보다 작으면
      const prevMonth = new Date(today.getFullYear(), today.getMonth(), 0);
      monthDays = prevMonth.getDate();
      useDays = monthDays + today.getDate() - checkDay + 1;
      checkYear = prevMonth.getFullYear();
      checkMonth = prevMonth.getMonth() + 1;
    }

    this._ret.checkYear = checkYear;
    this._ret.checkMonth = checkMonth;
    this._ret.monthDays = monthDays;
    this._ret.useDays = useDays;
    if (checkDay >= 28) {
      this._ret.checkDay = checkDay;
    }
  }

  /**
   * Calculate season usage days
   */
  calcLengthUseDays() {
    const { checkDay, checkYear, checkMonth, monthDays, energy } = this._ret;
    const superSection = this.RATES.PRICE_BASE.low.kwhSection.winter[2];

    let nextYear = checkYear;
    let nextMonth = checkMonth + 1;
    if (checkMonth === 12) {
      nextYear = checkYear + 1;
      nextMonth = 1;
    }

    const months = [
      { mm: 'mm1', year: checkYear, month: checkMonth, days: monthDays - checkDay + 1 },
      { mm: 'mm2', year: nextYear, month: nextMonth, days: checkDay - 1 },
    ];

    const mmDiff = [];

    for (const { mm, year, month, days } of months) {
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
      const yymm = this._ret[mm].yymm;

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
    const basicPrice = this.RATES.PRICE_BASE[pressure].basicPrice;

    let basicWonSum = 0;
    let kwhWonSum = 0;
    let diffWonSum = 0;
    let climateWonSum = 0;

    for (const mm of ['mm1', 'mm2']) {
      const seasonDays = this._ret[mm].useDays;
      if (seasonDays === 0) continue;

      const calcPrice = this._ret[mm].price;
      const diffPrice = calcPrice.adjustment[0];
      const climatePrice = this._ret.climatePrice != null ? this._ret.climatePrice : calcPrice.adjustment[1];
      const kwhPrice = calcPrice[pressure].kwhPrice;
      const season = this._ret[mm].season;
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
          stepEnergyCalc = Math.round((stepEnergy / monthDays) * seasonDays);
        } else {
          stepEnergy = restEnergy;
          restEnergy = 0;
          stepEnergyCalc = Math.round((energy / monthDays) * seasonDays) - stepEnergyCalcSum;
        }

        kwhStep += 1;
        stepEnergyCalcSum += stepEnergyCalc;
        const kwhWon = Math.round(stepEnergyCalc * kwhPrice[kwhStep - 1] * 100) / 100;
        const diffWon = Math.round(stepEnergyCalc * diffPrice * 100) / 100;
        kwhWonSeason += kwhWon + diffWon;
        kwhWonSum += kwhWon + diffWon;
      }

      const basicWon = (basicPrice[kwhStep - 1] * seasonDays) / monthDays;
      basicWonSum += basicWon;

      const diffWon = Math.round(((energy * diffPrice * seasonDays) / monthDays) * 100) / 100;
      diffWonSum += diffWon;

      const climateWon = Math.round(((energy * climatePrice * seasonDays) / monthDays) * 100) / 100;
      climateWonSum += climateWon;

      this._ret[mm].basicWon = Math.round(basicWon);
      this._ret[mm].kwhWon = kwhWonSeason;
      this._ret[mm].kwhStep = kwhStep;
      this._ret[mm].stepRate = kwhPrice[kwhStep - 1];
      this._ret[mm].diffWon = diffWon;
      this._ret[mm].climateWon = climateWon;
    }

    this._ret.basicWon = Math.floor(basicWonSum);
    this._ret.kwhWon = Math.floor(kwhWonSum - diffWonSum);
    this._ret.diffWon = Math.floor(diffWonSum);
    this._ret.climateWon = Math.floor(climateWonSum);
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
   * Calculate essential usage guarantee deduction (필수사용량 보장공제)
   */
  calcElecBasic() {
    for (const mm of ['mm1', 'mm2']) {
      const seasonDays = this._ret[mm].useDays;
      if (seasonDays === 0) continue;

      const calcPrice = this._ret[mm].price;
      const { monthDays, energy, pressure } = this._ret;
      const elecBasicLimit = calcPrice[pressure].elecBasicLimit[0];
      const elecBasicKwh = calcPrice[pressure].elecBasicLimit[1];

      if (elecBasicLimit > 0 && energy <= elecBasicKwh) {
        let elecBasicDc = Math.floor(
          this._ret.basicWon + this._ret.kwhWon + this._ret.diffWon + this._ret.fuelWon - 1000,
        );
        if (elecBasicDc > elecBasicLimit) {
          elecBasicDc = elecBasicLimit;
        }
        elecBasicDc = Math.floor(((elecBasicDc * seasonDays) / monthDays) * 100) / 100;
        this._ret[mm].elecBasicDc = elecBasicDc;
      } else {
        this._ret[mm].elecBasicDc = 0;
      }
    }
    this._ret.elecBasicDc = Math.floor(this._ret.mm1.elecBasicDc + this._ret.mm2.elecBasicDc);
  }

  /**
   * Calculate 200kWh or less reduction (200kWh 이하 감액)
   */
  calcElecBasic200() {
    const calcPrice = this._ret.mm1.price;
    const { energy, pressure } = this._ret;
    const elecBasic200Limit = calcPrice[pressure].elecBasic200Limit;

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
    const { energy, monthDays, bigfamDcCfg, welfareDcCfg } = this._ret;

    if (bigfamDcCfg > 0 || welfareDcCfg > 0) {
      for (const mm of ['mm1', 'mm2']) {
        const seasonDays = this._ret[mm].useDays;
        if (seasonDays === 0) continue;

        const yymm = this._ret[mm].yymm;
        const calcPrice = this._ret[mm].price;
        const season = yymm.slice(-2) in ['06', '07', '08'] ? 'summer' : 'etc';
        const dc = calcPrice.dc[season];
        const weak = dc.weak;

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

        const yymm = this._ret[mm].yymm;
        const calcPrice = this._ret[mm].price;
        const season = ['06', '07', '08'].includes(yymm.slice(-2)) ? 'summer' : 'etc';
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
    const { bigfamDcCfg, welfareDcCfg, monthDays, elecBasic200Dc } = this._ret;

    if (bigfamDcCfg > 0) {
      for (const mm of ['mm1', 'mm2']) {
        const seasonDays = this._ret[mm].useDays;
        if (seasonDays === 0) continue;

        const yymm = this._ret[mm].yymm;
        const calcPrice = this._ret[mm].price;
        const season = ['06', '07', '08'].includes(yymm.slice(-2)) ? 'summer' : 'etc';
        const dc = calcPrice.dc[season];

        let welfareDcTemp = 0;
        if (welfareDcCfg >= 2) {
          welfareDcTemp = this._ret[mm].welfareDc;
        }

        const weakDc = this._ret[mm].weakDc;
        const fuelWon = Math.floor((this._ret.fuelWon * this._ret[mm].useDays) / this._ret.monthDays);
        const kwhWonDcLimit = Math.floor(this._ret[mm].basicWon)
          + Math.floor(this._ret[mm].kwhWon)
          - Math.floor(this._ret[mm].diffWon)
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

    if (welfareDcCfg >= 3) {
      // 중복할인
      // dcValue = Math.floor(bigfamDc + welfareDc);
    } else {
      // 더 큰 것
      if (bigfamDc > welfareDc) {
        this._ret.welfareDc = 0;
      } else {
        this._ret.bigfamDc = 0;
      }
    }
  }

  /**
   * Calculate electricity industry base fund (전력산업기반기금)
   */
  baseFund(elecSumWon) {
    let baseFund = 0;
    for (const mm of ['mm1', 'mm2']) {
      const baseFundP = this._ret[mm].price.baseFundp;
      baseFund = Math.floor(
        elecSumWon * baseFundP * (this._ret[mm].useDays / this._ret.monthDays),
      );
      this._ret[mm].baseFund = baseFund;
    }
    this._ret.baseFund = Math.floor((this._ret.mm1.baseFund + this._ret.mm2.baseFund) / 10) * 10;
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
  _commercialSeason(month) {
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
      checkDay, checkYear, checkMonth, monthDays, energy, contractKw, tariffType,
    } = this._ret;
    const tariff = this.RATES.TARIFF_FLAT[tariffType];
    if (!tariff) {
      throw new Error(`알 수 없는 계약종별: ${tariffType}`);
    }

    let nextYear = checkYear;
    let nextMonth = checkMonth + 1;
    if (checkMonth === 12) {
      nextYear = checkYear + 1;
      nextMonth = 1;
    }
    const months = [
      { year: checkYear, month: checkMonth, days: monthDays - checkDay + 1 },
      { year: nextYear, month: nextMonth, days: checkDay - 1 },
    ];

    let basicSum = 0;
    let kwhSum = 0;
    let climateSum = 0;
    let fuelSum = 0;
    let minFloorSum = 0;
    let firstYymm = null;

    for (const { year, month, days } of months) {
      if (days <= 0) continue;

      const season = this._commercialSeason(month);
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
    const {
      checkYear, checkMonth, contractKw, tariffType,
    } = this._ret;
    const tariff = this.RATES.TARIFF_TOU[tariffType];
    if (!tariff) {
      throw new Error(`알 수 없는 TOU 계약종별: ${tariffType}`);
    }

    const season = this._commercialSeason(checkMonth);
    const off = buckets.off || 0;
    const mid = buckets.mid || 0;
    const peak = buckets.peak || 0;
    const totalKwh = off + mid + peak;

    const kwhSum = off * tariff.off[season]
      + mid * tariff.mid[season]
      + peak * tariff.peak[season];

    const yymm = String((checkYear - 2000) * 100 + checkMonth);
    const adjKey = this.priceFind(this.RATES.PRICE_ADJUSTMENT, yymm);
    const adj = this.RATES.PRICE_ADJUSTMENT[adjKey].adjustment;
    const climatePrice = this._ret.climatePrice != null ? this._ret.climatePrice : adj[1];
    const fuelPrice = this._ret.fuelPrice != null ? this._ret.fuelPrice : adj[2];

    this._ret.basicWon = Math.floor(tariff.basic * contractKw);
    this._ret.kwhWon = Math.floor(kwhSum);
    this._ret.climateWon = Math.floor(totalKwh * climatePrice);
    this._ret.fuelWon = Math.floor(totalKwh * fuelPrice);
    this._ret.diffWon = 0;
    this._ret.mm1.kwhStep = 0;

    const elecSumWon = this._ret.basicWon + this._ret.kwhWon
      + this._ret.climateWon + this._ret.fuelWon;

    let vat = 0;
    let baseFund = 0;
    let total = 0;
    if (elecSumWon > 0) {
      vat = Math.round(elecSumWon * 0.1);
      const fundKey = this.priceFind(this.RATES.BASE_FUND, yymm);
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
        if (this.RATES.TARIFF_TOU && this.RATES.TARIFF_TOU[this._ret.tariffType]) {
          this.calcTou(touBuckets || { off: 0, mid: 0, peak: 0 });
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
      } else {
        this.calcElecBasic();
      }

      this.calcTotal();
      return this._ret;
    } catch (error) {
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
    const kwhPrice = this.RATES.PRICE_BASE[pressure].kwhPrice;
    return kwhPrice[0] || 0;
  }

  /** 현재 계약종별이 시간대별(TOU) 요금제인지 여부 */
  isTouTariff() {
    return !!(this.RATES.TARIFF_TOU && this.RATES.TARIFF_TOU[this._ret.tariffType]);
  }
}

module.exports = KoreaElecBillCalculator;
