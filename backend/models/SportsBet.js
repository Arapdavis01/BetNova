const mongoose = require('mongoose');

const SelectionSchema = new mongoose.Schema({
    matchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Match', required: true },
    matchExternalId: { type: String, required: true },
    homeTeam: { type: String, required: true },
    awayTeam: { type: String, required: true },
    sportTitle: { type: String, required: true },
    commenceTime: { type: Date, required: true },
    pick: {
        type: String,
        enum: ['home', 'draw', 'away'],
        required: true
    },
    odds: { type: Number, required: true },
    result: {
        type: String,
        enum: ['pending', 'won', 'lost', 'void'],
        default: 'pending'
    }
}, { _id: false });

const SportsBetSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    username: { type: String, required: true },

    // Type of bet
    betType: {
        type: String,
        enum: ['single', 'accumulator'],
        required: true
    },

    // Selections
    selections: {
        type: [SelectionSchema],
        required: true,
        validate: v => v.length > 0 && v.length <= 20
    },

    // Financials
    stake: { type: Number, required: true, min: 10 },
    totalOdds: { type: Number, required: true },
    potentialPayout: { type: Number, required: true },
    actualPayout: { type: Number, default: 0 },

    // Status
    status: {
        type: String,
        enum: ['pending', 'won', 'lost', 'partial', 'void', 'cashed_out'],
        default: 'pending',
        index: true
    },
    settledAt: { type: Date, default: null },

    // For accumulator tracking
    totalSelections: { type: Number, required: true },
    wonSelections: { type: Number, default: 0 },
    lostSelections: { type: Number, default: 0 }
}, { timestamps: true });

SportsBetSchema.index({ userId: 1, createdAt: -1 });
SportsBetSchema.index({ status: 1, createdAt: -1 });

// Method: settle a single selection and update the whole bet
SportsBetSchema.methods.settleSelection = function (matchExternalId, winner) {
    let updated = false;
    for (const sel of this.selections) {
        if (sel.matchExternalId === matchExternalId && sel.result === 'pending') {
            sel.result = sel.pick === winner ? 'won' : (winner === 'void' ? 'void' : 'lost');
            if (sel.result === 'won') this.wonSelections += 1;
            if (sel.result === 'lost') this.lostSelections += 1;
            updated = true;
        }
    }
    if (!updated) return false;

    // If any selection lost → whole accumulator is lost
    if (this.lostSelections > 0) {
        this.status = 'lost';
        this.actualPayout = 0;
        this.settledAt = new Date();
    }
    // If all selections are won or void → payout
    else if (this.wonSelections + this.selections.filter(s => s.result === 'void').length === this.totalSelections) {
        this.status = 'won';
        this.actualPayout = this.potentialPayout;
        this.settledAt = new Date();
    }
    return true;
};

module.exports = mongoose.model('SportsBet', SportsBetSchema);
