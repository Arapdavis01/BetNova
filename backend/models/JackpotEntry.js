const mongoose = require('mongoose');

const JackpotEntrySchema = new mongoose.Schema({
    jackpotKey: {
        type: String,
        enum: ['daily', 'weekly', 'mega'],
        required: true,
        index: true
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    username: { type: String, required: true },

    // Entry weight — bigger bets = more chances
    weight: { type: Number, default: 1, min: 0 },
    totalContributed: { type: Number, default: 0, min: 0 },

    // Draw cycle
    cycleId: { type: String, required: true, index: true },

    // Status
    won: { type: Boolean, default: false },
    wonAt: { type: Date, default: null }
}, { timestamps: true });

JackpotEntrySchema.index({ jackpotKey: 1, cycleId: 1 });
JackpotEntrySchema.index({ jackpotKey: 1, cycleId: 1, userId: 1 }, { unique: true });

module.exports = mongoose.model('JackpotEntry', JackpotEntrySchema);
