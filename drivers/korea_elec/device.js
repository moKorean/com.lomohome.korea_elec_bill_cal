/*
 * Korea Electricity Bill Calculator Device
 * Copyright 2024, Geunwon Mo (mokorean@gmail.com)
 *
 * Based on Power by the Hour by Robin de Gruijter
 * Korean electricity rate calculation based on kwh_to_won by dugurs
 */

'use strict';

const { Device } = require('homey');
const KoreaElecBillCalculator = require('../../lib/KoreaElecBillCalculator');
const { emptyTouBuckets } = require('../../lib/KoreaElecBillCalculator');
const { isPublicHoliday, lunarSupported } = require('../../lib/kr_holidays');
const { resolveBillingPeriod, resolvePreviousBillingPeriod } = require('../../lib/billing_period');

class KoreaElecDevice extends Device {

  async onInit() {
    this.log('Korea Electricity Meter device initialized');

    // Initialize settings
    this.settings = this.getSettings();
    this.timeZone = this.homey.clock.getTimezone();

    // Add any capabilities introduced after this device was paired
    await this.ensureCapabilities();

    // Initialize calculator
    this.initCalculator();

    // 음력 공휴일(설날·부처님오신날·추석) 계산은 런타임 ICU의 dangi 달력에 의존한다.
    // 미지원이면 해당 날짜만 평일로 계량되므로 조용히 넘어가지 않고 남긴다.
    if (this.tariffIsTou && !lunarSupported()) {
      this.log('WARN: ICU dangi calendar unavailable — 음력 공휴일(설날·추석 등)은 평일로 계량됩니다');
    }

    // Initialize meter values
    await this.initMeterValues();

    // Setup source device listener
    await this.setupSourceDevice();

    // API 재연결 감지 + 데이터 신선도 감시
    this.startWatchdog();

    this.log(`Device ${this.getName()} is ready`);
  }

  /**
   * Sync an already-paired device's capability list with the driver manifest, so
   * an app update surfaces new sensors without re-pairing the device.
   *
   * Homey never touches an existing device's capabilities on update, and
   * addCapability() always appends — so manifest order is never applied by
   * itself and a new sensor would land at the bottom of the list.
   *
   * removeCapability() discards that capability's Insights history, so the
   * rebuild starts at the first position where the device diverges from the
   * manifest; everything before that point is left untouched. The applied
   * layout is stored, so a manifest that fails to stick can never put the
   * device into a rebuild-on-every-restart loop.
   */
  async ensureCapabilities() {
    const wanted = (this.driver.manifest && this.driver.manifest.capabilities) || [];
    if (!wanted.length) {
      this.error('Driver manifest lists no capabilities — skipping capability sync');
      return;
    }

    const signature = wanted.join('|');
    const current = this.getCapabilities();
    if (current.length === wanted.length && current.every((cap, i) => cap === wanted[i])) {
      await this.setStoreValue('capabilityLayout', signature);
      return;
    }

    // 이 매니페스트로 이미 한 번 재구성했는데도 순서가 다르면, 반복 삭제로 인사이트를
    // 계속 날리지 않도록 누락된 것만 덧붙이는 비파괴 경로로 물러난다.
    if (await this.getStoreValue('capabilityLayout') === signature) {
      for (const cap of wanted) {
        if (!this.hasCapability(cap)) {
          try {
            await this.addCapability(cap);
            this.log(`Added missing capability: ${cap}`);
          } catch (e) {
            this.error(`addCapability(${cap}) failed:`, e);
          }
        }
      }
      return;
    }

    let from = 0;
    while (from < current.length && from < wanted.length && current[from] === wanted[from]) {
      from += 1;
    }

    this.log(`Capability sync from index ${from}: [${current.slice(from).join(', ')}]`
      + ` -> [${wanted.slice(from).join(', ')}]`);

    for (const cap of current.slice(from).reverse()) {
      try {
        await this.removeCapability(cap);
      } catch (e) {
        this.error(`removeCapability(${cap}) failed:`, e);
      }
    }
    for (const cap of wanted.slice(from)) {
      try {
        await this.addCapability(cap);
      } catch (e) {
        this.error(`addCapability(${cap}) failed:`, e);
      }
    }

    await this.setStoreValue('capabilityLayout', signature);
    this.log(`Capability sync done: ${this.getCapabilities().join(', ')}`);
  }

  /** 사용자 시간대의 벽시계 시각. Homey 런타임의 new Date()는 UTC라 그대로 쓰면 안 된다. */
  nowLocal(now = new Date()) {
    return new Date(now.toLocaleString('en-US', { timeZone: this.timeZone }));
  }

  initCalculator() {
    try {
      const tariffType = this.settings.tariff_type || 'residential';
      const isResidential = (tariffType === 'residential');
      // Climate/fuel adjustment: auto (built-in rates) by default, manual override otherwise
      const useAuto = this.settings.use_auto_adjustment !== false;
      this.calculator = new KoreaElecBillCalculator({
        pressure: this.settings.pressure || 'low',
        tariffType: isResidential ? 'residential' : tariffType,
        contractKw: this.settings.contract_kw || 0,
        climatePrice: useAuto ? null : (this.settings.climate_price ?? null),
        fuelPrice: useAuto ? null : (this.settings.fuel_price ?? null),
        checkDay: this.settings.check_day || 1,
        // 계산기는 산출기간 경계를 날짜로 판정하므로 반드시 사용자 시간대의 벽시계를 받아야 한다.
        today: this.nowLocal(),
        bigfamDcCfg: parseInt(this.settings.bigfam_dc, 10) || 0,
        welfareDcCfg: parseInt(this.settings.welfare_dc, 10) || 0,
      });
      this.tariffIsTou = this.calculator.isTouTariff();
    } catch (error) {
      this.error('Failed to initialize calculator:', error);
    }
  }

