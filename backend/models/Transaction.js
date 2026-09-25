const mongoose = require('mongoose');

const TransactionSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    type: {
        type: String,
        enum: ['DEPOSIT', 'WITHDRAWAL'],
        required: true
    },
    amount: {
        type: Number,
        required: true
    },
    phoneNumber: {
        type: String,
        required: true
    },
    reference: {
        type: String,
        required: true,
        unique: true
    },
    payheroReference: {
        type: String,
        default: null
    },
    mpesaReceipt: {
        type: String,
        default: null
    },
    status: {
        type: String,
        enum: ['PENDING', 'SUCCESS', 'FAILED'],
        default: 'PENDING',
        index: true
    },
    failureReason: {
        type: String,
        default: null
    }
}, { timestamps: true });

module.exports = mongoose.model('Transaction', TransactionSchema);
