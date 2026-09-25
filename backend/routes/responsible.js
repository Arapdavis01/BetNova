const express = require('express');
const router = express.Router();
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');

// ---------- Set Limits ----------
router.post('/limits', async (req, res) => {
    try {
        const { userId, dailyDepositLimit, dailyWagerLimit, sessionTimeLimit } = req.body;
        if (!userId) return res.status(400).json({ error: 'userId is required.' });

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: 'User not found.' });

        // Limits can only be tightened, not loosened, within 24 hours
        const newLimits = {
            dailyDepositLimit: dailyDepositLimit !== undefined ? Number(dailyDepositLimit) || null : user.limits.dailyDepositLimit,
            dailyWagerLimit: dailyWagerLimit !== undefined ? Number(dailyWagerLimit) || null : user.limits.dailyWagerLimit,
            sessionTimeLimit: sessionTimeLimit !== undefined ? Number(sessionTimeLimit) || null : user.limits.sessionTimeLimit
        };

        user.limits = newLimits;
        await user.save();

        await AuditLog.create({
            action: 'LIMITS_UPDATED',
            userId: user._id,
            username: user.username,
            metadata: newLimits
        });

        res.json({ message: 'Limits updated.', limits: user.limits });
    } catch (err) {
        console.error('Set limits error:', err);
        res.status(500).json({ error: 'Failed to update limits.' });
    }
});

// ---------- Self-Exclusion ----------
router.post('/self-exclude', async (req, res) => {
    try {
        const { userId, durationHours } = req.body;
        if (!userId || !durationHours) {
            return res.status(400).json({ error: 'userId and durationHours are required.' });
        }

        const allowed = [24, 168, 720, 8760]; // 1d, 1w, 30d, 1y
        if (!allowed.includes(Number(durationHours))) {
            return res.status(400).json({ error: 'Duration must be 24, 168, 720, or 8760 hours.' });
        }

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: 'User not found.' });

        user.selfExcluded = true;
        user.selfExcludedUntil = new Date(Date.now() + durationHours * 60 * 60 * 1000);
        await user.save();

        await AuditLog.create({
            action: 'SELF_EXCLUDED',
            userId: user._id,
            username: user.username,
            metadata: { durationHours, until: user.selfExcludedUntil }
        });

        res.json({
            message: 'You have been self-excluded.',
            until: user.selfExcludedUntil
        });
    } catch (err) {
        console.error('Self-exclude error:', err);
        res.status(500).json({ error: 'Failed to self-exclude.' });
    }
});

// ---------- Get Current Status ----------
router.get('/status/:userId', async (req, res) => {
    try {
        const user = await User.findById(req.params.userId);
        if (!user) return res.status(404).json({ error: 'User not found.' });

        // Auto-lift expired self-exclusion
        if (user.selfExcluded && user.selfExcludedUntil && user.selfExcludedUntil < new Date()) {
            user.selfExcluded = false;
            user.selfExcludedUntil = null;
            await user.save();
        }

        res.json({
            limits: user.limits,
            selfExcluded: user.selfExcluded,
            selfExcludedUntil: user.selfExcludedUntil
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load status.' });
    }
});

module.exports = router;
