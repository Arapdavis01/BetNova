const mongoose = require('mongoose');

const MatchSchema = new mongoose.Schema({
    // ============================================
    // EXTERNAL ID (from The Odds API)
    // ============================================
    externalId: {
        type: String,
        required: true,
        unique: true,
        index: true
    },

    // ============================================
    // SPORT METADATA
    // ============================================
    sportKey: {
        type: String,
        required: true,
        index: true
    },
    sportTitle: {
        type: String,
        required: true,
        index: true
    },
    sportGroup: {
        type: String,
        required: true,
        index: true
    },
    // Country (e.g., "England", "Spain", "Europe", "Africa", "Kenya")
    // Used for flag display and league grouping on the frontend
    country: {
        type: String,
        default: '',
        index: true
    },

    // ============================================
    // TEAMS
    // ============================================
    homeTeam: {
        type: String,
        required: true,
        index: true
    },
    awayTeam: {
        type: String,
        required: true,
        index: true
    },

    // ============================================
    // TIMING
    // ============================================
    commenceTime: {
        type: Date,
        required: true,
        index: true
    },

    // ============================================
    // ODDS (1X2 for soccer, moneyline for others)
    // ============================================
    odds: {
        home: { type: Number, default: null, min: 1.00 },
        draw: { type: Number, default: null, min: 1.00 },
        away: { type: Number, default: null, min: 1.00 }
    },

    // ============================================
    // BOOKMAKER REFERENCE
    // ============================================
    bookmakerKey: {
        type: String,
        default: null
    },
    bookmakerTitle: {
        type: String,
        default: null
    },
    lastUpdate: {
        type: Date,
        default: Date.now
    },

    // ============================================
    // SETTLEMENT
    // ============================================
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

    // ============================================
    // METADATA
    // ============================================
    isActive: {
        type: Boolean,
        default: true,
        index: true
    }

}, { timestamps: true });

// ============================================
// COMPOUND INDEXES — for fast queries
// ============================================

// Listing upcoming matches per league
MatchSchema.index({ sportKey: 1, status: 1, commenceTime: 1 });

// Active matches sorted by start time
MatchSchema.index({ isActive: 1, commenceTime: 1 });

// Group queries (sport group + status)
MatchSchema.index({ sportGroup: 1, status: 1, commenceTime: 1 });

// Country filter (for the league sidebar)
MatchSchema.index({ country: 1, isActive: 1 });

// Team search (prefix search on home + away)
MatchSchema.index({ homeTeam: 'text', awayTeam: 'text' });

module.exports = mongoose.model('Match', MatchSchema);
