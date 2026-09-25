const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');

// ============================================
// HEALTH CHECK
// ============================================
router.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================
// USER REGISTRATION
// ============================================
router.post('/signup', async (req, res) => {
    try {
        const { username, password } = req.body;

        // ---------- Validation ----------
        if (!username || !password) {
            return res.status(400).json({ error: "Username and password are required." });
        }
        if (username.length < 3 || username.length > 20) {
            return res.status(400).json({ error: "Username must be 3-20 characters." });
        }
        if (!/^[a-zA-Z0-9_]+$/.test(username)) {
            return res.status(400).json({ error: "Username can only contain letters, numbers, and underscores." });
        }
        if (password.length < 4) {
            return res.status(400).json({ error: "Password must be at least 4 characters." });
        }

        // ---------- Duplicate check ----------
        const userExists = await User.findOne({ username: username.toLowerCase() });
        if (userExists) {
            return res.status(400).json({ error: "Username already taken." });
        }

        // ---------- Hash password ----------
        const hashedPassword = await bcrypt.hash(password, 10);

        // ---------- Create user ----------
        const user = new User({
            username: username.toLowerCase(),
            password: hashedPassword,
            balance: 0.00,       // real-money platform — start at 0, deposits required
            role: 'user',
            limits: {
                dailyDepositLimit: null,
                dailyWagerLimit: null,
                sessionTimeLimit: null
            },
            selfExcluded: false
        });
        await user.save();

        // ---------- Audit log ----------
        try {
            await AuditLog.create({
                action: 'USER_SIGNUP',
                userId: user._id,
                username: user.username,
                metadata: { ip: req.ip || req.headers['x-forwarded-for'] || 'unknown' }
            });
        } catch (_) {}

        res.status(201).json({
            message: "Registration successful!",
            userId: user._id,
            username: user.username
        });
    } catch (err) {
        console.error('Signup error:', err);
        res.status(500).json({ error: "Server registration error." });
    }
});

// ============================================
// USER LOGIN
// ============================================
router.post('/signin', async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ error: "Username and password are required." });
        }

        const user = await User.findOne({ username: username.toLowerCase() });
        if (!user) {
            return res.status(401).json({ error: "Invalid username or password." });
        }

        // ---------- Password verification (bcrypt) ----------
        const passwordMatch = await bcrypt.compare(password, user.password);
        if (!passwordMatch) {
            return res.status(401).json({ error: "Invalid username or password." });
        }

        // ---------- Auto-lift expired self-exclusion ----------
        if (user.selfExcluded && user.selfExcludedUntil && user.selfExcludedUntil <= new Date()) {
            user.selfExcluded = false;
            user.selfExcludedUntil = null;
        }

        // ---------- Update last login ----------
        user.lastLoginAt = new Date();
        await user.save();

        // ---------- Audit log ----------
        try {
            await AuditLog.create({
                action: 'USER_SIGNIN',
                userId: user._id,
                username: user.username,
                metadata: { ip: req.ip || req.headers['x-forwarded-for'] || 'unknown' }
            });
        } catch (_) {}

        res.status(200).json({
            message: "Authentication authorized",
            userId: user._id,
            username: user.username,
            balance: user.balance,
            phone: user.phone,
            phoneVerified: user.phoneVerified,
            role: user.role,
            selfExcluded: user.selfExcluded,
            selfExcludedUntil: user.selfExcludedUntil,
            limits: user.limits,
            token: `betnova-token-mock-${user._id}`
        });
    } catch (err) {
        console.error('Signin error:', err);
        res.status(500).json({ error: "Server login error." });
    }
});

// ============================================
// GET FRESH USER SNAPSHOT
// ============================================
router.get('/me/:userId', async (req, res) => {
    try {
        const user = await User.findById(req.params.userId).select('-password');
        if (!user) return res.status(404).json({ error: "User not found." });

        // Auto-lift expired self-exclusion
        if (user.selfExcluded && user.selfExcludedUntil && user.selfExcludedUntil <= new Date()) {
            user.selfExcluded = false;
            user.selfExcludedUntil = null;
            await user.save();
        }

        res.json({
            userId: user._id,
            username: user.username,
            balance: user.balance,
            phone: user.phone,
            phoneVerified: user.phoneVerified,
            role: user.role,
            selfExcluded: user.selfExcluded,
            selfExcludedUntil: user.selfExcludedUntil,
            limits: user.limits,
            totalDeposited: user.totalDeposited,
            totalWithdrawn: user.totalWithdrawn,
            createdAt: user.createdAt
        });
    } catch (err) {
        console.error('Me error:', err);
        res.status(500).json({ error: "Server lookup error." });
    }
});

// ============================================
// LOGOUT (mock — for audit trail only)
// ============================================
router.post('/logout', async (req, res) => {
    try {
        const { userId } = req.body;
        if (userId) {
            const user = await User.findById(userId);
            if (user) {
                await AuditLog.create({
                    action: 'USER_LOGOUT',
                    userId: user._id,
                    username: user.username
                });
            }
        }
        res.json({ message: 'Logged out.' });
    } catch (err) {
        res.status(500).json({ error: 'Logout error.' });
    }
});

module.exports = router;
