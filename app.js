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
// eslint-disable global-require: 내부 경로가 바뀌었을 때 패키지 루트로 물러나야 해서
// try/catch 안에서 require 해야 한다 (정적 import로는 대체 불가).
let HomeyAPI;
try {
  // eslint-disable-next-line global-require
  HomeyAPI = require('homey-api/lib/HomeyAPI/HomeyAPI');
} catch (err) {
  // eslint-disable-next-line global-require
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
      // 재연결하면 api 객체가 새로 만들어지고, 기존 capability instance는 죽은 객체에
      // 묶여 조용히 이벤트를 못 받는다. 디바이스가 이 값이 바뀐 것을 보고 재구독한다.
      this.apiGeneration = (this.apiGeneration || 0) + 1;
      this.log(`HomeyAPI connected (generation ${this.apiGeneration})`);
    } catch (err) {
      this.error('HomeyAPI init failed, retrying in 1 min:', err);
      this.apiRetryId = this.homey.setTimeout(() => this.initApi(), 60000);
    }
  }

}

module.exports = KoreaElecBillApp;