  /**
   * 직전(끝난) 청구기간 기준으로 구성한 계산기.
   * 검침일 롤오버 시 지난 기간 요금을 확정할 때 쓴다 — 그 기간의 계절·요율로 계산해야 한다.
   */
  calculatorForEndedPeriod(nowLocal) {
    const checkDay = this.settings.check_day || 1;
    const ended = resolvePreviousBillingPeriod(checkDay, nowLocal);
    // 끝난 기간의 마지막 날(= 그 기간의 검침일)을 기준일로 준다.
    const asOf = new Date(ended.checkYear, ended.checkMonth - 1, ended.startDay, 12, 0, 0);
    asOf.setDate(asOf.getDate() + ended.monthDays - 1);

    const tariffType = this.settings.tariff_type || 'residential';
    const useAuto = this.settings.use_auto_adjustment !== false;
    return new KoreaElecBillCalculator({
      pressure: this.settings.pressure || 'low',
      tariffType: tariffType === 'residential' ? 'residential' : tariffType,
      contractKw: this.settings.contract_kw || 0,
      climatePrice: useAuto ? null : (this.settings.climate_price ?? null),
      fuelPrice: useAuto ? null : (this.settings.fuel_price ?? null),
      checkDay,
      today: asOf,
      bigfamDcCfg: parseInt(this.settings.bigfam_dc, 10) || 0,
      welfareDcCfg: parseInt(this.settings.welfare_dc, 10) || 0,
    });
  }

  /**
   * 시(hour) 기준 부하시간대.
   * 경부하(off) 22-08시(전계절); 여름·봄가을 최대(peak) 15-21시, 그 외 중간(mid);
   * 겨울 최대 09-12·16-19시, 그 외 중간.
   */
  touPeriodByHour(nowLocal) {
    const h = nowLocal.getHours();
    const m = nowLocal.getMonth() + 1;
    const winter = [11, 12, 1, 2].includes(m);
    if (h >= 22 || h < 8) return 'off';
    if (winter) {
      if ((h >= 9 && h < 12) || (h >= 16 && h < 19)) return 'peak';
      return 'mid';
    }
    if (h >= 15 && h < 21) return 'peak';
    return 'mid';
  }

  /**
   * Time-of-use load period for a given local time (시간대 판정).
   *
   * 한전 「계절별·시간대별 구분」의 토요일·공휴일 계량 특례를 적용한다
   * (docs/2026_kr_bills.pdf, 임시공휴일 제외):
   *  - 공휴일(일요일 포함) : 최대수요전력 및 사용전력량 → 경부하 시간대로 계량
   *  - 토요일             : 최대부하 시간대의 사용전력량 → 중간부하 시간대로 계량
   */
  touPeriod(nowLocal) {
    const dow = nowLocal.getDay();
    const holiday = dow === 0
      || isPublicHoliday(nowLocal.getFullYear(), nowLocal.getMonth() + 1, nowLocal.getDate());
    if (holiday) return 'off';

    const period = this.touPeriodByHour(nowLocal);
    if (dow === 6 && period === 'peak') return 'mid';
    return period;
  }

  async initMeterValues() {
    // Restore stored values
    this.lastMeterValue = await this.getStoreValue('lastMeterValue') || 0;
    this.meterTotalStart = this.settings.meter_total_start || 0;
    this.monthStartMeter = this.settings.meter_month_start || 0;
    this.yearStartMeter = this.settings.meter_year_start || 0;

    // Restore last reading times (billing period based on check_day)
    this.lastBillingPeriod = await this.getStoreValue('lastBillingPeriod') || this.getCurrentBillingPeriod();
    this.lastReadingYear = await this.getStoreValue('lastReadingYear') || { year: new Date().getFullYear() };

    // Restore accumulated year bill (sum of completed months)
    this.yearAccumulatedBill = await this.getStoreValue('yearAccumulatedBill') || 0;

    // Restore hour/day/month tracking
    this.lastReadingHour = await this.getStoreValue('lastReadingHour') || { hour: new Date().getHours() };
    this.lastReadingDay = await this.getStoreValue('lastReadingDay') || { day: new Date().getDate() };
    this.hourStartMeter = await this.getStoreValue('hourStartMeter') || 0;
    this.dayStartMeter = await this.getStoreValue('dayStartMeter') || 0;
    this.todayStartMeter = await this.getStoreValue('todayStartMeter') || 0;

    // 오늘 쓴 요금: 자정 시점의 이번달 요금을 스냅샷으로 잡고, 실시간 이번달 요금과의
    // 차이로 계산한다. null이면 아직 스냅샷이 없다는 뜻(최초 설치 직후)이며, 첫 계산에서
    // 현재 요금으로 채워 설치 당일에 한 달치가 한꺼번에 찍히는 것을 막는다.
    // todayBillCarry: 검침일이 하루 중간에 지나가 요금이 0으로 리셋될 때, 리셋 전까지
    // 오늘 쌓인 금액을 이월해 둔다(그날 하루 요금이 끊기지 않도록).
    const storedTodayStartBill = await this.getStoreValue('todayStartBill');
    this.todayStartBill = (typeof storedTodayStartBill === 'number') ? storedTodayStartBill : null;
    this.todayBillCarry = await this.getStoreValue('todayBillCarry') || 0;

    // Restore last period values
    this.lastHourUsage = await this.getStoreValue('lastHourUsage') || 0;
    this.lastDayUsage = await this.getStoreValue('lastDayUsage') || 0;
    this.lastMonthUsage = await this.getStoreValue('lastMonthUsage') || 0;
    this.lastMonthBill = await this.getStoreValue('lastMonthBill') || 0;

    // Store current bill and step for flow triggers
    this.currentMonthBill = 0;
    this.currentKwhStep = await this.getStoreValue('currentKwhStep') || 1;

    // TOU (시간대별) load-period accumulators for this billing period
    // 계절별 x 부하시간대별 누적. 구버전은 계절 구분 없는 3버킷이었고 그 값으로는
    // 어느 계절 사용량인지 복원할 수 없어 이관하지 않는다(디바이스 재등록 안내).
    this.touBuckets = await this.getStoreValue('touBuckets') || emptyTouBuckets();

    // Day-over-day comparison + budget-exceeded edge state
    this.dayBeforeUsage = await this.getStoreValue('dayBeforeUsage') || 0;
    this.budgetExceededFired = false;

    // Solar net metering: exported (generation) cumulative + billing-period baseline
    this.exportMeterValue = await this.getStoreValue('exportMeterValue') || 0;
    this.exportMonthStart = await this.getStoreValue('exportMonthStart') || 0;
    this.lastSourceValue = null;
  }

