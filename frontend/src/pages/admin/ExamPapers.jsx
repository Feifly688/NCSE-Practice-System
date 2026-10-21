import React, { useState, useEffect } from 'react';
import {
  Typography, Card, Button, Table, Tag, Modal, Form, Input, InputNumber,
  Upload, message, Space, Tabs, Empty, Spin, Descriptions, Alert, Divider,
} from 'antd';
import {
  PlusOutlined, UploadOutlined, LinkOutlined, DeleteOutlined,
  EyeOutlined, ThunderboltOutlined, CheckCircleOutlined, InboxOutlined,
} from '@ant-design/icons';
import api from '../../services/api';

const { Title, Text, Paragraph } = Typography;

const ORIGIN_TAG = { crawl: { color: 'cyan', text: '爬取' }, upload: { color: 'purple', text: 'PDF上传' } };
const STATUS_TAG = {
  pending_review: { color: 'default', text: '待拆分' },
  parsed: { color: 'green', text: '已拆分' },
  approved: { color: 'blue', text: '已通过' },
  disabled: { color: 'red', text: '已停用' },
};

export default function ExamPapers() {
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
  const [parsing, setParsing] = useState(false);
  const [parsedQuestions, setParsedQuestions] = useState([]);
  const [selected, setSelected] = useState([]);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState(null);

  // 详情
  const [detailOpen, setDetailOpen] = useState(false);
  const [detail, setDetail] = useState(null);

  useEffect(() => { loadPapers(); }, [page]);

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
        timeout: 120000,
      });
      message.success(`上传成功，提取文本 ${r.data.textLength} 字，可进行 AI 拆分`);
      setAddOpen(false);
      setPage(1);
      loadPapers();
    } catch (err) {
      message.error(err.response?.data?.error || '上传失败');
    } finally {
      setSubmitting(false);
    }
  }

  async function submitCrawl() {
    const values = await crawlForm.validateFields().catch(() => null);
    if (!values) return;
    setSubmitting(true);
    try {
      const r = await api.post('/admin/exam-papers/crawl', values, { timeout: 60000 });
      message.success(`抓取成功，提取文本 ${r.data.textLength} 字，可进行 AI 拆分`);
      setAddOpen(false);
      setPage(1);
      loadPapers();
    } catch (err) {
      message.error(err.response?.data?.error || '抓取失败');
    } finally {
      setSubmitting(false);
    }
  }

  async function openParse(record) {
    setCurrentPaper(record);
    setParsedQuestions([]);
    setSelected([]);
    setSaveResult(null);
    setParseOpen(true);
  }

  async function runParse() {
    if (!currentPaper) return;
    setParsing(true);
    try {
      const r = await api.post(`/admin/exam-papers/${currentPaper.id}/parse`);
      setParsedQuestions(r.data.questions || []);
      setSelected((r.data.questions || []).map((_, i) => i));
      if ((r.data.questions || []).length === 0) message.info('未从该试卷中拆分出题目');
    } catch (err) {
      message.error(err.response?.data?.error || 'AI 拆分失败');
    } finally {
      setParsing(false);
    }
  }

  async function confirmSave() {
    if (selected.length === 0) { message.warning('请选择要入库的题目'); return; }
    setSaving(true);
    try {
      const toSave = selected.map(i => parsedQuestions[i]);
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
    } catch (err) { message.error('加载详情失败'); }
  }

  function removePaper(record) {
    Modal.confirm({
      title: '确认删除试卷',
      content: `删除「${record.title}」？已入库的题目会保留（仅解除归属）。`,
      okText: '删除', okType: 'danger', cancelText: '取消',
      async onOk() {
        try {
          await api.delete(`/admin/exam-papers/${record.id}`);
          message.success('已删除');
          loadPapers();
        } catch (err) { message.error('删除失败'); }
      },
    });
  }

  const columns = [
    { title: '试卷', dataIndex: 'title', ellipsis: true },
    { title: '年份', dataIndex: 'year', width: 80, render: v => v || '-' },
    {
      title: '来源', dataIndex: 'origin', width: 110,
      render: (v, r) => <Tag color={ORIGIN_TAG[v]?.color}>{ORIGIN_TAG[v]?.text || v}</Tag>,
    },
    { title: '来源站点/文件', dataIndex: 'source', width: 160, ellipsis: true, render: (v, r) => v || r.file_name || '-' },
    {
      title: '已拆题', dataIndex: 'question_count', width: 90,
      render: v => v > 0 ? <Tag color="green">{v} 题</Tag> : <Tag>未拆分</Tag>,
    },
    {
      title: '状态', dataIndex: 'status', width: 90,
      render: v => <Tag color={STATUS_TAG[v]?.color}>{STATUS_TAG[v]?.text || v}</Tag>,
    },
    { title: '创建时间', dataIndex: 'created_at', width: 170, render: v => v ? new Date(v).toLocaleString('zh-CN') : '-' },
    {
      title: '操作', width: 240,
      render: (_, record) => (
        <Space size="small">
          <Button size="small" icon={<ThunderboltOutlined />} onClick={() => openParse(record)}>AI 拆分</Button>
          <Button size="small" icon={<EyeOutlined />} onClick={() => openDetail(record.id)}>详情</Button>
          <Button size="small" danger icon={<DeleteOutlined />} onClick={() => removePaper(record)}>删除</Button>
        </Space>
      ),
    },
  ];

  const questionColumns = [
    {
      title: '选择', width: 50,
      render: (_, __, i) => (
        <input type="checkbox" checked={selected.includes(i)}
          onChange={e => setSelected(prev => e.target.checked ? [...prev, i] : prev.filter(x => x !== i))} />
      ),
    },
    { title: '模块', dataIndex: 'module', width: 150, render: v => <Tag color="blue">{v || '未分类'}</Tag> },
    { title: '题型', dataIndex: 'qtype', width: 110, render: v => <Tag color="purple">{v}</Tag> },
    { title: '难度', dataIndex: 'difficulty', width: 80, render: v => <Tag color={v <= 2 ? 'green' : v <= 4 ? 'orange' : 'red'}>{v}</Tag> },
    { title: '题干', dataIndex: 'stem', ellipsis: true },
    { title: '答案', dataIndex: 'answer', width: 60 },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={3} style={{ margin: 0 }}>真题管理</Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={openAdd}>添加真题</Button>
      </div>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="真题以两种形态保存"
        description="①完整真题试卷：保存整卷原文（PDF 提取或网页爬取）；②分模块去重题库：AI 拆分后按模块归类写入题库，题干指纹相同的题目自动去重跳过。"

      />

      <Card bodyStyle={{ padding: 0 }}>
        <Table
          columns={columns}
          dataSource={papers}
          rowKey="id"
          loading={loading}
          size="small"
          pagination={{
            current: page, total, pageSize: 20,
            showTotal: t => `共 ${t} 套试卷`,
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
                      <p className="ant-upload-hint">仅支持文本型 PDF（扫描件无法提取文字）</p>
                    </Upload.Dragger>
                  </Form.Item>
                  <Button type="primary" block loading={submitting} onClick={submitUpload}>上传并保存试卷</Button>
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
                  <Button type="primary" block loading={submitting} onClick={submitCrawl}>抓取并保存试卷</Button>
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
        onCancel={() => setParseOpen(false)}
        width={900}
        footer={[
          <Button key="close" onClick={() => setParseOpen(false)}>关闭</Button>,
          <Button key="parse" type="primary" icon={<ThunderboltOutlined />} loading={parsing} onClick={runParse}>
            开始拆分
          </Button>,
          <Button
            key="save" type="primary" icon={<CheckCircleOutlined />} loading={saving}
            disabled={selected.length === 0}
            onClick={confirmSave}
          >
            确认入库 ({selected.length})
          </Button>,
        ]}
      >
        {parsing && (
          <div style={{ textAlign: 'center', padding: '32px 0' }}>
            <Spin size="large" />
            <Paragraph type="secondary" style={{ marginTop: 12 }}>AI 正在拆分整卷并归类模块，请稍候…</Paragraph>
          </div>
        )}

        {!parsing && parsedQuestions.length === 0 && (
          <Empty description="点击「开始拆分」，AI 会从整卷文本中提取题目" />
        )}

        {!parsing && parsedQuestions.length > 0 && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <Text>共拆分出 {parsedQuestions.length} 道题</Text>
              <Space>
                <Button size="small" onClick={() => setSelected(parsedQuestions.map((_, i) => i))}>全选</Button>
                <Button size="small" onClick={() => setSelected([])}>取消</Button>
              </Space>
            </div>
            <Table
              columns={questionColumns}
              dataSource={parsedQuestions.map((q, i) => ({ ...q, key: i }))}
              size="small"
              pagination={{ pageSize: 8 }}
              scroll={{ y: 320 }}
            />
            {saveResult && (
              <Alert
                style={{ marginTop: 12 }}
                type="success"
                showIcon
                message={`入库 ${saveResult.inserted} 题${saveResult.duplicated > 0 ? `，去重跳过 ${saveResult.duplicated} 题` : ''}`}
                description={
                  Object.keys(saveResult.byModule || {}).length > 0 && (
                    <Space size={[6, 4]} wrap>
                      {Object.entries(saveResult.byModule).map(([m, c]) => (
                        <Tag key={m} color="blue">{m}：{c} 题</Tag>
                      ))}
                    </Space>
                  )
                }
              />
            )}
          </div>
        )}
      </Modal>

      {/* 详情 */}
      <Modal title="试卷详情" open={detailOpen} onCancel={() => setDetailOpen(false)} footer={null} width={720}>
        {detail && (
          <div>
            <Descriptions bordered size="small" column={2} style={{ marginBottom: 16 }}>
              <Descriptions.Item label="标题">{detail.paper.title}</Descriptions.Item>
              <Descriptions.Item label="年份">{detail.paper.year || '-'}</Descriptions.Item>
              <Descriptions.Item label="获取方式">{ORIGIN_TAG[detail.paper.origin]?.text || detail.paper.origin}</Descriptions.Item>
              <Descriptions.Item label="来源">{detail.paper.source || detail.paper.file_name || '-'}</Descriptions.Item>
              <Descriptions.Item label="已入库题目">{detail.paper.question_count} 题</Descriptions.Item>
              <Descriptions.Item label="状态">{STATUS_TAG[detail.paper.status]?.text || detail.paper.status}</Descriptions.Item>
            </Descriptions>

            <Divider style={{ margin: '12px 0' }} />

            <Text strong>整卷文本（完整真题试卷形态）</Text>
            <div style={{
              marginTop: 8, maxHeight: 240, overflow: 'auto', padding: 12,
              background: '#fafafa', borderRadius: 8, whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.7,
            }}>
              {(detail.paper.raw_text || '').slice(0, 3000) || '（无文本）'}
            </div>

            <Divider style={{ margin: '12px 0' }} />

            <Text strong>已入库题目（分模块去重题库）</Text>
            <div style={{ marginTop: 8 }}>
              {detail.questions.length === 0 ? (
                <Empty description="尚未入库题目" />
              ) : (
                <Space direction="vertical" size={6} style={{ width: '100%' }}>
                  {detail.questions.map(q => (
                    <div key={q.id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <Tag>{q.subject_name || '未分类'}</Tag>
                      <Tag color="purple">{q.qtype}</Tag>
                      <Tag color={q.difficulty <= 2 ? 'green' : q.difficulty <= 4 ? 'orange' : 'red'}>难度 {q.difficulty}</Tag>
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
