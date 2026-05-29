import React from 'react';
import { Card, Form, Input, Button, Typography, message, Space } from 'antd';
import { MailOutlined, LockOutlined } from '@ant-design/icons';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export default function Login() {
  const navigate = useNavigate();
  const { login, loading } = useAuth();
  const [form] = Form.useForm();

  async function onFinish(values) {
    try {
      await login(values.email, values.password);
      message.success('登录成功');
      navigate('/dashboard');
    } catch (err) {
      const msg = err.response?.data?.error || '登录失败';
      message.error(msg);
    }
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}>
      <Card style={{ width: 400 }} title="登录">
        <Form form={form} layout="vertical" onFinish={onFinish} autoComplete="off">
          <Form.Item name="email" rules={[{ required: true, message: '请输入邮箱' }, { type: 'email', message: '邮箱格式不正确' }]}>
            <Input prefix={<MailOutlined />} placeholder="邮箱" size="large" />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password prefix={<LockOutlined />} placeholder="密码" size="large" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={loading} block size="large">登录</Button>
          </Form.Item>
        </Form>
        <Space style={{ width: '100%', justifyContent: 'center' }}>
          <Typography.Text type="secondary">还没有账号？</Typography.Text>
          <Link to="/register">立即注册</Link>
        </Space>
      </Card>
    </div>
  );
}