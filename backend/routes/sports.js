// ============================================
// BetNova — Sports Betting API
// Time-based filters, live matches, grouped responses
// ============================================

const express = require('express');
const router = express.Router();
const Match = require('../models/Match');
const Sport = require('../models/Sport');
const SportsBet = require('../models/SportsBet');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');

// ============================================
// HELPERS
// ============================================
function safeFixed(n, decimals = 2) {
    return parseFloat((n || 0).toFixed(decimals));
}

/**
 * Get priority ordering for sport keys
 */
function getPriorityMap() {
    try {
        const { PRIORITY_LEAGUES } = require('../services/oddsProvider');
        const map = {};
        PRIORITY_LEAGUES.forEach((league, index) => {
            map[league.key] = league.priority || (index + 1);
        });
        return map;
    } catch (_) {
        return {};
    }
}

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
        console.error('Sports list error:', err);
        res.status(500).json({ error: 'Failed to load sports.' });
    }
});

// ============================================
// GET /api/sports/matches
// Time-based filters (from/to ISO OR range)
// Query params:
//   - sport=soccer_epl               (single league)
//   - group=Soccer                   (whole sport group)
//   - from=2026-09-26T00:00:00.000Z  (ISO — client-side date lower bound)
//   - to=2026-09-27T00:00:00.000Z    (ISO — client-side date upper bound)
//   - range=today|tomorrow|week|all  (fallback for no from/to)
//   - search=arsenal                 (team name search)
//   - status=upcoming|live|finished  (or 'all' to skip)
//   - limit=300
//   - format=grouped|flat            (default: grouped)
// ============================================
router.get('/matches', async (req, res) => {
    try {
        const {
            sport,
            group,
            from,
            to,
            range = 'all',
            search,
            status = 'upcoming',
            limit = 300,
            format = 'grouped'
        } = req.query;

        // ---------- Build filter ----------
        const filter = { isActive: true };

        if (sport) filter.sportKey = sport;
        if (group) filter.sportGroup = group;

        // ---------- Time-based filtering ----------
        const now = new Date();
        const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000);

        if (status === 'live') {
            // Matches that started within the last 3 hours
            filter.commenceTime = {
                $lte: now,
                $gte: threeHoursAgo
            };
        } else if (status === 'upcoming') {
            // Matches starting in the future
            filter.commenceTime = { $gt: now };

            // Client-supplied ISO window takes precedence
            if (from || to) {
                if (from) filter.commenceTime.$gte = new Date(from);
                if (to) filter.commenceTime.$lt = new Date(to);
            } else if (range && range !== 'all') {
                // Fallback to server-side range computation
                const rangeBounds = computeRangeBounds(range);
                if (rangeBounds) {
                    filter.commenceTime.$gte = rangeBounds.start;
                    filter.commenceTime.$lt = rangeBounds.end;
                }
            }
        } else if (status === 'finished') {
            filter.commenceTime = { $lt: now };
        } else {
            // status === 'all' or unrecognized — no time filter
        }

        // ---------- Team search ----------
        if (search && search.trim().length >= 2) {
            const regex = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            filter.$or = [
                { homeTeam: regex },
                { awayTeam: regex }
            ];
        }

        // ---------- Fetch ----------
        const matches = await Match.find(filter)
            .sort({ commenceTime: 1 })
            .limit(Math.min(parseInt(limit) || 300, 500))
            .lean();

        // ---------- Return flat if requested ----------
        if (format === 'flat') {
            return res.json({
                matches,
                count: matches.length
            });
        }

        // ---------- Group by league, priority-ordered ----------
        const priorityMap = getPriorityMap();
        const grouped = {};

        for (const m of matches) {
            if (!grouped[m.sportKey]) {
                grouped[m.sportKey] = {
                    sportKey: m.sportKey,
                    sportTitle: m.sportTitle,
                    sportGroup: m.sportGroup,
                    country: m.country || '',
                    priority: priorityMap[m.sportKey] || 999,
                    matches: []
                };
            }
            grouped[m.sportKey].matches.push(m);
        }

        // Sort groups by priority (then alphabetically)
        const sortedGroups = Object.values(grouped).sort((a, b) => {
            if (a.priority !== b.priority) return a.priority - b.priority;
            return a.sportTitle.localeCompare(b.sportTitle);
        });

        res.json({
            groups: sortedGroups,
            totalMatches: matches.length,
            totalLeagues: sortedGroups.length
        });
    } catch (err) {
        console.error('Matches error:', err);
        res.status(500).json({ error: 'Failed to load matches.' });
    }
});

