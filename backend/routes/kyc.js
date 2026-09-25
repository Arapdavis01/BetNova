const express = require('express');
const router = express.Router();
const User = require('../models/User');
const { sendSMS } = require('../services/sms');

// In-memory OTP store (use Redis in production)
const otpStore = new Map(); // phone -> { code, expiresAt, attempts }

function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function normalizePhone(phone) {
    let p = phone.replace(/\s/g, '').replace(/^\+/, '');
    if (p.startsWith('0')) p = '254' + p.slice(1);
    if (!p.startsWith('254')) p = '254' + p;
    return p;
}

// ---------- Send OTP ----------
router.post('/send-otp', async (req, res) => {
    try {
        const { userId, phone } = req.body;
        if (!userId || !phone) {
            return res.status(400).json({ error: 'userId and phone are required.' });
        }

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: 'User not found.' });

        const normalized = normalizePhone(phone);

        // Rate limit: one OTP per 60 seconds
        const existing = otpStore.get(normalized);
        if (existing && Date.now() - (existing.sentAt || 0) < 60000) {
            return res.status(429).json({ error: 'Please wait before requesting another OTP.' });
        }

        const code = generateOTP();
        otpStore.set(normalized, {
            code,
            expiresAt: Date.now() + 5 * 60 * 1000,
            attempts: 0,
            sentAt: Date.now()
        });

        await sendSMS(normalized, `Your BetNova verification code is: ${code}. Valid for 5 minutes.`);

        res.json({ message: 'OTP sent to your phone.', phone: normalized });
    } catch (err) {
        console.error('Send OTP error:', err);
        res.status(500).json({ error: 'Failed to send OTP.' });
    }
});

// ---------- Verify OTP ----------
router.post('/verify-otp', async (req, res) => {
    try {
        const { userId, phone, code } = req.body;
        if (!userId || !phone || !code) {
            return res.status(400).json({ error: 'userId, phone, and code are required.' });
        }

        const normalized = normalizePhone(phone);
        const record = otpStore.get(normalized);

        if (!record) {
            return res.status(400).json({ error: 'No OTP was requested for this phone.' });
        }
        if (Date.now() > record.expiresAt) {
            otpStore.delete(normalized);
            return res.status(400).json({ error: 'OTP expired. Request a new one.' });
        }
        if (record.attempts >= 5) {
            otpStore.delete(normalized);
            return res.status(429).json({ error: 'Too many attempts. Request a new OTP.' });
        }

        record.attempts += 1;

        if (record.code !== code) {
            return res.status(400).json({ error: 'Invalid OTP.' });
        }

        // Success
        otpStore.delete(normalized);

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: 'User not found.' });

        user.phone = normalized;
        user.phoneVerified = true;
        await user.save();

        res.json({
            message: 'Phone verified successfully.',
            phone: normalized
        });
    } catch (err) {
        console.error('Verify OTP error:', err);
        res.status(500).json({ error: 'Verification failed.' });
    }
});

module.exports = router;
