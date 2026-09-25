const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

// ---------- Config & Routes ----------
const connectDB = require('./config/db');
const authRoutes = require('./routes/auth');
const paymentRoutes = require('./routes/payments');
const betRoutes = require('./routes/bets');
const leaderboardRoutes = require('./routes/leaderboard');
const kycRoutes = require('./routes/kyc');
const responsibleRoutes = require('./routes/responsible');
const chatRoutes = require('./routes/chat');
const supportRoutes = require('./routes/support');
const adminRoutes = require('./routes/admin');
const walletRoutes = require('./routes/wallet');
const profileRoutes = require('./routes/profile');
const sportsRoutes = require('./routes/sports');

// ---------- Models ----------
const User = require('./models/User');
const Bet = require('./models/Bet');
const Round = require('./models/Round');
const ChatMessage = require('./models/ChatMessage');
const AuditLog = require('./models/AuditLog');

// ---------- Services ----------
const provablyFair = require('./services/provablyFair');
const { fullRefresh } = require('./services/oddsProvider');
const { runSettlementCycle } = require('./services/settler');

const app = express();

// ============================================
// CORS CONFIGURATION
// ============================================
const allowedOrigins = [
    "http://localhost:3000",
    "http://localhost:5000",
    "http://127.0.0.1:5500",
    "http://127.0.0.1:3000",
    process.env.CLIENT_URL
].filter(Boolean);

app.use(cors({
    origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin) || process.env.NODE_ENV !== 'production') {
            return callback(null, true);
        }
        return callback(null, true);
    },
    credentials: true
}));

app.use(express.json({ limit: '1mb' }));

// ============================================
// API ROUTES
// ============================================
app.use('/api', authRoutes);
app.use('/api/payhero', paymentRoutes);
app.use('/api/bets', betRoutes);
app.use('/api/leaderboard', leaderboardRoutes);
app.use('/api/kyc', kycRoutes);
app.use('/api/responsible', responsibleRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/sports', sportsRoutes);

// ============================================
// SERVE FRONTEND (Production)
// ============================================
if (process.env.NODE_ENV === 'production') {
    const frontendPath = path.join(__dirname, '../frontend');

    // ---------- Named page routes (specific routes FIRST) ----------
    app.get('/aviator', (req, res) => {
        res.sendFile(path.join(frontendPath, 'aviator/index.html'));
    });
    app.get('/aviator/', (req, res) => {
        res.sendFile(path.join(frontendPath, 'aviator/index.html'));
    });
    app.get('/crash', (req, res) => {
        res.sendFile(path.join(frontendPath, 'index.html'));
    });
    app.get('/sports', (req, res) => {
        res.sendFile(path.join(frontendPath, 'sports/index.html'));
    });
    app.get('/sports/', (req, res) => {
        res.sendFile(path.join(frontendPath, 'sports/index.html'));
    });
    app.get('/cashier', (req, res) => {
        res.sendFile(path.join(frontendPath, 'cashier/index.html'));
    });
    app.get('/cashier/', (req, res) => {
        res.sendFile(path.join(frontendPath, 'cashier/index.html'));
    });

    // ---------- Static assets ----------
    app.use(express.static(frontendPath));

    // ---------- SPA fallback (main app) ----------
    app.get(/^\/(?!api|socket\.io).*/, (req, res) => {
        res.sendFile(path.join(frontendPath, 'index.html'));
    });
}

// ============================================
// HTTP + SOCKET.IO SERVER
// ============================================
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: allowedOrigins,
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000
});

// ============================================
// GAME STATE
// ============================================
let gameState = {
    status: "WAITING",
    multiplier: 1.00,
    crashPoint: 1.00,
    timer: 5,
    roundId: 0,
    serverSeedHash: null
};

// Runtime bet registry — keyed by `${socketId}:${panel}`
const activeBets = new Map();

// Current secret seed (revealed after crash)
let currentServerSeed = null;

// In-memory crash history for fast broadcast (last 20)
const crashHistory = [];

// Chat online tracking
const onlineUsers = new Set();

const CURRENCY = 'KES';

// ============================================
// BROADCAST HELPERS
// ============================================
function broadcastState() {
    io.emit('betnova_tick', gameState);
    io.emit('active_bets_count', activeBets.size);
    io.emit('chat_online', onlineUsers.size);
}

