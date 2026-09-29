import { makeVersion } from './domain';
import type {
  Adjudication,
  Boat,
  FrozenResult,
  Race,
  RegattaStateV2,
  ResultVersion,
  TimelineEvent,
  TimelineType
} from './types';

/** 旧版（逐条改秒数）持久化结构 */
export interface V1State {
  races: Array<{ id: string; name: string; fleet: string; course: string; startsAt: string; status: Race['status'] }>;
  entries: Array<{
    id: string;
    boat: string;
    sailNo: string;
    skipper: string;
    elapsedSeconds: number;
    penaltySeconds: number;
    resultStatus: 'provisional' | 'corrected' | 'official';
    note: string;
  }>;
  protests: Array<{ id: string; raceId: string; entryId: string; reason: string; rule: string; status: string; decision: string; createdAt: string }>;
  timeline: Array<{ id: string; time: string; type: string; message: string }>;
}

const mapTimelineType = (type: string): TimelineType => {
  if (type === 'race') return 'race';
  if (type === 'protest') return 'adjudication';
  if (type === 'result') return 'recalc';
  return 'system';
};

/**
 * 老数据升级：旧台账里直接改过的秒数被拆成
 * 「冻结原始成绩 + 追加处罚裁决」，旧时间线保留可读。
 */
export function migrateV1(v1: V1State): RegattaStateV2 {
  const at = new Date().toISOString();
  const race: Race = v1.races[0]
    ? {
        id: v1.races[0].id,
        name: v1.races[0].name,
        fleet: v1.races[0].fleet,
        course: v1.races[0].course,
        startsAt: v1.races[0].startsAt,
        // 旧数据含到达秒数，视为已结束并冻结
        status: 'finished',
        frozenAt: at,
        lastSeq: 0
      }
    : {
        id: 'race-1',
        name: '海湾长距离赛 第1轮',
        fleet: '统一级',
        course: 'W2 / 东北风 12节',
        startsAt: at,
        status: 'scheduled',
        lastSeq: 0
      };

  const boats: Boat[] = v1.entries.map((e) => ({ id: e.id, boat: e.boat, sailNo: e.sailNo, skipper: e.skipper }));
  const frozen: FrozenResult[] = v1.entries.map((e) => ({ entryId: e.id, elapsedSeconds: e.elapsedSeconds }));

  const adjudications: Adjudication[] = [];
  let seq = 0;
  for (const e of v1.entries) {
    if (e.penaltySeconds > 0) {
      seq += 1;
      adjudications.push({
        seq,
        id: `legacy-adj-${e.id}`,
        entryId: e.id,
        kind: 'protestUpheldPenalty',
        role: 'jury',
        title: '旧台账迁移：历史处罚',
        detail: e.note ? `旧记录备注：${e.note}` : '旧版成绩中直接登记的处罚秒数，升级后转为追加裁决，原始用时保持冻结。',
        penaltyDeltaSeconds: e.penaltySeconds,
        author: '系统迁移',
        createdAt: at,
        basedOnSeq: 0
      });
    }
  }
  race.lastSeq = seq;

  const versions: ResultVersion[] = [];
  const original = makeVersion(1, 'original', '原始成绩（旧数据冻结）', '系统迁移', 0, boats, frozen, adjudications, at);
  versions.push(original);

  let current: typeof original = original;
  if (seq > 0) {
    const recalculated = makeVersion(2, 'recalculation', '旧台账历史处罚重算', '系统迁移', seq, boats, frozen, adjudications, at);
    versions.push(recalculated);
    current = recalculated;
  }

  const hadOfficial = v1.entries.some((e) => e.resultStatus === 'official');
  if (hadOfficial) {
    current.status = 'published';
    current.publishedAt = at;
    if (current.kind !== 'original') versions[0].status = 'superseded';
    race.officialVersionId = current.id;
  } else {
    race.draftVersionId = current.id;
  }

  const timeline: TimelineEvent[] = [
    {
      id: crypto.randomUUID(),
      time: at,
      type: 'system',
      title: '数据升级完成',
      message: '旧版逐条改秒数据已升级为裁决台账：原始成绩冻结，历史处罚转为追加裁决，旧时间线原样保留。'
    },
    ...v1.timeline.map((e) => ({ id: e.id, time: e.time, type: mapTimelineType(e.type), title: e.message, message: e.message }))
  ];

  return {
    schemaVersion: 2,
    races: [race],
    boats: { [race.id]: boats },
    frozen: { [race.id]: frozen },
    adjudications: { [race.id]: adjudications },
    versions: { [race.id]: versions },
    protests: v1.protests.map((p) => ({
      id: p.id,
      raceId: p.raceId,
      entryId: p.entryId,
      reason: p.reason,
      rule: p.rule,
      status: p.status === 'rejected' ? 'resolved' : (p.status as 'submitted' | 'reviewing' | 'resolved'),
      decision: p.decision,
      createdAt: p.createdAt
    })),
    timeline
  };
}
