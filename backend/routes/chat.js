const express = require('express');
const router = express.Router();
const ChatMessage = require('../models/ChatMessage');

// Get recent messages
router.get('/recent', async (req, res) => {
    try {
        const messages = await ChatMessage.find()
            .sort({ createdAt: -1 })
            .limit(50)
            .lean();
        res.json(messages.reverse());
    } catch (err) {
        res.status(500).json({ error: 'Failed to load messages.' });
    }
});

module.exports = router;
