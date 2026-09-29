import { useEffect, useMemo, useState } from 'react';
import {
  App as AntApp, Alert, Badge, Button, Card, Col, Collapse, Descriptions, Empty, Form, Input,
  InputNumber, Layout, List, Menu, Row, Select, Space, Statistic, Table, Tag, Timeline, Typography, message
} from 'antd';
import { ClockCircleOutlined, FileProtectOutlined, FlagOutlined, PlusOutlined, SafetyCertificateOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import {
  addProtest, appendAdjudicationReducer, publishVersion, resetDemo, saveRawElapsed, selectRace,
  setRaceStatus, transitionProtest, type AppDispatch, type RootState
} from './store';
import { useGetOfficialsQuery } from './api';
import { headVersion, isFrozen, isPublished, kindLabel, officialVersion, registrationsOf, roleLabel } from './domain';
import type { AdjudicationKind, Race, RaceStatus, Registration, ResultVersion, SubmitterRole, VersionRow } from './types';

const { Header, Content, Sider } = Layout;

const protestSchema = z.object({
  entryId: z.string().min(1),
  reason: z.string().min(4),
  rule: z.string().min(2)
});

const adjFormSchema = z.object({
  entryId: z.string().min(1),
  kind: z.enum(['penalty', 'exoneration', 'resail', 'retire', 'reinstate']),
  penaltySeconds: z.number(),
  elapsedSeconds: z.number(),
  rule: z.string(),
  note: z.string(),
  submittedBy: z.enum(['timer', 'judge', 'ro'])
});
type AdjFormValues = z.infer<typeof adjFormSchema>;

function countdown(target: string, now: number) {
  const seconds = Math.max(0, Math.floor((new Date(target).getTime() - now) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

function versionTag(version: ResultVersion) {
  const map = {
    draft: { color: 'gold', text: '未发布重算稿' },
    correction: { color: 'orange', text: '更正版（待发布）' },
    official: { color: 'green', text: '正式成绩' },
    superseded: { color: 'default', text: '已被取代（可追溯）' }
  } as const;
  const meta = map[version.status];
  return <Tag color={meta.color}>v{version.versionNo} · {meta.text}</Tag>;
}

function LeaderboardTable({ version, registrations }: { version: ResultVersion; registrations: Registration[] }) {
  const boatOf = (id: string) => registrations.find((item) => item.id === id);
  return (
    <Table<VersionRow>
      rowKey="entryId"
      pagination={false}
      size="small"
      dataSource={version.rows}
      columns={[
        { title: '排名', dataIndex: 'rank', width: 64, render: (rank: number | null) => rank ?? <Tag>RET</Tag> },
        { title: '船名', render: (_v, row) => boatOf(row.entryId)?.boat ?? row.entryId },
        { title: '帆号', render: (_v, row) => boatOf(row.entryId)?.sailNo ?? '-' },
        { title: '原始冻结用时', dataIndex: 'frozenElapsed', render: (v: number) => `${v}s` },
        {
          title: '重赛用时', dataIndex: 'resailElapsed',
          render: (v: number | null) => v == null ? <Tag color="default">原始</Tag> : <Tag color="geekblue">{v}s</Tag>
        },
        {
          title: '累计处罚', dataIndex: 'penaltyTotal',
          render: (v: number) => v > 0 ? <Tag color="volcano">+{v}s</Tag> : '—'
        },
        {
          title: '显示成绩',
          render: (_v, row) => row.retired
            ? <Tag color="magenta">弃权 RET</Tag>
            : <b>{row.displayedSeconds}s</b>
        }
      ]}
    />
  );
}

function RaceTimeline({ raceId }: { raceId: string }) {
  const timeline = useSelector((state: RootState) => state.regatta.timeline);
  const events = useMemo(
    () => timeline.filter((event) => !event.raceId || event.raceId === raceId),
    [timeline, raceId]
  );
  const colorOf = {
    race: 'blue', freeze: 'cyan', adjudication: 'orange', publish: 'green',
    protest: 'gold', system: 'purple', result: 'blue'
  } as const;
  const labelOf = {
    race: '比赛', freeze: '冻结', adjudication: '裁决', publish: '发布',
    protest: '抗议', system: '系统', result: '计时'
  } as const;
  if (events.length === 0) return <Empty description="暂无时间线" />;
  return (
    <Timeline
      items={events.map((event) => ({
        color: colorOf[event.type],
        children: (
          <div>
            <Space size={6} wrap>
              <Tag color={colorOf[event.type]}>{labelOf[event.type]}</Tag>
              {event.seq != null && <Tag color="orange">台账 #{event.seq}</Tag>}
              {event.versionNo != null && <Tag color="green">v{event.versionNo}</Tag>}
            </Space>
            <div>{event.message}</div>
            <small style={{ color: '#888' }}>{fmtTime(event.time)}</small>
          </div>
        )
      }))}
    />
  );
}

/* --------------------------------- 竞赛控制页 --------------------------------- */

function ControlPage({ race }: { race: Race }) {
  const dispatch = useDispatch<AppDispatch>();
  const registrations = useSelector((state: RootState) =>
    state.regatta.registrations.filter((item) => item.raceId === race.id)
  );
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const head = headVersion(race);
  const official = officialVersion(race);
  const displayVersion = official ?? head;
  const draftAhead = official && head && head.id !== official.id;
  const missingRaw = registrations.filter((item) => item.rawElapsedSeconds == null);

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Row gutter={[18, 18]}>
        <Col xs={24} lg={9}>
          <Card className="hero-card">
            <Badge
              status={race.status === 'running' ? 'processing' : race.status === 'finished' ? 'success' : 'default'}
              text={`比赛状态：${race.status === 'scheduled' ? '待起航' : race.status === 'running' ? '进行中' : '已结束（成绩冻结）'}`}
            />
            <Statistic title="距离起航" value={countdown(race.startsAt, now)} prefix={<ClockCircleOutlined />} />
            <Descriptions column={1} style={{ marginTop: 18 }}>
              <Descriptions.Item label="组别">{race.fleet}</Descriptions.Item>
              <Descriptions.Item label="航线">{race.course}</Descriptions.Item>
              {race.frozenAt && <Descriptions.Item label="冻结时刻">{fmtTime(race.frozenAt)}</Descriptions.Item>}
            </Descriptions>
            <Space wrap>
              <Button
                type="primary" icon={<FlagOutlined />}
                disabled={race.status !== 'scheduled'}
                onClick={() => dispatch(setRaceStatus({ id: race.id, status: 'running' }))}
              >
                开始比赛
              </Button>
              <Button
                disabled={race.status === 'finished' || missingRaw.length > 0}
                onClick={() => dispatch(setRaceStatus({ id: race.id, status: 'finished' }))}
              >
                结束比赛并冻结原始成绩
              </Button>
            </Space>
            {race.status !== 'finished' && missingRaw.length > 0 && (
              <Alert style={{ marginTop: 12 }} type="warning" showIcon message={`还有 ${missingRaw.length} 艘船未登记原始到岸用时，结束前必须补齐`} />
            )}
            {race.status === 'finished' && (
              <Alert style={{ marginTop: 12 }} type="info" showIcon message="原始成绩已冻结：抗议、重赛、弃权一律通过「裁决台账」追加，原始记录不再修改。" />
            )}
          </Card>
        </Col>
        <Col xs={24} lg={15}>
          <Card
            title="正式排行榜"
            extra={displayVersion ? versionTag(displayVersion) : <Tag>{registrations.length} 艘参赛船</Tag>}
          >
            {displayVersion ? (
              <>
                {official && <Alert style={{ marginBottom: 12 }} type="success" showIcon message={`正式成绩为 v${official.versionNo}（${fmtTime(official.publishedAt ?? official.createdAt)} 发布）`} />}
                {draftAhead && <Alert style={{ marginBottom: 12 }} type="warning" showIcon message={`发布后有新裁决，最新 v${head!.versionNo} 为更正版，需重新发布才会成为正式成绩。`} />}
                <LeaderboardTable version={displayVersion} registrations={registrations} />
              </>
            ) : (
              <Empty description="比赛结束冻结后生成排行榜" />
            )}
          </Card>
        </Col>
      </Row>

      <Card title={isFrozen(race) ? '原始成绩（已冻结，仅供核对）' : '船队与计时登记（冻结前可修改）'} extra={<Tag color="blue">{registrations.length} 艘参赛船</Tag>}>
        <Table<Registration>
          rowKey="id"
          pagination={false}
          dataSource={registrations}
          columns={[
            { title: '船名', dataIndex: 'boat' },
            { title: '帆号', dataIndex: 'sailNo' },
            { title: '船长', dataIndex: 'skipper' },
            {
              title: '原始到岸用时（秒）',
              render: (_v, record) => isFrozen(race)
                ? <b>{record.rawElapsedSeconds ?? 0}s</b>
                : <RawElapsedEditor raceId={race.id} registration={record} />
            },
            isFrozen(race)
              ? { title: '状态', render: () => <Tag color="cyan">已冻结</Tag> }
              : { title: '状态', render: () => <Tag>待冻结</Tag> }
          ]}
        />
      </Card>
    </Space>
  );
}

function RawElapsedEditor({ raceId, registration }: { raceId: string; registration: Registration }) {
  const dispatch = useDispatch<AppDispatch>();
  const [value, setValue] = useState<number | null>(registration.rawElapsedSeconds);
  return (
    <Space>
      <InputNumber min={1} value={value} onChange={setValue} placeholder="秒" style={{ width: 110 }} />
      <Button
        size="small"
        disabled={value == null || value === registration.rawElapsedSeconds}
        onClick={() => value != null && dispatch(saveRawElapsed({ raceId, entryId: registration.id, elapsedSeconds: value }))}
      >
        登记
      </Button>
    </Space>
  );
}

/* --------------------------------- 裁决台账页 --------------------------------- */

const KIND_OPTIONS: Array<{ value: AdjFormValues['kind']; label: string }> = [
  { value: 'penalty', label: '抗议处罚（加秒）' },
  { value: 'exoneration', label: '免责 / 撤销处罚（减秒）' },
  { value: 'resail', label: '重赛成绩（替换该船用时）' },
  { value: 'retire', label: '弃权（计 RET）' },
  { value: 'reinstate', label: '撤销弃权' }
];

function LedgerPage({ race }: { race: Race }) {
  const dispatch = useDispatch<AppDispatch>();
  const [messageApi, contextHolder] = message.useMessage();
  const registrations = useSelector((state: RootState) => registrationsOf(race, state.regatta.registrations));
  const tail = race.ledger.length;
  const head = headVersion(race);
  const published = isPublished(race);

  const { register, handleSubmit, reset, watch, setValue, formState: { errors } } = useForm<AdjFormValues>({
    resolver: zodResolver(adjFormSchema),
    defaultValues: { entryId: registrations[0]?.id, kind: 'penalty', penaltySeconds: 30, elapsedSeconds: 3200, rule: 'RRS 14', note: '', submittedBy: 'judge' }
  });
  const kind = watch('kind');

  if (!isFrozen(race)) {
    return (
      <>
        {contextHolder}
        <Alert type="info" showIcon message="比赛尚未结束：请先在「竞赛控制」结束比赛并冻结原始成绩，之后抗议、重赛和弃权都在此追加。" />
      </>
    );
  }

  const submit = (values: AdjFormValues) => {
    if ((values.kind === 'penalty' || values.kind === 'exoneration') && !(values.penaltySeconds > 0)) {
      messageApi.error('请填写大于 0 的秒数');
      return;
    }
    if (values.kind === 'resail' && !(values.elapsedSeconds > 0)) {
      messageApi.error('请填写重赛用时秒数');
      return;
    }
    dispatch(appendAdjudicationReducer({
      raceId: race.id,
      entryId: values.entryId,
      kind: values.kind,
      penaltySeconds: values.kind === 'penalty' || values.kind === 'exoneration' ? values.penaltySeconds : undefined,
      elapsedSeconds: values.kind === 'resail' ? values.elapsedSeconds : undefined,
      rule: values.rule || undefined,
      note: values.note || undefined,
      submittedBy: values.submittedBy,
      baseSeq: tail
    }));
    messageApi.success(published ? '已追加裁决并生成更正版，正式成绩在重新发布前保持不变' : '已追加裁决并基于台账重新计算');
    reset({ ...values, note: '' });
  };

  const simulateConcurrent = () => {
    const target = registrations[1] ?? registrations[0];
    if (!target) return;
    // 计时员与裁判“同时”提交：两者都基于同一旧尾号，后到的接续先到的继续算
    dispatch(appendAdjudicationReducer({
      raceId: race.id, entryId: target.id, kind: 'resail', elapsedSeconds: 3220,
      rule: 'RRS A10', note: '计时员提交：重赛补测用时 3220 秒', submittedBy: 'timer', baseSeq: tail
    }));
    dispatch(appendAdjudicationReducer({
      raceId: race.id, entryId: target.id, kind: 'penalty', penaltySeconds: 15,
      rule: 'RRS 14', note: '裁判提交：抗议加罚 15 秒（与计时员同时提交，接续已有重赛记录计算）', submittedBy: 'judge', baseSeq: tail
    }));
    messageApi.success('并发模拟完成：两条裁决都保留，后到的处罚接续先到的重赛继续计算，未发生覆盖');
  };

  return (
    <>
      {contextHolder}
      <Row gutter={[18, 18]}>
        <Col xs={24} lg={9}>
          <Card title="追加裁决（只增不改）" extra={<Tag color="cyan">台账尾号 #{tail}</Tag>}>
            {published && (
              <Alert
                style={{ marginBottom: 12 }}
                type="warning" showIcon
                message={`正式版 v${officialVersion(race)?.versionNo} 已发布：现在追加裁决只会生成更正版，不会改动正式成绩。`}
              />
            )}
            <Form layout="vertical" onFinish={handleSubmit(submit)}>
              <Form.Item label="参赛船" validateStatus={errors.entryId ? 'error' : undefined}>
                <select className="native-select" {...register('entryId')}>
                  {registrations.map((entry) => <option key={entry.id} value={entry.id}>{entry.boat} / {entry.sailNo}</option>)}
                </select>
              </Form.Item>
              <Form.Item label="裁决类型">
                <Select
                  value={kind}
                  options={KIND_OPTIONS}
                  onChange={(value: AdjFormValues['kind']) => setValue('kind', value)}
                />
              </Form.Item>
              {(kind === 'penalty' || kind === 'exoneration') && (
                <Form.Item label={kind === 'penalty' ? '处罚秒数' : '撤销秒数'}>
                  <InputNumber min={1} style={{ width: '100%' }} value={watch('penaltySeconds')} onChange={(v) => setValue('penaltySeconds', v ?? 0)} />
                </Form.Item>
              )}
              {kind === 'resail' && (
                <Form.Item label="重赛用时（秒）" extra="重赛替换显示用时，此前的处罚仍然保留并继续累加">
                  <InputNumber min={1} style={{ width: '100%' }} value={watch('elapsedSeconds')} onChange={(v) => setValue('elapsedSeconds', v ?? 0)} />
                </Form.Item>
              )}
              <Form.Item label="适用规则"><Input {...register('rule')} placeholder="如 RRS 14" /></Form.Item>
              <Form.Item label="裁决说明"><Input.TextArea rows={3} {...register('note')} maxLength={120} /></Form.Item>
              <Form.Item label="提交人">
                <Select
                  value={watch('submittedBy')}
                  options={(Object.keys(roleLabel) as SubmitterRole[]).map((role) => ({ value: role, label: roleLabel[role] }))}
                  onChange={(value: SubmitterRole) => setValue('submittedBy', value)}
                />
              </Form.Item>
              <Space wrap>
                <Button htmlType="submit" type="primary" icon={<PlusOutlined />}>追加裁决{published ? '（生成更正版）' : '（触发重算）'}</Button>
                <Button icon={<ThunderboltOutlined />} onClick={simulateConcurrent}>模拟计时员/裁判同时提交</Button>
              </Space>
            </Form>
          </Card>
        </Col>

        <Col xs={24} lg={15}>
          <Card
            title="裁决台账（追加式，不可修改）"
            extra={<Tag color="orange">{race.ledger.length} 条裁决</Tag>}
          >
            {race.ledger.length === 0 ? <Empty description="冻结后暂无追加裁决" /> : (
              <List
                size="small"
                dataSource={[...race.ledger].sort((a, b) => b.seq - a.seq)}
                renderItem={(item) => {
                  const boat = registrations.find((r) => r.id === item.entryId)?.boat ?? item.entryId;
                  return (
                    <List.Item>
                      <List.Item.Meta
                        title={
                          <Space wrap>
                            <Tag color="orange">#{item.seq}</Tag>
                            <b>{kindLabel(item.kind)}</b>
                            <span>{boat}</span>
                            {item.source === 'legacy' && <Tag color="purple">老数据迁移</Tag>}
                          </Space>
                        }
                        description={
                          <Space direction="vertical" size={2}>
                            <span>
                              {item.kind === 'penalty' && `加 ${item.payload.penaltySeconds} 秒`}
                              {item.kind === 'exoneration' && `撤销 ${item.payload.penaltySeconds} 秒处罚`}
                              {item.kind === 'resail' && `重赛成绩 ${item.payload.elapsedSeconds} 秒（处罚保留）`}
                              {item.kind === 'retire' && '计弃权 RET'}
                              {item.kind === 'reinstate' && '撤销弃权，恢复成绩'}
                              {item.kind === 'rejection' && '驳回抗议，成绩不变'}
                              {item.payload.rule ? ` · ${item.payload.rule}` : ''}
                            </span>
                            <span>{item.payload.note}</span>
                            <small style={{ color: '#888' }}>
                              {roleLabel[item.submittedBy]} 提交 · 基于 #{item.baseSeq}
                              {item.rebasedSeq > item.baseSeq ? ` → 接续 #${item.rebasedSeq}（后到，未覆盖先到裁决）` : ' 登记'} · {fmtTime(item.createdAt)}
                            </small>
                          </Space>
                        }
                      />
                    </List.Item>
                  );
                }}
              />
            )}
          </Card>
        </Col>
      </Row>

      <Card
        title="成绩版本（发布只认最新版，旧版可追溯）"
        style={{ marginTop: 18 }}
        extra={
          <Space>
            {head && head.status !== 'official' && (
              <Button
                type="primary"
                onClick={() => dispatch(publishVersion({ raceId: race.id }))}
              >
                发布 v{head.versionNo} 为正式成绩
              </Button>
            )}
          </Space>
        }
      >
        <Collapse
          items={[...race.versions].reverse().map((version) => ({
            key: version.id,
            label: (
              <Space wrap>
                {versionTag(version)}
                <b>{version.label}</b>
                <small style={{ color: '#888' }}>
                  {version.trigger === 'freeze' ? '冻结' : version.trigger === 'recompute' ? '晚到裁决重算' : '发布后更正'}
                  {' '}· 台账截至 #{version.ledgerSeq} · {fmtTime(version.publishedAt ?? version.createdAt)}
                </small>
              </Space>
            ),
            children: (
              <>
                <Alert style={{ marginBottom: 12 }} type={version.status === 'official' ? 'success' : 'info'} showIcon message={version.note} />
                <LeaderboardTable version={version} registrations={registrations} />
              </>
            )
          }))}
        />
      </Card>

      <Card title="裁决 / 重算 / 发布时间线" style={{ marginTop: 18 }}>
        <RaceTimeline raceId={race.id} />
      </Card>
    </>
  );
}

/* --------------------------------- 抗议处理页 --------------------------------- */

function ProtestsPage({ race }: { race: Race }) {
  const dispatch = useDispatch<AppDispatch>();
  const protests = useSelector((state: RootState) => state.regatta.protests.filter((item) => item.raceId === race.id));
  const registrations = useSelector((state: RootState) => registrationsOf(race, state.regatta.registrations));
  const [penaltyInputs, setPenaltyInputs] = useState<Record<string, number>>({});
  const { register, handleSubmit, reset, formState: { errors } } = useForm<z.infer<typeof protestSchema>>({
    resolver: zodResolver(protestSchema),
    defaultValues: { entryId: registrations[0]?.id, reason: '', rule: 'RRS 14' }
  });

  const submit = (values: z.infer<typeof protestSchema>) => {
    dispatch(addProtest({ raceId: race.id, ...values }));
    reset({ entryId: registrations[0]?.id, reason: '', rule: 'RRS 14' });
  };

  const resolveWith = (protestId: string, kind: AdjudicationKind, penaltySeconds?: number) => {
    dispatch(transitionProtest({
      id: protestId,
      status: 'resolved',
      kind,
      penaltySeconds,
      decision: kind === 'penalty'
        ? `接受抗议，追加 ${penaltySeconds} 秒处罚（台账重算）`
        : kind === 'retire'
          ? '接受抗议，该船弃权（RET）'
          : kind === 'resail'
            ? '接受抗议，以重赛成绩替换'
            : '抗议成立',
      baseSeq: race.ledger.length
    }));
  };

  return (
    <Row gutter={[18, 18]}>
      <Col xs={24} lg={8}>
        <Card title="提交抗议">
          <Form layout="vertical" onFinish={handleSubmit(submit)}>
            <Form.Item label="参赛船" validateStatus={errors.entryId ? 'error' : undefined}>
              <select className="native-select" {...register('entryId')}>
                {registrations.map((entry) => <option key={entry.id} value={entry.id}>{entry.boat}</option>)}
              </select>
            </Form.Item>
            <Form.Item label="适用规则" validateStatus={errors.rule ? 'error' : undefined} help={errors.rule?.message}><Input {...register('rule')} /></Form.Item>
            <Form.Item label="事件描述" validateStatus={errors.reason ? 'error' : undefined} help={errors.reason?.message}><Input.TextArea rows={4} {...register('reason')} /></Form.Item>
            <Button type="primary" htmlType="submit" icon={<PlusOutlined />}>登记抗议</Button>
          </Form>
        </Card>
      </Col>
      <Col xs={24} lg={9}>
        <Card title="冲突复核队列" extra={<Tag color="orange">{protests.filter((p) => p.status !== 'resolved' && p.status !== 'rejected').length} 待处理</Tag>}>
          {protests.length === 0 ? <Empty /> : (
            <List
              dataSource={protests}
              renderItem={(item) => {
                const boat = registrations.find((entry) => entry.id === item.entryId)?.boat;
                const frozen = !isFrozen(race);
                return (
                  <List.Item>
                    <List.Item.Meta
                      title={<Space wrap><Tag color={item.status === 'reviewing' ? 'processing' : item.status === 'resolved' ? 'success' : item.status === 'rejected' ? 'error' : 'default'}>{item.status}</Tag>{item.rule}{item.linkedAdjudicationSeq != null && <Tag color="orange">台账 #{item.linkedAdjudicationSeq}</Tag>}</Space>}
                      description={<><div>{item.reason}</div><small>{boat} · {item.decision || '尚未裁决'}</small></>}
                    />
                    <Space direction="vertical" style={{ alignItems: 'flex-end' }}>
                      <Button size="small" disabled={item.status === 'reviewing'} onClick={() => dispatch(transitionProtest({ id: item.id, status: 'reviewing' }))}>进入复核</Button>
                      <Space>
                        <InputNumber
                          size="small" min={1} style={{ width: 86 }}
                          placeholder="秒"
                          value={penaltyInputs[item.id] ?? 30}
                          onChange={(v) => setPenaltyInputs((prev) => ({ ...prev, [item.id]: v ?? 30 }))}
                        />
                        <Button size="small" type="primary" disabled={frozen} onClick={() => resolveWith(item.id, 'penalty', penaltyInputs[item.id] ?? 30)}>接受并加罚</Button>
                      </Space>
                      <Space>
                        <Button size="small" disabled={frozen} onClick={() => resolveWith(item.id, 'retire')}>弃权 RET</Button>
                        <Button size="small" danger disabled={item.status === 'rejected'} onClick={() => dispatch(transitionProtest({ id: item.id, status: 'rejected', decision: '证据不足，维持原成绩（驳回留痕）', kind: 'rejection', baseSeq: race.ledger.length }))}>驳回</Button>
                      </Space>
                      {frozen && <small style={{ color: '#a80' }}>比赛冻结后裁决才会进入台账</small>}
                    </Space>
                  </List.Item>
                );
              }}
            />
          )}
        </Card>
      </Col>
      <Col xs={24} lg={7}>
        <Card title="事件时间线"><RaceTimeline raceId={race.id} /></Card>
      </Col>
    </Row>
  );
}

/* ----------------------------------- 外壳 ----------------------------------- */

function Shell() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const dispatch = useDispatch<AppDispatch>();
  const { data = [] } = useGetOfficialsQuery();
  const races = useSelector((state: RootState) => state.regatta.races);
  const selectedId = useSelector((state: RootState) => state.regatta.ui.selectedRaceId);
  const race = races.find((item) => item.id === selectedId) ?? races[0];

  if (!race) return null;
  const statusLabel: Record<RaceStatus, string> = { scheduled: '待起航', running: '进行中', finished: '已冻结' };

  return (
    <AntApp>
      <Layout className="shell">
        <Header className="header">
          <Space><SafetyCertificateOutlined style={{ fontSize: 24 }} /><Typography.Title level={4} style={{ margin: 0, color: 'white' }}>{t('title')}</Typography.Title></Space>
          <Space wrap>
            <Select
              value={race.id}
              style={{ minWidth: 220 }}
              onChange={(value) => dispatch(selectRace(value))}
              options={races.map((item) => ({ value: item.id, label: `${item.name}（${statusLabel[item.status]}）` }))}
            />
            <Tag>{data.length} 名值班人员</Tag>
            <Button size="small" onClick={() => { dispatch(resetDemo()); message.success('已恢复演示数据'); }}>重置演示数据</Button>
            <Button ghost size="small" onClick={() => void i18n.changeLanguage(i18n.language.startsWith('zh') ? 'en' : 'zh')}>{t('language')}</Button>
          </Space>
        </Header>
        <Layout>
          <Sider width={210} breakpoint="lg" collapsedWidth="0" theme="light">
            <Menu mode="inline" selectedKeys={[location.pathname]} onClick={({ key }) => navigate(key)} items={[
              { key: '/', label: t('control'), icon: <FlagOutlined /> },
              { key: '/ledger', label: t('ledger'), icon: <FileProtectOutlined /> },
              { key: '/protests', label: t('protests'), icon: <SafetyCertificateOutlined /> }
            ]} />
          </Sider>
          <Content className="content">
            <Routes>
              <Route path="/" element={<ControlPage race={race} />} />
              <Route path="/ledger" element={<LedgerPage race={race} />} />
              <Route path="/protests" element={<ProtestsPage race={race} />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Content>
        </Layout>
      </Layout>
    </AntApp>
  );
}

export default function App() { return <BrowserRouter><Shell /></BrowserRouter>; }
