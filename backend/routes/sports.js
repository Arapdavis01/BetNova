const express = require('express');
const router = express.Router();
const Match = require('../models/Match');
const Sport = require('../models/Sport');
const SportsBet = require('../models/SportsBet');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');

// ============================================
// GET /api/sports — list all available sports
// ============================================
router.get('/', async (req, res) => {
    try {
        const sports = await Sport.find({ active: true })
            .select('key group title description')
            .sort({ group: 1, title: 1 })
            .lean();
        res.json(sports);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load sports.' });
    }
});

// ============================================
// GET /api/sports/matches — list upcoming matches
// Query: ?sport=soccer_epl&limit=50
// ============================================
router.get('/matches', async (req, res) => {
    try {
        const { sport, group, status = 'upcoming', limit = 50 } = req.query;
        const filter = { isActive: true };

        if (sport) filter.sportKey = sport;
        if (group) filter.sportGroup = group;
        if (status) filter.status = status;

        const matches = await Match.find(filter)
            .sort({ commenceTime: 1 })
            .limit(Math.min(parseInt(limit), 200))
            .lean();

        res.json({ matches, count: matches.length });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load matches.' });
    }
});

// ============================================
// GET /api/sports/matches/:externalId — single match
// ============================================
router.get('/matches/:externalId', async (req, res) => {
    try {
        const match = await Match.findOne({ externalId: req.params.externalId }).lean();
        if (!match) return res.status(404).json({ error: 'Match not found.' });
        res.json(match);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load match.' });
    }
});

// ============================================
// POST /api/sports/bets — place a bet
// Body: { userId, stake, selections: [{ matchExternalId, pick }] }
// ============================================
router.post('/bets', async (req, res) => {
    try {
        const { userId, stake, selections } = req.body;

        // ---------- Validation ----------
        if (!userId || !stake || !Array.isArray(selections) || selections.length === 0) {
            return res.status(400).json({ error: 'userId, stake, and selections are required.' });
        }
        const amt = parseFloat(stake);
        if (!amt || amt < 10) return res.status(400).json({ error: 'Minimum stake is KES 10.' });
        if (amt > 100000) return res.status(400).json({ error: 'Maximum stake is KES 100,000.' });
        if (selections.length > 20) return res.status(400).json({ error: 'Maximum 20 selections per bet.' });

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: 'User not found.' });
        if (user.status && user.status !== 'active') {
            return res.status(403).json({ error: 'Account is not active.' });
        }
        if (user.selfExcluded && user.selfExcludedUntil > new Date()) {
            return res.status(403).json({ error: 'You are self-excluded from betting.' });
        }
        if (user.balance < amt) return res.status(400).json({ error: 'Insufficient balance.' });

        // ---------- Build selection details ----------
        const detailedSelections = [];
        let totalOdds = 1;

        for (const sel of selections) {
            const match = await Match.findOne({ externalId: sel.matchExternalId });
            if (!match) return res.status(400).json({ error: `Match ${sel.matchExternalId} not found.` });
            if (match.status !== 'upcoming') {
                return res.status(400).json({ error: `Match ${match.homeTeam} vs ${match.awayTeam} is not open for betting.` });
            }
            const pick = sel.pick;
            if (!['home', 'draw', 'away'].includes(pick)) {
                return res.status(400).json({ error: 'Invalid pick.' });
            }
            const odds = match.odds[pick];
            if (!odds || odds < 1.01) {
                return res.status(400).json({ error: `No odds available for ${match.homeTeam} vs ${match.awayTeam}.` });
            }
            totalOdds *= odds;
            detailedSelections.push({
                matchId: match._id,
                matchExternalId: match.externalId,
                homeTeam: match.homeTeam,
                awayTeam: match.awayTeam,
                sportTitle: match.sportTitle,
                commenceTime: match.commenceTime,
                pick,
                odds
            });
        }

        // Cap total odds to prevent abuse
        if (totalOdds > 10000) totalOdds = 10000;
        totalOdds = parseFloat(totalOdds.toFixed(2));
        const potentialPayout = parseFloat((amt * totalOdds).toFixed(2));

        // ---------- Deduct balance ----------
        user.balance = parseFloat((user.balance - amt).toFixed(2));
        await user.save();

        // ---------- Create bet ----------
        const betType = detailedSelections.length === 1 ? 'single' : 'accumulator';
        const bet = await SportsBet.create({
            userId: user._id,
            username: user.username,
            betType,
            selections: detailedSelections,
            stake: amt,
            totalOdds,
            potentialPayout,
            totalSelections: detailedSelections.length
        });

        // ---------- Audit log ----------
        try {
            await AuditLog.create({
                action: 'SPORTSBET_PLACED',
                userId: user._id,
                username: user.username,
                metadata: { betId: bet._id, stake: amt, totalOdds, selections: detailedSelections.length }
            });
        } catch (_) {}

        res.status(201).json({
            message: 'Bet placed successfully.',
            betId: bet._id,
            newBalance: user.balance,
            totalOdds,
            potentialPayout,
            bet
        });
    } catch (err) {
        console.error('Place sports bet error:', err);
        res.status(500).json({ error: 'Failed to place bet.' });
    }
});

// ============================================
// GET /api/sports/bets/:userId — user's sports bets
// ============================================
router.get('/bets/:userId', async (req, res) => {
    try {
        const { status } = req.query;
        const filter = { userId: req.params.userId };
        if (status) filter.status = status;

        const bets = await SportsBet.find(filter)
            .sort({ createdAt: -1 })
            .limit(100)
            .lean();

        res.json({ bets });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load bets.' });
    }
});

// ============================================
// GET /api/sports/bets/single/:betId — single bet detail
// ============================================
router.get('/bets/single/:betId', async (req, res) => {
    try {
        const bet = await SportsBet.findById(req.params.betId).lean();
        if (!bet) return res.status(404).json({ error: 'Bet not found.' });
        res.json(bet);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load bet.' });
    }
});

// ============================================
// POST /api/sports/admin/refresh — force refresh (admin only)
// ============================================
router.post('/admin/refresh', async (req, res) => {
    try {
        const adminToken = req.headers['x-admin-token'];
        if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
            return res.status(403).json({ error: 'Unauthorized.' });
        }
        const { fullRefresh } = require('../services/oddsProvider');
        const result = await fullRefresh();
        res.json({ message: 'Refresh complete.', ...result });
    } catch (err) {
        console.error('Refresh error:', err);
        res.status(500).json({ error: 'Refresh failed.' });
    }
});

module.exports = router;
