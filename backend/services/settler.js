const axios = require('axios');
const Match = require('../models/Match');
const SportsBet = require('../models/SportsBet');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');

const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';
const API_KEY = () => process.env.ODDS_API_KEY;

/**
 * Fetch scores for a sport and update local matches.
 * Uses The Odds API's /scores endpoint (returns recent results).
 */
async function fetchScoresForSport(sportKey, daysFrom = 3) {
    if (!API_KEY()) return [];
    try {
        const res = await axios.get(`${ODDS_API_BASE}/sports/${sportKey}/scores`, {
            params: { apiKey: API_KEY(), daysFrom }
        });
        return res.data;
    } catch (err) {
        if (err.response?.status === 422) return [];
        console.error(`[Settler] Score fetch error for ${sportKey}:`, err.message);
        return [];
    }
}

/**
 * Update match statuses and winners from provider scores.
 */
async function updateMatchScores() {
    // Group sports we have matches for
    const sportKeys = await Match.distinct('sportKey', { isActive: true, status: { $in: ['live', 'upcoming'] } });

    for (const sportKey of sportKeys) {
        const scores = await fetchScoresForSport(sportKey, 3);
        for (const s of scores) {
            if (!s.completed || !s.scores) continue;

            const home = s.scores.find(x => x.name === s.home_team);
            const away = s.scores.find(x => x.name === s.away_team);
            if (!home || !away) continue;

            const homeScore = parseInt(home.score);
            const awayScore = parseInt(away.score);
            let winner = 'draw';
            if (homeScore > awayScore) winner = 'home';
            else if (awayScore > homeScore) winner = 'away';

            await Match.updateOne(
                { externalId: s.id },
                {
                    $set: {
                        status: 'finished',
                        scores: { home: homeScore, away: awayScore },
                        winner,
                        isActive: false
                    }
                }
            );
        }
        // Small delay to avoid rate limits
        await new Promise(r => setTimeout(r, 300));
    }
}

/**
 * Settle all pending sports bets whose matches have finished.
 */
async function settleBets() {
    const pendingBets = await SportsBet.find({ status: 'pending' }).limit(500);

    let settled = 0;
    for (const bet of pendingBets) {
        for (const sel of bet.selections) {
            if (sel.result !== 'pending') continue;

            const match = await Match.findOne({ externalId: sel.matchExternalId });
            if (!match) continue;
            if (match.status !== 'finished' && match.status !== 'cancelled') continue;

            const winner = match.status === 'cancelled' ? 'void' : match.winner;
            const changed = bet.settleSelection(sel.matchExternalId, winner);

            // If a void selection, refund pro-rata by adjusting potentialPayout
            if (changed && winner === 'void') {
                bet.potentialPayout = parseFloat(
                    (bet.potentialPayout / (bet.totalOdds / sel.odds)).toFixed(2)
                );
            }
        }

        if (bet.isModified()) {
            await bet.save();
            settled++;

            // If bet won, credit the user
            if (bet.status === 'won' && bet.actualPayout > 0) {
                const user = await User.findById(bet.userId);
                if (user) {
                    user.balance = parseFloat((user.balance + bet.actualPayout).toFixed(2));
                    await user.save();
                    // Note: user's socket will get balance on next refresh; can emit if we had io
                }
                try {
                    await AuditLog.create({
                        action: 'SPORTSBET_WON',
                        userId: bet.userId,
                        username: bet.username,
                        metadata: { betId: bet._id, payout: bet.actualPayout, totalOdds: bet.totalOdds }
                    });
                } catch (_) {}
            } else if (bet.status === 'lost') {
                try {
                    await AuditLog.create({
                        action: 'SPORTSBET_LOST',
                        userId: bet.userId,
                        username: bet.username,
                        metadata: { betId: bet._id, stake: bet.stake }
                    });
                } catch (_) {}
            }
        }
    }

    if (settled > 0) console.log(`[Settler] Settled ${settled} sports bets`);
    return { settled };
}

/**
 * Full cycle: update scores → settle bets.
 * Run every 5 minutes.
 */
async function runSettlementCycle() {
    try {
        await updateMatchScores();
        await settleBets();
    } catch (err) {
        console.error('[Settler] Cycle error:', err.message);
    }
}

module.exports = { runSettlementCycle, updateMatchScores, settleBets };
