/** 架次拆分计划（按航点顺序收束，单架次累计不超过 20 min） */
export interface SortiePlanRow {
  /** 架次号，从 1 开始 */
  sortie: number;
  /** 起始航点序号 */
  startSeq: number;
  /** 结束航点序号 */
  endSeq: number;
  /** 架次内航点数 */
  waypointCount: number;
  /** 预计拍照张数 */
  photos: number;
  /** 预计耗时 min */
  durationMin: number;
}

/** 随航线参数一起持久化的架次计划快照 */
export interface SortiePlanSnapshot {
  version: 1;
  /** 保存时刻航点序列的指纹：航点顺序或高度等变化后不再匹配 */
  fingerprint: string;
  /** 单架次时长上限 min */
  maxMin: number;
  /** 计划覆盖的航点总数 */
  waypointCount: number;
  /** 全航线预计张数（各架次之和） */
  totalPhotos: number;
  /** 全航线预计耗时 min（各架次之和） */
  totalDurationMin: number;
  sorties: SortiePlanRow[];
  createdAt: number;
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
  /** 已保存的架次计划快照；无航点时为空 */
  sortiePlan?: SortiePlanSnapshot;
  updatedAt: number;
}

export type FlightLineDraft = Omit<FlightLine, 'id' | 'updatedAt'>;
