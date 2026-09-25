const express = require('express');
const router = express.Router();
const adminAuth = require('../middleware/adminAuth');
const User = require('../models/User');
const Bet = require('../models/Bet');
const Round = require('../models/Round');
const Transaction = require('../models/Transaction');
const AuditLog = require('../models/AuditLog');
const SupportTicket = require('../models/SupportTicket');
const Referral = require('../models/Referral');
const Bonus = require('../models/Bonus');

// ============================================
// HELPER: Safe number
// ============================================
function safeFixed(n, decimals = 2) {
    return parseFloat((n || 0).toFixed(decimals));
}

// ============================================
// DASHBOARD STATS
// GET /api/admin/stats
// ============================================
router.get('/stats', adminAuth, async (req, res) => {
    try {
        const now = new Date();
        const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

        const [
            totalUsers,
            activeUsers,
            suspendedUsers,
            totalRounds,
            last24Rounds,
            betsLast24,
            depositsLast24,
            withdrawalsLast24,
            openTickets,
            totalReferrals
        ] = await Promise.all([
            User.countDocuments(),
            User.countDocuments({ lastLoginAt: { $gte: dayAgo } }),
            User.countDocuments({ status: { $in: ['suspended', 'banned'] } }),
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
            ]),
            SupportTicket.countDocuments({ status: 'open' }),
            Referral.countDocuments({ claimed: true })
        ]);

        const betStats = betsLast24[0] || { count: 0, wagered: 0, payout: 0, profit: 0 };
        const depStats = depositsLast24[0] || { total: 0, count: 0 };
        const wdrStats = withdrawalsLast24[0] || { total: 0, count: 0 };

        res.json({
            users: {
                total: totalUsers,
                active24h: activeUsers,
                suspended: suspendedUsers
            },
            rounds: { total: totalRounds, last24h: last24Rounds },
            bets24h: {
                count: betStats.count,
                wagered: safeFixed(betStats.wagered),
                payout: safeFixed(betStats.payout),
                houseProfit: safeFixed(-betStats.profit)
            },
            deposits24h: {
                count: depStats.count,
                total: safeFixed(depStats.total)
            },
            withdrawals24h: {
                count: wdrStats.count,
                total: safeFixed(wdrStats.total)
            },
            support: { openTickets },
            referral: { claimed: totalReferrals }
        });
    } catch (err) {
        console.error('Admin stats error:', err);
        res.status(500).json({ error: 'Failed to load stats.' });
    }
});

// ============================================
// LIVE GAME STATE
// GET /api/admin/game-state
// ============================================
router.get('/game-state', adminAuth, async (req, res) => {
    try {
        // Access the shared game state if exposed
        // Fall back to reading the latest Round for context
        const gameState = global.gameState || {};

        const lastRound = await Round.findOne()
            .sort({ roundId: -1 })
            .select('roundId crashPoint status createdAt')
            .lean();

        res.json({
            status: gameState.status || 'WAITING',
            roundId: gameState.roundId || (lastRound?.roundId || 0),
            multiplier: gameState.multiplier || 1.00,
            timer: gameState.timer || 5,
            crashPoint: gameState.crashPoint || lastRound?.crashPoint || 1.00,
            activeBets: global.activeBetsCount || 0,
            lastRound: lastRound ? {
                roundId: lastRound.roundId,
                crashPoint: lastRound.crashPoint,
                createdAt: lastRound.createdAt
            } : null,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        console.error('Game state error:', err);
        res.status(500).json({ error: 'Failed to load game state.' });
    }
});

// ============================================
// LIST RECENT ROUNDS
// GET /api/admin/rounds?limit=50&status=revealed
// ============================================
router.get('/rounds', adminAuth, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 50, 500);
        const { status } = req.query;

        const filter = {};
        if (status === 'revealed') filter.revealed = true;
        if (status === 'pending') filter.revealed = false;

        const rounds = await Round.find(filter)
            .sort({ roundId: -1 })
            .limit(limit)
            .lean();

        res.json(rounds);
    } catch (err) {
        console.error('Rounds error:', err);
        res.status(500).json({ error: 'Failed to load rounds.' });
    }
});

