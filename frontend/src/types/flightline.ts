/** 单个架次（一次起降覆盖的连续航点区间） */
export interface SortiePlan {
  /** 架次序号，从 1 开始 */
  sortie: number;
  /** 起始航点序号 */
  startSeq: number;
  /** 结束航点序号 */
  endSeq: number;
  /** 航点数 */
  waypointCount: number;
  /** 预计张数 */
  photos: number;
  /** 预计时长 min（含飞行、转弯与悬停） */
  durationMin: number;
}

/** 随航线参数一起保存的架次计划快照 */
export interface PlanSnapshot {
  /** 保存时间 ms */
  createdAt: number;
  /** 航点顺序与高度指纹；航点换序或高度变化后即失效 */
  fingerprint: string;
  /** 保存时航点总数 */
  waypointCount: number;
  /** 保存时预计总张数 */
  totalPhotos: number;
  /** 保存时预计总时长 min */
  totalDurationMin: number;
  sorties: SortiePlan[];
}

/** 航线参数 */
export interface FlightLine {
  id: string;
  missionId: string;
  /** 航线号 */
  lineNo: number;
  /** 航线间距 m */
  spacing: number;
  /** 拍照间隔 m */
  photoInterval: number;
  /** 航向重叠率 % */
  overlapForward: number;
  /** 旁向重叠率 % */
  overlapSide: number;
  /** 地面分辨率 cm/px */
  gsd: number;
  /** 预计张数 */
  estPhotos: number;
  /** 预计耗时 min */
  estDuration: number;
  /** 预计电池组数 */
  batteryCount: number;
  /** 航带方向 ° */
  heading: number;
  updatedAt: number;
  /** 按航点顺序切分的架次计划 */
  plan?: PlanSnapshot;
}

export type FlightLineDraft = Omit<FlightLine, 'id' | 'updatedAt'>;
