import React, { useState, useEffect } from 'react';
import { Typography, Button, Select, message, Space, Tag, Popconfirm, Modal, Form } from 'antd';
import { DeleteOutlined, EditOutlined, UserOutlined } from '@ant-design/icons';
import api from '../../services/api';

const { Title, Text } = Typography;

const ROLE_OPTIONS = [
  { value: 'user', label: '普通用户' },
  { value: 'admin', label: '管理员' },
];

export default function Users() {
  const [users, setUsers] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [editUser, setEditUser] = useState(null);
  const [editForm] = Form.useForm();

  useEffect(() => { loadUsers(); }, [page]);

  async function loadUsers() {
    setLoading(true);
    try {
      const r = await api.get('/admin/users', { params: { page, pageSize: 15 } });
      setUsers(r.data.users);
      setTotal(r.data.total);
    } catch (err) { message.error('加载失败'); }
    finally { setLoading(false); }
  }

  async function handleUpdate(id, data) {
    try {
      await api.put('/admin/users/' + id, data);
      message.success('更新成功');
      loadUsers();
    } catch (err) { message.error('更新失败'); }
  }

  async function handleDelete(id) {
    try {
      await api.delete('/admin/users/' + id);
      message.success('删除成功');
      loadUsers();
    } catch (err) { message.error(err.response?.data?.error || '删除失败'); }
  }

  function openEdit(user) {
    setEditUser(user);
    editForm.setFieldsValue({ role: user.role, status: user.status });
  }

  async function handleEditSave() {
    try {
      const values = await editForm.validateFields();
      await handleUpdate(editUser.id, values);
      setEditUser(null);
    } catch (err) { if (err.errorFields) return; }
  }

  return (
    <div>
      <Title level={3} style={{ marginBottom: 16 }}>用户管理</Title>
      <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#fafafa' }}>
              <th style={{ padding: '12px 16px', textAlign: 'left' }}>ID</th>
              <th style={{ padding: '12px 16px', textAlign: 'left' }}>昵称</th>
              <th style={{ padding: '12px 16px', textAlign: 'left' }}>邮箱</th>
              <th style={{ padding: '12px 16px', textAlign: 'left' }}>角色</th>
              <th style={{ padding: '12px 16px', textAlign: 'left' }}>状态</th>
              <th style={{ padding: '12px 16px', textAlign: 'center' }}>练习次数</th>
              <th style={{ padding: '12px 16px', textAlign: 'center' }}>平均分</th>
              <th style={{ padding: '12px 16px', textAlign: 'left' }}>注册时间</th>
              <th style={{ padding: '12px 16px', textAlign: 'center' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={9} style={{ padding: 40, textAlign: 'center' }}>加载中...</td></tr>
            ) : users.length === 0 ? (
              <tr><td colSpan={9} style={{ padding: 40, textAlign: 'center' }}>暂无数据</td></tr>
            ) : users.map((u, idx) => (
              <tr key={u.id} style={{ background: idx % 2 === 0 ? '#fff' : '#fafafa' }}>
                <td style={{ padding: '10px 16px' }}>{u.id}</td>
                <td style={{ padding: '10px 16px' }}><UserOutlined style={{ marginRight: 4 }} />{u.nickname}</td>
                <td style={{ padding: '10px 16px' }}>{u.email}</td>
                <td style={{ padding: '10px 16px' }}><Tag color={u.role === 'admin' ? 'red' : 'blue'}>{u.role === 'admin' ? '管理员' : '用户'}</Tag></td>
                <td style={{ padding: '10px 16px' }}><Tag color={u.status === 'active' ? 'green' : 'red'}>{u.status === 'active' ? '正常' : '禁用'}</Tag></td>
                <td style={{ padding: '10px 16px', textAlign: 'center' }}>{u.practice_count || 0}</td>
                <td style={{ padding: '10px 16px', textAlign: 'center' }}>{u.avg_score || '-'}</td>
                <td style={{ padding: '10px 16px' }}>{new Date(u.created_at).toLocaleDateString('zh-CN')}</td>
                <td style={{ padding: '10px 16px', textAlign: 'center' }}>
                  <Space size="small">
                    <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(u)} />
                    {u.status === 'active' ? (
                      <Button size="small" onClick={() => handleUpdate(u.id, { status: 'disabled' })}>禁用</Button>
                    ) : (
                      <Button size="small" type="primary" onClick={() => handleUpdate(u.id, { status: 'active' })}>启用</Button>
                    )}
                    <Popconfirm title="确定删除？该用户的练习记录也会被清除。" onConfirm={() => handleDelete(u.id)}>
                      <Button size="small" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  </Space>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {total > 15 && (
        <div style={{ marginTop: 12, textAlign: 'right' }}>
          <Space>
            <Button size="small" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</Button>
            <Text type="secondary">第 {page} 页 / 共 {Math.ceil(total / 15)} 页</Text>
            <Button size="small" disabled={page * 15 >= total} onClick={() => setPage(page + 1)}>下一页</Button>
          </Space>
        </div>
      )}

      {editUser && (
        <Modal title="编辑用户（仅限修改角色和状态）" open={true} onCancel={() => setEditUser(null)} onOk={handleEditSave} width={400}>
          <div style={{ marginBottom: 16, padding: 12, background: '#f5f5f5', borderRadius: 8 }}>
            <Text type="secondary">用户：{editUser.nickname}（{editUser.email}）</Text>
          </div>
          <Form form={editForm} layout="vertical">
            <Form.Item name="role" label="角色">
              <Select options={ROLE_OPTIONS} />
            </Form.Item>
            <Form.Item name="status" label="状态">
              <Select options={[{ value: 'active', label: '正常' }, { value: 'disabled', label: '禁用' }]} />
            </Form.Item>
          </Form>
        </Modal>
      )}
    </div>
  );
}
