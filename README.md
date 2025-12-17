# Web Contact Form Backend Server

A Node.js application for processing website contact forms with support for multiple websites, email notifications, and bot protection.

## Features

- ✅ **Multi-Website Support**: Handle forms from multiple websites with different configurations
- ✅ **Email Notifications**: Send styled HTML emails with custom templates per website
- ✅ **Bot Protection**: Cloudflare Turnstile integration for spam prevention
- ✅ **Docker Ready**: Containerized deployment with Docker and Docker Compose
- ✅ **CORS Support**: Configurable cross-origin resource sharing per domain
- ✅ **Template System**: Customizable email templates per website

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
- [Docker Deployment](#docker-deployment)
- [Adding New Websites](#adding-new-websites)
- [API Endpoints](#api-endpoints)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)

## Prerequisites

- Node.js (version 18 or higher)
- Docker and Docker Compose (for containerized deployment)
- SMTP server credentials for email delivery

## Installation

### Option 1: Local Development

1. Clone the repository:
```bash
git clone https://github.com/c0deirl/formbackend.git
cd formbackend
```

2. Install dependencies:
```bash
npm install
```

3. Start the server:
```bash
npm start
```

The server will run on port 3000 by default.

### Option 2: Docker Deployment

See [Docker Deployment](#docker-deployment) section below.

## Configuration

### config.json

The main configuration file `config.json` contains all settings for your websites:

```json
{
    "recipients": {
        "website-a": {
            "to": "recipient@your-domain-a.com",
            "subjectPrefix": "Your Domain Contact Form - ",
            "redirectUrl": "https://your-domain.com/thanks.html",
            "templatePath": "email-template-a.html"
        },
        "website-b": {
            "to": "recipient@wyour-domain-b.com",
            "subjectPrefix": "Your Domain Contact Form - ",
            "redirectUrl": "https://your-domain.com/thanks.html",
            "templatePath": "email-template-website-b.html"
        }
    },
    "smtp": {
        "host": "smtp.your-domain.com",
        "port": 25,
        "secure": false,
        "from": "webform@your-domain.com"
    },
    "turnstile": {
        "website-a": {
            "secretKey": "YOUR_WEBSITE_A_TURNSTILE_SECRET_KEY"
        },
        "website-b": {
            "secretKey": "YOUR_WEBSITE_B_TURNSTILE_SECRET_KEY"
        }
    },
    "cors": {
        "allowedOrigins": [
            "https://your-domain-a.com",
            "https://your-domain-b.com",
            "https://subdomain.your-domain.com"
        ]
    }
}
```

### Configuration Options

#### Recipients
Each website needs a configuration object with:
- `to`: Email address to receive form submissions
- `subjectPrefix`: Prefix for email subject line
- `redirectUrl`: URL to redirect users after successful submission
- `templatePath`: Path to HTML email template file

#### SMTP Settings
Configure your email server:
- `host`: SMTP server hostname
- `port`: SMTP server port (25 for non-SSL, 465 for SSL, 587 for STARTLS)
- `secure`: Set to `true` for SSL/TLS, `false` for plain text
- `from`: Default sender email address

#### Turnstile (Bot Protection)
For each website, add:
- `secretKey`: Cloudflare Turnstile secret key

#### CORS Settings
Configure allowed origins for cross-origin requests:
- `allowedOrigins`: Array of allowed domain URLs  

> This array is universal between all form processors, add all possible website origins here.

### Email Templates

Create HTML email templates in the root directory. Use these placeholders:
- `{{website_id}}`: Website identifier
- `{{name}}`: User's name
- `{{email}}`: User's email
- `{{phone}}`: User's phone number
- `{{rooms}}`: Number of rooms (this can also be a dropdown of options)
- `{{message}}`: User's message

Example template structure:
```html
<!DOCTYPE html>
<html>
<head>
    <title>New Form Submission</title>
    <style>
        /* Your CSS styles */
    </style>
</head>
<body>
    <h2>New Form Submission from {{website_id}}</h2>
    <p><strong>Name:</strong> {{name}}</p>
    <p><strong>Email:</strong> {{email}}</p>
    <!-- More fields -->
</body>
</html>
```
>  When making a template, the server.js will replace the bracketed variables for you.

## Usage

### Form HTML Example

Add this to your website forms:

```html
<form action="https://your-server-domain.com/submit" method="POST">
    <input type="hidden" name="website_id" value="website-a">
    
    <label>Name: <input type="text" name="name" required></label>
    <label>Email: <input type="email" name="email" required></label>
    <label>Phone: <input type="tel" name="phone"></label>
    <label>Rooms: <input type="number" name="rooms"></label>
    <label>Message: <textarea name="message"></textarea></label>
    
    <!-- Cloudflare Turnstile widget -->
    <div class="cf-turnstile" data-sitekey="YOUR_SITE_KEY"></div>
    
    <button type="submit">Submit</button>
</form>

<!-- Include Turnstile script -->
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
```

### Required Form Fields

- `website_id`: Identifier matching your config.json
- `name`: User's name
- `email`: User's email address
- `phone`: User's phone number (optional)
- `rooms`: Number of rooms (optional)
- `message`: User's message (optional)
- `cf-turnstile-response`: Turnstile token (automatically added)  

> The "Rooms" variable is a numerical value, I used it for a dropdown selection list. You can customize this to any dropdown you would like, but keep in mind this will return a numerical value.

## Docker Deployment

### Using Docker Compose (Recommended)

1. Ensure you have `docker` and `docker-compose` installed
2. Build and run:
```bash
docker compose build --no-cache && docker compose up -d
```

This will:
- Build the Docker image
- Start the container on port 3000
- Mount your local files for easy development

### CORS Configuration

CORS settings are now managed through `config.json` for better security and flexibility:

```json
{
    "cors": {
        "allowedOrigins": [
            "https://your-website.com",
            "https://your-other-site.com"
        ]
    }
}
```

To add a new domain:
1. Add the full URL (including https://) to the `allowedOrigins` array
2. Restart the server or container for changes to take effect

### Using Docker Only

1. Build the image:
```bash
docker build -t formbackend .
```

2. Run the container:
```bash
docker run -d -p 3000:3000 --name formbackend formbackend
```

### Environment Variables

You can override configuration using environment variables in `docker-compose.yml`:

```yaml
environment:
  - NODE_ENV=production
  - PORT=3000
```

## Adding New Websites

1. **Get Cloudflare Turnstile keys**:
   - Go to [Cloudflare Turnstile](https://www.cloudflare.com/turnstile/)
   - Add your domain and get Site Key and Secret Key

2. **Create email template**:
   - Copy an existing template
   - Customize styling and layout
   - Save as `email-template-[your-website].html`

3. **Update config.json**:
```json
{
    "recipients": {
        "your-website": {
            "to": "your-email@domain.com",
            "subjectPrefix": "Your Website - ",
            "redirectUrl": "https://your-website.com/thanks.html",
            "templatePath": "email-template-your-website.html"
        }
    },
    "turnstile": {
        "your-website": {
            "secretKey": "YOUR_SECRET_KEY"
        }
    }
}
```

4. **Update your HTML form**:
```html
<input type="hidden" name="website_id" value="YOUR-WEBSITE-ID-VALUE">
<div class="cf-turnstile" data-sitekey="YOUR_SITE_KEY"></div>
```

## API Endpoints

### POST /submit

Process form submissions.

**Request Body:**
- `website_id` (required): Website identifier
- `name` (required): User's name
- `email` (required): User's email
- `phone` (optional): User's phone
- `rooms` (optional): Number of rooms
- `message` (optional): User's message
- `cf-turnstile-response` (required): Turnstile token

**Responses:**
- `200`: Success (redirects to thank you page)
- `400`: Invalid request or Turnstile verification failed
- `500`: Server error

## Reverse Proxy

> This server can be reverse proxied. I have only attempted it with NPM, but there are no special configuration options, other than "allow websockets"
> The server MUST be exposed using HTTPS for any modern website to work properly, you "can" get by not using TLS, but the form will warn users when they go to use it.

## Troubleshooting

### Common Issues

1. **Email not sending**:
   - Check SMTP credentials in config.json
   - Verify firewall allows SMTP connections
   - Check server logs for error details
> ** NOTE: This is considered an Email Relay, some SMTP servers do not allow relay traffic, so verify with your email provider if they allow this kind of traffic. **

2. **Turnstile not working**:
   - Verify site key and secret key match
   - Ensure domain is registered with Cloudflare Turnstile
   - Check browser console for JavaScript errors

3. **CORS errors**:
   - Add your domain to `allowedOrigins` in config.json
   - Verify domain matches exactly (including https://)

4. **Template not found**:
   - Check template file exists in root directory
   - Verify `templatePath` in config.json is correct
   - Check file permissions

### Logs

View server logs:
```bash
# Docker Compose
docker-compose logs

# Docker
docker logs formbackend

# Local development
npm start
```

### Health Check

Test if server is running:
```bash
curl http://localhost:3000/
```

## Security Notes

- Always use HTTPS in production
- Store sensitive data (SMTP credentials) securely
- Regularly update dependencies
- Monitor logs for suspicious activity
- Use strong, unique Turnstile keys per website

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

GNU GPLv3

## Support

For support and questions:
- Create an issue in the repository
