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
