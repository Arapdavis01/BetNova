const axios = require('axios');

const PAYHERO_BASE = 'https://backend.payhero.co.ke/api/v2';

// Build Basic Auth header from username:password
function getAuthHeader() {
    const username = process.env.PAYHERO_USERNAME;
    const password = process.env.PAYHERO_PASSWORD;
    if (!username || !password) {
        throw new Error('PayHero credentials not configured in environment variables.');
    }
    const token = Buffer.from(`${username}:${password}`).toString('base64');
    return `Basic ${token}`;
}

/**
 * Initiate STK Push for a deposit
 * @param {string} phoneNumber - Format: 254712345678
 * @param {number} amount - Amount in KES
 * @param {string} reference - Your internal reference (e.g., userId-timestamp)
 */
async function initiateSTKPush(phoneNumber, amount, reference) {
    const payload = {
        amount: amount,
        phone_number: phoneNumber,
        channel_id: process.env.PAYHERO_CHANNEL_ID,
        provider: 'm-pesa',
        external_reference: reference
    };

    const response = await axios.post(
        `${PAYHERO_BASE}/payments/initiate-stk-push`,
        payload,
        {
            headers: {
                'Authorization': getAuthHeader(),
                'Content-Type': 'application/json'
            }
        }
    );

    return response.data;
}

/**
 * Initiate B2C withdrawal to a mobile number
 * @param {string} phoneNumber - Format: 254712345678
 * @param {number} amount - Amount in KES
 * @param {string} reference - Your internal reference
 * @param {string} networkCode - "63902" for MPesa, "63903" for Airtel
 */
async function initiateWithdrawal(phoneNumber, amount, reference, networkCode = '63902') {
    const payload = {
        amount: amount,
        phone_number: phoneNumber,
        network_code: networkCode,
        external_reference: reference,
        callback_url: process.env.PAYHERO_CALLBACK_URL
    };

    const response = await axios.post(
        `${PAYHERO_BASE}/payments/withdraw`,
        payload,
        {
            headers: {
                'Authorization': getAuthHeader(),
                'Content-Type': 'application/json'
            }
        }
    );

    return response.data;
}

/**
 * Check transaction status
 * @param {string} reference - The reference returned by PayHero
 */
async function checkTransactionStatus(reference) {
    const response = await axios.get(
        `${PAYHERO_BASE}/payments/status/${reference}`,
        {
            headers: {
                'Authorization': getAuthHeader()
            }
        }
    );
    return response.data;
}

module.exports = {
    initiateSTKPush,
    initiateWithdrawal,
    checkTransactionStatus
};
