import type { AdjudicationKind, Race, ResultStatus, ResultVersion, VersionStatus, RegattaStateV2, TimelineType } from './types';

export function sortedVersions(versions: ResultVersion[]): ResultVersion[] {
  return [...versions].sort((a, b) => a.versionNo - b.versionNo);
}

export function latestVersion(versions: ResultVersion[]): ResultVersion | undefined {
  return sortedVersions(versions).at(-1);
}

export function officialVersion(versions: ResultVersion[]): ResultVersion | undefined {
  return versions.find((v) => v.status === 'published');
}

export function draftVersion(versions: ResultVersion[]): ResultVersion | undefined {
  return versions.find((v) => v.status === 'draft');
}

export interface RaceBundle {
  race: Race;
  boats: RegattaStateV2['boats'][string];
  frozen: RegattaStateV2['frozen'][string];
  adjudications: RegattaStateV2['adjudications'][string];
  versions: ResultVersion[];
}

export function selectRace(state: RegattaStateV2, raceId: string): RaceBundle | null {
  const race = state.races.find((r) => r.id === raceId);
  if (!race) return null;
  return {
    race,
    boats: state.boats[raceId] ?? [],
    frozen: state.frozen[raceId] ?? [],
    adjudications: state.adjudications[raceId] ?? [],
    versions: state.versions[raceId] ?? []
  };
}

export const adjudicationKindMeta: Record<AdjudicationKind, { label: string; color: string }> = {
  protestUpheldPenalty: { label: '抗议成立·加罚', color: 'volcano' },
  protestUpheldNoPenalty: { label: '抗议成立·免罚', color: 'gold' },
  protestRejected: { label: '抗议驳回', color: 'default' },
  rerace: { label: '重赛成绩', color: 'geekblue' },
  timeCorrection: { label: '计时更正', color: 'blue' },
  retirement: { label: '弃权 RET', color: 'magenta' }
};

export const resultStatusMeta: Record<ResultStatus, { label: string; color: string }> = {
  ok: { label: '正常', color: 'green' },
  penalized: { label: '加罚', color: 'orange' },
  retired: { label: '弃权 RET', color: 'magenta' }
};

export const versionStatusMeta: Record<VersionStatus, { label: string; color: string }> = {
  draft: { label: '待发布', color: 'orange' },
  published: { label: '正式', color: 'green' },
  superseded: { label: '历史版本', color: 'default' }
};

export const timelineColor: Record<TimelineType, string> = {
  race: 'blue',
  freeze: 'cyan',
  adjudication: 'orange',
  recalc: 'geekblue',
  publish: 'green',
  system: 'gray'
};

export const timelineLabel: Record<TimelineType, string> = {
  race: '比赛',
  freeze: '冻结',
  adjudication: '裁决',
  recalc: '重算',
  publish: '发布',
  system: '系统'
};

export function fmtTime(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}

export function fmtClock(iso: string): string {
  return new Date(iso).toLocaleTimeString();
}