  /** 소스 기기 구독을 해제한다. 재구독 전에 반드시 불러야 리스너가 누적되지 않는다. */
  destroySourceListeners() {
    for (const key of ['capabilityListener', 'exportListener']) {
      if (this[key]) {
        try {
          this[key].destroy();
        } catch (e) {
          this.error(`${key}.destroy() failed:`, e);
        }
        this[key] = null;
      }
    }
  }

  /** 구독 실패(API·소스 기기 미준비) 시 재시도를 예약한다. 백오프 최대 10분. */
  scheduleSourceRetry(reason) {
    if (this.sourceRetryId) this.homey.clearTimeout(this.sourceRetryId);
    this.sourceRetryDelay = Math.min((this.sourceRetryDelay || 15000) * 2, 600000);
    this.log(`${reason} — retrying source subscription in ${Math.round(this.sourceRetryDelay / 1000)}s`);
    this.sourceRetryId = this.homey.setTimeout(() => {
      this.sourceRetryId = null;
      this.setupSourceDevice().catch((e) => this.error('Source retry failed:', e));
    }, this.sourceRetryDelay);
  }

  async setupSourceDevice() {
    const sourceDeviceId = this.settings.homey_device_id;

    // 재구독일 수 있으므로 항상 기존 구독을 먼저 끊는다. 이게 없으면 재시도마다
    // 리스너가 쌓여 같은 값이 여러 번 들어온다.
    this.destroySourceListeners();

    if (!sourceDeviceId) {
      this.log('No source device configured');
      return;
    }

    try {
      const { api } = this.homey.app;
      if (!api) {
        // 앱 시작 시 API가 늦게 붙으면 여기로 들어온다. 예전에는 그대로 반환해서
        // 센서가 영구히 멈췄다.
        this.scheduleSourceRetry('Homey API not ready');
        return;
      }

      this.sourceDevice = await api.devices.getDevice({ id: sourceDeviceId });

      if (!this.sourceDevice) {
        this.scheduleSourceRetry('Source device not found');
        return;
      }

      // 이 구독이 어느 API 세대에 묶였는지 기록한다. watchdog이 세대 변화를 보고 재구독한다.
      this.apiGeneration = this.homey.app.apiGeneration;
      this.sourceRetryDelay = 0;

      // Listen for meter_power changes
      if (this.sourceDevice.capabilities.includes('meter_power')) {
        this.capabilityListener = this.sourceDevice.makeCapabilityInstance('meter_power', async (value) => {
          await this.updateMeter(value).catch(this.error);
        });
        this.log(`Listening to meter_power from ${this.sourceDevice.name}`);

        // Also track exported (generation) energy for solar net metering, if present
        if (this.sourceDevice.capabilities.includes('meter_power.exported')) {
          const eo = this.sourceDevice.capabilitiesObj && this.sourceDevice.capabilitiesObj['meter_power.exported'];
          if (eo && typeof eo.value === 'number') this.exportMeterValue = eo.value;
          this.exportListener = this.sourceDevice.makeCapabilityInstance('meter_power.exported', async (value) => {
            this.exportMeterValue = value || 0;
            await this.setStoreValue('exportMeterValue', this.exportMeterValue);
            if (this.lastSourceValue != null) await this.updateMeter(this.lastSourceValue).catch(this.error);
          });
          this.log('Also tracking meter_power.exported (generation)');
        }

        // Initial update
        if (this.sourceDevice.capabilitiesObj && this.sourceDevice.capabilitiesObj.meter_power) {
          const initialValue = this.sourceDevice.capabilitiesObj.meter_power.value;

          // Check if this is first time setup (all start values are 0)
          const isFirstSetup = this.hourStartMeter === 0
            && this.dayStartMeter === 0
            && this.monthStartMeter === 0
            && this.yearStartMeter === 0;

          if (isFirstSetup && initialValue > 0) {
            this.log('First setup detected, initializing start values with current meter value');
            const currentMeter = initialValue + this.meterTotalStart;

            // Set all start values to current meter value
            this.hourStartMeter = currentMeter;
            this.dayStartMeter = currentMeter;
            this.todayStartMeter = currentMeter;
            this.monthStartMeter = currentMeter;
            this.yearStartMeter = currentMeter;
            this.lastMeterValue = currentMeter;
            this.lastBillingPeriod = this.getCurrentBillingPeriod();
            this.exportMonthStart = this.exportMeterValue;

            // Persist values
            await this.setStoreValue('exportMonthStart', this.exportMonthStart);
            await this.setStoreValue('hourStartMeter', this.hourStartMeter);
            await this.setStoreValue('dayStartMeter', this.dayStartMeter);
            await this.setStoreValue('todayStartMeter', this.todayStartMeter);
            await this.setStoreValue('lastMeterValue', this.lastMeterValue);
            await this.setStoreValue('lastBillingPeriod', this.lastBillingPeriod);
            await this.setSettings({
              meter_month_start: this.monthStartMeter,
              meter_year_start: this.yearStartMeter,
            }).catch(this.error);
          }

          await this.updateMeter(initialValue);
        }
      }
    } catch (error) {
      this.error('Failed to setup source device:', error);
      this.scheduleSourceRetry('Source subscription threw');
    }
  }

