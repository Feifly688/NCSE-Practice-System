import React, { useState, useEffect, useRef } from 'react';
import {
  Typography, Card, Button, Table, Tag, Modal, Form, Input, InputNumber,
  Upload, message, Space, Tabs, Empty, Spin, Alert, Divider, Progress,
} from 'antd';
import {
  PlusOutlined, UploadOutlined, LinkOutlined, DeleteOutlined,
  EyeOutlined, ThunderboltOutlined, CheckCircleOutlined, InboxOutlined,
  RedoOutlined, FileSearchOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import api from '../../services/api';

const { Title, Text, Paragraph } = Typography;

const ORIGIN_TAG = { crawl: { color: 'cyan', text: '爬取' }, upload: { color: 'purple', text: 'PDF上传' } };
const STATUS_TAG = {
  pending_review: { color: 'default', text: '待审核' },
  parsed: { color: 'green', text: '已入库' },
  approved: { color: 'blue', text: '已通过' },
  disabled: { color: 'red', text: '已停用' },
};
const PARSE_TAG = {
  pending: { color: 'default', text: '待拆分' },
  parsing: { color: 'processing', text: '拆分中' },
  success: { color: 'success', text: '拆分完成' },
  partial: { color: 'warning', text: '部分成功' },
  failed: { color: 'error', text: '拆分失败' },
};

export default function ExamPapers() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [papers, setPapers] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);

  // 添加真题弹窗
  const [addOpen, setAddOpen] = useState(false);
  const [addWay, setAddWay] = useState('upload');
  const [uploadForm] = Form.useForm();
  const [crawlForm] = Form.useForm();
  const [fileList, setFileList] = useState([]);
  const [submitting, setSubmitting] = useState(false);

  // 拆分与入库
  const [parseOpen, setParseOpen] = useState(false);
  const [currentPaper, setCurrentPaper] = useState(null);
  const [parseState, setParseState] = useState(null); // 轮询中的状态
  const [parsedQuestions, setParsedQuestions] = useState([]);
  const [selected, setSelected] = useState([]);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState(null);
  const pollRef = useRef(null);

  // 详情
  const [detailOpen, setDetailOpen] = useState(false);
  const [detail, setDetail] = useState(null);

  useEffect(() => { loadPapers(); }, [page]);
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  async function loadPapers() {
    setLoading(true);
    try {
      const r = await api.get('/admin/exam-papers', { params: { page, pageSize: 20 } });
      setPapers(r.data.papers || []);
      setTotal(r.data.total || 0);
    } catch (err) {
      message.error('加载真题列表失败');
    } finally {
      setLoading(false);
    }
  }

  function openAdd() {
    setAddWay('upload');
    uploadForm.resetFields();
    crawlForm.resetFields();
    setFileList([]);
    setAddOpen(true);
  }

  async function submitUpload() {
    const values = await uploadForm.validateFields().catch(() => null);
    if (!values) return;
    if (fileList.length === 0) { message.warning('请选择 PDF 文件'); return; }
    const fd = new FormData();
    fd.append('file', fileList[0].originFileObj || fileList[0]);
    fd.append('title', values.title);
    if (values.year) fd.append('year', values.year);
    setSubmitting(true);
    try {
      const r = await api.post('/admin/exam-papers/upload', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 180000,
      });
      const w = r.data.warning ? `（${r.data.warning}）` : '';
      message.success(`上传成功：提取 ${r.data.textLength} 字${r.data.method === 'ocr-vision' ? '（OCR）' : ''}，已开始 AI 拆题${w}`);
      setAddOpen(false);
      setPage(1);
      loadPapers();
    } catch (err) {
      const d = err.response?.data;
      message.error({
        content: d?.error || '上传失败',
        duration: 6,
      });
      if (d?.detail) console.warn('上传失败详情:', d.detail);
    } finally {
      setSubmitting(false);
    }
  }

  async function submitCrawl() {
    const values = await crawlForm.validateFields().catch(() => null);
    if (!values) return;
    setSubmitting(true);
    try {
      const r = await api.post('/admin/exam-papers/crawl', values, { timeout: 120000 });
      message.success(`抓取成功：提取 ${r.data.textLength} 字，已开始 AI 拆题`);
      setAddOpen(false);
      setPage(1);
      loadPapers();
    } catch (err) {
      message.error({ content: err.response?.data?.error || '抓取失败', duration: 5 });
    } finally {
      setSubmitting(false);
    }
  }

  /** 打开拆题弹窗：若尚未拆分则自动触发，并轮询状态 */
  async function openParse(record) {
    setCurrentPaper(record);
    setParsedQuestions([]);
    setSelected([]);
    setSaveResult(null);
    setParseState({ parse_status: 'loading' });
    setParseOpen(true);

    try {
      const s = await api.get(`/admin/exam-papers/${record.id}/parse-status`);
      setParseState(s.data);
      if (['pending', 'failed', 'partial'].includes(s.data.parse_status)) {
        await api.post(`/admin/exam-papers/${record.id}/parse`);
        startPolling(record.id);
      } else if (s.data.parse_status === 'parsing') {
        startPolling(record.id);
      } else if (s.data.parse_status === 'success') {
        await loadParsedQuestions(record.id);
      }
    } catch (err) {
      message.error('获取拆题状态失败');
      setParseState({ parse_status: 'failed', parse_error: '获取状态失败' });
    }
  }

  function startPolling(paperId) {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const s = await api.get(`/admin/exam-papers/${paperId}/parse-status`);
        setParseState(s.data);
        if (['success', 'partial', 'failed'].includes(s.data.parse_status)) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          if (s.data.parse_status !== 'failed') await loadParsedQuestions(paperId);
          else message.error('拆题失败，可查看原因后重试');
          loadPapers();
        }
      } catch { /* 轮询失败保持等待 */ }
    }, 3000);
  }

  async function loadParsedQuestions(paperId) {
    try {
      const r = await api.get(`/admin/exam-papers/${paperId}/questions`);
      setParsedQuestions(r.data.questions || []);
      setSelected((r.data.questions || []).map((_, i) => i));
    } catch { message.error('加载拆分结果失败'); }
  }

  async function reparse() {
    if (!currentPaper) return;
    setParsedQuestions([]);
    setSaveResult(null);
    try {
      await api.post(`/admin/exam-papers/${currentPaper.id}/reparse`);
      setParseState({ parse_status: 'parsing' });
      message.info('已重新触发拆题');
      startPolling(currentPaper.id);
    } catch (err) {
      message.error(err.response?.data?.error || '重新拆题失败');
    }
  }

  async function confirmSave() {
    if (selected.length === 0) { message.warning('请选择要入库的题目'); return; }
    setSaving(true);
    try {
      const toSave = selected.map((i) => parsedQuestions[i]);
      const r = await api.post(`/admin/exam-papers/${currentPaper.id}/confirm`, { questions: toSave });
      setSaveResult(r.data);
      message.success('入库完成');
      loadPapers();
    } catch (err) {
      message.error(err.response?.data?.error || '入库失败');
    } finally {
      setSaving(false);
    }
  }

  async function openDetail(id) {
    try {
      const r = await api.get(`/admin/exam-papers/${id}`);
      setDetail(r.data);
      setDetailOpen(true);
    } catch { message.error('加载详情失败'); }
  }

  function removePaper(record) {
    Modal.confirm({
      title: '确认删除试卷',
      content: `删除「${record.title}」？整卷题目会一并删除，已入库到题库的题目保留（仅解除归属）。`,
      okText: '删除', okType: 'danger', cancelText: '取消',
      async onOk() {
        try {
          await api.delete(`/admin/exam-papers/${record.id}`);
          message.success('已删除');
          loadPapers();
        } catch { message.error('删除失败'); }
      },
    });
  }

  const columns = [
    { title: '试卷', dataIndex: 'title', ellipsis: true },
    { title: '年份', dataIndex: 'year', width: 80, render: (v) => v || '-' },
    {
      title: '来源', dataIndex: 'origin', width: 110,
      render: (v) => <Tag color={ORIGIN_TAG[v]?.color}>{ORIGIN_TAG[v]?.text || v}</Tag>,
    },
    { title: '来源站点/文件', dataIndex: 'source', width: 140, ellipsis: true, render: (v, r) => v || r.file_name || '-' },
    {
      title: '拆题', dataIndex: 'parse_status', width: 110,
      render: (v, r) => (
        <Space direction="vertical" size={2}>
          <Tag color={PARSE_TAG[v]?.color}>{PARSE_TAG[v]?.text || v}</Tag>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {r.parsed_count > 0 ? `${r.parsed_count} 题` : '—'}
          </Text>
        </Space>
      ),
    },
    {
      title: '已入库', dataIndex: 'question_count', width: 90,
      render: (v) => (v > 0 ? <Tag color="green">{v} 题</Tag> : <Tag>未入库</Tag>),
    },
    { title: '创建时间', dataIndex: 'created_at', width: 160, render: (v) => (v ? new Date(v).toLocaleString('zh-CN') : '-') },
    {
      title: '操作', width: 300,
      render: (_, record) => (
        <Space size="small" wrap>
          <Button size="small" icon={<ThunderboltOutlined />} onClick={() => openParse(record)}>
            {record.parse_status === 'failed' ? '重新拆题' : 'AI 拆分'}
          </Button>
          <Button
            size="small" icon={<FileSearchOutlined />}
            disabled={!record.parsed_count}
            onClick={() => navigate(`/exam-papers/${record.id}`)}
          >
            整卷作答
          </Button>
          <Button size="small" icon={<EyeOutlined />} onClick={() => openDetail(record.id)}>详情</Button>
          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => removePaper(record)}>删除</Button>
        </Space>
      ),
    },
  ];

  const questionColumns = [
    {
      title: '选择', width: 46,
      render: (_, __, i) => (
        <input
          type="checkbox" checked={selected.includes(i)}
          onChange={(e) => setSelected((prev) => (e.target.checked ? [...prev, i] : prev.filter((x) => x !== i)))}
        />
      ),
    },
    { title: '题号', dataIndex: 'seq', width: 60 },
    { title: '模块', dataIndex: 'section', width: 130, render: (v) => <Tag color="blue">{v || '未分类'}</Tag> },
    { title: '题型', dataIndex: 'qtype', width: 100, render: (v) => <Tag color="purple">{v}</Tag> },
    { title: '题干', dataIndex: 'stem', ellipsis: true },
    { title: '答案', dataIndex: 'answer', width: 60 },
  ];

  const parsing = parseState && ['parsing', 'loading'].includes(parseState.parse_status);

  // 拆题要跑几分钟，只显示「请稍候」会让人以为卡死了——展示真实进度与预计剩余时间
  const prog = parseState?.progress;
  const progressPercent = prog && prog.total > 0 ? Math.min(99, Math.round((prog.done / prog.total) * 100)) : 0;
  const progressText = (() => {
    if (!prog) return 'AI 正在按片段分批拆题（自动重试与降级），请稍候…';
    const sec = Math.round((prog.elapsedMs || 0) / 1000);
    if (prog.total > 0) {
      const eta = prog.done > 0 ? Math.round((sec / prog.done) * (prog.total - prog.done)) : null;
      return `${prog.stage}中… 已完成 ${prog.done}/${prog.total}，已用时 ${sec}s${eta ? `，预计还需约 ${eta}s` : ''}`;
    }
    return `${prog.stage}…（已用时 ${sec}s）`;
  })();

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={3} style={{ margin: 0 }}>真题管理</Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={openAdd}>添加真题</Button>
      </div>

      <Alert
        type="info" showIcon style={{ marginBottom: 16 }}
        message="入库流水线与两种存储形态"
        description={
          <span>
            PDF 上传与联网爬取共用同一流水线：文本提取 → 自动 AI 分批拆题 → ①<strong>完整真题试卷</strong>
            （整卷原文 + 按原卷顺序的整卷题目，可在线阅览作答）；②<strong>分模块去重题库</strong>
            （确认后按模块入库，指纹 + 文本相似度 + 题型/选项/答案特征去重）。
            扫描件需服务器 OCR 环境，否则会给出明确报错。
          </span>
        }
      />

      <Card styles={{ body: { padding: 0 } }}>
        <Table
          columns={columns}
          dataSource={papers}
          rowKey="id"
          loading={loading}
          size="small"
          scroll={{ x: 1100 }}
          pagination={{
            current: page, total, pageSize: 20,
            showTotal: (t) => `共 ${t} 套试卷`,
            onChange: setPage,
          }}
        />
      </Card>

      {/* 添加真题 */}
      <Modal title="添加真题" open={addOpen} onCancel={() => setAddOpen(false)} footer={null} width={560}>
        <Tabs
          activeKey={addWay}
          onChange={setAddWay}
          items={[
            {
              key: 'upload',
              label: <span><UploadOutlined /> PDF 上传</span>,
              children: (
                <Form form={uploadForm} layout="vertical" style={{ marginTop: 12 }}>
                  <Form.Item name="title" label="试卷标题" rules={[{ required: true, message: '请填写试卷标题' }]}>
                    <Input placeholder="如：2024年国考行测真题" />
                  </Form.Item>
                  <Form.Item name="year" label="年份">
                    <InputNumber min={1990} max={2100} style={{ width: 120 }} />
                  </Form.Item>
                  <Form.Item label="PDF 文件" required>
                    <Upload.Dragger
                      accept=".pdf,application/pdf"
                      maxCount={1}
                      beforeUpload={() => false}
                      fileList={fileList}
                      onChange={({ fileList: fl }) => setFileList(fl.slice(-1))}
                    >
                      <p className="ant-upload-drag-icon"><InboxOutlined /></p>
                      <p className="ant-upload-text">点击或拖拽上传 PDF 试卷</p>
                      <p className="ant-upload-hint">支持文本型 PDF；扫描件/图片型需服务器安装 poppler-utils 走 OCR</p>
                    </Upload.Dragger>
                  </Form.Item>
                  <Button type="primary" block loading={submitting} onClick={submitUpload}>
                    上传并自动拆题
                  </Button>
                </Form>
              ),
            },
            {
              key: 'crawl',
              label: <span><LinkOutlined /> 联网爬取</span>,
              children: (
                <Form form={crawlForm} layout="vertical" style={{ marginTop: 12 }}>
                  <Form.Item name="url" label="试卷页面 URL" rules={[{ required: true, message: '请填写 URL' }, { type: 'url', message: 'URL 格式不正确' }]}>
                    <Input placeholder="https://example.com/2024-guoce-zhenti" />
                  </Form.Item>
                  <Form.Item name="title" label="试卷标题">
                    <Input placeholder="留空则使用网页标题" />
                  </Form.Item>
                  <Form.Item name="year" label="年份">
                    <InputNumber min={1990} max={2100} style={{ width: 120 }} />
                  </Form.Item>
                  <Alert type="warning" showIcon style={{ marginBottom: 12 }}
                    message="仅支持公网可访问页面，内网地址会被拒绝（SSRF 防护）" />
                  <Button type="primary" block loading={submitting} onClick={submitCrawl}>
                    抓取并自动拆题
                  </Button>
                </Form>
              ),
            },
          ]}
        />
      </Modal>

      {/* AI 拆分与入库 */}
      <Modal
        title={`AI 拆分：${currentPaper?.title || ''}`}
        open={parseOpen}
        onCancel={() => { if (pollRef.current) clearInterval(pollRef.current); setParseOpen(false); }}
        width={960}
        footer={[
          <Button key="close" onClick={() => { if (pollRef.current) clearInterval(pollRef.current); setParseOpen(false); }}>
            关闭
          </Button>,
          <Button key="reparse" icon={<RedoOutlined />} disabled={parsing} onClick={reparse}>
            重新拆题
          </Button>,
          <Button
            key="save" type="primary" icon={<CheckCircleOutlined />} loading={saving}
            disabled={selected.length === 0 || parsing}
            onClick={confirmSave}
          >
            确认入库 ({selected.length})
          </Button>,
        ]}
      >
        {/* 拆题中 */}
        {parsing && (
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <Spin size="large" />
            <Paragraph type="secondary" style={{ marginTop: 16 }}>
              {progressText}
            </Paragraph>
            <Progress
              percent={progressPercent || 60}
              status="active" showInfo={progressPercent > 0} style={{ maxWidth: 320, margin: '0 auto' }}
            />
          </div>
        )}

        {/* 失败或部分失败 */}
        {!parsing && parseState && ['failed', 'partial'].includes(parseState.parse_status) && (
          <Alert
            type={parseState.parse_status === 'failed' ? 'error' : 'warning'}
            showIcon
            style={{ marginBottom: 12 }}
            message={parseState.parse_status === 'failed' ? '拆题失败' : `拆题部分成功（${parseState.parsed_count || 0} 题）`}
            description={
              <div>
                <div>{parseState.parse_error || '（无详细信息）'}</div>
                <div style={{ marginTop: 6 }}>
                  可点击「重新拆题」重试；若持续失败，请检查 PDF 文本质量（是否为扫描件）或 AI 服务配额。
                </div>
              </div>
            }
          />
        )}

        {/* 结果列表 */}
        {!parsing && parsedQuestions.length > 0 && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <Space>
                <Text>共拆分出 {parsedQuestions.length} 道题</Text>
                {parseState?.sections?.length > 0 && (
                  <Space size={4} wrap>
                    {parseState.sections.map((s) => (
                      <Tag key={s.name} color="blue">{s.name}：{s.count}</Tag>
                    ))}
                  </Space>
                )}
              </Space>
              <Space>
                <Button size="small" onClick={() => setSelected(parsedQuestions.map((_, i) => i))}>全选</Button>
                <Button size="small" onClick={() => setSelected([])}>取消</Button>
              </Space>
            </div>
            <Table
              columns={questionColumns}
              dataSource={parsedQuestions.map((q, i) => ({ ...q, key: q.id || i }))}
              size="small"
              pagination={{ pageSize: 8 }}
              scroll={{ y: 320, x: 720 }}
            />
            {saveResult && (
              <Alert
                style={{ marginTop: 12 }} type="success" showIcon
                message={`入库 ${saveResult.inserted} 题${saveResult.duplicated > 0 ? `，去重跳过 ${saveResult.duplicated} 题` : ''}`}
                description={
                  <div>
                    {Object.keys(saveResult.byModule || {}).length > 0 && (
                      <Space size={[6, 4]} wrap style={{ marginBottom: 6 }}>
                        {Object.entries(saveResult.byModule).map(([m, c]) => (
                          <Tag key={m} color="blue">{m}：{c} 题</Tag>
                        ))}
                      </Space>
                    )}
                    {saveResult.duplicateDetails?.length > 0 && (
                      <div style={{ fontSize: 12, color: '#8c8c8c' }}>
                        判重示例：
                        {saveResult.duplicateDetails.slice(0, 3).map((d, i) => (
                          <div key={i}>· {d.stem}…（{d.reason === 'exact' ? '完全一致' : `相似度 ${d.score}`}）</div>
                        ))}
                      </div>
                    )}
                  </div>
                }
              />
            )}
          </div>
        )}

        {!parsing && parsedQuestions.length === 0 && parseState?.parse_status === 'success' && (
          <Empty description="未从该试卷中拆分出题目，请检查整卷文本" />
        )}
      </Modal>

      {/* 详情 */}
      <Modal title="试卷详情" open={detailOpen} onCancel={() => setDetailOpen(false)} footer={null} width={760}>
        {detail && (
          <div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
              <Tag>{detail.paper.title}</Tag>
              {detail.paper.year && <Tag>{detail.paper.year}</Tag>}
              <Tag color={ORIGIN_TAG[detail.paper.origin]?.color}>{ORIGIN_TAG[detail.paper.origin]?.text}</Tag>
              <Tag color={PARSE_TAG[detail.paper.parse_status]?.color}>
                拆题：{PARSE_TAG[detail.paper.parse_status]?.text}
              </Tag>
              <Tag color="green">整卷题目 {detail.paper.parsed_count ?? 0} 题</Tag>
              <Tag color="blue">题库已入库 {detail.paper.question_count} 题</Tag>
            </div>

            {detail.paper.parse_error && (
              <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="拆题记录" description={detail.paper.parse_error} />
            )}

            <Divider style={{ margin: '12px 0' }} />
            <Text strong>整卷文本（完整真题试卷形态）</Text>
            <div style={{
              marginTop: 8, maxHeight: 220, overflow: 'auto', padding: 12,
              background: '#fafafa', borderRadius: 8, whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.7,
            }}>
              {(detail.paper.raw_text || '').slice(0, 3000) || '（无文本）'}
            </div>

            <Divider style={{ margin: '12px 0' }} />
            <Text strong>整卷题目（按原卷顺序，供在线阅览作答）</Text>
            <div style={{ marginTop: 8, maxHeight: 200, overflow: 'auto' }}>
              {detail.paperQuestions?.length === 0 ? (
                <Empty description="尚未拆出题目" />
              ) : (
                <Space direction="vertical" size={4} style={{ width: '100%' }}>
                  {detail.paperQuestions.map((q) => (
                    <div key={q.seq} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <Tag>{q.seq}</Tag>
                      <Tag color="blue">{q.section}</Tag>
                      <Tag color="purple">{q.qtype}</Tag>
                      <Text ellipsis style={{ flex: 1, minWidth: 160 }}>{q.stem}</Text>
                    </div>
                  ))}
                </Space>
              )}
            </div>

            <Divider style={{ margin: '12px 0' }} />
            <Text strong>已入库题目（分模块去重题库）</Text>
            <div style={{ marginTop: 8 }}>
              {detail.questions.length === 0 ? (
                <Empty description="尚未入库题目" />
              ) : (
                <Space direction="vertical" size={4} style={{ width: '100%' }}>
                  {detail.questions.map((q) => (
                    <div key={q.id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <Tag>{q.subject_name || '未分类'}</Tag>
                      <Tag color="purple">{q.qtype}</Tag>
                      <Text ellipsis style={{ flex: 1, minWidth: 160 }}>{q.stem}</Text>
                      <Text type="secondary">答案 {q.answer}</Text>
                    </div>
                  ))}
                </Space>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
