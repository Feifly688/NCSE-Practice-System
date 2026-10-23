import React from 'react';
import { Checkbox, Typography } from 'antd';
import { useAuth } from '../contexts/AuthContext';

const { Text } = Typography;

/**
 * 「记住我」勾选项 + 时效提示。
 *
 * 时效文案来自后端 GET /api/auth/session-policy（由运维的 JWT_EXPIRES_IN /
 * JWT_EXPIRES_SHORT 决定），不在前端硬编码，避免配置改了而文案说谎。
 *
 * @param {{
 *   checked: boolean;
 *   onChange: (checked: boolean) => void;
 *   dark?: boolean;
 *   style?: React.CSSProperties;
 * }} props
 */
export default function RememberMeField({ checked, onChange, dark = true, style }) {
  const { sessionPolicy } = useAuth();
  const longLabel = sessionPolicy?.long?.label || '7 天';
  const shortLabel = sessionPolicy?.short?.label || '2 小时';

  const textColor = dark ? 'rgba(255,255,255,0.78)' : undefined;
  const hintColor = dark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.45)';

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', ...style }}>
      <Checkbox checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ color: textColor }}>
        记住我
      </Checkbox>
      <Text style={{ fontSize: 11, color: hintColor }}>
        {checked ? `${longLabel}内免登录` : `${shortLabel}后需重新登录`}
      </Text>
    </div>
  );
}
