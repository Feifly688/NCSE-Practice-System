import React, { useState, useEffect } from 'react';
import { Typography, Card, Form, Input, Button, Space, message, Descriptions, Modal } from 'antd';
import { UserOutlined, MailOutlined, LockOutlined, SaveOutlined, EditOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import api from '../services/api';
import { getTokenExpiry, describeRemaining } from '../services/session';
import { useResponsive } from '../hooks/useResponsive';

const { Title } = Typography;

export default function Profile() {
  const navigate = useNavigate();
  const { user, setUser, logout } = useAuth();
  const { isMobile } = useResponsive();
  // 从 JWT 的 exp 字段解析登录失效时间，让会话时长对用户透明
  const [sessionExpiry, setSessionExpiry] = useState('-');
  useEffect(() => {
    const expiryAt = getTokenExpiry(localStorage.getItem('token'));
    if (!expiryAt) {
      setSessionExpiry('-');
      return;
    }
    const d = new Date(expiryAt);
    setSessionExpiry(`${d.toLocaleString('zh-CN')}（${describeRemaining(expiryAt)}）`);
  }, [user]);
  const [profileForm] = Form.useForm();
  const [passwordForm] = Form.useForm();
  const [usernameForm] = Form.useForm();
  const [profileLoading, setProfileLoading] = useState(false);
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [usernameModalOpen, setUsernameModalOpen] = useState(false);
  const [usernameLoading, setUsernameLoading] = useState(false);

  useEffect(() => {
    if (user) {
      profileForm.setFieldsValue({ nickname: user.nickname, email: user.email });
      usernameForm.setFieldsValue({ username: user.username });
    }
  }, [user]);

  // 昵称和邮箱：直接保存，无需确认
  async function handleProfileSave() {
    try {
      setProfileLoading(true);
      const values = await profileForm.validateFields();
      await api.put('/auth/profile', values);
      const updated = { ...user, ...values };
      setUser(updated);
      localStorage.setItem('user', JSON.stringify(updated));
      message.success('个人信息已更新');
    } catch (err) {
      if (err.errorFields) return;
      message.error(err.response?.data?.error || '更新失败');
    } finally {
      setProfileLoading(false);
    }
  }

  // 用户名：单独接口，需二次确认
  async function handleUsernameSave() {
    try {
      const values = await usernameForm.validateFields();
      setUsernameLoading(true);
      const { data } = await api.put('/auth/username', values);
      const updated = { ...user, username: data.username };
      setUser(updated);
      localStorage.setItem('user', JSON.stringify(updated));
      message.success('用户名已修改，下次请使用新用户名登录');
      setUsernameModalOpen(false);
    } catch (err) {
      if (err.errorFields) return;
      message.error(err.response?.data?.error || '修改失败');
    } finally {
      setUsernameLoading(false);
    }
  }

  async function handlePasswordSave() {
    try {
      setPasswordLoading(true);
      const values = await passwordForm.validateFields();
      await api.put('/auth/password', { oldPassword: values.oldPassword, newPassword: values.newPassword });
      message.success('密码已修改，请重新登录');
      passwordForm.resetFields();
      logout();
      // 回首页即可，未登录时首页会直接展示登录卡片
      navigate('/');
    } catch (err) {
      if (err.errorFields) return;
      message.error(err.response?.data?.error || '修改失败');
    } finally {
      setPasswordLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 600, margin: '0 auto', padding: '0 4px' }}>
      <Title level={3} style={{ fontSize: isMobile ? 20 : undefined }}>个人信息</Title>

      <Card
        title="账号信息"
        style={{ marginBottom: 24 }}
        extra={
          <Button size="small" icon={<EditOutlined />} onClick={() => { usernameForm.setFieldsValue({ username: user?.username }); setUsernameModalOpen(true); }}>
            修改用户名
          </Button>
        }
      >
        <Descriptions column={1}>
          <Descriptions.Item label="用户名">{user?.username || '-'}</Descriptions.Item>
          <Descriptions.Item label="邮箱">{user?.email || '-'}</Descriptions.Item>
          <Descriptions.Item label="角色">{user?.role === 'admin' ? '管理员' : '普通用户'}</Descriptions.Item>
          <Descriptions.Item label="注册时间">{user?.created_at ? new Date(user.created_at).toLocaleString('zh-CN') : '-'}</Descriptions.Item>
          <Descriptions.Item label="登录有效期至">{sessionExpiry}</Descriptions.Item>
        </Descriptions>
      </Card>

      <Card title="修改资料" style={{ marginBottom: 24 }} extra={<span style={{ fontSize: 12, color: '#999' }}>昵称和邮箱保存后立即生效</span>}>
        <Form form={profileForm} layout="vertical">
          <Form.Item name="nickname" label="昵称" rules={[{ required: true, message: '请输入昵称' }]}>
            <Input prefix={<UserOutlined />} placeholder="请输入昵称" />
          </Form.Item>
          <Form.Item name="email" label="邮箱" rules={[{ type: 'email', message: '请输入有效邮箱' }, { max: 100, message: '邮箱不能超过100个字符' }]}>
            <Input prefix={<MailOutlined />} placeholder="请输入邮箱" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" icon={<SaveOutlined />} loading={profileLoading} onClick={handleProfileSave}>
              保存修改
            </Button>
          </Form.Item>
        </Form>
      </Card>

      <Modal
        title="修改用户名"
        open={usernameModalOpen}
        onOk={handleUsernameSave}
        onCancel={() => setUsernameModalOpen(false)}
        confirmLoading={usernameLoading}
        okText="确认修改"
        cancelText="取消"
      >
        <div style={{ marginBottom: 16, padding: 12, background: '#fffbe6', border: '1px solid #ffe58f', borderRadius: 8 }}>
          <Typography.Paragraph type="secondary" style={{ margin: 0, fontSize: 12 }}>
            用户名是你的登录账号，修改后需使用新用户名登录。<br />
            用户名全网唯一，不可与他人重复。
          </Typography.Paragraph>
        </div>
        <Form form={usernameForm} layout="vertical">
          <Form.Item
            name="username"
            label="新用户名"
            rules={[
              { required: true, message: '请输入新用户名' },
              { min: 2, max: 64, message: '用户名长度需为2-64个字符' },
              { pattern: /^[a-zA-Z0-9_\u4e00-\u9fa5-]+$/, message: '只能包含字母、数字、下划线、连字符和中文' }
            ]}
          >
            <Input prefix={<UserOutlined />} placeholder="请输入新用户名" />
          </Form.Item>
        </Form>
      </Modal>

      <Card title="修改密码">
        <Form form={passwordForm} layout="vertical">
          <Form.Item name="oldPassword" label="旧密码" rules={[{ required: true, message: '请输入旧密码' }]}>
            <Input.Password prefix={<LockOutlined />} placeholder="请输入旧密码" />
          </Form.Item>
          <Form.Item name="newPassword" label="新密码" rules={[{ required: true, min: 6, message: '新密码至少6位' }]}>
            <Input.Password prefix={<LockOutlined />} placeholder="请输入新密码" />
          </Form.Item>
          <Form.Item name="confirm" label="确认新密码" dependencies={['newPassword']}
            rules={[{ required: true, message: '请确认新密码' }, ({ getFieldValue }) => ({
              validator(_, value) { if (!value || getFieldValue('newPassword') === value) return Promise.resolve(); return Promise.reject(new Error('两次密码不一致')); }
            })]}>
            <Input.Password prefix={<LockOutlined />} placeholder="请再次输入新密码" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" icon={<SaveOutlined />} loading={passwordLoading} onClick={handlePasswordSave}>
              修改密码
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  );
}
