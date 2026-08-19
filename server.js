// Install dependencies: npm install express body-parser nodemailer
const express = require('express');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const multer = require('multer');
const config = require('./config.json');

// Helper to always read fresh config from disk for admin APIs
async function loadAdminConfig() {
    const raw = await fs.readFile(path.join(__dirname, 'config.json'), 'utf8');
    return JSON.parse(raw);
}

// ==================== Submission Logs ====================
let submissionLogs = [];

async function loadLogs() {
    try {
        const raw = await fs.readFile(path.join(__dirname, 'logs.json'), 'utf8');
        const loaded = JSON.parse(raw);
        if (submissionLogs.length === 0) submissionLogs = loaded;
    } catch (e) {
        submissionLogs = [];
    }
}
loadLogs(); // Load logs on startup (background, non-blocking)

async function appendLog(entry) {
    const logEntry = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        timestamp: new Date().toISOString(),
        ...entry
    };
    submissionLogs.push(logEntry);
    if (submissionLogs.length > 500) submissionLogs = submissionLogs.slice(-500);
    try {
        await fs.writeFile(path.join(__dirname, 'logs.json'), JSON.stringify(submissionLogs, null, 4));
    } catch (e) {
        console.error('Failed to persist log entry:', e);
    }
    return logEntry;
}

const app = express();
const PORT = process.env.PORT || 3000;
const DEBUG = process.env.DEBUG === 'true';

// Override config with environment variables if provided
if (process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD) {
    if (!config.admin) config.admin = {};
    config.admin.username = process.env.ADMIN_USERNAME;
    config.admin.password = process.env.ADMIN_PASSWORD;
}

// Middleware to parse form data
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Multer for multipart/form-data (used by fetch() with FormData)
// This is required because the website forms submit via fetch(FormData),
// which sends multipart/form-data - not urlencoded or JSON.
const upload = multer({ storage: multer.memoryStorage() });

// CORS Configuration - Allow requests from your websites
// CORS origins are read fresh from disk so new origins take effect without a server restart
let cachedCorsOrigins = null;

async function refreshCorsOrigins() {
    try {
        const freshCfg = JSON.parse(await fs.readFile(path.join(__dirname, 'config.json'), 'utf8'));
        cachedCorsOrigins = freshCfg.cors?.allowedOrigins || [];
    } catch {
        if (!cachedCorsOrigins) cachedCorsOrigins = config.cors?.allowedOrigins || [];
    }
}

function invalidateCorsCache() { cachedCorsOrigins = null; }

refreshCorsOrigins(); // Initialize on startup (background)

app.use(async (req, res, next) => {
    if (!cachedCorsOrigins) await refreshCorsOrigins();
    const origin = req.headers.origin;
    if (cachedCorsOrigins.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin);
        res.header('Vary', 'Origin');
    }
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    // Allow the headers that fetch() sends: Content-Type and Accept
    res.header('Access-Control-Allow-Headers', 'Content-Type, Accept');
    res.header('Access-Control-Max-Age', '86400');

    // Handle CORS preflight (OPTIONS) requests immediately
    // fetch() with FormData triggers a preflight because it sends a custom Accept header
    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    next();
});

// Configure the Nodemailer transporter
// Only include auth if user and pass are provided
const transporterConfig = { ...config.smtp };
if (transporterConfig.user && transporterConfig.pass) {
    transporterConfig.auth = {
        user: transporterConfig.user,
        pass: transporterConfig.pass
    };
}
// Remove user/pass from top-level to avoid nodemailer warnings
delete transporterConfig.user;
delete transporterConfig.pass;
let transporter = nodemailer.createTransport(transporterConfig);

