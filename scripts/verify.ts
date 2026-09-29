import assert from 'node:assert/strict';
import { buildRows, createAdjudication, makeVersion } from '../src/domain.ts';
import { migrateV1 } from '../src/migration.ts';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const boats = [
  { id: 'b1', boat: '海风号', sailNo: 'A1', skipper: '甲' },
  { id: 'b2', boat: '远岚号', sailNo: 'A2', skipper: '乙' },
  { id: 'b3', boat: '北辰号', sailNo: 'A3', skipper: '丙' }
];
const frozen = [
  { entryId: 'b1', elapsedSeconds: 1000 },
  { entryId: 'b2', elapsedSeconds: 1100 },
  { entryId: 'b3', elapsedSeconds: 1200 }
];
const at = (s) => new Date(Date.now() + s * 1000).toISOString();

function append(list, lastSeq, input) {
  const adj = createAdjudication({ basedOnSeq: lastSeq, at: at(list.length), ...input }, lastSeq);
  list.push(adj);
  return adj;
}
const rowMap = (rows) => Object.fromEntries(rows.map((r) => [r.entryId, r]));

// 1. 无裁决时，显示结果等于冻结原始成绩
test('冻结原始成绩原样显示', () => {
  const rows = buildRows(boats, frozen, []);
  const m = rowMap(rows);
  assert.equal(m.b1.elapsedSeconds, 1000);
  assert.equal(m.b1.correctedSeconds, 1000);
  assert.equal(m.b1.rank, 1);
});

// 2. 抗议处罚累加，且绝不覆盖先到处罚（计时员/裁判同时提交）
test('后到处罚基于已登记裁决累加，不覆盖先到处罚', () => {
  const adjs = [];
  let seq = 0;
  // 裁判先登记 +30
  seq = append(adjs, seq, { raceId: 'r', entryId: 'b2', kind: 'protestUpheldPenalty', role: 'jury', title: '抗议加罚', detail: 'x', penaltyDeltaSeconds: 30, author: '裁判A', basedOnSeq: 0 }).seq;
  // 计时员基于的是自己看到的旧序号 0（并发），后到 +20
  seq = append(adjs, seq, { raceId: 'r', entryId: 'b2', kind: 'protestUpheldPenalty', role: 'timer', title: '另一项加罚', detail: 'y', penaltyDeltaSeconds: 20, author: '计时员B', basedOnSeq: 0 }).seq;
  const m = rowMap(buildRows(boats, frozen, adjs));
  assert.equal(m.b2.penaltySeconds, 50, '两项处罚必须累加为 50');
  assert.equal(m.b2.correctedSeconds, 1150);
  assert.deepEqual(m.b2.sources, [1, 2]);
});

// 3. 重赛成绩替换用时，但不抹掉既有处罚
test('重赛只替换用时，不覆盖已登记处罚', () => {
  const adjs = [];
  let seq = 0;
  seq = append(adjs, seq, { raceId: 'r', entryId: 'b3', kind: 'protestUpheldPenalty', role: 'jury', title: '加罚40', detail: '', penaltyDeltaSeconds: 40, author: '裁判', basedOnSeq: 0 }).seq;
  seq = append(adjs, seq, { raceId: 'r', entryId: 'b3', kind: 'rerace', role: 'timer', title: '重赛成绩', detail: '', elapsedSeconds: 950, author: '计时员', basedOnSeq: 1 }).seq;
  const m = rowMap(buildRows(boats, frozen, adjs));
  assert.equal(m.b3.elapsedSeconds, 950);
  assert.equal(m.b3.penaltySeconds, 40);
  assert.equal(m.b3.correctedSeconds, 990);
});

// 4. 弃权 RET：不排名，且后续裁决不再改变结果
test('弃权不排名且先于后到裁决生效', () => {
  const adjs = [];
  let seq = 0;
  seq = append(adjs, seq, { raceId: 'r', entryId: 'b1', kind: 'retirement', role: 'jury', title: '弃权', detail: '器材损坏', author: '裁判', basedOnSeq: 0 }).seq;
  seq = append(adjs, seq, { raceId: 'r', entryId: 'b1', kind: 'protestUpheldPenalty', role: 'jury', title: '晚到加罚', detail: '', penaltyDeltaSeconds: 60, author: '裁判', basedOnSeq: 1 }).seq;
  const m = rowMap(buildRows(boats, frozen, adjs));
  assert.equal(m.b1.status, 'retired');
  assert.equal(m.b1.rank, null);
  assert.equal(m.b1.penaltySeconds, 0);
});

