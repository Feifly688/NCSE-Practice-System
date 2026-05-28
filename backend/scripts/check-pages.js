const fs = require('fs');
const path = require('path');

const pages = [
  'frontend/src/pages/Home.jsx',
  'frontend/src/pages/Login.jsx',
  'frontend/src/pages/Register.jsx',
  'frontend/src/pages/Dashboard.jsx',
  'frontend/src/pages/Practice.jsx',
  'frontend/src/pages/History.jsx',
  'frontend/src/pages/WrongBook.jsx',
  'frontend/src/pages/Favorites.jsx',
  'frontend/src/pages/admin/AdminHome.jsx',
  'frontend/src/pages/admin/Questions.jsx',
  'frontend/src/pages/admin/Users.jsx',
  'frontend/src/pages/admin/Generate.jsx',
  'frontend/src/pages/admin/Articles.jsx',
];

for (const p of pages) {
  try {
    const content = fs.readFileSync(p, 'utf8');
    // Check for common issues
    const issues = [];
    
    // Check for garbled text (non-ASCII in unexpected places)
    const garbledMatch = content.match(/[\u00c0-\u00ff]{3,}/g);
    if (garbledMatch) issues.push('possible garbled text: ' + garbledMatch[0]);
    
    // Check for undefined imports
    if (content.includes('useNavigate') && !content.includes('import.*useNavigate')) issues.push('useNavigate used but not imported');
    if (content.includes('useSearchParams') && !content.includes('import.*useSearchParams')) issues.push('useSearchParams used but not imported');
    if (content.includes('useParams') && !content.includes('import.*useParams')) issues.push('useParams used but not imported');
    
    // Check for mismatched braces
    const openBraces = (content.match(/{/g) || []).length;
    const closeBraces = (content.match(/}/g) || []).length;
    if (openBraces !== closeBraces) issues.push('brace mismatch: { = ' + openBraces + ', } = ' + closeBraces);
    
    // Check for mismatched parens
    const openParens = (content.match(/\(/g) || []).length;
    const closeParens = (content.match(/\)/g) || []).length;
    if (openParens !== closeParens) issues.push('paren mismatch: ( = ' + openParens + ', ) = ' + closeParens);
    
    if (issues.length > 0) {
      console.log(p + ': ' + issues.join(', '));
    } else {
      console.log(p + ': OK');
    }
  } catch (err) {
    console.log(p + ': ERROR - ' + err.message);
  }
}