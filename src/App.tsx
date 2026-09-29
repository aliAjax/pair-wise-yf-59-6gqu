import { useEffect, useMemo, useState } from 'react';
import {
  App as AntApp,
  Badge,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Form,
  Input,
  InputNumber,
  Layout,
  List,
  Menu,
  Modal,
  Popconfirm,
  Radio,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Timeline,
  Typography
} from 'antd';
import { ClockCircleOutlined, FlagOutlined, PlusOutlined, SafetyCertificateOutlined, LockOutlined } from '@ant-design/icons';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import {
  appendAdjudication,
  createCorrectionVersion,
  freezeRace,
  publishVersion,
  registerProtest,
  resetAll,
  resolveProtest,
  setProtestReviewing,
  startRace,
  type AppDispatch,
  type FreezeResultInput,
  type RootState
} from './store';
import { useGetOfficialsQuery } from './api';
import type { AdjudicationKind, JudgeRole, ResultVersion, VersionRow } from './types';
import {
  adjudicationKindMeta,
  draftVersion,
  fmtClock,
  fmtTime,
  latestVersion,
  officialVersion,
  resultStatusMeta,
  selectRace,
  sortedVersions,
  timelineColor,
  timelineLabel,
  versionStatusMeta
} from './selectors';

const { Header, Content, Sider } = Layout;
const RACE_ID = 'race-1';

const RACE_STATUS_TEXT: Record<string, string> = { scheduled: '待起航', running: '进行中', finished: '已结束' };

const protestSchema = z.object({
  entryId: z.string().min(1),
  reason: z.string().min(4),
  rule: z.string().min(2),
  by: z.string().min(2)
});

