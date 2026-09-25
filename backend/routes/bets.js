const express = require('express');
const router = express.Router();
const Bet = require('../models/Bet');

// Get user's bet history (paginated)
router.get('/user/:userId', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = Math.min(parseInt(req.query.limit) || 20, 100);
        const skip = (page - 1) * limit;

        const [bets, total] = await Promise.all([
            Bet.find({ userId: req.params.userId })
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            Bet.countDocuments({ userId: req.params.userId })
        ]);

        res.json({
            bets,
            pagination: {
                page,
                limit,
                total,
                pages: Math.ceil(total / limit)
            }
        });
    } catch (err) {
        console.error('Bet history error:', err);
        res.status(500).json({ error: 'Failed to load bet history.' });
    }
});

// Get user's stats summary
router.get('/stats/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;

        const [stats] = await Bet.aggregate([
            { $match: { userId: new (require('mongoose').Types.ObjectId)(userId) } },
            {
                $group: {
                    _id: null,
                    totalBets: { $sum: 1 },
                    totalWagered: { $sum: '$amount' },
                    totalPayout: { $sum: '$payout' },
                    totalProfit: { $sum: '$profit' },
                    wins: {
                        $sum: { $cond: ['$cashedOut', 1, 0] }
                    },
                    biggestWin: { $max: '$profit' },
                    biggestLoss: { $min: '$profit' }
                }
            }
        ]);

        if (!stats) {
            return res.json({
                totalBets: 0,
                totalWagered: 0,
                totalPayout: 0,
                totalProfit: 0,
                wins: 0,
                losses: 0,
                winRate: 0,
                biggestWin: 0,
                biggestLoss: 0
            });
        }

        const losses = stats.totalBets - stats.wins;
        res.json({
            totalBets: stats.totalBets,
            totalWagered: parseFloat(stats.totalWagered.toFixed(2)),
            totalPayout: parseFloat(stats.totalPayout.toFixed(2)),
            totalProfit: parseFloat(stats.totalProfit.toFixed(2)),
            wins: stats.wins,
            losses,
            winRate: parseFloat(((stats.wins / stats.totalBets) * 100).toFixed(1)),
            biggestWin: parseFloat((stats.biggestWin || 0).toFixed(2)),
            biggestLoss: parseFloat((stats.biggestLoss || 0).toFixed(2))
        });
    } catch (err) {
        console.error('Stats error:', err);
        res.status(500).json({ error: 'Failed to load stats.' });
    }
});

// Get recent rounds (for provably fair verification)
router.get('/rounds/recent', async (req, res) => {
    try {
        const Round = require('../models/Round');
        const rounds = await Round.find({ revealed: true })
            .sort({ roundId: -1 })
            .limit(50)
            .lean();
        res.json(rounds);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load rounds.' });
    }
});

module.exports = router;
