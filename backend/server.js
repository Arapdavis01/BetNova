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

// ---------- Models ----------
const User = require('./models/User');
const Bet = require('./models/Bet');
const Round = require('./models/Round');
const ChatMessage = require('./models/ChatMessage');
const AuditLog = require('./models/AuditLog');

// ---------- Services ----------
const provablyFair = require('./services/provablyFair');

const app = express();

// ============================================
// CORS CONFIGURATION
// ============================================
const allowedOrigins = [
    "http://localhost:3000",
    "http://localhost:5000",
    "http://127.0.0.1:5500",       // VS Code Live Server
    "http://127.0.0.1:3000",
    process.env.CLIENT_URL          // Production frontend URL
].filter(Boolean);

app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (mobile apps, curl, Postman)
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin) || process.env.NODE_ENV !== 'production') {
            return callback(null, true);
        }
        // Permissive for deployment flexibility — tighten in production if needed
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

// ============================================
// SERVE FRONTEND (Production)
// ============================================
if (process.env.NODE_ENV === 'production') {
    const frontendPath = path.join(__dirname, '../frontend');
    app.use(express.static(frontendPath));

    // SPA fallback — send index.html for any non-API route
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
    // Required for proper WebSocket handling behind Render's proxy
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000
});

// ============================================
// GAME STATE
// ============================================
let gameState = {
    status: "WAITING",       // WAITING, FLYING, CRASHED
    multiplier: 1.00,
    crashPoint: 1.00,
    timer: 5,
    roundId: 0,
    serverSeedHash: null
};

// Runtime bet registry: socketId -> { userId, username, amount, cashedOut, cashoutMultiplier }
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

// ============================================
// ENGINE LOOP
// ============================================
async function runEngineLoop() {
    // Begin a new round
    gameState.roundId += 1;
    currentServerSeed = provablyFair.generateServerSeed();
    gameState.serverSeedHash = provablyFair.hashSeed(currentServerSeed);
    gameState.crashPoint = 1.00;
    gameState.multiplier = 1.00;
    gameState.timer = 5;
    gameState.status = "WAITING";

    // Persist round metadata before it starts
    try {
        await Round.create({
            roundId: gameState.roundId,
            serverSeedHash: gameState.serverSeedHash,
            clientSeed: 'betnova-public'
        });
    } catch (err) {
        console.error('Round creation error:', err.message);
    }

    // Broadcast commit hash so players can verify later
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

    // Deterministic crash point derived from the committed seed
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
            broadcastState();
        }
    }, 100);
}

