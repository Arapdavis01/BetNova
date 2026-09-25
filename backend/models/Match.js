const mongoose = require('mongoose');

const MatchSchema = new mongoose.Schema({
    // External ID from the odds provider
    externalId: { type: String, required: true, unique: true, index: true },

    // Sport metadata
    sportKey: { type: String, required: true, index: true },
    sportTitle: { type: String, required: true },
    sportGroup: { type: String, required: true, index: true },

    // Teams
    homeTeam: { type: String, required: true },
    awayTeam: { type: String, required: true },

    // Timing
    commenceTime: { type: Date, required: true, index: true },

    // Odds (1X2 for soccer, moneyline for others)
    odds: {
        home: { type: Number, default: null },
        draw: { type: Number, default: null },
        away: { type: Number, default: null }
    },

    // Bookmaker odds snapshot (for reference)
    bookmakerKey: { type: String, default: null },
    bookmakerTitle: { type: String, default: null },
    lastUpdate: { type: Date, default: Date.now },

    // Settlement
    status: {
        type: String,
        enum: ['upcoming', 'live', 'finished', 'cancelled'],
        default: 'upcoming',
        index: true
    },
    scores: {
        home: { type: Number, default: null },
        away: { type: Number, default: null }
    },
    winner: {
        type: String,
        enum: ['home', 'draw', 'away', null],
        default: null
    },

    // Metadata
    isActive: { type: Boolean, default: true, index: true }
}, { timestamps: true });

MatchSchema.index({ commenceTime: 1, isActive: 1 });
MatchSchema.index({ sportKey: 1, commenceTime: 1 });

module.exports = mongoose.model('Match', MatchSchema);
