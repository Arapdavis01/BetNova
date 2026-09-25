const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Bet = require('../models/Bet');

// Get leaderboard for a given period
router.get('/:period', async (req, res) => {
    try {
        const period = req.params.period; // 'daily', 'weekly', 'alltime'
        const now = new Date();
        let since = new Date(0);

        if (period === 'daily') {
            since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        } else if (period === 'weekly') {
            since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        } else if (period !== 'alltime') {
            return res.status(400).json({ error: 'Invalid period.' });
        }

        const limit = Math.min(parseInt(req.query.limit) || 10, 50);

        const leaders = await Bet.aggregate([
            { $match: { createdAt: { $gte: since } } },
            {
                $group: {
                    _id: '$userId',
                    username: { $first: '$username' },
                    totalProfit: { $sum: '$profit' },
                    totalWagered: { $sum: '$amount' },
                    biggestWin: { $max: '$profit' },
                    totalBets: { $sum: 1 }
                }
            },
            { $match: { totalProfit: { $gt: 0 } } },
            { $sort: { totalProfit: -1 } },
            { $limit: limit }
        ]);

        res.json({
            period,
            since: since.toISOString(),
            leaders: leaders.map((entry, idx) => ({
                rank: idx + 1,
                username: entry.username,
                totalProfit: parseFloat(entry.totalProfit.toFixed(2)),
                totalWagered: parseFloat(entry.totalWagered.toFixed(2)),
                biggestWin: parseFloat(entry.biggestWin.toFixed(2)),
                totalBets: entry.totalBets
            }))
        });
    } catch (err) {
        console.error('Leaderboard error:', err);
        res.status(500).json({ error: 'Failed to load leaderboard.' });
    }
});

module.exports = router;
