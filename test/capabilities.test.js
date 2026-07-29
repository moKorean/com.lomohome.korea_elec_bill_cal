/*
 * ensureCapabilities() 검증 — 앱 업데이트로 추가된 센서가 기존 디바이스에 반영되는지.
 *
 * Homey는 앱 업데이트 시 기존 디바이스의 capability를 건드리지 않고, addCapability()는
 * 항상 목록 끝에 붙는다. 그래서 앱이 직접 매니페스트 순서까지 맞춰줘야 한다.
 * removeCapability()는 인사이트 기록을 지우므로 재구성 범위를 최소화해야 한다.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { makeDevice, MANIFEST } = require('./lib/homey-stub');

/** meter_money_today가 없고 일평균/전일대비 순서가 뒤바뀐 구버전 목록 */
function legacyCapabilities() {
  const caps = MANIFEST.filter((c) => c !== 'meter_money_today');
  const i = caps.indexOf('meter_kwh_daily_avg');
  const j = caps.indexOf('meter_day_comparison');
  [caps[i], caps[j]] = [caps[j], caps[i]];
  return caps;
}

test('구버전 디바이스가 매니페스트 순서로 맞춰진다', async () => {
  const legacy = legacyCapabilities();
  assert.ok(!legacy.includes('meter_money_today'), '전제: 신규 센서가 없다');

  const dev = makeDevice({ capabilities: legacy });
  await dev.ensureCapabilities();

  assert.deepStrictEqual(dev.getCapabilities(), MANIFEST, '순서까지 정확히 일치');
  assert.ok(dev.hasCapability('meter_money_today'), '신규 센서 추가됨');
});

test('재구성 범위가 최소화된다 (앞부분 인사이트 보존)', async () => {
  const dev = makeDevice({ capabilities: legacyCapabilities() });
  await dev.ensureCapabilities();

  const log = dev.logs.find((l) => l.startsWith('Capability sync from index'));
  assert.ok(log, '동기화 로그가 남아야 한다');

  const from = Number(log.match(/index (\d+)/)[1]);
  // 처음 어긋나는 위치(meter_kwh_daily_avg 자리)부터만 다시 만든다
  const firstDiff = MANIFEST.findIndex((c, i) => legacyCapabilities()[i] !== c);
  assert.strictEqual(from, firstDiff, '처음 어긋나는 인덱스부터 재구성');
  assert.ok(from > 0, '앞부분은 건드리지 않는다');
});

test('이미 맞는 디바이스는 아무것도 하지 않는다', async () => {
  const dev = makeDevice();
  await dev.ensureCapabilities();
  assert.strictEqual(dev.logs.length, 0, '로그 없음 = 재구성 없음');
  assert.deepStrictEqual(dev.getCapabilities(), MANIFEST);
  assert.strictEqual(dev.store.capabilityLayout, MANIFEST.join('|'), '배치 서명 기록');
});

test('두 번째 호출은 재구성하지 않는다', async () => {
  const dev = makeDevice({ capabilities: legacyCapabilities() });
  await dev.ensureCapabilities();
  dev.logs.length = 0;

  await dev.ensureCapabilities();
  assert.strictEqual(dev.logs.length, 0, '재시작마다 다시 지우면 안 된다');
});

test('순서 반영이 안 되는 런타임에서도 반복 삭제하지 않는다', async () => {
  // removeCapability가 먹지 않는 상황을 가정. 무한 재구성 루프에 빠지면
  // 매 재시작마다 인사이트가 날아간다.
  const dev = makeDevice({ capabilities: legacyCapabilities() });
  dev.removeCapability = async () => {};

  await dev.ensureCapabilities();
  assert.ok(dev.hasCapability('meter_money_today'), '그래도 누락 센서는 추가된다');

  dev.logs.length = 0;
  await dev.ensureCapabilities();
  const rebuilt = dev.logs.some((l) => l.startsWith('Capability sync from index'));
  assert.ok(!rebuilt, '두 번째 호출은 비파괴 경로로 물러난다');
});

test('매니페스트에서 빠진 센서는 제거된다', async () => {
  const dev = makeDevice({ capabilities: [...MANIFEST, 'meter_obsolete_sensor'] });
  await dev.ensureCapabilities();
  assert.ok(!dev.hasCapability('meter_obsolete_sensor'), '구식 센서 제거');
  assert.deepStrictEqual(dev.getCapabilities(), MANIFEST);
});

test('매니페스트가 비면 아무것도 건드리지 않는다', async () => {
  const dev = makeDevice({ capabilities: legacyCapabilities() });
  const before = [...dev.getCapabilities()];
  dev.driver.manifest = { capabilities: [] };

  await dev.ensureCapabilities();
  assert.deepStrictEqual(dev.getCapabilities(), before, '목록 유지');
  assert.ok(dev.logs.some((l) => l.startsWith('ERROR')), '오류를 남긴다');
});
