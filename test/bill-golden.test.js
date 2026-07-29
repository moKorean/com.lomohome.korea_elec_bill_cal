/*
 * 요금 계산 회귀 테스트 (골든 해시).
 *
 * 리팩터링·정리 작업이 계산 결과를 바꾸지 않았는지 넓게 확인한다. 실패는 두 가지 중
 * 하나를 뜻한다.
 *   1) 의도하지 않은 회귀       -> 코드를 고친다
 *   2) 의도한 요율/로직 변경    -> `npm run test:golden:update` 로 기준값을 갱신하고
 *                                무엇이 왜 바뀌었는지 커밋 메시지에 남긴다
 *
 * 실패 시 실제 출력을 test/.golden-actual/<group>.txt 에 남기므로, 이전 커밋의 출력과
 * diff 하면 어떤 케이스가 달라졌는지 정확히 볼 수 있다.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { run } = require('./lib/bill-matrix');

const EXPECTED = require('./fixtures/bill-matrix.json');

const DUMP_DIR = path.join(__dirname, '.golden-actual');

const results = run();

test('회귀 매트릭스가 모든 그룹을 덮는다', () => {
  const groups = results.map((r) => r.group).sort();
  const expected = Object.keys(EXPECTED).filter((k) => !k.startsWith('_')).sort();
  assert.deepStrictEqual(groups, expected, '그룹 목록이 기준값 파일과 다릅니다');
  assert.ok(results.every((r) => r.cases > 0), '케이스가 0인 그룹이 있습니다');
});

for (const r of results) {
  test(`${r.group}: 계산 결과가 기준값과 동일 (${r.cases}건)`, () => {
    const want = EXPECTED[r.group];
    assert.strictEqual(r.cases, want.cases,
      '케이스 수가 달라졌습니다. 매트릭스를 바꿨다면 기준값도 갱신하세요.');

    if (r.sha256 !== want.sha256) {
      fs.mkdirSync(DUMP_DIR, { recursive: true });
      const dump = path.join(DUMP_DIR, `${r.group}.txt`);
      fs.writeFileSync(dump, r.body);
      assert.fail(`${r.group} 계산 결과가 바뀌었습니다.\n`
        + `  기대 ${want.sha256}\n  실제 ${r.sha256}\n`
        + `  실제 출력: ${dump}\n`
        + '  의도한 변경이면 `npm run test:golden:update` 로 기준값을 갱신하세요.');
    }
  });
}
