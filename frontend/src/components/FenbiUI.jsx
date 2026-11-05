import React from 'react';
import { ConfigProvider, Card } from 'antd';
import { useResponsive } from '../hooks/useResponsive';

/**
 * 粉笔式「页面级」视觉外壳。
 *
 * 只被仪表盘 / 题库 / 历史 / 错题本 / 收藏 / 排行榜 六个页面引用。
 * 刻意不修改全局 ThemeContext、App.jsx、MainLayout —— 其余页面保持原貌：
 *   - 配色 token 由本模块的 F 提供，页面内自行取用；
 *   - antd 主色用嵌套 ConfigProvider 局部覆盖（不泄漏到别的路由）；
 *   - 所有 CSS 选择器都限定在 .fenbi-scope / .fenbi-portal 之下，
 *     弹窗通过 className="fenbi-portal" 同样吃到这套样式。
 */

export const F = {
  // 页面层级
  pageBg: '#F7F8FA',
  cardBg: '#FFFFFF',
  cardBgAlt: '#F7F8FA',
  // 文字
  text: '#333333',
  textSub: '#666666',
  textWeak: '#999999',
  textInverse: '#FFFFFF',
  // 品牌色
  primary: '#F47735',
  primaryLight: '#FFF3EB',
  selectedBg: '#FFF3EB',
  selectedBorder: '#FFD9BF',
  // 描边
  border: '#EEEEEE',
  cardBorder: '#EEEEEE',
  divider: '#F2F2F2',
  // 语义色
  success: '#35B879',
  warning: '#FAAD14',
  error: '#F05B55',
  accent: '#F47735',
  // 遮罩 / 阴影（克制）
  mask: 'rgba(0,0,0,0.45)',
  shadow: '0 2px 8px rgba(0,0,0,0.03)',
};

const S = ':is(.fenbi-scope, .fenbi-portal)';

