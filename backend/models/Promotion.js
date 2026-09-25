const mongoose = require('mongoose');

const PromotionSchema = new mongoose.Schema({
    code: {
        type: String,
        required: true,
        unique: true,
        uppercase: true,
        trim: true,
        index: true
    },
    title: { type: String, required: true },
    description: { type: String, default: '' },

    type: {
        type: String,
        enum: ['fixed_bonus', 'deposit_match', 'free_bet'],
        required: true
    },

    // Value interpretation depends on type:
    // - fixed_bonus: amount is the bonus (e.g., 100)
    // - deposit_match: amount is the multiplier (e.g., 0.5 = 50% match)
    // - free_bet: amount is the free bet value
    amount: { type: Number, required: true },
    maxBonus: { type: Number, default: null },  // cap for deposit_match

    // Constraints
    minDeposit: { type: Number, default: 0 },
    wageringMultiplier: { type: Number, default: 3 },

    // Validity
    validFrom: { type: Date, default: () => new Date() },
    validUntil: { type: Date, default: null, index: true },
    usageLimit: { type: Number, default: null },        // total redemptions allowed
    usagePerUser: { type: Number, default: 1 },         // per-user limit
    usageCount: { type: Number, default: 0 },

    isActive: { type: Boolean, default: true, index: true },

    // Targeting (optional)
    newUsersOnly: { type: Boolean, default: false },
    minAccountAge: { type: Number, default: null }  // hours
}, { timestamps: true });

module.exports = mongoose.model('Promotion', PromotionSchema);
