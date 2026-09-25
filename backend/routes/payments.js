const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Referral = require('../models/Referral');
const Bonus = require('../models/Bonus');
const AuditLog = require('../models/AuditLog');
const payhero = require('../services/payhero');

// ============================================
// CONSTANTS
// ============================================
const MIN_DEPOSIT = 10;
const MAX_DEPOSIT = 150000;
const MIN_WITHDRAWAL = 50;
const MAX_WITHDRAWAL = 250000;

// Referral payout — referrer gets this when their referee makes first deposit
const REFERRER_BONUS = 100;
const REFERRER_BONUS_WAGERING = 3;

// ============================================
// PHONE NORMALIZER
// ============================================
function normalizePhone(phoneNumber) {
    let phone = String(phoneNumber).replace(/\s/g, '').replace(/^\+/, '');
    if (phone.startsWith('0')) phone = '254' + phone.slice(1);
    if (!phone.startsWith('254')) phone = '254' + phone;
    return phone;
}

// ============================================
// INITIATE DEPOSIT (STK Push)
// ============================================
router.post('/deposit', async (req, res) => {
    try {
        const { userId, amount, phoneNumber } = req.body;

        // ---------- Validation ----------
        if (!userId || !amount || !phoneNumber) {
            return res.status(400).json({ error: 'userId, amount, and phoneNumber are required.' });
        }

        const amt = parseFloat(amount);
        if (!amt || amt < MIN_DEPOSIT) {
            return res.status(400).json({ error: `Minimum deposit is KES ${MIN_DEPOSIT}.` });
        }
        if (amt > MAX_DEPOSIT) {
            return res.status(400).json({ error: `Maximum deposit is KES ${MAX_DEPOSIT}.` });
        }

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: 'User not found.' });

        // ---------- Account status ----------
        if (user.status && user.status !== 'active') {
            return res.status(403).json({ error: 'Your account is not active.' });
        }

        // ---------- Daily deposit limit check ----------
        if (user.limits && user.limits.dailyDepositLimit) {
            const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
            const todayDeposits = await Transaction.aggregate([
                {
                    $match: {
                        userId: user._id,
                        type: 'DEPOSIT',
                        status: 'SUCCESS',
                        createdAt: { $gte: dayAgo }
                    }
                },
                { $group: { _id: null, total: { $sum: '$amount' } } }
            ]);
            const deposited = todayDeposits[0]?.total || 0;
            if (deposited + amt > user.limits.dailyDepositLimit) {
                return res.status(400).json({
                    error: `Daily deposit limit of KES ${user.limits.dailyDepositLimit} would be exceeded. Already deposited KES ${deposited.toFixed(2)} today.`
                });
            }
        }

        // ---------- Normalize phone ----------
        const phone = normalizePhone(phoneNumber);

        // ---------- Create pending transaction ----------
        const reference = `DEP-${userId}-${Date.now()}`;
        const transaction = new Transaction({
            userId,
            type: 'DEPOSIT',
            amount: amt,
            phoneNumber: phone,
            reference,
            status: 'PENDING'
        });
        await transaction.save();

        // ---------- Call PayHero STK Push ----------
        const result = await payhero.initiateSTKPush(phone, amt, reference);

        // Save PayHero reference if available
        if (result.response && result.response.Transaction_Reference) {
            transaction.payheroReference = result.response.Transaction_Reference;
            await transaction.save();
        }

        // ---------- Audit log ----------
        try {
            await AuditLog.create({
                action: 'DEPOSIT_INITIATED',
                userId: user._id,
                username: user.username,
                metadata: { amount: amt, phone, reference }
            });
        } catch (_) {}

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

// ============================================
// INITIATE WITHDRAWAL (B2C)
// ============================================
router.post('/withdraw', async (req, res) => {
    try {
        const { userId, amount, phoneNumber } = req.body;

        // ---------- Validation ----------
        if (!userId || !amount || !phoneNumber) {
            return res.status(400).json({ error: 'userId, amount, and phoneNumber are required.' });
        }

        const amt = parseFloat(amount);
        if (!amt || amt < MIN_WITHDRAWAL) {
            return res.status(400).json({ error: `Minimum withdrawal is KES ${MIN_WITHDRAWAL}.` });
        }
        if (amt > MAX_WITHDRAWAL) {
            return res.status(400).json({ error: `Maximum withdrawal is KES ${MAX_WITHDRAWAL}.` });
        }

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ error: 'User not found.' });

        // ---------- Account status ----------
        if (user.status && user.status !== 'active') {
            return res.status(403).json({ error: 'Your account is not active.' });
        }

        // ---------- KYC requirement ----------
        if (!user.emailVerified) {
            return res.status(403).json({
                error: 'Please verify your email before withdrawing.',
                code: 'KYC_REQUIRED'
            });
        }

        // ---------- Balance check ----------
        if (user.balance < amt) {
            return res.status(400).json({
                error: `Insufficient balance. Available: KES ${user.balance.toFixed(2)}`
            });
        }

        // ---------- Bonus wagering check ----------
        if (user.bonusWageringRequired > 0) {
            return res.status(403).json({
                error: `Complete your bonus wagering first. Remaining: KES ${user.bonusWageringRequired.toFixed(2)}`,
                code: 'WAGERING_REQUIRED'
            });
        }

        // ---------- Normalize phone ----------
        const phone = normalizePhone(phoneNumber);

        // ---------- Deduct balance immediately ----------
        // (Refunded by callback handler if the withdrawal fails)
        user.balance = parseFloat((user.balance - amt).toFixed(2));
        user.totalWithdrawn = parseFloat(((user.totalWithdrawn || 0) + amt).toFixed(2));
        await user.save();

        // ---------- Create pending transaction ----------
        const reference = `WDR-${userId}-${Date.now()}`;
        const transaction = new Transaction({
            userId,
            type: 'WITHDRAWAL',
            amount: amt,
            phoneNumber: phone,
            reference,
            status: 'PENDING'
        });
        await transaction.save();

        // ---------- Call PayHero B2C ----------
        const result = await payhero.initiateWithdrawal(phone, amt, reference);

        if (result.response && result.response.Transaction_Reference) {
            transaction.payheroReference = result.response.Transaction_Reference;
            await transaction.save();
        }

        // ---------- Audit log ----------
        try {
            await AuditLog.create({
                action: 'WITHDRAWAL_INITIATED',
                userId: user._id,
                username: user.username,
                metadata: { amount: amt, phone, reference, newBalance: user.balance }
            });
        } catch (_) {}

        res.json({
            message: 'Withdrawal initiated. Funds will arrive shortly.',
            newBalance: user.balance,
            reference
        });
    } catch (err) {
        console.error('Withdraw error:', err.response?.data || err.message);

        // Try to refund if we already deducted
        try {
            const { userId, amount } = req.body;
            const user = await User.findById(userId);
            if (user && amount) {
                user.balance = parseFloat((user.balance + parseFloat(amount)).toFixed(2));
                user.totalWithdrawn = parseFloat(Math.max(0, (user.totalWithdrawn || 0) - parseFloat(amount)).toFixed(2));
                await user.save();
                console.log(`Refunded withdrawal failure for user ${user.username}`);
            }
        } catch (refundErr) {
            console.error('Refund error:', refundErr.message);
        }

        res.status(500).json({
            error: 'Failed to initiate withdrawal.',
            detail: err.response?.data || err.message
        });
    }
});

