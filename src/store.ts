import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type {
  AdjudicationKind,
  AppState,
  Protest,
  ProtestStatus,
  Race,
  RaceStatus,
  Registration,
  TimelineEvent,
  TimelineType
} from './types';
import { appendAdjudication, freezeResult, nowIso, publishHead, uid, type AppendAdjudicationInput } from './domain';
import { raceApi } from './api';

const STORAGE_KEY = 'regatta-control-v2';
const LEGACY_STORAGE_KEY = 'regatta-control-v1';

function timelineEvent(type: TimelineType, message: string, extra: Partial<TimelineEvent> = {}): TimelineEvent {
  return { id: uid('evt'), time: nowIso(), type, message, ...extra };
}

/* ---------------------------------- 种子数据 ---------------------------------- */

function buildSeed(): AppState {
  const base = new Date();
  const finishedAt = new Date(base.getTime() - 55 * 60 * 1000).toISOString();
  const runningStart = new Date(base.getTime() + 10 * 60 * 1000).toISOString();

  const raceA: Race = {
    id: 'race-1',
    name: '海湾长距离赛 第1轮',
    fleet: '统一级',
    course: 'W2 / 东北风 12节',
    startsAt: new Date(base.getTime() - 90 * 60 * 1000).toISOString(),
    status: 'finished',
    frozenAt: finishedAt,
    officialVersionId: null,
    frozen: [
      { entryId: 'entry-1', elapsedSeconds: 3168 },
      { entryId: 'entry-2', elapsedSeconds: 3194 },
      { entryId: 'entry-3', elapsedSeconds: 3210 }
    ],
    ledger: [],
    versions: []
  };
  const registrations: Registration[] = [
    { id: 'entry-1', raceId: 'race-1', boat: '海风号', sailNo: 'CHN 218', skipper: '林舟', rawElapsedSeconds: 3168 },
    { id: 'entry-2', raceId: 'race-1', boat: '远岚号', sailNo: 'CHN 106', skipper: '周屿', rawElapsedSeconds: 3194 },
    { id: 'entry-3', raceId: 'race-1', boat: '北辰号', sailNo: 'CHN 077', skipper: '许澄', rawElapsedSeconds: 3210 },
    { id: 'entry-4', raceId: 'race-2', boat: '白鸥号', sailNo: 'CHN 302', skipper: '沈澜', rawElapsedSeconds: null },
    { id: 'entry-5', raceId: 'race-2', boat: '听潮号', sailNo: 'CHN 119', skipper: '顾帆', rawElapsedSeconds: null }
  ];
  const raceB: Race = {
    id: 'race-2',
    name: '近岸绕标赛 第2轮',
    fleet: '公开级',
    course: 'O1 / 东南风 8节',
    startsAt: runningStart,
    status: 'scheduled',
    frozen: [],
    ledger: [],
    versions: []
  };

  const adj1Time = new Date(new Date(finishedAt).getTime() + 4 * 60 * 1000).toISOString();
  const adj2Time = new Date(new Date(adj1Time).getTime() + 6 * 60 * 1000).toISOString();
  const frozenA = freezeResult(raceA, registrations, finishedAt);
  const step1 = appendAdjudication(frozenA, {
    raceId: frozenA.id, entryId: 'entry-2', kind: 'penalty', penaltySeconds: 30,
    rule: 'RRS 14', note: '起航后舷侧接触，仲裁加罚 30 秒', submittedBy: 'judge', baseSeq: 0, createdAt: adj1Time
  });
  const step2 = appendAdjudication(step1.race, {
    raceId: step1.race.id, entryId: 'entry-2', kind: 'penalty', penaltySeconds: 20,
    rule: 'RRS 44.3', note: '晚到裁决：基于 1 号台账追加 20 秒，重算不覆盖既有处罚', submittedBy: 'judge', baseSeq: 1, createdAt: adj2Time
  });

  const raceAFinal = step2.race;
  const protest: Protest = {
    id: 'protest-1',
    raceId: 'race-1',
    entryId: 'entry-2',
    reason: '起航后发生舷侧接触，远岚号要求复审',
    rule: 'RRS 14',
    status: 'resolved',
    decision: '接受抗议，加罚 30 秒（1 号台账）',
    createdAt: adj1Time,
    linkedAdjudicationSeq: 1
  };

  const timeline: TimelineEvent[] = [
    { id: 'evt-seed-1', time: new Date(base.getTime() - 100 * 60 * 1000).toISOString(), raceId: 'race-1', type: 'race', message: '航线 W2 已发布' },
    { id: 'evt-seed-2', time: finishedAt, raceId: 'race-1', type: 'freeze', message: '海湾长距离赛 第1轮 结束，原始成绩已冻结（v1）', versionNo: 1 },
    { id: 'evt-seed-3', time: adj1Time, raceId: 'race-1', type: 'adjudication', message: '1 号台账：抗议处罚 远岚号 +30 秒，生成重算稿 v2', seq: 1, versionNo: 2 },
    { id: 'evt-seed-4', time: adj2Time, raceId: 'race-1', type: 'adjudication', message: '2 号台账：抗议处罚 远岚号 +20 秒，基于 1 号继续重算 v3', seq: 2, versionNo: 3 },
    { id: 'evt-seed-5', time: runningStart, raceId: 'race-2', type: 'race', message: '近岸绕标赛 第2轮 计划起航' }
  ];

  return {
    schemaVersion: 2,
    races: [raceAFinal, raceB],
    registrations,
    protests: [protest],
    timeline,
    ui: { selectedRaceId: 'race-1' }
  };
}

