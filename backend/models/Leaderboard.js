const mongoose = require('mongoose');

const LeaderboardSchema = new mongoose.Schema({
    period: {
        type: String,
        enum: ['daily', 'weekly', 'alltime'],
        required: true,
        index: true
    },
    username: {
        type: String,
        required: true
    },
    totalProfit: {
        type: Number,
        required: true
    },
    totalWagered: {
        type: Number,
        required: true
    },
    biggestWin: {
        type: Number,
        required: true
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
});

LeaderboardSchema.index({ period: 1, totalProfit: -1 });

module.exports = mongoose.model('Leaderboard', LeaderboardSchema);
