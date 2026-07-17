/*
 * Korea Electricity Bill Calculator Driver
 * Copyright 2024, Geunwon Mo (mokorean@gmail.com)
 *
 * Based on Power by the Hour by Robin de Gruijter
 */

'use strict';

const { Driver } = require('homey');

class KoreaElecDriver extends Driver {

  async onInit() {
    this.log('Korea Electricity Driver initialized');

    // Register flow trigger for step change
    this.homey.flow.getDeviceTriggerCard('kwh_step_changed')
      .registerRunListener(async (args, state) => true);

    // Register flow trigger for step increase (only fires when step goes up)
    this.homey.flow.getDeviceTriggerCard('kwh_step_increased')
      .registerRunListener(async (args, state) => true);

    // Register flow condition for money exceeds
    this.homey.flow.getConditionCard('money_exceeds')
      .registerRunListener(async (args) => {
        const { device, amount } = args;
        return device.currentMonthBill > amount;
      });

    // New-billing-period and budget triggers (no args to match)
    this.homey.flow.getDeviceTriggerCard('new_billing_period')
      .registerRunListener(async () => true);
    this.homey.flow.getDeviceTriggerCard('budget_exceeded')
      .registerRunListener(async () => true);

    // This-month cost rises above a per-flow amount (edge-triggered on crossing)
    this.homey.flow.getDeviceTriggerCard('money_exceeds_trigger')
      .registerRunListener(async (args, state) => state.oldBill <= args.amount && state.newBill > args.amount);

    // Condition: current load period (경/중/최대부하) computed live
    this.homey.flow.getConditionCard('load_period_is')
      .registerRunListener(async (args) => {
        const { device, period } = args;
        const tz = device.timeZone || 'Asia/Seoul';
        const nowLocal = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
        return device.touPeriod(nowLocal) === period;
      });

    // Condition: current progressive step is at least N
    this.homey.flow.getConditionCard('kwh_step_at_least')
      .registerRunListener(async (args) => (args.device.currentKwhStep || 1) >= Number(args.step));
  }

  async triggerNewBillingPeriod(device, tokens) {
    try {
      await this.homey.flow.getDeviceTriggerCard('new_billing_period').trigger(device, tokens);
      this.log(`Triggered new_billing_period: usage=${tokens.last_month_usage} bill=${tokens.last_month_bill}`);
    } catch (error) {
      this.error('Failed to trigger new_billing_period:', error);
    }
  }

  async triggerBudgetExceeded(device, tokens) {
    try {
      await this.homey.flow.getDeviceTriggerCard('budget_exceeded').trigger(device, tokens);
      this.log(`Triggered budget_exceeded: forecast=${tokens.forecast} budget=${tokens.budget}`);
    } catch (error) {
      this.error('Failed to trigger budget_exceeded:', error);
    }
  }

  async triggerMoneyExceeds(device, tokens, state) {
    try {
      await this.homey.flow.getDeviceTriggerCard('money_exceeds_trigger').trigger(device, tokens, state);
    } catch (error) {
      this.error('Failed to trigger money_exceeds_trigger:', error);
    }
  }

  async triggerKwhStepChanged(device, tokens) {
    try {
      await this.homey.flow.getDeviceTriggerCard('kwh_step_changed')
        .trigger(device, tokens);
      this.log(`Triggered kwh_step_changed: ${tokens.old_step} -> ${tokens.new_step}`);
    } catch (error) {
      this.error('Failed to trigger kwh_step_changed:', error);
    }
  }

  async triggerKwhStepIncreased(device, tokens) {
    try {
      await this.homey.flow.getDeviceTriggerCard('kwh_step_increased')
        .trigger(device, tokens);
      this.log(`Triggered kwh_step_increased: ${tokens.old_step} -> ${tokens.new_step}`);
    } catch (error) {
      this.error('Failed to trigger kwh_step_increased:', error);
    }
  }

  async onPairListDevices() {
    const devices = [];

    try {
      const api = this.homey.app.api;
      if (!api) {
        this.error('Homey API not ready');
        return devices;
      }

      // Get all devices from Homey
      const allDevices = await api.devices.getDevices();

      // Filter devices that have meter_power capability
      for (const [id, device] of Object.entries(allDevices)) {
        if (device.capabilities && device.capabilities.includes('meter_power')) {
          devices.push({
            name: device.name,
            data: {
              id: `korea_elec_${id}`,
            },
            settings: {
              homey_device_id: id,
              homey_device_name: device.name,
              check_day: 1,
              tariff_type: 'residential',
              pressure: 'low',
              contract_kw: 0,
              budget_won: 0,
              use_auto_adjustment: true,
              climate_price: 9,
              fuel_price: 5,
              bigfam_dc: '0',
              welfare_dc: '0',
              meter_total_start: 0,
              meter_month_start: 0,
              meter_year_start: 0,
            },
          });
        }
      }

      this.log(`Found ${devices.length} compatible devices`);
    } catch (error) {
      this.error('Error listing devices:', error);
    }

    return devices;
  }

}

module.exports = KoreaElecDriver;