/**
 * Fallback server-side range computation.
 * Only used when client doesn't send from/to ISO params.
 */
function computeRangeBounds(range) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    switch (range) {
        case 'today': {
            const end = new Date(today);
            end.setDate(end.getDate() + 1);
            return { start: today, end };
        }
        case 'tomorrow': {
            const start = new Date(today);
            start.setDate(start.getDate() + 1);
            const end = new Date(start);
            end.setDate(end.getDate() + 1);
            return { start, end };
        }
        case 'week': {
            const end = new Date(today);
            end.setDate(end.getDate() + 7);
            return { start: today, end };
        }
        default:
            return null;
    }
}

// ============================================
// GET /api/sports/leagues
// Returns distinct leagues with match counts
// ============================================
router.get('/leagues', async (req, res) => {
    try {
        const priorityMap = getPriorityMap();
        const now = new Date();

        // Only count upcoming matches (commenceTime in future)
        const leagues = await Match.aggregate([
            {
                $match: {
                    isActive: true,
                    commenceTime: { $gt: now }
                }
            },
            {
                $group: {
                    _id: '$sportKey',
                    sportTitle: { $first: '$sportTitle' },
                    sportGroup: { $first: '$sportGroup' },
                    country: { $first: '$country' },
                    matchCount: { $sum: 1 }
                }
            },
            { $sort: { sportTitle: 1 } }
        ]);

        const enriched = leagues.map(l => ({
            sportKey: l._id,
            sportTitle: l.sportTitle,
            sportGroup: l.sportGroup,
            country: l.country || '',
            matchCount: l.matchCount,
            priority: priorityMap[l._id] || 999
        })).sort((a, b) => {
            if (a.priority !== b.priority) return a.priority - b.priority;
            return a.sportTitle.localeCompare(b.sportTitle);
        });

        res.json({ leagues: enriched });
    } catch (err) {
        console.error('Leagues error:', err);
        res.status(500).json({ error: 'Failed to load leagues.' });
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

        // ---------- Check for duplicate matches ----------
        const matchIds = selections.map(s => s.matchExternalId);
        const uniqueIds = new Set(matchIds);
        if (uniqueIds.size !== matchIds.length) {
            return res.status(400).json({ error: 'Cannot have two picks from the same match.' });
        }

        // ---------- Build selection details ----------
        const detailedSelections = [];
        let totalOdds = 1;

        for (const sel of selections) {
            const match = await Match.findOne({ externalId: sel.matchExternalId });
            if (!match) {
                return res.status(400).json({ error: `Match ${sel.matchExternalId} not found.` });
            }
            if (new Date(match.commenceTime) <= new Date()) {
                return res.status(400).json({
                    error: `Betting closed for ${match.homeTeam} vs ${match.awayTeam}.`
                });
            }

            const pick = sel.pick;
            if (!['home', 'draw', 'away'].includes(pick)) {
                return res.status(400).json({ error: 'Invalid pick. Must be home, draw, or away.' });
            }

            const odds = match.odds[pick];
            if (!odds || odds < 1.01) {
                return res.status(400).json({
                    error: `No odds available for ${match.homeTeam} vs ${match.awayTeam}.`
                });
            }

            // Multiply into accumulator (correct math)
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

        // ---------- Compute payout ----------
        // totalOdds = product of all selection odds
        // Example: 1.20 × 10.30 = 12.36 (NOT 11.50)
        if (totalOdds > 10000) totalOdds = 10000;
        totalOdds = safeFixed(totalOdds);
        const potentialPayout = safeFixed(amt * totalOdds);

        // ---------- Balance check ----------
        if (user.balance < amt) {
            return res.status(400).json({
                error: `Insufficient balance. Available: KES ${safeFixed(user.balance)}`
            });
        }

        // ---------- Deduct balance ----------
        user.balance = safeFixed(user.balance - amt);
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
                metadata: {
                    betId: bet._id,
                    stake: amt,
                    totalOdds,
                    potentialPayout,
                    selections: detailedSelections.length
                }
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
// GET /api/sports/bets/:userId
// ============================================
router.get('/bets/:userId', async (req, res) => {
    try {
        const { status, limit = 100 } = req.query;
        const filter = { userId: req.params.userId };
        if (status) filter.status = status;

        const bets = await SportsBet.find(filter)
            .sort({ createdAt: -1 })
            .limit(Math.min(parseInt(limit) || 100, 200))
            .lean();

        const stats = {
            totalBets: bets.length,
            pending: bets.filter(b => b.status === 'pending').length,
            won: bets.filter(b => b.status === 'won').length,
            lost: bets.filter(b => b.status === 'lost').length,
            totalStaked: safeFixed(bets.reduce((sum, b) => sum + (b.stake || 0), 0)),
            totalPayout: safeFixed(bets.reduce((sum, b) => sum + (b.actualPayout || 0), 0))
        };

        res.json({ bets, stats });
    } catch (err) {
        console.error('Bets load error:', err);
        res.status(500).json({ error: 'Failed to load bets.' });
    }
});

// ============================================
// GET /api/sports/bets/single/:betId
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
// GET /api/sports/stats — platform-wide sports stats
// ============================================
router.get('/stats', async (req, res) => {
    try {
        const now = new Date();
        const [matchCount, leagueCount, upcomingCount, liveCount] = await Promise.all([
            Match.countDocuments({ isActive: true }),
            Match.distinct('sportKey', { isActive: true }).then(arr => arr.length),
            Match.countDocuments({ isActive: true, commenceTime: { $gt: now } }),
            Match.countDocuments({
                isActive: true,
                commenceTime: {
                    $lte: now,
                    $gte: new Date(now.getTime() - 3 * 60 * 60 * 1000)
                }
            })
        ]);

        res.json({
            totalMatches: matchCount,
            activeLeagues: leagueCount,
            upcomingMatches: upcomingCount,
            liveMatches: liveCount
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load stats.' });
    }
});

// ============================================
// POST /api/sports/admin/refresh — force refresh
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

// ============================================
// POST /api/sports/admin/refresh-one
// ============================================
router.post('/admin/refresh-one', async (req, res) => {
    try {
        const adminToken = req.headers['x-admin-token'];
        if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
            return res.status(403).json({ error: 'Unauthorized.' });
        }
        const { sportKey } = req.body;
        if (!sportKey) return res.status(400).json({ error: 'sportKey is required.' });

        const { syncOneSport } = require('../services/oddsProvider');
        const result = await syncOneSport(sportKey);
        res.json({ message: `Refreshed ${sportKey}.`, ...result });
    } catch (err) {
        console.error('Refresh-one error:', err);
        res.status(500).json({ error: 'Refresh failed.' });
    }
});

// ============================================
// POST /api/sports/admin/reset-statuses
// Utility to recompute DB `status` field from commenceTime
// ============================================
router.post('/admin/reset-statuses', async (req, res) => {
    try {
        const adminToken = req.headers['x-admin-token'];
        if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
            return res.status(403).json({ error: 'Unauthorized.' });
        }

        const now = new Date();
        const threeHoursAgo = new Date(now.getTime() - 3 * 60 * 60 * 1000);

        const upcoming = await Match.updateMany(
            { commenceTime: { $gt: now }, status: { $ne: 'upcoming' } },
            { $set: { status: 'upcoming' } }
        );

        const live = await Match.updateMany(
            {
                commenceTime: { $lte: now, $gte: threeHoursAgo },
                status: { $ne: 'live' }
            },
            { $set: { status: 'live' } }
        );

        const finished = await Match.updateMany(
            {
                commenceTime: { $lt: threeHoursAgo },
                status: { $nin: ['finished', 'cancelled'] }
            },
            { $set: { status: 'finished' } }
        );

        res.json({
            message: 'Statuses reset.',
            upcoming: upcoming.modifiedCount,
            live: live.modifiedCount,
            finished: finished.modifiedCount
        });
    } catch (err) {
        console.error('Reset statuses error:', err);
        res.status(500).json({ error: 'Reset failed.' });
    }
});

module.exports = router;