/* ------------------------------- v1 老数据迁移 ------------------------------- */

interface LegacyState {
  races?: Array<{
    id?: string;
    name?: string;
    fleet?: string;
    course?: string;
    startsAt?: string;
    status?: RaceStatus;
  }>;
  entries?: Array<{
    id?: string;
    boat?: string;
    sailNo?: string;
    skipper?: string;
    elapsedSeconds?: number;
    penaltySeconds?: number;
    resultStatus?: string;
    note?: string;
  }>;
  protests?: Array<{
    id?: string;
    raceId?: string;
    entryId?: string;
    reason?: string;
    rule?: string;
    status?: ProtestStatus;
    decision?: string;
    createdAt?: string;
  }>;
  timeline?: TimelineEvent[];
}

function migrateLegacy(raw: LegacyState): AppState {
  const at = nowIso();
  const legacyRace = raw.races?.[0] ?? {};
  const raceId = legacyRace.id ?? 'race-1';
  const entries = raw.entries ?? [];

  const registrations: Registration[] = entries.map((entry) => ({
    id: entry.id ?? uid('entry'),
    raceId,
    boat: entry.boat ?? '未知船',
    sailNo: entry.sailNo ?? '',
    skipper: entry.skipper ?? '',
    rawElapsedSeconds: typeof entry.elapsedSeconds === 'number' ? entry.elapsedSeconds : 0
  }));

  let race: Race = {
    id: raceId,
    name: legacyRace.name ?? '历史比赛',
    fleet: legacyRace.fleet ?? '',
    course: legacyRace.course ?? '',
    startsAt: legacyRace.startsAt ?? at,
    status: 'finished',
    frozenAt: at,
    officialVersionId: null,
    frozen: [],
    ledger: [],
    versions: []
  };
  race = freezeResult(race, registrations, at);

  const migratedProtests: Protest[] = [];
  let anyOfficial = false;

  // 旧的处罚秒数升级为冻结之后的历史裁决；正式标记升级为发布动作
  entries.forEach((entry, index) => {
    if (!entry.id) return;
    const penalty = entry.penaltySeconds ?? 0;
    if (penalty > 0) {
      const result = appendAdjudication(race, {
        raceId,
        entryId: entry.id,
        kind: 'penalty',
        penaltySeconds: penalty,
        note: `老数据升级：保留历史处罚 ${penalty} 秒（${entry.note || '无备注'}）`,
        submittedBy: 'judge',
        baseSeq: index,
        createdAt: at,
        source: 'legacy'
      });
      race = result.race;
    }
    if (entry.resultStatus === 'official') anyOfficial = true;
  });

  if (anyOfficial) {
    race = publishHead(race, at, '老数据升级：沿用原正式标记发布');
  }

  (raw.protests ?? []).forEach((protest) => {
    migratedProtests.push({
      id: protest.id ?? uid('protest'),
      raceId: protest.raceId ?? raceId,
      entryId: protest.entryId ?? registrations[0]?.id ?? '',
      reason: protest.reason ?? '',
      rule: protest.rule ?? '',
      status: protest.status ?? 'submitted',
      decision: protest.decision ?? '',
      createdAt: protest.createdAt ?? at
    });
  });

  const timeline: TimelineEvent[] = [
    {
      id: uid('evt'),
      time: at,
      raceId,
      type: 'system',
      message: `老数据升级：旧台账已迁移至 ${race.versions.length} 个成绩版本，原始记录保留`,
      versionNo: race.versions[race.versions.length - 1]?.versionNo
    },
    ...(raw.timeline ?? []).map((event) => ({ ...event, id: event.id ?? uid('evt'), raceId: event.raceId ?? raceId }))
  ];

  return {
    schemaVersion: 2,
    races: [race],
    registrations,
    protests: migratedProtests,
    timeline,
    ui: { selectedRaceId: raceId }
  };
}

