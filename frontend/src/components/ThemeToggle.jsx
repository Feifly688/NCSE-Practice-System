import React from 'react';
import { Tooltip, Button, Dropdown } from 'antd';
import { BulbOutlined, MoonOutlined, DesktopOutlined } from '@ant-design/icons';
import { useTheme } from '../contexts/ThemeContext';

/**
 * 日夜模式切换按钮。
 *
 * 交互：单击按钮直接在日/夜间之间切换（粉笔的页头按钮就是这样）；
 * 右键菜单可选择「日间 / 夜间 / 跟随系统」。
 * 注意 Dropdown 必须用 contextMenu 触发 —— 用 click 会把点击吃掉，
 * 导致单击按钮只弹出菜单而不切换主题。
 */
export default function ThemeToggle({ size = 'small', style }) {
  const { mode, resolved, isDark, setMode } = useTheme();

  const Icon = mode === 'system' ? DesktopOutlined : (isDark ? MoonOutlined : BulbOutlined);
  const label = mode === 'system' ? '跟随系统' : (isDark ? '夜间模式' : '日间模式');

  const items = [
    { key: 'light', label: '日间模式', icon: <BulbOutlined /> },
    { key: 'dark', label: '夜间模式', icon: <MoonOutlined /> },
    { key: 'system', label: '跟随系统', icon: <DesktopOutlined /> },
  ];

  return (
    <Dropdown
      menu={{
        items,
        selectable: true,
        selectedKeys: [mode],
        onClick: ({ key }) => setMode(key),
      }}
      trigger={['contextMenu']}
      placement="bottomRight"
    >
      <Tooltip title={`主题：${label}（点击切换）`}>
        <Button
          type="text"
          size={size}
          icon={<Icon />}
          aria-label="切换日夜模式"
          data-theme-toggle="1"
          onClick={() => setMode(resolved === 'dark' ? 'light' : 'dark')}
          style={{ color: 'inherit', ...style }}
        />
      </Tooltip>
    </Dropdown>
  );
}
