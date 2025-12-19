// Install dependencies: npm install express body-parser nodemailer
const express = require('express');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const config = require('./config.json');

const app = express();
const PORT = 3000;

// Middleware to parse form data
app.use(bodyParser.urlencoded({ extended: true }));

// CORS Configuration - Allow requests from your websites
app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (config.cors.allowedOrigins.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin);
    }
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

// Configure the Nodemailer transporter
const transporter = nodemailer.createTransport(config.smtp);

app.post('/submit', async (req, res) => {
    const { website_id, name, email, phone, rooms, message, 'cf-turnstile-response': turnstileToken } = req.body;

    // 1. DYNAMIC ROUTING CHECK
    const recipientConfig = config.recipients[website_id];

    if (!recipientConfig) {
        console.error(`Unknown website_id: ${website_id}`);
        // Redirect to a failure page or just return 400
        return res.status(400).send('Invalid form submission ID.');
    }

    // 2. VERIFY CLOUDFLARE TURNSTILE TOKEN
    if (!turnstileToken) {
        console.error('No Turnstile token provided');
        return res.status(400).send('Please complete the security verification.');
    }

    // Get the appropriate Turnstile secret key for this website
    const turnstileConfig = config.turnstile[website_id];
    if (!turnstileConfig) {
        console.error(`No Turnstile config found for website: ${website_id}`);
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
            return res.status(400).send('Security verification failed. Please try again.');
        }
    } catch (error) {
        console.error('Error verifying Turnstile token:', error);
        return res.status(500).send('Security verification error. Please try again later.');
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
            .replace(/{{message}}/g, message || 'No details provided.');

const mailOptions = {
    // 1. Set the technical sender to the authenticated user from config
    // This is the CRITICAL change to satisfy the server's relay policy
    from: `"${name}" <${config.smtp.from}>`, // Example: "John Smith" <cloud@codemov.com>
    
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

        // 4. REDIRECT THE USER
        // IMPORTANT: The browser expects a response. A redirect is the simplest way.
        // Use the website-specific redirect URL from config
        res.redirect(302, recipientConfig.redirectUrl); 

    } catch (error) {
        console.error('Error sending email:', error);
        // Redirect to a failure page or display an error
        res.status(500).send('Something went wrong on the server.');
    }
    } catch (templateError) {
        console.error('Error reading email template:', templateError);
        res.status(500).send('Template error on the server.');
    }
});

// Health Check Endpoint
app.get('/health', async (req, res) => {
    try {
        const healthCheck = {
            status: 'ok',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            memory: {
                used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024 * 100) / 100,
                total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024 * 100) / 100
            },
            config: {
                websites: Object.keys(config.recipients),
                smtp: config.smtp ? 'configured' : 'missing',
                turnstile: Object.keys(config.turnstile || {})
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

// Start the server
app.listen(PORT, () => {
    console.log(`Form processing server running on port ${PORT}`);
    console.log(`Health check available at: http://localhost:${PORT}/health`);
});