function loadInitialState(): AppState {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as AppState;
      if (parsed?.schemaVersion === 2 && Array.isArray(parsed.races)) return normalizeV2(parsed);
    } catch {
      // 损坏的 v2 数据回退到迁移流程
    }
  }
  const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (legacy) {
    try {
      return migrateLegacy(JSON.parse(legacy) as LegacyState);
    } catch {
      // 损坏数据忽略，使用种子
    }
  }
  return buildSeed();
}

/** 补齐旧会话中可能缺失的 v2 字段，保证升级后仍可打开 */
function normalizeV2(state: AppState): AppState {
  return {
    ...state,
    schemaVersion: 2,
    races: state.races.map((race) => ({
      ...race,
      frozen: race.frozen ?? [],
      ledger: race.ledger ?? [],
      versions: race.versions ?? [],
      officialVersionId: race.officialVersionId ?? null
    })),
    registrations: state.registrations ?? [],
    protests: state.protests ?? [],
    timeline: state.timeline ?? [],
    ui: { ...(state.ui ?? {}), selectedRaceId: state.ui?.selectedRaceId ?? state.races[0]?.id ?? '' }
  };
}

/* ----------------------------------- Slice ----------------------------------- */

export interface AppendPayload {
  raceId: string;
  entryId: string;
  kind: AdjudicationKind;
  penaltySeconds?: number;
  elapsedSeconds?: number;
  rule?: string;
  note?: string;
  protestId?: string;
  submittedBy: AppendAdjudicationInput['submittedBy'];
  baseSeq: number;
  createdAt?: string;
}