  /**
   * 구독 상태 감시. 두 가지를 본다.
   *  - HomeyAPI가 재연결되어 api 객체가 바뀌면(app.apiGeneration 증가) 재구독한다.
   *    기존 capability instance는 죽은 api에 묶여 조용히 이벤트를 못 받는다.
   *  - 값이 너무 오래 안 들어오면 경고를 띄운다. 요금이 그럴듯한 값에 멈춰 있는 게
   *    사용자에게는 가장 알아채기 어려운 고장이다.
   */
  startWatchdog() {
    const CHECK_MS = 5 * 60 * 1000;
    const STALE_MS = 6 * 60 * 60 * 1000;
    this.stopWatchdog();
    this.watchdogId = this.homey.setInterval(async () => {
      try {
        const appGeneration = this.homey.app.apiGeneration;
        if (this.settings.homey_device_id && appGeneration !== this.apiGeneration) {
          this.log(`HomeyAPI generation changed (${this.apiGeneration} -> ${appGeneration}) — resubscribing`);
          await this.setupSourceDevice();
          return;
        }

        if (!this.lastUpdateAt || this.staleWarned) return;
        const idleMs = Date.now() - this.lastUpdateAt;
        if (idleMs > STALE_MS) {
          this.staleWarned = true;
          const hours = Math.floor(idleMs / 3600000);
          await this.setWarning(this.homey.__('warning_source_stale') || `No meter update for ${hours}h — the bill shown may be out of date.`).catch(this.error);
          this.error(`No meter update for ${hours}h`);
        }
      } catch (e) {
        this.error('Watchdog check failed:', e);
      }
    }, CHECK_MS);
  }

  stopWatchdog() {
    if (this.watchdogId) {
      this.homey.clearInterval(this.watchdogId);
      this.watchdogId = null;
    }
  }

  /** 앱 종료·디바이스 정지 시 구독과 타이머를 정리한다. */
  async onUninit() {
    this.log('Device onUninit');
    this.stopWatchdog();
    if (this.sourceRetryId) this.homey.clearTimeout(this.sourceRetryId);
    this.destroySourceListeners();
  }

  /**
   * 미터값 갱신 진입점. 실제 처리는 _applyMeterValue()이고, 여기서는 호출을 직렬화한다.
   *
   * updateMeter는 서로 독립적인 4개 경로(meter_power 이벤트, meter_power.exported 이벤트,
   * 최초 구독, 설정 변경 후 재계산)에서 불리고 내부에 await이 많다. 두 호출이 겹치면
   * await 경계에서 상태가 섞이는데, monthUsage처럼 매번 다시 계산되는 값은 다음 갱신에서
   * 저절로 복구되지만 TOU 부하 버킷·yearAccumulatedBill·todayBillCarry는 '누산'이라
   * 겹친 증분이 영구히 남는다. 특히 시간대별 요금제는 요금 전체가 그 버킷에서 나오므로
   * 대조해서 바로잡을 방법도 없다. 그래서 순차 실행을 보장한다.
   */
  async updateMeter(sourceMeterValue) {
    this._meterChain = Promise.resolve(this._meterChain)
      .then(() => this._applyMeterValue(sourceMeterValue))
      .catch((err) => this.error('updateMeter failed:', err));
    return this._meterChain;
  }

