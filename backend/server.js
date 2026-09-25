const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
require('dotenv').config();

const connectDB = require('./config/db');
const authRoutes = require('./routes/auth');
const User = require('./models/User');

const app = express();
app.use(cors());
app.use(express.json());

// Mount authentication path routes
app.use('/api', authRoutes);

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
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
                msg: `${bet.username} lost $${bet.amount.toFixed(2)} (crashed at ${gameState.multiplier.toFixed(2)}x)`,
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
    // Send initial snapshot
    socket.emit('betnova_tick', gameState);
    socket.emit('crash_history', crashHistory);

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
                msg: `${user.username} placed $${amt.toFixed(2)}`,
                type: 'info'
            });
            io.emit('active_bets_count', activeBets.size);
        } catch (err) {
            console.error(err);
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
                msg: `${bet.username} cashed out at ${gameState.multiplier.toFixed(2)}x for $${payout.toFixed(2)}`,
                type: 'success'
            });
        } catch (err) {
            console.error(err);
            socket.emit('bet_error', 'Server error while cashing out.');
        }
    });

    socket.on('disconnect', async () => {
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
connectDB().then(() => {
    server.listen(process.env.PORT || 5000, () => {
        console.log(`🚀 BetNova core backend operating on port ${process.env.PORT || 5000}`);
        runEngineLoop();
    });
});