// ============================================
// LIST USERS
// GET /api/admin/users?limit=50&search=xxx&status=active
// ============================================
router.get('/users', adminAuth, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 50, 500);
        const { search, status, sort } = req.query;

        const filter = {};
        if (search) {
            filter.username = { $regex: new RegExp(search, 'i') };
        }
        if (status) {
            filter.status = status;
        }

        let sortBy = { createdAt: -1 };
        if (sort === 'balance') sortBy = { balance: -1 };
        if (sort === 'referrals') sortBy = { referralEarnings: -1 };
        if (sort === 'recent') sortBy = { lastLoginAt: -1 };

        const users = await User.find(filter)
            .select('-password')
            .sort(sortBy)
            .limit(limit)
            .lean();

        res.json(users);
    } catch (err) {
        console.error('Users error:', err);
        res.status(500).json({ error: 'Failed to load users.' });
    }
});

// ============================================
// GET SINGLE USER
// GET /api/admin/users/:userId
// ============================================
router.get('/users/:userId', adminAuth, async (req, res) => {
    try {
        const user = await User.findById(req.params.userId).select('-password').lean();
        if (!user) return res.status(404).json({ error: 'User not found.' });

        // Enrich with recent bets
        const recentBets = await Bet.find({ userId: user._id })
            .sort({ createdAt: -1 })
            .limit(10)
            .lean();

        // Recent transactions
        const recentTx = await Transaction.find({ userId: user._id })
            .sort({ createdAt: -1 })
            .limit(10)
            .lean();

        res.json({ user, recentBets, recentTransactions: recentTx });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load user.' });
    }
});

// ============================================
// ADJUST USER BALANCE
// POST /api/admin/users/:userId/balance
// Body: { amount, reason }
// ============================================
router.post('/users/:userId/balance', adminAuth, async (req, res) => {
    try {
        const { amount, reason } = req.body;

        if (amount === undefined || amount === null) {
            return res.status(400).json({ error: 'amount is required.' });
        }

        const amt = Number(amount);
        if (isNaN(amt) || amt === 0) {
            return res.status(400).json({ error: 'amount must be a non-zero number.' });
        }

        const user = await User.findById(req.params.userId);
        if (!user) return res.status(404).json({ error: 'User not found.' });

        const newBalance = parseFloat((user.balance + amt).toFixed(2));
        if (newBalance < 0) {
            return res.status(400).json({
                error: `Cannot reduce balance below 0. Current: ${user.balance}, requested: ${amt}`
            });
        }

        const previousBalance = user.balance;
        user.balance = newBalance;
        await user.save();

        await AuditLog.create({
            action: 'ADMIN_BALANCE_ADJUST',
            userId: user._id,
            username: user.username,
            metadata: {
                amount: amt,
                reason: reason || 'No reason provided',
                previousBalance,
                newBalance: user.balance
            }
        });

        res.json({
            message: 'Balance updated.',
            previousBalance,
            newBalance: user.balance
        });
    } catch (err) {
        console.error('Balance adjust error:', err);
        res.status(500).json({ error: 'Failed to update balance.' });
    }
});

