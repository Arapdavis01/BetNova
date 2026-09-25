const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const connectDB = require('./config/db');
const authRoutes = require('./routes/auth');
const paymentRoutes = require('./routes/payments');
const User = require('./models/User');

const app = express();

// ---------- CORS Configuration ----------
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
        return callback(null, true); // Permissive for deployment flexibility
    },
    credentials: true
}));

app.use(express.json());

// ---------- API Routes ----------
app.use('/api', authRoutes);
app.use('/api/payhero', paymentRoutes);

// ---------- Serve Frontend (Production) ----------
if (process.env.NODE_ENV === 'production') {
    const frontendPath = path.join(__dirname, '../frontend');
    app.use(express.static(frontendPath));

    // SPA fallback — send index.html for any non-API route
    app.get(/^\/(?!api|socket\.io).*/, (req, res) => {
        res.sendFile(path.join(frontendPath, 'index.html'));
    });
}

// ---------- HTTP + Socket.IO Server ----------
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

// ---------- Game State ----------
let gameState = {
    status: "WAITING",     // WAITING, FLYING, CRASHED
    multiplier: 1.00,
    crashPoint: 1.00,
    timer: 5
};

// socketId -> { userId, username, amount, cashedOut, cashoutMultiplier }
const activeBets = new Map();

// Recent crash history (last 20)
const crashHistory = [];

// Currency symbol (Kenya Shillings)
const CURRENCY = 'KES';

function generateCrashPoint() {
    if (Math.random() < 0.03) return 1.00; // 3% instant-crash house edge
    return parseFloat((1.01 / (1.0 - Math.random())).toFixed(2));
}

function broadcastState() {
    io.emit('betnova_tick', gameState);
    io.emit('active_bets_count', activeBets.size);
}

function runEngineLoop() {
    gameState.status = "WAITING";
    gameState.timer = 5;
    gameState.multiplier = 1.00;
    gameState.crashPoint = 1.00;

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
    gameState.crashPoint = generateCrashPoint();

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

    // Record crash point in history
    crashHistory.unshift(gameState.crashPoint);
    if (crashHistory.length > 20) crashHistory.pop();
    io.emit('crash_history', crashHistory);

    // Mark all uncashed bets as lost
    for (const [sid, bet] of activeBets.entries()) {
        if (!bet.cashedOut) {
            io.to(sid).emit('bet_lost', { amount: bet.amount });
            io.emit('feed', {
                msg: `${bet.username} lost ${CURRENCY} ${bet.amount.toFixed(2)} (crashed at ${gameState.multiplier.toFixed(2)}x)`,
                type: 'alert'
            });
        }
    }
    activeBets.clear();

    setTimeout(() => {
        runEngineLoop();
    }, 4000);
}

// ---------- Socket Handling ----------
io.on('connection', (socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);

    // Send initial snapshot
    socket.emit('betnova_tick', gameState);
    socket.emit('crash_history', crashHistory);
    socket.emit('active_bets_count', activeBets.size);

    socket.on('place_bet', async ({ userId, amount }) => {
        try {
            if (gameState.status !== 'WAITING') {
                return socket.emit('bet_error', 'Round already in progress.');
            }
            if (activeBets.has(socket.id)) {
                return socket.emit('bet_error', 'Bet already placed this round.');
            }
            const amt = parseFloat(amount);
            if (!amt || amt <= 0) {
                return socket.emit('bet_error', 'Invalid bet amount.');
            }
            if (amt < 10) {
                return socket.emit('bet_error', `Minimum bet is ${CURRENCY} 10.`);
            }
            if (amt > 100000) {
                return socket.emit('bet_error', `Maximum bet is ${CURRENCY} 100,000.`);
            }

            const user = await User.findById(userId);
            if (!user) return socket.emit('bet_error', 'User not found.');
            if (user.balance < amt) return socket.emit('bet_error', 'Insufficient funds.');

            user.balance = parseFloat((user.balance - amt).toFixed(2));
            await user.save();

            activeBets.set(socket.id, {
                userId: user._id.toString(),
                username: user.username,
                amount: amt,
                cashedOut: false,
                cashoutMultiplier: null
            });

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

            const user = await User.findById(bet.userId);
            if (user) {
                user.balance = parseFloat((user.balance + payout).toFixed(2));
                await user.save();
                socket.emit('balance_update', user.balance);
            }

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

    socket.on('disconnect', async () => {
        console.log(`🔌 Client disconnected: ${socket.id}`);

        // Refund pending bet if the round hasn't crashed yet
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

// ---------- Bootstrap ----------
const PORT = process.env.PORT || 5000;

connectDB().then(() => {
    server.listen(PORT, '0.0.0.0', () => {
        console.log(`🚀 BetNova core backend operating on port ${PORT}`);
        console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
        console.log(`💳 PayHero integration: ${process.env.PAYHERO_USERNAME ? 'ENABLED' : 'DISABLED'}`);
        runEngineLoop();
    });
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully...');
    server.close(() => {
        console.log('Server closed.');
        process.exit(0);
    });
});
