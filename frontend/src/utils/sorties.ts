import { distanceMeters, photoInterval } from './geoCalc';
import { round } from './id';
import type { Mission } from '../types/mission';
import type { Waypoint } from '../types/waypoint';
import type { SortiePlanRow, SortiePlanSnapshot } from '../types/flightline';

/** 单架次累计时长上限 min */
export const SORTIE_MAX_MIN = 20;
/** 单架次累计时长上限 s */
export const SORTIE_MAX_SEC = SORTIE_MAX_MIN * 60;
/** 每个航点的转弯附加 s（与 geoCalc.estimateDuration 口径一致） */
export const TURN_SEC_PER_WAYPOINT = 4;

export interface SortieBuildResult {
  plan: SortiePlanSnapshot;
  sorties: SortiePlanRow[];
  /** 全航线预计张数（各架次之和） */
  totalPhotos: number;
  /** 全航线预计耗时 min（各架次之和） */
  totalDurationMin: number;
}

export interface SortieBuildError {
  error: true;
  /** 自身就超过单架次时长上限的航点序号 */
  waypointSeq: number;
  /** 该航点自身耗时 min */
  durationMin: number;
  message: string;
}

/** 一个航点自身计入架次的耗时 s：飞入航程 + 转弯 + 悬停 */
export function waypointOwnSec(wp: Waypoint, prev: Waypoint | null): number {
  const flySec = prev ? distanceMeters([prev.lng, prev.lat], [wp.lng, wp.lat]) / (wp.speed > 0 ? wp.speed : 1) : 0;
  const hoverSec = wp.action === '悬停' ? wp.hoverSec : 0;
  return flySec + TURN_SEC_PER_WAYPOINT + hoverSec;
}

/** 飞入该航点的航段预计拍照张数：按该航点航高对应的拍照间隔铺算，段末点不重复计 */
export function legPhotos(wp: Waypoint, prev: Waypoint | null, sensorHeightMm: number, focalLengthMm: number, overlapForwardPct: number): number {
  if (!prev) return 0;
  const interval = photoInterval(sensorHeightMm, wp.altitude, focalLengthMm, overlapForwardPct);
  if (interval <= 0) return 0;
  const segMeters = distanceMeters([prev.lng, prev.lat], [wp.lng, wp.lat]);
  return Math.floor(segMeters / interval);
}

/**
 * 按航点顺序把航线收束为多个架次：
 * 一个架次累计飞行、转弯与悬停时长不超过 20 min；加入下一航点会超时，
 * 则在当前航点收束，下一航点起开新架次。某航点自身即超 20 min 时返回 error
 * （调用方不得保存整套计划）。
 *
 * 张数口径：飞入航段按当前航点航高对应的拍照间隔估算，动作为「拍照」的航点本身再加一张。
 */
export function buildSortiePlan(
  waypoints: Waypoint[],
  mission: Mission | undefined,
  overlapForwardPct = 75,
): SortieBuildResult | SortieBuildError {
  const createdAt = Date.now();
  if (waypoints.length === 0) {
    return {
      plan: {
        version: 1,
        fingerprint: '',
        maxMin: SORTIE_MAX_MIN,
        waypointCount: 0,
        totalPhotos: 0,
        totalDurationMin: 0,
        sorties: [],
        createdAt,
      },
      sorties: [],
      totalPhotos: 0,
      totalDurationMin: 0,
    };
  }

  const sorted = [...waypoints].sort((a, b) => a.seq - b.seq);
  const sensorHeight = mission?.sensorHeight ?? 8.8;
  const focalLength = mission?.focalLength ?? 8.8;

  type Acc = { startSeq: number; startIndex: number; sec: number; photos: number };
  const rows: SortiePlanRow[] = [];
  let current: Acc | null = null;
  let prev: Waypoint | null = null;
  let totalPhotos = 0;
  let totalSec = 0;

  const finish = (endIndex: number, acc: Acc) => {
    const end = sorted[endIndex];
    rows.push({
      sortie: rows.length + 1,
      startSeq: acc.startSeq,
      endSeq: end.seq,
      waypointCount: endIndex - acc.startIndex + 1,
      photos: acc.photos,
      durationMin: round(acc.sec / 60, 1),
    });
    totalPhotos += acc.photos;
    totalSec += acc.sec;
  };

  for (let i = 0; i < sorted.length; i += 1) {
    const wp = sorted[i];
    const ownSec = waypointOwnSec(wp, prev);
    if (ownSec > SORTIE_MAX_SEC) {
      return {
        error: true,
        waypointSeq: wp.seq,
        durationMin: round(ownSec / 60, 1),
        message: `航点 #${wp.seq} 自身预计耗时 ${round(ownSec / 60, 1)} min，已超过单架次 ${SORTIE_MAX_MIN} min 上限，请缩短该航点悬停时间或调整航程/航速`,
      };
    }

    if (current === null) {
      current = { startSeq: wp.seq, startIndex: i, sec: 0, photos: 0 };
    } else if (current.sec + ownSec > SORTIE_MAX_SEC) {
      // 加入该航点会超时：上一航点收束，从本航点开始下一架次
      finish(i - 1, current);
      current = { startSeq: wp.seq, startIndex: i, sec: 0, photos: 0 };
    }

    current.sec += ownSec;
    if (wp.action === '拍照') current.photos += 1;
    current.photos += legPhotos(wp, prev, sensorHeight, focalLength, overlapForwardPct);
    prev = wp;
  }
  finish(sorted.length - 1, current as Acc);

  const totalDurationMin = round(totalSec / 60, 1);
  const plan: SortiePlanSnapshot = {
    version: 1,
    fingerprint: '',
    maxMin: SORTIE_MAX_MIN,
    waypointCount: sorted.length,
    totalPhotos,
    totalDurationMin,
    sorties: rows,
    createdAt,
  };
  return { plan, sorties: rows, totalPhotos, totalDurationMin };
}

/**
 * 航点序列指纹：顺序、坐标、航高、航速、动作与悬停任一变化都会改变，
 * 用于判断已保存的架次计划是否失效。
 */
export function waypointFingerprint(waypoints: Waypoint[]): string {
  const sorted = [...waypoints].sort((a, b) => a.seq - b.seq);
  const raw = sorted
    .map((w) => `${w.seq}:${w.lng.toFixed(6)},${w.lat.toFixed(6)},${w.altitude},${w.speed},${w.action},${w.hoverSec}`)
    .join('|');
  // djb2 哈希，避免指纹过长
  let hash = 5381;
  for (let i = 0; i < raw.length; i += 1) {
    hash = ((hash << 5) + hash + raw.charCodeAt(i)) >>> 0;
  }
  return `wp-v1:${sorted.length}:${hash.toString(36)}`;
}

/** 把拆分结果补全指纹，生成可持久化的计划快照 */
export function toPlanSnapshot(result: SortieBuildResult, waypoints: Waypoint[], createdAt = Date.now()): SortiePlanSnapshot {
  return { ...result.plan, fingerprint: waypointFingerprint(waypoints), createdAt };
}

/** 已保存计划是否仍与当前航点序列一致 */
export function isPlanCurrent(plan: SortiePlanSnapshot | undefined, waypoints: Waypoint[]): boolean {
  if (!plan || plan.waypointCount !== waypoints.length) return false;
  return plan.fingerprint === waypointFingerprint(waypoints);
}
