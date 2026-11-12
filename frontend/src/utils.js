export function parseOptions(opts) {
  if (Array.isArray(opts)) return opts;
  try { return JSON.parse(opts); } catch(e) { return []; }
}

export function cleanOption(text) {
  if (!text) return '';
  return text.replace(/^[A-D][.、．]\s*/, '');
}

export function formatTime(seconds) {
  const absSeconds = Math.abs(seconds);
  const m = Math.floor(absSeconds / 60);
  const s = absSeconds % 60;
  return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
}

/** 让可点击的非按钮元素支持键盘激活：Enter / Space 触发同一逻辑，Space 阻止页面滚动；
 *  事件来自内部表单控件/按钮时不接管，避免破坏其原生键盘交互。 */
export function activateOnKey(e, action) {
  if (e.target !== e.currentTarget) return;
  if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
    e.preventDefault();
    action();
  }
}
