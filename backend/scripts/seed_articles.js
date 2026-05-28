require('dotenv').config();
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const articles = [
  {
    source: '人民日报',
    title: '坚持人民至上 谱写中国式现代化新篇章',
    url: 'http://opinion.people.com.cn/n1/2025/0520/c1003-example1.html',
    publish_time: '2025-05-20 08:30:00',
    author: '人民日报评论部',
    clean_text: '中国式现代化是全体人民共同富裕的现代化。坚持以人民为中心的发展思想，不断实现发展为了人民、发展依靠人民、发展成果由人民共享，让现代化建设成果更多更公平惠及全体人民。人民是历史的创造者，是决定党和国家前途命运的根本力量。必须坚持人民至上，站稳人民立场，把握人民愿望，尊重人民创造，集中人民智慧。'
  },
  {
    source: '人民日报',
    title: '以科技创新引领高质量发展',
    url: 'http://opinion.people.com.cn/n1/2025/0519/c1003-example2.html',
    publish_time: '2025-05-19 09:15:00',
    author: '人民日报记者',
    clean_text: '科技创新是发展新质生产力的核心要素。当前，新一轮科技革命和产业变革深入发展，科技创新成为国际战略博弈的主要战场。我们要加快实现高水平科技自立自强，以科技创新引领产业创新，积极培育和发展新质生产力。要加强基础研究，强化关键核心技术攻关，推动科技成果转化应用。'
  },
  {
    source: '新华社',
    title: '坚定不移推进全面深化改革',
    url: 'http://www.xinhuanet.com/politics/2025-05/20/c_example3.htm',
    publish_time: '2025-05-20 10:00:00',
    author: '新华社评论员',
    clean_text: '全面深化改革是推进中国式现代化的根本动力。面对新形势新任务，必须紧紧围绕全面建设社会主义现代化国家的目标，突出重点，对准焦距，找准穴位，击中要害，推出一批能叫得响、立得住、群众认可的硬招实招。要把改革重点放到解决实际问题上来，多推有利于增添经济发展动力的改革。'
  },
  {
    source: '新华社',
    title: '加快建设现代化经济体系',
    url: 'http://www.xinhuanet.com/fortune/2025-05/19/c_example4.htm',
    publish_time: '2025-05-19 14:30:00',
    author: '新华社记者',
    clean_text: '建设现代化经济体系是跨越关口的迫切要求和我国发展的战略目标。要大力发展实体经济，筑牢现代化经济体系的坚实基础。要加快实施创新驱动发展战略，强化现代化经济体系的战略支撑。要积极推动城乡区域协调发展，优化现代化经济体系的空间布局。要着力发展开放型经济，提高现代化经济体系的国际竞争力。'
  },
  {
    source: '学习强国',
    title: '深刻理解新发展理念的科学内涵',
    url: 'https://www.xuexi.cn/lgpage/detail/example5.html',
    publish_time: '2025-05-18 09:00:00',
    author: '学习平台',
    clean_text: '新发展理念是一个系统的理论体系。创新是引领发展的第一动力，协调是持续健康发展的内在要求，绿色是永续发展的必要条件和人民对美好生活追求的重要体现，开放是国家繁荣发展的必由之路，共享是中国特色社会主义的本质要求。要坚持系统观念，把新发展理念完整、准确、全面贯穿发展全过程和各领域。'
  },
  {
    source: '学习强国',
    title: '推进国家治理体系和治理能力现代化',
    url: 'https://www.xuexi.cn/lgpage/detail/example6.html',
    publish_time: '2025-05-17 10:30:00',
    author: '学习平台',
    clean_text: '国家治理体系和治理能力是一个国家制度和制度执行能力的集中体现。推进国家治理体系和治理能力现代化，是完善和发展中国特色社会主义制度的必然要求，是实现社会主义现代化的应有之义。要强化制度意识，带头维护制度权威，做制度执行的表率，带动全党全社会自觉尊崇制度、严格执行制度、坚决维护制度。'
  },
  {
    source: '人民日报',
    title: '推动绿色发展 建设美丽中国',
    url: 'http://opinion.people.com.cn/n1/2025/0518/c1003-example7.html',
    publish_time: '2025-05-18 08:00:00',
    author: '人民日报记者',
    clean_text: '绿水青山就是金山银山。生态环境保护和经济发展不是矛盾对立的关系，而是辩证统一的关系。推动绿色发展，建设美丽中国，要正确处理好高质量发展和高水平保护的关系，正确处理好重点攻坚和协同治理的关系，正确处理好自然恢复和人工修复的关系，正确处理好外部约束和内生动力的关系。'
  },
  {
    source: '新华社',
    title: '牢牢把握高质量发展这个首要任务',
    url: 'http://www.xinhuanet.com/politics/2025-05/18/c_example8.htm',
    publish_time: '2025-05-18 11:00:00',
    author: '新华社评论员',
    clean_text: '高质量发展是全面建设社会主义现代化国家的首要任务。发展是党执政兴国的第一要务，没有坚实的物质技术基础，就不可能全面建成社会主义现代化强国。必须完整、准确、全面贯彻新发展理念，坚持社会主义市场经济改革方向，坚持高水平对外开放，加快构建以国内大循环为主体、国内国际双循环相互促进的新发展格局。'
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

  let inserted = 0;
  for (const a of articles) {
    const fp = crypto.createHash('md5').update(a.url).digest('hex');
    await conn.query(
      'INSERT IGNORE INTO article (source, title, url, publish_time, author, clean_text, fingerprint) VALUES (?,?,?,?,?,?,?)',
      [a.source, a.title, a.url, a.publish_time, a.author, a.clean_text, fp]
    );
    inserted++;
  }

  console.log('Seeded ' + inserted + ' articles');
  const [count] = await conn.query('SELECT COUNT(*) AS total FROM article');
  console.log('Total articles in DB: ' + count[0].total);

  await conn.end();
})().catch(e => { console.error(e.message); process.exit(1); });