  async _applyMeterValue(sourceMeterValue) {
    if (typeof sourceMeterValue !== 'number' || !Number.isFinite(sourceMeterValue)) {
      this.log('Invalid meter value:', sourceMeterValue);
      return;
    }

    // 소스 미터 리셋 감지(기기 교체·펌웨어 초기화). 누적값이 줄면 이후 사용량이 기준점을
    // 다시 넘어설 때까지 0으로 눌려 있고 기준점은 영영 어긋난다. 총 사용량 오프셋을
    // 낙폭만큼 올려 meterValue의 연속성을 되살린다(모든 기준점이 그대로 유효해진다).
    if (this.lastSourceValue != null && sourceMeterValue < this.lastSourceValue - 1) {
      const drop = this.lastSourceValue - sourceMeterValue;
      this.meterTotalStart += drop;
      this.log(`Source meter reset detected (${this.lastSourceValue} -> ${sourceMeterValue});`
        + ` total offset raised by ${drop.toFixed(2)} kWh to keep usage continuous`);
      await this.setSettings({ meter_total_start: this.meterTotalStart }).catch(this.error);
    }

    // 마지막으로 값을 받은 시각 — 신선도 감시(watchdog)가 쓴다.
    this.lastUpdateAt = Date.now();
    if (this.staleWarned) {
      this.staleWarned = false;
      await this.unsetWarning().catch(this.error);
    }

    // Remember the raw source value so the exported-energy listener can recompute
    this.lastSourceValue = sourceMeterValue;

    // Apply total meter offset
    const meterValue = sourceMeterValue + this.meterTotalStart;

    const now = new Date();
    const nowLocal = this.nowLocal(now);

    // Check for new hour
    if (nowLocal.getHours() !== this.lastReadingHour.hour) {
      this.log('New hour detected');
      // Save last hour usage
      this.lastHourUsage = Math.max(0, this.lastMeterValue - this.hourStartMeter);
      await this.setStoreValue('lastHourUsage', this.lastHourUsage);

      this.hourStartMeter = this.lastMeterValue;
      this.lastReadingHour = { hour: nowLocal.getHours() };
      await this.setStoreValue('lastReadingHour', this.lastReadingHour);
      await this.setStoreValue('hourStartMeter', this.hourStartMeter);
    }

    // Check for new day
    if (nowLocal.getDate() !== this.lastReadingDay.day) {
      this.log('New day detected');
      // Yesterday's total becomes the "day before" for day-over-day comparison
      this.dayBeforeUsage = this.lastDayUsage;
      await this.setStoreValue('dayBeforeUsage', this.dayBeforeUsage);
      // Save last day usage
      this.lastDayUsage = Math.max(0, this.lastMeterValue - this.dayStartMeter);
      await this.setStoreValue('lastDayUsage', this.lastDayUsage);

      this.dayStartMeter = this.lastMeterValue;
      this.todayStartMeter = this.lastMeterValue;
      this.lastReadingDay = { day: nowLocal.getDate() };
      await this.setStoreValue('lastReadingDay', this.lastReadingDay);
      await this.setStoreValue('dayStartMeter', this.dayStartMeter);
      await this.setStoreValue('todayStartMeter', this.todayStartMeter);

      // 날짜가 바뀌었으니 오늘 요금 기준점을 지금까지의 이번달 요금으로 다시 잡는다
      // (todayStartMeter가 lastMeterValue를 쓰는 것과 같은 시점 기준).
      this.todayStartBill = this.currentMonthBill;
      this.todayBillCarry = 0;
      await this.setStoreValue('todayStartBill', this.todayStartBill);
      await this.setStoreValue('todayBillCarry', 0);
    }

    // Check for new year first (before month check)
    if (nowLocal.getFullYear() !== this.lastReadingYear.year) {
      this.log('New year detected');
      this.yearStartMeter = this.lastMeterValue;
      this.lastReadingYear = { year: nowLocal.getFullYear() };
      this.yearAccumulatedBill = 0; // Reset accumulated bill for new year
      await this.setStoreValue('lastReadingYear', this.lastReadingYear);
      await this.setStoreValue('yearAccumulatedBill', 0);
      await this.setSettings({ meter_year_start: this.yearStartMeter }).catch(this.error);
    }

    // Check for new billing period (based on check_day / meter reading day)
    const currentBillingPeriod = this.getCurrentBillingPeriod();
    if (currentBillingPeriod.year !== this.lastBillingPeriod.year
        || currentBillingPeriod.month !== this.lastBillingPeriod.month) {
      this.log(`New billing period detected: ${this.lastBillingPeriod.year}/${this.lastBillingPeriod.month + 1} -> ${currentBillingPeriod.year}/${currentBillingPeriod.month + 1}`);

      // Save last month usage
      this.lastMonthUsage = Math.max(0, this.lastMeterValue - this.monthStartMeter);
      await this.setStoreValue('lastMonthUsage', this.lastMonthUsage);

      // 끝난 기간의 요금을 확정한다. this.calculator는 호출 시점에 따라 새 기간으로
      // 초기화돼 있을 수 있으므로(앱 재시작·설정 변경 직후 경로), 여기서는 '직전 기간'을
      // 명시적으로 지정한 계산기를 따로 만들어 쓴다. 그러지 않으면 지난 달 요금이
      // 새 기간의 계절·요율로 계산돼 계절 경계마다 어긋난다.
      // (TOU 버킷은 이 시점까지 끝난 기간의 값을 그대로 들고 있다.)
      if (this.lastMonthUsage > 0) {
        const endedPeriodCalc = this.calculatorForEndedPeriod(nowLocal);
        const lastMonthBillResult = endedPeriodCalc.getSimpleBill(this.lastMonthUsage, this.touBuckets);
        this.lastMonthBill = lastMonthBillResult.total;
        await this.setStoreValue('lastMonthBill', this.lastMonthBill);
        this.yearAccumulatedBill += lastMonthBillResult.total;
        await this.setStoreValue('yearAccumulatedBill', this.yearAccumulatedBill);
        this.log(`Added last month bill: ${lastMonthBillResult.total}, Year total: ${this.yearAccumulatedBill}`);
      }

      // Notify flows that a new billing period has started (last period's totals)
      await this.driver.triggerNewBillingPeriod(this, {
        last_month_usage: Math.round(this.lastMonthUsage * 10) / 10,
        last_month_bill: Math.round(this.lastMonthBill),
      });

      // 검침일이 하루 중간에 지나가면 이번달 요금이 0부터 다시 쌓인다. 리셋 직전까지
      // 오늘 누적된 금액을 이월해 두고 기준점을 0으로 내려, 그날 '오늘 쓴 요금'이
      // 음수로 튀거나 끊기지 않게 한다.
      if (this.todayStartBill != null) {
        this.todayBillCarry += Math.max(0, this.currentMonthBill - this.todayStartBill);
      }
      this.todayStartBill = 0;
      await this.setStoreValue('todayBillCarry', this.todayBillCarry);
      await this.setStoreValue('todayStartBill', 0);

      this.monthStartMeter = this.lastMeterValue;
      this.lastBillingPeriod = currentBillingPeriod;
      await this.setStoreValue('lastBillingPeriod', this.lastBillingPeriod);
      await this.setSettings({ meter_month_start: this.monthStartMeter }).catch(this.error);

      // Reset TOU load-period accumulators at the start of the new billing period
      this.touBuckets = emptyTouBuckets();
      await this.setStoreValue('touBuckets', this.touBuckets);

      // Reset solar export baseline for the new billing period
      this.exportMonthStart = this.exportMeterValue;
      await this.setStoreValue('exportMonthStart', this.exportMonthStart);
    }

    // Calculate usage
    const monthUsage = Math.max(0, meterValue - this.monthStartMeter);
    const yearUsage = Math.max(0, meterValue - this.yearStartMeter);

    // TOU (시간대별) bucketing: attribute consumption since the last reading to
    // the current load period. Only tracked for time-of-use tariffs.
    if (this.tariffIsTou) {
      const touDelta = meterValue - this.lastMeterValue;
      if (touDelta > 0) {
        // 부하시간대와 함께 그 시점의 계절도 기록한다. 계절이 걸치는 산출기간에서
        // 사용량이 잘못된 계절 단가로 계산되던 문제(최대부하는 계절 간 50% 이상 차이)를
        // 막는다.
        const period = this.touPeriod(nowLocal);
        const season = this.calculator.commercialSeason(nowLocal.getMonth() + 1);
        this.touBuckets[season][period] += touDelta;
        await this.setStoreValue('touBuckets', this.touBuckets);
      }
    }

    // Solar net metering: billable usage = consumption - exported generation.
    // Applied to non-TOU tariffs only (TOU billing uses load-period buckets).
    const exportMonth = Math.max(0, this.exportMeterValue - this.exportMonthStart);
    let billableUsage = monthUsage;
    if (this.settings.solar_offset && !this.tariffIsTou) {
      billableUsage = Math.max(0, monthUsage - exportMonth);
    }

    // Calculate bill using Korean progressive rate
    try {
      this.initCalculator(); // Re-init with current date
      const billResult = this.calculator.getSimpleBill(billableUsage, this.touBuckets);

      // Update capabilities
      await this.setCapabilityValue('meter_power', meterValue).catch(this.error);
      await this.setCapabilityValue('meter_kwh_this_month', Math.round(monthUsage * 100) / 100).catch(this.error);
      await this.setCapabilityValue('meter_kwh_this_year', Math.round(yearUsage * 100) / 100).catch(this.error);
      const thisHourUsage = Math.max(0, meterValue - this.hourStartMeter);
      await this.setCapabilityValue('meter_kwh_this_hour', Math.round(thisHourUsage * 100) / 100).catch(this.error);
      await this.setCapabilityValue('meter_kwh_last_hour', Math.round(this.lastHourUsage * 100) / 100).catch(this.error);
      await this.setCapabilityValue('meter_kwh_last_day', Math.round(this.lastDayUsage * 100) / 100).catch(this.error);

      // Today's usage (since midnight)
      const todayUsage = Math.max(0, meterValue - this.todayStartMeter);
      await this.setCapabilityValue('meter_kwh_today', Math.round(todayUsage * 100) / 100).catch(this.error);

      // Daily average for this billing period
      const dailyAvg = this.calculateDailyAverage(monthUsage, nowLocal);
      await this.setCapabilityValue('meter_kwh_daily_avg', Math.round(dailyAvg * 100) / 100).catch(this.error);

      // Month comparison (vs same point last month)
      const comparison = this.calculateMonthComparison(monthUsage);
      await this.setCapabilityValue('meter_month_comparison', Math.round(comparison * 10) / 10).catch(this.error);

      // Current load period (경/중/최대부하)
      await this.setCapabilityValue('meter_load_period', this.touPeriod(nowLocal)).catch(this.error);

      // CO2 emissions estimate (국가 전력 배출계수 약 0.4594 kgCO2/kWh)
      await this.setCapabilityValue('meter_co2', Math.round(monthUsage * 0.4594 * 10) / 10).catch(this.error);

      // Solar generation (exported) this billing period
      await this.setCapabilityValue('meter_kwh_generated', Math.round(exportMonth * 100) / 100).catch(this.error);

      // Day-over-day comparison (어제 vs 그저께)
      if (this.dayBeforeUsage > 0) {
        const dayComp = ((this.lastDayUsage - this.dayBeforeUsage) / this.dayBeforeUsage) * 100;
        await this.setCapabilityValue('meter_day_comparison', Math.round(dayComp * 10) / 10).catch(this.error);
      }

      await this.setCapabilityValue('meter_kwh_last_month', Math.round(this.lastMonthUsage * 100) / 100).catch(this.error);
      await this.setCapabilityValue('meter_money_last_month', Math.round(this.lastMonthBill)).catch(this.error);
      await this.setCapabilityValue('meter_money_this_month', Math.round(billResult.total)).catch(this.error);

      // 오늘 쓴 요금 = 자정 스냅샷 이후 오른 이번달 요금 + 검침일 리셋 이월분.
      // 최초 설치 시에는 지금 값을 기준점으로 잡아 설치 당일에 한 달치가 찍히지 않게 한다.
      if (this.todayStartBill == null) {
        this.todayStartBill = billResult.total;
        await this.setStoreValue('todayStartBill', this.todayStartBill);
      }
      const todayCost = this.todayBillCarry + billResult.total - this.todayStartBill;
      await this.setCapabilityValue('meter_money_today', Math.max(0, Math.round(todayCost))).catch(this.error);

      // Check for step change and trigger flow
      const newStep = billResult.kwhStep || 1;
      if (newStep !== this.currentKwhStep) {
        this.log(`Progressive step changed: ${this.currentKwhStep} -> ${newStep}`);
        const oldStep = this.currentKwhStep;
        this.currentKwhStep = newStep;
        await this.setStoreValue('currentKwhStep', newStep);

        // Trigger flow (fires on any change, incl. the reset at the meter-reading day)
        await this.driver.triggerKwhStepChanged(this, { old_step: oldStep, new_step: newStep });

        // Additionally fire the "increased" trigger only when the step goes up.
        // Within a billing period the step only rises; it drops only on the
        // meter-reading-day reset, which this trigger deliberately ignores.
        if (newStep > oldStep) {
          await this.driver.triggerKwhStepIncreased(this, { old_step: oldStep, new_step: newStep });
        }
      }

      await this.setCapabilityValue('kwh_step', newStep).catch(this.error);

      // Store current bill for condition check + fire "cost rises above amount"
      // trigger (edge-triggered per flow's amount via the run listener).
      const oldBill = this.currentMonthBill;
      this.currentMonthBill = billResult.total;
      if (billResult.total > oldBill) {
        await this.driver.triggerMoneyExceeds(this, {}, { oldBill, newBill: billResult.total });
      }

      // Current unit rate. Fixed-type tariffs (residential progressive, flat
      // seasonal) report the current tier/seasonal rate. Time-of-use tariffs
      // report the current load period's rate (fixed within the period, changes
      // only by time of day). Average is a last-resort fallback.
      if (billResult.stepRate != null) {
        await this.setCapabilityValue('meter_tariff', billResult.stepRate).catch(this.error);
      } else if (this.tariffIsTou) {
        const touRate = this.calculator.getTouRate(this.touPeriod(nowLocal));
        if (touRate != null) {
          await this.setCapabilityValue('meter_tariff', touRate).catch(this.error);
        } else if (monthUsage > 0) {
          await this.setCapabilityValue('meter_tariff', Math.round((billResult.total / monthUsage) * 10) / 10).catch(this.error);
        }
      } else if (monthUsage > 0) {
        const avgTariff = Math.round((billResult.total / monthUsage) * 10) / 10;
        await this.setCapabilityValue('meter_tariff', avgTariff).catch(this.error);
      } else {
        await this.setCapabilityValue('meter_tariff', this.calculator.getFirstStepRate()).catch(this.error);
      }

      // Calculate year total: accumulated past months + current month estimate
      const yearTotalBill = this.yearAccumulatedBill + billResult.total;
      await this.setCapabilityValue('meter_money_this_year', Math.round(yearTotalBill)).catch(this.error);

      // Calculate forecast (예상 사용량/요금) — uses net (billable) usage for solar
      const forecast = this.calculateForecast(billableUsage, nowLocal);
      await this.setCapabilityValue('meter_kwh_forecast', Math.round(forecast.kwhForecast * 100) / 100).catch(this.error);
      await this.setCapabilityValue('meter_money_forecast', Math.round(forecast.moneyForecast)).catch(this.error);

      // Budget: usage % of monthly budget + edge-triggered "forecast exceeds budget"
      const budget = this.settings.budget_won || 0;
      if (budget > 0) {
        // 예산 대비(%): 이번달 사용량 요금(현재까지 지출) 기준
        await this.setCapabilityValue('meter_budget_pct', Math.round((billResult.total / budget) * 100)).catch(this.error);
        // 예산 초과 트리거: 예상 요금(월말 전망) 기준 — 조기 경고
        if (forecast.moneyForecast > budget && !this.budgetExceededFired) {
          this.budgetExceededFired = true;
          await this.driver.triggerBudgetExceeded(this, { forecast: Math.round(forecast.moneyForecast), budget });
        } else if (forecast.moneyForecast <= budget) {
          this.budgetExceededFired = false;
        }
      }

    } catch (error) {
      this.error('Failed to calculate bill:', error);
    }

    // Store last meter value (with offset applied)
    this.lastMeterValue = meterValue;
    await this.setStoreValue('lastMeterValue', meterValue);
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Settings changed:', changedKeys);

    // Validate meter start values: current >= month >= year
    const currentMeter = this.lastMeterValue || 0;
    const yearStart = newSettings.meter_year_start;
    const monthStart = newSettings.meter_month_start;

    // Validation: year_start should be <= month_start <= current meter
    if (changedKeys.includes('meter_year_start') || changedKeys.includes('meter_month_start')) {
      // Year start cannot be greater than month start
      if (yearStart > monthStart) {
        throw new Error(this.homey.__('error_year_greater_than_month') || 'Year start cannot be greater than month start');
      }
      // Month start cannot be greater than current meter
      if (monthStart > currentMeter && currentMeter > 0) {
        throw new Error(this.homey.__('error_month_greater_than_current') || 'Month start cannot be greater than current meter value');
      }
      // Year start cannot be greater than current meter
      if (yearStart > currentMeter && currentMeter > 0) {
        throw new Error(this.homey.__('error_year_greater_than_current') || 'Year start cannot be greater than current meter value');
      }
    }

    // Validate contract power for non-residential tariffs.
    // (Homey device settings can't hide fields conditionally, so we validate
    //  instead: non-residential types except Off-peak(A) need contract_kw > 0.)
    if (changedKeys.includes('tariff_type') || changedKeys.includes('contract_kw')) {
      const tt = newSettings.tariff_type || 'residential';
      const needsKw = tt !== 'residential' && tt !== 'night_gap';
      if (needsKw && (!newSettings.contract_kw || newSettings.contract_kw <= 0)) {
        throw new Error(this.homey.__('error_contract_kw_required')
          || 'This contract type requires Contract Power (kW) greater than 0. (이 계약종별은 계약전력(kW)을 0보다 크게 입력해야 합니다.)');
      }
    }

    // Update settings
    this.settings = newSettings;

    // Re-initialize calculator with new settings
    this.initCalculator();

    // If meter start values changed, recalculate
    if (changedKeys.includes('meter_total_start')) {
      this.meterTotalStart = newSettings.meter_total_start;
    }
    if (changedKeys.includes('meter_month_start')) {
      this.monthStartMeter = newSettings.meter_month_start;
      // Also update hour/day start if they're lower than month start
      if (this.hourStartMeter < this.monthStartMeter) {
        this.hourStartMeter = this.monthStartMeter;
        await this.setStoreValue('hourStartMeter', this.hourStartMeter);
      }
      if (this.dayStartMeter < this.monthStartMeter) {
        this.dayStartMeter = this.monthStartMeter;
        await this.setStoreValue('dayStartMeter', this.dayStartMeter);
      }
    }
    if (changedKeys.includes('meter_year_start')) {
      this.yearStartMeter = newSettings.meter_year_start;
    }

    // Defer reconnect/recalculation until AFTER Homey has committed the new
    // settings. setupSourceDevice()/updateMeter() call this.setSettings()
    // internally (hour/day/billing-period rollover); calling setSettings while
    // onSettings is still resolving is a Homey anti-pattern that races with the
    // settings commit, so we run it once the handler has returned.
    this.homey.setTimeout(async () => {
      try {
        // If source device changed, reconnect
        if (changedKeys.includes('homey_device_id')) {
          // setupSourceDevice()가 먼저 기존 구독을 끊는다.
          await this.setupSourceDevice();
        }

        // Recalculate with current meter value
        if (this.lastMeterValue > 0) {
          await this.updateMeter(this.lastMeterValue - this.meterTotalStart);
        }
      } catch (err) {
        this.error('Deferred settings recalculation failed:', err);
      }
    }, 1000);
  }

