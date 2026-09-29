// 校验老数据（regatta-control-v1）升级后仍可打开（CJS 版，支持清缓存二次加载）
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => void store.set(k, v),
  removeItem: (k) => void store.delete(k)
};

store.set('regatta-control-v1', JSON.stringify({
  races: [{ id: 'race-old', name: '老比赛', fleet: 'F', course: 'C', startsAt: new Date().toISOString(), status: 'finished' }],
  entries: [
    { id: 'e1', boat: '甲船', sailNo: '1', skipper: 's1', elapsedSeconds: 1000, penaltySeconds: 0, resultStatus: 'provisional', note: '' },
    { id: 'e2', boat: '乙船', sailNo: '2', skipper: 's2', elapsedSeconds: 1020, penaltySeconds: 40, resultStatus: 'official', note: '旧争议' }
  ],
  protests: [{ id: 'p1', raceId: 'race-old', entryId: 'e2', reason: '接触', rule: 'RRS 14', status: 'resolved', decision: '加罚', createdAt: new Date().toISOString() }],
  timeline: [{ id: 't1', time: new Date().toISOString(), type: 'protest', message: '旧时间线事件' }]
}));

let failed = 0;
const assert = (cond, msg) => {
  console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`);
  if (!cond) failed += 1;
};

const mod = require('./tmp-store.cjs');
const initialState = mod.initialState;

assert(initialState.schemaVersion === 2, '状态升级为 schema v2');
const race = initialState.races[0];
assert(race.id === 'race-old' && race.status === 'finished' && !!race.frozenAt, '老比赛迁移后处于冻结状态');
assert(race.frozen.length === 2, '原始成绩行完整迁移');
assert(race.frozen.every((r) => r.elapsedSeconds > 0), '原始用时保留');
assert(race.ledger.length === 1 && race.ledger[0].kind === 'penalty' && race.ledger[0].payload.penaltySeconds === 40, '旧处罚秒数转为台账裁决（追加式）');
assert(race.ledger[0].source === 'legacy', '迁移裁决带 legacy 标记');
assert(race.versions.length === 2, '生成 v1 冻结版 + v2 重算版');
assert(!!race.officialVersionId, '沿用旧 official 标记完成发布');
assert(initialState.registrations.length === 2 && initialState.protests.length === 1, '船队与抗议记录保留');
assert(initialState.timeline.some((e) => e.type === 'system' && e.message.includes('老数据升级')), '时间线记录了升级事件');
assert(initialState.timeline.some((e) => e.message === '旧时间线事件'), '旧时间线条目保留');

// v2 往返：store 订阅已写入 regatta-control-v2；清缓存重新加载应读到 v2
delete require.cache[require.resolve('./tmp-store.cjs')];
const reloaded = require('./tmp-store.cjs').initialState;
assert(reloaded.races[0].versions.length === 2, '升级后数据再次打开版本不丢失');
assert(reloaded.races[0].frozen.length === 2, '再次打开冻结原始成绩仍在');

console.log(failed === 0 ? '\n迁移校验全部通过' : `\n${failed} 项失败`);
process.exit(failed ? 1 : 0);
