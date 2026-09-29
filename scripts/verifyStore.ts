import assert from 'node:assert/strict';
import { createRegattaSlice, loadState, seedState } from '../src/ledgerSlice.ts';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const slice = createRegattaSlice(seedState());
let state = seedState();
const dispatch = (action) => { state = slice.reducer(state, action); };
const ctx = () => {
  const r = 'race-1';
  return {
    race: state.races[0],
    boats: state.boats[r],
    frozen: state.frozen[r],
    adjs: state.adjudications[r],
    versions: state.versions[r]
  };
};
const freezeResults = () => ctx().boats.map((b, i) => ({ entryId: b.id, elapsedSeconds: 3000 + i * 100 }));
const rowOf = (version, entryId) => version.rows.find((r) => r.entryId === entryId);
const adjInput = (over) => ({
  raceId: 'race-1',
  entryId: ctx().boats[1].id,
  kind: 'protestUpheldPenalty',
  role: 'jury',
  title: '抗议成立·加罚',
  detail: '测试',
  penaltyDeltaSeconds: 30,
  author: '裁判',
  ...over
});

// 1. 比赛结束即冻结
test('结束比赛：冻结原始成绩并生成 V1 原始版', () => {
  dispatch(slice.actions.startRace({ id: 'race-1' }));
  dispatch(slice.actions.freezeRace({ id: 'race-1', results: freezeResults(), by: '计时员罗夏' }));
  const c = ctx();
  assert.equal(c.race.status, 'finished');
  assert.ok(c.race.frozenAt);
  assert.equal(c.frozen.length, 3);
  assert.equal(c.versions.length, 1);
  assert.equal(c.versions[0].kind, 'original');
  assert.equal(c.versions[0].status, 'draft');
  assert.equal(rowOf(c.versions[0], c.boats[0].id).elapsedSeconds, 3000);
});

// 2. 冻结不可逆：再次结束/冻结被忽略，原始记录不变
test('冻结不可逆：重复冻结被忽略，原始秒数保留', () => {
  const before = JSON.stringify(ctx().frozen);
  dispatch(slice.actions.freezeRace({ id: 'race-1', results: ctx().boats.map((b) => ({ entryId: b.id, elapsedSeconds: 1 })), by: 'x' }));
  assert.equal(JSON.stringify(ctx().frozen), before);
  assert.equal(ctx().versions.length, 1);
});

// 3. 未发布时晚到裁决触发重算；冻结数组不动
test('未发布：追加裁决触发 V2 重算，原始记录仍保留', () => {
  dispatch(slice.actions.appendAdjudication({ input: adjInput({ penaltyDeltaSeconds: 30 }) }));
  const c = ctx();
  assert.equal(c.adjs.length, 1);
  assert.equal(c.frozen.find((f) => f.entryId === c.boats[1].id).elapsedSeconds, 3100, '原始冻结用时不变');
  assert.equal(c.versions.length, 2);
  assert.equal(c.versions[0].status, 'superseded', '旧草稿被标记取代但保留');
  const v2 = c.versions[1];
  assert.equal(v2.kind, 'recalculation');
  assert.equal(v2.status, 'draft');
  assert.equal(rowOf(v2, c.boats[1].id).correctedSeconds, 3130);
});

// 4. 计时员与裁判并发：后到者基于已登记裁决续算，不覆盖处罚/重赛
test('并发提交：重赛替换用时但保留先到的加罚（裁判+30 已登记）', () => {
  // 计时员的重赛“后到”，只替换用时；+30 处罚必须仍在
  dispatch(slice.actions.appendAdjudication({ input: adjInput({
    kind: 'rerace', role: 'timer', title: '重赛成绩', detail: '重赛轮净用时', elapsedSeconds: 2950, author: '计时员罗夏'
  }) }));
  const c = ctx();
  assert.equal(c.adjs.length, 2);
  assert.equal(c.adjs[1].basedOnSeq, 1, '后到者基于已登记序号 1');
  const v3 = c.versions.at(-1);
  const row = rowOf(v3, c.boats[1].id);
  assert.equal(row.elapsedSeconds, 2950);
  assert.equal(row.penaltySeconds, 30, '先到的处罚不能被重赛覆盖');
  assert.equal(row.correctedSeconds, 2980);
});

