const mongoose = require('mongoose');

const RoundSchema = new mongoose.Schema({
    roundId: {
        type: Number,
        required: true,
        unique: true,
        index: true
    },
    serverSeedHash: {
        type: String,
        required: true
    },
    serverSeed: {
        type: String,
        default: null   // revealed after crash
    },
    clientSeed: {
        type: String,
        default: 'betnova-public'
    },
    crashPoint: {
        type: Number,
        default: null
    },
    totalBets: {
        type: Number,
        default: 0
    },
    totalWagered: {
        type: Number,
        default: 0
    },
    totalPayout: {
        type: Number,
        default: 0
    },
    revealed: {
        type: Boolean,
        default: false
    }
}, { timestamps: true });

module.exports = mongoose.model('Round', RoundSchema);
