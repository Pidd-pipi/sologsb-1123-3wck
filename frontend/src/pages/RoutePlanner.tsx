import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Button, Card, Col, Row, Space, Table, Tag, Typography, type TableProps } from 'antd';
import { useMissionStore } from '../stores/missionStore';
import { useWaypointStore } from '../stores/waypointStore';
import { useRouteMetrics, DEFAULT_ROUTE_PARAMS, type RouteParams } from '../hooks/useRouteMetrics';
import AmapRouteView from '../components/common/AmapRouteView';
import OverlapCalcPanel from '../components/common/OverlapCalcPanel';
import { loadFlightLine, saveFlightLine } from '../utils/db';
import { buildSortiePlan, isPlanCurrent, toPlanSnapshot } from '../utils/sorties';
import { newId } from '../utils/id';
import type { FlightLine, SortiePlanRow, SortiePlanSnapshot } from '../types/flightline';
import type { Waypoint } from '../types/waypoint';

type LineRow = { key: string; label: string; value: string };

const lineColumns: NonNullable<TableProps<LineRow>['columns']> = [
  { title: '项', dataIndex: 'label', width: 160 },
  { title: '值', dataIndex: 'value' },
];

const sortieColumns: NonNullable<TableProps<SortiePlanRow>['columns']> = [
  { title: '架次', dataIndex: 'sortie', width: 80, render: (v: number) => `第 ${v} 架次` },
  {
    title: '起止序号',
    width: 100,
    render: (_: unknown, row: SortiePlanRow) =>
      row.startSeq === row.endSeq ? `#${row.startSeq}` : `#${row.startSeq}–${row.endSeq}`,
  },
  { title: '航点数', dataIndex: 'waypointCount', width: 80 },
  { title: '预计张数', dataIndex: 'photos', width: 90 },
  { title: '预计时长 min', dataIndex: 'durationMin', width: 110 },
];

function SortieTable({ rows }: { rows: SortiePlanRow[] }) {
  return (
    <Table<SortiePlanRow>
      rowKey="sortie"
      size="small"
      columns={sortieColumns}
      dataSource={rows}
      pagination={false}
      locale={{ emptyText: '暂无航点，无法拆分架次' }}
    />
  );
}