// ---------- All Bets Feed ----------
function getPublicBets() {
    const bets = [];
    for (const bet of activeBets.values()) {
        bets.push({
            username: bet.username,
            amount: bet.amount,
            cashedOut: bet.cashedOut,
            cashoutMultiplier: bet.cashoutMultiplier,
            avatarColor: bet.avatarColor
        });
    }
    bets.sort((a, b) => {
        if (a.cashedOut !== b.cashedOut) return a.cashedOut ? -1 : 1;
        return b.amount - a.amount;
    });
    return bets;
}

function broadcastAllBets() {
    io.emit('all_bets_update', getPublicBets());
}

// ============================================
// ENGINE LOOP
// ============================================
async function runEngineLoop() {
    gameState.roundId += 1;
    currentServerSeed = provablyFair.generateServerSeed();
    gameState.serverSeedHash = provablyFair.hashSeed(currentServerSeed);
    gameState.crashPoint = 1.00;
    gameState.multiplier = 1.00;
    gameState.timer = 5;
    gameState.status = "WAITING";

    activeBets.clear();
    broadcastAllBets();

    try {
        await Round.create({
            roundId: gameState.roundId,
            serverSeedHash: gameState.serverSeedHash,
            clientSeed: 'betnova-public'
        });
    } catch (err) {
        if (err.code === 11000) {
            console.warn(`Round #${gameState.roundId} already exists — syncing from DB`);
            try {
                const lastRound = await Round.findOne().sort({ roundId: -1 }).select('roundId').lean();
                if (lastRound && lastRound.roundId) {
                    gameState.roundId = lastRound.roundId + 1;
                    console.log(`Adjusted roundId to #${gameState.roundId}`);
                    await Round.create({
                        roundId: gameState.roundId,
                        serverSeedHash: gameState.serverSeedHash,
                        clientSeed: 'betnova-public'
                    });
                }
            } catch (retryErr) {
                console.error('Round creation retry failed:', retryErr.message);
            }
        } else {
            console.error('Round creation error:', err.message);
        }
    }

    io.emit('round_commit', {
        roundId: gameState.roundId,
        serverSeedHash: gameState.serverSeedHash
    });

    const countdown = setInterval(() => {
        broadcastState();
        gameState.timer--;

        if (gameState.timer < 0) {
            clearInterval(countdown);
            launchMultiplier();
        }
    }, 1000);
}

function launchMultiplier() {
    gameState.status = "FLYING";

    gameState.crashPoint = provablyFair.computeCrashPoint(
        currentServerSeed,
        gameState.roundId
    );

    const flight = setInterval(() => {
        if (gameState.multiplier >= gameState.crashPoint) {
            clearInterval(flight);
            gameState.multiplier = gameState.crashPoint;
            explodePlane();
        } else {
            let increment = gameState.multiplier < 3.0 ? 0.02 : 0.07;
            gameState.multiplier = parseFloat((gameState.multiplier + increment).toFixed(2));

            // Server-side auto-cashout check
            for (const [key, bet] of activeBets.entries()) {
                if (!bet.cashedOut && bet.autoCashout && gameState.multiplier >= bet.autoCashout) {
                    executeCashOut(key, bet);
                }
            }

            broadcastState();
        }
    }, 100);
}

// ---------- Reusable cash-out (manual + auto) ----------
async function executeCashOut(betKey, bet) {
    if (!bet || bet.cashedOut) return;
    if (gameState.status !== 'FLYING') return;

    bet.cashedOut = true;
    bet.cashoutMultiplier = gameState.multiplier;
    const payout = parseFloat((bet.amount * gameState.multiplier).toFixed(2));
    const profit = parseFloat((payout - bet.amount).toFixed(2));

    // ---------- Credit user balance (winnings → main balance) ----------
    try {
        const user = await User.findById(bet.userId);
        if (user) {
            user.creditWinnings(payout);
            await user.save();
            io.to(bet.socketId).emit('balance_update', user.balance);
        }
    } catch (err) {
        console.error('Balance credit error:', err.message);
    }

    // Persist winning bet
    try {
        await Bet.create({
            userId: bet.userId,
            username: bet.username,
            roundId: gameState.roundId,
            amount: bet.amount,
            cashedOut: true,
            cashoutMultiplier: gameState.multiplier,
            payout,
            profit,
            crashPoint: gameState.crashPoint
        });
    } catch (err) {
        console.error('Bet persist error:', err.message);
    }

    // Audit log
    try {
        await AuditLog.create({
            action: bet.autoCashout ? 'BET_AUTO_CASHED_OUT' : 'BET_CASHED_OUT',
            userId: bet.userId,
            username: bet.username,
            metadata: {
                amount: bet.amount,
                multiplier: gameState.multiplier,
                payout,
                panel: bet.panel,
                roundId: gameState.roundId
            }
        });
    } catch (_) {}

    // Notify client
    io.to(bet.socketId).emit('bet_cashed', {
        payout,
        multiplier: gameState.multiplier,
        panel: bet.panel,
        auto: !!bet.autoCashout
    });

    io.emit('feed', {
        msg: `${bet.username} cashed out at ${gameState.multiplier.toFixed(2)}x for ${CURRENCY} ${payout.toFixed(2)}`,
        type: 'success'
    });

    broadcastAllBets();
}

