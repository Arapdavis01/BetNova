const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const User = require('../models/User');
const Referral = require('../models/Referral');
const Bonus = require('../models/Bonus');
const AuditLog = require('../models/AuditLog');

// ============================================
// HELPERS
// ============================================

function generateReferralCode(username) {
    const base = username.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 6);
    const suffix = crypto.randomBytes(2).toString('hex').toUpperCase();
    return `${base}${suffix}`;
}

const SIGNUP_BONUS = 50;
const SIGNUP_BONUS_WAGERING = 3;   // must wager 3× before withdrawal
const REFERRER_BONUS = 100;
const REFERRER_BONUS_WAGERING = 3;

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
        const { username, password, referralCode } = req.body;

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

        const uname = username.toLowerCase();

        // ---------- Duplicate check ----------
        const userExists = await User.findOne({ username: uname });
        if (userExists) {
            return res.status(400).json({ error: "Username already taken." });
        }

        // ---------- Resolve referrer (if code supplied) ----------
        let referrer = null;
        if (referralCode && typeof referralCode === 'string') {
            referrer = await User.findOne({ referralCode: referralCode.toUpperCase().trim() });
            // Silently ignore invalid codes — don't fail signup
        }

        // ---------- Hash password ----------
        const hashedPassword = await bcrypt.hash(password, 10);

        // ---------- Generate unique referral code for new user ----------
        let newCode;
        let codeExists = true;
        let attempts = 0;
        while (codeExists && attempts < 5) {
            newCode = generateReferralCode(uname);
            codeExists = await User.findOne({ referralCode: newCode });
            attempts++;
        }

        // ---------- Create user ----------
        const user = new User({
            username: uname,
            password: hashedPassword,
            balance: 0.00,
            bonusBalance: 0,
            bonusWageringRequired: 0,
            bonusWagered: 0,
            role: 'user',
            referralCode: newCode,
            referredBy: referrer ? referrer._id : null,
            limits: {
                dailyDepositLimit: null,
                dailyWagerLimit: null,
                sessionTimeLimit: null
            },
            selfExcluded: false,
            kycLevel: 0
        });
        await user.save();

        // ---------- Referral bonus for referee (signup bonus) ----------
        if (referrer) {
            try {
                // Give KES 50 bonus to new user
                user.addBonus(SIGNUP_BONUS, SIGNUP_BONUS_WAGERING);
                await user.save();

                // Create Bonus record for audit
                await Bonus.create({
                    userId: user._id,
                    username: user.username,
                    type: 'referral',
                    amount: SIGNUP_BONUS,
                    wageringRequired: SIGNUP_BONUS * SIGNUP_BONUS_WAGERING,
                    reference: `SIGNUP-${referrer.referralCode}`
                });

                // Create Referral record (unclaimed until first deposit)
                await Referral.create({
                    referrerId: referrer._id,
                    referrerUsername: referrer.username,
                    refereeId: user._id,
                    refereeUsername: user.username,
                    claimed: false,
                    refereeBonus: SIGNUP_BONUS
                });

                // Audit log
                await AuditLog.create({
                    action: 'REFERRAL_APPLIED',
                    userId: user._id,
                    username: user.username,
                    metadata: {
                        referrerId: referrer._id,
                        referrerUsername: referrer.username,
                        referralCode: referrer.referralCode,
                        signupBonus: SIGNUP_BONUS
                    }
                });
            } catch (referralErr) {
                console.error('Referral setup error:', referralErr.message);
                // Don't fail signup — just skip the bonus
            }
        }

        // ---------- Audit log ----------
        try {
            await AuditLog.create({
                action: 'USER_SIGNUP',
                userId: user._id,
                username: user.username,
                metadata: {
                    ip: req.ip || req.headers['x-forwarded-for'] || 'unknown',
                    referred: !!referrer
                }
            });
        } catch (_) {}

        res.status(201).json({
            message: "Registration successful!",
            userId: user._id,
            username: user.username,
            referralCode: user.referralCode,
            signupBonus: referrer ? SIGNUP_BONUS : 0
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

        // ---------- Password verification ----------
        const passwordMatch = await bcrypt.compare(password, user.password);
        if (!passwordMatch) {
            return res.status(401).json({ error: "Invalid username or password." });
        }

        // ---------- Auto-lift expired self-exclusion ----------
        if (user.selfExcluded && user.selfExcludedUntil && user.selfExcludedUntil <= new Date()) {
            user.selfExcluded = false;
            user.selfExcludedUntil = null;
        }

        // ---------- Ensure referral code exists ----------
        if (!user.referralCode) {
            let code;
            let exists = true;
            let attempts = 0;
            while (exists && attempts < 5) {
                code = generateReferralCode(user.username);
                exists = await User.findOne({ referralCode: code });
                attempts++;
            }
            user.referralCode = code;
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
            bonusBalance: user.bonusBalance,
            bonusWageringRequired: user.bonusWageringRequired,
            bonusWagered: user.bonusWagered,
            email: user.email,
            emailVerified: user.emailVerified,
            phone: user.phone,
            phoneVerified: user.phoneVerified,
            kycLevel: user.kycLevel,
            role: user.role,
            status: user.status,
            selfExcluded: user.selfExcluded,
            selfExcludedUntil: user.selfExcludedUntil,
            limits: user.limits,
            referralCode: user.referralCode,
            referralEarnings: user.referralEarnings,
            referralCount: user.referralCount,
            dailyStreak: user.dailyStreak,
            lastDailyClaim: user.lastDailyClaim,
            totalDeposited: user.totalDeposited,
            totalWithdrawn: user.totalWithdrawn,
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
            bonusBalance: user.bonusBalance,
            bonusWageringRequired: user.bonusWageringRequired,
            bonusWagered: user.bonusWagered,
            email: user.email,
            emailVerified: user.emailVerified,
            phone: user.phone,
            phoneVerified: user.phoneVerified,
            kycLevel: user.kycLevel,
            role: user.role,
            status: user.status,
            selfExcluded: user.selfExcluded,
            selfExcludedUntil: user.selfExcludedUntil,
            limits: user.limits,
            referralCode: user.referralCode,
            referralEarnings: user.referralEarnings,
            referralCount: user.referralCount,
            dailyStreak: user.dailyStreak,
            lastDailyClaim: user.lastDailyClaim,
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
// REFERRAL LEADERBOARD
// ============================================
router.get('/referral/leaderboard', async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 20, 100);

        const leaders = await User.find({ referralCount: { $gt: 0 } })
            .select('username referralCount referralEarnings')
            .sort({ referralEarnings: -1 })
            .limit(limit)
            .lean();

        res.json({
            leaders: leaders.map((u, i) => ({
                rank: i + 1,
                username: u.username,
                referralCount: u.referralCount || 0,
                referralEarnings: u.referralEarnings || 0
            }))
        });
    } catch (err) {
        console.error('Referral leaderboard error:', err);
        res.status(500).json({ error: 'Failed to load leaderboard.' });
    }
});

// ============================================
// LOGOUT
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
