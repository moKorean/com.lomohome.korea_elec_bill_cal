/*
 * Korea Electricity Bill Calculator Device
 * Copyright 2024, LomoHome (mokorean@gmail.com)
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

    // Restore last reading times
    this.lastReadingMonth = await this.getStoreValue('lastReadingMonth') || { month: new Date().getMonth() };
    this.lastReadingYear = await this.getStoreValue('lastReadingYear') || { year: new Date().getFullYear() };

    // Restore accumulated year bill (sum of completed months)
    this.yearAccumulatedBill = await this.getStoreValue('yearAccumulatedBill') || 0;

    // Restore hour/day/month tracking
    this.lastReadingHour = await this.getStoreValue('lastReadingHour') || { hour: new Date().getHours() };
    this.lastReadingDay = await this.getStoreValue('lastReadingDay') || { day: new Date().getDate() };
    this.hourStartMeter = await this.getStoreValue('hourStartMeter') || 0;
    this.dayStartMeter = await this.getStoreValue('dayStartMeter') || 0;

    // Restore last period values
    this.lastHourUsage = await this.getStoreValue('lastHourUsage') || 0;
    this.lastDayUsage = await this.getStoreValue('lastDayUsage') || 0;
    this.lastMonthUsage = await this.getStoreValue('lastMonthUsage') || 0;

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
          await this.updateMeter(this.sourceDevice.capabilitiesObj.meter_power.value);
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
      this.lastReadingDay = { day: nowLocal.getDate() };
      await this.setStoreValue('lastReadingDay', this.lastReadingDay);
      await this.setStoreValue('dayStartMeter', this.dayStartMeter);
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

    // Check for new month
    if (nowLocal.getMonth() !== this.lastReadingMonth.month) {
      this.log('New month detected');

      // Save last month usage
      this.lastMonthUsage = Math.max(0, this.lastMeterValue - this.monthStartMeter);
      await this.setStoreValue('lastMonthUsage', this.lastMonthUsage);

      // Calculate and save last month's bill before resetting
      if (this.lastMonthUsage > 0) {
        const lastMonthBill = this.calculator.getSimpleBill(this.lastMonthUsage);
        this.yearAccumulatedBill += lastMonthBill.total;
        await this.setStoreValue('yearAccumulatedBill', this.yearAccumulatedBill);
        this.log(`Added last month bill: ${lastMonthBill.total}, Year total: ${this.yearAccumulatedBill}`);
      }

      this.monthStartMeter = this.lastMeterValue;
      this.lastReadingMonth = { month: nowLocal.getMonth() };
      await this.setStoreValue('lastReadingMonth', this.lastReadingMonth);
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
      await this.setCapabilityValue('meter_kwh_this_month', Math.round(monthUsage * 10) / 10).catch(this.error);
      await this.setCapabilityValue('meter_kwh_this_year', Math.round(yearUsage * 10) / 10).catch(this.error);
      await this.setCapabilityValue('meter_kwh_last_hour', Math.round(this.lastHourUsage * 100) / 100).catch(this.error);
      await this.setCapabilityValue('meter_kwh_last_day', Math.round(this.lastDayUsage * 10) / 10).catch(this.error);
      await this.setCapabilityValue('meter_kwh_last_month', Math.round(this.lastMonthUsage * 10) / 10).catch(this.error);
      await this.setCapabilityValue('meter_money_this_month', this.formatMoney(billResult.total)).catch(this.error);

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

      // Calculate average tariff
      if (monthUsage > 0) {
        const avgTariff = Math.round((billResult.total / monthUsage) * 10) / 10;
        await this.setCapabilityValue('meter_tariff', avgTariff).catch(this.error);
      }

      // Calculate year total: accumulated past months + current month estimate
      const yearTotalBill = this.yearAccumulatedBill + billResult.total;
      await this.setCapabilityValue('meter_money_this_year', this.formatMoney(yearTotalBill)).catch(this.error);

    } catch (error) {
      this.error('Failed to calculate bill:', error);
    }

    // Store last meter value (with offset applied)
    this.lastMeterValue = meterValue;
    await this.setStoreValue('lastMeterValue', meterValue);
  }

  async onSettings({ oldSettings, newSettings, changedKeys }) {
    this.log('Settings changed:', changedKeys);

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
    }
    if (changedKeys.includes('meter_year_start')) {
      this.yearStartMeter = newSettings.meter_year_start;
    }

    // If source device changed, reconnect
    if (changedKeys.includes('homey_device_id')) {
      if (this.capabilityListener) {
        this.capabilityListener.destroy();
      }
      await this.setupSourceDevice();
    }

    // Recalculate with current meter value
    if (this.lastMeterValue > 0) {
      await this.updateMeter(this.lastMeterValue);
    }
  }

  onDeleted() {
    this.log('Device deleted');
    if (this.capabilityListener) {
      this.capabilityListener.destroy();
    }
  }

  formatMoney(value) {
    return `₩${Math.round(value).toLocaleString('ko-KR')}`;
  }

}

module.exports = KoreaElecDevice;
