import { appendAdjudication, computeRows, freezeResult, headVersion, officialVersion, publishHead } from '../src/domain';
import type { Race, Registration } from '../src/types';

let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${msg}`);
  }
}

const regs: Registration[] = [
  { id: 'a', raceId: 'r', boat: 'A', sailNo: '1', skipper: '', rawElapsedSeconds: 100 },
  { id: 'b', raceId: 'r', boat: 'B', sailNo: '2', skipper: '', rawElapsedSeconds: 110 },
  { id: 'c', raceId: 'r', boat: 'C', sailNo: '3', skipper: '', rawElapsedSeconds: 120 }
];
const race0: Race = {
  id: 'r', name: 'T', fleet: '', course: '', startsAt: '', status: 'scheduled',
  frozen: [], ledger: [], versions: []
};

// 1. 冻结生成 v1，原始快照不变
let race = freezeResult(race0, regs, '2026-09-29T10:00:00Z');
assert(race.status === 'finished' && !!race.frozenAt, '比赛结束即冻结');
assert(headVersion(race)!.versionNo === 1, '冻结产生 v1');
assert(computeRows(race, 0).map((r) => r.rank).join(',') === '1,2,3', '冻结后初始名次 A,B,C');

// 2. 未发布时晚到裁决触发重算（新 draft），原始记录保留
const r1 = appendAdjudication(race, { raceId: 'r', entryId: 'a', kind: 'penalty', penaltySeconds: 30, submittedBy: 'judge', baseSeq: 0, note: '加30' });
race = r1.race;
assert(headVersion(race)!.versionNo === 2 && headVersion(race)!.trigger === 'recompute' && headVersion(race)!.status === 'draft', '晚到处罚触发重算稿 v2');
const rankA = headVersion(race)!.rows.find((x) => x.entryId === 'a')!;
assert(rankA.rank === 3 && rankA.displayedSeconds === 130, 'A 加30秒后显示130，名次降到第3（B110、C120）');
assert(race.frozen.find((f) => f.entryId === 'a')!.elapsedSeconds === 100, '冻结原始成绩仍为 100（保留）');

// 3. 并发：计时员（重赛）与裁判（处罚）同时提交，后到基于已登记裁决继续，不覆盖
const timer = appendAdjudication(race, { raceId: 'r', entryId: 'b', kind: 'resail', elapsedSeconds: 90, submittedBy: 'timer', baseSeq: 1, note: '重赛90' });
const judge = appendAdjudication(timer.race, { raceId: 'r', entryId: 'b', kind: 'penalty', penaltySeconds: 15, submittedBy: 'judge', baseSeq: 1, note: '加15（同时提交）' });
race = judge.race;
assert(judge.rebased === true && judge.adjudication.seq === 3 && judge.adjudication.rebasedSeq === 2, '后到提交识别并发并接续 #2，未覆盖');
const rowB = headVersion(race)!.rows.find((x) => x.entryId === 'b')!;
assert(rowB.resailElapsed === 90 && rowB.penaltyTotal === 15 && rowB.displayedSeconds === 105, 'B 重赛90 + 处罚15 = 105，两者都生效');
assert(headVersion(race)!.versionNo === 4, '两次追加各产生一个版本 v3/v4');

// 4. 弃权 RET 排在所有有效成绩之后
const r5 = appendAdjudication(race, { raceId: 'r', entryId: 'c', kind: 'retire', submittedBy: 'judge', baseSeq: 3, note: 'C 弃权' });
race = r5.race;
const cRow = headVersion(race)!.rows.find((x) => x.entryId === 'c')!;
assert(cRow.retired === true && cRow.rank === null, 'C 弃权计 RET，无有效名次');
assert(headVersion(race)!.rows[headVersion(race)!.rows.length - 1].entryId === 'c', '弃权船排在榜单末尾');

// 5. 发布最新版为正式，旧版保留
const beforeVersions = race.versions.length;
race = publishHead(race, '2026-09-29T11:00:00Z');
assert(!!race.officialVersionId && officialVersion(race)!.status === 'official', '最新 v5 成为正式成绩');
assert(race.versions.length === beforeVersions, '发布不新增版本');
assert(race.versions[0].status !== 'official' || race.versions[0].id === race.officialVersionId, '旧版不再标记为正式');

// 6. 发布后追加只能生成更正版，正式成绩不变，再发布后更新
const officialNo = officialVersion(race)!.versionNo;
const r6 = appendAdjudication(race, { raceId: 'r', entryId: 'b', kind: 'exoneration', penaltySeconds: 15, submittedBy: 'judge', baseSeq: 4, note: '免责撤销15' });
race = r6.race;
const head = headVersion(race)!;
assert(head.trigger === 'correction' && head.status === 'correction', '发布后追加生成更正版');
assert(officialVersion(race)!.versionNo === officialNo, '正式成绩仍指向原版本，未被改动');
const bCorrected = head.rows.find((x) => x.entryId === 'b')!;
assert(bCorrected.penaltyTotal === 0 && bCorrected.displayedSeconds === 90, '免责撤销15后 B 为 90（重赛仍保留）');
race = publishHead(race, '2026-09-29T12:00:00Z');
assert(officialVersion(race)!.versionNo === head.versionNo, '重新发布后更正版成为正式成绩');
assert(race.versions.some((v) => v.status === 'superseded'), '旧正式版标记为 superseded 但仍可追溯');
assert(race.versions.length === 6, '全部历史版本均保留（冻结+4裁决+1更正共6版）');

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