const slice = createSlice({
  name: 'regatta',
  initialState: loadInitialState,
  reducers: {
    selectRace(state, action: PayloadAction<string>) {
      state.ui.selectedRaceId = action.payload;
    },
    setRaceStatus(state, action: PayloadAction<{ id: string; status: RaceStatus }>) {
      const race = state.races.find((item) => item.id === action.payload.id);
      if (!race) return;
      if (race.status === 'finished' && action.payload.status !== 'finished') return; // 冻结后不可逆
      if (action.payload.status === 'finished') {
        if (race.status === 'finished') return;
        const index = state.races.findIndex((item) => item.id === race.id);
        const at = nowIso();
        state.races[index] = freezeResult(race, state.registrations, at);
        state.timeline.unshift(timelineEvent('freeze', `${race.name} 结束，原始成绩冻结（v1）`, { raceId: race.id, versionNo: 1 }));
        return;
      }
      race.status = action.payload.status;
      state.timeline.unshift(timelineEvent('race', `${race.name} 状态更新为 ${race.status}`, { raceId: race.id }));
    },
    saveRawElapsed(state, action: PayloadAction<{ raceId: string; entryId: string; elapsedSeconds: number }>) {
      // 计时员只能在冻结前改原始到岸用时
      const race = state.races.find((item) => item.id === action.payload.raceId);
      if (!race || race.status === 'finished') return;
      const registration = state.registrations.find(
        (item) => item.id === action.payload.entryId && item.raceId === action.payload.raceId
      );
      if (!registration) return;
      registration.rawElapsedSeconds = action.payload.elapsedSeconds;
      state.timeline.unshift(timelineEvent(
        'result',
        `计时员登记 ${registration.boat} 原始用时 ${action.payload.elapsedSeconds} 秒（冻结前可改）`,
        { raceId: race.id }
      ));
    },
    appendAdjudicationReducer(state, action: PayloadAction<AppendPayload>) {
      const index = state.races.findIndex((item) => item.id === action.payload.raceId);
      if (index < 0) return;
      const race = state.races[index];
      if (race.status !== 'finished') return;
      const result = appendAdjudication(race, action.payload);
      state.races[index] = result.race;
      const published = Boolean(race.officialVersionId);
      state.timeline.unshift(timelineEvent(
        'adjudication',
        `${result.adjudication.seq} 号台账：${result.adjudication.kind}（${state.registrations.find((r) => r.id === action.payload.entryId)?.boat ?? ''}）`
          + `，${published ? '生成更正版' : '晚到裁决触发重新计算'} v${result.version.versionNo}`
          + (result.rebased ? `；后到提交已基于 ${result.adjudication.rebasedSeq} 号既有裁决接续` : ''),
        { raceId: race.id, seq: result.adjudication.seq, versionNo: result.version.versionNo }
      ));
    },
    publishVersion(state, action: PayloadAction<{ raceId: string; note?: string }>) {
      const index = state.races.findIndex((item) => item.id === action.payload.raceId);
      if (index < 0) return;
      const race = state.races[index];
      if (race.status !== 'finished') return;
      const head = race.versions[race.versions.length - 1];
      if (!head || race.officialVersionId === head.id) return;
      const at = nowIso();
      state.races[index] = publishHead(race, at, action.payload.note);
      state.timeline.unshift(timelineEvent(
        'publish',
        `${race.name} 发布 v${head.versionNo} 为正式成绩，旧版本保留可追溯`,
        { raceId: race.id, versionNo: head.versionNo }
      ));
    },
    addProtest(state, action: PayloadAction<{ raceId: string; entryId: string; reason: string; rule: string }>) {
      const protest: Protest = {
        id: uid('protest'),
        ...action.payload,
        status: 'submitted',
        decision: '',
        createdAt: nowIso()
      };
      state.protests.unshift(protest);
      state.timeline.unshift(timelineEvent('protest', `收到 ${action.payload.rule} 抗议，等待复核`, { raceId: action.payload.raceId }));
    },
    transitionProtest(state, action: PayloadAction<{
      id: string;
      status: ProtestStatus;
      decision?: string;
      kind?: AdjudicationKind;
      penaltySeconds?: number;
      note?: string;
      submittedBy?: 'timer' | 'judge' | 'ro';
      baseSeq?: number;
    }>) {
      const protest = state.protests.find((item) => item.id === action.payload.id);
      if (!protest) return;
      protest.status = action.payload.status;
      protest.decision = action.payload.decision ?? protest.decision;

      if (action.payload.status === 'resolved' && action.payload.kind) {
        const raceIndex = state.races.findIndex((item) => item.id === protest.raceId);
        const race = state.races[raceIndex];
        if (race && race.status === 'finished') {
          const result = appendAdjudication(race, {
            raceId: protest.raceId,
            entryId: protest.entryId,
            kind: action.payload.kind,
            penaltySeconds: action.payload.penaltySeconds,
            rule: protest.rule,
            note: action.payload.note ?? action.payload.decision ?? `抗议 ${protest.id.slice(0, 8)} 裁决`,
            protestId: protest.id,
            submittedBy: action.payload.submittedBy ?? 'judge',
            baseSeq: action.payload.baseSeq ?? race.ledger.length
          });
          state.races[raceIndex] = result.race;
          protest.linkedAdjudicationSeq = result.adjudication.seq;
          const published = Boolean(race.officialVersionId);
          state.timeline.unshift(timelineEvent(
            'adjudication',
            `抗议 ${protest.id.slice(0, 8)} 支持：${result.adjudication.seq} 号台账 ${action.payload.kind}，${published ? '更正版' : '重算稿'} v${result.version.versionNo}`,
            { raceId: race.id, seq: result.adjudication.seq, versionNo: result.version.versionNo }
          ));
        }
      }
      state.timeline.unshift(timelineEvent('protest', `抗议 ${protest.id.slice(0, 8)} 更新为 ${protest.status}`, { raceId: protest.raceId }));
    },
    resetDemo() {
      return buildSeed();
    }
  }
});

const initialState = loadInitialState();

export const {
  selectRace,
  setRaceStatus,
  saveRawElapsed,
  appendAdjudicationReducer,
  publishVersion,
  addProtest,
  transitionProtest,
  resetDemo
} = slice.actions;

export const store = configureStore({
  reducer: { regatta: slice.reducer, [raceApi.reducerPath]: raceApi.reducer },
  middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(raceApi.middleware)
});
store.subscribe(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(store.getState().regatta)));

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
export { initialState };
