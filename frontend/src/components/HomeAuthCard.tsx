import React, { useState } from 'react';
import { Form, Input, Typography, message } from 'antd';
import { UserOutlined, LockOutlined, MailOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useResponsive } from '../hooks/useResponsive';
import StarBorder from './react-bits/StarBorder';
import RememberMeField from './RememberMeField';

const { Text } = Typography;

type Mode = 'login' | 'register';

/**
 * 首页 hero 区的内嵌登录/注册卡片。
 *
 * 与早先的 Modal 方案不同：这里不使用遮罩层，卡片直接落在原来
 * 「免费注册 / 登录」按钮的位置，背景动画依然完整可见。
 * 挂载时通过 .auth-card 的 CSS 关键帧做一次弹出动画。
 */
export default function HomeAuthCard() {
  const navigate = useNavigate();
  const { login, register, loading, sessionPolicy } = useAuth();
  const { isMobile } = useResponsive();
  const [mode, setMode] = useState<Mode>('login');
  const [loginForm] = Form.useForm();
  const [registerForm] = Form.useForm();
  // 记住我：勾选 = 长有效期（默认 7 天）；不勾选 = 短有效期（默认 2 小时）
  const [remember, setRemember] = useState(true);

  const shortLabel = sessionPolicy?.short?.label || '2 小时';

  async function handleLogin(values: { account: string; password: string }) {
    try {
      await login(values.account, values.password, remember);
      message.success(remember ? '登录成功' : `登录成功（${shortLabel}后需重新登录）`);
      loginForm.resetFields();
      navigate('/dashboard');
    } catch (err: any) {
      message.error(err?.response?.data?.error || '登录失败');
    }
  }

  async function handleRegister(values: any) {
    try {
      await register(values, remember);
      message.success(remember ? '注册成功' : `注册成功（${shortLabel}后需重新登录）`);
      registerForm.resetFields();
      navigate('/dashboard');
    } catch (err: any) {
      message.error(err?.response?.data?.error || '注册失败');
    }
  }

  function switchMode(next: Mode) {
    setMode(next);
    // 切换时清空密码，避免误填到另一张表单
    loginForm.resetFields(['password']);
    registerForm.resetFields(['password']);
  }

  const tabStyle = (active: boolean): React.CSSProperties => ({
    flex: 1,
    padding: '9px 0',
    fontSize: 14,
    fontWeight: 600,
    borderRadius: 9,
    cursor: 'pointer',
    border: 'none',
    background: active ? 'rgba(96, 165, 250, 0.16)' : 'transparent',
    color: active ? '#93c5fd' : 'rgba(255, 255, 255, 0.5)',
    transition: 'all 0.2s ease',
  });

  return (
    <div
      className="auth-card auth-dark"
      style={{
        width: '100%',
        maxWidth: 400,
        margin: '0 auto',
        padding: isMobile ? '20px 18px 22px' : '24px 26px 26px',
        textAlign: 'left',
      }}
    >
      {/* 标题区 */}
      <div style={{ textAlign: 'center', marginBottom: 18 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: '#fff', letterSpacing: '0.02em' }}>
          {mode === 'login' ? '登录账号' : '创建账号'}
        </div>
        <Text style={{ fontSize: 12, color: 'rgba(255,255,255,0.42)' }}>
          {mode === 'login' ? '登录后开始练习，记录答题进度' : '注册即可免费使用全部功能'}
        </Text>
      </div>

      {/* 分段切换 */}
      <div
        style={{
          display: 'flex',
          gap: 4,
          padding: 4,
          marginBottom: 18,
          borderRadius: 12,
          background: 'rgba(255, 255, 255, 0.05)',
          border: '1px solid rgba(255, 255, 255, 0.08)',
        }}
      >
        <button type="button" style={tabStyle(mode === 'login')} onClick={() => switchMode('login')}>
          登录
        </button>
        <button type="button" style={tabStyle(mode === 'register')} onClick={() => switchMode('register')}>
          注册
        </button>
      </div>

      {mode === 'login' ? (
        <Form form={loginForm} layout="vertical" onFinish={handleLogin} autoComplete="off" size="large" requiredMark={false}>
          <Form.Item
            name="account"
            rules={[{ required: true, message: '请输入用户名或邮箱' }]}
            style={{ marginBottom: 14 }}
          >
            <Input
              prefix={<UserOutlined style={{ color: 'rgba(255,255,255,0.3)' }} />}
              placeholder="用户名或邮箱"
              style={{ borderRadius: 9 }}
            />
          </Form.Item>
          <Form.Item
            name="password"
            rules={[{ required: true, message: '请输入密码' }]}
            style={{ marginBottom: 18 }}
          >
            <Input.Password
              prefix={<LockOutlined style={{ color: 'rgba(255,255,255,0.3)' }} />}
              placeholder="密码"
              style={{ borderRadius: 9 }}
            />
          </Form.Item>
          {/* 记住我：勾选=长有效期，不勾选=短有效期（公共设备更安全） */}
          <RememberMeField checked={remember} onChange={setRemember} style={{ marginBottom: 14 }} />
          {/* React Bits StarBorder 提交按钮：星星沿边框环跑 + 点击光脉冲。
              antd Button 无 loading 内置，用 disabled + 文案表达提交中状态。 */}
          <StarBorder
            as="button"
            type="submit"
            disabled={loading}
            radius={9}
            thickness={2.5}
            duration={4}
            glow={1}
            sparkle
            stars={2}
            trailLength={0.5}
            color="#93c5fd"
            trailColor="#60A5FA"
            backgroundColor="rgba(96, 165, 250, 0.14)"
            textColor="#ffffff"
            borderColor="rgba(96, 165, 250, 0.35)"
            style={{ width: '100%', height: 42, fontWeight: 600, fontSize: 15 }}
          >
            {loading ? '登录中…' : '登录'}
          </StarBorder>
        </Form>
      ) : (
        <Form form={registerForm} layout="vertical" onFinish={handleRegister} autoComplete="off" size="large" requiredMark={false}>
          <Form.Item
            name="nickname"
            rules={[{ required: true, message: '请输入昵称' }]}
            style={{ marginBottom: 12 }}
          >
            <Input
              prefix={<UserOutlined style={{ color: 'rgba(255,255,255,0.3)' }} />}
              placeholder="昵称（显示名称，可随时修改）"
              style={{ borderRadius: 9 }}
            />
          </Form.Item>
          <Form.Item
            name="username"
            rules={[
              { required: true, message: '请输入用户名' },
              { min: 2, max: 64, message: '用户名长度需为 2-64 个字符' },
              { pattern: /^[a-zA-Z0-9_\u4e00-\u9fa5-]+$/, message: '只能包含字母、数字、下划线、连字符和中文' },
            ]}
            style={{ marginBottom: 12 }}
          >
            <Input
              prefix={<UserOutlined style={{ color: 'rgba(255,255,255,0.3)' }} />}
              placeholder="用户名（登录账号，不可重复）"
              style={{ borderRadius: 9 }}
            />
          </Form.Item>
          <Form.Item
            name="email"
            rules={[
              { type: 'email', message: '邮箱格式不正确' },
              { max: 100, message: '邮箱不能超过 100 个字符' },
            ]}
            style={{ marginBottom: 12 }}
          >
            <Input
              prefix={<MailOutlined style={{ color: 'rgba(255,255,255,0.3)' }} />}
              placeholder="邮箱（选填，用于找回账号）"
              style={{ borderRadius: 9 }}
            />
          </Form.Item>
          <Form.Item
            name="password"
            rules={[
              { required: true, message: '请输入密码' },
              { min: 6, message: '密码至少 6 位' },
            ]}
            style={{ marginBottom: 18 }}
          >
            <Input.Password
              prefix={<LockOutlined style={{ color: 'rgba(255,255,255,0.3)' }} />}
              placeholder="密码（至少 6 位）"
              style={{ borderRadius: 9 }}
            />
          </Form.Item>
          <RememberMeField checked={remember} onChange={setRemember} style={{ marginBottom: 14 }} />
          <StarBorder
            as="button"
            type="submit"
            disabled={loading}
            radius={9}
            thickness={2.5}
            duration={4}
            glow={1}
            sparkle
            stars={2}
            trailLength={0.5}
            color="#93c5fd"
            trailColor="#60A5FA"
            backgroundColor="rgba(96, 165, 250, 0.14)"
            textColor="#ffffff"
            borderColor="rgba(96, 165, 250, 0.35)"
            style={{ width: '100%', height: 42, fontWeight: 600, fontSize: 15 }}
          >
            {loading ? '创建中…' : '创建账号'}
          </StarBorder>
        </Form>
      )}

      <div style={{ textAlign: 'center', marginTop: 14 }}>
        <Text style={{ fontSize: 12, color: 'rgba(255,255,255,0.32)' }}>
          {mode === 'login' ? '还没有账号？' : '已有账号？'}
        </Text>
        <a
          onClick={() => switchMode(mode === 'login' ? 'register' : 'login')}
          style={{ fontSize: 12, fontWeight: 600, color: '#60A5FA', cursor: 'pointer', marginLeft: 4 }}
        >
          {mode === 'login' ? '立即注册' : '去登录'}
        </a>
      </div>
    </div>
  );
}
