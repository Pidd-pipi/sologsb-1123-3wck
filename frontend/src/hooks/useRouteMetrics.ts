import { useMemo } from 'react';
import { useMissionStore } from '../stores/missionStore';
import { useWaypointStore } from '../stores/waypointStore';
import {
  calcGsd,
  estimateBatteries,
  estimateDuration,
  estimatePhotos,
  lineSpacing,
  pathLengthMeters,
  photoInterval,
  polygonAreaM2,
} from '../utils/geoCalc';
import { buildSortiePlan, type SortieBuildError } from '../utils/sorties';
import type { LngLat } from '../types/mission';
import type { Waypoint } from '../types/waypoint';
import type { SortiePlanRow } from '../types/flightline';

export interface RouteParams {
  /** 相对航高 m */
  altitude: number;
  /** 航速 m/s */
  speed: number;
  /** 航向重叠率 % */
  overlapForward: number;
  /** 旁向重叠率 % */
  overlapSide: number;
  /** 航带方向 ° */
  heading: number;
}

export const DEFAULT_ROUTE_PARAMS: RouteParams = {
  altitude: 120,
  speed: 8,
  overlapForward: 75,
  overlapSide: 70,
  heading: 90,
};

export interface RouteMetrics {
  gsd: number;
  spacing: number;
  photoInterval: number;
  estPhotos: number;
  estDuration: number;
  batteryCount: number;
  /** 测区面积 m² */
  area: number;
  /** 航带路径长度 m */
  pathLength: number;
  /** 航点数量 */
  waypointCount: number;
  /** 预计航带数 */
  lineCount: number;
  coverageForward: number;
  coverageSide: number;
  /** 按航点顺序收束的各架次（单航点超限时为空） */
  sorties: SortiePlanRow[];
  /** 单个航点自身超过 20 min 时的错误信息（此时不应保存整套计划） */
  sortieError: SortieBuildError | null;
}

/**
 * 由航高、焦距、像元尺寸算 GSD、航线间距、预计张数与耗时，
 * 并按航点顺序把累计飞行/转弯/悬停不超过 20 min 的航点收束为一个架次。
 * 被航线规划页（/missions/:id/route）与航点明细页（/missions/:id/waypoints）消费。
 */
export function useRouteMetrics(missionId: string | undefined, params: RouteParams = DEFAULT_ROUTE_PARAMS): RouteMetrics {
  const missions = useMissionStore((s) => s.items);
  const allWaypoints = useWaypointStore((s) => s.items);

  return useMemo<RouteMetrics>(() => {
    const mission = missions.find((m) => m.id === missionId);
    const missionWaypoints: Waypoint[] = allWaypoints
      .filter((w) => w.missionId === missionId)
      .sort((a, b) => a.seq - b.seq);
    const points: LngLat[] = missionWaypoints.map((w) => [w.lng, w.lat] as LngLat);

    const sensorWidth = mission?.sensorWidth ?? 13.2;
    const sensorHeight = mission?.sensorHeight ?? 8.8;
    const focalLength = mission?.focalLength ?? 8.8;
    const pixelSize = mission?.pixelSize ?? 2.4;

    const gsd = calcGsd(pixelSize, params.altitude, focalLength);
    const spacing = lineSpacing(sensorWidth, params.altitude, focalLength, params.overlapSide);
    const interval = photoInterval(sensorHeight, params.altitude, focalLength, params.overlapForward);
    const area = mission ? polygonAreaM2(mission.areaPolygon) : 0;
    const pathLength = pathLengthMeters(points);
    // 按测区面积与航线间距估算航带数
    const side = area > 0 ? Math.sqrt(area) : 0;
    const lineCount = spacing > 0 && side > 0 ? Math.max(1, Math.ceil(side / spacing)) : 0;
    const effLineLength = lineCount > 0 ? (area > 0 ? area / (lineCount * Math.max(spacing, 1)) * spacing : 0) : 0;
    const areaEstPhotos = estimatePhotos(effLineLength || side, interval, lineCount);

    const base: RouteMetrics = {
      gsd,
      spacing,
      photoInterval: interval,
      estPhotos: areaEstPhotos,
      estDuration: 0,
      batteryCount: 0,
      area,
      pathLength,
      waypointCount: points.length,
      lineCount,
      coverageForward: Math.round((sensorHeight * params.altitude) / (focalLength || 1) * 100) / 100,
      coverageSide: Math.round((sensorWidth * params.altitude) / (focalLength || 1) * 100) / 100,
      sorties: [],
      sortieError: null,
    };

    // 无航点时无架次可拆；保留基于测区面积的估算
    if (missionWaypoints.length === 0) return base;

    const built = buildSortiePlan(missionWaypoints, mission, params.overlapForward);
    if ('error' in built) {
      // 单航点自身超限：仍返回原始口径的总耗时估算，便于页面参考，但不提供可用架次计划
      const hoverSecTotal = missionWaypoints.reduce((s, w) => s + (w.action === '悬停' ? w.hoverSec : 0), 0);
      const estDuration = estimateDuration(pathLength, params.speed, points.length, hoverSecTotal);
      return {
        ...base,
        estDuration,
        batteryCount: estimateBatteries(estDuration),
        sortieError: built,
      };
    }

    return {
      ...base,
      estPhotos: built.totalPhotos,
      estDuration: built.totalDurationMin,
      batteryCount: Math.max(1, built.sorties.length),
      sorties: built.sorties,
    };
  }, [missions, allWaypoints, missionId, params]);
}
