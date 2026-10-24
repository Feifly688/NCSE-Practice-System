/**
 * 端到端验证：上传含图形的 PDF → 拆题 → 检查区域截图是否生成并挂载。
 * 用法：node scripts/e2e_paper_images.js <pdf路径>
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const { withConnection, closePool } = require('../src/db');

async function main() {
  const BASE = process.env.E2E_BASE || 'http://127.0.0.1:4000';
  const pdfPath = process.argv[2] || '/tmp/test-box.pdf';
    // 临时管理员账号（结束时删除）——服务器 .env 里没配 ADMIN_* 凭据
  const tmpUser = 'e2e_img_' + Date.now();
  const tmpPass = 'E2eTest' + Date.now();
  const bcrypt = require('bcryptjs');
  await withConnection(async (conn) => {
    await conn.query(
      "INSERT INTO `user` (username, nickname, password_hash, role, status) VALUES (?,?,?,'admin','active')",
      [tmpUser, 'E2E图片测试', await bcrypt.hash(tmpPass, 10)]
    );
  });
  console.log('0) 临时管理员已创建:', tmpUser);

  const adminUser = tmpUser;
  const adminPass = tmpPass;

  // 1. 登录
  const lr = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: adminUser, password: adminPass }),
  });
  const lj = await lr.json();
  if (!lj.token) { console.error('登录失败:', JSON.stringify(lj).slice(0, 200)); process.exit(1); }
  const token = lj.token;
  console.log('1) 管理员登录成功');

  // 2. 上传
  const buf = fs.readFileSync(pdfPath);
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'application/pdf' }), path.basename(pdfPath));
  form.append('title', 'E2E图形卷');
  const ur = await fetch(`${BASE}/api/admin/exam-papers/upload`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
  });
  const uj = await ur.json();
  if (!uj.id) { console.error('上传失败:', JSON.stringify(uj).slice(0, 300)); process.exit(1); }
  const paperId = uj.id;
  console.log('2) 上传成功 paperId =', paperId, '| 文本长度 =', uj.textLength, '| 方法 =', uj.method);

  // 3. 原 PDF 是否落盘
  const pdfSaved = path.resolve(__dirname, '../uploads/papers', `${paperId}.pdf`);
  console.log('3) 原始 PDF 落盘:', fs.existsSync(pdfSaved) ? `是 (${fs.statSync(pdfSaved).size} 字节)` : '否');

  // 4. 轮询拆题状态
  let status = 'pending';
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const sr = await fetch(`${BASE}/api/admin/exam-papers/${paperId}/parse-status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const sj = await sr.json();
    status = sj.parse_status || sj.status;
    if (['success', 'partial', 'failed'].includes(status)) break;
  }
  console.log('4) 拆题状态:', status);

  // 5. 检查图片挂载
  await withConnection(async (conn) => {
    const [qs] = await conn.query(
      'SELECT seq, section, stem, image_url, options_json FROM exam_paper_question WHERE exam_paper_id = ? ORDER BY seq',
      [paperId]
    );
    console.log('5) 题目数:', qs.length);
    for (const q of qs) {
      let opts = [];
      try { opts = JSON.parse(q.options_json); } catch (e) {}
      console.log(`   seq=${q.seq} image_url=${q.image_url || '(无)'} | ${JSON.stringify(q.stem.slice(0, 34))} | opts=${JSON.stringify(opts).slice(0, 50)}`);
    }
    const withImg = qs.filter((q) => q.image_url);
    console.log('   带截图题数:', withImg.length);

    // 6. 校验图片文件存在且可访问
    for (const q of withImg) {
      for (const f of String(q.image_url).split(',')) {
        const abs = path.resolve(__dirname, '../../uploads/papers/paper-images', String(paperId), f);
        const ok = fs.existsSync(abs);
        const rr = await fetch(`${BASE}/api/exam-papers/images/${paperId}/${f}?t=${token}`);
        console.log(`   图片 ${f}: 文件${ok ? '存在' : '缺失'} HTTP=${rr.status} type=${rr.headers.get('content-type')} size=${ok ? fs.statSync(abs).size : 0}`);
      }
    }

    // 7. 整卷接口是否返回 images
    const pr = await fetch(`${BASE}/api/exam-papers/${paperId}`, { headers: { Authorization: `Bearer ${token}` } });
    const pj = await pr.json();
    const first = pj.sections?.[0]?.questions?.[0];
    console.log('7) 整卷接口 images 字段:', JSON.stringify(first?.images || null));
    console.log('   分区:', (pj.sections || []).map((s) => `${s.name}(${s.count})`).join(' '));
  });

  // 8. 清理测试数据
  await withConnection(async (conn) => {
    await conn.query('DELETE FROM exam_paper_question WHERE exam_paper_id = ?', [paperId]);
    await conn.query('DELETE FROM exam_paper WHERE id = ?', [paperId]);
  });
  const imgDir = path.resolve(__dirname, '../uploads/papers/paper-images', String(paperId));
  if (fs.existsSync(imgDir)) fs.rmSync(imgDir, { recursive: true, force: true });
  if (fs.existsSync(pdfSaved)) fs.rmSync(pdfSaved, { force: true });
  await withConnection(async (conn) => {
    await conn.query('DELETE FROM `user` WHERE username = ?', [tmpUser]);
  });
  console.log('8) 测试数据与临时账号已清理');
}

main().catch((e) => { console.error('ERR', e.message, e.stack); process.exit(1); });