async function explodePlane() {
    gameState.status = "CRASHED";
    broadcastState();

    crashHistory.unshift(gameState.crashPoint);
    if (crashHistory.length > 20) crashHistory.pop();
    io.emit('crash_history', crashHistory);

    try {
        await Round.updateOne(
            { roundId: gameState.roundId },
            {
                $set: {
                    serverSeed: currentServerSeed,
                    crashPoint: gameState.crashPoint,
                    totalBets: activeBets.size,
                    totalWagered: Array.from(activeBets.values())
                        .reduce((sum, b) => sum + b.amount, 0),
                    totalPayout: Array.from(activeBets.values())
                        .filter(b => b.cashedOut)
                        .reduce((sum, b) => sum + (b.amount * (b.cashoutMultiplier || 0)), 0),
                    revealed: true
                }
            }
        );
    } catch (err) {
        console.error('Round reveal error:', err.message);
    }

    io.emit('round_reveal', {
        roundId: gameState.roundId,
        serverSeed: currentServerSeed,
        crashPoint: gameState.crashPoint
    });

    // Notify losing bets
    for (const [key, bet] of activeBets.entries()) {
        if (!bet.cashedOut) {
            io.to(bet.socketId).emit('bet_lost', {
                amount: bet.amount,
                panel: bet.panel
            });

            io.emit('feed', {
                msg: `${bet.username} lost ${CURRENCY} ${bet.amount.toFixed(2)} (crashed at ${gameState.multiplier.toFixed(2)}x)`,
                type: 'alert'
            });

            try {
                await Bet.create({
                    userId: bet.userId,
                    username: bet.username,
                    roundId: gameState.roundId,
                    amount: bet.amount,
                    cashedOut: false,
                    cashoutMultiplier: null,
                    payout: 0,
                    profit: -bet.amount,
                    crashPoint: gameState.crashPoint
                });
            } catch (err) {
                console.error('Bet persist error:', err.message);
            }
        }
    }

    broadcastAllBets();

    setTimeout(() => {
        runEngineLoop();
    }, 4000);
}

