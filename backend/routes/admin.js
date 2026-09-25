const express = require('express');
const router = express.Router();
const adminAuth = require('../middleware/adminAuth');
const User = require('../models/User');
const Bet = require('../models/Bet');
const Round = require('../models/Round');
const Transaction = require('../models/Transaction');
const AuditLog = require('../models/AuditLog');

// ---------- Dashboard Stats ----------
router.get('/stats', adminAuth, async (req, res) => {
    try {
        const now = new Date();
        const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

        const [
            totalUsers,
            activeUsers,
            totalRounds,
            last24Rounds,
            betsLast24,
            depositsLast24,
            withdrawalsLast24
        ] = await Promise.all([
            User.countDocuments(),
            User.countDocuments({ lastLoginAt: { $gte: dayAgo } }),
            Round.countDocuments(),
            Round.countDocuments({ createdAt: { $gte: dayAgo } }),
            Bet.aggregate([
                { $match: { createdAt: { $gte: dayAgo } } },
                {
                    $group: {
                        _id: null,
                        count: { $sum: 1 },
                        wagered: { $sum: '$amount' },
                        payout: { $sum: '$payout' },
                        profit: { $sum: '$profit' }
                    }
                }
            ]),
            Transaction.aggregate([
                { $match: { createdAt: { $gte: dayAgo }, type: 'DEPOSIT', status: 'SUCCESS' } },
                { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
            ]),
            Transaction.aggregate([
                { $match: { createdAt: { $gte: dayAgo }, type: 'WITHDRAWAL', status: 'SUCCESS' } },
                { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
            ])
        ]);

        const betStats = betsLast24[0] || { count: 0, wagered: 0, payout: 0, profit: 0 };
        const depStats = depositsLast24[0] || { total: 0, count: 0 };
        const wdrStats = withdrawalsLast24[0] || { total: 0, count: 0 };

        res.json({
            users: { total: totalUsers, active24h: activeUsers },
            rounds: { total: totalRounds, last24h: last24Rounds },
            bets24h: {
                count: betStats.count,
                wagered: parseFloat(betStats.wagered.toFixed(2)),
                payout: parseFloat(betStats.payout.toFixed(2)),
                houseProfit: parseFloat((-betStats.profit).toFixed(2))
            },
            deposits24h: {
                count: depStats.count,
                total: parseFloat(depStats.total.toFixed(2))
            },
            withdrawals24h: {
                count: wdrStats.count,
                total: parseFloat(wdrStats.total.toFixed(2))
            }
        });
    } catch (err) {
        console.error('Admin stats error:', err);
        res.status(500).json({ error: 'Failed to load stats.' });
    }
});

// ---------- List Recent Rounds ----------
router.get('/rounds', adminAuth, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 50, 200);
        const rounds = await Round.find()
            .sort({ roundId: -1 })
            .limit(limit)
            .lean();
        res.json(rounds);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load rounds.' });
    }
});

// ---------- List Users ----------
router.get('/users', adminAuth, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 50, 200);
        const users = await User.find()
            .select('-password')
            .sort({ createdAt: -1 })
            .limit(limit)
            .lean();
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load users.' });
    }
});

// ---------- Force-Update User Balance ----------
router.post('/users/:userId/balance', adminAuth, async (req, res) => {
    try {
        const { amount, reason } = req.body;
        if (amount === undefined) {
            return res.status(400).json({ error: 'amount is required.' });
        }

        const user = await User.findById(req.params.userId);
        if (!user) return res.status(404).json({ error: 'User not found.' });

        user.balance = parseFloat((user.balance + Number(amount)).toFixed(2));
        await user.save();

        await AuditLog.create({
            action: 'ADMIN_BALANCE_ADJUST',
            userId: user._id,
            username: user.username,
            metadata: { amount, reason, newBalance: user.balance }
        });

        res.json({ message: 'Balance updated.', newBalance: user.balance });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update balance.' });
    }
});

// ---------- Audit Log ----------
router.get('/audit', adminAuth, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 100, 500);
        const logs = await AuditLog.find()
            .sort({ createdAt: -1 })
            .limit(limit)
            .lean();
        res.json(logs);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load audit log.' });
    }
});

module.exports = router;
