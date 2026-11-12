// shadcn CLI 约定路径（components.json 的 @/lib/utils）。
// 当前源码无调用者，改用零依赖实现，避免为 6 行工具函数保留两个 npm 包。
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
