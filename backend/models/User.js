const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
    username: {
        type: String,
        required: true,
        unique: true,
        trim: true
    },
    password: {
        type: String,
        required: true
    },
    balance: {
        type: Number,
        default: 1000.00
    },
    // ---------- KYC ----------
    phone: {
        type: String,
        default: null,
        index: true
    },
    phoneVerified: {
        type: Boolean,
        default: false
    },
    // ---------- Responsible Gambling ----------
    limits: {
        dailyDepositLimit: { type: Number, default: null },   // null = no limit
        dailyWagerLimit: { type: Number, default: null },
        sessionTimeLimit: { type: Number, default: null }      // minutes
    },
    selfExcluded: {
        type: Boolean,
        default: false
    },
    selfExcludedUntil: {
        type: Date,
        default: null
    },
    // ---------- Admin ----------
    role: {
        type: String,
        enum: ['user', 'admin'],
        default: 'user'
    },
    // ---------- Tracking ----------
    lastLoginAt: {
        type: Date,
        default: null
    },
    totalDeposited: {
        type: Number,
        default: 0
    },
    totalWithdrawn: {
        type: Number,
        default: 0
    }
}, { timestamps: true });

module.exports = mongoose.model('User', UserSchema);
