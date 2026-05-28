const fs = require('fs');
let c = fs.readFileSync('frontend/src/pages/Practice.jsx', 'utf8');

// Add StarOutlined import
c = c.replace("PauseCircleOutlined } from '@ant-design/icons';", "PauseCircleOutlined, StarOutlined } from '@ant-design/icons';");

// Add favorite button in result cards
const oldTag = "<div style={{ marginBottom: 8 }}><Tag color={isCorrect ? 'green' : 'red'}>{isCorrect ? '\u6B63\u786E' : '\u9519\u8BEF'}</Tag><Text type=\"secondary\"> \u7B2C {idx + 1} \u9898</Text></div>";
const newTag = "<div style={{ marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><div><Tag color={isCorrect ? 'green' : 'red'}>{isCorrect ? '\u6B63\u786E' : '\u9519\u8BEF'}</Tag><Text type=\"secondary\"> \u7B2C {idx + 1} \u9898</Text></div><Button size=\"small\" icon={<StarOutlined />} onClick={async () => { try { await api.post('/practice/favorites', { question_id: q.id }); message.success('\u5DF2\u6536\u85CF'); } catch(e) { message.error('\u6536\u85CF\u5931\u8D25'); } }}>\u6536\u85CF</Button></div>";
c = c.replace(oldTag, newTag);

fs.writeFileSync('frontend/src/pages/Practice.jsx', c, 'utf8');
console.log('Done');