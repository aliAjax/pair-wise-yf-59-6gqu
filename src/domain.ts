import type {
  Adjudication,
  AppendAdjudicationInput,
  Boat,
  FrozenResult,
  ResultStatus,
  ResultVersion,
  VersionRow
} from './types';

interface BoatAcc {
  elapsed: number;
  penalty: number;
  retired: boolean;
  sources: number[];
}

/**
 * 从冻结原始成绩出发，按登记序号依次折叠裁决。
 * 关键并发规则：
 *  - 处罚用增量累加，后到者永远不会覆盖先到者的处罚
 *  - 重赛 / 计时更正只替换用时，不触碰已登记处罚
 *  - 弃权（RET）优先且不可逆，不参与排名
 */
export function buildRows(
  boats: Boat[],
  frozen: FrozenResult[],
  adjudications: Adjudication[],
  upToSeq = Number.MAX_SAFE_INTEGER
): VersionRow[] {
  const acc = new Map<string, BoatAcc>();
  for (const f of frozen) {
    acc.set(f.entryId, { elapsed: f.elapsedSeconds, penalty: 0, retired: false, sources: [] });
  }

  const ordered = adjudications
    .filter((a) => a.seq <= upToSeq)
    .sort((a, b) => a.seq - b.seq);

  for (const a of ordered) {
    let cur = acc.get(a.entryId);
    if (!cur) {
      // 原始成绩缺失（理论上不会发生）也允许裁决登记，用时按 0 起步
      cur = { elapsed: 0, penalty: 0, retired: false, sources: [] };
      acc.set(a.entryId, cur);
    }
    if (cur.retired) continue; // 弃权后裁决不再改变显示结果
    switch (a.kind) {
      case 'protestUpheldPenalty':
        cur.penalty += Math.max(0, a.penaltyDeltaSeconds ?? 0);
        cur.sources.push(a.seq);
        break;
      case 'protestUpheldNoPenalty':
      case 'protestRejected':
        cur.sources.push(a.seq); // 留痕，但不改秒数
        break;
      case 'rerace':
      case 'timeCorrection':
        if (typeof a.elapsedSeconds === 'number') cur.elapsed = a.elapsedSeconds;
        cur.sources.push(a.seq);
        break;
      case 'retirement':
        cur.retired = true;
        cur.sources.push(a.seq);
        break;
    }
  }

  const rows: VersionRow[] = boats.map((b) => {
    const cur = acc.get(b.id) ?? { elapsed: 0, penalty: 0, retired: false, sources: [] };
    const status: ResultStatus = cur.retired ? 'retired' : cur.penalty > 0 ? 'penalized' : 'ok';
    return {
      entryId: b.id,
      boat: b.boat,
      sailNo: b.sailNo,
      skipper: b.skipper,
      elapsedSeconds: cur.elapsed,
      penaltySeconds: cur.penalty,
      correctedSeconds: cur.elapsed + cur.penalty,
      status,
      rank: null,
      sources: cur.sources
    };
  });

  // 排名：仅未完赛弃权船之外参与，按修正用时升序
  const ranked = rows
    .filter((r) => r.status !== 'retired')
    .sort((a, b) => a.correctedSeconds - b.correctedSeconds);
  ranked.forEach((r, i) => {
    const row = rows.find((x) => x.entryId === r.entryId)!;
    row.rank = i + 1;
  });
  return rows;
}

/** 生成一个未发布的快照版本（原始版或重算版） */
export function makeVersion(
  versionNo: number,
  kind: ResultVersion['kind'],
  reason: string,
  createdBy: string,
  basedOnSeq: number,
  boats: Boat[],
  frozen: FrozenResult[],
  adjudications: Adjudication[],
  at: string
): ResultVersion {
  return {
    id: `ver-${versionNo}`,
    versionNo,
    kind,
    status: 'draft',
    reason,
    createdAt: at,
    createdBy,
    basedOnSeq,
    rows: buildRows(boats, frozen, adjudications, basedOnSeq)
  };
}

let counter = 0;
function localId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

/**
 * 追加裁决。纯函数：传入当前台账，返回新裁决（已分配全局序号）。
 * basedOnSeq 仅用于留痕与并发说明；无论提交方基于哪个序号，
 * 一律在最新已登记裁决之后续接，因此绝不覆盖先到者的处罚或重赛。
 */
export function createAdjudication(input: AppendAdjudicationInput, lastSeq: number): Adjudication {
  return {
    seq: lastSeq + 1,
    id: localId('adj'),
    entryId: input.entryId,
    kind: input.kind,
    role: input.role,
    refId: input.refId,
    title: input.title,
    detail: input.detail,
    penaltyDeltaSeconds: input.penaltyDeltaSeconds,
    elapsedSeconds: input.elapsedSeconds,
    author: input.author,
    createdAt: input.at ?? new Date().toISOString(),
    basedOnSeq: input.basedOnSeq
  };
}