  onDeleted() {
    this.log('Device deleted');
    this.stopWatchdog();
    if (this.sourceRetryId) this.homey.clearTimeout(this.sourceRetryId);
    this.destroySourceListeners();
  }

  /**
   * Calculate daily average usage for this billing period
   */
  calculateDailyAverage(currentMonthUsage, nowLocal) {
    const { useDays } = resolveBillingPeriod(this.settings.check_day || 1, nowLocal);
    return currentMonthUsage / Math.max(1, useDays);
  }

  /**
   * Calculate comparison with last month
   * Compares current usage rate with last month's total
   * Returns percentage: current month projected vs last month actual
   * Example: 120% means on track to use 20% more than last month
   */
  calculateMonthComparison(currentMonthUsage) {
    if (this.lastMonthUsage <= 0) {
      return 0; // No comparison data available
    }

    // Get current forecast and compare with last month actual
    const now = new Date();
    const nowLocal = this.nowLocal(now);
    const forecast = this.calculateForecast(currentMonthUsage, nowLocal);

    const percentChange = ((forecast.kwhForecast - this.lastMonthUsage) / this.lastMonthUsage) * 100;
    return percentChange;
  }

  /**
   * Calculate forecast usage and cost for the billing period
   * Based on current usage rate, extrapolate to end of billing period
   */
  calculateForecast(currentMonthUsage, nowLocal) {
    const period = resolveBillingPeriod(this.settings.check_day || 1, nowLocal);
    const totalDays = period.monthDays;
    const elapsedDays = period.useDays;

    // Avoid division by zero
    if (elapsedDays <= 0) {
      return { kwhForecast: currentMonthUsage, moneyForecast: 0 };
    }

    // Calculate daily average and forecast
    const dailyAverage = currentMonthUsage / elapsedDays;
    const kwhForecast = dailyAverage * totalDays;

    // Calculate forecast bill using the calculator. For TOU tariffs, scale the
    // current load-period buckets up to the forecast total (assumes the same
    // load-period mix continues for the rest of the period).
    let moneyForecast = 0;
    try {
      let touForecast = null;
      if (this.tariffIsTou) {
        const touTotal = Object.values(this.touBuckets)
          .reduce((sum, bySeason) => sum + bySeason.off + bySeason.mid + bySeason.peak, 0);
        const scale = touTotal > 0 ? kwhForecast / touTotal : 0;
        touForecast = {
          ...Object.fromEntries(Object.entries(this.touBuckets).map(([season, b]) => [season, {
            off: b.off * scale, mid: b.mid * scale, peak: b.peak * scale,
          }])),
        };
      }
      const forecastBill = this.calculator.getSimpleBill(kwhForecast, touForecast);
      moneyForecast = forecastBill.total;
    } catch (error) {
      this.error('Failed to calculate forecast bill:', error);
    }

    return { kwhForecast, moneyForecast };
  }

  /**
   * 현재 청구기간. 경계 정의는 lib/billing_period.js가 유일한 출처이며 계산기와 공유한다.
   * 한전 기간은 (검침일, 다음 검침일] 이므로 전환은 검침일 '다음날'에 일어난다.
   * 예: 검침일 15일 -> 7/15는 아직 6월 기간, 7/16부터 7월 기간.
   * @returns {{year: number, month: number}} month는 0-based
   */
  getCurrentBillingPeriod(date = new Date()) {
    const period = resolveBillingPeriod(this.settings.check_day || 1, this.nowLocal(date));
    // month는 0-based로 유지한다 (기존 저장값 호환).
    return { year: period.checkYear, month: period.checkMonth - 1 };
  }

}

module.exports = KoreaElecDevice;
