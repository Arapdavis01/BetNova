const mongoose = require('mongoose');

const SupportTicketSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    username: {
        type: String,
        required: true
    },
    category: {
        type: String,
        enum: ['deposit', 'withdrawal', 'game', 'account', 'other'],
        required: true
    },
    subject: {
        type: String,
        required: true,
        maxlength: 100
    },
    message: {
        type: String,
        required: true,
        maxlength: 2000
    },
    status: {
        type: String,
        enum: ['open', 'in_progress', 'resolved', 'closed'],
        default: 'open',
        index: true
    },
    adminResponse: {
        type: String,
        default: null
    }
}, { timestamps: true });

module.exports = mongoose.model('SupportTicket', SupportTicketSchema);