app.post('/submit', upload.none(), async (req, res) => {
    const { website_id: rawWebsiteId, name, email, phone, rooms, service, subject, message, 'cf-turnstile-response': turnstileToken } = req.body;

    // Normalize the website_id: trim whitespace and match case-insensitively
    // so forms sending "Website-A", " website-a ", etc. still resolve correctly
    let website_id = String(rawWebsiteId || '').trim();

    // Collect data for submission logging
    // Include the FULL raw request body so failed submissions show every field received
    const logData = {
        ip: req.ip,
        website_id,
        name: name || '',
        email: email || '',
        phone: phone || '',
        rooms: rooms || '',
        service: service || '',
        message: message || '',
        rawBody: req.body || {}
    };

    // 1. DYNAMIC ROUTING CHECK - always read fresh config so new websites work immediately
    const cfg = await loadAdminConfig();
    const recipientConfig = cfg.recipients[website_id] ||
        cfg.recipients[Object.keys(cfg.recipients).find(k => k.toLowerCase() === website_id.toLowerCase())];

    if (!recipientConfig) {
        console.error(`Unknown website_id: "${rawWebsiteId}" (normalized: "${website_id}"). Available IDs: ${Object.keys(cfg.recipients).join(', ')}`);
        await appendLog({ ...logData, website_id: rawWebsiteId, success: false, error: `Invalid form submission ID: "${rawWebsiteId}". Available: ${Object.keys(cfg.recipients).join(', ')}` });
        // Redirect to a failure page or just return 400
        return res.status(400).send('Invalid form submission ID.');
    }
    // website_id now holds the normalized ID for all downstream logic (turnstile, statistics, templates, etc.)
    logData.website_id = website_id;

    // 2. VERIFY CLOUDFLARE TURNSTILE TOKEN
    // Skip verification in DEBUG mode
    if (!DEBUG) {
        if (!turnstileToken) {
            console.error('No Turnstile token provided');
            await appendLog({ ...logData, success: false, error: 'No Turnstile token provided' });
            return res.status(400).send('Please complete the security verification.');
        }

        // Get the appropriate Turnstile secret key for this website
        const turnstileConfig = cfg.turnstile?.[website_id];
        if (!turnstileConfig) {
            console.error(`No Turnstile config found for website: ${website_id}`);
            await appendLog({ ...logData, success: false, error: 'No Turnstile config found' });
            return res.status(400).send('Invalid form submission.');
        }

        try {
            const verificationResponse = await axios.post(
                'https://challenges.cloudflare.com/turnstile/v0/siteverify',
                new URLSearchParams({
                    secret: turnstileConfig.secretKey,
                    response: turnstileToken,
                    remoteip: req.ip
                }),
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                }
            );

            const { success, 'error-codes': errorCodes } = verificationResponse.data;

            if (!success) {
                console.error('Turnstile verification failed:', errorCodes);
                await appendLog({ ...logData, success: false, error: 'Turnstile verification failed: ' + (errorCodes || []).join(', ') });
                return res.status(400).send('Security verification failed. Please try again.');
            }
        } catch (error) {
            console.error('Error verifying Turnstile token:', error);
            await appendLog({ ...logData, success: false, error: 'Turnstile verification error: ' + error.message });
            return res.status(500).send('Security verification error. Please try again later.');
        }
    } else {
        console.log('DEBUG mode: Skipping Turnstile verification');
    }

    // 3. READ HTML TEMPLATE AND REPLACE PLACEHOLDERS
    try {
        // Use the template path from config
        const templatePath = path.join(__dirname, recipientConfig.templatePath);
        let mailBody = await fs.readFile(templatePath, 'utf8');
        
        // Replace placeholders with actual data
        mailBody = mailBody
            .replace(/{{website_id}}/g, website_id || 'Unknown')
            .replace(/{{name}}/g, name || 'Anonymous')
            .replace(/{{email}}/g, email || 'No email provided')
            .replace(/{{phone}}/g, phone || 'No phone provided')
            .replace(/{{rooms}}/g, rooms || 'Not specified')
            // service OR subject fallback: forms may send either field name
            .replace(/{{service}}/g, service || subject || 'Not specified')
            .replace(/{{subject}}/g, subject || service || 'Not specified')
            .replace(/{{message}}/g, message || 'No details provided.');

const mailOptions = {
    // 1. Set the technical sender to the authenticated user from config
    // This is the CRITICAL change to satisfy the server's relay policy
    from: `"${name}" <${cfg.smtp?.from || 'noreply@example.com'}>`, // Dynamically read sender from config
    
    // 2. Set the recipient address
    to: recipientConfig.to,
    
    // 3. Set the subject
    subject: `${recipientConfig.subjectPrefix} New Lead from ${name}`,
    html: mailBody,
    
    // 4. IMPORTANT: Set Reply-To to the customer's email
    // This allows you to just hit 'Reply' to contact the customer.
    replyTo: email 
};

    // 3. SEND EMAIL
    try {
        await transporter.sendMail(mailOptions);
        console.log(`Email successfully sent to ${recipientConfig.to} for ${website_id}`);
        await appendLog({ ...logData, success: true, recipient: recipientConfig.to });

        // 4. UPDATE STATISTICS
        try {
            // Read current config to get latest statistics
            const currentConfig = JSON.parse(await fs.readFile(path.join(__dirname, 'config.json'), 'utf8'));
            
            // Initialize statistics for this website if it doesn't exist
            if (!currentConfig.statistics) {
                currentConfig.statistics = {};
            }
            if (!currentConfig.statistics[website_id]) {
                currentConfig.statistics[website_id] = {
                    successfulSubmissions: 0,
                    lastSubmission: null
                };
            }
            
            // Increment counter and update timestamp
            currentConfig.statistics[website_id].successfulSubmissions++;
            currentConfig.statistics[website_id].lastSubmission = new Date().toISOString();
            
            // Write updated config back to file
            await fs.writeFile(path.join(__dirname, 'config.json'), JSON.stringify(currentConfig, null, 4));
            
            console.log(`Statistics updated for ${website_id}: ${currentConfig.statistics[website_id].successfulSubmissions} submissions`);
            
        } catch (statsError) {
            console.error('Error updating statistics:', statsError);
            // Don't fail the entire submission if statistics update fails
        }

        // 5. REDIRECT THE USER
        // IMPORTANT: The browser expects a response. A redirect is the simplest way.
        // Use the website-specific redirect URL from config
        return res.redirect(302, recipientConfig.redirectUrl); 

    } catch (error) {
        console.error('Error sending email:', error);
        await appendLog({ ...logData, success: false, error: 'Email sending failed: ' + error.message });
        // Redirect to a failure page or display an error
        res.status(500).send('Something went wrong on the server.');
    }
    } catch (templateError) {
        console.error('Error reading email template:', templateError);
        await appendLog({ ...logData, success: false, error: 'Template error: ' + templateError.message });
        res.status(500).send('Template error on the server.');
    }
});

