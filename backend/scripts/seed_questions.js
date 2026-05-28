require('dotenv').config();
const mysql = require('mysql2/promise');

const questions = [
  // Verbal comprehension
  {
    subject_slug: 'verbal_comprehension',
    qtype: '主旨概括',
    difficulty: 2,
    passage: '在经济全球化的背景下，各国之间的贸易往来日益频繁。然而，贸易保护主义的抬头给国际贸易带来了新的挑战。一些国家通过设置关税壁垒和非关税壁垒来保护本国产业，这种做法虽然短期内可能有利于本国企业，但从长远来看，不利于全球经济的健康发展。',
    stem: '这段文字主要说明了什么？',
    options_json: ['A. 经济全球化对各国贸易的影响', 'B. 贸易保护主义的危害', 'C. 关税壁垒的作用', 'D. 国际贸易的发展趋势'],
    answer: 'B',
    explanation: '文段重点强调贸易保护主义虽然短期有利，但长远不利于全球经济发展，主旨是说明其危害。',
    source_exam: '2024年国考真题'
  },
  {
    subject_slug: 'verbal_comprehension',
    qtype: '主旨概括',
    difficulty: 2,
    passage: '人工智能技术的快速发展，正在深刻改变着人们的生活方式。从智能家居到自动驾驶，从医疗诊断到金融分析，人工智能的应用场景越来越广泛。然而，人工智能的发展也带来了一些问题，如就业结构的变化、数据安全和隐私保护等。',
    stem: '根据这段文字，人工智能发展带来的问题不包括？',
    options_json: ['A. 就业结构变化', 'B. 数据安全问题', 'C. 隐私保护问题', 'D. 技术发展缓慢'],
    answer: 'D',
    explanation: '文段提到的问题包括就业结构变化、数据安全和隐私保护，不包括技术发展缓慢。',
    source_exam: '2024年省考真题'
  },
  {
    subject_slug: 'verbal_comprehension',
    qtype: '逻辑填空',
    difficulty: 1,
    passage: null,
    stem: '依次填入下面横线处的词语，最恰当的一组是：______的改革需要______的勇气和______的智慧。',
    options_json: ['A. 深入 坚定 超群', 'B. 深刻 果敢 非凡', 'C. 深层 英明 卓越', 'D. 深远 勇敢 杰出'],
    answer: 'B',
    explanation: '"深刻的改革"搭配恰当，"果敢的勇气"和"非凡的智慧"也是常用搭配。',
    source_exam: '2023年国考真题'
  },
  {
    subject_slug: 'verbal_comprehension',
    qtype: '主旨概括',
    difficulty: 3,
    passage: '传统文化是一个民族的精神命脉。在现代化进程中，如何传承和弘扬传统文化，是一个值得深思的问题。一方面，我们要保护传统文化的独特性，使其不被外来文化同化；另一方面，我们也要推动传统文化的创新发展，使其适应时代的需求。只有在传承中创新，在创新中传承，传统文化才能焕发出新的生命力。',
    stem: '作者认为传统文化应该如何发展？',
    options_json: ['A. 完全保留传统', 'B. 全面接受外来文化', 'C. 在传承中创新', 'D. 只注重创新发展'],
    answer: 'C',
    explanation: '文段最后明确指出"在传承中创新，在创新中传承"，答案为C。',
    source_exam: '2024年国考真题'
  },
  {
    subject_slug: 'verbal_comprehension',
    qtype: '主旨概括',
    difficulty: 2,
    passage: '乡村振兴战略是新时代做好"三农"工作的总抓手。实施乡村振兴战略，要坚持农业农村优先发展，按照产业兴旺、生态宜居、乡风文明、治理有效、生活富裕的总要求，建立健全城乡融合发展体制机制和政策体系，加快推进农业农村现代化。',
    stem: '乡村振兴战略的总要求不包括以下哪项？',
    options_json: ['A. 产业兴旺', 'B. 生态宜居', 'C. 科技领先', 'D. 生活富裕'],
    answer: 'C',
    explanation: '总要求包括产业兴旺、生态宜居、乡风文明、治理有效、生活富裕，不包括科技领先。',
    source_exam: '2023年省考真题'
  },
  // Politics
  {
    subject_slug: 'politics',
    qtype: '意图判断',
    difficulty: 2,
    passage: null,
    stem: '中国特色社会主义最本质的特征是什么？',
    options_json: ['A. 人民当家作主', 'B. 中国共产党领导', 'C. 公有制为主体', 'D. 依法治国'],
    answer: 'B',
    explanation: '习近平总书记指出，中国特色社会主义最本质的特征是中国共产党领导。',
    source_exam: '2024年国考真题'
  },
  {
    subject_slug: 'politics',
    qtype: '意图判断',
    difficulty: 2,
    passage: null,
    stem: '新发展理念包括哪些内容？',
    options_json: ['A. 创新、协调、绿色、开放、共享', 'B. 创新、协调、环保、开放、共享', 'C. 创新、统筹、绿色、开放、共享', 'D. 创新、协调、绿色、开放、公平'],
    answer: 'A',
    explanation: '新发展理念包括创新、协调、绿色、开放、共享五大发展理念。',
    source_exam: '2024年省考真题'
  },
  {
    subject_slug: 'politics',
    qtype: '意图判断',
    difficulty: 1,
    passage: null,
    stem: '我国社会主要矛盾已经转化为什么？',
    options_json: ['A. 人民日益增长的物质文化需要同落后的社会生产之间的矛盾', 'B. 人民日益增长的美好生活需要和不平衡不充分的发展之间的矛盾', 'C. 经济发展与环境保护之间的矛盾', 'D. 城乡发展不平衡的矛盾'],
    answer: 'B',
    explanation: '党的十九大报告指出，我国社会主要矛盾已经转化为人民日益增长的美好生活需要和不平衡不充分的发展之间的矛盾。',
    source_exam: '2023年国考真题'
  },
  {
    subject_slug: 'politics',
    qtype: '意图判断',
    difficulty: 3,
    passage: null,
    stem: '"四个自信"包括哪些？',
    options_json: ['A. 道路自信、理论自信、制度自信、文化自信', 'B. 道路自信、理论自信、制度自信、科技自信', 'C. 道路自信、理论自信、经济自信、文化自信', 'D. 政治自信、理论自信、制度自信、文化自信'],
    answer: 'A',
    explanation: '"四个自信"包括道路自信、理论自信、制度自信、文化自信。',
    source_exam: '2024年国考真题'
  },
  {
    subject_slug: 'politics',
    qtype: '意图判断',
    difficulty: 2,
    passage: null,
    stem: '全面建设社会主义现代化国家的首要任务是什么？',
    options_json: ['A. 高质量发展', 'B. 科技创新', 'C. 乡村振兴', 'D. 共同富裕'],
    answer: 'A',
    explanation: '党的二十大报告指出，高质量发展是全面建设社会主义现代化国家的首要任务。',
    source_exam: '2024年省考真题'
  }
];

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    charset: 'utf8mb4'
  });

  // Get subject IDs
  const [subjects] = await conn.query('SELECT id, slug FROM subject');
  const subjectMap = {};
  subjects.forEach(s => subjectMap[s.slug] = s.id);

  // Get admin user ID
  const [admins] = await conn.query("SELECT id FROM user WHERE role='admin' LIMIT 1");
  const adminId = admins.length > 0 ? admins[0].id : null;

  let inserted = 0;
  for (const q of questions) {
    const subjectId = subjectMap[q.subject_slug];
    if (!subjectId) continue;

    await conn.query(
      `INSERT INTO question (subject_id, qtype, difficulty, passage, stem, options_json, answer, explanation, source_exam, creator_user_id, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [subjectId, q.qtype, q.difficulty, q.passage, q.stem, JSON.stringify(q.options_json), q.answer, q.explanation, q.source_exam, adminId, 'approved']
    );
    inserted++;
  }

  console.log('Seeded ' + inserted + ' questions');
  
  const [count] = await conn.query('SELECT COUNT(*) AS total FROM question');
  console.log('Total questions in DB: ' + count[0].total);

  await conn.end();
})().catch(e => { console.error(e.message); process.exit(1); });