const SCOPE_CSS = `
${S} { color: ${F.text}; font-size: 14px; }
${S} .ant-card { border: 1px solid ${F.border}; border-radius: 8px; box-shadow: none; }
${S} .ant-card-head { border-bottom: 1px solid ${F.divider}; min-height: 52px; padding: 0 20px; }
${S} .ant-card-head-title { font-size: 15px; font-weight: 600; color: ${F.text}; }
${S} .ant-card-body { padding: 20px; }
${S} .ant-btn:not(.ant-btn-sm):not(.ant-btn-lg) { height: 36px; border-radius: 6px; }
${S} .ant-btn-sm { border-radius: 5px; }
${S} .ant-btn-primary { box-shadow: none; }
${S} .ant-btn-link, ${S} a { color: ${F.primary}; }
${S} .ant-tag { border-radius: 4px; font-size: 12px; line-height: 20px; padding: 0 7px; margin-inline-end: 8px; }
${S} .ant-tag-blue, ${S} .ant-tag-orange, ${S} .ant-tag-cyan { color: ${F.primary}; background: ${F.primaryLight}; border-color: ${F.selectedBorder}; }
${S} .ant-tag-green, ${S} .ant-tag-success { color: ${F.success}; background: #F0FAF4; border-color: #B5E5CC; }
${S} .ant-tag-red, ${S} .ant-tag-error { color: ${F.error}; background: #FEF2F1; border-color: #F8C9C6; }
${S} .ant-tag-purple, ${S} .ant-tag-default { color: ${F.textSub}; background: #F5F5F5; border-color: #E8E8E8; }
${S} .ant-tag-gold { color: #D48806; background: #FFFBE6; border-color: #FFE58F; }
${S} .ant-table-thead > tr > th { background: #FAFAFA !important; color: ${F.textSub}; font-weight: 600; border-bottom: 1px solid ${F.border} !important; }
${S} .ant-table-tbody > tr > td { border-bottom: 1px solid ${F.divider}; }
${S} .ant-table-row-selected > td { background: ${F.primaryLight} !important; }
${S} .ant-list-item { border-bottom: 1px solid ${F.divider} !important; }
${S} .ant-pagination-item-active { border-color: ${F.primary}; }
${S} .ant-empty-description { color: ${F.textWeak}; }
${S} .ant-radio-button-wrapper-checked { color: ${F.primary}; }
${S} .fb-pagehead { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 20px; }
${S} .fb-title { margin: 0; font-size: 22px; line-height: 1.4; font-weight: 600; color: ${F.text}; display: flex; align-items: center; gap: 8px; }
${S} .fb-title-icon { color: ${F.primary}; font-size: 20px; }
${S} .fb-desc { margin: 6px 0 0; font-size: 13px; color: ${F.textWeak}; }
${S} .fb-pagehead-extra { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
${S} .fb-section { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 0 0 12px; }
${S} .fb-section-title { font-size: 15px; font-weight: 600; color: ${F.text}; }
${S} .fb-section-title::before { content: ''; display: inline-block; width: 3px; height: 14px; background: ${F.primary}; border-radius: 2px; margin-right: 8px; vertical-align: -2px; }
${S} .fb-stat { display: flex; align-items: center; gap: 14px; padding: 18px 20px; background: ${F.cardBg}; border: 1px solid ${F.border}; border-radius: 8px; height: 100%; }
${S} .fb-stat-icon { width: 40px; height: 40px; flex-shrink: 0; border-radius: 8px; display: grid; place-items: center; font-size: 19px; }
${S} .fb-stat-label { font-size: 12px; color: ${F.textWeak}; margin-bottom: 2px; }
${S} .fb-stat-value { font-size: 24px; font-weight: 600; line-height: 1.2; color: ${F.text}; }
${S} .fb-stat-unit { font-size: 13px; font-weight: 400; color: ${F.textWeak}; margin-left: 3px; }
${S} .fb-row { background: ${F.cardBg}; border: 1px solid ${F.border}; border-radius: 8px; padding: 16px 20px; margin-bottom: 10px; transition: border-color .15s ease, background .15s ease; }
${S} .fb-row:hover { border-color: ${F.selectedBorder}; background: #FFFCF9; }
${S} .fb-row-clickable { cursor: pointer; }
${S} .fb-row-title { font-size: 15px; color: ${F.text}; line-height: 1.6; word-break: break-word; }
${S} .fb-meta { font-size: 12px; color: ${F.textWeak}; }
${S} .fb-tag { display: inline-flex; align-items: center; border-radius: 4px; font-size: 12px; line-height: 20px; padding: 0 8px; border: 1px solid transparent; white-space: nowrap; }
${S} .fb-nav-item { display: flex; align-items: center; gap: 8px; padding: 11px 14px; border-left: 3px solid transparent; cursor: pointer; font-size: 14px; transition: background .15s ease; }
${S} .fb-nav-item:hover { background: #FFF8F3; }
${S} .fb-nav-item.fb-nav-active { background: ${F.primaryLight}; border-left-color: ${F.primary}; color: ${F.primary}; font-weight: 600; }
${S} .fb-link { color: ${F.primary}; cursor: pointer; }
${S} .fb-link:hover { text-decoration: underline; }
${S} .fb-empty { padding: 40px 0; text-align: center; color: ${F.textWeak}; font-size: 13px; }
${S} .hide-scrollbar { scrollbar-width: none; }
${S} .hide-scrollbar::-webkit-scrollbar { display: none; }
@media (max-width: 767px) {
  ${S} .fb-title { font-size: 19px; }
  ${S} .fb-stat { padding: 14px; gap: 10px; }
  ${S} .fb-stat-value { font-size: 20px; }
  ${S} .fb-row { padding: 14px; }
  ${S} .ant-card-body { padding: 14px; }
  ${S} .ant-card-head { padding: 0 14px; }
}
`;