test('并发提交：第二项加罚累加为 50 而非覆盖为 20', () => {
  dispatch(slice.actions.appendAdjudication({ input: adjInput({ penaltyDeltaSeconds: 20, role: 'timer', author: '计时员', detail: '另一项加罚' }) }));
  const v4 = ctx().versions.at(-1);
  assert.equal(rowOf(v4, ctx().boats[1].id).penaltySeconds, 50);
});

// 5. 发布：仅最新版本成为正式成绩
test('发布 V4：仅最新版正式，旧版全部可追溯', () => {
  dispatch(slice.actions.publishVersion({ raceId: 'race-1', by: '仲裁主席宋宁' }));
  const c = ctx();
  assert.equal(c.race.officialVersionId, c.versions.at(-1).id);
  assert.equal(c.versions.at(-1).status, 'published');
  assert.ok(c.versions.at(-1).publishedAt);
  assert.ok(c.versions.slice(0, -1).every((v) => v.status === 'superseded'));
  assert.equal(c.versions.length, 4, 'V1..V4 全部保留');
  const officialRow = rowOf(c.versions.find((v) => v.id === c.race.officialVersionId), c.boats[1].id);
  assert.equal(officialRow.correctedSeconds, 3000, '2950+50');
});

// 6. 发布后晚到裁决：不生成新版本、正式版不变
test('发布后晚到裁决：只入台账，正式版不变，不自动重算', () => {
  const officialSnapshot = JSON.stringify(ctx().versions.find((v) => v.status === 'published'));
  dispatch(slice.actions.appendAdjudication({ input: adjInput({ penaltyDeltaSeconds: 100, detail: '发布后才送达的抗议' }) }));
  const c = ctx();
  assert.equal(c.adjs.length, 4);
  assert.equal(c.race.lastSeq, 4);
  assert.equal(c.versions.length, 4, '版本数不变');
  assert.equal(JSON.stringify(c.versions.find((v) => v.status === 'published')), officialSnapshot, '正式快照未被改动');
});

// 7. 只能生成更正版，发布后最新才转正
test('生成更正版 V5 草稿 → 发布后 V5 正式，V4 转历史且可追溯', () => {
  dispatch(slice.actions.createCorrectionVersion({ raceId: 'race-1', reason: '赛后抗议成立', by: '宋宁' }));
  let c = ctx();
  assert.equal(c.versions.length, 5);
  const v5 = c.versions.at(-1);
  assert.equal(v5.status, 'draft');
  assert.equal(v5.basedOnSeq, 4);
  assert.equal(rowOf(v5, c.boats[1].id).penaltySeconds, 150, '50+100 累加');

  dispatch(slice.actions.publishVersion({ raceId: 'race-1', by: '宋宁' }));
  c = ctx();
  assert.equal(c.race.officialVersionId, v5.id);
  assert.equal(c.versions.find((x) => x.id === v5.id).status, 'published');
  assert.equal(c.versions.find((x) => x.versionNo === 4).status, 'superseded');
  assert.equal(c.versions.find((x) => x.versionNo === 1).kind, 'original', '原始版仍可追溯');
});

// 8. 打开更正版期间的晚到裁决继续并入草稿
test('更正版草稿打开期间，晚到裁决继续并入草稿，正式版不动', () => {
  // 先开更正版草稿（此时台账截至 #4），随后晚到的弃权裁决并入该草稿
  dispatch(slice.actions.createCorrectionVersion({ raceId: 'race-1', reason: '赛后补录', by: '宋宁' }));
  const draftBefore = ctx().versions.find((v) => v.status === 'draft');
  assert.equal(draftBefore.versionNo, 6);
  dispatch(slice.actions.appendAdjudication({ input: adjInput({ kind: 'retirement', title: '弃权 RET', detail: '器材损坏', author: '裁判' }) }));
  const c = ctx();
  const draft = c.versions.find((v) => v.status === 'draft');
  assert.equal(draft.versionNo, 7, '草稿期间继续生成新重算草稿');
  assert.equal(rowOf(draft, c.boats[1].id).status, 'retired');
  assert.equal(rowOf(draft, c.boats[1].id).rank, null);
  // 正式版 V5 不受草稿影响
  assert.equal(c.versions.find((v) => v.id === c.race.officialVersionId).versionNo, 5);
});

