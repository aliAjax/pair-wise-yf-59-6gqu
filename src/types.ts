// 裁决台账领域模型：
// - 原始成绩在比赛结束时冻结，永不可变
// - 抗议裁决 / 重赛 / 计时更正 / 弃权全部以“追加裁决”形式登记
// - 显示结果 = 冻结原始成绩 + 按登记顺序折叠全部裁决
// - 未发布时晚到裁决触发重算草稿；发布后只能开出更正版
// - 所有版本快照保留，仅最新发布版为正式成绩

export type RaceStatus = 'scheduled' | 'running' | 'finished';
export type ResultStatus = 'ok' | 'penalized' | 'retired';
export type JudgeRole = 'timer' | 'jury';

/** 追加裁决的种类 */
export type AdjudicationKind =
  | 'protestUpheldPenalty' // 抗议成立：加罚秒数（在现有处罚上累加）
  | 'protestUpheldNoPenalty' // 抗议成立：免罚
  | 'protestRejected' // 抗议驳回：维持
  | 'rerace' // 重赛成绩：替换用时，不动既有处罚
  | 'timeCorrection' // 计时更正：替换用时，不动既有处罚
  | 'retirement'; // 弃权（RET）

export type VersionKind = 'original' | 'recalculation' | 'published';
export type VersionStatus = 'draft' | 'published' | 'superseded';

export interface Boat {
  id: string;
  boat: string;
  sailNo: string;
  skipper: string;
}

/** 冻结的原始成绩：比赛结束即写入，之后任何人不得修改 */
export interface FrozenResult {
  entryId: string;
  elapsedSeconds: number;
}

/** 追加裁决：只能新增，不能修改或删除 */
export interface Adjudication {
  seq: number; // 全局递增登记序号
  id: string;
  entryId: string;
  kind: AdjudicationKind;
  role: JudgeRole; // 提交人角色：计时员 / 裁判
  refId?: string; // 关联的抗议单等
  title: string;
  detail: string;
  penaltyDeltaSeconds?: number; // 加罚增量（累加，绝不覆盖）
  elapsedSeconds?: number; // 重赛 / 计时更正后的用时
  author: string;
  createdAt: string;
  /** 提交方看到的已登记序号；后到者基于已登记裁决继续计算 */
  basedOnSeq: number;
}

export interface VersionRow {
  entryId: string;
  boat: string;
  sailNo: string;
  skipper: string;
  elapsedSeconds: number;
  penaltySeconds: number;
  correctedSeconds: number;
  status: ResultStatus;
  rank: number | null; // 弃权不排名
  sources: number[]; // 生效裁决序号
}

/** 成绩版本快照：原始版 / 重算版，发布时转为正式版 */
export interface ResultVersion {
  id: string;
  versionNo: number;
  kind: VersionKind;
  status: VersionStatus;
  reason: string;
  createdAt: string;
  createdBy: string;
  basedOnSeq: number;
  publishedAt?: string;
  supersededAt?: string;
  rows: VersionRow[];
}

export interface Race {
  id: string;
  name: string;
  fleet: string;
  course: string;
  startsAt: string;
  status: RaceStatus;
  frozenAt?: string;
  lastSeq: number;
  draftVersionId?: string;
  officialVersionId?: string;
}

export type ProtestStatus = 'submitted' | 'reviewing' | 'resolved';

export interface Protest {
  id: string;
  raceId: string;
  entryId: string;
  reason: string;
  rule: string;
  status: ProtestStatus;
  decision: string;
  createdAt: string;
}

export type TimelineType = 'race' | 'freeze' | 'adjudication' | 'recalc' | 'publish' | 'system';

export interface TimelineEvent {
  id: string;
  time: string;
  type: TimelineType;
  title: string;
  message: string;
  versionNo?: number;
  seq?: number;
}

/** v2 持久化结构（regatta-ledger-v2） */
export interface RegattaStateV2 {
  schemaVersion: 2;
  races: Race[];
  boats: Record<string, Boat[]>;
  frozen: Record<string, FrozenResult[]>;
  adjudications: Record<string, Adjudication[]>;
  versions: Record<string, ResultVersion[]>;
  protests: Protest[];
  timeline: TimelineEvent[];
}

export interface AppendAdjudicationInput {
  raceId: string;
  entryId: string;
  kind: AdjudicationKind;
  role: JudgeRole;
  refId?: string;
  title: string;
  detail: string;
  penaltyDeltaSeconds?: number;
  elapsedSeconds?: number;
  author: string;
  basedOnSeq: number;
  at?: string;
}
