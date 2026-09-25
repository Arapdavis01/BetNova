const express = require('express');
const router = express.Router();
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const { sendOtpEmail } = require('../services/email');

// ============================================
// IN-MEMORY OTP STORE
// For production with multiple instances, use Redis.
// Key: email (lowercased, trimmed)
// Value: { code, expiresAt, attempts, sentAt, userId }
// ============================================
const otpStore = new Map();

// Configuration
const OTP_TTL_MS = 5 * 60 * 1000;        // 5 minutes
const OTP_RESEND_COOLDOWN_MS = 60 * 1000; // 60 seconds
const OTP_MAX_ATTEMPTS = 5;

function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function normalizeEmail(email) {
    return String(email).trim().toLowerCase();
}

function isValidEmail(email) {
    // Simple but effective email validation
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

// Periodic cleanup of expired OTPs every 10 minutes
setInterval(() => {
    const now = Date.now();
    for (const [key, record] of otpStore.entries()) {
        if (record.expiresAt < now) {
            otpStore.delete(key);
        }
    }
}, 10 * 60 * 1000);

// ============================================
// SEND OTP
// POST /api/kyc/send-otp
// Body: { userId, email }
// ============================================
router.post('/send-otp', async (req, res) => {
    try {
        const { userId, email } = req.body;

        // ---------- Validation ----------
        if (!userId || !email) {
            return res.status(400).json({ error: 'userId and email are required.' });
        }
        if (!isValidEmail(email)) {
            return res.status(400).json({ error: 'Please enter a valid email address.' });
        }

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found.' });
        }
        if (user.status !== 'active') {
            return res.status(403).json({ error: 'Account is not active.' });
        }

        const normalized = normalizeEmail(email);

        // ---------- Resend cooldown ----------
        const existing = otpStore.get(normalized);
        if (existing && existing.sentAt && Date.now() - existing.sentAt < OTP_RESEND_COOLDOWN_MS) {
            const waitSeconds = Math.ceil(
                (OTP_RESEND_COOLDOWN_MS - (Date.now() - existing.sentAt)) / 1000
            );
            return res.status(429).json({
                error: `Please wait ${waitSeconds}s before requesting another code.`
            });
        }

        // ---------- Generate and store OTP ----------
        const code = generateOTP();
        otpStore.set(normalized, {
            code,
            userId: user._id.toString(),
            expiresAt: Date.now() + OTP_TTL_MS,
            attempts: 0,
            sentAt: Date.now()
        });

        // ---------- Send email ----------
        try {
            await sendOtpEmail(normalized, code);
        } catch (emailErr) {
            // Roll back OTP on send failure so user isn't stuck with a cooldown
            otpStore.delete(normalized);
            console.error('Email delivery failed:', emailErr.message);
            return res.status(500).json({
                error: 'Could not send verification email. Please try again.'
            });
        }

        // ---------- Audit log ----------
        try {
            await AuditLog.create({
                action: 'OTP_SENT',
                userId: user._id,
                username: user.username,
                metadata: { email: normalized, ip: req.ip || null }
            });
        } catch (_) {}

        res.json({
            message: 'Verification code sent to your email.',
            email: normalized,
            expiresInSeconds: Math.floor(OTP_TTL_MS / 1000)
        });
    } catch (err) {
        console.error('Send OTP error:', err);
        res.status(500).json({ error: 'Failed to send verification code.' });
    }
});

// ============================================
// VERIFY OTP
// POST /api/kyc/verify-otp
// Body: { userId, email, code }
// ============================================
router.post('/verify-otp', async (req, res) => {
    try {
        const { userId, email, code } = req.body;

        // ---------- Validation ----------
        if (!userId || !email || !code) {
            return res.status(400).json({ error: 'userId, email, and code are required.' });
        }
        if (!isValidEmail(email)) {
            return res.status(400).json({ error: 'Invalid email address.' });
        }
        if (!/^\d{6}$/.test(String(code))) {
            return res.status(400).json({ error: 'Code must be 6 digits.' });
        }

        const normalized = normalizeEmail(email);
        const record = otpStore.get(normalized);

        // ---------- Record checks ----------
        if (!record) {
            return res.status(400).json({ error: 'No code was requested for this email.' });
        }
        if (record.userId !== userId) {
            return res.status(400).json({ error: 'Code does not match this account.' });
        }
        if (Date.now() > record.expiresAt) {
            otpStore.delete(normalized);
            return res.status(400).json({ error: 'Code expired. Request a new one.' });
        }
        if (record.attempts >= OTP_MAX_ATTEMPTS) {
            otpStore.delete(normalized);
            return res.status(429).json({ error: 'Too many attempts. Request a new code.' });
        }

        // ---------- Increment attempts and compare ----------
        record.attempts += 1;

        if (record.code !== String(code)) {
            const remaining = OTP_MAX_ATTEMPTS - record.attempts;
            return res.status(400).json({
                error: `Invalid code. ${remaining} attempt${remaining !== 1 ? 's' : ''} remaining.`
            });
        }

        // ---------- Success ----------
        otpStore.delete(normalized);

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found.' });
        }

        user.email = normalized;
        user.emailVerified = true;
        await user.save();

        // ---------- Audit log ----------
        try {
            await AuditLog.create({
                action: 'EMAIL_VERIFIED',
                userId: user._id,
                username: user.username,
                metadata: { email: normalized, ip: req.ip || null }
            });
        } catch (_) {}

        res.json({
            message: 'Email verified successfully.',
            email: normalized,
            emailVerified: true
        });
    } catch (err) {
        console.error('Verify OTP error:', err);
        res.status(500).json({ error: 'Verification failed. Please try again.' });
    }
});

// ============================================
// CHECK VERIFICATION STATUS
// GET /api/kyc/status/:userId
// ============================================
router.get('/status/:userId', async (req, res) => {
    try {
        const user = await User.findById(req.params.userId).select('email emailVerified phone phoneVerified');
        if (!user) return res.status(404).json({ error: 'User not found.' });

        res.json({
            email: user.email,
            emailVerified: user.emailVerified,
            phone: user.phone,
            phoneVerified: user.phoneVerified
        });
    } catch (err) {
        console.error('KYC status error:', err);
        res.status(500).json({ error: 'Failed to check verification status.' });
    }
});

module.exports = router;