async function explodePlane() {
    gameState.status = "CRASHED";
    broadcastState();

    // Update crash history
    crashHistory.unshift(gameState.crashPoint);
    if (crashHistory.length > 20) crashHistory.pop();
    io.emit('crash_history', crashHistory);

    // Persist round with revealed seed
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

    // Broadcast reveal for client-side verification
    io.emit('round_reveal', {
        roundId: gameState.roundId,
        serverSeed: currentServerSeed,
        crashPoint: gameState.crashPoint
    });

    // Persist losing bets + notify players
    for (const [sid, bet] of activeBets.entries()) {
        if (!bet.cashedOut) {
            io.to(sid).emit('bet_lost', { amount: bet.amount });
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
    activeBets.clear();

    // Next round after short break
    setTimeout(() => {
        runEngineLoop();
    }, 4000);
}

// ============================================
// SOCKET HANDLING
// ============================================
io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);

    // Send initial snapshot
    socket.emit('betnova_tick', gameState);
    socket.emit('crash_history', crashHistory);
    socket.emit('active_bets_count', activeBets.size);
    socket.emit('chat_online', onlineUsers.size);

    if (gameState.serverSeedHash) {
        socket.emit('round_commit', {
            roundId: gameState.roundId,
            serverSeedHash: gameState.serverSeedHash
        });
    }

    // Send recent chat history
    (async () => {
        try {
            const recent = await ChatMessage.find()
                .sort({ createdAt: -1 })
                .limit(30)
                .lean();
            socket.emit('chat_history', recent.reverse());
        } catch (_) {}
    })();

    // ---------- Chat Online Tracking ----------
    socket.on('chat_join', ({ username }) => {
        socket.data.username = username || 'Anonymous';
        onlineUsers.add(socket.id);
        io.emit('chat_online', onlineUsers.size);
    });

    // ---------- Chat Message ----------
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

    // ---------- Place Bet ----------
    socket.on('place_bet', async ({ userId, amount }) => {
        try {
            if (gameState.status !== 'WAITING') {
                return socket.emit('bet_error', 'Round already in progress.');
            }
            if (activeBets.has(socket.id)) {
                return socket.emit('bet_error', 'Bet already placed this round.');
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

            // ---------- Account Status Check ----------
            if (user.status && user.status !== 'active') {
                return socket.emit('bet_error', 'Your account is not active.');
            }

            // ---------- Self-Exclusion Check ----------
            if (user.selfExcluded && user.selfExcludedUntil > new Date()) {
                return socket.emit('bet_error', 'You are self-excluded from betting.');
            }

            // Auto-lift expired exclusion
            if (user.selfExcluded && user.selfExcludedUntil <= new Date()) {
                user.selfExcluded = false;
                user.selfExcludedUntil = null;
            }

            // ---------- Daily Wager Limit Check ----------
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

            if (user.balance < amt) return socket.emit('bet_error', 'Insufficient funds.');

            // Deduct balance
            user.balance = parseFloat((user.balance - amt).toFixed(2));
            await user.save();

            // Register active bet
            activeBets.set(socket.id, {
                userId: user._id.toString(),
                username: user.username,
                amount: amt,
                cashedOut: false,
                cashoutMultiplier: null
            });

            // Audit log
            try {
                await AuditLog.create({
                    action: 'BET_PLACED',
                    userId: user._id,
                    username: user.username,
                    metadata: { amount: amt, roundId: gameState.roundId }
                });
            } catch (_) {}

            socket.emit('balance_update', user.balance);
            socket.emit('bet_placed', { amount: amt });
            io.emit('feed', {
                msg: `${user.username} placed ${CURRENCY} ${amt.toFixed(2)}`,
                type: 'info'
            });
            io.emit('active_bets_count', activeBets.size);
        } catch (err) {
            console.error('place_bet error:', err);
            socket.emit('bet_error', 'Server error while placing bet.');
        }
    });

    // ---------- Cash Out ----------
    socket.on('cash_out', async () => {
        try {
            const bet = activeBets.get(socket.id);
            if (!bet || bet.cashedOut) {
                return socket.emit('bet_error', 'No active bet to cash out.');
            }
            if (gameState.status !== 'FLYING') {
                return socket.emit('bet_error', 'Cannot cash out right now.');
            }

            bet.cashedOut = true;
            bet.cashoutMultiplier = gameState.multiplier;
            const payout = parseFloat((bet.amount * gameState.multiplier).toFixed(2));
            const profit = parseFloat((payout - bet.amount).toFixed(2));

            const user = await User.findById(bet.userId);
            if (user) {
                user.balance = parseFloat((user.balance + payout).toFixed(2));
                await user.save();
                socket.emit('balance_update', user.balance);
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
                    action: 'BET_CASHED_OUT',
                    userId: bet.userId,
                    username: bet.username,
                    metadata: {
                        amount: bet.amount,
                        multiplier: gameState.multiplier,
                        payout,
                        roundId: gameState.roundId
                    }
                });
            } catch (_) {}

            socket.emit('bet_cashed', {
                payout,
                multiplier: gameState.multiplier
            });
            io.emit('feed', {
                msg: `${bet.username} cashed out at ${gameState.multiplier.toFixed(2)}x for ${CURRENCY} ${payout.toFixed(2)}`,
                type: 'success'
            });
        } catch (err) {
            console.error('cash_out error:', err);
            socket.emit('bet_error', 'Server error while cashing out.');
        }
    });

    // ---------- Disconnect ----------
    socket.on('disconnect', async () => {
        console.log(`Client disconnected: ${socket.id}`);

        // Remove from chat presence
        onlineUsers.delete(socket.id);
        io.emit('chat_online', onlineUsers.size);

        // Refund pending bet if round hasn't crashed yet
        const bet = activeBets.get(socket.id);
        if (bet && !bet.cashedOut && gameState.status !== 'CRASHED') {
            try {
                const user = await User.findById(bet.userId);
                if (user) {
                    user.balance = parseFloat((user.balance + bet.amount).toFixed(2));
                    await user.save();
                }
            } catch (e) {
                console.error('Refund error on disconnect:', e);
            }
        }
        activeBets.delete(socket.id);
        io.emit('active_bets_count', activeBets.size);
    });
});

// ============================================
// BOOTSTRAP
// ============================================
const PORT = process.env.PORT || 5000;

connectDB().then(() => {
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 BetNova core backend operating on port ${PORT}`);
        console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
        console.log(`💳 PayHero integration: ${process.env.PAYHERO_USERNAME ? 'ENABLED' : 'DISABLED'}`);
        console.log(`📧 Email OTP: ${process.env.EMAIL_USER && process.env.EMAIL_PASSWORD ? 'ENABLED' : 'DISABLED'}`);
        console.log(`🔐 Provably Fair: ENABLED (SHA-256 commit-reveal)`);
        console.log(`💬 Chat: ENABLED`);
        console.log(`🛡️  Responsible Gambling: ENABLED`);
        console.log(`🎛️  Admin API: ${process.env.ADMIN_TOKEN ? 'ENABLED' : 'DISABLED'}`);

        runEngineLoop();
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
