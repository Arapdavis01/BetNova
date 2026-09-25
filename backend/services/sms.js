const axios = require('axios');

/**
 * Send SMS via Africa's Talking.
 * Sign up: https://africastalking.com
 * Set AT_USERNAME and AT_API_KEY in env vars.
 * In sandbox mode, use AT_USERNAME=sandbox.
 */
async function sendSMS(phone, message) {
    const username = process.env.AT_USERNAME;
    const apiKey = process.env.AT_API_KEY;

    if (!username || !apiKey) {
        console.warn('⚠️ Africa\'s Talking not configured — SMS skipped');
        console.log(`[SMS MOCK] to=${phone}: ${message}`);
        return { mocked: true };
    }

    const baseUrl = username === 'sandbox'
        ? 'https://api.sandbox.africastalking.com/version1/messaging'
        : 'https://api.africastalking.com/version1/messaging';

    const params = new URLSearchParams({
        username: username,
        to: phone,
        message: message,
        from: process.env.AT_SENDER_ID || ''
    });

    try {
        const response = await axios.post(baseUrl, params.toString(), {
            headers: {
                'apiKey': apiKey,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json'
            }
        });
        return response.data;
    } catch (err) {
        console.error('SMS send error:', err.response?.data || err.message);
        throw new Error('Failed to send SMS.');
    }
}

module.exports = { sendSMS };
