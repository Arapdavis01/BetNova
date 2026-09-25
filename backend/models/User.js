const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
    // ============================================
    // AUTHENTICATION
    // ============================================
    username: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        lowercase: true,
        minlength: 3,
        maxlength: 20,
        index: true
    },
    password: {
        type: String,
        required: true
        // Stored as bcrypt hash, never plain text
    },

    // ============================================
    // WALLET — MAIN BALANCE
    // ============================================
    balance: {
        type: Number,
        default: 0.00,
        min: 0
    },

    // ============================================
    // WALLET — BONUS BALANCE
    // Separated from main. Requires wagering before withdrawal.
    // ============================================
    bonusBalance: {
        type: Number,
        default: 0,
        min: 0
    },
    bonusWageringRequired: {
        type: Number,
        default: 0,
        min: 0
    },
    bonusWagered: {
        type: Number,
        default: 0,
        min: 0
    },

    // ============================================
    // KYC — EMAIL
    // ============================================
    email: {
        type: String,
        default: null,
        trim: true,
        lowercase: true,
        index: true
    },
    emailVerified: {
        type: Boolean,
        default: false
    },

    // ============================================
    // KYC — PHONE (Reserved for future SMS)
    // ============================================
    phone: {
        type: String,
        default: null,
        trim: true
    },
    phoneVerified: {
        type: Boolean,
        default: false
    },

    // KYC level: 0 = none, 1 = email, 2 = email + phone, 3 = full ID
    kycLevel: {
        type: Number,
        default: 0,
        min: 0,
        max: 3
    },

    // ============================================
    // REFERRAL SYSTEM
    // ============================================
    referralCode: {
        type: String,
        default: null,
        unique: true,
        sparse: true,
        index: true
    },
    referredBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null
    },
    referralEarnings: {
        type: Number,
        default: 0,
        min: 0
    },
    referralCount: {
        type: Number,
        default: 0,
        min: 0
    },

    // ============================================
    // DAILY BONUS STREAK
    // ============================================
    lastDailyClaim: {
        type: Date,
        default: null
    },
    dailyStreak: {
        type: Number,
        default: 0,
        min: 0,
        max: 7
    },

    // ============================================
    // RESPONSIBLE GAMBLING
    // ============================================
    limits: {
        dailyDepositLimit: {
            type: Number,
            default: null,   // null = no limit
            min: 0
        },
        dailyWagerLimit: {
            type: Number,
            default: null,
            min: 0
        },
        sessionTimeLimit: {
            type: Number,
            default: null,   // minutes
            min: 0
        }
    },
    selfExcluded: {
        type: Boolean,
        default: false
    },
    selfExcludedUntil: {
        type: Date,
        default: null
    },

    // ============================================
    // ROLE / PERMISSIONS
    // ============================================
    role: {
        type: String,
        enum: ['user', 'admin'],
        default: 'user'
    },

    // ============================================
    // ACTIVITY TRACKING
    // ============================================
    lastLoginAt: {
        type: Date,
        default: null,
        index: true
    },
    totalDeposited: {
        type: Number,
        default: 0,
        min: 0
    },
    totalWithdrawn: {
        type: Number,
        default: 0,
        min: 0
    },

    // ============================================
    // ACCOUNT STATUS
    // ============================================
    status: {
        type: String,
        enum: ['active', 'suspended', 'banned'],
        default: 'active'
    }

}, {
    timestamps: true,
    toJSON: {
        transform: function (doc, ret) {
            delete ret.password;
            delete ret.__v;
            return ret;
        }
    }
});

// ============================================
// COMPOUND INDEXES
// ============================================
UserSchema.index({ status: 1, lastLoginAt: -1 });
UserSchema.index({ role: 1, createdAt: -1 });
UserSchema.index({ referredBy: 1, createdAt: -1 });
UserSchema.index({ referralEarnings: -1 });

// ============================================
// VIRTUAL FIELDS
// ============================================

UserSchema.virtual('netCashflow').get(function () {
    return parseFloat((this.totalWithdrawn - this.totalDeposited).toFixed(2));
});

UserSchema.virtual('isCurrentlyExcluded').get(function () {
    if (!this.selfExcluded) return false;
    if (!this.selfExcludedUntil) return false;
    return this.selfExcludedUntil > new Date();
});

