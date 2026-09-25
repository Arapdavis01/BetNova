const crypto = require('crypto');
const Jackpot = require('../models/Jackpot');
const JackpotEntry = require('../models/JackpotEntry');
const User = require('../models/User');
const Bonus = require('../models/Bonus');
const AuditLog = require('../models/AuditLog');

// ============================================
// ENSURE DEFAULT JACKPOTS EXIST
// ============================================
async function ensureJackpots() {
    const defaults = [
        {
            key: 'daily',
            name: 'Daily Jackpot',
            description: 'Draws every 24 hours. Winners take the full pool.',
            startingPool: 10000,
            contributionPercent: 1,
            drawIntervalHours: 24
        },
        {
            key: 'weekly',
            name: 'Weekly Mega Jackpot',
            description: 'Draws every Sunday at midnight. Bigger pool, bigger prize.',
            startingPool: 100000,
            contributionPercent: 0.5,
            drawIntervalHours: 168
        },
        {
            key: 'mega',
            name: 'Mega Progressive',
            description: 'Minimum KES 1,000,000. Grows until it hits.',
            startingPool: 1000000,
            contributionPercent: 0.3,
            drawIntervalHours: 720  // 30 days
        }
    ];

    for (const def of defaults) {
        const existing = await Jackpot.findOne({ key: def.key });
        if (!existing) {
            const nextDraw = new Date(Date.now() + def.drawIntervalHours * 60 * 60 * 1000);
            await Jackpot.create({
                ...def,
                currentPool: def.startingPool,
                nextDrawAt: nextDraw
            });
            console.log(`[Jackpot] Created "${def.name}" with starting pool KES ${def.startingPool}`);
        }
    }
}

// ============================================
// CONTRIBUTE FROM A BET
// ============================================
async function contributeToJackpots(betAmount, userId, username) {
    try {
        const jackpots = await Jackpot.find({ isActive: true });

        for (const jackpot of jackpots) {
            if (betAmount < jackpot.minimumBet) continue;

            const contribution = parseFloat((betAmount * (jackpot.contributionPercent / 100)).toFixed(2));
            if (contribution <= 0) continue;

            // Update pool
            jackpot.currentPool = parseFloat((jackpot.currentPool + contribution).toFixed(2));
            jackpot.totalContributed = parseFloat((jackpot.totalContributed + contribution).toFixed(2));
            await jackpot.save();

            // Register or update user's entry for this cycle
            const cycleId = jackpot.nextDrawAt
                ? jackpot.nextDrawAt.toISOString().slice(0, 10)
                : new Date().toISOString().slice(0, 10);

            await JackpotEntry.findOneAndUpdate(
                { jackpotKey: jackpot.key, cycleId, userId },
                {
                    $inc: { weight: 1, totalContributed: contribution },
                    $setOnInsert: {
                        username,
                        won: false
                    }
                },
                { upsert: true }
            );
        }
    } catch (err) {
        console.error('[Jackpot] Contribution error:', err.message);
    }
}

