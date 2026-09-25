const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const User = require('../models/User');
const Bet = require('../models/Bet');
const SportsBet = require('../models/SportsBet');
const Transaction = require('../models/Transaction');
const Referral = require('../models/Referral');
const Bonus = require('../models/Bonus');
const AuditLog = require('../models/AuditLog');

// ============================================
// Generate unique referral code
// ============================================
function generateReferralCode(username) {
    const base = username.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 6);
    const suffix = crypto.randomBytes(2).toString('hex').toUpperCase();
    return `${base}${suffix}`;
}

// ============================================
// GET /api/wallet/transactions/:userId — paginated history
// ============================================
router.get('/transactions/:userId', async (req, res) => {
    try {
        const userId = req.params.userId;
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(50, parseInt(req.query.limit) || 20);
        const skip = (page - 1) * limit;

        // Combine PayHero transactions + bets + sports bets
        const [payhero, aviatorBets, sportsBets] = await Promise.all([
            Transaction.find({ userId }).lean(),
            Bet.find({ userId }).lean(),
            SportsBet.find({ userId }).lean()
        ]);

        // Normalize into a unified format
        const all = [
            ...payhero.map(t => ({
                _id: t._id,
                type: t.type,                      // DEPOSIT / WITHDRAWAL
                amount: t.amount,
                status: t.status,
                reference: t.reference,
                mpesaReceipt: t.mpesaReceipt,
                createdAt: t.createdAt,
                source: 'payhero'
            })),
            ...aviatorBets.map(b => ({
                _id: b._id,
                type: b.cashedOut ? 'WIN' : 'BET_LOSS',
                amount: b.cashedOut ? b.payout : -b.amount,
                stake: b.amount,
                multiplier: b.cashoutMultiplier,
                status: b.cashedOut ? 'WON' : 'LOST',
                reference: `AVIATOR-${b.roundId}`,
                createdAt: b.createdAt,
                source: 'aviator'
            })),
            ...sportsBets.map(b => ({
                _id: b._id,
                type: `SPORTS_${b.status.toUpperCase()}`,
                amount: b.status === 'won' ? b.actualPayout : (b.status === 'lost' ? -b.stake : 0),
                stake: b.stake,
                status: b.status.toUpperCase(),
                reference: `SPORTS-${b._id}`,
                createdAt: b.createdAt,
                source: 'sports'
            }))
        ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        const paginated = all.slice(skip, skip + limit);

        res.json({
            transactions: paginated,
            pagination: {
                page,
                limit,
                total: all.length,
                pages: Math.ceil(all.length / limit)
            }
        });
    } catch (err) {
        console.error('Transaction history error:', err);
        res.status(500).json({ error: 'Failed to load transactions.' });
    }
});

// ============================================
// GET /api/wallet/summary/:userId — cashier summary
// ============================================
router.get('/summary/:userId', async (req, res) => {
    try {
        const user = await User.findById(req.params.userId).select('-password');
        if (!user) return res.status(404).json({ error: 'User not found.' });

        // Total deposits/withdrawals
        const [deposits, withdrawals] = await Promise.all([
            Transaction.aggregate([
                { $match: { userId: user._id, type: 'DEPOSIT', status: 'SUCCESS' } },
                { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
            ]),
            Transaction.aggregate([
                { $match: { userId: user._id, type: 'WITHDRAWAL', status: 'SUCCESS' } },
                { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
            ])
        ]);

        res.json({
            balance: user.balance,
            bonusBalance: user.bonusBalance,
            bonusWageringRequired: user.bonusWageringRequired,
            bonusWagered: user.bonusWagered,
            totalDeposited: deposits[0]?.total || 0,
            totalWithdrawn: withdrawals[0]?.total || 0,
            depositCount: deposits[0]?.count || 0,
            withdrawalCount: withdrawals[0]?.count || 0,
            referralCode: user.referralCode,
            referralEarnings: user.referralEarnings,
            referralCount: user.referralCount,
            dailyStreak: user.dailyStreak,
            lastDailyClaim: user.lastDailyClaim
        });
    } catch (err) {
        console.error('Summary error:', err);
        res.status(500).json({ error: 'Failed to load summary.' });
    }
});

// ============================================
// POST /api/wallet/referral/generate — create user's code
// ============================================
router.post('/referral/generate', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ error: 'userId is required.' });

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: 'User not found.' });

        if (!user.referralCode) {
            let code;
            let exists = true;
            while (exists) {
                code = generateReferralCode(user.username);
                exists = await User.findOne({ referralCode: code });
            }
            user.referralCode = code;
            await user.save();
        }

        res.json({
            referralCode: user.referralCode,
            referralLink: `https://betnova-60lx.onrender.com/?ref=${user.referralCode}`
        });
    } catch (err) {
        console.error('Referral generate error:', err);
        res.status(500).json({ error: 'Failed to generate referral code.' });
    }
});