// ============================================
// PAYHERO WEBHOOK CALLBACK
// ============================================
router.post('/callback', async (req, res) => {
    try {
        console.log('PayHero callback received:', JSON.stringify(req.body, null, 2));

        const payload = req.body.response || req.body;

        const transactionType = payload.Transaction_Type;
        const mpesaRef = payload.MPESA_Reference;
        const amount = parseFloat(payload.Amount || 0);
        const userReference = payload.User_Reference;
        const payheroRef = payload.Transaction_Reference;

        // ============================================
        // DEPOSIT (C2B)
        // ============================================
        if (transactionType === 'C2B') {
            const transaction = await Transaction.findOne({ reference: userReference });

            if (!transaction) {
                console.warn('No matching transaction for deposit reference:', userReference);
                return res.json({ status: true });
            }

            // ---------- Duplicate callback protection ----------
            if (transaction.status === 'SUCCESS') {
                console.log('Deposit already processed:', userReference);
                return res.json({ status: true });
            }

            transaction.status = 'SUCCESS';
            transaction.mpesaReceipt = mpesaRef;
            await transaction.save();

            // ---------- Credit user balance ----------
            const user = await User.findById(transaction.userId);
            if (user) {
                // Credit to MAIN balance
                user.balance = parseFloat((user.balance + amount).toFixed(2));

                // Track total deposited
                const wasFirstDeposit = (user.totalDeposited || 0) === 0;
                user.totalDeposited = parseFloat(((user.totalDeposited || 0) + amount).toFixed(2));

                await user.save();

                console.log(`Deposit credited: user=${user.username}, amount=${amount}, newBalance=${user.balance}`);

                // ============================================
                // REFERRAL PAYOUT (only on first deposit)
                // ============================================
                if (wasFirstDeposit && user.referredBy) {
                    try {
                        const referrer = await User.findById(user.referredBy);

                        if (referrer) {
                            // Give referrer the bonus
                            referrer.addBonus(REFERRER_BONUS, REFERRER_BONUS_WAGERING);
                            referrer.referralEarnings = parseFloat(
                                ((referrer.referralEarnings || 0) + REFERRER_BONUS).toFixed(2)
                            );
                            referrer.referralCount = (referrer.referralCount || 0) + 1;
                            await referrer.save();

                            // Create Bonus record
                            await Bonus.create({
                                userId: referrer._id,
                                username: referrer.username,
                                type: 'referral',
                                amount: REFERRER_BONUS,
                                wageringRequired: REFERRER_BONUS * REFERRER_BONUS_WAGERING,
                                reference: `REF-${user.username}`
                            });

                            // Mark referral as claimed
                            await Referral.updateOne(
                                { refereeId: user._id, claimed: false },
                                {
                                    $set: {
                                        claimed: true,
                                        referrerBonus: REFERRER_BONUS,
                                        firstDepositAmount: amount,
                                        firstDepositAt: new Date()
                                    }
                                }
                            );

                            // Audit log
                            await AuditLog.create({
                                action: 'REFERRAL_BONUS_PAID',
                                userId: referrer._id,
                                username: referrer.username,
                                metadata: {
                                    refereeId: user._id,
                                    refereeUsername: user.username,
                                    bonus: REFERRER_BONUS
                                }
                            });

                            console.log(`Referral bonus paid: ${referrer.username} earned KES ${REFERRER_BONUS} from ${user.username}`);
                        }
                    } catch (referralErr) {
                        console.error('Referral payout error:', referralErr.message);
                        // Don't fail the deposit — referrer payout can be retried manually
                    }
                }

                // ============================================
                // AUDIT LOG
                // ============================================
                try {
                    await AuditLog.create({
                        action: 'DEPOSIT_SUCCESS',
                        userId: user._id,
                        username: user.username,
                        metadata: {
                            amount,
                            mpesaReceipt: mpesaRef,
                            reference: userReference,
                            newBalance: user.balance
                        }
                    });
                } catch (_) {}
            }
        }

        // ============================================
        // WITHDRAWAL (B2C)
        // ============================================
        else if (transactionType === 'B2C') {
            const transaction = await Transaction.findOne({ payheroReference: payheroRef });

            if (!transaction) {
                console.warn('No matching transaction for withdrawal ref:', payheroRef);
                return res.json({ status: true });
            }

            // ---------- Duplicate callback protection ----------
            if (transaction.status !== 'PENDING') {
                console.log('Withdrawal already processed:', payheroRef);
                return res.json({ status: true });
            }

            // Check if success or failure
            const isSuccess = payload.Status === 'Success' || payload.Status === 'SUCCESS' ||
                             (payload.ResultCode === 0 || payload.ResultCode === '0');

            if (isSuccess) {
                transaction.status = 'SUCCESS';
                transaction.mpesaReceipt = mpesaRef;
                await transaction.save();

                try {
                    await AuditLog.create({
                        action: 'WITHDRAWAL_SUCCESS',
                        userId: transaction.userId,
                        metadata: {
                            amount: transaction.amount,
                            mpesaReceipt: mpesaRef,
                            reference: transaction.reference
                        }
                    });
                } catch (_) {}

                console.log(`Withdrawal completed: ref=${payheroRef}, receipt=${mpesaRef}`);
            } else {
                // Withdrawal failed — refund the user
                transaction.status = 'FAILED';
                transaction.failureReason = payload.Status || payload.Message || 'Unknown failure';
                await transaction.save();

                const user = await User.findById(transaction.userId);
                if (user) {
                    user.balance = parseFloat((user.balance + transaction.amount).toFixed(2));
                    user.totalWithdrawn = parseFloat(
                        Math.max(0, (user.totalWithdrawn || 0) - transaction.amount).toFixed(2)
                    );
                    await user.save();

                    try {
                        await AuditLog.create({
                            action: 'WITHDRAWAL_FAILED',
                            userId: user._id,
                            username: user.username,
                            metadata: {
                                amount: transaction.amount,
                                reason: transaction.failureReason,
                                refunded: true
                            }
                        });
                    } catch (_) {}

                    console.log(`Withdrawal failed, refunded ${transaction.amount} to ${user.username}`);
                }
            }
        }

        res.json({ status: true });
    } catch (err) {
        console.error('Callback processing error:', err.message);
        res.json({ status: true }); // Always 200 to prevent retries
    }
});

// ============================================
// CHECK TRANSACTION STATUS
// ============================================
router.get('/status/:reference', async (req, res) => {
    try {
        const result = await payhero.checkTransactionStatus(req.params.reference);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
