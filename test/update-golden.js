/*
 * 요금 계산 회귀 기준값 갱신 (`npm run test:golden:update`).
 *
 * 요율표나 계산 로직을 의도적으로 바꿨을 때만 실행한다. 실행하면 현재 코드의 결과가
 * 그대로 정답이 되므로, 무엇이 왜 바뀌었는지 반드시 확인하고 커밋 메시지에 남긴다.
 */

/* eslint-disable no-console */

'use strict';

const fs = require('fs');
const path = require('path');

const { run } = require('./lib/bill-matrix');

const FIXTURE = path.join(__dirname, 'fixtures', 'bill-matrix.json');

function statusOf(old, result) {
  if (!old) return '추가';
  if (old.sha256 !== result.sha256 || old.cases !== result.cases) return '변경';
  return '동일';
}

function main() {
  const before = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const next = { _comment: before._comment };
  let changed = 0;

  for (const result of run()) {
    const old = before[result.group];
    const status = statusOf(old, result);
    if (status !== '동일') changed += 1;

    console.log(`${status}  ${result.group.padEnd(12)} ${String(result.cases).padStart(6)}건  ${result.sha256}`);
    if (status === '변경') {
      console.log(`      이전: ${String(old.cases).padStart(6)}건  ${old.sha256}`);
    }

    next[result.group] = { cases: result.cases, sha256: result.sha256 };
  }

  if (!changed) {
    console.log('\n변경 없음 — 기준값을 그대로 둡니다.');
    return;
  }

  fs.writeFileSync(FIXTURE, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`\n${changed}개 그룹의 기준값을 갱신했습니다: ${path.relative(process.cwd(), FIXTURE)}`);
  console.log('변경 사유를 커밋 메시지에 남기세요.');
}

main();
