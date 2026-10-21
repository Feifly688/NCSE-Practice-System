import React, { useState, useEffect, lazy, Suspense } from 'react';
import { Row, Col, Button, Skeleton, Carousel } from 'antd';
import {
  EditOutlined, TrophyOutlined, UserOutlined, BookOutlined,
  EyeOutlined, FireOutlined, ReadOutlined, SafetyOutlined, HistoryOutlined,
  ArrowRightOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import api from '../services/api';
import { GlowCard } from '../components/ui/spotlight-card';
import HomeAuthCard from '../components/HomeAuthCard';
import HighlightCover, { type CoverKind } from '../components/HighlightCover';
import TechText from '../components/react-bits/TechText';
import { useResponsive } from '../hooks/useResponsive';
import GlowCursor from '../components/react-bits/GlowCursor';

// 背景与轮播按需加载：ElectricLogo 依赖 WebGL（ogl），
// 放到首屏之后再加载，避免拖慢首次渲染。
const ElectricLogo = lazy(() => import('../components/react-bits/ElectricLogo'));

interface Highlight {
  id: number;
  title: string;
  description: string;
  /** 封面绘制类型，见 HighlightCover */
  kind: CoverKind;
}

const HIGHLIGHTS: Highlight[] = [
  {
    id: 1,
    title: '权威来源',
    description: '题目基于人民日报、新华社等权威内容生成，确保内容质量与时事同步。',
    kind: 'source',
  },
  {
    id: 2,
    title: '智能练习',
    description: 'AI 自适应出题，覆盖言语理解与政治模块，难度智能匹配。',
    kind: 'practice',
  },
  {
    id: 3,
    title: '答题历史',
    description: '记录每次答题数据，多维分析薄弱环节，针对性提高。',
    kind: 'history',
  },
  {
    id: 4,
    title: '错题本 & 收藏',
    description: '自动收集错题，支持收藏好题，循环巩固知识点。',
    kind: 'wrongbook',
  },
  {
    id: 5,
    title: '数据安全',
    description: '个人数据隔离存储，答题记录仅自己可见，隐私无忧。',
    kind: 'security',
  },
];

const colorMap: Record<string, { color: string; glow: 'blue' | 'purple' | 'green' | 'red' | 'orange' }> = {
  todayAnswers: { color: '#1D4ED8', glow: 'blue' },
  todayCorrectRate: { color: '#059669', glow: 'green' },
  totalUsers: { color: '#7C3AED', glow: 'purple' },
  totalQuestions: { color: '#DC2626', glow: 'red' },
  totalVisits: { color: '#0891B2', glow: 'blue' },
  todayVisits: { color: '#EA580C', glow: 'orange' },
};

function StatCard({ icon, title, value, color, glow, loading }: {
  icon: React.ReactNode; title: string; value: string | number;
  color?: string; glow?: 'blue' | 'purple' | 'green' | 'red' | 'orange'; loading?: boolean;
}) {
  if (loading) {
    return <div style={{ backdropFilter: 'blur(5px)', borderRadius: 14, border: '3px solid rgba(255,255,255,0.08)', padding: 20, background: 'hsl(0 0% 60% / 0.12)' }}><Skeleton active paragraph={{ rows: 1 }} /></div>;
  }
  return (
    <GlowCard glowColor={glow || 'blue'} customSize className="!h-auto !w-full !p-5 !grid !grid-rows-none">
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{ fontSize: 30, color: color || '#1D4ED8', flexShrink: 0 }}>{icon}</div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)', marginBottom: 2 }}>{title}</div>
          <div style={{ fontSize: 26, fontWeight: 600, color: '#fff', lineHeight: 1.2 }}>{value}</div>
        </div>
      </div>
    </GlowCard>
  );
}

interface TrendItem { date: string; count: number; }
interface Stats {
  todayAnswers?: number; todayCorrectRate?: number; totalUsers?: number;
  totalQuestions?: number; totalVisits?: number; todayVisits?: number; weekTrend?: TrendItem[];
}

