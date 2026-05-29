import React, { useState, useEffect } from 'react';
import { Typography, Button, Select, Modal, message, Checkbox, Divider, Space, Tag, Input, Popconfirm, Form, Radio } from 'antd';
import { EditOutlined, DeleteOutlined, CheckOutlined, CloseOutlined } from '@ant-design/icons';
import api from '../../services/api';
import { parseOptions } from '../../utils';
import Pagination from '../../components/Pagination';

const { Title, Text } = Typography;
const { TextArea } = Input;

const STATUS_OPTIONS = [
  { value: 'pending_review', label: '待审核', color: 'orange' },
  { value: 'approved', label: '已通过', color: 'green' },
  { value: 'disabled', label: '已禁用', color: 'red' },
];

const QTYPE_OPTIONS = ['意图判断', '主旨概括', '细节理解', '标题填入', '下文推断'];

export default function Questions() {
  const [questions, setQuestions] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState(null);
  const [qtypeFilter, setQtypeFilter] = useState(null);
  const [keyword, setKeyword] = useState('');
  const [keywordInput, setKeywordInput] = useState('');
  const [selectedIds, setSelectedIds] = useState([]);
  const [sortField, setSortField] = useState('id');
  const [sortOrder, setSortOrder] = useState('desc');
  const [previewQuestion, setPreviewQuestion] = useState(null);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingQuestion, setEditingQuestion] = useState(null);
  const [editForm] = Form.useForm();
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [addForm] = Form.useForm();

  useEffect(() => { loadQuestions(); }, [page, statusFilter, qtypeFilter, keyword, sortField, sortOrder]);

  async function loadQuestions() {
    setLoading(true);
    try {
      const params = { page, pageSize: 15, sortField, sortOrder };
      if (statusFilter) params.status = statusFilter;
      if (qtypeFilter) params.qtype = qtypeFilter;
      if (keyword) params.keyword = keyword;
      const r = await api.get('/questions', { params });
      setQuestions(r.data.questions);
      setTotal(r.data.total);
    } catch (err) {
      message.error('加载失败');
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(id) {
    try {
      await api.delete('/questions/' + id);
      message.success('删除成功');
      loadQuestions();
    } catch (err) {
      message.error('删除失败');
    }
  }

  async function handleStatusChange(id, status) {
    try {
      await api.put('/questions/' + id, { status });
      message.success('状态更新成功');
      setPreviewQuestion(null);
      loadQuestions();
    } catch (err) {
      message.error('更新失败');
    }
  }

  async function handleBatchStatus(status) {
    if (selectedIds.length === 0) {
      message.warning('请先选择题目');
      return;
    }
    try {
      await api.post('/questions/batch-update-status', { ids: selectedIds, status });
      message.success('成功更新 ' + selectedIds.length + ' 道题目');
      setSelectedIds([]);
      loadQuestions();
    } catch (err) {
      message.error('批量更新失败');
    }
  }

  async function handleBatchDelete() {
    if (selectedIds.length === 0) {
      message.warning('请先选择题目');
      return;
    }
    try {
      await api.post('/questions/batch-delete', { ids: selectedIds });
      message.success('成功删除 ' + selectedIds.length + ' 道题目');
      setSelectedIds([]);
      loadQuestions();
    } catch (err) {
      message.error('批量删除失败');
    }
  }

  function openEditModal(question) {
    setEditingQuestion(question);
    editForm.setFieldsValue({
      qtype: question.qtype,
      difficulty: question.difficulty,
      stem: question.stem,
      options: parseOptions(question.options_json),
      answer: question.answer,
      explanation: question.explanation,
    });
    setEditModalOpen(true);
  }

  async function handleEditSave() {
    try {
      const values = await editForm.validateFields();
      await api.put('/questions/' + editingQuestion.id, values);
      message.success('保存成功');
      setEditModalOpen(false);
      loadQuestions();
    } catch (err) {
      if (err.errorFields) return;
      message.error('保存失败');
    }
  }

  async function handleAdd() {
    try {
      const values = await addForm.validateFields();
      values.options = values.options.filter(o => o && o.trim());
      if (values.options.length < 4) { message.error('请填写4个选项'); return; }
      values.status = 'pending_review';
      await api.post('/questions', values);
      message.success('题目已添加');
      setAddModalOpen(false);
      addForm.resetFields();
      loadQuestions();
    } catch (err) {
      if (err.errorFields) return;
      message.error(err.response?.data?.error || '添加失败');
    }
  }

  function getDifficultyTag(d) {
    if (d <= 2) return <Tag color="green">简单</Tag>;
    if (d <= 4) return <Tag color="orange">中等</Tag>;
    return <Tag color="red">困难</Tag>;
  }

  function getStatusTag(status) {
    var opt = STATUS_OPTIONS.find(function(o) { return o.value === status; });
    return <Tag color={opt ? opt.color : undefined}>{opt ? opt.label : status}</Tag>;
  }

  return (
    <div>
      <Title level={3} style={{ marginBottom: 16 }}>题目管理</Title>
      
      <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <Space>
          <Select allowClear placeholder="全部状态" style={{ width: 120 }} value={statusFilter}
            onChange={function(v) { setStatusFilter(v); setPage(1); }}
            options={STATUS_OPTIONS} />
          <Select allowClear placeholder="全部题型" style={{ width: 120 }} value={qtypeFilter}
            onChange={function(v) { setQtypeFilter(v); setPage(1); }}
            options={QTYPE_OPTIONS.map(function(t) { return { label: t, value: t }; })} />
          <Input.Search
            placeholder="搜索题干/片段/解析"
            allowClear
            style={{ width: 220 }}
            value={keywordInput}
            onChange={e => setKeywordInput(e.target.value)}
            onSearch={v => { setKeyword(v); setPage(1); }}
          />
          <Button type="primary" onClick={() => setAddModalOpen(true)}>新增题目</Button>
          {selectedIds.length > 0 && (
            <>
              <Divider type="vertical" />
              <Text type="secondary">已选 {selectedIds.length} 道</Text>
              <Button size="small" onClick={function() { handleBatchStatus('approved'); }}>批量通过</Button>
              <Button size="small" onClick={function() { handleBatchStatus('disabled'); }}>批量禁用</Button>
              <Popconfirm title={'确定删除选中的 ' + selectedIds.length + ' 道题目？此操作不可恢复。'} onConfirm={handleBatchDelete} okText="删除" cancelText="取消" okButtonProps={{ danger: true }}>
                <Button size="small" danger>批量删除</Button>
              </Popconfirm>
            </>
          )}
        </Space>
        <Text type="secondary">共 {total} 道题目</Text>
      </div>

      <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#fafafa' }}>
              <th style={{ width: 40, padding: '12px 8px', textAlign: 'center' }}>
                <Checkbox
                  checked={selectedIds.length === questions.length && questions.length > 0}
                  indeterminate={selectedIds.length > 0 && selectedIds.length < questions.length}
                  onChange={function(e) { setSelectedIds(e.target.checked ? questions.map(function(q) { return q.id; }) : []); }}
                />
              </th>
              <th style={{ width: 60, padding: '12px 8px' }}>ID</th>
              <th style={{ width: 90, padding: '12px 8px', cursor: 'pointer', userSelect: 'none' }} onClick={() => { setSortField('qtype'); setSortOrder(prev => sortField === 'qtype' && prev === 'desc' ? 'asc' : 'desc'); setPage(1); }}>
                题型 {sortField === 'qtype' && (sortOrder === 'desc' ? '↓' : '↑')}
              </th>
              <th style={{ width: 70, padding: '12px 8px', cursor: 'pointer', userSelect: 'none' }} onClick={() => { setSortField('difficulty'); setSortOrder(prev => sortField === 'difficulty' && prev === 'desc' ? 'asc' : 'desc'); setPage(1); }}>
                难度 {sortField === 'difficulty' && (sortOrder === 'desc' ? '↓' : '↑')}
              </th>
              <th style={{ padding: '12px 8px' }}>片段</th>
              <th style={{ padding: '12px 8px' }}>题干</th>
              <th style={{ width: 50, padding: '12px 8px' }}>答案</th>
              <th style={{ width: 80, padding: '12px 8px', cursor: 'pointer', userSelect: 'none' }} onClick={() => { setSortField('status'); setSortOrder(prev => sortField === 'status' && prev === 'desc' ? 'asc' : 'desc'); setPage(1); }}>
                状态 {sortField === 'status' && (sortOrder === 'desc' ? '↓' : '↑')}
              </th>
              <th style={{ width: 140, padding: '12px 8px', cursor: 'pointer', userSelect: 'none' }} onClick={() => { setSortField('created_at'); setSortOrder(prev => sortField === 'created_at' && prev === 'desc' ? 'asc' : 'desc'); setPage(1); }}>
                创建时间 {sortField === 'created_at' && (sortOrder === 'desc' ? '↓' : '↑')}
              </th>
              <th style={{ width: 160, padding: '12px 8px' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={10} style={{ padding: 40, textAlign: 'center' }}>加载中...</td></tr>
            ) : questions.length === 0 ? (
              <tr><td colSpan={10} style={{ padding: 40, textAlign: 'center' }}>暂无数据</td></tr>
            ) : (
              questions.map(function(q, idx) {
                return (
                  <tr key={q.id} style={{ background: idx % 2 === 0 ? '#fff' : '#fafafa' }}>
                    <td style={{ padding: '10px 8px', textAlign: 'center' }}>
                      <Checkbox
                        checked={selectedIds.includes(q.id)}
                        onChange={function(e) {
                          setSelectedIds(function(prev) {
                            return e.target.checked ? prev.concat([q.id]) : prev.filter(function(id) { return id !== q.id; });
                          });
                        }}
                      />
                    </td>
                    <td style={{ padding: '10px 8px' }}>{q.id}</td>
                    <td style={{ padding: '10px 8px' }}><Tag color="purple">{q.qtype}</Tag></td>
                    <td style={{ padding: '10px 8px' }}>{getDifficultyTag(q.difficulty)}</td>
                    <td style={{ padding: '10px 8px', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q.passage || '-'}</td>
                    <td style={{ padding: '10px 8px', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q.stem}</td>
                    <td style={{ padding: '10px 8px' }}><Text strong>{q.answer}</Text></td>
                    <td style={{ padding: '10px 8px' }}>{getStatusTag(q.status)}</td>
                    <td style={{ padding: '10px 8px', fontSize: 12 }}>{q.created_at ? new Date(q.created_at).toLocaleString('zh-CN') : '-'}</td>
                    <td style={{ padding: '10px 8px' }}>
                      <Space size="small">
                        <Button size="small" icon={<EditOutlined />} onClick={function() { setPreviewQuestion(q); }} />
                        {q.status === 'disabled' && (
                          <Button size="small" type="primary" onClick={function() { handleStatusChange(q.id, 'approved'); }}>启用</Button>
                        )}
                        {q.status === 'approved' && (
                          <Button size="small" icon={<CloseOutlined />} onClick={function() { handleStatusChange(q.id, 'disabled'); }} />
                        )}
                        <Popconfirm title="确定删除？" onConfirm={function() { handleDelete(q.id); }}>
                          <Button size="small" danger icon={<DeleteOutlined />} />
                        </Popconfirm>
                      </Space>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <Pagination current={page} total={total} pageSize={15} onChange={setPage} />

      {previewQuestion && (
        <Modal
          title="题目审核"
          open={true}
          onCancel={function() { setPreviewQuestion(null); }}
          width={650}
          footer={[
            <Button key="close" onClick={function() { setPreviewQuestion(null); }}>关闭</Button>,
            <Button key="reject" danger icon={<CloseOutlined />} onClick={function() { handleStatusChange(previewQuestion.id, 'disabled'); }}>不通过</Button>,
            <Button key="approve" type="primary" icon={<CheckOutlined />} onClick={function() { handleStatusChange(previewQuestion.id, 'approved'); }}>通过</Button>
          ]}
        >
          <div>
            <Space style={{ marginBottom: 16 }}>
              <Tag color="purple">{previewQuestion.qtype}</Tag>
              {getDifficultyTag(previewQuestion.difficulty)}
              {getStatusTag(previewQuestion.status)}
            </Space>
            {previewQuestion.article_title && (
              <div style={{ marginBottom: 12 }}>
                <Text type="secondary">来源文章：</Text>
                <Text>{previewQuestion.article_title}</Text>
              </div>
            )}
            <div style={{ marginBottom: 16, padding: 16, background: '#f5f5f5', borderRadius: 8 }}>
              <Text strong style={{ display: 'block', marginBottom: 8 }}>题干：</Text>
              <Text>{previewQuestion.stem}</Text>
            </div>
            <div style={{ marginBottom: 16 }}>
              <Text strong style={{ display: 'block', marginBottom: 8 }}>选项：</Text>
              {parseOptions(previewQuestion.options_json).map(function(opt, i) {
                var isCorrect = String.fromCharCode(65 + i) === previewQuestion.answer;
                return (
                  <div key={i} style={{ padding: '6px 12px', marginBottom: 4, borderRadius: 4, background: isCorrect ? '#f6ffed' : '#fff', border: isCorrect ? '1px solid #b7eb8f' : '1px solid #f0f0f0' }}>
                    <Text type={isCorrect ? 'success' : undefined}>
                      <Text strong>{String.fromCharCode(65 + i)}.</Text> {opt}
                      {isCorrect && ' ✓ 正确答案'}
                    </Text>
                  </div>
                );
              })}
            </div>
            <div style={{ padding: 12, background: '#e6f7ff', borderRadius: 8 }}>
              <Text strong style={{ display: 'block', marginBottom: 4 }}>解析：</Text>
              <Text>{previewQuestion.explanation}</Text>
            </div>
          </div>
        </Modal>
      )}

      {editModalOpen && (
        <Modal
          title="编辑题目"
          open={true}
          onCancel={function() { setEditModalOpen(false); }}
          onOk={handleEditSave}
          width={700}
        >
          <Form form={editForm} layout="vertical">
            <Form.Item name="qtype" label="题型">
              <Select options={QTYPE_OPTIONS.map(function(t) { return { label: t, value: t }; })} />
            </Form.Item>
            <Form.Item name="difficulty" label="难度">
              <Radio.Group>
                <Radio.Button value={1}>简单</Radio.Button>
                <Radio.Button value={3}>中等</Radio.Button>
                <Radio.Button value={5}>困难</Radio.Button>
              </Radio.Group>
            </Form.Item>
            <Form.Item name="stem" label="题干" rules={[{ required: true }]}>
              <TextArea rows={3} />
            </Form.Item>
            <Form.Item label="选项">
              <Form.List name="options">
                {function(fields) {
                  return fields.map(function(field, index) {
                    return (
                      <Form.Item key={field.key} required={false}>
                        <Space>
                          <Text strong>{String.fromCharCode(65 + index)}.</Text>
                          <Form.Item {...field} noStyle>
                            <Input style={{ width: 400 }} />
                          </Form.Item>
                        </Space>
                      </Form.Item>
                    );
                  });
                }}
              </Form.List>
            </Form.Item>
            <Form.Item name="answer" label="正确答案" rules={[{ required: true }]}>
              <Select options={['A', 'B', 'C', 'D'].map(function(v) { return { label: v, value: v }; })} />
            </Form.Item>
            <Form.Item name="explanation" label="解析" rules={[{ required: true }]}>
              <TextArea rows={4} />
            </Form.Item>
          </Form>
        </Modal>
      )}

      {addModalOpen && (
        <Modal title="新增题目" open={true} onCancel={() => setAddModalOpen(false)} onOk={handleAdd} width={700}>
          <Form form={addForm} layout="vertical">
            <Form.Item name="qtype" label="题型" initialValue="意图判断">
              <Select options={['意图判断', '主旨概括', '细节理解', '标题填入', '下文推断'].map(t => ({ label: t, value: t }))} />
            </Form.Item>
            <Form.Item name="difficulty" label="难度" initialValue={3}>
              <Radio.Group>
                <Radio.Button value={1}>简单</Radio.Button>
                <Radio.Button value={3}>中等</Radio.Button>
                <Radio.Button value={5}>困难</Radio.Button>
              </Radio.Group>
            </Form.Item>
            <Form.Item name="passage" label="片段">
              <TextArea rows={3} placeholder="从文章摘取的片段原文（50-150字）" />
            </Form.Item>
            <Form.Item name="stem" label="题干" rules={[{ required: true }]}>
              <TextArea rows={2} placeholder="例如：这段文字意在说明：" />
            </Form.Item>
            <Form.Item label="选项（A/B/C/D）" required>
              <Form.List name="options" initialValue={['', '', '', '']}>
                {fields => fields.map((field, index) => (
                  <Form.Item key={field.key} required={false}>
                    <Space>
                      <Text strong>{String.fromCharCode(65 + index)}.</Text>
                      <Form.Item {...field} noStyle><Input style={{ width: 400 }} /></Form.Item>
                    </Space>
                  </Form.Item>
                ))}
              </Form.List>
            </Form.Item>
            <Form.Item name="answer" label="正确答案" rules={[{ required: true }]}>
              <Select options={['A', 'B', 'C', 'D'].map(v => ({ label: v, value: v }))} />
            </Form.Item>
            <Form.Item name="explanation" label="解析" rules={[{ required: true }]}>
              <TextArea rows={3} />
            </Form.Item>
          </Form>
        </Modal>
      )}
    </div>
  );
}