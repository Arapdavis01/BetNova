const express = require('express');
const router = express.Router();
const jackpot = require('../services/jackpot');
const promotions = require('../services/promotions');
const PromoRedemption = require('../models/PromoRedemption');

// ============================================
// GET /api/promotions/jackpots
// ============================================
router.get('/jackpots', async (req, res) => {
    try {
        const jackpots = await jackpot.getJackpots();
        res.json({ jackpots });
    } catch (err) {
        console.error('Jackpots error:', err);
        res.status(500).json({ error: 'Failed to load jackpots.' });
    }
});

// ============================================
// GET /api/promotions/jackpots/user/:userId
// ============================================
router.get('/jackpots/user/:userId', async (req, res) => {
    try {
        const entries = await jackpot.getUserEntries(req.params.userId);
        res.json({ entries });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load entries.' });
    }
});

// ============================================
// GET /api/promotions/active
// ============================================
router.get('/active', async (req, res) => {
    try {
        const promos = await promotions.listActivePromotions();
        res.json({ promotions: promos });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load promotions.' });
    }
});

// ============================================
// POST /api/promotions/validate
// Body: { code, userId }
// ============================================
router.post('/validate', async (req, res) => {
    try {
        const { code, userId } = req.body;
        if (!code || !userId) {
            return res.status(400).json({ error: 'code and userId are required.' });
        }

        const result = await promotions.validateCode(code, userId);
        res.json(result);
    } catch (err) {
        console.error('Validate error:', err);
        res.status(500).json({ error: 'Failed to validate code.' });
    }
});

// ============================================
// POST /api/promotions/redeem
// Body: { code, userId }
// ============================================
router.post('/redeem', async (req, res) => {
    try {
        const { code, userId } = req.body;
        if (!code || !userId) {
            return res.status(400).json({ error: 'code and userId are required.' });
        }

        const result = await promotions.redeemCode(code, userId);

        if (!result.valid) {
            return res.status(400).json({ error: result.error });
        }

        res.json({
            message: result.message,
            bonusAmount: result.bonusAmount,
            newBonusBalance: result.newBonusBalance
        });
    } catch (err) {
        console.error('Redeem error:', err);
        res.status(500).json({ error: 'Failed to redeem code.' });
    }
});

// ============================================
// GET /api/promotions/my-redemptions/:userId
// ============================================
router.get('/my-redemptions/:userId', async (req, res) => {
    try {
        const redemptions = await PromoRedemption.find({ userId: req.params.userId })
            .sort({ createdAt: -1 })
            .limit(50)
            .lean();

        res.json({ redemptions });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load redemptions.' });
    }
});

module.exports = router;