// ============================================
// POST /api/wallet/referral/apply — new user applies a code
// ============================================
router.post('/referral/apply', async (req, res) => {
    try {
        const { userId, referralCode } = req.body;
        if (!userId || !referralCode) {
            return res.status(400).json({ error: 'userId and referralCode are required.' });
        }

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: 'User not found.' });

        if (user.referredBy) {
            return res.status(400).json({ error: 'You have already used a referral code.' });
        }

        const referrer = await User.findOne({ referralCode: referralCode.toUpperCase() });
        if (!referrer) {
            return res.status(404).json({ error: 'Invalid referral code.' });
        }
        if (referrer._id.toString() === userId) {
            return res.status(400).json({ error: 'You cannot refer yourself.' });
        }

        user.referredBy = referrer._id;
        await user.save();

        // Create referral record (pending until first deposit)
        await Referral.create({
            referrerId: referrer._id,
            referrerUsername: referrer.username,
            refereeId: user._id,
            refereeUsername: user.username,
            claimed: false
        });

        // Give signup bonus to referee
        const refereeBonus = 50;
        user.addBonus(refereeBonus, 3);
        await user.save();

        await Bonus.create({
            userId: user._id,
            username: user.username,
            type: 'signup',
            amount: refereeBonus,
            wageringRequired: refereeBonus * 3,
            reference: referralCode
        });

        await AuditLog.create({
            action: 'REFERRAL_APPLIED',
            userId: user._id,
            username: user.username,
            metadata: { referrerId: referrer._id, referralCode }
        });

        res.json({
            message: 'Referral applied. Signup bonus credited!',
            bonusAmount: refereeBonus
        });
    } catch (err) {
        console.error('Referral apply error:', err);
        res.status(500).json({ error: 'Failed to apply referral code.' });
    }
});

// ============================================
// POST /api/wallet/daily-bonus — claim daily bonus
// ============================================
router.post('/daily-bonus', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ error: 'userId is required.' });

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: 'User not found.' });

        const now = new Date();
        const lastClaim = user.lastDailyClaim;

        if (lastClaim) {
            const hoursSince = (now - lastClaim) / (1000 * 60 * 60);
            if (hoursSince < 20) {
                const hoursLeft = Math.ceil(20 - hoursSince);
                return res.status(400).json({
                    error: `Already claimed today. Come back in ${hoursLeft} hours.`,
                    nextClaimAt: new Date(lastClaim.getTime() + 20 * 60 * 60 * 1000)
                });
            }

            // Streak logic: reset if more than 48 hours since last claim
            const daysSince = hoursSince / 24;
            if (daysSince > 2) {
                user.dailyStreak = 0;
            }
        }

        user.dailyStreak = Math.min(7, (user.dailyStreak || 0) + 1);
        user.lastDailyClaim = now;

        // Bonus amount scales with streak
        const baseAmount = 20;
        const streakBonus = user.dailyStreak * 10;
        const amount = baseAmount + streakBonus;

        user.addBonus(amount, 3);
        await user.save();

        await Bonus.create({
            userId: user._id,
            username: user.username,
            type: 'daily',
            amount,
            wageringRequired: amount * 3,
            reference: `STREAK-${user.dailyStreak}`
        });

        await AuditLog.create({
            action: 'DAILY_BONUS_CLAIMED',
            userId: user._id,
            username: user.username,
            metadata: { amount, streak: user.dailyStreak }
        });

        res.json({
            message: `Day ${user.dailyStreak} bonus claimed!`,
            amount,
            streak: user.dailyStreak,
            nextClaimAt: new Date(now.getTime() + 20 * 60 * 60 * 1000)
        });
    } catch (err) {
        console.error('Daily bonus error:', err);
        res.status(500).json({ error: 'Failed to claim daily bonus.' });
    }
});

// ============================================
// GET /api/wallet/bonus/history/:userId — bonus history
// ============================================
router.get('/bonus/history/:userId', async (req, res) => {
    try {
        const bonuses = await Bonus.find({ userId: req.params.userId })
            .sort({ createdAt: -1 })
            .limit(50)
            .lean();
        res.json({ bonuses });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load bonus history.' });
    }
});

module.exports = router;
