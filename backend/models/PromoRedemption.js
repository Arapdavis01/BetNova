const mongoose = require('mongoose');

const PromoRedemptionSchema = new mongoose.Schema({
    promotionId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Promotion',
        required: true,
        index: true
    },
    promoCode: { type: String, required: true },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    username: { type: String, required: true },

    bonusAmount: { type: Number, required: true },
    wageringRequired: { type: Number, required: true }
}, { timestamps: true });

PromoRedemptionSchema.index({ promotionId: 1, userId: 1 });

module.exports = mongoose.model('PromoRedemption', PromoRedemptionSchema);
