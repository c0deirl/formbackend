var fs = require('fs');
var c = fs.readFileSync('server.js', 'utf8');

// 1. Fix tab on service line - replace 3 tabs with 12 spaces
c = c.replace(/^\t+\.replace/, '            .replace');
// Remove any remaining tabs
c = c.replace(/\t/g, '    ');

// 2. Fix mailOptions indentation line
c = c.replace('\nconst mailOptions = {', '\n        const mailOptions = {');

// 3. Add return before res.redirect
c = c.replace('res.redirect(302, recipientConfig.redirectUrl);', 'return res.redirect(302, recipientConfig.redirectUrl);');

// 4. Fix /logs GET endpoint - use in-memory fallback
c = c.replace('res.json([]);', 'res.json([...submissionLogs].reverse()); // Fallback to in-memory logs');

fs.writeFileSync('server.js', c);
console.log('FIXES APPLIED');