// 9. 时间线包含冻结/裁决/重算/发布全过程
test('时间线记录裁决、重算与发布全过程', () => {
  const types = new Set(state.timeline.map((e) => e.type));
  for (const t of ['freeze', 'adjudication', 'recalc', 'publish']) assert.ok(types.has(t), `缺少 ${t} 事件`);
  const pubs = state.timeline.filter((e) => e.type === 'publish');
  assert.equal(pubs.length, 2);
});

// 10. 抗议裁决原子写入台账
test('抗议登记→复核→成立加罚：抗议单与裁决台账一致', () => {
  const local = seedState();
  const sl = createRegattaSlice(local);
  let s = local;
  const d = (a) => { s = sl.reducer(s, a); };
  const b2 = s.boats['race-1'][0].id;
  d(sl.actions.freezeRace({ id: 'race-1', results: s.boats['race-1'].map((b, i) => ({ entryId: b.id, elapsedSeconds: 3000 + i * 100 })), by: '计时员' }));
  d(sl.actions.registerProtest({ raceId: 'race-1', entryId: b2, reason: '起航接触事件', rule: 'RRS 14', by: '宋宁' }));
  const pid = s.protests[0].id;
  d(sl.actions.setProtestReviewing({ id: pid }));
  d(sl.actions.resolveProtest({ protestId: pid, decision: '抗议成立，加罚 30 秒', kind: 'protestUpheldPenalty', penaltyDeltaSeconds: 30, by: '宋宁' }));
  assert.equal(s.protests[0].status, 'resolved');
  assert.equal(s.adjudications['race-1'].length, 1);
  assert.equal(s.adjudications['race-1'][0].refId, pid);
  const v2 = s.versions['race-1'].at(-1);
  assert.equal(v2.rows.find((r) => r.entryId === b2).correctedSeconds, 3030);
  // 已裁决抗议不能重复入账
  d(sl.actions.resolveProtest({ protestId: pid, decision: '再罚一次', kind: 'protestUpheldPenalty', penaltyDeltaSeconds: 99, by: 'x' }));
  assert.equal(s.adjudications['race-1'].length, 1, '重复裁决被忽略');
});

// 11. 旧数据通过 loadState 升级后可正常继续操作
test('loadState：v1 老数据升级后可继续冻结后流程', () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  mem.set('regatta-control-v1', JSON.stringify({
    races: [{ id: 'race-1', name: '旧', fleet: 'f', course: 'c', startsAt: new Date().toISOString(), status: 'finished' }],
    entries: [{ id: 'e1', boat: '甲', sailNo: '1', skipper: 'a', elapsedSeconds: 3000, penaltySeconds: 10, resultStatus: 'provisional', note: '' }],
    protests: [],
    timeline: []
  }));
  const migrated = loadState(storage);
  const sl = createRegattaSlice(migrated);
  let s = migrated;
  const d = (a) => { s = sl.reducer(s, a); };
  assert.equal(mem.has('regatta-ledger-v2'), true, '升级结果写回 v2 键');
  // 已结束+已冻结状态下追加裁决，沿用升级后的序号继续
  d(sl.actions.appendAdjudication({ input: {
    raceId: 'race-1', entryId: 'e1', kind: 'protestUpheldPenalty', role: 'jury', title: '抗议成立·加罚', detail: '升级后新裁决', penaltyDeltaSeconds: 5, author: '宋宁'
  } }));
  const draft = s.versions['race-1'].find((v) => v.status === 'draft');
  assert.equal(draft.rows[0].penaltySeconds, 15, '历史 10 秒 + 新 5 秒');
});

console.log(`\n全部 ${passed} 项 reducer 验证通过`);