/** /missions/:id/route 航线规划主视图：地图 + 参数面板实时回算 */
export default function RoutePlanner() {
  const { id = '' } = useParams();
  const missions = useMissionStore((s) => s.items);
  const waypoints = useWaypointStore((s) => s.items);
  const addWaypoint = useWaypointStore((s) => s.add);
  const mission = missions.find((m) => m.id === id);
  const missionWaypoints = useMemo(
    () => waypoints.filter((w) => w.missionId === id).sort((a, b) => a.seq - b.seq),
    [waypoints, id],
  );

  const [params, setParams] = useState<RouteParams>({ ...DEFAULT_ROUTE_PARAMS });
  const [savedLine, setSavedLine] = useState<FlightLine | null>(null);
  const [savedText, setSavedText] = useState('');
  const [error, setError] = useState('');
  const metrics = useRouteMetrics(id, params);

  useEffect(() => {
    if (!id) return;
    void loadFlightLine(id).then((line) => {
      setSavedLine(line ?? null);
      if (!line) return;
      setParams((prev) => ({
        ...prev,
        altitude: missionWaypoints[0]?.altitude ?? prev.altitude,
        overlapForward: line.overlapForward,
        overlapSide: line.overlapSide,
        heading: line.heading,
      }));
      setSavedText(`上次保存：${new Date(line.updatedAt).toLocaleString('zh-CN')}`);
    });
  }, [id, missionWaypoints.length]);

  useEffect(() => {
    if (missionWaypoints.length > 0) {
      setParams((prev) => ({ ...prev, altitude: missionWaypoints[0].altitude }));
    }
  }, [missionWaypoints.length]);

  const savedPlan: SortiePlanSnapshot | undefined = savedLine?.sortiePlan;
  const savedPlanCurrent = isPlanCurrent(savedPlan, missionWaypoints);

  const onSave = async () => {
    if (!mission) return;
    // 先按当前航点顺序构建计划：单个航点自身超限时不保存整套计划，并指明该航点
    const built = buildSortiePlan(missionWaypoints, mission, params.overlapForward);
    if ('error' in built) {
      setError(built.message);
      return;
    }
    const plan = toPlanSnapshot(built, missionWaypoints);
    const updatedAt = Date.now();
    const line: FlightLine = {
      id: savedLine?.id ?? newId('line'),
      missionId: mission.id,
      lineNo: savedLine?.lineNo ?? 1,
      spacing: metrics.spacing,
      photoInterval: metrics.photoInterval,
      overlapForward: params.overlapForward,
      overlapSide: params.overlapSide,
      gsd: metrics.gsd,
      estPhotos: built.totalPhotos,
      estDuration: built.totalDurationMin,
      batteryCount: Math.max(1, built.sorties.length),
      heading: params.heading,
      sortiePlan: missionWaypoints.length > 0 ? plan : undefined,
      updatedAt,
    };
    await saveFlightLine(line);
    setSavedLine(line);
    setSavedText(`已保存 ${new Date(updatedAt).toLocaleString('zh-CN')}`);
    setError('');
  };

  const pickPoint = async (lng: number, lat: number) => {
    if (!mission) return;
    if (missionWaypoints.length >= 60) {
      setError('单任务航点上限为 60 个，请拆分架次');
      return;
    }
    const seq = missionWaypoints.length === 0 ? 1 : Math.max(...missionWaypoints.map((w) => w.seq)) + 1;
    await addWaypoint({
      missionId: mission.id,
      seq,
      lng: Number(lng.toFixed(6)),
      lat: Number(lat.toFixed(6)),
      altitude: params.altitude,
      speed: params.speed,
      heading: params.heading,
      gimbalPitch: -90,
      action: '拍照',
      hoverSec: 0,
    });
    setError('');
  };

  const lineRows: LineRow[] = [
    { key: 'gsd', label: '地面分辨率 GSD', value: `${metrics.gsd} cm/px` },
    { key: 'spacing', label: '航线间距', value: `${metrics.spacing} m` },
    { key: 'interval', label: '拍照间隔', value: `${metrics.photoInterval} m` },
    { key: 'photos', label: '预计张数', value: `${metrics.estPhotos} 张` },
    { key: 'duration', label: '预计耗时', value: `${metrics.estDuration} min` },
    { key: 'battery', label: '预计电池组数', value: `${metrics.batteryCount} 组` },
    { key: 'area', label: '测区面积', value: `${metrics.area.toFixed(0)} m²` },
    { key: 'length', label: '航带路径长度', value: `${metrics.pathLength.toFixed(1)} m` },
    { key: 'lines', label: '预计航带数', value: `${metrics.lineCount} 条` },
  ];

  if (!mission) {
    return (
      <Space direction="vertical">
        <Alert type="warning" showIcon message="未找到该任务（可能已被删除）" />
        <Link to="/missions">返回任务台账</Link>
      </Space>
    );
  }

  return (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      <Space wrap align="center">
        <Typography.Title level={4} style={{ margin: 0 }}>
          航线规划 · {mission.missionNo}
        </Typography.Title>
        <Tag color="cyan">{mission.purpose}</Tag>
        <Tag>{mission.areaName}</Tag>
        <Tag color={missionWaypoints.length > 0 ? 'green' : 'default'}>航点 {missionWaypoints.length} 个</Tag>
        <div style={{ flex: 1 }} />
        <Button type="link">
          <Link to={`/missions/${mission.id}/waypoints`}>航点明细</Link>
        </Button>
        <Button type="link">
          <Link to={`/missions/${mission.id}/assets`}>成果编目</Link>
        </Button>
        <Button type="link">
          <Link to="/settings/camera">相机预设</Link>
        </Button>
        <Button type="link">
          <Link to="/missions">返回台账</Link>
        </Button>
      </Space>

      {error ? <Alert type="error" showIcon message={error} closable onClose={() => setError('')} /> : null}

      <Row gutter={14}>
        <Col span={15}>
          <Card size="small" title="测区与航线">
            <AmapRouteView
              mission={mission}
              waypoints={missionWaypoints}
              altitude={params.altitude}
              height={440}
              onPickPoint={pickPoint}
            />
          </Card>
          <Card size="small" title="航线参数明细" style={{ marginTop: 14 }}>
            <Table<LineRow>
              rowKey="key"
              size="small"
              columns={lineColumns}
              dataSource={lineRows}
              pagination={false}
            />
          </Card>
          <Card
            size="small"
            title="多架次拆分（按航点顺序收束，单架次累计飞行/转弯/悬停 ≤ 20 min）"
            style={{ marginTop: 14 }}
            extra={
              metrics.sortieError ? (
                <Tag color="red">计划不可保存</Tag>
              ) : (
                <Tag color="blue">{metrics.sorties.length} 个架次</Tag>
              )
            }
          >
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
              {metrics.sortieError ? (
                <Alert
                  type="error"
                  showIcon
                  message={`${metrics.sortieError.message}；已阻止保存，请调整后再保存航线参数。`}
                />
              ) : (
                <>
                  <Typography.Text strong>当前计划（实时）</Typography.Text>
                  <SortieTable rows={metrics.sorties} />
                </>
              )}

              {savedPlan ? (
                <>
                  <Space wrap size={6} style={{ marginTop: 2 }}>
                    <Typography.Text strong>已保存计划</Typography.Text>
                    <Tag color={savedPlanCurrent ? 'green' : 'default'}>
                      {savedPlanCurrent ? '与当前航点一致' : '已失效'}
                    </Tag>
                    <Typography.Text type="secondary">
                      保存于 {new Date(savedPlan.createdAt).toLocaleString('zh-CN')}
                    </Typography.Text>
                  </Space>
                  {savedPlanCurrent ? null : (
                    <Alert
                      type="warning"
                      showIcon
                      message="航点顺序或高度等已变化，旧架次计划已失效；保存航线参数后将按当前航点重新拆分。"
                    />
                  )}
                  <SortieTable rows={savedPlan.sorties} />
                </>
              ) : (
                <Typography.Text type="secondary">尚未保存架次计划（保存航线参数时会一并保存）。</Typography.Text>
              )}
            </Space>
          </Card>
        </Col>
        <Col span={9}>
          <OverlapCalcPanel
            params={params}
            onChange={(patch) => setParams((prev) => ({ ...prev, ...patch }))}
            metrics={metrics}
            onSave={onSave}
            savedText={savedText}
          />
        </Col>
      </Row>

      <Card size="small" title="点击网格新增的航点">
        {missionWaypoints.length === 0 ? (
          <Typography.Text type="secondary">
            暂无航点：在地图/网格上单击即可按当前航高新增航点，或到「航点明细」页批量粘贴导入。
          </Typography.Text>
        ) : (
          <Space wrap size={6}>
            {missionWaypoints.map((w: Waypoint) => (
              <Tag key={w.id} color={w.action === '悬停' ? 'gold' : 'blue'}>
                #{w.seq} {w.lng.toFixed(5)}, {w.lat.toFixed(5)} · {w.altitude} m · {w.action}
              </Tag>
            ))}
          </Space>
        )}
      </Card>
    </Space>
  );
}
