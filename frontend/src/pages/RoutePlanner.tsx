import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Button, Card, Col, Row, Space, Table, Tag, Typography, type TableProps } from 'antd';
import { useMissionStore } from '../stores/missionStore';
import { useWaypointStore } from '../stores/waypointStore';
import { useRouteMetrics, DEFAULT_ROUTE_PARAMS, type RouteParams } from '../hooks/useRouteMetrics';
import AmapRouteView from '../components/common/AmapRouteView';
import OverlapCalcPanel, { sortieColumns } from '../components/common/OverlapCalcPanel';
import { loadFlightLine, saveFlightLine } from '../utils/db';
import { createPlanSnapshot, isPlanStale } from '../utils/sortiePlan';
import { newId } from '../utils/id';
import type { FlightLine } from '../types/flightline';
import type { Waypoint } from '../types/waypoint';

type LineRow = { key: string; label: string; value: string };

const lineColumns: NonNullable<TableProps<LineRow>['columns']> = [
  { title: '项', dataIndex: 'label', width: 160 },
  { title: '值', dataIndex: 'value' },
];

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
  const [savedLine, setSavedLine] = useState<FlightLine | undefined>(undefined);
  const [savedText, setSavedText] = useState('');
  const [error, setError] = useState('');
  const metrics = useRouteMetrics(id, params);

  // 已保存的计划在航点顺序或高度变化后失效
  const planStale = useMemo(
    () => isPlanStale(savedLine?.plan, missionWaypoints),
    [savedLine, missionWaypoints],
  );

  useEffect(() => {
    if (!id) return;
    void loadFlightLine(id).then((line) => {
      setSavedLine(line);
      if (!line) return;
      setParams((prev) => ({
        ...prev,
        altitude: waypoints.filter((w) => w.missionId === id).sort((a, b) => a.seq - b.seq)[0]?.altitude ?? prev.altitude,
        overlapForward: line.overlapForward,
        overlapSide: line.overlapSide,
        heading: line.heading,
      }));
      setSavedText(`上次保存：${new Date(line.updatedAt).toLocaleString('zh-CN')}`);
    });
    // 仅按任务加载一次；航点变化由 planStale 响应
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (missionWaypoints.length > 0) {
      setParams((prev) => ({ ...prev, altitude: missionWaypoints[0].altitude }));
    }
  }, [missionWaypoints.length]);

  const onSave = async () => {
    if (!mission) return;
    if (metrics.overLimitSeq !== undefined) {
      setError(`航点 #${metrics.overLimitSeq} 自身累计飞行、转弯与悬停超过 20 min，请先调整该航点后再保存`);
      return;
    }
    // 保存参数时把按航点顺序切分的架次计划一起保存
    const { snapshot, overLimitSeq } = createPlanSnapshot(
      missionWaypoints,
      params.speed,
      metrics.estPhotos,
      Date.now(),
    );
    if (overLimitSeq !== undefined) {
      setError(`航点 #${overLimitSeq} 自身累计飞行、转弯与悬停超过 20 min，请先调整该航点后再保存`);
      return;
    }
    const updatedAt = Date.now();
    const line: FlightLine = {
      id: savedLine?.id ?? newId('line'),
      missionId: mission.id,
      lineNo: 1,
      spacing: metrics.spacing,
      photoInterval: metrics.photoInterval,
      overlapForward: params.overlapForward,
      overlapSide: params.overlapSide,
      gsd: metrics.gsd,
      estPhotos: metrics.estPhotos,
      estDuration: metrics.estDuration,
      batteryCount: metrics.batteryCount,
      heading: params.heading,
      updatedAt,
      plan: snapshot,
    };
    await saveFlightLine(line);
    setSavedLine(line);
    setError('');
    setSavedText(`已保存 ${new Date(updatedAt).toLocaleString('zh-CN')}`);
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
    { key: 'battery', label: '预计架次（电池组数）', value: `${metrics.batteryCount} 架次` },
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
      {metrics.overLimitSeq !== undefined ? (
        <Alert
          type="error"
          showIcon
          message={`航点 #${metrics.overLimitSeq} 自身累计飞行、转弯与悬停超过 20 min，无法纳入任何架次；请缩短其航程/悬停后再保存整套计划`}
        />
      ) : null}

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
          <Card size="small" title="架次计划（按航点顺序，每架次不超过 20 min，超时前一个航点收束）" style={{ marginTop: 14 }}>
            {savedLine?.plan ? (
              planStale ? (
                <Alert
                  type="warning"
                  showIcon
                  style={{ marginBottom: 10 }}
                  message="已保存的架次计划已失效：航点顺序或高度发生了变化，下方为按当前航线实时重算的结果，请重新保存。"
                />
              ) : (
                <Alert
                  type="success"
                  showIcon
                  style={{ marginBottom: 10 }}
                  message={`已保存的架次计划有效（${savedLine.plan.sorties.length} 个架次，共 ${savedLine.plan.totalPhotos} 张 / ${savedLine.plan.totalDurationMin} min），保存于 ${new Date(savedLine.plan.createdAt).toLocaleString('zh-CN')}`}
                />
              )
            ) : (
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 10 }}
                message="尚未保存架次计划：保存航线参数时会把下方拆分结果一起保存。"
              />
            )}
            {metrics.overLimitSeq === undefined && missionWaypoints.length > 0 ? (
              <Table
                rowKey="sortie"
                size="small"
                columns={sortieColumns}
                dataSource={metrics.sorties}
                pagination={false}
              />
            ) : metrics.overLimitSeq === undefined ? (
              <Typography.Text type="secondary">暂无航点，无法切分架次。</Typography.Text>
            ) : null}
            {savedLine?.plan && planStale ? (
              <>
                <Typography.Text strong style={{ display: 'block', margin: '10px 0 6px' }}>
                  失效前保存的计划（仅供对照）
                </Typography.Text>
                <Table
                  rowKey="sortie"
                  size="small"
                  columns={sortieColumns}
                  dataSource={savedLine.plan.sorties}
                  pagination={false}
                />
              </>
            ) : null}
          </Card>
        </Col>
        <Col span={9}>
          <OverlapCalcPanel
            params={params}
            onChange={(patch) => setParams((prev) => ({ ...prev, ...patch }))}
            metrics={metrics}
            onSave={onSave}
            savedText={savedText}
            saveDisabled={metrics.overLimitSeq !== undefined}
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
              <Tag
                key={w.id}
                color={
                  metrics.overLimitSeq === w.seq ? 'red' : w.action === '悬停' ? 'gold' : 'blue'
                }
              >
                #{w.seq} {w.lng.toFixed(5)}, {w.lat.toFixed(5)} · {w.altitude} m · {w.action}
              </Tag>
            ))}
          </Space>
        )}
      </Card>
    </Space>
  );
}
