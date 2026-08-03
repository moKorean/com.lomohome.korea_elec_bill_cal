/*
 * 소스 기기 통신 검증 — 실제 device.js를 스텁 런타임으로 구동.
 *
 * 다루는 결함:
 *  A1 updateMeter() 재진입 — 누산값(TOU 버킷·연 누적요금·오늘 요금 이월)이 영구 오염
 *  A2 HomeyAPI 재연결 시 재구독 안 함 — 센서가 그럴듯한 값에 조용히 영구 정지
 *  A3 API·소스 기기 미준비 시 재시도 없이 영구 포기
 *  A5 값이 오래 안 들어와도 사용자가 알 수 없음
 *  A6 소스 미터 리셋(기기 교체) 미감지
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { makeDevice, primeDevice, clock } = require('./lib/homey-stub');

clock.install();
test.after(() => clock.restore());

/** meter_power 구독을 흉내내는 소스 기기. */
function fakeSource(id = 'src1', caps = ['meter_power'], value = 0) {
  const src = {
    id,
    name: 'Fake Meter',
    capabilities: caps,
    capabilitiesObj: { meter_power: { value } },
    instances: [],
    makeCapabilityInstance(cap, cb) {
      const inst = {
        cap,
        cb,
        destroyed: false,
        destroy() {
          this.destroyed = true;
        },
      };
      src.instances.push(inst);
      return inst;
    },
  };
  return src;
}

function withApi(dev, source) {
  dev.homey.app.api = {
    devices: { getDevice: async ({ id }) => (source && source.id === id ? source : null) },
  };
  return dev;
}

// ---------- A1 ----------
test('A1: 동시 호출이 직렬화되어 누산값이 이중 계산되지 않는다', async () => {
  clock.setKst(2026, 6, 10, 12, 0);
  const dev = makeDevice({ settings: { check_day: 8 } });
  await primeDevice(dev, { meter: 100, day: 10, hour: 12 });
  await dev.updateMeter(100);

  const before = dev.yearAccumulatedBill;
  const startMeter = dev.lastMeterValue;

  // 서로 다른 값으로 겹쳐 호출 (await 하지 않고 동시에 던진다)
  await Promise.all([dev.updateMeter(120), dev.updateMeter(140), dev.updateMeter(160)]);

  assert.strictEqual(dev.lastMeterValue, 160, '마지막 값이 최종 상태여야 한다');
  assert.strictEqual(dev.yearAccumulatedBill, before, '롤오버가 없으면 연 누적은 그대로');
  // 오늘 사용량은 파생값이므로 정확히 델타와 일치해야 한다
  assert.strictEqual(
    dev.capValues.meter_kwh_today,
    Math.round((160 - dev.todayStartMeter) * 100) / 100,
    '중복 누적 없이 델타가 정확',
  );
  assert.ok(startMeter === 100, '전제 확인');
});

test('A1: TOU 버킷이 동시 호출에서도 실제 증분과 일치한다', async () => {
  clock.setKst(2026, 6, 10, 12, 0); // 여름 중간부하 시간대
  const dev = makeDevice({
    settings: { check_day: 8, tariff_type: 'general_gap2_highA_s1', contract_kw: 100 },
  });
  await primeDevice(dev, { meter: 0, day: 10, hour: 12 });
  await dev.updateMeter(0);
  assert.ok(dev.tariffIsTou, '전제: TOU 요금제');

  await Promise.all([dev.updateMeter(10), dev.updateMeter(20), dev.updateMeter(30)]);

  const bucketSum = Object.values(dev.touBuckets)
    .reduce((sum, b) => sum + b.off + b.mid + b.peak, 0);
  assert.strictEqual(Math.round(bucketSum * 100) / 100, 30,
    `버킷 합(${bucketSum})이 실제 증분 30kWh와 같아야 한다 — 겹친 증분이 남으면 영구 오염`);
});

// ---------- A2 ----------
test('A2: HomeyAPI 세대가 바뀌면 재구독한다', async () => {
  clock.setKst(2026, 6, 10, 12, 0);
  const src = fakeSource();
  const dev = withApi(makeDevice({ settings: { check_day: 8, homey_device_id: 'src1' } }), src);
  await primeDevice(dev, { meter: 0, day: 10, hour: 12 });

  await dev.setupSourceDevice();
  assert.strictEqual(src.instances.length, 1, '최초 구독 1건');
  assert.strictEqual(dev.apiGeneration, 1);

  dev.startWatchdog();

  // 같은 세대에서는 재구독하지 않는다
  await dev.runTimers('interval');
  assert.strictEqual(src.instances.length, 1, '세대 동일 시 재구독 없음');

  // 재연결로 세대가 올라가면 재구독하고, 이전 구독은 반드시 해제되어야 한다
  dev.homey.app.apiGeneration = 2;
  await dev.runTimers('interval');
  assert.strictEqual(src.instances.length, 2, '재구독 발생');
  assert.strictEqual(src.instances[0].destroyed, true, '이전 리스너 해제 (누적 방지)');
  assert.strictEqual(src.instances[1].destroyed, false, '새 리스너는 살아 있음');
  assert.strictEqual(dev.apiGeneration, 2);
});

test('A2: 재구독을 반복해도 리스너가 쌓이지 않는다', async () => {
  clock.setKst(2026, 6, 10, 12, 0);
  const src = fakeSource();
  const dev = withApi(makeDevice({ settings: { check_day: 8, homey_device_id: 'src1' } }), src);
  await primeDevice(dev, { meter: 0, day: 10, hour: 12 });

  for (let i = 0; i < 5; i += 1) await dev.setupSourceDevice();

  const alive = src.instances.filter((x) => !x.destroyed);
  assert.strictEqual(alive.length, 1, `살아 있는 리스너는 항상 1개 (실제 ${alive.length})`);
});

