export type RaceStatus = 'scheduled' | 'running' | 'finished';
export type ProtestStatus = 'submitted' | 'reviewing' | 'resolved' | 'rejected';

/** 版本状态：未发布的重算稿、更正版（发布后追加裁决产生）、正式版、被取代的旧版 */
export type VersionStatus = 'draft' | 'correction' | 'official' | 'superseded';
export type VersionTrigger = 'freeze' | 'recompute' | 'correction';

/**
 * 裁决类型：
 * - penalty 抗议处罚（加秒）
 * - exoneration 免责 / 撤销处罚（减秒，不低于 0）
 * - resail 重赛成绩（替换该船显示用时，不影响既有处罚）
 * - retire 弃权（计 RET，排在所有有效成绩之后）
 * - reinstate 撤销弃权
 * - rejection 抗议驳回（不改变成绩，仅留痕）
 */
export type AdjudicationKind = 'penalty' | 'exoneration' | 'resail' | 'retire' | 'reinstate' | 'rejection';

export type SubmitterRole = 'timer' | 'judge' | 'ro';

export interface Registration {
  id: string;
  raceId: string;
  boat: string;
  sailNo: string;
  skipper: string;
  /** 赛前/赛中计时员录入的原始到岸用时；比赛结束冻结后即不可再改 */
  rawElapsedSeconds: number | null;
}

/** 冻结的原始成绩行，冻结后永不变更 */
export interface FrozenResultRow {
  entryId: string;
  elapsedSeconds: number;
}

/** 追加式裁决台账条目，只增不改 */
export interface Adjudication {
  id: string;
  raceId: string;
  /** 登记顺序号（1 起），后到的裁决只能追加在队尾 */
  seq: number;
  /** 提交方计算时所依据的台账尾号；小于登记时的实际尾号说明发生并发 */
  baseSeq: number;
  /** 实际接续的台账尾号（登记时的队尾），用于展示重算基线 */
  rebasedSeq: number;
  kind: AdjudicationKind;
  entryId: string;
  payload: {
    penaltySeconds?: number;
    elapsedSeconds?: number;
    rule?: string;
    note?: string;
    protestId?: string;
  };
  submittedBy: SubmitterRole;
  createdAt: string;
  /** 旧版数据迁移进来的裁决 */
  source?: 'legacy';
}

export interface VersionRow {
  entryId: string;
  /** 原始冻结用时，恒等于冻结快照 */
  frozenElapsed: number;
  /** 截至该版本最新一次重赛成绩（无则 null） */
  resailElapsed: number | null;
  /** 截至该版本累计处罚秒数（免责已冲抵） */
  penaltyTotal: number;
  /** 显示成绩 = 重赛或原始用时 + 累计处罚 */
  displayedSeconds: number;
  retired: boolean;
  /** 有效名次；弃权船为 null */
  rank: number | null;
}

export interface ResultVersion {
  id: string;
  raceId: string;
  /** 版次，1 起 */
  versionNo: number;
  /** 该版本包含的台账尾号 */
  ledgerSeq: number;
  status: VersionStatus;
  trigger: VersionTrigger;
  label: string;
  note: string;
  createdAt: string;
  publishedAt?: string;
  rows: VersionRow[];
}

export interface Race {
  id: string;
  name: string;
  fleet: string;
  course: string;
  startsAt: string;
  status: RaceStatus;
  /** 比赛结束时刻；存在即表示原始成绩已冻结 */
  frozenAt?: string;
  /** 当前正式版本 id；只有最新版本可被发布为正式成绩 */
  officialVersionId?: string | null;
  frozen: FrozenResultRow[];
  ledger: Adjudication[];
  versions: ResultVersion[];
}

export interface Protest {
  id: string;
  raceId: string;
  entryId: string;
  reason: string;
  rule: string;
  status: ProtestStatus;
  decision: string;
  createdAt: string;
  /** 支持抗议并产生处罚时，关联台账裁决号 */
  linkedAdjudicationSeq?: number;
}

export type TimelineType = 'race' | 'freeze' | 'adjudication' | 'publish' | 'protest' | 'system' | 'result';

export interface TimelineEvent {
  id: string;
  time: string;
  raceId?: string;
  type: TimelineType;
  message: string;
  seq?: number;
  versionNo?: number;
}

export interface AppState {
  schemaVersion: 2;
  races: Race[];
  registrations: Registration[];
  protests: Protest[];
  timeline: TimelineEvent[];
  ui: { selectedRaceId: string };
}
