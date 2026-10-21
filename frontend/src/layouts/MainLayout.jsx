import React, { useState, useEffect } from 'react';
import { Layout, Menu, Button, Space, Typography, Dropdown, Drawer } from 'antd';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { HomeOutlined, EditOutlined, HistoryOutlined, DashboardOutlined, SettingOutlined, LogoutOutlined, LoginOutlined, UserAddOutlined, UserOutlined, BookOutlined, StarFilled, TrophyOutlined, MenuOutlined, FileTextOutlined } from '@ant-design/icons';
import { useAuth } from '../contexts/AuthContext';
import { useResponsive } from '../hooks/useResponsive';

const { Header, Content, Footer } = Layout;

export default function MainLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, isAuthenticated, isAdmin, logout, openAuth } = useAuth();
  const { isMobile } = useResponsive();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // 首页为深色主题，需与其他页面的浅色布局区分
  const isHome = location.pathname === '/';

  // 未登录访问首页时不渲染导航栏，呈现为纯落地页；
  // 登录后（或进入登录/注册等子页）才显示。首页 hero 区本身带登录/注册入口。
  const showHeader = isAuthenticated || !isHome;

  // 路由变化时关闭移动端抽屉
  useEffect(() => { setDrawerOpen(false); }, [location.pathname]);

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
      { key: '/exam-papers', icon: <FileTextOutlined />, label: '整卷真题' },
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

  const currentLabel = menuItems.find((m) => m.key === location.pathname)?.label || 'NCSE';

  const navMenu = (
    <Menu
      mode={isMobile ? 'inline' : 'horizontal'}
      // 桌面端 header 为深色底（#0a0a0f），菜单须用深色主题（浅色文字）；
      // 移动端菜单在白色抽屉内，用浅色主题（深色文字）
      theme={isMobile ? 'light' : 'dark'}
      selectedKeys={[location.pathname]}
      items={menuItems}
      onClick={({ key }) => navigate(key)}
      // 显式指定文字/悬停/选中色；选中态用首页 accent 蓝（桌面深底用淡蓝，
      // 移动端白底抽屉用深蓝保证可读性），避免默认 antd 蓝违和
      itemColor={isMobile ? undefined : 'rgba(255, 255, 255, 0.75)'}
      itemHoverColor={isMobile ? undefined : '#ffffff'}
      itemSelectedColor={isMobile ? '#1d4ed8' : '#93c5fd'}
      itemSelectedBg="rgba(96, 165, 250, 0.16)"
      style={{
        flex: isMobile ? undefined : 1,
        minWidth: 0,
        background: 'transparent',
        borderBottom: 'none',
      }}
    />
  );

  return (
    <Layout style={{ minHeight: '100vh', background: isHome ? '#0a0a0f' : '#f8f9fb' }}>
      {showHeader && (
        <>
          <Header
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: isMobile ? '0 12px' : '0 32px',
              background: '#0a0a0f',
              borderBottom: '1px solid rgba(255,255,255,0.06)',
              position: 'sticky',
              top: 0,
              zIndex: 100,
              paddingTop: 'env(safe-area-inset-top)',
            }}
          >
        {isMobile && (
          <Button
            type="text"
            icon={<MenuOutlined />}
            onClick={() => setDrawerOpen(true)}
            aria-label="打开菜单"
            style={{ color: 'rgba(255,255,255,0.85)', marginRight: 4, fontSize: 18 }}
          />
        )}

        <Typography.Text
          style={{
            color: '#fff',
            fontSize: isMobile ? 16 : 18,
            fontWeight: 700,
            marginRight: isMobile ? 8 : 36,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            letterSpacing: '0.03em',
            flexShrink: 0,
          }}
          onClick={() => navigate('/')}
        >
          {isMobile ? 'NCSE' : 'NCSE 刷题系统'}
        </Typography.Text>

        {!isMobile && navMenu}

        <Space style={{ marginLeft: 'auto' }} size={isMobile ? 4 : 8}>
          {isAuthenticated ? (
            <Dropdown menu={{ items: userMenuItems }} placement="bottomRight">
              <Button
                type="text"
                icon={<UserOutlined />}
                style={{
                  color: 'rgba(255,255,255,0.85)',
                  background: 'rgba(255,255,255,0.06)',
                  borderRadius: 8,
                  maxWidth: isMobile ? 40 : undefined,
                  overflow: 'hidden',
                }}
              >
                {!isMobile && user.nickname}
              </Button>
            </Dropdown>
          ) : (
            <>
              <Button
                type="text"
                icon={<LoginOutlined />}
                onClick={() => openAuth('login')}
                style={{ color: 'rgba(255,255,255,0.75)', padding: isMobile ? '4px 8px' : undefined }}
              >
                {!isMobile && '登录'}
              </Button>
              <Button
                type="primary"
                icon={<UserAddOutlined />}
                onClick={() => openAuth('register')}
                style={{ borderRadius: 8, background: '#fff', color: '#000', border: 'none', fontWeight: 600, padding: isMobile ? '4px 10px' : undefined }}
              >
                {!isMobile && '注册'}
              </Button>
            </>
          )}
        </Space>
          </Header>

          {/* 移动端抽屉导航 */}
          <Drawer
            title="NCSE 刷题系统"
            placement="left"
            open={drawerOpen}
            onClose={() => setDrawerOpen(false)}
            width={260}
            styles={{ body: { padding: 0 }, header: { borderBottom: '1px solid #f0f0f0' } }}
          >
            {navMenu}
          </Drawer>
        </>
      )}

      {isHome ? (
        // 首页为深色全屏主题，脱离内容容器约束直接铺满。
        // 不设 minHeight，避免与外层 Layout 的 100vh 叠加产生嵌套滚动条。
        <Content style={{ padding: 0, margin: 0, width: '100%', background: '#0a0a0f', flex: 'none' }}>
          <Outlet />
        </Content>
      ) : (
        <Content
          style={{
            padding: 0,
            margin: 0,
            width: '100%',
          }}
        >
          <div style={{
            maxWidth: 1200,
            margin: '0 auto',
            width: '100%',
            boxSizing: 'border-box',
            padding: isMobile ? '16px 12px' : '32px 48px',
          }}>
            <Outlet />
          </div>
        </Content>
      )}

      <Footer style={{
        textAlign: 'center',
        color: isHome ? 'rgba(255,255,255,0.35)' : '#999',
        background: isHome ? '#0a0a0f' : '#f8f9fb',
        borderTop: isHome ? '1px solid rgba(255,255,255,0.06)' : '1px solid #eee',
        fontSize: isMobile ? 12 : 14,
      }}>
        NCSE 公务员考试练习系统 &copy; 2026
      </Footer>
    </Layout>
  );
}
