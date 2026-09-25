const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const payhero = require('../services/payhero');

// ---------- Initiate Deposit (STK Push) ----------
router.post('/deposit', async (req, res) => {
    try {
        const { userId, amount, phoneNumber } = req.body;

        if (!userId || !amount || !phoneNumber) {
            return res.status(400).json({ error: 'userId, amount, and phoneNumber are required.' });
        }
        if (amount < 10 || amount > 150000) {
            return res.status(400).json({ error: 'Amount must be between KES 10 and KES 150,000.' });
        }

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: 'User not found.' });

        // Normalize phone: 0712... → 254712...
        let phone = phoneNumber.replace(/\s/g, '').replace(/^\+/, '');
        if (phone.startsWith('0')) phone = '254' + phone.slice(1);
        if (!phone.startsWith('254')) phone = '254' + phone;

        const reference = `DEP-${userId}-${Date.now()}`;

        // Create pending transaction first
        const transaction = new Transaction({
            userId,
            type: 'DEPOSIT',
            amount,
            phoneNumber: phone,
            reference,
            status: 'PENDING'
        });
        await transaction.save();

        // Call PayHero
        const result = await payhero.initiateSTKPush(phone, amount, reference);

        // PayHero returns Status, Message, and possibly Transaction_Reference
        if (result.response && result.response.Transaction_Reference) {
            transaction.payheroReference = result.response.Transaction_Reference;
            await transaction.save();
        }

        res.json({
            message: 'STK Push initiated. Enter your M-Pesa PIN to complete.',
            reference,
            payheroResponse: result
        });
    } catch (err) {
        console.error('Deposit error:', err.response?.data || err.message);
        res.status(500).json({
            error: 'Failed to initiate deposit.',
            detail: err.response?.data || err.message
        });
    }
});

// ---------- Initiate Withdrawal (B2C) ----------
router.post('/withdraw', async (req, res) => {
    try {
        const { userId, amount, phoneNumber } = req.body;

        if (!userId || !amount || !phoneNumber) {
            return res.status(400).json({ error: 'userId, amount, and phoneNumber are required.' });
        }
        if (amount < 50) {
            return res.status(400).json({ error: 'Minimum withdrawal is KES 50.' });
        }

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: 'User not found.' });
        if (user.balance < amount) {
            return res.status(400).json({ error: 'Insufficient balance.' });
        }

        let phone = phoneNumber.replace(/\s/g, '').replace(/^\+/, '');
        if (phone.startsWith('0')) phone = '254' + phone.slice(1);
        if (!phone.startsWith('254')) phone = '254' + phone;

        const reference = `WDR-${userId}-${Date.now()}`;

        // Deduct balance immediately (reverses on failure via callback)
        user.balance = parseFloat((user.balance - amount).toFixed(2));
        await user.save();

        const transaction = new Transaction({
            userId,
            type: 'WITHDRAWAL',
            amount,
            phoneNumber: phone,
            reference,
            status: 'PENDING'
        });
        await transaction.save();

        const result = await payhero.initiateWithdrawal(phone, amount, reference);

        if (result.response && result.response.Transaction_Reference) {
            transaction.payheroReference = result.response.Transaction_Reference;
            await transaction.save();
        }

        res.json({
            message: 'Withdrawal initiated. Funds will arrive shortly.',
            newBalance: user.balance,
            reference
        });
    } catch (err) {
        console.error('Withdraw error:', err.response?.data || err.message);
        res.status(500).json({
            error: 'Failed to initiate withdrawal.',
            detail: err.response?.data || err.message
        });
    }
});

// ---------- PayHero Webhook Callback ----------
router.post('/callback', async (req, res) => {
    try {
        console.log('PayHero callback received:', JSON.stringify(req.body, null, 2));

        const payload = req.body.response || req.body;

        // Determine if this is a C2B (deposit) or B2C (withdrawal) callback
        const transactionType = payload.Transaction_Type;
        const mpesaRef = payload.MPESA_Reference;
        const amount = payload.Amount;
        const userReference = payload.User_Reference;

        if (transactionType === 'C2B') {
            // Deposit successful — find by user_reference (our internal reference)
            const transaction = await Transaction.findOne({ reference: userReference });
            if (!transaction) {
                console.warn('No matching transaction for deposit reference:', userReference);
                return res.json({ status: true });
            }

            transaction.status = 'SUCCESS';
            transaction.mpesaReceipt = mpesaRef;
            await transaction.save();

            // Credit user balance
            const user = await User.findById(transaction.userId);
            if (user) {
                user.balance = parseFloat((user.balance + amount).toFixed(2));
                await user.save();
                console.log(`Deposit credited: user=${user.username}, amount=${amount}, newBalance=${user.balance}`);
            }
        } else if (transactionType === 'B2C') {
            // Withdrawal callback — find by Transaction_Reference
            const payheroRef = payload.Transaction_Reference;
            const transaction = await Transaction.findOne({ payheroReference: payheroRef });
            if (transaction) {
                transaction.status = 'SUCCESS';
                transaction.mpesaReceipt = mpesaRef;
                await transaction.save();
                console.log(`Withdrawal completed: ref=${payheroRef}, receipt=${mpesaRef}`);
            }
        }

        res.json({ status: true });
    } catch (err) {
        console.error('Callback processing error:', err.message);
        res.json({ status: true }); // Always return 200 to prevent PayHero retries
    }
});

// ---------- Check Transaction Status ----------
router.get('/status/:reference', async (req, res) => {
    try {
        const result = await payhero.checkTransactionStatus(req.params.reference);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
