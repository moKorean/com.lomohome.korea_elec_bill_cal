/*
 * Korea Electricity Bill Calculator Driver
 * Copyright 2024, LomoHome (mokorean@gmail.com)
 *
 * Based on Power by the Hour by Robin de Gruijter
 */

'use strict';

const { Driver } = require('homey');

class KoreaElecDriver extends Driver {

  async onInit() {
    this.log('Korea Electricity Driver initialized');
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
            name: `${device.name} (한국 전력)`,
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
