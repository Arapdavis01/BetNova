const mongoose = require('mongoose');

const JackpotSchema = new mongoose.Schema({
    key: {
        type: String,
        enum: ['daily', 'weekly', 'mega'],
        required: true,
        unique: true,
        index: true
    },
    name: { type: String, required: true },
    description: { type: String, default: '' },

    // Pool
    currentPool: { type: Number, default: 0, min: 0 },
    startingPool: { type: Number, default: 0 },  // minimum guaranteed
    totalPaidOut: { type: Number, default: 0 },

    // Configuration
    contributionPercent: { type: Number, default: 2, min: 0, max: 100 },  // % of each bet
    minimumBet: { type: Number, default: 10 },
    drawIntervalHours: { type: Number, default: 24 },
    nextDrawAt: { type: Date, default: null, index: true },

    // Winner tracking
    lastWinner: {
        userId: mongoose.Schema.Types.ObjectId,
        username: String,
        amount: Number,
        drawnAt: Date
    },

    // Stats
    totalContributed: { type: Number, default: 0 },
    drawCount: { type: Number, default: 0 },

    isActive: { type: Boolean, default: true }
}, { timestamps: true });

module.exports = mongoose.model('Jackpot', JackpotSchema);