// ============================================
// SOCKET HANDLING
// ============================================
io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);

    // Initial snapshot
    socket.emit('betnova_tick', gameState);
    socket.emit('crash_history', crashHistory);
    socket.emit('active_bets_count', activeBets.size);
    socket.emit('chat_online', onlineUsers.size);
    socket.emit('all_bets_update', getPublicBets());

    if (gameState.serverSeedHash) {
        socket.emit('round_commit', {
            roundId: gameState.roundId,
            serverSeedHash: gameState.serverSeedHash
        });
    }

    // Recent chat history
    (async () => {
        try {
            const recent = await ChatMessage.find()
                .sort({ createdAt: -1 })
                .limit(30)
                .lean();
            socket.emit('chat_history', recent.reverse());
        } catch (_) {}
    })();

    // ---------- Chat online tracking ----------
    socket.on('chat_join', ({ username }) => {
        socket.data.username = username || 'Anonymous';
        onlineUsers.add(socket.id);
        io.emit('chat_online', onlineUsers.size);
    });

    // ---------- Chat message ----------
    socket.on('chat_message', async ({ userId, username, message }) => {
        try {
            if (!message || message.trim().length === 0) return;
            if (message.length > 200) return;
            if (!userId || !username) return;

            const cleaned = message.trim().slice(0, 200);

            const chatMsg = await ChatMessage.create({
                userId,
                username,
                message: cleaned
            });

            io.emit('chat_message', {
                _id: chatMsg._id,
                username,
                message: cleaned,
                createdAt: chatMsg.createdAt
            });
        } catch (err) {
            console.error('Chat error:', err.message);
        }
    });

    // ---------- Place Bet (Aviator — supports dual panels) ----------
    socket.on('place_bet', async ({ userId, amount, panel = 1, autoCashout = null }) => {
        try {
            if (gameState.status !== 'WAITING') {
                return socket.emit('bet_error', 'Round already in progress.');
            }

            const betKey = `${socket.id}:${panel}`;
            if (activeBets.has(betKey)) {
                return socket.emit('bet_error', 'Bet already placed on this panel.');
            }

            const amt = parseFloat(amount);
            if (!amt || amt < 10) {
                return socket.emit('bet_error', `Minimum bet is ${CURRENCY} 10.`);
            }
            if (amt > 100000) {
                return socket.emit('bet_error', `Maximum bet is ${CURRENCY} 100,000.`);
            }

            const user = await User.findById(userId);
            if (!user) return socket.emit('bet_error', 'User not found.');

            // Account status
            if (user.status && user.status !== 'active') {
                return socket.emit('bet_error', 'Your account is not active.');
            }

            // Self-exclusion
            if (user.selfExcluded && user.selfExcludedUntil > new Date()) {
                return socket.emit('bet_error', 'You are self-excluded from betting.');
            }
            if (user.selfExcluded && user.selfExcludedUntil <= new Date()) {
                user.selfExcluded = false;
                user.selfExcludedUntil = null;
            }

            // Daily wager limit
            if (user.limits && user.limits.dailyWagerLimit) {
                const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
                const todayWagered = await Bet.aggregate([
                    { $match: { userId: user._id, createdAt: { $gte: dayAgo } } },
                    { $group: { _id: null, total: { $sum: '$amount' } } }
                ]);
                const wagered = todayWagered[0]?.total || 0;
                if (wagered + amt > user.limits.dailyWagerLimit) {
                    return socket.emit(
                        'bet_error',
                        `Daily wager limit of ${CURRENCY} ${user.limits.dailyWagerLimit} would be exceeded.`
                    );
                }
            }

            // ---------- Consume balance (main first, then bonus) ----------
            const consumed = user.consumeBalance(amt);
            if (!consumed) {
                return socket.emit('bet_error', 'Insufficient funds.');
            }
            await user.save();

            // Register active bet
            activeBets.set(betKey, {
                socketId: socket.id,
                userId: user._id.toString(),
                username: user.username,
                amount: amt,
                cashedOut: false,
                cashoutMultiplier: null,
                autoCashout: autoCashout && autoCashout >= 1.01 ? parseFloat(autoCashout) : null,
                panel: parseInt(panel) || 1,
                avatarColor: `hsl(${Math.floor(Math.random() * 360)}, 70%, 55%)`
            });

            // Audit log
            try {
                await AuditLog.create({
                    action: 'BET_PLACED',
                    userId: user._id,
                    username: user.username,
                    metadata: {
                        amount: amt,
                        roundId: gameState.roundId,
                        panel,
                        mainUsed: consumed.mainUsed,
                        bonusUsed: consumed.bonusUsed
                    }
                });
            } catch (_) {}

            socket.emit('balance_update', user.balance);
            socket.emit('bonus_update', user.bonusBalance);
            socket.emit('bet_placed', { amount: amt, panel: parseInt(panel) || 1 });
            io.emit('feed', {
                msg: `${user.username} placed ${CURRENCY} ${amt.toFixed(2)}`,
                type: 'info'
            });
            io.emit('active_bets_count', activeBets.size);
            broadcastAllBets();
        } catch (err) {
            console.error('place_bet error:', err);
            socket.emit('bet_error', 'Server error while placing bet.');
        }
    });

    // ---------- Cash Out (Aviator — supports dual panels) ----------
    socket.on('cash_out', async ({ panel = 1 } = {}) => {
        try {
            const betKey = `${socket.id}:${panel}`;
            const bet = activeBets.get(betKey);

            if (!bet || bet.cashedOut) {
                return socket.emit('bet_error', 'No active bet to cash out.');
            }
            if (gameState.status !== 'FLYING') {
                return socket.emit('bet_error', 'Cannot cash out right now.');
            }

            await executeCashOut(betKey, bet);
        } catch (err) {
            console.error('cash_out error:', err);
            socket.emit('bet_error', 'Server error while cashing out.');
        }
    });

    // ---------- Disconnect ----------
    socket.on('disconnect', async () => {
        console.log(`Client disconnected: ${socket.id}`);

        onlineUsers.delete(socket.id);
        io.emit('chat_online', onlineUsers.size);

        // Refund any pending bets for this socket (both panels)
        for (const [key, bet] of activeBets.entries()) {
            if (bet.socketId !== socket.id) continue;

            if (!bet.cashedOut && gameState.status !== 'CRASHED') {
                try {
                    const user = await User.findById(bet.userId);
                    if (user) {
                        // Refund to main balance (refunds never go to bonus)
                        user.creditWinnings(bet.amount);
                        await user.save();
                    }
                } catch (e) {
                    console.error('Refund error on disconnect:', e);
                }
            }
            activeBets.delete(key);
        }

        io.emit('active_bets_count', activeBets.size);
        broadcastAllBets();
    });
});

