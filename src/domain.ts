import type {
  Adjudication,
  AdjudicationKind,
  FrozenResultRow,
  Race,
  Registration,
  ResultVersion,
  SubmitterRole,
  VersionRow,
  VersionStatus,
  VersionTrigger
} from './types';

let seedCounter = 0;
export function uid(prefix = 'id'): string {
  seedCounter += 1;
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now().toString(36)}-${seedCounter}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function registrationsOf(race: Race, registrations: Registration[]): Registration[] {
  return registrations
    .filter((item) => item.raceId === race.id)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function headVersion(race: Race): ResultVersion | undefined {
  return race.versions[race.versions.length - 1];
}

export function officialVersion(race: Race): ResultVersion | undefined {
  return race.versions.find((version) => version.id === race.officialVersionId);
}

export function isPublished(race: Race): boolean {
  return Boolean(race.officialVersionId);
}

export function isFrozen(race: Race): boolean {
  return Boolean(race.frozenAt) && race.frozen.length > 0;
}

/** 按裁决台账计算某尾号下的完整排行榜 */
export function computeRows(race: Race, untilSeq: number): VersionRow[] {
  const rows = new Map<string, VersionRow>();
  for (const frozen of race.frozen) {
    rows.set(frozen.entryId, {
      entryId: frozen.entryId,
      frozenElapsed: frozen.elapsedSeconds,
      resailElapsed: null,
      penaltyTotal: 0,
      displayedSeconds: frozen.elapsedSeconds,
      retired: false,
      rank: null
    });
  }

  const items: Adjudication[] = race.ledger
    .filter((item) => item.seq <= untilSeq)
    .sort((a, b) => a.seq - b.seq);

  for (const item of items) {
    const row = rows.get(item.entryId);
    if (!row) continue;
    switch (item.kind) {
      case 'penalty':
        row.penaltyTotal += item.payload.penaltySeconds ?? 0;
        break;
      case 'exoneration':
        row.penaltyTotal = Math.max(0, row.penaltyTotal - (item.payload.penaltySeconds ?? 0));
        break;
      case 'resail':
        if (typeof item.payload.elapsedSeconds === 'number') row.resailElapsed = item.payload.elapsedSeconds;
        break;
      case 'retire':
        row.retired = true;
        break;
      case 'reinstate':
        row.retired = false;
        break;
      case 'rejection':
        break;
    }
  }

  for (const row of rows.values()) {
    row.displayedSeconds = (row.resailElapsed ?? row.frozenElapsed) + row.penaltyTotal;
  }

  // 有效成绩按显示用时升序；弃权船排在之后，按冻结序号保持稳定
  const ordered = [...rows.values()];
  const frozenIndex = new Map(race.frozen.map((row, index) => [row.entryId, index]));
  const finishers = ordered
    .filter((row) => !row.retired)
    .sort((a, b) => a.displayedSeconds - b.displayedSeconds || (frozenIndex.get(a.entryId) ?? 0) - (frozenIndex.get(b.entryId) ?? 0));
  const retired = ordered
    .filter((row) => row.retired)
    .sort((a, b) => (frozenIndex.get(a.entryId) ?? 0) - (frozenIndex.get(b.entryId) ?? 0));

  finishers.forEach((row, index) => { row.rank = index + 1; });
  retired.forEach((row) => { row.rank = null; });

  return [...finishers, ...retired];
}

function cloneRows(rows: VersionRow[]): VersionRow[] {
  return rows.map((row) => ({ ...row }));
}

export function buildVersion(params: {
  race: Race;
  ledgerSeq: number;
  trigger: VersionTrigger;
  label: string;
  note: string;
  createdAt: string;
}): ResultVersion {
  const status: VersionStatus = params.trigger === 'correction' ? 'correction' : 'draft';
  return {
    id: uid('ver'),
    raceId: params.race.id,
    versionNo: 0, // 由调用方按归属比赛赋值
    ledgerSeq: params.ledgerSeq,
    status,
    trigger: params.trigger,
    label: params.label,
    note: params.note,
    createdAt: params.createdAt,
    rows: cloneRows(computeRows(params.race, params.ledgerSeq))
  };
}

export function freezeResult(race: Race, registrations: Registration[], at: string): Race {
  const next: Race = { ...race, status: 'finished', frozenAt: at, frozen: [], ledger: race.ledger ?? [], versions: race.versions ?? [] };
  const frozen: FrozenResultRow[] = registrationsOf(next, registrations)
    .map((registration) => ({ entryId: registration.id, elapsedSeconds: registration.rawElapsedSeconds ?? 0 }));
  next.frozen = frozen;
  const v1 = buildVersion({ race: next, ledgerSeq: 0, trigger: 'freeze', label: '冻结原始成绩', note: '比赛结束，原始成绩冻结', createdAt: at });
  v1.versionNo = 1;
  next.versions = [...next.versions, v1];
  return next;
}

export interface AppendAdjudicationInput {
  raceId: string;
  entryId: string;
  kind: AdjudicationKind;
  penaltySeconds?: number;
  elapsedSeconds?: number;
  rule?: string;
  note?: string;
  protestId?: string;
  submittedBy: SubmitterRole;
  /** 提交方所见台账尾号；旧于实际尾号时仍接续追加，不覆盖既有裁决 */
  baseSeq: number;
  createdAt?: string;
  source?: 'legacy';
}

export interface AppendResult {
  race: Race;
  adjudication: Adjudication;
  version: ResultVersion;
  rebased: boolean;
}

export function appendAdjudication(race: Race, input: AppendAdjudicationInput): AppendResult {
  if (!isFrozen(race)) throw new Error('比赛尚未结束，不能登记裁决');
  const createdAt = input.createdAt ?? nowIso();
  const head = headVersion(race);
  const currentSeq = race.ledger.length;
  const seq = currentSeq + 1;
  const rebased = input.baseSeq < currentSeq;
  const adjudication: Adjudication = {
    id: uid('adj'),
    raceId: race.id,
    seq,
    baseSeq: input.baseSeq,
    rebasedSeq: currentSeq,
    kind: input.kind,
    entryId: input.entryId,
    payload: {
      penaltySeconds: input.penaltySeconds,
      elapsedSeconds: input.elapsedSeconds,
      rule: input.rule,
      note: input.note,
      protestId: input.protestId
    },
    submittedBy: input.submittedBy,
    createdAt,
    source: input.source
  };

  const ledger = [...race.ledger, adjudication];
  let draftRace: Race = { ...race, ledger };
  // 已发布后追加：生成更正版；未发布：晚到裁决触发重新计算
  const trigger: VersionTrigger = isPublished(race) ? 'correction' : 'recompute';
  const label = trigger === 'correction'
    ? `更正版 ${head ? head.versionNo + 1 : 1}（${kindLabel(input.kind)}）`
    : `重算稿 ${head ? head.versionNo + 1 : 1}（${kindLabel(input.kind)}）`;
  const note = input.note
    || (rebased
      ? `并发提交：基于 ${input.baseSeq} 号，接续 ${currentSeq} 号既有裁决后重算`
      : `追加裁决：${kindLabel(input.kind)}`);

  const version = buildVersion({ race: draftRace, ledgerSeq: seq, trigger, label, note, createdAt });
  version.versionNo = (head?.versionNo ?? 0) + 1;
  draftRace = { ...draftRace, versions: [...draftRace.versions, version] };
  return { race: draftRace, adjudication, version, rebased };
}

/** 发布当前最新版本为正式成绩；旧版本转为 superseded 但保留可追溯 */
export function publishHead(race: Race, at: string, note = '裁判组发布正式成绩'): Race {
  const head = headVersion(race);
  if (!head) throw new Error('没有可发布的成绩版本');
  if (race.officialVersionId === head.id) return race;
  const versions = race.versions.map((version) =>
    version.id === head.id
      ? { ...version, status: 'official' as VersionStatus, publishedAt: at }
      : version.status === 'official'
        ? { ...version, status: 'superseded' as VersionStatus }
        : version
  );
  return { ...race, officialVersionId: head.id, versions };
}

export function kindLabel(kind: AdjudicationKind): string {
  const map: Record<AdjudicationKind, string> = {
    penalty: '抗议处罚',
    exoneration: '免责撤销处罚',
    resail: '重赛成绩',
    retire: '弃权',
    reinstate: '撤销弃权',
    rejection: '抗议驳回'
  };
  return map[kind];
}

export const roleLabel: Record<SubmitterRole, string> = {
  timer: '计时员',
  judge: '裁判',
  ro: '竞赛官'
};
