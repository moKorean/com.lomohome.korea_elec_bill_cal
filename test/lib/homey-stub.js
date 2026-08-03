/*
 * Homey 런타임 스텁 — device.js를 실제 코드 그대로 구동하기 위한 최소 환경.
 *
 * device.js는 `require('homey')`와 Device 인스턴스 메서드(getStoreValue,
 * setCapabilityValue, ...)에 의존한다. 로직을 테스트로 다시 옮겨 적으면 원본과
 * 어긋나므로, 모듈 로더를 가로채 실제 device.js를 그대로 로드한다.
 */

/*
 * eslint-disable max-classes-per-file --
 * 가짜 런타임을 조립하는 파일이라 성격이 다른 클래스가 함께 있어야 한다:
 * Device 베이스 스텁, 가상 시계(SimDate), 그리고 테스트용 Device 서브클래스.
 */
/* eslint-disable max-classes-per-file */

'use strict';

const Module = require('module');

// require('homey')를 가로채 Device 베이스 클래스만 제공한다.
// device.js를 require하기 전에 설치되어야 한다.
const origLoad = Module._load;
Module._load = function stubbedLoad(request, ...rest) {
  if (request === 'homey') return { Device: class HomeyDeviceStub {} };
  return origLoad.call(this, request, ...rest);
};

const KoreaElecDevice = require('../../drivers/korea_elec/device');
const MANIFEST = require('../../app.json').drivers[0].capabilities;

/*
 * 가상 시계. device.js가 내부에서 `new Date()`를 호출하므로 전역 Date를 갈아끼워야
 * 시간 경과를 시뮬레이션할 수 있다. clock.set(null)이면 실제 시각으로 돌아간다.
 */
const RealDate = Date;
let simNow = null;

class SimDate extends RealDate {
  constructor(...args) {
    if (args.length === 0 && simNow !== null) {
      super(simNow);
      return;
    }
    super(...args);
  }

  static now() {
    return simNow !== null ? simNow : RealDate.now();
  }
}

const clock = {
  /** KST 벽시계 기준으로 현재 시각을 고정한다. */
  setKst(y, m, d, h, mi = 0) {
    simNow = RealDate.UTC(y, m - 1, d, h - 9, mi);
    return simNow;
  },
  reset() {
    simNow = null;
  },
  install() {
    global.Date = SimDate;
  },
  restore() {
    global.Date = RealDate;
    simNow = null;
  },
  /** 테스트 기대값 계산용 — 가상 시계에 영향받지 않는 KST epoch. */
  kst(y, m, d, h, mi = 0) {
    return RealDate.UTC(y, m - 1, d, h - 9, mi);
  },
};

/**
 * 스텁 Device 인스턴스 생성.
 * @param {object} [opts]
 * @param {string[]} [opts.capabilities] 디바이스가 현재 가진 capability 목록
 * @param {object} [opts.settings] 디바이스 설정 오버라이드
 */
function makeDevice(opts = {}) {
  const caps = opts.capabilities ? [...opts.capabilities] : [...MANIFEST];
  const settings = {
    pressure: 'low',
    check_day: 8,
    tariff_type: 'residential',
    budget_won: 0,
    ...opts.settings,
  };

  class FakeDevice extends KoreaElecDevice {
    constructor() {
      super();
      this.store = {};
      this.caps = caps;
      this.capValues = {};
      this.settings = settings;
      this.timeZone = 'Asia/Seoul';
      this.warnings = [];
      this.timers = new Map();
      this.nextTimerId = 1;
      // 스텁 타이머: 자동으로 발화하지 않고 runTimer()로 테스트가 직접 돌린다.
      this.homey = {
        clock: { getTimezone: () => 'Asia/Seoul' },
        __: (k) => k,
        app: { api: opts.api === undefined ? {} : opts.api, apiGeneration: opts.apiGeneration || 1 },
        setTimeout: (fn, ms) => {
          const id = this.nextTimerId++;
          this.timers.set(id, { fn, ms, kind: 'timeout' });
          return id;
        },
        clearTimeout: (id) => this.timers.delete(id),
        setInterval: (fn, ms) => {
          const id = this.nextTimerId++;
          this.timers.set(id, { fn, ms, kind: 'interval' });
          return id;
        },
        clearInterval: (id) => this.timers.delete(id),
      };
      this.logs = [];
      this.driver = {
        manifest: { capabilities: MANIFEST },
        triggerNewBillingPeriod: async () => {},
        triggerKwhStepChanged: async () => {},
        triggerKwhStepIncreased: async () => {},
        triggerMoneyExceeds: async () => {},
        triggerBudgetExceeded: async () => {},
      };
    }

    log(...a) {
      this.logs.push(a.join(' '));
    }

    error(...a) {
      this.logs.push(`ERROR ${a.join(' ')}`);
    }

    getName() {
      return 'test-device';
    }

    getSettings() {
      return this.settings;
    }

    async setSettings(s) {
      Object.assign(this.settings, s);
    }

    getCapabilities() {
      return this.caps;
    }

    hasCapability(c) {
      return this.caps.includes(c);
    }

    async addCapability(c) {
      if (!this.caps.includes(c)) this.caps.push(c);
    }

    async removeCapability(c) {
      this.caps = this.caps.filter((x) => x !== c);
    }

    async setCapabilityValue(c, v) {
      if (!this.caps.includes(c)) throw new Error(`no such capability: ${c}`);
      this.capValues[c] = v;
    }

    async setWarning(msg) {
      this.warnings.push(msg);
    }

    async unsetWarning() {
      this.warnings.push(null);
    }

    /** 예약된 타이머를 수동으로 실행한다 (kind로 골라서). */
    async runTimers(kind) {
      const entries = [...this.timers.entries()].filter(([, t]) => t.kind === kind);
      for (const [id, t] of entries) {
        if (t.kind === 'timeout') this.timers.delete(id);
        await t.fn();
      }
      return entries.length;
    }

    async getStoreValue(k) {
      return this.store[k];
    }

    async setStoreValue(k, v) {
      this.store[k] = v;
    }
  }

  return new FakeDevice();
}

/** 검침 기준점을 잡아 산출기간 시작 상태로 초기화한다. */
async function primeDevice(dev, {
  meter = 0, day, hour, year = 2026,
} = {}) {
  dev.initCalculator();
  await dev.initMeterValues();
  dev.lastMeterValue = meter;
  dev.monthStartMeter = meter;
  dev.yearStartMeter = meter;
  dev.dayStartMeter = meter;
  dev.todayStartMeter = meter;
  dev.lastBillingPeriod = dev.getCurrentBillingPeriod();
  dev.lastReadingDay = { day };
  dev.lastReadingHour = { hour };
  dev.lastReadingYear = { year };
  return dev;
}

module.exports = {
  makeDevice, primeDevice, clock, MANIFEST,
};
