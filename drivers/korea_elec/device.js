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
    this.monthStartMeter = this.settings.meter_month_start || 0;
    this.yearStartMeter = this.settings.meter_year_start || 0;

    // Restore last reading times
    this.lastReadingMonth = await this.getStoreValue('lastReadingMonth') || { month: new Date().getMonth() };
    this.lastReadingYear = await this.getStoreValue('lastReadingYear') || { year: new Date().getFullYear() };
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

  async updateMeter(meterValue) {
    if (typeof meterValue !== 'number') {
      this.log('Invalid meter value:', meterValue);
      return;
    }

    const now = new Date();
    const nowLocal = new Date(now.toLocaleString('en-US', { timeZone: this.timeZone }));

    // Check for new month
    if (nowLocal.getMonth() !== this.lastReadingMonth.month) {
      this.log('New month detected');
      this.monthStartMeter = this.lastMeterValue;
      this.lastReadingMonth = { month: nowLocal.getMonth() };
      await this.setStoreValue('lastReadingMonth', this.lastReadingMonth);
      await this.setSettings({ meter_month_start: this.monthStartMeter }).catch(this.error);
    }

    // Check for new year
    if (nowLocal.getFullYear() !== this.lastReadingYear.year) {
      this.log('New year detected');
      this.yearStartMeter = this.lastMeterValue;
      this.lastReadingYear = { year: nowLocal.getFullYear() };
      await this.setStoreValue('lastReadingYear', this.lastReadingYear);
      await this.setSettings({ meter_year_start: this.yearStartMeter }).catch(this.error);
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
      await this.setCapabilityValue('meter_money_this_month', billResult.total).catch(this.error);
      await this.setCapabilityValue('kwh_step', billResult.kwhStep || 1).catch(this.error);

      // Calculate average tariff
      if (monthUsage > 0) {
        const avgTariff = Math.round((billResult.total / monthUsage) * 10) / 10;
        await this.setCapabilityValue('meter_tariff', avgTariff).catch(this.error);
      }

      // Calculate year total (approximate based on monthly average)
      const yearBillResult = this.calculator.getSimpleBill(yearUsage);
      await this.setCapabilityValue('meter_money_this_year', yearBillResult.total).catch(this.error);

    } catch (error) {
      this.error('Failed to calculate bill:', error);
    }

    // Store last meter value
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

}

module.exports = KoreaElecDevice;