// ============================================
// RUN A SINGLE JACKPOT DRAW
// ============================================
async function drawJackpot(jackpotKey) {
    try {
        const jackpot = await Jackpot.findOne({ key: jackpotKey, isActive: true });
        if (!jackpot) return null;

        if (!jackpot.nextDrawAt || jackpot.nextDrawAt > new Date()) {
            return null; // Not due yet
        }

        const cycleId = jackpot.nextDrawAt.toISOString().slice(0, 10);

        // Get all entries for this cycle
        const entries = await JackpotEntry.find({
            jackpotKey,
            cycleId,
            won: false
        });

        if (entries.length === 0) {
            // No entries — rollover the pool
            console.log(`[Jackpot] ${jackpot.name}: no entries, rolling over pool of KES ${jackpot.currentPool}`);

            // Schedule next draw
            jackpot.nextDrawAt = new Date(Date.now() + jackpot.drawIntervalHours * 60 * 60 * 1000);
            await jackpot.save();
            return null;
        }

        // Weighted random selection
        const totalWeight = entries.reduce((sum, e) => sum + Math.max(e.weight, 1), 0);
        const rand = crypto.randomInt(0, totalWeight);
        let cumulative = 0;
        let winner = null;

        for (const entry of entries) {
            cumulative += Math.max(entry.weight, 1);
            if (rand < cumulative) {
                winner = entry;
                break;
            }
        }

        if (!winner) winner = entries[entries.length - 1];

        const prizeAmount = jackpot.currentPool;

        // Credit winner
        const user = await User.findById(winner.userId);
        if (user) {
            user.creditWinnings(prizeAmount);
            await user.save();

            await Bonus.create({
                userId: user._id,
                username: user.username,
                type: 'promo',
                amount: prizeAmount,
                wageringRequired: 0,  // Jackpots are paid immediately, no wagering required
                reference: `JACKPOT-${jackpot.key}-${cycleId}`
            });

            console.log(`[Jackpot] ${jackpot.name} won by ${user.username} — KES ${prizeAmount}`);
        }

        // Mark winner
        winner.won = true;
        winner.wonAt = new Date();
        await winner.save();

        // Update jackpot record
        jackpot.lastWinner = {
            userId: winner.userId,
            username: winner.username,
            amount: prizeAmount,
            drawnAt: new Date()
        };
        jackpot.totalPaidOut = parseFloat((jackpot.totalPaidOut + prizeAmount).toFixed(2));
        jackpot.drawCount += 1;

        // Reset pool to starting minimum
        jackpot.currentPool = jackpot.startingPool;
        jackpot.nextDrawAt = new Date(Date.now() + jackpot.drawIntervalHours * 60 * 60 * 1000);
        await jackpot.save();

        // Audit
        try {
            await AuditLog.create({
                action: 'JACKPOT_DRAWN',
                userId: winner.userId,
                username: winner.username,
                metadata: {
                    jackpotKey: jackpot.key,
                    cycleId,
                    prize: prizeAmount,
                    entries: entries.length
                }
            });
        } catch (_) {}

        return {
            jackpotKey: jackpot.key,
            jackpotName: jackpot.name,
            winner: winner.username,
            amount: prizeAmount,
            entries: entries.length
        };
    } catch (err) {
        console.error(`[Jackpot] Draw error for ${jackpotKey}:`, err.message);
        return null;
    }
}

// ============================================
// RUN ALL DUE DRAWS (called by cron)
// ============================================
async function runDueDraws(io) {
    try {
        const dueJackpots = await Jackpot.find({
            isActive: true,
            nextDrawAt: { $lte: new Date() }
        });

        for (const jackpot of dueJackpots) {
            const result = await drawJackpot(jackpot.key);

            if (result && io) {
                // Broadcast to all connected clients
                io.emit('jackpot_won', result);
                io.emit('feed', {
                    msg: `🎉 ${result.winner} won the ${result.jackpotName} of KES ${result.amount.toLocaleString()}!`,
                    type: 'success'
                });
            }
        }
    } catch (err) {
        console.error('[Jackpot] runDueDraws error:', err.message);
    }
}

// ============================================
// GET PUBLIC STATE
// ============================================
async function getJackpots() {
    const jackpots = await Jackpot.find({ isActive: true }).sort({ currentPool: -1 }).lean();

    return jackpots.map(j => ({
        key: j.key,
        name: j.name,
        description: j.description,
        currentPool: j.currentPool,
        nextDrawAt: j.nextDrawAt,
        lastWinner: j.lastWinner,
        drawCount: j.drawCount,
        totalPaidOut: j.totalPaidOut,
        contributionPercent: j.contributionPercent
    }));
}

async function getUserEntries(userId) {
    const entries = await JackpotEntry.find({ userId, won: false })
        .sort({ createdAt: -1 })
        .lean();

    // Group by jackpot
    const grouped = {};
    for (const entry of entries) {
        if (!grouped[entry.jackpotKey]) {
            grouped[entry.jackpotKey] = {
                jackpotKey: entry.jackpotKey,
                weight: 0,
                totalContributed: 0
            };
        }
        grouped[entry.jackpotKey].weight += entry.weight;
        grouped[entry.jackpotKey].totalContributed += entry.totalContributed;
    }

    return Object.values(grouped);
}

module.exports = {
    ensureJackpots,
    contributeToJackpots,
    drawJackpot,
    runDueDraws,
    getJackpots,
    getUserEntries
};
