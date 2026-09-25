const mongoose = require('mongoose');

const BetSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    username: {
        type: String,
        required: true
    },
    roundId: {
        type: Number,
        required: true,
        index: true
    },
    amount: {
        type: Number,
        required: true
    },
    cashedOut: {
        type: Boolean,
        default: false
    },
    cashoutMultiplier: {
        type: Number,
        default: null
    },
    payout: {
        type: Number,
        default: 0
    },
    profit: {
        type: Number,
        default: 0   // payout - amount (negative if lost)
    },
    crashPoint: {
        type: Number,
        required: true
    }
}, { timestamps: true });

// Index for fast user history lookups
BetSchema.index({ userId: 1, createdAt: -1 });
// Index for leaderboard queries
BetSchema.index({ profit: -1, createdAt: -1 });

module.exports = mongoose.model('Bet', BetSchema);
