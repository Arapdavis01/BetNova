const axios = require('axios');

/**
 * Send email via SendGrid.
 * Sign up: https://sendgrid.com
 * Set SENDGRID_API_KEY and FROM_EMAIL in env vars.
 */
async function sendEmail(to, subject, htmlBody) {
    const apiKey = process.env.SENDGRID_API_KEY;
    const fromEmail = process.env.FROM_EMAIL;

    if (!apiKey || !fromEmail) {
        console.warn('⚠️ SendGrid not configured — email skipped');
        console.log(`[EMAIL MOCK] to=${to}, subject="${subject}"`);
        return { mocked: true };
    }

    try {
        const response = await axios.post(
            'https://api.sendgrid.com/v3/mail/send',
            {
                personalizations: [{ to: [{ email: to }] }],
                from: { email: fromEmail, name: 'BetNova' },
                subject,
                content: [{ type: 'text/html', value: htmlBody }]
            },
            {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        return response.data;
    } catch (err) {
        console.error('Email send error:', err.response?.data || err.message);
        throw new Error('Failed to send email.');
    }
}

module.exports = { sendEmail };
