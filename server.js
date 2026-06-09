const express = require('express');
const morgan = require('morgan');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'db.json');
const USER_DB_PATH = path.join(__dirname, 'user.json');

app.use(morgan('dev'));
app.use(express.json());

// CORS Middleware with credentials support for Chrome Extension
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Cookie');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Helper to get local IP address
function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // Skip internal and non-IPv4 addresses
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// Normalize helper to match the extension's identification strategy
// Trim, lowercase, collapse spacing/newlines/tabs to a single space, but preserve special characters.
function normalizeText(text) {
  if (!text) return '';
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s\r\n\t]+/g, ' ') // replace any spacing with single space
    .trim();
}

// Database helper: Read Main DB
async function readDatabase() {
  try {
    const data = await fs.readFile(DB_PATH, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading database, resetting:', error.message);
    const initialDb = { questions: {} };
    await writeDatabase(initialDb);
    return initialDb;
  }
}

// Database helper: Write Main DB
async function writeDatabase(data) {
  await fs.writeFile(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
}

// Database helper: Read User DB
async function readUserDatabase() {
  try {
    const data = await fs.readFile(USER_DB_PATH, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading user database, resetting:', error.message);
    const initialUserDb = { users: {} };
    await writeUserDatabase(initialUserDb);
    return initialUserDb;
  }
}

// Database helper: Write User DB
async function writeUserDatabase(data) {
  await fs.writeFile(USER_DB_PATH, JSON.stringify(data, null, 2), 'utf8');
}

// Helper to extract cookie value
function getUserIdFromCookie(req) {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;)\s*userId\s*=\s*([^;]+)/);
  return match ? match[1] : null;
}

// Middleware to ensure user identification (cookie-based or header-based)
async function ensureUserId(req, res, next) {
  try {
    let userId = null;
    let mustSetCookie = false;

    // Check if userid header is present (case-insensitive in Express)
    const headerUserId = req.headers['userid'] || req.headers['user-id'];
    
    if (headerUserId) {
      userId = headerUserId;
      mustSetCookie = true; // Overwrite cookie to match the header value
    } else {
      userId = getUserIdFromCookie(req);
    }

    let userDb = await readUserDatabase();

    if (!userId) {
      // Generate new ID if none provided
      userId = 'usr_' + Math.random().toString(36).substring(2, 12) + '_' + Date.now().toString(36);
      userDb.users[userId] = { createdAt: Date.now() };
      await writeUserDatabase(userDb);
      mustSetCookie = true;
    } else if (!userDb.users[userId]) {
      // If a userId was provided but is unrecognized/missing
      if (headerUserId) {
        // Since the client explicitly requested this userId via header, register it
        userDb.users[userId] = { createdAt: Date.now() };
        await writeUserDatabase(userDb);
      } else {
        // If it came from a cookie, treat it as unrecognized (e.g. after reset) and overwrite it
        userId = 'usr_' + Math.random().toString(36).substring(2, 12) + '_' + Date.now().toString(36);
        userDb.users[userId] = { createdAt: Date.now() };
        await writeUserDatabase(userDb);
        mustSetCookie = true;
      }
    }

    req.userId = userId;

    if (mustSetCookie) {
      // Set a non-expiring cookie (Max-Age is 10 years in seconds: 315360000)
      res.setHeader('Set-Cookie', `userId=${userId}; Path=/; Max-Age=315360000; SameSite=Lax`);
    }

    next();
  } catch (error) {
    console.error('Error in ensureUserId middleware:', error);
    res.status(500).json({ success: false, error: 'Internal server error during authentication' });
  }
}

// REST Endpoint: Sync Question and Vote State
app.post('/api/questions/sync', ensureUserId, async (req, res) => {
  try {
    const { questionText, optionTexts, selectedOptionText } = req.body;
    const userId = req.userId;
    
    if (!questionText || !optionTexts || !Array.isArray(optionTexts)) {
      return res.status(400).json({ success: false, error: 'Missing required parameters' });
    }
    
    const qKey = normalizeText(questionText);
    const db = await readDatabase();
    
    // Initialize question in database if new
    if (!db.questions[qKey]) {
      db.questions[qKey] = {
        questionText: questionText,
        normalizedText: qKey,
        options: optionTexts.map(text => ({
          text: text,
          normalizedText: normalizeText(text),
          userIds: []
        })),
        createdAt: Date.now()
      };
    } else {
      // Validate that existing options match incoming options
      // (in case of subtle spacing edits in dynamic DOM)
      const existingOpts = db.questions[qKey].options;
      const existingTexts = existingOpts.map(o => o.normalizedText);
      const incomingNorms = optionTexts.map(t => normalizeText(t));
      
      const optionsMatch = incomingNorms.every(n => existingTexts.includes(n)) &&
                           incomingNorms.length === existingTexts.length;
      
      if (!optionsMatch) {
        // Options changed or shuffled differently, re-initialize
        db.questions[qKey].options = optionTexts.map(text => ({
          text: text,
          normalizedText: normalizeText(text),
          userIds: []
        }));
      }
    }
    
    const optKey = selectedOptionText ? normalizeText(selectedOptionText) : null;
    
    // Remove this user's ID from all options under this question to clear any existing vote
    db.questions[qKey].options.forEach(opt => {
      opt.userIds = opt.userIds.filter(id => id !== userId);
    });
    
    // Add this user's ID to the selected option if specified
    if (optKey) {
      const selectedOpt = db.questions[qKey].options.find(opt => opt.normalizedText === optKey);
      if (selectedOpt) {
        selectedOpt.userIds.push(userId);
      }
    }
    
    await writeDatabase(db);
    
    // Find which option currently contains the user's ID
    const userSelectedOpt = db.questions[qKey].options.find(opt => opt.userIds.includes(userId));
    const userSelection = userSelectedOpt ? userSelectedOpt.text : null;
    
    res.json({
      success: true,
      data: {
        questionText: db.questions[qKey].questionText,
        options: db.questions[qKey].options,
        selectedOption: userSelection
      }
    });
    
  } catch (error) {
    console.error('Error in /sync:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// REST Endpoint: Get Dashboard Stats and Question list
app.get('/api/stats', ensureUserId, async (req, res) => {
  try {
    const userId = req.userId;
    const db = await readDatabase();
    
    const questionsList = Object.values(db.questions);
    const totalParsed = questionsList.length;
    
    // Count how many questions this user has voted on
    let totalAnswered = 0;
    questionsList.forEach(q => {
      const userHasVoted = q.options.some(opt => opt.userIds.includes(userId));
      if (userHasVoted) {
        totalAnswered++;
      }
    });
    
    // Add active selections on questions array returned to popup
    const questionsResponse = questionsList.map(q => {
      const userSelectedOpt = q.options.find(opt => opt.userIds.includes(userId));
      return {
        ...q,
        selectedOption: userSelectedOpt ? userSelectedOpt.text : null
      };
    });
    
    res.json({
      success: true,
      stats: {
        totalParsed,
        totalAnswered
      },
      questions: questionsResponse
    });
    
  } catch (error) {
    console.error('Error in /stats:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// REST Endpoint: Reset / Wipe DB
app.delete('/api/questions', async (req, res) => {
  try {
    // Reset main DB
    const freshDb = { questions: {} };
    await writeDatabase(freshDb);

    // Reset User DB
    const freshUserDb = { users: {} };
    await writeUserDatabase(freshUserDb);

    res.json({ success: true, message: 'Database reset successfully' });
  } catch (error) {
    console.error('Error resetting database:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// REST Endpoint: Reset via GET route with password protection
app.get('/api/reset/:password', async (req, res) => {
  try {
    const { password } = req.params;
    if (password === 'dumdumhot') {
      // Reset main DB
      const freshDb = { questions: {} };
      await writeDatabase(freshDb);

      // Reset User DB
      const freshUserDb = { users: {} };
      await writeUserDatabase(freshUserDb);

      return res.json({ success: true, message: 'Database reset successfully' });
    } else {
      return res.status(401).json({ success: false, error: 'Unauthorized: Incorrect password' });
    }
  } catch (error) {
    console.error('Error resetting database:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Fallback error handler
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Route not found' });
});

app.listen(PORT, () => {
  const localIp = getLocalIpAddress();
  console.log(`MCQ Sync server listening at http://localhost:${PORT}`);
  console.log(`Access from another device on the same network: http://${localIp}:${PORT}`);
});