function countdown(target: string, now: number) {
  const seconds = Math.max(0, Math.floor((new Date(target).getTime() - now) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function useRegatta() {
  return useSelector((s: RootState) => selectRace(s.regatta, RACE_ID));
}

// ---------- 冻结原始成绩对话框 ----------
function FreezeModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dispatch = useDispatch<AppDispatch>();
  const { message } = AntApp.useApp();
  const bundle = useRegatta();
  const [times, setTimes] = useState<Record<string, number>>({});
  const [by, setBy] = useState('罗夏');

  useEffect(() => {
    if (open && bundle) {
      const seed: Record<string, number> = {};
      bundle.boats.forEach((b, i) => { seed[b.id] = times[b.id] ?? 3160 + i * 22; });
      setTimes(seed);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!bundle) return null;

  const submit = () => {
    const results: FreezeResultInput[] = [];
    for (const b of bundle.boats) {
      const v = times[b.id];
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
        message.error(`请填写 ${b.boat} 的有效净用时`);
        return;
      }
      results.push({ entryId: b.id, elapsedSeconds: v });
    }
    dispatch(freezeRace({ id: RACE_ID, results, by: by.trim() || '计时员' }));
    message.success('原始成绩已冻结，之后只能追加裁决');
    onClose();
  };

  return (
    <Modal title="比赛结束 · 冻结原始成绩" open={open} onCancel={onClose} onOk={submit} okText="结束比赛并冻结" cancelText="取消" destroyOnClose>
      <Typography.Paragraph type="warning">
        <LockOutlined /> 冻结后原始秒数不可修改；抗议、重赛、弃权只能通过追加裁决改变显示结果。
      </Typography.Paragraph>
      <Space direction="vertical" style={{ width: '100%' }}>
        {bundle.boats.map((b) => (
          <Space key={b.id} style={{ width: '100%', justifyContent: 'space-between' }}>
            <span><b>{b.boat}</b> <Tag>{b.sailNo}</Tag><small> {b.skipper}</small></span>
            <InputNumber
              min={1}
              value={times[b.id]}
              onChange={(v) => setTimes((t) => ({ ...t, [b.id]: typeof v === 'number' ? v : 0 }))}
              addonAfter="秒"
              style={{ width: 180 }}
            />
          </Space>
        ))}
        <Space>提交人（计时员）：<Input value={by} onChange={(e) => setBy(e.target.value)} style={{ width: 160 }} /></Space>
      </Space>
    </Modal>
  );
}

function RankTable({ rows, sources }: { rows: VersionRow[]; sources?: 'show' }) {
  return (
    <Table
      rowKey="entryId"
      size="small"
      pagination={false}
      dataSource={rows}
      columns={[
        { title: '排名', dataIndex: 'rank', width: 60, render: (v: number | null) => v ?? '—' },
        { title: '船名', render: (_v, r) => <><b>{r.boat}</b> <small>{r.sailNo}</small></> },
        { title: '原始/重赛用时', dataIndex: 'elapsedSeconds', width: 130, render: (v: number) => `${v}s` },
        { title: '处罚', dataIndex: 'penaltySeconds', width: 80, render: (v: number) => v > 0 ? <Tag color="orange">+{v}s</Tag> : '—' },
        { title: '修正总时', width: 100, render: (_v, r) => r.status === 'retired' ? 'RET' : <b>{r.correctedSeconds}s</b> },
        {
          title: '状态',
          width: 90,
          render: (_v, r) => <Tag color={resultStatusMeta[r.status].color}>{resultStatusMeta[r.status].label}</Tag>
        },
        ...(sources === 'show'
          ? [{ title: '依据裁决', width: 110, render: (_v: unknown, r: VersionRow) => r.sources.length ? r.sources.map((s) => <Tag key={s} color="geekblue">#{s}</Tag>) : <small>原始成绩</small> }]
          : [])
      ]}
    />
  );
}

// ---------- 竞赛控制 ----------
function ControlPage() {
  const { t } = useTranslation();
  const dispatch = useDispatch<AppDispatch>();
  const bundle = useRegatta();
  const [now, setNow] = useState(Date.now());
  const [freezeOpen, setFreezeOpen] = useState(false);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);

  if (!bundle) return null;
  const { race } = bundle;
  const official = officialVersion(bundle.versions);
  const draft = draftVersion(bundle.versions);
  const shown = draft ?? latestVersion(bundle.versions);

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Row gutter={[18, 18]}>
        <Col xs={24} lg={10}>
          <Card className="hero-card">
            <Badge status={race.status === 'running' ? 'processing' : race.status === 'finished' ? 'success' : 'default'} text={`比赛状态：${RACE_STATUS_TEXT[race.status]}`} />
            <Statistic title="距离起航" value={countdown(race.startsAt, now)} prefix={<ClockCircleOutlined />} />
            <Descriptions column={1} style={{ marginTop: 18 }}>
              <Descriptions.Item label="组别">{race.fleet}</Descriptions.Item>
              <Descriptions.Item label="航线">{race.course}</Descriptions.Item>
              <Descriptions.Item label="冻结时间">{race.frozenAt ? fmtTime(race.frozenAt) : '未冻结'}</Descriptions.Item>
            </Descriptions>
            <Space wrap>
              <Button type="primary" icon={<FlagOutlined />} disabled={race.status !== 'scheduled'} onClick={() => dispatch(startRace({ id: race.id }))}>开始比赛</Button>
              <Button icon={<LockOutlined />} disabled={race.status === 'finished'} onClick={() => setFreezeOpen(true)}>结束比赛并冻结</Button>
            </Space>
          </Card>
        </Col>
        <Col xs={24} lg={14}>
          <Card
            title={t('control')}
            extra={
              <Space>
                {official && <Tag color="green">正式 V{official.versionNo}</Tag>}
                {draft && <Tag color="orange">草稿 V{draft.versionNo}</Tag>}
                <Tag color="blue">{bundle.boats.length} 艘参赛船</Tag>
              </Space>
            }
          >
            {shown ? (
              <>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  当前显示：{draft ? `待发布重算版 V${draft.versionNo}` : official ? `正式版 V${official.versionNo}` : `原始版 V${shown.versionNo}`}
                </Typography.Text>
                <RankTable rows={shown.rows} />
              </>
            ) : (
              <Empty description="比赛未结束，尚无成绩。结束比赛时由计时员提交并冻结原始成绩。" />
            )}
          </Card>
        </Col>
      </Row>
      <FreezeModal open={freezeOpen} onClose={() => setFreezeOpen(false)} />
    </Space>
  );
}

// ---------- 成绩与版本（裁决台账） ----------
function VersionCard({ version, onPublish }: { version: ResultVersion; onPublish?: (v: ResultVersion) => void }) {
  const meta = versionStatusMeta[version.status];
  return (
    <Card
      size="small"
      style={{ marginBottom: 12, borderColor: version.status === 'published' ? '#52c41a' : undefined }}
      title={
        <Space wrap>
          <b>V{version.versionNo}</b>
          <Tag color={meta.color}>{meta.label}</Tag>
          {version.kind === 'original' && <Tag>原始版</Tag>}
          <span style={{ fontWeight: 400, fontSize: 13 }}>{version.reason}</span>
        </Space>
      }
      extra={
        <Space size="small">
          <small>台账截至 #{version.basedOnSeq}</small>
          {onPublish && version.status === 'draft' && <Button size="small" type="primary" onClick={() => onPublish(version)}>发布此版本</Button>}
        </Space>
      }
    >
      <Descriptions size="small" column={3}>
        <Descriptions.Item label="创建">{version.createdBy} · {fmtClock(version.createdAt)}</Descriptions.Item>
        <Descriptions.Item label="发布时间">{fmtTime(version.publishedAt)}</Descriptions.Item>
        <Descriptions.Item label="被取代时间">{fmtTime(version.supersededAt)}</Descriptions.Item>
      </Descriptions>
      <RankTable rows={version.rows} sources="show" />
    </Card>
  );
}

function ResultsPage() {
  const dispatch = useDispatch<AppDispatch>();
  const { message } = AntApp.useApp();
  const bundle = useRegatta();
  const [adjForm, setAdjForm] = useState({
    entryId: bundle?.boats[0]?.id ?? '',
    kind: 'timeCorrection' as 'timeCorrection' | 'rerace' | 'retirement',
    role: 'timer' as JudgeRole,
    elapsedSeconds: 3200,
    detail: '',
    by: '罗夏'
  });
  const [corrReason, setCorrReason] = useState('');
  const [corrBy, setCorrBy] = useState('宋宁');

  if (!bundle) return null;
  const { race, adjudications } = bundle;
  const versions = sortedVersions(bundle.versions);
  const official = officialVersion(bundle.versions);
  const draft = draftVersion(bundle.versions);
  const needsElapsed = adjForm.kind === 'timeCorrection' || adjForm.kind === 'rerace';

  const submitAdj = () => {
    if (adjForm.detail.trim().length < 2 || adjForm.by.trim().length < 2) {
      message.error('请填写裁决说明和提交人');
      return;
    }
    if (needsElapsed && !(adjForm.elapsedSeconds > 0)) {
      message.error('请填写有效的新用时（秒）');
      return;
    }
    dispatch(appendAdjudication({
      input: {
        raceId: RACE_ID,
        entryId: adjForm.entryId,
        kind: adjForm.kind,
        role: adjForm.role,
        elapsedSeconds: needsElapsed ? adjForm.elapsedSeconds : undefined,
        title: adjudicationKindMeta[adjForm.kind].label,
        detail: adjForm.detail.trim(),
        author: adjForm.by.trim()
      }
    }));
    message.success(official && !draft ? '裁决已追加入账，正式版未变，需生成更正版' : '裁决已追加并触发重算');
    setAdjForm((f) => ({ ...f, detail: '' }));
  };

  const submitCorrection = () => {
    if (corrReason.trim().length < 4 || corrBy.trim().length < 2) {
      message.error('请填写更正原因和裁决人');
      return;
    }
    dispatch(createCorrectionVersion({ raceId: RACE_ID, reason: corrReason.trim(), by: corrBy.trim() }));
    setCorrReason('');
    message.success('已基于全部已登记裁决生成更正版草稿');
  };

  return (
    <Row gutter={[18, 18]}>
      <Col xs={24} lg={9}>
        <Card title="追加裁决（计时更正 / 重赛 / 弃权）" style={{ marginBottom: 18 }}>
          {race.status !== 'finished' ? (
            <Empty description="比赛未结束，原始成绩尚未冻结" />
          ) : (
            <Form layout="vertical" onFinish={(e) => { e.preventDefault(); submitAdj(); }}>
              <Form.Item label="参赛船">
                <select
                  className="native-select"
                  value={adjForm.entryId}
                  onChange={(e) => setAdjForm((f) => ({ ...f, entryId: e.target.value }))}
                >
                  {bundle.boats.map((b) => <option key={b.id} value={b.id}>{b.boat} / {b.sailNo}</option>)}
                </select>
              </Form.Item>
              <Form.Item label="裁决类型">
                <Radio.Group
                  value={adjForm.kind}
                  onChange={(e) => setAdjForm((f) => ({ ...f, kind: e.target.value }))}
                >
                  <Radio value="timeCorrection">计时更正</Radio>
                  <Radio value="rerace">重赛成绩</Radio>
                  <Radio value="retirement">弃权 RET</Radio>
                </Radio.Group>
              </Form.Item>
              <Form.Item label="提交方">
                <Radio.Group
                  value={adjForm.role}
                  onChange={(e) => setAdjForm((f) => ({ ...f, role: e.target.value as JudgeRole }))}
                >
                  <Radio value="timer">计时员</Radio>
                  <Radio value="jury">裁判</Radio>
                </Radio.Group>
              </Form.Item>
              {needsElapsed && (
                <Form.Item label="新用时（秒，仅替换用时，不改已登记处罚）">
                  <InputNumber
                    min={1}
                    style={{ width: '100%' }}
                    value={adjForm.elapsedSeconds}
                    onChange={(v) => setAdjForm((f) => ({ ...f, elapsedSeconds: typeof v === 'number' ? v : 0 }))}
                  />
                </Form.Item>
              )}
              <Form.Item label="说明">
                <Input.TextArea rows={2} value={adjForm.detail} onChange={(e) => setAdjForm((f) => ({ ...f, detail: e.target.value }))} placeholder="如：起航浮标漏绕，重赛净用时 / 器材损坏弃权" />
              </Form.Item>
              <Form.Item label="提交人">
                <Input value={adjForm.by} onChange={(e) => setAdjForm((f) => ({ ...f, by: e.target.value }))} />
              </Form.Item>
              <Button type="primary" htmlType="submit" icon={<PlusOutlined />}>追加裁决</Button>
              <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
                后到的提交自动基于已登记到 #{race.lastSeq} 的裁决续算：处罚累加不覆盖，重赛只替换用时。
              </Typography.Paragraph>
            </Form>
          )}
        </Card>

        <Card title="裁决台账（只追加，不可改删）">
          <Table
            rowKey="seq"
            size="small"
            pagination={false}
            scroll={{ y: 260 }}
            dataSource={[...adjudications].sort((a, b) => b.seq - a.seq)}
            columns={[
              { title: '#', dataIndex: 'seq', width: 44 },
              { title: '类型', width: 110, render: (_v, r) => <Tag color={adjudicationKindMeta[r.kind].color}>{adjudicationKindMeta[r.kind].label}</Tag> },
              { title: '船', render: (_v, r) => bundle.boats.find((b) => b.id === r.entryId)?.boat ?? r.entryId },
              { title: '内容', render: (_v, r) => (<><div>{r.detail}</div><small>{r.role === 'timer' ? '计时员' : '裁判'} {r.author} · 基于 #{r.basedOnSeq}</small></>) }
            ]}
          />
        </Card>
      </Col>

      <Col xs={24} lg={15}>
        {official && !draft && (
          <Card size="small" style={{ marginBottom: 18 }} title="发布后晚到裁决" extra={<Tag color="green">正式 V{official.versionNo} 生效中</Tag>}>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 10 }}>
              正式版不会被直接改动。追加的裁决已入账，确认后生成更正版草稿，再走发布流程。
            </Typography.Paragraph>
            <Space wrap>
              <Input placeholder="更正原因" value={corrReason} onChange={(e) => setCorrReason(e.target.value)} style={{ width: 240 }} />
              <Input placeholder="裁决人" value={corrBy} onChange={(e) => setCorrBy(e.target.value)} style={{ width: 120 }} />
              <Button type="primary" onClick={submitCorrection}>生成更正版</Button>
            </Space>
          </Card>
        )}

        <Card
          title="成绩版本"
          extra={
            <Space>
              <Tag color={official ? 'green' : 'orange'}>{official ? `正式：V${official.versionNo}` : '尚未发布'}</Tag>
              {draft && <Tag color="orange">待发布：V{draft.versionNo}</Tag>}
            </Space>
          }
        >
          {versions.length === 0 ? <Empty description="比赛结束并冻结后生成原始版" /> : (
            <>
              {[...versions].reverse().map((v) => (
                <VersionCard
                  key={v.id}
                  version={v}
                  onPublish={(ver) => {
                    Modal.confirm({
                      title: `发布 V${ver.versionNo} 为正式成绩？`,
                      content: ver.kind === 'original' ? '发布后仅该版本成为正式成绩。' : '旧正式版将转为历史版本，仍可追溯。',
                      okText: '发布',
                      cancelText: '取消',
                      onOk: () => { dispatch(publishVersion({ raceId: RACE_ID, by: '宋宁' })); message.success(`V${ver.versionNo} 已发布为正式成绩`); }
                    });
                  }}
                />
              ))}
            </>
          )}
        </Card>
      </Col>
    </Row>
  );
}

// ---------- 抗议与时间线 ----------
function ProtestsPage() {
  const dispatch = useDispatch<AppDispatch>();
  const { message } = AntApp.useApp();
  const bundle = useRegatta();
  const protests = useSelector((s: RootState) => s.regatta.protests.filter((p) => p.raceId === RACE_ID));
  const timeline = useSelector((s: RootState) => s.regatta.timeline);
  const { register, handleSubmit, reset, formState: { errors } } = useForm<z.infer<typeof protestSchema>>({
    resolver: zodResolver(protestSchema),
    defaultValues: { entryId: bundle?.boats[0]?.id, reason: '', rule: 'RRS 14', by: '宋宁' }
  });
  const [penalty, setPenalty] = useState<Record<string, number>>({});

  if (!bundle) return null;

  const submit = (values: z.infer<typeof protestSchema>) => {
    dispatch(registerProtest({ raceId: RACE_ID, entryId: values.entryId, reason: values.reason, rule: values.rule, by: values.by }));
    message.success('抗议已登记');
    reset({ entryId: bundle.boats[0]?.id, reason: '', rule: values.rule, by: values.by });
  };

  return (
    <Row gutter={[18, 18]}>
      <Col xs={24} lg={8}>
        <Card title="提交抗议">
          <Form layout="vertical" onFinish={handleSubmit(submit)}>
            <Form.Item label="参赛船">
              <select className="native-select" {...register('entryId')}>
                {bundle.boats.map((b) => <option key={b.id} value={b.id}>{b.boat} / {b.sailNo}</option>)}
              </select>
            </Form.Item>
            <Form.Item label="适用规则" validateStatus={errors.rule ? 'error' : undefined} help={errors.rule?.message}><Input {...register('rule')} /></Form.Item>
            <Form.Item label="事件描述" validateStatus={errors.reason ? 'error' : undefined} help={errors.reason?.message}><Input.TextArea rows={4} {...register('reason')} /></Form.Item>
            <Form.Item label="提交人" validateStatus={errors.by ? 'error' : undefined} help={errors.by?.message}><Input {...register('by')} /></Form.Item>
            <Button type="primary" htmlType="submit" icon={<PlusOutlined />}>登记抗议</Button>
          </Form>
        </Card>
      </Col>
      <Col xs={24} lg={8}>
        <Card title="复核与裁决">
          {protests.length === 0 ? <Empty /> : (
            <List dataSource={protests} renderItem={(item) => (
              <List.Item>
                <List.Item.Meta
                  title={<Space wrap><Tag color={item.status === 'reviewing' ? 'processing' : item.status === 'resolved' ? 'success' : 'default'}>{item.status === 'submitted' ? '已提交' : item.status === 'reviewing' ? '复核中' : '已裁决'}</Tag>{item.rule}</Space>}
                  description={
                    <>
                      <div>{item.reason}</div>
                      <small>{bundle.boats.find((b) => b.id === item.entryId)?.boat}</small>
                      {item.decision && <div style={{ marginTop: 4 }}>裁决：{item.decision}</div>}
                    </>
                  }
                />
                {item.status !== 'resolved' && (
                  <Space direction="vertical" size={4}>
                    {item.status === 'submitted' && <Button size="small" onClick={() => dispatch(setProtestReviewing({ id: item.id }))}>进入复核</Button>}
                    <Space.Compact style={{ width: '100%' }}>
                      <InputNumber min={1} defaultValue={30} size="small" style={{ width: 80 }} onChange={(v) => setPenalty((p) => ({ ...p, [item.id]: typeof v === 'number' ? v : 30 }))} addonAfter="秒" />
                      <Button
                        size="small"
                        type="primary"
                        onClick={() => { dispatch(resolveProtest({ protestId: item.id, decision: '抗议成立，按规则加罚', kind: 'protestUpheldPenalty', penaltyDeltaSeconds: penalty[item.id] ?? 30, by: '宋宁' })); message.success('处罚已追加（累加，不覆盖既有处罚）'); }}
                      >成立加罚</Button>
                    </Space.Compact>
                    <Button size="small" onClick={() => dispatch(resolveProtest({ protestId: item.id, decision: '抗议成立，免予处罚', kind: 'protestUpheldNoPenalty', by: '宋宁' }))}>成立免罚</Button>
                    <Button size="small" danger onClick={() => dispatch(resolveProtest({ protestId: item.id, decision: '证据不足，驳回抗议，维持原成绩', kind: 'protestRejected', by: '宋宁' }))}>驳回</Button>
                  </Space>
                )}
              </List.Item>
            )} />
          )}
        </Card>
      </Col>
      <Col xs={24} lg={8}>
        <Card title="裁决 / 重算 / 发布时间线" style={{ maxHeight: '70vh', overflowY: 'auto' }}>
          <Timeline
            items={timeline.map((event) => ({
              color: timelineColor[event.type],
              children: (
                <>
                  <Space size={4} wrap>
                    <Tag color={timelineColor[event.type]} style={{ marginInlineEnd: 0 }}>{timelineLabel[event.type]}</Tag>
                    {typeof event.seq === 'number' && <Tag color="orange">#{event.seq}</Tag>}
                    {typeof event.versionNo === 'number' && <Tag color="green">V{event.versionNo}</Tag>}
                    <b>{event.title}</b>
                  </Space>
                  <div style={{ fontSize: 12 }}>{event.message}</div>
                  <small>{fmtTime(event.time)}</small>
                </>
              )
            }))}
          />
        </Card>
      </Col>
    </Row>
  );
}

// ---------- 外壳 ----------
function Shell() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const dispatch = useDispatch<AppDispatch>();
  const { data = [] } = useGetOfficialsQuery();
  return (
    <AntApp>
      <Layout className="shell">
        <Header className="header">
          <Space><SafetyCertificateOutlined style={{ fontSize: 24 }} /><Typography.Title level={4} style={{ margin: 0, color: 'white' }}>{t('title')}</Typography.Title></Space>
          <Space>
            <Tag>{data.length} 名值班人员</Tag>
            <Popconfirm title="重置为演示数据？" description="将清空当前台账（仅本机）" onConfirm={() => dispatch(resetAll())} okText="重置" cancelText="取消">
              <Button ghost size="small">重置演示</Button>
            </Popconfirm>
            <Button ghost onClick={() => void i18n.changeLanguage(i18n.language.startsWith('zh') ? 'en' : 'zh')}>{t('language')}</Button>
          </Space>
        </Header>
        <Layout>
          <Sider width={210} breakpoint="lg" collapsedWidth="0" theme="light">
            <Menu mode="inline" selectedKeys={[location.pathname]} onClick={({ key }) => navigate(key)} items={[
              { key: '/', label: t('control'), icon: <FlagOutlined /> },
              { key: '/results', label: t('results'), icon: <ClockCircleOutlined /> },
              { key: '/protests', label: t('protests'), icon: <SafetyCertificateOutlined /> }
            ]} />
          </Sider>
          <Content className="content"><Routes>
            <Route path="/" element={<ControlPage />} />
            <Route path="/results" element={<ResultsPage />} />
            <Route path="/protests" element={<ProtestsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes></Content>
        </Layout>
      </Layout>
    </AntApp>
  );
}

export default function App() { return <BrowserRouter><Shell /></BrowserRouter>; }
