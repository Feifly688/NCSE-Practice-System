import React, { useState, useEffect } from 'react';
import { Typography, Card, Form, Input, Button, Space, message, Descriptions } from 'antd';
import { UserOutlined, MailOutlined, LockOutlined, SaveOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import api from '../services/api';

const { Title } = Typography;

export default function Profile() {
  const navigate = useNavigate();
  const { user, setUser, logout } = useAuth();
  const [profileForm] = Form.useForm();
  const [passwordForm] = Form.useForm();
  const [profileLoading, setProfileLoading] = useState(false);
  const [passwordLoading, setPasswordLoading] = useState(false);

  useEffect(() => {
    if (user) {
      profileForm.setFieldsValue({ nickname: user.nickname, email: user.email });
    }
  }, [user]);

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

  async function handlePasswordSave() {
    try {
      setPasswordLoading(true);
      const values = await passwordForm.validateFields();
      await api.put('/auth/password', { oldPassword: values.oldPassword, newPassword: values.newPassword });
      message.success('密码已修改，请重新登录');
      passwordForm.resetFields();
      logout();
      navigate('/login');
    } catch (err) {
      if (err.errorFields) return;
      message.error(err.response?.data?.error || '修改失败');
    } finally {
      setPasswordLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 600, margin: '0 auto' }}>
      <Title level={3}>个人信息</Title>

      <Card title="账号信息" style={{ marginBottom: 24 }}>
        <Descriptions column={1}>
          <Descriptions.Item label="邮箱">{user?.email}</Descriptions.Item>
          <Descriptions.Item label="角色">{user?.role === 'admin' ? '管理员' : '普通用户'}</Descriptions.Item>
          <Descriptions.Item label="注册时间">{user?.created_at ? new Date(user.created_at).toLocaleString('zh-CN') : '-'}</Descriptions.Item>
        </Descriptions>
      </Card>

      <Card title="修改资料" style={{ marginBottom: 24 }}>
        <Form form={profileForm} layout="vertical">
          <Form.Item name="nickname" label="昵称" rules={[{ required: true, message: '请输入昵称' }]}>
            <Input prefix={<UserOutlined />} placeholder="请输入昵称" />
          </Form.Item>
          <Form.Item name="email" label="邮箱" rules={[{ required: true, type: 'email', message: '请输入有效邮箱' }]}>
            <Input prefix={<MailOutlined />} placeholder="请输入邮箱" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" icon={<SaveOutlined />} loading={profileLoading} onClick={handleProfileSave}>
              保存修改
            </Button>
          </Form.Item>
        </Form>
      </Card>

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
