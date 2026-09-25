const User = require('../models/User');

/**
 * Simple admin auth middleware.
 * In production, replace with proper JWT/session tokens.
 * For now, checks for an X-Admin-Token header matching ADMIN_TOKEN env var.
 */
module.exports = async function adminAuth(req, res, next) {
    try {
        const token = req.headers['x-admin-token'];
        const adminToken = process.env.ADMIN_TOKEN;

        if (!adminToken) {
            return res.status(500).json({ error: 'Admin access not configured.' });
        }

        if (!token || token !== adminToken) {
            return res.status(403).json({ error: 'Unauthorized admin access.' });
        }

        next();
    } catch (err) {
        res.status(500).json({ error: 'Auth check failed.' });
    }
};
