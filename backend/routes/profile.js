const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Bet = require('../models/Bet');
const SportsBet = require('../models/SportsBet');

// ============================================
// GET /api/profile/:userId — public profile
// ============================================
router.get('/:userId', async (req, res) => {
    try {
        const user = await User.findById(req.params.userId).select('-password -email');
        if (!user) return res.status(404).json({ error: 'User not found.' });

        // Aggregate stats
        const [aviatorStats, sportsStats] = await Promise.all([
            Bet.aggregate([
                { $match: { userId: user._id } },
                {
                    $group: {
                        _id: null,
                        totalBets: { $sum: 1 },
                        totalWagered: { $sum: '$amount' },
                        totalWon: { $sum: '$payout' },
                        biggestWin: { $max: '$profit' },
                        wins: { $sum: { $cond: ['$cashedOut', 1, 0] } }
                    }
                }
            ]),
            SportsBet.aggregate([
                { $match: { userId: user._id } },
                {
                    $group: {
                        _id: null,
                        totalBets: { $sum: 1 },
                        totalWagered: { $sum: '$stake' },
                        totalWon: { $sum: '$actualPayout' },
                        wins: { $sum: { $cond: [{ $eq: ['$status', 'won'] }, 1, 0] } }
                    }
                }
            ])
        ]);

        const aviator = aviatorStats[0] || { totalBets: 0, totalWagered: 0, totalWon: 0, biggestWin: 0, wins: 0 };
        const sports = sportsStats[0] || { totalBets: 0, totalWagered: 0, totalWon: 0, wins: 0 };

        const totalBets = aviator.totalBets + sports.totalBets;
        const totalWins = aviator.wins + sports.wins;

        res.json({
            username: user.username,
            memberSince: user.createdAt,
            kycLevel: user.kycLevel,
            status: user.status,
            stats: {
                totalBets,
                totalWins,
                winRate: totalBets > 0 ? parseFloat(((totalWins / totalBets) * 100).toFixed(1)) : 0,
                totalWagered: aviator.totalWagered + sports.totalWagered,
                totalWon: aviator.totalWon + sports.totalWon,
                biggestWin: aviator.biggestWin || 0,
                aviatorBets: aviator.totalBets,
                sportsBets: sports.totalBets
            }
        });
    } catch (err) {
        console.error('Profile error:', err);
        res.status(500).json({ error: 'Failed to load profile.' });
    }
});

module.exports = router;