// Health Check Endpoint
app.get('/health', async (req, res) => {
    try {
        const cfg = await loadAdminConfig();
        const healthCheck = {
            status: 'ok',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            memory: {
                used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024 * 100) / 100,
                total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024 * 100) / 100
            },
            config: {
                websites: Object.keys(cfg.recipients),
                smtp: cfg.smtp ? {
                    host: cfg.smtp.host || '',
                    port: cfg.smtp.port || '',
                    secure: cfg.smtp.secure || false,
                    from: cfg.smtp.from || ''
                } : {},
                turnstile: Object.keys(cfg.turnstile || {})
            }
        };

        // Optional: Test SMTP connection (commented out by default for performance)
        // try {
        //     await transporter.verify();
        //     healthCheck.smtp = 'connected';
        // } catch (error) {
        //     healthCheck.smtp = 'connection_error';
        //     healthCheck.status = 'warning';
        // }

        res.status(200).json(healthCheck);
    } catch (error) {
        console.error('Health check failed:', error);
        res.status(503).json({
            status: 'error',
            timestamp: new Date().toISOString(),
            error: 'Health check failed'
        });
    }
});

// Admin authentication middleware
let cachedAdmin = null;
let cachedAdminTime = 0;
const ADMIN_CACHE_MS = 5000;

