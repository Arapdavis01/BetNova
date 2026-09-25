const express = require('express');
const router = express.Router();
const SupportTicket = require('../models/SupportTicket');
const adminAuth = require('../middleware/adminAuth');

// User creates a ticket
router.post('/', async (req, res) => {
    try {
        const { userId, username, category, subject, message } = req.body;
        if (!userId || !category || !subject || !message) {
            return res.status(400).json({ error: 'Missing required fields.' });
        }

        const ticket = await SupportTicket.create({
            userId, username, category, subject, message
        });

        res.status(201).json({ message: 'Ticket submitted.', ticketId: ticket._id });
    } catch (err) {
        console.error('Create ticket error:', err);
        res.status(500).json({ error: 'Failed to create ticket.' });
    }
});

// User views their tickets
router.get('/user/:userId', async (req, res) => {
    try {
        const tickets = await SupportTicket.find({ userId: req.params.userId })
            .sort({ createdAt: -1 })
            .lean();
        res.json(tickets);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load tickets.' });
    }
});

// Admin: list all tickets
router.get('/admin/all', adminAuth, async (req, res) => {
    try {
        const status = req.query.status || 'open';
        const tickets = await SupportTicket.find({ status })
            .sort({ createdAt: -1 })
            .limit(100)
            .lean();
        res.json(tickets);
    } catch (err) {
        res.status(500).json({ error: 'Failed to load tickets.' });
    }
});

// Admin: respond to ticket
router.post('/admin/respond/:ticketId', adminAuth, async (req, res) => {
    try {
        const { response, status } = req.body;
        const ticket = await SupportTicket.findById(req.params.ticketId);
        if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });

        ticket.adminResponse = response || ticket.adminResponse;
        ticket.status = status || 'resolved';
        await ticket.save();

        res.json({ message: 'Response saved.', ticket });
    } catch (err) {
        res.status(500).json({ error: 'Failed to respond.' });
    }
});

module.exports = router;