// 5. upToSeq 快照：旧版本可追溯，且不随新裁决变化
test('版本快照按截至序号冻结，旧版可追溯', () => {
  const adjs = [];
  let seq = 0;
  seq = append(adjs, seq, { raceId: 'r', entryId: 'b2', kind: 'protestUpheldPenalty', role: 'jury', title: '+30', detail: '', penaltyDeltaSeconds: 30, author: '裁判', basedOnSeq: 0 }).seq;
  const v1 = makeVersion(1, 'original', '原始', '计时员', 0, boats, frozen, adjs, at(0));
  seq = append(adjs, seq, { raceId: 'r', entryId: 'b2', kind: 'protestUpheldPenalty', role: 'jury', title: '+10', detail: '', penaltyDeltaSeconds: 10, author: '裁判', basedOnSeq: 1 }).seq;
  const v2 = makeVersion(2, 'recalculation', '重算', '裁判', seq, boats, frozen, adjs, at(1));
  assert.equal(v1.rows.find((r) => r.entryId === 'b2').correctedSeconds, 1100);
  assert.equal(v2.rows.find((r) => r.entryId === 'b2').correctedSeconds, 1140);
  assert.equal(v1.status, 'draft');
});

// 6. 晚到裁决通过 upToSeq 不影响已发布快照（发布不可变由 reducer 保证，这里验证快照独立性）
test('重新计算不修改既有版本对象', () => {
  const adjs = [];
  const v1 = makeVersion(1, 'original', '原始', 'x', 0, boats, frozen, adjs, at(0));
  append(adjs, 0, { raceId: 'r', entryId: 'b1', kind: 'timeCorrection', role: 'timer', title: '更正', detail: '', elapsedSeconds: 990, author: '计时员', basedOnSeq: 0 });
  const v2 = makeVersion(2, 'recalculation', '更正', 'x', 1, boats, frozen, adjs, at(1));
  assert.equal(v1.rows.find((r) => r.entryId === 'b1').elapsedSeconds, 1000);
  assert.equal(v2.rows.find((r) => r.entryId === 'b1').elapsedSeconds, 990);
});

// 7. 老数据升级：原始用时冻结 + 历史处罚转为追加裁决，且仍可打开
test('v1 旧数据迁移：冻结用时并保留历史处罚', () => {
  const v1 = {
    races: [{ id: 'race-1', name: '旧轮', fleet: 'F', course: 'C', startsAt: at(-100), status: 'finished' }],
    entries: [
      { id: 'e1', boat: '甲', sailNo: '1', skipper: 'a', elapsedSeconds: 3000, penaltySeconds: 0, resultStatus: 'provisional', note: '' },
      { id: 'e2', boat: '乙', sailNo: '2', skipper: 'b', elapsedSeconds: 3100, penaltySeconds: 30, resultStatus: 'corrected', note: '旧备注' }
    ],
    protests: [],
    timeline: [{ id: 'old-1', time: at(-50), type: 'protest', message: '旧抗议事件' }]
  };
  const s2 = migrateV1(v1);
  assert.equal(s2.schemaVersion, 2);
  assert.equal(s2.frozen['race-1'].find((f) => f.entryId === 'e2').elapsedSeconds, 3100, '原始用时必须是 3100');
  const legacy = s2.adjudications['race-1'];
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].kind, 'protestUpheldPenalty');
  assert.equal(legacy[0].penaltyDeltaSeconds, 30);
  assert.equal(s2.versions['race-1'].length, 2, '应有原始版+重算版');
  const latest = s2.versions['race-1'].at(-1);
  assert.equal(latest.rows.find((r) => r.entryId === 'e2').correctedSeconds, 3130);
  assert.ok(s2.timeline.some((e) => e.message.includes('旧抗议事件')), '旧时间线必须保留');
});

// 8. 已发布旧数据迁移：最新版标记为正式
test('v1 迁移保留正式发布状态', () => {
  const v1 = {
    races: [{ id: 'race-1', name: 'n', fleet: 'f', course: 'c', startsAt: at(-1), status: 'finished' }],
    entries: [{ id: 'e1', boat: '甲', sailNo: '1', skipper: 'a', elapsedSeconds: 3000, penaltySeconds: 20, resultStatus: 'official', note: '' }],
    protests: [],
    timeline: []
  };
  const s2 = migrateV1(v1);
  const versions = s2.versions['race-1'];
  assert.equal(versions.at(-1).status, 'published');
  assert.equal(s2.races[0].officialVersionId, versions.at(-1).id);
  assert.equal(versions[0].status, 'superseded', '原始版被正式重算版取代但保留');
});

console.log(`\n全部 ${passed} 项验证通过`);
