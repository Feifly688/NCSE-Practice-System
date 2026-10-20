import React from 'react';

export type CoverKind = 'source' | 'practice' | 'history' | 'wrongbook' | 'security';

const PALETTE: Record<CoverKind, { accent: string; deep: string }> = {
  source: { accent: '#60A5FA', deep: '#0f1d3a' },
  practice: { accent: '#34D399', deep: '#0c2b26' },
  history: { accent: '#A78BFA', deep: '#1d1233' },
  wrongbook: { accent: '#FBBF24', deep: '#2b1c07' },
  security: { accent: '#22D3EE', deep: '#07242e' },
};

/**
 * 亮点卡片封面：纯本地 SVG 绘制，不依赖任何外链图片。
 *
 * 早先的封面来自 Unsplash 外链，其中一个 URL 失效导致破图，
 * 且外链会被限流。改用矢量绘制后：永不破图、零网络请求、
 * 主题与文案一致，并可与深色首页保持统一质感。
 */
export default function HighlightCover({ kind }: { kind: CoverKind }) {
  const { accent, deep } = PALETTE[kind];
  const gid = `grad-${kind}`;
  const gridId = `grid-${kind}`;
  const glowId = `glow-${kind}`;

  return (
    <svg
      viewBox="0 0 1200 640"
      preserveAspectRatio="xMidYMid slice"
      role="presentation"
      aria-hidden="true"
      style={{ width: '100%', height: '100%', display: 'block' }}
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={deep} />
          <stop offset="58%" stopColor="#0a0a0f" />
          <stop offset="100%" stopColor="#080810" />
        </linearGradient>
        <radialGradient id={glowId} cx="0.72" cy="0.18" r="0.75">
          <stop offset="0%" stopColor={accent} stopOpacity="0.30" />
          <stop offset="60%" stopColor={accent} stopOpacity="0.06" />
          <stop offset="100%" stopColor={accent} stopOpacity="0" />
        </radialGradient>
        <pattern id={gridId} width="46" height="46" patternUnits="userSpaceOnUse">
          <path d="M46 0H0V46" fill="none" stroke={accent} strokeOpacity="0.09" strokeWidth="1" />
        </pattern>
      </defs>

      <rect width="1200" height="640" fill={`url(#${gid})`} />
      <rect width="1200" height="640" fill={`url(#${gridId})`} />
      <rect width="1200" height="640" fill={`url(#${glowId})`} />

      {/* ── 权威来源：层叠文稿 ── */}
      {kind === 'source' && (
        <g>
          <g stroke={accent} fill="none" strokeWidth="2">
            <rect x="742" y="108" width="318" height="404" rx="14" opacity="0.18" />
            <rect x="702" y="142" width="318" height="404" rx="14" opacity="0.32" />
            <rect x="662" y="176" width="318" height="404" rx="14" opacity="0.62" />
          </g>
          <g stroke={accent} strokeWidth="3" strokeLinecap="round" opacity="0.45">
            <line x1="700" y1="248" x2="942" y2="248" />
            <line x1="700" y1="300" x2="918" y2="300" />
            <line x1="700" y1="352" x2="932" y2="352" />
            <line x1="700" y1="404" x2="856" y2="404" />
          </g>
          <circle cx="932" cy="520" r="26" fill={accent} opacity="0.16" />
          <circle cx="932" cy="520" r="10" fill={accent} opacity="0.7" />
        </g>
      )}

      {/* ── 智能练习：节点网络 ── */}
      {kind === 'practice' && (
        <g>
          <g stroke={accent} strokeWidth="2" opacity="0.30">
            <line x1="760" y1="200" x2="900" y2="150" />
            <line x1="760" y1="200" x2="860" y2="300" />
            <line x1="900" y1="150" x2="1000" y2="240" />
            <line x1="860" y1="300" x2="1000" y2="240" />
            <line x1="860" y1="300" x2="820" y2="430" />
            <line x1="820" y1="430" x2="960" y2="470" />
            <line x1="1000" y1="240" x2="960" y2="470" />
          </g>
          <g fill={accent}>
            <circle cx="760" cy="200" r="12" opacity="0.9" />
            <circle cx="900" cy="150" r="17" opacity="0.75" />
            <circle cx="1000" cy="240" r="13" opacity="0.9" />
            <circle cx="860" cy="300" r="21" opacity="0.6" />
            <circle cx="820" cy="430" r="11" opacity="0.85" />
            <circle cx="960" cy="470" r="16" opacity="0.7" />
          </g>
          <circle cx="860" cy="300" r="48" fill="none" stroke={accent} strokeWidth="1.5" opacity="0.35" />
          <circle cx="860" cy="300" r="78" fill="none" stroke={accent} strokeWidth="1" opacity="0.16" />
        </g>
      )}

      {/* ── 答题历史：柱状图 + 趋势线 ── */}
      {kind === 'history' && (
        <g>
          <g fill={accent} opacity="0.75">
            <rect x="700" y="392" width="44" height="120" rx="7" opacity="0.45" />
            <rect x="770" y="336" width="44" height="176" rx="7" opacity="0.6" />
            <rect x="840" y="272" width="44" height="240" rx="7" opacity="0.8" />
            <rect x="910" y="318" width="44" height="194" rx="7" opacity="0.65" />
            <rect x="980" y="216" width="44" height="296" rx="7" opacity="0.9" />
          </g>
          <polyline
            points="722,376 792,320 862,254 932,300 1002,198"
            fill="none"
            stroke={accent}
            strokeWidth="3.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity="0.95"
          />
          <g fill="#0a0a0f" stroke={accent} strokeWidth="3">
            <circle cx="722" cy="376" r="7" />
            <circle cx="792" cy="320" r="7" />
            <circle cx="862" cy="254" r="7" />
            <circle cx="932" cy="300" r="7" />
            <circle cx="1002" cy="198" r="7" />
          </g>
          <line x1="686" y1="512" x2="1054" y2="512" stroke={accent} strokeWidth="2" opacity="0.35" />
        </g>
      )}

      {/* ── 错题本 & 收藏：清单 + 星标 ── */}
      {kind === 'wrongbook' && (
        <g>
          <g stroke={accent} fill="none" strokeWidth="2">
            <rect x="700" y="150" width="330" height="80" rx="12" opacity="0.5" />
            <rect x="700" y="256" width="330" height="80" rx="12" opacity="0.35" />
            <rect x="700" y="362" width="330" height="80" rx="12" opacity="0.22" />
          </g>
          <g stroke={accent} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" fill="none" opacity="0.85">
            <path d="M726 190l10 11 17-22" />
            <path d="M726 296l10 11 17-22" />
            <path d="M726 402l10 11 17-22" />
          </g>
          <path
            d="M960 96l14 31 34 4-25 23 7 33-30-17-30 17 7-33-25-23 34-4z"
            fill={accent}
            opacity="0.85"
          />
        </g>
      )}

      {/* ── 数据安全：盾牌 + 锁 + 六边网格 ── */}
      {kind === 'security' && (
        <g>
          <g stroke={accent} strokeWidth="1.5" opacity="0.20" fill="none">
            <polygon points="880,120 980,175 980,320 880,375 780,320 780,175" />
            <polygon points="880,170 940,203 940,292 880,325 820,292 820,203" />
          </g>
          <path
            d="M880 140l96 42v104c0 72-52 118-96 138-44-20-96-66-96-138V182z"
            fill="none"
            stroke={accent}
            strokeWidth="3.5"
            opacity="0.85"
          />
          <path
            d="M880 178l64 28v78c0 50-35 82-64 96-29-14-64-46-64-96v-78z"
            fill={accent}
            opacity="0.12"
          />
          <rect x="852" y="286" width="56" height="46" rx="8" fill="none" stroke={accent} strokeWidth="3.5" opacity="0.9" />
          <path d="M864 286v-14a16 16 0 0132 0v14" fill="none" stroke={accent} strokeWidth="3.5" opacity="0.9" />
          <circle cx="880" cy="308" r="5" fill={accent} opacity="0.95" />
        </g>
      )}
    </svg>
  );
}
