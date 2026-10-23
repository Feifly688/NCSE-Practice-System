import React, { useState, useEffect } from 'react';
import { Modal, Tabs, Form, Input, Button, Typography, message, Space } from 'antd';
import { UserOutlined, LockOutlined, MailOutlined } from '@ant-design/icons';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import RememberMeField from './RememberMeField';

const { Text } = Typography;

// 深色毛玻璃弹窗：85% 不透明，保留背景朦胧可见
const PANEL_BG = 'rgba(18, 18, 26, 0.85)';

/**
 * 登录 / 注册弹窗，仅用于非首页入口（如顶部导航的登录按钮）。
 *
 * 首页已改为 hero 区内嵌卡片（HomeAuthCard），因此这里在 `/`
 * 路由下直接不渲染，避免遮罩盖住首页背景。
 */
export default function AuthModal() {
  const navigate = useNavigate();
  const location = useLocation();
  const { authModal, closeAuth, login, register, loading, sessionPolicy } = useAuth();
  const [tab, setTab] = useState('login');
  const [loginForm] = Form.useForm();
  const [registerForm] = Form.useForm();
  // 记住我：勾选 = 长有效期（默认 7 天）；不勾选 = 短有效期（默认 2 小时）
  const [remember, setRemember] = useState(true);

  const shortLabel = sessionPolicy?.short?.label || '2 小时';

  // 打开时同步到请求的标签页
  useEffect(() => {
    if (authModal) setTab(authModal);
  }, [authModal]);

  const open = authModal !== null && location.pathname !== '/';

  function handleClose() {
    closeAuth();
    // 关闭时清空密码等敏感输入，避免残留
    loginForm.resetFields(['password']);
    registerForm.resetFields(['password']);
  }

  async function handleLogin(values) {
    try {
      await login(values.account, values.password, remember);
      message.success(remember ? '登录成功' : `登录成功（${shortLabel}后需重新登录）`);
      loginForm.resetFields();
      closeAuth();
      navigate('/dashboard');
    } catch (err) {
      message.error(err.response?.data?.error || '登录失败');
    }
  }

  async function handleRegister(values) {
    try {
      await register(values, remember);
      message.success(remember ? '注册成功' : `注册成功（${shortLabel}后需重新登录）`);
      registerForm.resetFields();
      closeAuth();
      navigate('/dashboard');
    } catch (err) {
      message.error(err.response?.data?.error || '注册失败');
    }
  }

  const tabItems = [
    {
      key: 'login',
      label: '登录',
      children: (
        <Form form={loginForm} layout="vertical" onFinish={handleLogin} autoComplete="off" size="large">
          <Form.Item
            name="account"
            rules={[{ required: true, message: '请输入用户名或邮箱' }]}
            style={{ marginBottom: 18 }}
          >
            <Input aria-label="用户名或邮箱" prefix={<UserOutlined style={{ color: 'rgba(255,255,255,0.35)' }} />} placeholder="用户名或邮箱" style={{ borderRadius: 8 }} />
          </Form.Item>
          <Form.Item
            name="password"
            rules={[{ required: true, message: '请输入密码' }]}
            style={{ marginBottom: 22 }}
          >
            <Input.Password aria-label="密码" prefix={<LockOutlined style={{ color: 'rgba(255,255,255,0.35)' }} />} placeholder="密码" style={{ borderRadius: 8 }} />
          </Form.Item>
          <RememberMeField checked={remember} onChange={setRemember} style={{ marginBottom: 18 }} />
          <Button
            type="primary"
            htmlType="submit"
            loading={loading}
            block
            size="large"
            style={{ borderRadius: 8, height: 44, fontWeight: 600 }}
          >
            登录
          </Button>
        </Form>
      ),
    },
    {
      key: 'register',
      label: '注册',
      children: (
        <Form form={registerForm} layout="vertical" onFinish={handleRegister} autoComplete="off" size="large">
          <Form.Item
            name="nickname"
            rules={[{ required: true, message: '请输入昵称' }]}
            style={{ marginBottom: 16 }}
          >
            <Input aria-label="昵称" prefix={<UserOutlined style={{ color: 'rgba(255,255,255,0.35)' }} />} placeholder="昵称（显示名称，可随时修改）" style={{ borderRadius: 8 }} />
          </Form.Item>
          <Form.Item
            name="username"
            rules={[
              { required: true, message: '请输入用户名' },
              { min: 2, max: 64, message: '用户名长度需为2-64个字符' },
              { pattern: /^[a-zA-Z0-9_\u4e00-\u9fa5-]+$/, message: '只能包含字母、数字、下划线、连字符和中文' },
            ]}
            style={{ marginBottom: 16 }}
          >
            <Input aria-label="用户名" prefix={<UserOutlined style={{ color: 'rgba(255,255,255,0.35)' }} />} placeholder="用户名（登录账号，不可重复）" style={{ borderRadius: 8 }} />
          </Form.Item>
          <Form.Item
            name="email"
            rules={[
              { type: 'email', message: '邮箱格式不正确' },
              { max: 100, message: '邮箱不能超过100个字符' },
            ]}
            style={{ marginBottom: 16 }}
          >
            <Input aria-label="邮箱" prefix={<MailOutlined style={{ color: 'rgba(255,255,255,0.35)' }} />} placeholder="邮箱（选填，用于找回账号）" style={{ borderRadius: 8 }} />
          </Form.Item>
          <Form.Item
            name="password"
            rules={[{ required: true, message: '请输入密码' }, { min: 6, message: '密码至少6位' }]}
            style={{ marginBottom: 22 }}
          >
            <Input.Password aria-label="密码，至少 6 位" prefix={<LockOutlined style={{ color: 'rgba(255,255,255,0.35)' }} />} placeholder="密码（至少6位）" style={{ borderRadius: 8 }} />
          </Form.Item>
          <RememberMeField checked={remember} onChange={setRemember} style={{ marginBottom: 18 }} />
          <Button
            type="primary"
            htmlType="submit"
            loading={loading}
            block
            size="large"
            style={{ borderRadius: 8, height: 44, fontWeight: 600 }}
          >
            注册
          </Button>
        </Form>
      ),
    },
  ];

  return (
    <Modal
      className="auth-dark"
      open={open}
      onCancel={handleClose}
      footer={null}
      centered
      width={420}
      destroyOnClose
      maskClosable
      styles={{
        mask: { background: 'rgba(0, 0, 0, 0.55)', backdropFilter: 'blur(2px)' },
        content: {
          background: PANEL_BG,
          backdropFilter: 'blur(24px) saturate(140%)',
          WebkitBackdropFilter: 'blur(24px) saturate(140%)',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 16,
          boxShadow: '0 24px 64px -12px rgba(0,0,0,0.8)',
          padding: '8px 24px 26px',
        },
        body: { paddingTop: 4 },
      }}
    >
      <div style={{ textAlign: 'center', marginBottom: 8 }}>
        <div style={{ fontSize: 17, fontWeight: 700, color: '#fff', letterSpacing: '0.02em' }}>
          NCSE 刷题系统
        </div>
        <Text style={{ color: 'rgba(255,255,255,0.45)', fontSize: 13 }}>
          {tab === 'login' ? '欢迎回来，请登录你的账号' : '创建账号，开始练习'}
        </Text>
      </div>

      <Tabs
        activeKey={tab}
        onChange={setTab}
        centered
        items={tabItems}
        // 深色主题下的标签样式
        tabBarStyle={{ borderBottom: '1px solid rgba(255,255,255,0.1)', marginBottom: 20 }}
      />

      <div style={{ textAlign: 'center' }}>
        <Space size={4}>
          <Text style={{ color: 'rgba(255,255,255,0.35)', fontSize: 12 }}>
            {tab === 'login' ? '还没有账号？' : '已有账号？'}
          </Text>
          <Button
            type="link"
            onClick={() => setTab(tab === 'login' ? 'register' : 'login')}
            style={{ color: '#60A5FA', height: 'auto', padding: 0, fontSize: 12, fontWeight: 600 }}
          >
            {tab === 'login' ? '立即注册' : '去登录'}
          </Button>
        </Space>
      </div>
    </Modal>
  );
}