async function adminAuth(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Basic ')) {
        res.set('WWW-Authenticate', 'Basic realm="Admin Area"');
        return res.status(401).send('Authentication required');
    }
    const base64Credentials = authHeader.split(' ')[1];
    const credentials = Buffer.from(base64Credentials, 'base64').toString('utf8');
    const [user, pass] = credentials.split(':');
    
    // Use fresh config with a short 5s cache to avoid excessive disk reads
    const now = Date.now();
    if (!cachedAdmin || now - cachedAdminTime > ADMIN_CACHE_MS) {
        try {
            const freshCfg = JSON.parse(await fs.readFile(path.join(__dirname, 'config.json'), 'utf8'));
            cachedAdmin = { username: freshCfg.admin?.username, password: freshCfg.admin?.password };
            cachedAdminTime = now;
        } catch {
            cachedAdmin = config.admin; // fall back to startup config
        }
    }
    
    if (DEBUG) {
        console.log('Admin auth attempt:', { user, pass, configAdmin: cachedAdmin });
    }
    
    if (cachedAdmin && user === cachedAdmin.username && pass === cachedAdmin.password) {
        return next();
    }
    return res.status(403).send('Forbidden');
}

// Serve static admin UI files (protected) - handle all admin routes
app.use('/admin', adminAuth, (req, res, next) => {
    // If it's the root path, serve index.html
    if (req.path === '/' || req.path === '') {
        return res.sendFile(path.join(__dirname, 'admin', 'index.html'));
    }
    // For other files, serve them statically
    express.static(path.join(__dirname, 'admin'))(req, res, next);
});

// Serve only image files from the root directory
// (NOT express.static(__dirname) directly - that would publicly expose config.json, logs.json, and source files)
app.use((req, res, next) => {
    const ext = path.extname(req.path).toLowerCase();
    const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.bmp'];
    if (ext && imageExtensions.includes(ext)) {
        return express.static(__dirname)(req, res, next);
    }
    return next();
});

// Admin API routes (protected)
const adminRouter = express.Router();
adminRouter.use(adminAuth);

// Get full dashboard data
adminRouter.get('/status', async (req, res) => {
    try {
        const cfg = await loadAdminConfig();
        const stats = cfg.statistics || {};
        let totalSubmissions = 0;
        let latestSubmission = null;
        for (const ws of Object.values(stats)) {
            totalSubmissions += (ws.successfulSubmissions || 0);
            if (!latestSubmission || (ws.lastSubmission && new Date(ws.lastSubmission) > new Date(latestSubmission))) {
                latestSubmission = ws.lastSubmission;
            }
        }
        const healthCheck = {
            status: 'ok',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            port: PORT,
            memory: {
                used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024 * 100) / 100,
                total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024 * 100) / 100
            },
            config: {
                websites: Object.keys(cfg.recipients || {}),
                websiteCount: Object.keys(cfg.recipients || {}).length,
                turnstile: Object.keys(cfg.turnstile || {}),
                corsOrigins: cfg.cors ? cfg.cors.allowedOrigins : [],
                smtpHost: cfg.smtp ? cfg.smtp.host : '',
                smtpPort: cfg.smtp ? cfg.smtp.port : '',
                smtpSecure: cfg.smtp ? cfg.smtp.secure : false,
                adminUser: cfg.admin ? cfg.admin.username : ''
            },
            summary: {
                totalSubmissions,
                latestSubmission,
                websitesWithStats: Object.keys(stats).length
            }
        };
        res.json(healthCheck);
    } catch (e) {
        res.status(500).json({ error: 'Failed to retrieve status' });
    }
});

// Get list of configured websites
adminRouter.get('/websites', async (req, res) => {
    const cfg = await loadAdminConfig();
    res.json(cfg.recipients);
});