// ============================================
// PERIODIC ALL-BETS BROADCAST
// ============================================
setInterval(() => {
    if (activeBets.size > 0 || gameState.status !== 'WAITING') {
        broadcastAllBets();
    }
}, 500);

// ============================================
// BOOTSTRAP
// ============================================
const PORT = process.env.PORT || 5000;

connectDB().then(async () => {
    // Resume roundId from DB
    try {
        const lastRound = await Round.findOne()
            .sort({ roundId: -1 })
            .select('roundId')
            .lean();

        if (lastRound && typeof lastRound.roundId === 'number') {
            gameState.roundId = lastRound.roundId;
            console.log(`🔄 Resuming from round #${gameState.roundId}`);
        } else {
            gameState.roundId = 0;
            console.log(`🆕 Starting fresh from round #1`);
        }
    } catch (err) {
        console.error('Failed to load last roundId:', err.message);
        gameState.roundId = 0;
    }

    server.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 BetNova core backend operating on port ${PORT}`);
        console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
        console.log(`💳 PayHero integration: ${process.env.PAYHERO_USERNAME ? 'ENABLED' : 'DISABLED'}`);
        console.log(`📧 Email OTP: ${process.env.EMAIL_USER && process.env.EMAIL_PASSWORD ? 'ENABLED' : 'DISABLED'}`);
        console.log(`🔐 Provably Fair: ENABLED (SHA-256 commit-reveal)`);
        console.log(`💬 Chat: ENABLED`);
        console.log(`🛡️  Responsible Gambling: ENABLED`);
        console.log(`🎛️  Admin API: ${process.env.ADMIN_TOKEN ? 'ENABLED' : 'DISABLED'}`);
        console.log(`✈️  Aviator: ENABLED (/aviator)`);
        console.log(`🏆 Sports Betting: ${process.env.ODDS_API_KEY ? 'ENABLED (/sports)' : 'DISABLED (no ODDS_API_KEY)'}`);
        console.log(`💰 Wallet & Referral: ENABLED (/api/wallet)`);
        console.log(`👤 Profile API: ENABLED (/api/profile)`);

        runEngineLoop();

        // ============================================
        // BACKGROUND JOBS
        // ============================================

        // Initial odds sync — 30 seconds after startup
        if (process.env.ODDS_API_KEY) {
            setTimeout(() => {
                fullRefresh().catch(err => console.error('[Startup] Odds refresh failed:', err.message));
            }, 30000);

            // Refresh odds every 30 minutes
            setInterval(() => {
                fullRefresh().catch(err => console.error('[Cron] Odds refresh failed:', err.message));
            }, 30 * 60 * 1000);

            // Run settlement every 5 minutes
            setInterval(() => {
                runSettlementCycle().catch(err => console.error('[Cron] Settler failed:', err.message));
            }, 5 * 60 * 1000);
        }
    });
});

// ============================================
// GRACEFUL SHUTDOWN
// ============================================
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully...');
    server.close(() => {
        console.log('Server closed.');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down gracefully...');
    server.close(() => {
        console.log('Server closed.');
        process.exit(0);
    });
});
