import type { SortiePlan, PlanSnapshot } from '../types/flightline';
import type { Waypoint } from '../types/waypoint';
import { distanceMeters } from './geoCalc';
import { round } from './id';

/** 单架次累计时长上限 min（飞行 + 转弯 + 悬停） */
export const SORTIE_LIMIT_MIN = 20;

/** 每个航点的转弯附加时间 s */
export const TURN_SEC_PER_WAYPOINT = 4;

/** 参与架次切分的最小航点字段（按 seq 升序） */
export interface PlanWaypoint {
  id: string;
  seq: number;
  lng: number;
  lat: number;
  altitude: number;
  /** 航速 m/s，缺省回退到面板航速 */
  speed: number;
  action: Waypoint['action'];
  /** 悬停秒数 */
  hoverSec: number;
}

export interface BuiltPlan {
  sorties: SortiePlan[];
  /** 预计总时长 min */
  totalDurationMin: number;
  /** 总航程 m（不含架次间断开的过渡段） */
  flightDistanceM: number;
  /** 单航点自身即超 20 min 时，指明其航点序号 */
  overLimitSeq?: number;
}

/**
 * 某航点相对前一航点的耗时 s：
 * 飞抵段（距离 / 航速）+ 转弯附加 4 s + 本点悬停。
 * 首点只有转弯与悬停。
 */
export function waypointDurationSec(wp: PlanWaypoint, prev: PlanWaypoint | null, fallbackSpeed: number): number {
  const speed = wp.speed > 0 ? wp.speed : fallbackSpeed;
  const flySec = prev && speed > 0 ? distanceMeters([prev.lng, prev.lat], [wp.lng, wp.lat]) / speed : 0;
  const hoverSec = wp.action === '悬停' ? wp.hoverSec : 0;
  return flySec + TURN_SEC_PER_WAYPOINT + hoverSec;
}

/**
 * 按航点顺序贪心切分架次：逐点累计飞行、转弯与悬停时长，加入下一航点会
 * 超过 20 min 时在上一个航点收束，新架次从该航点继续（计入跨架次飞抵段）。
 * 某个航点自身（连同其飞抵段）就超过 20 min 时无法切分，返回 overLimitSeq。
 */
export function buildSortiePlan(
  waypoints: PlanWaypoint[],
  fallbackSpeed: number,
  totalPhotos = 0,
): BuiltPlan {
  const points = [...waypoints].sort((a, b) => a.seq - b.seq);
  if (points.length === 0) {
    return { sorties: [], totalDurationMin: 0, flightDistanceM: 0 };
  }

  const groups: { start: number; end: number; distanceM: number; durationSec: number }[] = [];
  let groupStart = 0;
  let groupSec = 0;
  let groupDistance = 0;
  let totalDurationSec = 0;
  let totalDistance = 0;

  for (let i = 0; i < points.length; i += 1) {
    const prev = i > 0 ? points[i - 1] : null;
    const legSec = waypointDurationSec(points[i], prev, fallbackSpeed);
    const legDistance = prev ? distanceMeters([prev.lng, prev.lat], [points[i].lng, points[i].lat]) : 0;

    // 首点允许空组开新架次；非首点加入后会超时则在 i-1 处收束
    if (i > groupStart && groupSec + legSec > SORTIE_LIMIT_MIN * 60) {
      groups.push({ start: groupStart, end: i - 1, distanceM: groupDistance, durationSec: groupSec });
      groupStart = i;
      groupSec = legSec;
      groupDistance = legDistance;
      totalDurationSec += legSec; // 跨架次飞抵段仍计入总时长（只计一次）
      totalDistance += legDistance;
      continue;
    }

    groupSec += legSec;
    groupDistance += legDistance;
    totalDurationSec += legSec;
    totalDistance += legDistance;
  }
  groups.push({ start: groupStart, end: points.length - 1, distanceM: groupDistance, durationSec: groupSec });

  // 单架次内部仍超时，说明该航点自身（含飞抵段）就超过 20 min
  const over = groups.find((g) => g.durationSec > SORTIE_LIMIT_MIN * 60);
  if (over) {
    return {
      sorties: [],
      totalDurationMin: round(totalDurationSec / 60, 1),
      flightDistanceM: round(totalDistance, 1),
      overLimitSeq: points[over.start].seq,
    };
  }

  const allocations = allocatePhotos(
    groups.map((g) => g.distanceM),
    totalPhotos,
  );

  const sorties: SortiePlan[] = groups.map((g, idx) => ({
    sortie: idx + 1,
    startSeq: points[g.start].seq,
    endSeq: points[g.end].seq,
    waypointCount: g.end - g.start + 1,
    photos: allocations[idx],
    durationMin: round(g.durationSec / 60, 1),
  }));

  return {
    sorties,
    totalDurationMin: round(totalDurationSec / 60, 1),
    flightDistanceM: round(totalDistance, 1),
  };
}

/**
 * 按各架次航程占比分配预计张数，保证总和等于 totalPhotos。
 * 航程全为 0（单航点等情形）时平均分配。
 */
function allocatePhotos(weights: number[], total: number): number[] {
  if (weights.length === 0) return [];
  if (total <= 0) return weights.map(() => 0);
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  if (totalWeight <= 0) {
    const base = Math.floor(total / weights.length);
    const result = weights.map(() => base);
    for (let i = 0; i < total - base * weights.length; i += 1) result[i] += 1;
    return result;
  }

  const shares = weights.map((w) => (total * w) / totalWeight);
  const floors = shares.map((s) => Math.floor(s));
  let remaining = total - floors.reduce((s, v) => s + v, 0);
  // 余数按小数部分从大到小补发
  const order = shares
    .map((s, idx) => ({ idx, frac: s - Math.floor(s) }))
    .sort((a, b) => b.frac - a.frac);
  let cursor = 0;
  while (remaining > 0) {
    floors[order[cursor % order.length].idx] += 1;
    remaining -= 1;
    cursor += 1;
  }
  return floors;
}

/** 航点顺序与高度指纹：顺序（id@seq 序列）或高度一变即不同 */
export function waypointsFingerprint(waypoints: Pick<Waypoint, 'id' | 'seq' | 'altitude'>[]): string {
  return [...waypoints]
    .sort((a, b) => a.seq - b.seq)
    .map((w) => `${w.id}@${w.seq}:${w.altitude}`)
    .join('|');
}

/** 构造随航线参数持久化的架次计划快照 */
export function createPlanSnapshot(
  waypoints: PlanWaypoint[],
  fallbackSpeed: number,
  totalPhotos: number,
  now = Date.now(),
): { snapshot?: PlanSnapshot; overLimitSeq?: number } {
  const built = buildSortiePlan(waypoints, fallbackSpeed, totalPhotos);
  if (built.overLimitSeq !== undefined) return { overLimitSeq: built.overLimitSeq };
  if (built.sorties.length === 0) return {};
  return {
    snapshot: {
      createdAt: now,
      fingerprint: waypointsFingerprint(waypoints),
      waypointCount: waypoints.length,
      totalPhotos: built.sorties.reduce((s, x) => s + x.photos, 0),
      totalDurationMin: built.totalDurationMin,
      sorties: built.sorties,
    },
  };
}

/** 已保存的计划是否与当前航点顺序、高度一致；不一致则视为失效 */
export function isPlanStale(
  snapshot: PlanSnapshot | undefined,
  waypoints: Pick<Waypoint, 'id' | 'seq' | 'altitude'>[],
): boolean {
  if (!snapshot) return true;
  return snapshot.fingerprint !== waypointsFingerprint(waypoints);
}