function WeekTrend({ data, loading }: { data?: TrendItem[]; loading?: boolean }) {
  if (loading) return <div style={{ background: 'rgba(255,255,255,0.05)', borderRadius: 12, padding: 24, border: '1px solid rgba(255,255,255,0.08)' }}><Skeleton active paragraph={{ rows: 3 }} /></div>;
  if (!data || data.length === 0) return null;
  const maxCount = Math.max(...data.map(d => d.count), 1);
  return (
    <div style={{ background: 'rgba(255,255,255,0.05)', borderRadius: 12, padding: 24, border: '1px solid rgba(255,255,255,0.08)' }}>
      <h3 style={{ color: '#fff', fontSize: 16, marginBottom: 20, margin: 0 }}>📈 近7天答题趋势</h3>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', height: 140, padding: '0 12px' }}>
        {data.map((item, idx) => (
          <div key={idx} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', fontWeight: 500 }}>{item.count}</div>
            <div style={{ width: '65%', maxWidth: 48, height: `${Math.max((item.count / maxCount) * 100, 6)}px`, background: 'linear-gradient(180deg, #60A5FA 0%, #3B82F6 100%)', borderRadius: '6px 6px 0 0', transition: 'height 0.3s ease', minHeight: 6 }} />
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>{item.date}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 单张亮点卡片：矢量封面 + 渐变压暗 + 文案。 */
function HighlightSlide({ item, index, isMobile }: { item: Highlight; index: number; isMobile: boolean }) {
  return (
    <div style={{ padding: '0 2px' }}>
      <div
        style={{
          position: 'relative',
          borderRadius: 16,
          overflow: 'hidden',
          border: '1px solid rgba(255,255,255,0.1)',
          background: '#0a0a0f',
          height: isMobile ? 236 : 320,
        }}
      >
        <div style={{ position: 'absolute', inset: 0 }}>
          <HighlightCover kind={item.kind} />
        </div>
        {/* 底部渐变，保证文字始终可读 */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'linear-gradient(180deg, rgba(10,10,15,0.05) 0%, rgba(10,10,15,0.42) 46%, rgba(10,10,15,0.94) 100%)',
            pointerEvents: 'none',
          }}
        />
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: isMobile ? '16px 18px' : '22px 26px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <span
              style={{
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: 11,
                letterSpacing: '0.08em',
                color: '#93c5fd',
                border: '1px solid rgba(147,197,253,0.35)',
                borderRadius: 6,
                padding: '1px 6px',
              }}
            >
              {String(index + 1).padStart(2, '0')}
            </span>
            <h3 style={{ color: '#fff', fontSize: isMobile ? 17 : 20, fontWeight: 700, margin: 0 }}>{item.title}</h3>
          </div>
          <p style={{ color: 'rgba(255,255,255,0.62)', fontSize: isMobile ? 13 : 14, lineHeight: 1.7, margin: 0 }}>
            {item.description}
          </p>
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();
  const { isMobile } = useResponsive();
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchStats();
    recordVisit();
  }, []);

  // 首页为深色主题：同步把 html/body 背景设为深色，
  // 否则滚动条占用的宽度会露出 body 默认浅色，形成一条竖状亮边
  useEffect(() => {
    const html = document.documentElement;
    const prevHtml = html.style.backgroundColor;
    const prevBody = document.body.style.backgroundColor;
    html.style.backgroundColor = '#0a0a0f';
    document.body.style.backgroundColor = '#0a0a0f';
    return () => {
      html.style.backgroundColor = prevHtml;
      document.body.style.backgroundColor = prevBody;
    };
  }, []);

  async function fetchStats() {
    try { const res = await api.get('/stats/public'); setStats(res.data); }
    catch { /* */ }
    finally { setLoading(false); }
  }

  async function recordVisit() {
    try {
      const last = sessionStorage.getItem('lastVisitTime');
      const now = Date.now();
      if (last && now - Number(last) < 3 * 60 * 60 * 1000) return;
      await api.post('/stats/visit');
      sessionStorage.setItem('lastVisitTime', String(now));
    } catch { /* */ }
  }

  const features = [
    { title: '权威来源', icon: ReadOutlined as unknown as React.ComponentType<React.SVGProps<SVGSVGElement>>, description: '题目基于人民日报、新华社等权威内容生成' },
    { title: '智能练习', icon: EditOutlined as unknown as React.ComponentType<React.SVGProps<SVGSVGElement>>, description: '支持言语理解等模块，随机出题自主练习' },
    { title: '答题历史', icon: HistoryOutlined as unknown as React.ComponentType<React.SVGProps<SVGSVGElement>>, description: '记录每次答题数据，分析薄弱环节' },
    { title: '数据安全', icon: SafetyOutlined as unknown as React.ComponentType<React.SVGProps<SVGSVGElement>>, description: '个人数据隔离存储，答题记录仅自己可见' },
  ];

  return (
    <div style={{ position: 'relative', background: '#0a0a0f', overflowX: 'clip' }}>
      {/* 光标流体光效（React Bits 官方 GlowCursor）：WebGL2 流体染料模拟，
          全屏 fixed canvas（.glow-cursor-fixed，z-index 2 位于背景之上、
          内容之下，pointer-events:none 不拦截交互）；鼠标轨迹向流体场注入
          速度与染料，染料随流场漂移、点击时放射状迸发。
          颜色：主色 #60A5FA（首页 accent 蓝），其余官方默认参数。 */}
      <GlowCursor className="glow-cursor-fixed" color="#60A5FA" />

      {/* ─── 页面底纹：径向光晕 + 细网格 ─── */}
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 0,
          background:
            'radial-gradient(60% 50% at 50% 30%, rgba(37,99,235,0.18) 0%, rgba(10,10,15,0) 70%), ' +
            'linear-gradient(180deg, #0a0a0f 0%, #08080f 100%)',
        }}
      />
      {/* 上下压暗，让正文内容从背景里浮出来 */}
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 1,
          background: 'linear-gradient(180deg, rgba(10,10,15,0.1) 0%, rgba(10,10,15,0.5) 42%, rgba(10,10,15,0.93) 100%)',
          pointerEvents: 'none',
        }}
      />

      {/* Scrollable content */}
      <div
        style={{
          position: 'relative',
          zIndex: 3,
          width: '100%',
          maxWidth: 1100,
          margin: '0 auto',
          padding: isMobile ? '32px 14px 40px' : '56px 20px 60px',
          // 内容层不拦截指针事件：hero 等空白区域的 hover 穿透到
          // 下层页面元素；各子元素（卡片/按钮/轮播）默认可命中
          pointerEvents: 'none',
        }}
      >
        {/* ─── Hero ─── */}
        {/* pointerEvents:'none'：hero 整体不拦截指针事件，空白区域的
            hover/点击穿透到下层页面元素；下方各交互子元素自行恢复。
            （背景电光 logo 现位于"功能介绍"区块底层，见该区块注释） */}
        <div style={{ position: 'relative', textAlign: 'center', padding: isMobile ? '8px 0 26px' : '10px 0 34px', pointerEvents: 'none' }}>
          <div style={{ position: 'relative', zIndex: 1, pointerEvents: 'none' }}>
            {/* 画布标题，供视觉呈现。单独恢复指针事件，保留其悬停虚线效果 */}
            <div style={{ width: '100%', height: isMobile ? 64 : 112, marginBottom: isMobile ? 2 : 6, pointerEvents: 'auto' }}>
              <TechText
                text="公务员考试刷题系统"
                fontSize={150}
                color="#ffffff"
                accentColor="#60A5FA"
                align="center"
                reveal="letter"
                selection
                sweep={false}
                draggable={false}
                labels={false}
                guides={false}
                specks={12}
                bounce={0.3}
                intro="none"
              />
            </div>
          {/* 供搜索引擎与读屏识别的真实标题 */}
          <h1 className="sr-only">公务员考试刷题系统</h1>

          <p
            style={{
              fontSize: isMobile ? 13 : 15,
              color: 'rgba(255,255,255,0.5)',
              marginTop: isMobile ? 4 : 8,
              marginBottom: isMobile ? 22 : 30,
              letterSpacing: '0.12em',
              fontWeight: 300,
              pointerEvents: 'auto',
            }}
          >
            基于权威素材的智能命题与练习平台
          </p>

          {/* 登录态：直接进入练习；未登录：内嵌登录/注册卡片。
              这两块恢复指针事件，确保可点击；其余空白区域穿透给底层 logo，
              这样鼠标移入时电弧才会响应。 */}
          {isAuthenticated ? (
            <div style={{ pointerEvents: 'auto', display: 'inline-block' }}>
              <Button
                size="large"
                onClick={() => navigate('/practice')}
                icon={<ArrowRightOutlined />}
                style={{
                  height: 48,
                  padding: '0 38px',
                  fontSize: 15,
                  borderRadius: 24,
                  background: '#fff',
                  color: '#0a0a0f',
                  border: 'none',
                  fontWeight: 600,
                }}
              >
                开始练习
              </Button>
            </div>
          ) : (
            <div style={{ pointerEvents: 'auto' }}>
              <HomeAuthCard />
            </div>
          )}
          </div>
        </div>

        {/* ─── Stats ─── */}
        <Row gutter={[isMobile ? 8 : 14, isMobile ? 8 : 14]} style={{ marginBottom: isMobile ? 32 : 50, pointerEvents: 'auto' }}>
          <Col xs={12} sm={8} md={4}><StatCard icon={<EditOutlined />} title="今日答题" value={stats?.todayAnswers ?? '-'} {...colorMap.todayAnswers} loading={loading} /></Col>
          <Col xs={12} sm={8} md={4}><StatCard icon={<TrophyOutlined />} title="今日正确率" value={stats?.todayCorrectRate ? `${stats.todayCorrectRate}%` : '-'} {...colorMap.todayCorrectRate} loading={loading} /></Col>
          <Col xs={12} sm={8} md={4}><StatCard icon={<UserOutlined />} title="注册用户" value={stats?.totalUsers ?? '-'} {...colorMap.totalUsers} loading={loading} /></Col>
          <Col xs={12} sm={8} md={4}><StatCard icon={<BookOutlined />} title="题库总数" value={stats?.totalQuestions ?? '-'} {...colorMap.totalQuestions} loading={loading} /></Col>
          <Col xs={12} sm={8} md={4}><StatCard icon={<EyeOutlined />} title="总访问量" value={stats?.totalVisits ?? '-'} {...colorMap.totalVisits} loading={loading} /></Col>
          <Col xs={12} sm={8} md={4}><StatCard icon={<FireOutlined />} title="今日访问" value={stats?.todayVisits ?? '-'} {...colorMap.todayVisits} loading={loading} /></Col>
        </Row>

        {/* ─── Feature Cards ─── */}
        <div style={{ position: 'relative', marginBottom: isMobile ? 34 : 52, pointerEvents: 'auto' }}>
          {/* 背景电光 logo（React Bits 官方 ElectricLogo）：位于"功能介绍"
              文本区域正下方、水平居中，作为本区块的底层背景
              （z-index:-1，渲染在文字与卡片之下）。
              定位：桌面容器顶 = 文字块下缘上方 125px（图形中心约在文字块
              下方 100px），移动端为 75px；容器 680×570（移动 440×370），
              宽高比与源图 211×177 一致。
              参数以官方 usage example 为基础，按"静态干净、hover 带电"
              的预期行为调整（shader 中 uStrands 是静态基数，heat*hover
              充电时动态增至最多 6 条）：
              ① strands 4 -> 1：静态仅 1 条主丝沿轮廓缓流，不再繁杂；
              hover 充电时增至约 3.5 条，交互感知明显；
              ② arcs 1 -> 0：关闭静态随机跳弧（静态画面保持干净）；
              点击仍有 pulses 涟漪冲击（ripple 不依赖 arcs）；
              ③ crackle 1.5 -> 0.3：大幅减少细碎抖动杂线；
              ④ flicker 0.6 -> 0.2、glow 0.5 -> 0.28、intensity 1 -> 0.9：
              进一步压低静态闪烁与光晕，hover 时三者随 heat 自动增强。
              其余保持官方：intensity 1 / thickness 1.5 / bend 0.6 /
              fill 0 / cursorIntensity 0.75 / cursorRadius 100 /
              color #ecc7ff + glowColor #ad6dff。
              src 用加粗版 logo-outline-bold.png（原图 1px 细线在官方
              宽晕下会糊成雾团，加粗至 4-5px 后电弧沿轮廓稳定流动）。
              scale 0.85 在官方 0.7 基础上放大（用户要求）。
              !overflow-visible：大 scale 下电光光晕会超出容器，
              覆盖官方 CSS 的 overflow:hidden，避免衰减途中被裁出硬边。 */}
          <div
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: '50%',
              top: isMobile ? -75 : -125,
              transform: 'translateX(-50%)',
              width: isMobile ? 'min(92vw, 440px)' : 'min(78vw, 680px)',
              height: isMobile ? 'min(77vw, 370px)' : 'min(66vw, 570px)',
              zIndex: -1,
              pointerEvents: 'auto',
            }}
          >
            <Suspense fallback={null}>
              <ElectricLogo
                src="/logo-outline-bold.png"
                color="#ecc7ff"
                glowColor="#ad6dff"
                theme="dark"
                scale={0.85}
                className="!overflow-visible"
                intensity={0.9}
                glow={0.28}
                thickness={1.5}
                strands={1}
                bend={0.6}
                crackle={0.3}
                arcs={0}
                flicker={0.2}
                fill={0}
                speed={2.5}
                interactive
                cursorIntensity={0.75}
                cursorRadius={100}
              />
            </Suspense>
          </div>
          <h2 style={{ textAlign: 'center', fontSize: isMobile ? 20 : 26, fontWeight: 700, color: '#fff', marginBottom: 6 }}>功能介绍</h2>
          <p style={{ textAlign: 'center', fontSize: 14, color: 'rgba(255,255,255,0.4)', marginBottom: isMobile ? 18 : 28, marginTop: 0 }}>四大核心能力，助你高效备考</p>
          <div className="features-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(240px, 100%), 1fr))', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, overflow: 'hidden', background: 'rgba(255,255,255,0.02)' }}>
            {features.map((f, i) => (
              <div className="home-feature-item" key={i} style={{ padding: isMobile ? '18px 16px' : '28px 24px', borderRight: i % 2 === 0 ? '1px solid rgba(255,255,255,0.08)' : 'none', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                <div style={{ fontSize: 28, marginBottom: 16, opacity: 0.7 }}>
                  {React.createElement(f.icon, { style: { color: '#fff' } })}</div>
                <h3 style={{ color: '#fff', fontSize: 15, fontWeight: 600, margin: '0 0 8px 0' }}>{f.title}</h3>
                <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 13, margin: 0, lineHeight: 1.6 }}>{f.description}</p>
              </div>
            ))}
          </div>
        </div>

        {/* ─── 平台亮点轮播 ─── */}
        <div style={{ marginBottom: isMobile ? 34 : 52, pointerEvents: 'auto' }}>
          <h2 style={{ textAlign: 'center', fontSize: isMobile ? 20 : 26, fontWeight: 700, color: '#fff', marginBottom: 6 }}>平台亮点</h2>
          <p style={{ textAlign: 'center', fontSize: 14, color: 'rgba(255,255,255,0.4)', marginBottom: isMobile ? 18 : 26, marginTop: 0 }}>自动轮播，可左右拖动</p>
          <div className="home-carousel">
            <Carousel
              autoplay
              autoplaySpeed={4200}
              dots
              arrows={!isMobile}
              draggable
              pauseOnHover
              adaptiveHeight={false}
            >
              {HIGHLIGHTS.map((item, i) => (
                <HighlightSlide key={item.id} item={item} index={i} isMobile={isMobile} />
              ))}
            </Carousel>
          </div>
        </div>

        {/* ─── Trend ─── */}
        <WeekTrend data={stats?.weekTrend} loading={loading} />

      </div>
    </div>
  );
}
