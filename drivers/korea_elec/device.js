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

class KoreaElecDevice extends Device {

  async onInit() {
    this.log('Korea Electricity Meter device initialized');

    // Initialize settings
    this.settings = this.getSettings();
    this.timeZone = this.homey.clock.getTimezone();

    // Initialize calculator
    this.initCalculator();

    // Initialize meter values
    await this.initMeterValues();

    // Setup source device listener
    await this.setupSourceDevice();

    this.log(`Device ${this.getName()} is ready`);
  }

  initCalculator() {
    try {
      this.calculator = new KoreaElecBillCalculator({
        pressure: this.settings.pressure || 'low',
        checkDay: this.settings.check_day || 1,
        today: new Date(),
        bigfamDcCfg: parseInt(this.settings.bigfam_dc, 10) || 0,
        welfareDcCfg: parseInt(this.settings.welfare_dc, 10) || 0,
      });
    } catch (error) {
      this.error('Failed to initialize calculator:', error);
    }
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

    // Restore last period values
    this.lastHourUsage = await this.getStoreValue('lastHourUsage') || 0;
    this.lastDayUsage = await this.getStoreValue('lastDayUsage') || 0;
    this.lastMonthUsage = await this.getStoreValue('lastMonthUsage') || 0;
    this.lastMonthBill = await this.getStoreValue('lastMonthBill') || 0;

    // Store current bill and step for flow triggers
    this.currentMonthBill = 0;
    this.currentKwhStep = await this.getStoreValue('currentKwhStep') || 1;
  }