// Get a single website configuration (includes turnstileKey for editing)
adminRouter.get('/websites/:id', async (req, res) => {
    const { id } = req.params;
    const cfg = await loadAdminConfig();
    if (!cfg.recipients[id]) {
        return res.status(404).json({ error: 'Website not found' });
    }
    const recipient = { ...cfg.recipients[id] };
    // Include turnstileKey from the turnstile section for the admin UI to populate the form
    if (cfg.turnstile?.[id]) {
        recipient.turnstileKey = cfg.turnstile[id].secretKey;
    }
    res.json(recipient);
});

// Get turnstile config for a website (for editing)
adminRouter.get('/websites/:id/turnstile', async (req, res) => {
    const { id } = req.params;
    const cfg = await loadAdminConfig();
    if (!cfg.turnstile || !cfg.turnstile[id]) {
        return res.status(404).json({ error: 'No Turnstile config found' });
    }
    res.json(cfg.turnstile[id]);
});

// Add a new website configuration
adminRouter.post('/websites', async (req, res) => {
    const { id, config: siteConfig } = req.body;
    if (!id || !siteConfig) {
        return res.status(400).json({ error: 'Missing id or config' });
    }
    const cfg = await loadAdminConfig();
    if (cfg.recipients[id]) {
        return res.status(409).json({ error: 'Website ID already exists' });
    }
    // Extract turnstileKey separately so it doesn't leak into the recipients config
    const { turnstileKey, ...recipientConfig } = siteConfig;
    cfg.recipients[id] = recipientConfig;
    // Add turnstile entry if provided
    if (!cfg.turnstile) cfg.turnstile = {};
    if (turnstileKey) {
        cfg.turnstile[id] = { secretKey: turnstileKey };
    }
    // Auto-add CORS origin from redirectUrl so the new website can submit forms immediately
    if (recipientConfig.redirectUrl) {
        try {
            const redirectOrigin = new URL(recipientConfig.redirectUrl).origin;
            if (!cfg.cors) cfg.cors = { allowedOrigins: [] };
            if (!cfg.cors.allowedOrigins.includes(redirectOrigin)) {
                cfg.cors.allowedOrigins.push(redirectOrigin);
            }
        } catch { /* invalid URL, skip */ }
    }
    await fs.writeFile(path.join(__dirname, 'config.json'), JSON.stringify(cfg, null, 4));
    invalidateCorsCache();
    res.status(201).json({ message: 'Website added' });
});

// Update existing website configuration
adminRouter.put('/websites/:id', async (req, res) => {
    const { id } = req.params;
    const siteConfig = req.body;
    const cfg = await loadAdminConfig();
    if (!cfg.recipients[id]) {
        return res.status(404).json({ error: 'Website not found' });
    }
    // Extract turnstileKey separately so it doesn't leak into the recipients config
    const { turnstileKey, ...recipientConfig } = siteConfig;
    cfg.recipients[id] = { ...cfg.recipients[id], ...recipientConfig };
    // Update turnstile entry if a key was provided
    if (turnstileKey) {
        if (!cfg.turnstile) cfg.turnstile = {};
        cfg.turnstile[id] = { secretKey: turnstileKey };
    }
    // Auto-add CORS origin from redirectUrl
    if (recipientConfig.redirectUrl) {
        try {
            const redirectOrigin = new URL(recipientConfig.redirectUrl).origin;
            if (!cfg.cors) cfg.cors = { allowedOrigins: [] };
            if (!cfg.cors.allowedOrigins.includes(redirectOrigin)) {
                cfg.cors.allowedOrigins.push(redirectOrigin);
            }
        } catch { /* invalid URL, skip */ }
    }
    await fs.writeFile(path.join(__dirname, 'config.json'), JSON.stringify(cfg, null, 4));
    invalidateCorsCache();
    res.json({ message: 'Website updated' });
});

// Delete a website configuration
adminRouter.delete('/websites/:id', async (req, res) => {
    const { id } = req.params;
    const cfg = await loadAdminConfig();
    if (!cfg.recipients[id]) {
        return res.status(404).json({ error: 'Website not found' });
    }
    delete cfg.recipients[id];
    if (cfg.turnstile && cfg.turnstile[id]) {
        delete cfg.turnstile[id];
    }
    await fs.writeFile(path.join(__dirname, 'config.json'), JSON.stringify(cfg, null, 4));
    invalidateCorsCache();
    res.json({ message: 'Website removed' });
});

