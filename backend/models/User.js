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
    // WALLET
    // ============================================
    balance: {
        type: Number,
        default: 0.00,
        min: 0
    },

    // ============================================
    // KYC — EMAIL (Primary verification method)
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
            // Never expose password hash in JSON responses
            delete ret.password;
            delete ret.__v;
            return ret;
        }
    }
});

// ============================================
// COMPOUND INDEXES (only ones that need multiple fields)
// ============================================
// Single-field indexes are already declared inline above via `index: true`.
// Compound indexes go here because Mongoose can't express them on field definitions.

// Fast lookup for admin dashboard (active users by status + last login)
UserSchema.index({ status: 1, lastLoginAt: -1 });

// Fast lookup for user list by role + created date
UserSchema.index({ role: 1, createdAt: -1 });

// ============================================
// VIRTUAL FIELDS
// ============================================

// Computed: net profit/loss across all deposits/withdrawals
UserSchema.virtual('netCashflow').get(function () {
    return parseFloat((this.totalWithdrawn - this.totalDeposited).toFixed(2));
});

// Computed: is user currently self-excluded?
UserSchema.virtual('isCurrentlyExcluded').get(function () {
    if (!this.selfExcluded) return false;
    if (!this.selfExcludedUntil) return false;
    return this.selfExcludedUntil > new Date();
});

// ============================================
// INSTANCE METHODS
// ============================================

// Check if user can place a bet (not excluded, account active)
UserSchema.methods.canPlaceBet = function () {
    if (this.status !== 'active') return false;
    if (this.selfExcluded && this.selfExcludedUntil > new Date()) return false;
    return true;
};

// Safe public representation (no password, no internal fields)
UserSchema.methods.toPublic = function () {
    return {
        userId: this._id,
        username: this.username,
        balance: this.balance,
        email: this.email,
        emailVerified: this.emailVerified,
        phone: this.phone,
        phoneVerified: this.phoneVerified,
        role: this.role,
        status: this.status,
        selfExcluded: this.selfExcluded,
        selfExcludedUntil: this.selfExcludedUntil,
        limits: this.limits,
        totalDeposited: this.totalDeposited,
        totalWithdrawn: this.totalWithdrawn,
        lastLoginAt: this.lastLoginAt,
        createdAt: this.createdAt
    };
};

module.exports = mongoose.model('User', UserSchema);
