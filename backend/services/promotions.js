const Promotion = require('../models/Promotion');
const PromoRedemption = require('../models/PromoRedemption');
const User = require('../models/User');
const Bonus = require('../models/Bonus');
const AuditLog = require('../models/AuditLog');

/**
 * Validate a promo code without applying it
 */
async function validateCode(code, userId) {
    const promo = await Promotion.findOne({
        code: code.toUpperCase().trim(),
        isActive: true
    });

    if (!promo) return { valid: false, error: 'Invalid promo code.' };

    const now = new Date();
    if (promo.validFrom && promo.validFrom > now) {
        return { valid: false, error: 'This promo code is not yet active.' };
    }
    if (promo.validUntil && promo.validUntil < now) {
        return { valid: false, error: 'This promo code has expired.' };
    }
    if (promo.usageLimit && promo.usageCount >= promo.usageLimit) {
        return { valid: false, error: 'This promo has reached its usage limit.' };
    }

    // User-specific checks
    const user = await User.findById(userId);
    if (!user) return { valid: false, error: 'User not found.' };

    const userRedemptions = await PromoRedemption.countDocuments({
        promotionId: promo._id,
        userId: user._id
    });

    if (userRedemptions >= promo.usagePerUser) {
        return { valid: false, error: 'You have already used this promo code.' };
    }

    if (promo.newUsersOnly) {
        const accountAgeHours = (Date.now() - user.createdAt.getTime()) / (1000 * 60 * 60);
        if (accountAgeHours > 24) {
            return { valid: false, error: 'This promo is for new users only.' };
        }
    }

    return { valid: true, promotion: promo };
}

/**
 * Apply a promo code — credits bonus to user
 */
async function redeemCode(code, userId) {
    const validation = await validateCode(code, userId);
    if (!validation.valid) return validation;

    const promo = validation.promotion;
    const user = await User.findById(userId);

    let bonusAmount = 0;

    switch (promo.type) {
        case 'fixed_bonus':
            bonusAmount = promo.amount;
            break;

        case 'deposit_match':
            // Applied on next deposit — just flag user for now
            // For simplicity, credit a preview bonus
            bonusAmount = Math.min(
                promo.maxBonus || promo.amount,
                promo.amount
            );
            break;

        case 'free_bet':
            bonusAmount = promo.amount;
            break;
    }

    if (bonusAmount <= 0) {
        return { valid: false, error: 'This promo has no bonus amount.' };
    }

    // Credit bonus
    user.addBonus(bonusAmount, promo.wageringMultiplier);
    await user.save();

    // Record redemption
    await PromoRedemption.create({
        promotionId: promo._id,
        promoCode: promo.code,
        userId: user._id,
        username: user.username,
        bonusAmount,
        wageringRequired: bonusAmount * promo.wageringMultiplier
    });

    // Increment usage count
    promo.usageCount += 1;
    await promo.save();

    // Bonus record
    await Bonus.create({
        userId: user._id,
        username: user.username,
        type: 'promo',
        amount: bonusAmount,
        wageringRequired: bonusAmount * promo.wageringMultiplier,
        reference: promo.code
    });

    // Audit
    try {
        await AuditLog.create({
            action: 'PROMO_REDEEMED',
            userId: user._id,
            username: user.username,
            metadata: {
                promoCode: promo.code,
                promoType: promo.type,
                bonusAmount
            }
        });
    } catch (_) {}

    return {
        valid: true,
        bonusAmount,
        newBonusBalance: user.bonusBalance,
        message: `Bonus of KES ${bonusAmount} credited!`
    };
}

/**
 * List active promotions for a user
 */
async function listActivePromotions() {
    const now = new Date();
    return Promotion.find({
        isActive: true,
        validFrom: { $lte: now },
        $or: [
            { validUntil: null },
            { validUntil: { $gte: now } }
        ]
    })
        .select('-usageCount -usageLimit -_id')
        .sort({ createdAt: -1 })
        .limit(20)
        .lean();
}

module.exports = {
    validateCode,
    redeemCode,
    listActivePromotions
};