UserSchema.virtual('totalBalance').get(function () {
    return parseFloat((this.balance + this.bonusBalance).toFixed(2));
});

UserSchema.virtual('bonusWageringProgress').get(function () {
    if (this.bonusWageringRequired <= 0) return 100;
    const total = this.bonusWagered + this.bonusWageringRequired;
    if (total <= 0) return 100;
    return Math.min(100, (this.bonusWagered / total) * 100);
});

UserSchema.virtual('canClaimDaily').get(function () {
    if (!this.lastDailyClaim) return true;
    const hoursSince = (Date.now() - this.lastDailyClaim.getTime()) / (1000 * 60 * 60);
    return hoursSince >= 20;
});

// ============================================
// INSTANCE METHODS
// ============================================

// Check if user can place a bet
UserSchema.methods.canPlaceBet = function () {
    if (this.status !== 'active') return false;
    if (this.selfExcluded && this.selfExcludedUntil > new Date()) return false;
    return true;
};

// Add bonus with wagering requirement
UserSchema.methods.addBonus = function (amount, wageringMultiplier = 3) {
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return;

    this.bonusBalance = parseFloat((this.bonusBalance + amt).toFixed(2));
    this.bonusWageringRequired = parseFloat(
        (this.bonusWageringRequired + amt * wageringMultiplier).toFixed(2)
    );
};

// Consume balance for a bet — main first, then bonus
// Returns { mainUsed, bonusUsed } or null if insufficient
UserSchema.methods.consumeBalance = function (amount) {
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return null;

    const total = this.balance + this.bonusBalance;
    if (total < amt) return null;

    let mainUsed = 0;
    let bonusUsed = 0;
    let remaining = amt;

    // Main balance first
    if (this.balance >= remaining) {
        mainUsed = remaining;
        remaining = 0;
    } else {
        mainUsed = this.balance;
        remaining -= this.balance;
    }

    // Then bonus balance
    if (remaining > 0 && this.bonusBalance > 0) {
        if (this.bonusBalance >= remaining) {
            bonusUsed = remaining;
            remaining = 0;
        } else {
            bonusUsed = this.bonusBalance;
            remaining -= this.bonusBalance;
        }
    }

    if (remaining > 0) return null;

    this.balance = parseFloat((this.balance - mainUsed).toFixed(2));
    this.bonusBalance = parseFloat((this.bonusBalance - bonusUsed).toFixed(2));

    // Reduce wagering requirement from bonus portion
    if (bonusUsed > 0) {
        this.bonusWagered = parseFloat((this.bonusWagered + bonusUsed).toFixed(2));
        this.bonusWageringRequired = Math.max(
            0,
            parseFloat((this.bonusWageringRequired - bonusUsed).toFixed(2))
        );
    }

    return { mainUsed, bonusUsed };
};

// Credit winnings — always to main balance
UserSchema.methods.creditWinnings = function (amount) {
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return;
    this.balance = parseFloat((this.balance + amt).toFixed(2));
};

// Safe public representation
UserSchema.methods.toPublic = function () {
    return {
        userId: this._id,
        username: this.username,
        balance: this.balance,
        bonusBalance: this.bonusBalance,
        bonusWageringRequired: this.bonusWageringRequired,
        bonusWagered: this.bonusWagered,
        email: this.email,
        emailVerified: this.emailVerified,
        phone: this.phone,
        phoneVerified: this.phoneVerified,
        kycLevel: this.kycLevel,
        role: this.role,
        status: this.status,
        selfExcluded: this.selfExcluded,
        selfExcludedUntil: this.selfExcludedUntil,
        limits: this.limits,
        referralCode: this.referralCode,
        referralEarnings: this.referralEarnings,
        referralCount: this.referralCount,
        dailyStreak: this.dailyStreak,
        lastDailyClaim: this.lastDailyClaim,
        totalDeposited: this.totalDeposited,
        totalWithdrawn: this.totalWithdrawn,
        lastLoginAt: this.lastLoginAt,
        createdAt: this.createdAt
    };
};

module.exports = mongoose.model('User', UserSchema);
