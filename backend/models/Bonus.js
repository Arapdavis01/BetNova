const mongoose = require('mongoose');

const BonusSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    username: { type: String, required: true },

    type: {
        type: String,
        enum: ['signup', 'referral', 'daily', 'promo', 'deposit_match', 'manual'],
        required: true
    },
    amount: { type: Number, required: true },

    // Wagering
    wageringRequired: { type: Number, required: true },
    wagered: { type: Number, default: 0 },
    cleared: { type: Boolean, default: false },

    // Reference (e.g., referral ID, promo code)
    reference: { type: String, default: null },

    expiresAt: {
        type: Date,
        default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days
    }
}, { timestamps: true });

BonusSchema.index({ userId: 1, createdAt: -1 });
BonusSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Bonus', BonusSchema);