  async setupSourceDevice() {
    const sourceDeviceId = this.settings.homey_device_id;

    if (!sourceDeviceId) {
      this.log('No source device configured');
      return;
    }

    try {
      const api = this.homey.app.api;
      if (!api) {
        this.error('Homey API not ready');
        return;
      }

      this.sourceDevice = await api.devices.getDevice({ id: sourceDeviceId });

      if (!this.sourceDevice) {
        this.error('Source device not found');
        return;
      }

      // Listen for meter_power changes
      if (this.sourceDevice.capabilities.includes('meter_power')) {
        this.capabilityListener = this.sourceDevice.makeCapabilityInstance('meter_power', async (value) => {
          await this.updateMeter(value).catch(this.error);
        });
        this.log(`Listening to meter_power from ${this.sourceDevice.name}`);

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

            // Persist values
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
    }
  }

  async updateMeter(sourceMeterValue) {
    if (typeof sourceMeterValue !== 'number') {
      this.log('Invalid meter value:', sourceMeterValue);
      return;
    }

    // Apply total meter offset
    const meterValue = sourceMeterValue + this.meterTotalStart;

    const now = new Date();
    const nowLocal = new Date(now.toLocaleString('en-US', { timeZone: this.timeZone }));

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
      // Save last day usage
      this.lastDayUsage = Math.max(0, this.lastMeterValue - this.dayStartMeter);
      await this.setStoreValue('lastDayUsage', this.lastDayUsage);

      this.dayStartMeter = this.lastMeterValue;
      this.todayStartMeter = this.lastMeterValue;
      this.lastReadingDay = { day: nowLocal.getDate() };
      await this.setStoreValue('lastReadingDay', this.lastReadingDay);
      await this.setStoreValue('dayStartMeter', this.dayStartMeter);
      await this.setStoreValue('todayStartMeter', this.todayStartMeter);
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

      // Calculate and save last month's bill before resetting
      if (this.lastMonthUsage > 0) {
        const lastMonthBillResult = this.calculator.getSimpleBill(this.lastMonthUsage);
        this.lastMonthBill = lastMonthBillResult.total;
        await this.setStoreValue('lastMonthBill', this.lastMonthBill);
        this.yearAccumulatedBill += lastMonthBillResult.total;
        await this.setStoreValue('yearAccumulatedBill', this.yearAccumulatedBill);
        this.log(`Added last month bill: ${lastMonthBillResult.total}, Year total: ${this.yearAccumulatedBill}`);
      }

      this.monthStartMeter = this.lastMeterValue;
      this.lastBillingPeriod = currentBillingPeriod;
      await this.setStoreValue('lastBillingPeriod', this.lastBillingPeriod);
      await this.setSettings({ meter_month_start: this.monthStartMeter }).catch(this.error);
    }

    // Calculate usage
    const monthUsage = Math.max(0, meterValue - this.monthStartMeter);
    const yearUsage = Math.max(0, meterValue - this.yearStartMeter);

    // Calculate bill using Korean progressive rate
    try {
      this.initCalculator(); // Re-init with current date
      const billResult = this.calculator.getSimpleBill(monthUsage);

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

      await this.setCapabilityValue('meter_kwh_last_month', Math.round(this.lastMonthUsage * 100) / 100).catch(this.error);
      await this.setCapabilityValue('meter_money_last_month', Math.round(this.lastMonthBill)).catch(this.error);
      await this.setCapabilityValue('meter_money_this_month', Math.round(billResult.total)).catch(this.error);

      // Check for step change and trigger flow
      const newStep = billResult.kwhStep || 1;
      if (newStep !== this.currentKwhStep) {
        this.log(`Progressive step changed: ${this.currentKwhStep} -> ${newStep}`);
        const oldStep = this.currentKwhStep;
        this.currentKwhStep = newStep;
        await this.setStoreValue('currentKwhStep', newStep);

        // Trigger flow
        await this.driver.triggerKwhStepChanged(this, { old_step: oldStep, new_step: newStep });
      }

      await this.setCapabilityValue('kwh_step', newStep).catch(this.error);

      // Store current bill for condition check
      this.currentMonthBill = billResult.total;

      // Calculate average tariff (or show base rate if no usage yet)
      if (monthUsage > 0) {
        const avgTariff = Math.round((billResult.total / monthUsage) * 10) / 10;
        await this.setCapabilityValue('meter_tariff', avgTariff).catch(this.error);
      } else {
        // Show first step rate when no usage
        const baseRate = this.calculator.getFirstStepRate();
        await this.setCapabilityValue('meter_tariff', baseRate).catch(this.error);
      }

      // Calculate year total: accumulated past months + current month estimate
      const yearTotalBill = this.yearAccumulatedBill + billResult.total;
      await this.setCapabilityValue('meter_money_this_year', Math.round(yearTotalBill)).catch(this.error);

      // Calculate forecast (예상 사용량/요금)
      const forecast = this.calculateForecast(monthUsage, nowLocal);
      await this.setCapabilityValue('meter_kwh_forecast', Math.round(forecast.kwhForecast * 100) / 100).catch(this.error);
      await this.setCapabilityValue('meter_money_forecast', Math.round(forecast.moneyForecast)).catch(this.error);

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
    let yearStart = newSettings.meter_year_start;
    let monthStart = newSettings.meter_month_start;

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
          if (this.capabilityListener) {
            this.capabilityListener.destroy();
          }
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
    if (this.capabilityListener) {
      this.capabilityListener.destroy();
    }
  }

  /**
   * Calculate daily average usage for this billing period
   */
  calculateDailyAverage(currentMonthUsage, nowLocal) {
    const checkDay = this.settings.check_day || 1;

    // Calculate billing period start
    let periodStart;
    if (checkDay === 0) {
      periodStart = new Date(nowLocal.getFullYear(), nowLocal.getMonth(), 1);
    } else if (nowLocal.getDate() >= checkDay) {
      periodStart = new Date(nowLocal.getFullYear(), nowLocal.getMonth(), checkDay);
    } else {
      periodStart = new Date(nowLocal.getFullYear(), nowLocal.getMonth() - 1, checkDay);
    }

    const elapsedDays = Math.max(1, Math.ceil((nowLocal - periodStart) / (1000 * 60 * 60 * 24)));
    return currentMonthUsage / elapsedDays;
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
    const nowLocal = new Date(now.toLocaleString('en-US', { timeZone: this.timeZone }));
    const forecast = this.calculateForecast(currentMonthUsage, nowLocal);

    const percentChange = ((forecast.kwhForecast - this.lastMonthUsage) / this.lastMonthUsage) * 100;
    return percentChange;
  }

  /**
   * Calculate forecast usage and cost for the billing period
   * Based on current usage rate, extrapolate to end of billing period
   */
  calculateForecast(currentMonthUsage, nowLocal) {
    const checkDay = this.settings.check_day || 1;

    // Calculate billing period start and end dates
    let periodStart;
    let periodEnd;

    if (checkDay === 0) {
      // Last day of month: period is 1st to last day
      periodStart = new Date(nowLocal.getFullYear(), nowLocal.getMonth(), 1);
      periodEnd = new Date(nowLocal.getFullYear(), nowLocal.getMonth() + 1, 0);
    } else {
      // Period starts on check_day
      if (nowLocal.getDate() >= checkDay) {
        // Current month's check_day to next month's check_day - 1
        periodStart = new Date(nowLocal.getFullYear(), nowLocal.getMonth(), checkDay);
        periodEnd = new Date(nowLocal.getFullYear(), nowLocal.getMonth() + 1, checkDay - 1);
      } else {
        // Previous month's check_day to current month's check_day - 1
        periodStart = new Date(nowLocal.getFullYear(), nowLocal.getMonth() - 1, checkDay);
        periodEnd = new Date(nowLocal.getFullYear(), nowLocal.getMonth(), checkDay - 1);
      }
    }

    // Calculate days in period and days elapsed
    const totalDays = Math.ceil((periodEnd - periodStart) / (1000 * 60 * 60 * 24)) + 1;
    const elapsedDays = Math.ceil((nowLocal - periodStart) / (1000 * 60 * 60 * 24));

    // Avoid division by zero
    if (elapsedDays <= 0) {
      return { kwhForecast: currentMonthUsage, moneyForecast: 0 };
    }

    // Calculate daily average and forecast
    const dailyAverage = currentMonthUsage / elapsedDays;
    const kwhForecast = dailyAverage * totalDays;

    // Calculate forecast bill using the calculator
    let moneyForecast = 0;
    try {
      const forecastBill = this.calculator.getSimpleBill(kwhForecast);
      moneyForecast = forecastBill.total;
    } catch (error) {
      this.error('Failed to calculate forecast bill:', error);
    }

    return { kwhForecast, moneyForecast };
  }

  /**
   * Get current billing period based on check_day (meter reading day)
   * Returns { year, month } where month changes on check_day
   * Example: check_day=15, today=July 10 -> billing period is June
   *          check_day=15, today=July 20 -> billing period is July
   */
  getCurrentBillingPeriod(date = new Date()) {
    const checkDay = this.settings.check_day || 1;
    const localDate = new Date(date.toLocaleString('en-US', { timeZone: this.timeZone }));

    let year = localDate.getFullYear();
    let month = localDate.getMonth();
    const day = localDate.getDate();

    // If check_day is 0, it means last day of month: billing period is always
    // the current calendar month (transition on the 1st).
    if (checkDay === 0) {
      return { year, month };
    }

    // Clamp the meter reading day to the last day of the current month so that
    // check_day 29~31 still transitions on the last day of shorter months
    // (e.g. check_day=31 in February transitions on the 28th/29th, not the 1st
    //  of March). For check_day 1~28 this is a no-op.
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const effectiveCheckDay = Math.min(checkDay, daysInMonth);

    // Before the (effective) check day: still in previous month's billing period
    if (day < effectiveCheckDay) {
      month -= 1;
      if (month < 0) {
        month = 11;
        year -= 1;
      }
    }

    return { year, month };
  }

}

module.exports = KoreaElecDevice;
