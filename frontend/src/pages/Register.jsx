import React from 'react';
import { Card, Form, Input, Button, Typography, message, Space } from 'antd';
import { MailOutlined, LockOutlined, UserOutlined } from '@ant-design/icons';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export default function Register() {
  const navigate = useNavigate();
  const { register, loading } = useAuth();
  const [form] = Form.useForm();

  async function onFinish(values) {
    try {
      await register(values.email, values.password, values.nickname);
      message.success('注册成功');
      navigate('/dashboard');
    } catch (err) {
      const msg = err.response?.data?.error || '注册失败';
      message.error(msg);
    }
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}>
      <Card style={{ width: 400 }} title="注册">
        <Form form={form} layout="vertical" onFinish={onFinish} autoComplete="off">
          <Form.Item name="nickname" rules={[{ required: true, message: '请输入昵称' }]}>
            <Input prefix={<UserOutlined />} placeholder="昵称" size="large" />
          </Form.Item>
          <Form.Item name="email" rules={[{ required: true, message: '请输入邮箱' }, { type: 'email', message: '邮箱格式不正确' }]}>
            <Input prefix={<MailOutlined />} placeholder="邮箱" size="large" />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }, { min: 6, message: '密码至少6位' }]}>
            <Input.Password prefix={<LockOutlined />} placeholder="密码（至少6位）" size="large" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={loading} block size="large">注册</Button>
          </Form.Item>
        </Form>
        <Space style={{ width: '100%', justifyContent: 'center' }}>
          <Typography.Text type="secondary">已有账号？</Typography.Text>
          <Link to="/login">去登录</Link>
        </Space>
      </Card>
    </div>
  );
}