/**
 * 题库维护：① 按 fingerprint 去重 question 表；② 重建二级/三级分类映射。
 *
 * 背景：
 *   · 回流时同 fingerprint 理论上只保留首条，但早期版本留下过重复行
 *     （同一题在 question 表里出现多次，答题/错题记录引用的可能是不同副本）。
 *   · autoTag 的旧规则导致大量题挂错二级分类，规则修好后需要清掉旧映射重打
 *     （一级模块映射来自 section，可靠，保留）。
 *
 * 用法：node scripts/dedupe_questions.js   （幂等，可重复跑）
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { withConnection } = require('../src/db');

(async () => {
  await withConnection(async (conn) => {
    await conn.beginTransaction();

    try {
      // ── ① 指纹去重：每组只留最小 id，其余副本的引用先迁到保留行 ──
      const [dups] = await conn.query(
        `SELECT fingerprint, MIN(id) AS keep_id, GROUP_CONCAT(id ORDER BY id) AS all_ids
           FROM question GROUP BY fingerprint HAVING COUNT(*) > 1`
      );
      let removed = 0;
      for (const d of dups) {
        const ids = d.all_ids.split(',').map(Number);
        const dupIds = ids.filter((x) => x !== d.keep_id);
        // 引用迁移：能迁的迁（撞唯一键的会被 IGNORE 跳过）
        for (const table of ['practice_answer', 'wrong_book', 'favorite']) {
          await conn.query(
            `UPDATE IGNORE ${table} SET question_id = ? WHERE question_id IN (${dupIds.join(',')})`,
            [d.keep_id]);
        }
        await conn.query(
          `UPDATE IGNORE question_category_map SET ref_id = ? WHERE pool='question' AND ref_id IN (${dupIds.join(',')})`,
          [d.keep_id]);
        // 清掉仍指向副本的答题记录（同一场练习里两份重复题的作答），再删副本
        await conn.query(`DELETE FROM practice_answer WHERE question_id IN (${dupIds.join(',')})`);
        await conn.query(`DELETE FROM wrong_book WHERE question_id IN (${dupIds.join(',')})`);
        await conn.query(`DELETE FROM favorite WHERE question_id IN (${dupIds.join(',')})`);
        await conn.query(`DELETE FROM question_category_map WHERE pool='question' AND ref_id IN (${dupIds.join(',')})`);
        await conn.query(`DELETE FROM question WHERE id IN (${dupIds.join(',')})`);
        removed += dupIds.length;
      }
      console.log(`去重: ${dups.length} 组，删除 ${removed} 行`);

      // ── ② 清掉二级/三级分类映射（一级模块映射保留，来自 section 可靠） ──
      const [cleared] = await conn.query(
        `DELETE m FROM question_category_map m
          JOIN question_category c ON c.id = m.category_id
         WHERE m.pool = 'question' AND c.level >= 2`
      );
      console.log(`清除旧二级/三级映射: ${cleared.affectedRows ?? cleared.length ?? 'ok'} 条`);

      await conn.commit();
      console.log('完成。下一步：node src/lib/autoTag.js 重打二级分类');
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  });
  process.exit(0);
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