// ============================================
// ADJUST USER BONUS BALANCE
// POST /api/admin/users/:userId/bonus
// Body: { amount, reason }
// ============================================
router.post('/users/:userId/bonus', adminAuth, async (req, res) => {
    try {
        const { amount, reason } = req.body;

        if (amount === undefined || amount === null) {
            return res.status(400).json({ error: 'amount is required.' });
        }

        const amt = Number(amount);
        if (isNaN(amt) || amt === 0) {
            return res.status(400).json({ error: 'amount must be a non-zero number.' });
        }

        const user = await User.findById(req.params.userId);
        if (!user) return res.status(404).json({ error: 'User not found.' });

        const previousBonus = user.bonusBalance;

        if (amt > 0) {
            user.addBonus(amt, 3); // 3× wagering
        } else {
            user.bonusBalance = Math.max(0, parseFloat((user.bonusBalance + amt).toFixed(2)));
        }
        await user.save();

        await Bonus.create({
            userId: user._id,
            username: user.username,
            type: 'manual',
            amount: amt,
            wageringRequired: amt > 0 ? amt * 3 : 0,
            reference: `ADMIN-${Date.now()}`
        });

        await AuditLog.create({
            action: 'ADMIN_BONUS_ADJUST',
            userId: user._id,
            username: user.username,
            metadata: {
                amount: amt,
                reason: reason || 'No reason provided',
                previousBonus,
                newBonus: user.bonusBalance
            }
        });

        res.json({
            message: 'Bonus balance updated.',
            previousBonus,
            newBonus: user.bonusBalance
        });
    } catch (err) {
        console.error('Bonus adjust error:', err);
        res.status(500).json({ error: 'Failed to update bonus balance.' });
    }
});

// ============================================
// CHANGE USER STATUS
// POST /api/admin/users/:userId/status
// Body: { status, reason }
// ============================================
router.post('/users/:userId/status', adminAuth, async (req, res) => {
    try {
        const { status, reason } = req.body;

        if (!['active', 'suspended', 'banned'].includes(status)) {
            return res.status(400).json({ error: 'Invalid status. Must be active, suspended, or banned.' });
        }

        const user = await User.findById(req.params.userId);
        if (!user) return res.status(404).json({ error: 'User not found.' });

        const previousStatus = user.status;
        user.status = status;
        await user.save();

        await AuditLog.create({
            action: 'ADMIN_USER_STATUS_CHANGE',
            userId: user._id,
            username: user.username,
            metadata: {
                previousStatus,
                newStatus: status,
                reason: reason || 'No reason provided'
            }
        });

        res.json({
            message: `User status changed to ${status}.`,
            previousStatus,
            newStatus: user.status
        });
    } catch (err) {
        console.error('Status change error:', err);
        res.status(500).json({ error: 'Failed to update status.' });
    }
});

// ============================================
// FORCE SELF-EXCLUSION
// POST /api/admin/users/:userId/exclude
// Body: { durationHours, reason }
// ============================================
router.post('/users/:userId/exclude', adminAuth, async (req, res) => {
    try {
        const { durationHours, reason } = req.body;

        const hours = Number(durationHours) || 24;
        if (hours < 1 || hours > 8760) {
            return res.status(400).json({ error: 'Duration must be 1-8760 hours.' });
        }

        const user = await User.findById(req.params.userId);
        if (!user) return res.status(404).json({ error: 'User not found.' });

        user.selfExcluded = true;
        user.selfExcludedUntil = new Date(Date.now() + hours * 60 * 60 * 1000);
        await user.save();

        await AuditLog.create({
            action: 'ADMIN_FORCE_EXCLUDE',
            userId: user._id,
            username: user.username,
            metadata: {
                durationHours: hours,
                until: user.selfExcludedUntil,
                reason: reason || 'No reason provided'
            }
        });

        res.json({
            message: `User excluded for ${hours} hours.`,
            selfExcludedUntil: user.selfExcludedUntil
        });
    } catch (err) {
        console.error('Force exclude error:', err);
        res.status(500).json({ error: 'Failed to exclude user.' });
    }
});

// ============================================
// SUPPORT TICKETS
// GET /api/admin/tickets?status=open&limit=100
// ============================================
router.get('/tickets', adminAuth, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 100, 500);
        const { status } = req.query;

        const filter = {};
        if (status) filter.status = status;

        const tickets = await SupportTicket.find(filter)
            .sort({ createdAt: -1 })
            .limit(limit)
            .lean();

        res.json(tickets);
    } catch (err) {
        console.error('Tickets error:', err);
        res.status(500).json({ error: 'Failed to load tickets.' });
    }
});

