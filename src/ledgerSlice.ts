import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createAdjudication, makeVersion } from './domain';
import { migrateV1, type V1State } from './migration';
import type {
  Adjudication,
  AdjudicationKind,
  AppendAdjudicationInput,
  Protest,
  Race,
  RegattaStateV2,
  ResultVersion
} from './types';

export function uid(prefix: string): string {
  const c = globalThis.crypto as Crypto | undefined;
  return c?.randomUUID ? `${prefix}-${c.randomUUID()}` : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

// ---------- 初始演示数据：比赛尚未结束，船队已就绪，等待计时员提交 ----------
export function seedState(): RegattaStateV2 {
  const at = nowIso();
  const start = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const race: Race = {
    id: 'race-1',
    name: '海湾长距离赛 第1轮',
    fleet: '统一级',
    course: 'W2 / 东北风 12节',
    startsAt: start,
    status: 'scheduled',
    lastSeq: 0
  };
  return {
    schemaVersion: 2,
    races: [race],
    boats: {
      'race-1': [
        { id: 'entry-1', boat: '海风号', sailNo: 'CHN 218', skipper: '林舟' },
        { id: 'entry-2', boat: '远岚号', sailNo: 'CHN 106', skipper: '周屿' },
        { id: 'entry-3', boat: '北辰号', sailNo: 'CHN 077', skipper: '许澄' }
      ]
    },
    frozen: {},
    adjudications: { 'race-1': [] },
    versions: { 'race-1': [] },
    protests: [],
    timeline: [{ id: uid('event'), time: at, type: 'race', title: '赛事准备', message: '航线 W2 已发布，等待比赛开始' }]
  };
}

// ---------- 持久化与老数据升级 ----------
export const STORAGE_KEY_V2 = 'regatta-ledger-v2';
export const STORAGE_KEY_V1 = 'regatta-control-v1';

export function loadState(storage?: Pick<Storage, 'getItem' | 'setItem'>): RegattaStateV2 {
  try {
    const rawV2 = storage?.getItem(STORAGE_KEY_V2);
    if (rawV2) return JSON.parse(rawV2) as RegattaStateV2;
    const rawV1 = storage?.getItem(STORAGE_KEY_V1);
    if (rawV1) {
      const migrated = migrateV1(JSON.parse(rawV1) as V1State);
      storage?.setItem(STORAGE_KEY_V2, JSON.stringify(migrated));
      return migrated;
    }
  } catch (err) {
    console.error('台账数据加载失败，回退到初始数据', err);
  }
  return seedState();
}

interface RaceCtx {
  race: Race;
  boats: NonNullable<RegattaStateV2['boats'][string]>;
  frozen: NonNullable<RegattaStateV2['frozen'][string]>;
  adjudications: Adjudication[];
  versions: ResultVersion[];
}

function raceCtx(state: RegattaStateV2, raceId: string): RaceCtx | null {
  const race = state.races.find((r) => r.id === raceId);
  if (!race) return null;
  if (!state.boats[raceId]) state.boats[raceId] = [];
  if (!state.frozen[raceId]) state.frozen[raceId] = [];
  if (!state.adjudications[raceId]) state.adjudications[raceId] = [];
  if (!state.versions[raceId]) state.versions[raceId] = [];
  return {
    race,
    boats: state.boats[raceId],
    frozen: state.frozen[raceId],
    adjudications: state.adjudications[raceId],
    versions: state.versions[raceId]
  };
}

function pushTimeline(
  state: RegattaStateV2,
  event: { type: RegattaStateV2['timeline'][number]['type']; title: string; message: string; versionNo?: number; seq?: number }
) {
  state.timeline.unshift({ id: uid('event'), time: nowIso(), ...event });
}

/** 在当前草稿（未发布最新版本）上追加一个重算快照 */
function refreshDraft(ctx: RaceCtx, reason: string, createdBy: string): ResultVersion | null {
  const { race } = ctx;
  if (!race.frozenAt) return null;
  const nextNo = ctx.versions.reduce((max, v) => Math.max(max, v.versionNo), 0) + 1;
  const draft = makeVersion(nextNo, 'recalculation', reason, createdBy, race.lastSeq, ctx.boats, ctx.frozen, ctx.adjudications, nowIso());
  // 旧草稿被新草稿取代（仍保留可追溯）
  for (const v of ctx.versions) if (v.status === 'draft') v.status = 'superseded';
  ctx.versions.push(draft);
  race.draftVersionId = draft.id;
  return draft;
}

export interface FreezeResultInput {
  entryId: string;
  elapsedSeconds: number;
}

interface AppendPayload {
  input: Omit<AppendAdjudicationInput, 'basedOnSeq' | 'at'>;
}

export function createRegattaSlice(initialState: RegattaStateV2) {
  return createSlice({
    name: 'regatta',
    initialState,
    reducers: {
      startRace(state, action: PayloadAction<{ id: string }>) {
        const ctx = raceCtx(state, action.payload.id);
        if (!ctx || ctx.race.status === 'running') return;
        ctx.race.status = 'running';
        pushTimeline(state, { type: 'race', title: '比赛开始', message: `${ctx.race.name} 已起航` });
      },

      /** 比赛结束：计时员提交到达秒数，原始成绩立即冻结 */
      freezeRace(state, action: PayloadAction<{ id: string; results: FreezeResultInput[]; by: string }>) {
        const ctx = raceCtx(state, action.payload.id);
        if (!ctx || ctx.race.status === 'finished') return;
        ctx.race.status = 'finished';
        ctx.race.frozenAt = nowIso();
        ctx.frozen.length = 0;
        for (const r of action.payload.results) ctx.frozen.push({ entryId: r.entryId, elapsedSeconds: r.elapsedSeconds });

        const original = makeVersion(1, 'original', '比赛结束，原始成绩冻结', action.payload.by, 0, ctx.boats, ctx.frozen, ctx.adjudications, ctx.race.frozenAt);
        ctx.versions.length = 0;
        ctx.versions.push(original);
        ctx.race.draftVersionId = original.id;
        ctx.race.officialVersionId = undefined;
        pushTimeline(state, { type: 'freeze', title: '原始成绩已冻结', message: `${action.payload.by} 提交 ${ctx.frozen.length} 条到达成绩，原始记录封存，后续只能追加裁决`, versionNo: 1 });
      },

      /**
       * 追加裁决（抗议处罚 / 重赛 / 计时更正 / 弃权）。
       * 序号在 reducer 内分配，后到者一律续接在已登记裁决之后。
       */
      appendAdjudication(state, action: PayloadAction<AppendPayload>) {
        const { input } = action.payload;
        const ctx = raceCtx(state, input.raceId);
        if (!ctx || !ctx.race.frozenAt) return;

        const fullInput: AppendAdjudicationInput = { ...input, basedOnSeq: ctx.race.lastSeq };
        const adj = createAdjudication(fullInput, ctx.race.lastSeq);
        ctx.adjudications.push(adj);
        ctx.race.lastSeq = adj.seq;

        const roleText = adj.role === 'timer' ? '计时员' : '裁判';
        pushTimeline(state, {
          type: 'adjudication',
          title: `裁决 #${adj.seq} ${adj.title}`,
          seq: adj.seq,
          message: `${roleText} ${adj.author} 登记「${adj.title}」：${adj.detail}`
        });

        // 未发布：晚到裁决立即触发重算；已发布且没有打开的更正版：只登记，等待显式生成更正版
        const hasOpenDraft = ctx.versions.some((v) => v.status === 'draft');
        if (!ctx.race.officialVersionId || hasOpenDraft) {
          const draft = refreshDraft(ctx, `按裁决 #${adj.seq}（${adj.title}）重新计算`, adj.author);
          if (draft) {
            pushTimeline(state, {
              type: 'recalc',
              title: `重算生成 V${draft.versionNo}`,
              versionNo: draft.versionNo,
              seq: adj.seq,
              message: ctx.race.officialVersionId
                ? '正式版未改动，已在更正版草稿中重新计算'
                : '晚到裁决已并入，显示结果基于全部已登记裁决重新计算'
            });
          }
        } else {
          pushTimeline(state, {
            type: 'adjudication',
            title: `裁决 #${adj.seq} 已入账，待开更正版`,
            seq: adj.seq,
            message: '正式成绩已发布，裁决只追加到台账；需点击「生成更正版」才会改变对外显示结果'
          });
        }
      },

      /** 发布后显式生成更正版（重算快照） */
      createCorrectionVersion(state, action: PayloadAction<{ raceId: string; reason: string; by: string }>) {
        const ctx = raceCtx(state, action.payload.raceId);
        if (!ctx || !ctx.race.officialVersionId) return;
        if (ctx.versions.some((v) => v.status === 'draft')) return;
        const draft = refreshDraft(ctx, `更正版：${action.payload.reason}`, action.payload.by);
        if (draft) {
          pushTimeline(state, { type: 'recalc', title: `更正版 V${draft.versionNo} 已生成`, message: action.payload.reason, versionNo: draft.versionNo });
        }
      },

      /** 发布：仅最新版本成为正式成绩，旧版本全部转为可追溯的历史版本 */
      publishVersion(state, action: PayloadAction<{ raceId: string; by: string }>) {
        const ctx = raceCtx(state, action.payload.raceId);
        if (!ctx) return;
        const draft = [...ctx.versions].sort((a, b) => b.versionNo - a.versionNo).find((v) => v.status === 'draft');
        if (!draft) return;
        const at = nowIso();
        draft.status = 'published';
        draft.publishedAt = at;
        for (const v of ctx.versions) {
          if (v.id !== draft.id && v.status !== 'superseded') {
            v.status = 'superseded';
            v.supersededAt = at;
          }
        }
        const prevOfficial = ctx.race.officialVersionId;
        ctx.race.officialVersionId = draft.id;
        ctx.race.draftVersionId = undefined;
        pushTimeline(state, {
          type: 'publish',
          title: `V${draft.versionNo} 发布为正式成绩`,
          versionNo: draft.versionNo,
          message: prevOfficial ? `原正式版 V${ctx.versions.find((v) => v.id === prevOfficial)?.versionNo ?? ''} 转为历史版本，仍可追溯` : '首个正式版本发布'
        });
      },

      registerProtest(state, action: PayloadAction<{ raceId: string; entryId: string; reason: string; rule: string; by: string }>) {
        const p: Protest = {
          id: uid('protest'),
          raceId: action.payload.raceId,
          entryId: action.payload.entryId,
          reason: action.payload.reason,
          rule: action.payload.rule,
          status: 'submitted',
          decision: '',
          createdAt: nowIso()
        };
        state.protests.unshift(p);
        pushTimeline(state, { type: 'adjudication', title: `收到 ${p.rule} 抗议`, message: `${action.payload.by} 登记抗议：${p.reason}` });
      },

      setProtestReviewing(state, action: PayloadAction<{ id: string }>) {
        const p = state.protests.find((x) => x.id === action.payload.id);
        if (p && p.status === 'submitted') {
          p.status = 'reviewing';
          pushTimeline(state, { type: 'adjudication', title: '抗议进入复核', message: `${p.rule}：${p.reason}` });
        }
      },

      /**
       * 抗议裁决：同时写入抗议结论与追加裁决（一个 reducer 内原子完成），
       * 避免台账和裁决单不一致。
       */
      resolveProtest(
        state,
        action: PayloadAction<{
          protestId: string;
          decision: string;
          kind: Extract<AdjudicationKind, 'protestUpheldPenalty' | 'protestUpheldNoPenalty' | 'protestRejected'>;
          penaltyDeltaSeconds?: number;
          by: string;
        }>
      ) {
        const p = state.protests.find((x) => x.id === action.payload.protestId);
        if (!p || p.status === 'resolved') return;
        const ctx = raceCtx(state, p.raceId);
        p.status = 'resolved';
        p.decision = action.payload.decision;

        if (!ctx || !ctx.race.frozenAt) {
          pushTimeline(state, { type: 'adjudication', title: '抗议已裁决', message: `${p.rule}：${p.decision}（比赛尚未结束，冻结后将体现在原始版）` });
          return;
        }

        const titleMap: Record<typeof action.payload.kind, string> = {
          protestUpheldPenalty: '抗议成立，追加处罚',
          protestUpheldNoPenalty: '抗议成立，免予处罚',
          protestRejected: '抗议驳回'
        };
        const fullInput: AppendAdjudicationInput = {
          raceId: p.raceId,
          entryId: p.entryId,
          kind: action.payload.kind,
          role: 'jury',
          refId: p.id,
          title: titleMap[action.payload.kind],
          detail: `${p.rule}：${p.decision}`,
          penaltyDeltaSeconds: action.payload.kind === 'protestUpheldPenalty' ? action.payload.penaltyDeltaSeconds : undefined,
          author: action.payload.by,
          basedOnSeq: ctx.race.lastSeq
        };
        const adj = createAdjudication(fullInput, ctx.race.lastSeq);
        ctx.adjudications.push(adj);
        ctx.race.lastSeq = adj.seq;
        pushTimeline(state, { type: 'adjudication', title: `裁决 #${adj.seq} ${adj.title}`, seq: adj.seq, message: `${p.rule}：${p.decision}` });

        const hasOpenDraft = ctx.versions.some((v) => v.status === 'draft');
        if (!ctx.race.officialVersionId || hasOpenDraft) {
          const draft = refreshDraft(ctx, `按裁决 #${adj.seq} 抗议结论重新计算`, action.payload.by);
          if (draft) {
            pushTimeline(state, { type: 'recalc', title: `重算生成 V${draft.versionNo}`, versionNo: draft.versionNo, seq: adj.seq, message: '抗议裁决已并入显示结果' });
          }
        } else {
          pushTimeline(state, { type: 'adjudication', title: `裁决 #${adj.seq} 已入账，待开更正版`, seq: adj.seq, message: '正式成绩已发布，需生成更正版后才会改变显示结果' });
        }
      },

      resetAll: () => seedState()
    }
  });
}
