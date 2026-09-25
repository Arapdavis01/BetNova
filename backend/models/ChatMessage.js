const mongoose = require('mongoose');

const ChatMessageSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    username: {
        type: String,
        required: true
    },
    message: {
        type: String,
        required: true,
        maxlength: 200
    },
    isSystem: {
        type: Boolean,
        default: false
    }
}, { timestamps: true });

// Auto-expire messages older than 24 hours
ChatMessageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 });

module.exports = mongoose.model('ChatMessage', ChatMessageSchema);