// ============================================
// TICKET STATS
// GET /api/admin/tickets/stats
// ============================================
router.get('/tickets/stats', adminAuth, async (req, res) => {
    try {
        const [open, inProgress, resolved, closed] = await Promise.all([
            SupportTicket.countDocuments({ status: 'open' }),
            SupportTicket.countDocuments({ status: 'in_progress' }),
            SupportTicket.countDocuments({ status: 'resolved' }),
            SupportTicket.countDocuments({ status: 'closed' })
        ]);

        res.json({ open, inProgress, resolved, closed, total: open + inProgress + resolved + closed });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load ticket stats.' });
    }
});

// ============================================
// RESPOND TO TICKET
// POST /api/admin/tickets/:ticketId/respond
// Body: { response, status }
// ============================================
router.post('/tickets/:ticketId/respond', adminAuth, async (req, res) => {
    try {
        const { response, status } = req.body;

        if (!response || response.trim().length === 0) {
            return res.status(400).json({ error: 'Response is required.' });
        }

        const ticket = await SupportTicket.findById(req.params.ticketId);
        if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });

        ticket.adminResponse = response.trim().slice(0, 2000);
        ticket.status = ['in_progress', 'resolved', 'closed'].includes(status) ? status : 'resolved';
        await ticket.save();

        await AuditLog.create({
            action: 'ADMIN_TICKET_RESPONSE',
            userId: ticket.userId,
            username: ticket.username,
            metadata: {
                ticketId: ticket._id,
                newStatus: ticket.status
            }
        });

        res.json({ message: 'Response saved.', ticket });
    } catch (err) {
        console.error('Ticket respond error:', err);
        res.status(500).json({ error: 'Failed to respond to ticket.' });
    }
});

// ============================================
// AUDIT LOG
// GET /api/admin/audit?limit=100&action=xxx&userId=xxx
// ============================================
router.get('/audit', adminAuth, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 100, 500);
        const { action, userId } = req.query;

        const filter = {};
        if (action) filter.action = { $regex: new RegExp(action, 'i') };
        if (userId) filter.userId = userId;

        const logs = await AuditLog.find(filter)
            .sort({ createdAt: -1 })
            .limit(limit)
            .lean();

        res.json(logs);
    } catch (err) {
        console.error('Audit error:', err);
        res.status(500).json({ error: 'Failed to load audit log.' });
    }
});

// ============================================
// LIST TRANSACTIONS
// GET /api/admin/transactions?limit=100&type=DEPOSIT&status=SUCCESS
// ============================================
router.get('/transactions', adminAuth, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 100, 500);
        const { type, status, userId } = req.query;

        const filter = {};
        if (type) filter.type = type;
        if (status) filter.status = status;
        if (userId) filter.userId = userId;

        const transactions = await Transaction.find(filter)
            .sort({ createdAt: -1 })
            .limit(limit)
            .lean();

        res.json(transactions);
    } catch (err) {
        console.error('Transactions error:', err);
        res.status(500).json({ error: 'Failed to load transactions.' });
    }
});

// ============================================
// LIST REFERRALS
// GET /api/admin/referrals?limit=100
// ============================================
router.get('/referrals', adminAuth, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 100, 500);
        const { claimed } = req.query;

        const filter = {};
        if (claimed === 'true') filter.claimed = true;
        if (claimed === 'false') filter.claimed = false;

        const referrals = await Referral.find(filter)
            .sort({ createdAt: -1 })
            .limit(limit)
            .lean();

        res.json(referrals);
    } catch (err) {
        console.error('Referrals error:', err);
        res.status(500).json({ error: 'Failed to load referrals.' });
    }
});

// ============================================
// PLATFORM HEALTH CHECK
// GET /api/admin/health
// ============================================
router.get('/health', adminAuth, async (req, res) => {
    try {
        const [userCount, roundCount, lastRound] = await Promise.all([
            User.countDocuments(),
            Round.countDocuments(),
            Round.findOne().sort({ roundId: -1 }).select('roundId createdAt').lean()
        ]);

        res.json({
            status: 'healthy',
            database: 'connected',
            userCount,
            roundCount,
            lastRound,
            uptime: process.uptime(),
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        res.status(500).json({
            status: 'unhealthy',
            error: err.message
        });
    }
});

module.exports = router;
