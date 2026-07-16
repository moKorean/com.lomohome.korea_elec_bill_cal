/*
 * Korea Electricity Bill Calculator
 * Copyright 2024, Geunwon Mo (mokorean@gmail.com)
 *
 * Based on Power by the Hour by Robin de Gruijter
 */

'use strict';

const Homey = require('homey');

// Import only the HomeyAPI submodule. `require('homey-api')` eagerly loads ~20
// unused Athom Cloud API clients (weather, store, backup, firmware, ...) and
// their dependencies — ~200 extra modules / ~22 MB RSS. We only need
// HomeyAPI.createAppAPI(). Fall back to the package root if the internal path
// ever changes.
let HomeyAPI;
try {
  HomeyAPI = require('homey-api/lib/HomeyAPI/HomeyAPI');
} catch (err) {
  ({ HomeyAPI } = require('homey-api'));
}

class KoreaElecBillApp extends Homey.App {

  async onInit() {
    try {
      // Login to Homey API
      await this.initApi();

      this.log(`Korea Electricity Bill Calculator app is running... Timezone: ${this.homey.clock.getTimezone()}`);
    } catch (error) {
      this.error(error);
    }
  }

  async onUninit() {
    this.log('app onUninit called');
    if (this.apiRetryId) this.homey.clearTimeout(this.apiRetryId);
  }

  async initApi() {
    if (this.apiRetryId) this.homey.clearTimeout(this.apiRetryId);
    try {
      this.api = await Promise.race([
        HomeyAPI.createAppAPI({ homey: this.homey }),
        new Promise((resolve, reject) => {
          this.homey.setTimeout(() => reject(new Error('HomeyAPI.createAppAPI timeout')), 10000);
        }),
      ]);
      this.log('HomeyAPI connected');
    } catch (err) {
      this.error('HomeyAPI init failed, retrying in 1 min:', err);
      this.apiRetryId = this.homey.setTimeout(() => this.initApi(), 60000);
    }
  }

}

module.exports = KoreaElecBillApp;