/** 页面级橙白主题容器。bleed 让浅灰底铺满 MainLayout 的内容区，视觉上与粉笔一致。 */
export function FenbiScope({ children, bleed = true, style }) {
  const { isMobile } = useResponsive();
  const bleedStyle = bleed
    ? (isMobile
      ? { margin: '-16px -12px -16px', padding: '16px 12px 24px' }
      : { margin: '-32px -48px -32px', padding: '32px 48px 40px' })
    : {};
  return (
    <ConfigProvider
      theme={{
        token: {
          colorPrimary: F.primary,
          colorInfo: F.primary,
          colorSuccess: F.success,
          colorError: F.error,
          colorWarning: F.warning,
          colorLink: F.primary,
          colorTextBase: F.text,
          colorBgBase: F.cardBg,
          borderRadius: 8,
        },
        components: {
          Card: { colorBgContainer: F.cardBg },
          Table: { colorBgContainer: F.cardBg, headerBg: '#FAFAFA', headerColor: F.textSub },
        },
      }}
    >
      <div className="fenbi-scope" style={{ background: F.pageBg, ...bleedStyle, ...style }}>
        <style>{SCOPE_CSS}</style>
        {children}
      </div>
    </ConfigProvider>
  );
}

/** 页面标题栏：标题 + 说明 + 右侧操作 */
export function PageHead({ title, desc, extra, icon }) {
  return (
    <div className="fb-pagehead">
      <div>
        <h1 className="fb-title">
          {icon && <span className="fb-title-icon">{icon}</span>}
          {title}
        </h1>
        {desc && <p className="fb-desc">{desc}</p>}
      </div>
      {extra && <div className="fb-pagehead-extra">{extra}</div>}
    </div>
  );
}

/** 白底轻边框内容块 */
export function Panel({ title, extra, children, style, bodyStyle, className = '' }) {
  return (
    <Card
      className={className}
      title={title ? <span style={{ fontSize: 15, fontWeight: 600, color: F.text }}>{title}</span> : undefined}
      extra={extra}
      style={{ borderRadius: 8, border: `1px solid ${F.border}`, ...style }}
      styles={{ body: { padding: 20, ...bodyStyle } }}
    >
      {children}
    </Card>
  );
}

/** 小节标题（橙色竖条） */
export function SectionLabel({ title, extra }) {
  return (
    <div className="fb-section">
      <span className="fb-section-title">{title}</span>
      {extra}
    </div>
  );
}

/** 数据面板里的单个指标卡 */
export function StatTile({ label, value, unit, icon, tone = 'primary' }) {
  const palette = {
    primary: [F.primary, F.primaryLight],
    success: [F.success, '#F0FAF4'],
    error: [F.error, '#FEF2F1'],
    neutral: [F.textSub, '#F5F5F5'],
  }[tone] || [F.primary, F.primaryLight];
  return (
    <div className="fb-stat">
      {icon && <div className="fb-stat-icon" style={{ color: palette[0], background: palette[1] }}>{icon}</div>}
      <div style={{ minWidth: 0 }}>
        <div className="fb-stat-label">{label}</div>
        <div className="fb-stat-value">{value}{unit && <span className="fb-stat-unit">{unit}</span>}</div>
      </div>
    </div>
  );
}

/** 轻量语义标签，避免 antd 预设色板与品牌色冲突 */
export function MetaTag({ children, tone = 'neutral', style }) {
  const palette = {
    neutral: [F.textSub, '#F5F5F5', '#E8E8E8'],
    primary: [F.primary, F.primaryLight, F.selectedBorder],
    success: [F.success, '#F0FAF4', '#B5E5CC'],
    error: [F.error, '#FEF2F1', '#F8C9C6'],
    warning: ['#D48806', '#FFFBE6', '#FFE58F'],
  }[tone] || [F.textSub, '#F5F5F5', '#E8E8E8'];
  return (
    <span className="fb-tag" style={{ color: palette[0], background: palette[1], borderColor: palette[2], ...style }}>
      {children}
    </span>
  );
}