// SMTP configuration routes
adminRouter.get('/smtp', async (req, res) => {
    const cfg = await loadAdminConfig();
    res.json(cfg.smtp || {});
});

adminRouter.put('/smtp', async (req, res) => {
    const newSmtp = req.body;
    if (!newSmtp || typeof newSmtp !== 'object') {
        return res.status(400).json({ error: 'Invalid SMTP config' });
    }
    const cfg = await loadAdminConfig();
    cfg.smtp = { ...cfg.smtp, ...newSmtp };
    // Preserve password if not provided in the update
    if (newSmtp.pass === '') {
        cfg.smtp.pass = cfg.smtp?.pass || '';
    }
    try {
        await fs.writeFile(path.join(__dirname, 'config.json'), JSON.stringify(cfg, null, 4));
        invalidateCorsCache();
        
        // Rebuild transporter so subsequent emails use new SMTP settings immediately
        const freshTransporterConfig = { ...cfg.smtp };
        if (freshTransporterConfig.user && freshTransporterConfig.pass) {
            freshTransporterConfig.auth = { user: freshTransporterConfig.user, pass: freshTransporterConfig.pass };
        }
        delete freshTransporterConfig.user;
        delete freshTransporterConfig.pass;
        transporter = nodemailer.createTransport(freshTransporterConfig);
        
        res.json({ message: 'SMTP config updated' });
    } catch (e) {
        console.error('Failed to write config:', e);
        res.status(500).json({ error: 'Failed to save config' });
    }
});

// Statistics routes
adminRouter.get('/statistics', async (req, res) => {
    const cfg = await loadAdminConfig();
    // Return statistics for all websites
    const stats = cfg.statistics || {};
    
    // Enhance with website names from recipients
    const enhancedStats = {};
    for (const [websiteId, websiteConfig] of Object.entries(cfg.recipients)) {
        const websiteStats = stats[websiteId] || {
            successfulSubmissions: 0,
            lastSubmission: null
        };
        enhancedStats[websiteId] = {
            ...websiteStats,
            name: websiteConfig.subjectPrefix || websiteId,
            email: websiteConfig.to
        };
    }
    
    res.json(enhancedStats);
});

adminRouter.get('/statistics/:id', async (req, res) => {
    const { id } = req.params;
    const cfg = await loadAdminConfig();
    if (!cfg.recipients[id]) {
        return res.status(404).json({ error: 'Website not found' });
    }
    
    const stats = cfg.statistics || {};
    const websiteStats = stats[id] || {
        successfulSubmissions: 0,
        lastSubmission: null
    };
    
    res.json({
        websiteId: id,
        name: cfg.recipients[id].subjectPrefix || id,
        email: cfg.recipients[id].to,
        ...websiteStats
    });
});

adminRouter.put('/statistics/:id/reset', async (req, res) => {
    const { id } = req.params;
    const cfg = await loadAdminConfig();
    if (!cfg.recipients[id]) {
        return res.status(404).json({ error: 'Website not found' });
    }
    
    try {
        // Reset statistics for this website
        if (!cfg.statistics) {
            cfg.statistics = {};
        }
        cfg.statistics[id] = {
            successfulSubmissions: 0,
            lastSubmission: null
        };
        
        // Write updated config back to file
        await fs.writeFile(path.join(__dirname, 'config.json'), JSON.stringify(cfg, null, 4));
        invalidateCorsCache();
        
        res.json({ message: 'Statistics reset', websiteId: id });
    } catch (e) {
        console.error('Failed to reset statistics:', e);
        res.status(500).json({ error: 'Failed to reset statistics' });
    }
});

