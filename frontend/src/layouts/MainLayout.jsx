import React from 'react';
import { Layout, Menu, Button, Space, Typography, Dropdown } from 'antd';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { HomeOutlined, EditOutlined, HistoryOutlined, DashboardOutlined, SettingOutlined, LogoutOutlined, LoginOutlined, UserAddOutlined, UserOutlined, BookOutlined, StarFilled, TrophyOutlined } from '@ant-design/icons';
import { useAuth } from '../contexts/AuthContext';

const { Header, Content, Footer } = Layout;

export default function MainLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, isAuthenticated, isAdmin, logout } = useAuth();

  const menuItems = [
    { key: '/', icon: <HomeOutlined />, label: '首页' },
  ];
  if (isAuthenticated) {
    menuItems.push(
      { key: '/dashboard', icon: <DashboardOutlined />, label: '仪表盘' },
      { key: '/practice', icon: <EditOutlined />, label: '答题' },
      { key: '/history', icon: <HistoryOutlined />, label: '历史' },
      { key: '/wrong-book', icon: <BookOutlined />, label: '错题本' },
      { key: '/favorites', icon: <StarFilled />, label: '收藏' },
      { key: '/leaderboard', icon: <TrophyOutlined />, label: '排行榜' },
    );
  }
  if (isAdmin) {
    menuItems.push({ key: '/admin', icon: <SettingOutlined />, label: '管理后台' });
  }

  function handleLogout() {
    logout();
    navigate('/');
  }

  const userMenuItems = [
    { key: 'profile', icon: <UserOutlined />, label: '个人信息', onClick: () => navigate('/profile') },
    { type: 'divider' },
    { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', onClick: handleLogout },
  ];

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header style={{ display: 'flex', alignItems: 'center', padding: '0 24px' }}>
        <Typography.Text style={{ color: '#fff', fontSize: 18, fontWeight: 700, marginRight: 32, cursor: 'pointer', whiteSpace: 'nowrap' }} onClick={() => navigate('/')}>
          NCSE 刷题系统
        </Typography.Text>
        <Menu
          theme="dark"
          mode="horizontal"
          selectedKeys={[location.pathname]}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
          style={{ flex: 1, minWidth: 0 }}
        />
        <Space style={{ marginLeft: 'auto' }}>
          {isAuthenticated ? (
            <Dropdown menu={{ items: userMenuItems }} placement="bottomRight">
              <Button type="text" icon={<UserOutlined />} style={{ color: '#fff' }}>
                {user.nickname}
              </Button>
            </Dropdown>
          ) : (
            <>
              <Button type="text" icon={<LoginOutlined />} style={{ color: '#fff' }} onClick={() => navigate('/login')}>登录</Button>
              <Button type="primary" icon={<UserAddOutlined />} onClick={() => navigate('/register')}>注册</Button>
            </>
          )}
        </Space>
      </Header>
      <Content style={{ padding: '24px 48px' }}>
        <Outlet />
      </Content>
      <Footer style={{ textAlign: 'center', color: '#999' }}>NCSE 公务员考试练习系统 &copy; 2026</Footer>
    </Layout>
  );
}
