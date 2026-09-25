const mongoose = require('mongoose');

const ReferralSchema = new mongoose.Schema({
    referrerId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    referrerUsername: { type: String, required: true },

    refereeId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        unique: true
    },
    refereeUsername: { type: String, required: true },

    // Bonus status
    claimed: { type: Boolean, default: false },
    referrerBonus: { type: Number, default: 0 },
    refereeBonus: { type: Number, default: 0 },

    // Trigger
    firstDepositAmount: { type: Number, default: 0 },
    firstDepositAt: { type: Date, default: null }
}, { timestamps: true });

ReferralSchema.index({ referrerId: 1, createdAt: -1 });

module.exports = mongoose.model('Referral', ReferralSchema);