// List available email template files
adminRouter.get('/email-templates', async (req, res) => {
    try {
        const dir = path.join(__dirname, 'email-templates');
        const allFiles = await fs.readdir(dir);
        const templates = allFiles.filter(f => f.endsWith('.html'));
        res.json(templates);
    } catch (e) {
        res.status(500).json({ error: 'Failed to list templates' });
    }
});

// Get an email template by filename
adminRouter.get('/email-templates/:name', async (req, res) => {
    const { name } = req.params;
    if (!name.endsWith('.html')) {
        return res.status(400).json({ error: 'Invalid template name' });
    }
    try {
        const templatePath = path.join(__dirname, 'email-templates', name);
        await fs.access(templatePath);
        const content = await fs.readFile(templatePath, 'utf8');
        res.json({ name, content });
    } catch (e) {
        res.status(404).json({ error: 'Template not found' });
    }
});

// Update or create an email template
adminRouter.put('/email-templates/:name', async (req, res) => {
    const { name } = req.params;
    const { content } = req.body;
    if (!name.endsWith('.html')) {
        return res.status(400).json({ error: 'Invalid template name. Must end with .html' });
    }
    if (content === undefined) {
        return res.status(400).json({ error: 'Content is required' });
    }
    try {
        const templatePath = path.join(__dirname, 'email-templates', name);
        await fs.writeFile(templatePath, content, 'utf8');
        res.json({ message: 'Template saved', name });
    } catch (e) {
        console.error('Failed to save template:', e);
        res.status(500).json({ error: 'Failed to save template' });
    }
});

// Delete an email template
adminRouter.delete('/email-templates/:name', async (req, res) => {
    const { name } = req.params;
    if (!name.endsWith('.html')) {
        return res.status(400).json({ error: 'Invalid template name. Must end with .html' });
    }
    try {
        const templatePath = path.join(__dirname, 'email-templates', name);
        await fs.unlink(templatePath);
        res.json({ message: 'Template deleted', name });
    } catch (e) {
        console.error('Failed to delete template:', e);
        res.status(500).json({ error: 'Failed to delete template' });
    }
});

// Reset admin password
adminRouter.put('/reset-password', async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    
    if (!currentPassword || !newPassword) {
        return res.status(400).json({ error: 'Current password and new password are required' });
    }
    
    // Verify current password from fresh config
    const cfg = await loadAdminConfig();
    if (currentPassword !== cfg.admin?.password) {
        return res.status(403).json({ error: 'Current password is incorrect' });
    }
    
    try {
        // Update password and preserve admin section
        const freshCfg = await loadAdminConfig();
        if (!freshCfg.admin) { freshCfg.admin = {}; }
        freshCfg.admin.password = newPassword;
        
        // Write updated config back to file
        await fs.writeFile(path.join(__dirname, 'config.json'), JSON.stringify(freshCfg, null, 4));
        invalidateCorsCache();
        
        res.json({ message: 'Password updated successfully' });
    } catch (e) {
        console.error('Failed to update password:', e);
        res.status(500).json({ error: 'Failed to update password' });
    }
});

// Submission logs routes
adminRouter.get('/logs', async (req, res) => {
    try {
        const raw = await fs.readFile(path.join(__dirname, 'logs.json'), 'utf8');
        const logs = JSON.parse(raw);
        res.json(logs.reverse()); // Return newest first
    } catch {
        res.json([...submissionLogs].reverse()); // Fallback to in-memory logs
    }
});

adminRouter.delete('/logs', async (req, res) => {
    try {
        submissionLogs = [];
        await fs.writeFile(path.join(__dirname, 'logs.json'), JSON.stringify([]));
        res.json({ message: 'Logs cleared' });
    } catch (e) {
        console.error('Failed to clear logs:', e);
        res.status(500).json({ error: 'Failed to clear logs' });
    }
});

app.use('/admin/api', adminRouter);

// Start the server
app.listen(PORT, () => {
    console.log(`Form processing server running on port ${PORT}`);
    console.log(`Health check available at: http://localhost:${PORT}/health`);
    console.log(`Admin UI available at: http://localhost:${PORT}/admin`);
});