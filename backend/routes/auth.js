const express = require('express');
const router = express.Router();
const User = require('../models/User');

// Endpoint for User Registration
router.post('/signup', async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: "Username and password are required." });
        }

        const userExists = await User.findOne({ username });
        if (userExists) {
            return res.status(400).json({ error: "Username already taken." });
        }

        const user = new User({ username, password });
        await user.save();

        res.status(201).json({ message: "Registration successful!" });
    } catch (err) {
        res.status(500).json({ error: "Server registration error." });
    }
});

// Endpoint for User Login
router.post('/signin', async (req, res) => {
    try {
        const { username, password } = req.body;

        const user = await User.findOne({ username });
        if (!user || user.password !== password) {
            // Note: plain text passwords for simple school project showcase only
            return res.status(401).json({ error: "Invalid username or password." });
        }

        res.status(200).json({
            message: "Authentication authorized",
            userId: user._id,
            username: user.username,
            balance: user.balance,
            token: `betnova-token-mock-${user._id}`
        });
    } catch (err) {
        res.status(500).json({ error: "Server login error." });
    }
});

// Get fresh user snapshot (used to re-sync balance after reconnect)
router.get('/me/:userId', async (req, res) => {
    try {
        const user = await User.findById(req.params.userId);
        if (!user) return res.status(404).json({ error: "User not found." });
        res.json({
            userId: user._id,
            username: user.username,
            balance: user.balance
        });
    } catch (err) {
        res.status(500).json({ error: "Server lookup error." });
    }
});

module.exports = router;