// ---------- A3 ----------
test('A3: API가 아직 없으면 포기하지 않고 재시도를 예약한다', async () => {
  clock.setKst(2026, 6, 10, 12, 0);
  const src = fakeSource();
  const dev = makeDevice({ settings: { check_day: 8, homey_device_id: 'src1' }, api: null });
  await primeDevice(dev, { meter: 0, day: 10, hour: 12 });

  await dev.setupSourceDevice();
  assert.strictEqual(src.instances.length, 0, '구독 못 함');
  assert.ok(dev.sourceRetryId, '재시도가 예약되어야 한다 (예전에는 영구 포기)');

  // API가 붙은 뒤 재시도가 성공해야 한다
  withApi(dev, src);
  await dev.runTimers('timeout');
  assert.strictEqual(src.instances.length, 1, '재시도로 구독 성공');
});

test('A3: 소스 기기를 못 찾으면 백오프로 재시도한다', async () => {
  clock.setKst(2026, 6, 10, 12, 0);
  const dev = withApi(makeDevice({ settings: { check_day: 8, homey_device_id: 'missing' } }), null);
  await primeDevice(dev, { meter: 0, day: 10, hour: 12 });

  await dev.setupSourceDevice();
  const first = [...dev.timers.values()][0];
  assert.ok(first, '재시도 예약됨');

  await dev.runTimers('timeout'); // 여전히 못 찾음 -> 다시 예약
  const second = [...dev.timers.values()][0];
  assert.ok(second, '계속 재시도');
  assert.ok(second.ms > first.ms, `백오프가 늘어나야 한다 (${first.ms} -> ${second.ms})`);
  assert.ok(second.ms <= 600000, '상한 10분');
});

// ---------- A5 ----------
test('A5: 값이 오래 안 들어오면 경고하고, 다시 들어오면 해제한다', async () => {
  clock.setKst(2026, 6, 10, 12, 0);
  const dev = makeDevice({ settings: { check_day: 8 } });
  await primeDevice(dev, { meter: 0, day: 10, hour: 12 });
  await dev.updateMeter(10);
  dev.startWatchdog();

  await dev.runTimers('interval');
  assert.strictEqual(dev.warnings.length, 0, '방금 받았으면 경고 없음');

  // 7시간 전에 마지막으로 받은 상태로 조작
  dev.lastUpdateAt = Date.now() - 7 * 3600 * 1000;
  await dev.runTimers('interval');
  assert.strictEqual(dev.warnings.length, 1, '정체되면 경고');
  assert.ok(dev.warnings[0], '경고 메시지가 있어야 한다');

  await dev.runTimers('interval');
  assert.strictEqual(dev.warnings.length, 1, '경고는 한 번만 (반복 알림 없음)');

  await dev.updateMeter(20);
  assert.strictEqual(dev.warnings[dev.warnings.length - 1], null, '값이 오면 경고 해제');
});

// ---------- A6 ----------
test('A6: 소스 미터가 리셋되면 오프셋으로 연속성을 유지한다', async () => {
  clock.setKst(2026, 6, 10, 12, 0);
  const dev = makeDevice({ settings: { check_day: 8 } });
  await primeDevice(dev, { meter: 0, day: 10, hour: 12 });
  await dev.updateMeter(0);
  await dev.updateMeter(500);

  const usageBefore = dev.capValues.meter_kwh_this_month;
  assert.ok(usageBefore > 0, '전제: 사용량이 쌓여 있다');

  // 기기 교체로 소스가 0부터 다시 시작
  await dev.updateMeter(0);
  assert.strictEqual(dev.meterTotalStart, 500, '낙폭만큼 오프셋 상향');
  assert.strictEqual(dev.capValues.meter_kwh_this_month, usageBefore,
    '리셋 직후에도 이번달 사용량이 유지되어야 한다 (0으로 눌리지 않음)');

  // 새 미터에서 10kWh 더 쓰면 그만큼만 늘어난다
  await dev.updateMeter(10);
  assert.strictEqual(
    Math.round((dev.capValues.meter_kwh_this_month - usageBefore) * 100) / 100, 10,
    '리셋 이후 증분이 정확히 반영',
  );
});

test('A6: 작은 하락은 리셋으로 오인하지 않는다', async () => {
  clock.setKst(2026, 6, 10, 12, 0);
  const dev = makeDevice({ settings: { check_day: 8 } });
  await primeDevice(dev, { meter: 0, day: 10, hour: 12 });
  await dev.updateMeter(500);

  await dev.updateMeter(499.5); // 계측 지터 수준
  assert.strictEqual(dev.meterTotalStart, 0, '1kWh 미만 하락은 오프셋을 건드리지 않는다');
});

test('잘못된 값은 상태를 바꾸지 않는다', async () => {
  clock.setKst(2026, 6, 10, 12, 0);
  const dev = makeDevice({ settings: { check_day: 8 } });
  await primeDevice(dev, { meter: 0, day: 10, hour: 12 });
  await dev.updateMeter(100);
  const snapshot = dev.lastMeterValue;

  for (const bad of [undefined, null, 'abc', NaN, Infinity]) {
    await dev.updateMeter(bad);
  }
  assert.strictEqual(dev.lastMeterValue, snapshot, '유효하지 않은 값은 무시');
});
