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

    // Register flow condition for money exceeds
    this.homey.flow.getConditionCard('money_exceeds')
      .registerRunListener(async (args) => {
        const { device, amount } = args;
        return device.currentMonthBill > amount;
      });
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
              pressure: 'low',
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
