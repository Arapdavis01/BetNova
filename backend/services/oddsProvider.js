const axios = require('axios');
const Sport = require('../models/Sport');
const Match = require('../models/Match');

const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';
const API_KEY = () => process.env.ODDS_API_KEY;

// ============================================
// Sports list
// ============================================
async function fetchSportsList() {
    if (!API_KEY()) throw new Error('ODDS_API_KEY not configured');
    const res = await axios.get(`${ODDS_API_BASE}/sports`, {
        params: { apiKey: API_KEY(), all: 'true' }
    });
    return res.data;
}

async function syncSports() {
    const sports = await fetchSportsList();
    let created = 0, updated = 0;

    for (const s of sports) {
        // Filter to in-season only (they set active: true)
        if (!s.active) continue;
        // Skip outrights and other non-match markets
        if (s.has_outrights) continue;

        const existing = await Sport.findOne({ key: s.key });
        if (existing) {
            existing.group = s.group;
            existing.title = s.title;
            existing.description = s.description || '';
            existing.active = true;
            existing.hasOutrights = s.has_outrights || false;
            await existing.save();
            updated++;
        } else {
            await Sport.create({
                key: s.key,
                group: s.group,
                title: s.title,
                description: s.description || '',
                hasOutrights: s.has_outrights || false
            });
            created++;
        }
    }
    console.log(`[OddsProvider] Sports synced: ${created} new, ${updated} updated`);
    return { created, updated };
}

// ============================================
// Matches for a sport
// ============================================
async function fetchMatchesForSport(sportKey, regions = 'eu', markets = 'h2h') {
    if (!API_KEY()) throw new Error('ODDS_API_KEY not configured');
    const res = await axios.get(`${ODDS_API_BASE}/sports/${sportKey}/odds`, {
        params: {
            apiKey: API_KEY(),
            regions,
            markets,
            oddsFormat: 'decimal',
            dateFormat: 'iso'
        }
    });
    return res.data;
}

/**
 * Extract 1X2 (or h2h) odds from the first bookmaker
 * Prefers the closest-to-market bookmaker.
 */
function extractOdds(event) {
    if (!event.bookmakers || event.bookmakers.length === 0) return null;

    // Prefer well-known bookmakers, fall back to first
    const preferred = ['betfair', 'pinnacle', 'bet365', 'williamhill', 'unibet'];
    let bk = event.bookmakers.find(b => preferred.includes(b.key)) || event.bookmakers[0];
    if (!bk) return null;

    const h2h = bk.markets?.find(m => m.key === 'h2h');
    if (!h2h) return null;

    const outcomes = h2h.outcomes || [];
    const home = outcomes.find(o => o.name === event.home_team);
    const away = outcomes.find(o => o.name === event.away_team);
    const draw = outcomes.find(o => o.name === 'Draw');

    return {
        home: home ? parseFloat(home.price) : null,
        draw: draw ? parseFloat(draw.price) : null,
        away: away ? parseFloat(away.price) : null,
        bookmakerKey: bk.key,
        bookmakerTitle: bk.title,
        lastUpdate: new Date(h2h.last_update || bk.last_update || Date.now())
    };
}

// ============================================
// Sync matches for one sport into DB
// ============================================
async function syncMatchesForSport(sportKey, sportGroup, sportTitle) {
    let events;
    try {
        events = await fetchMatchesForSport(sportKey);
    } catch (err) {
        // 422 = sport not in season, just skip
        if (err.response?.status === 422) return { synced: 0 };
        console.error(`[OddsProvider] Fetch error for ${sportKey}:`, err.message);
        return { synced: 0 };
    }

    let synced = 0;
    for (const event of events) {
        const odds = extractOdds(event);
        if (!odds || (!odds.home && !odds.away)) continue;

        const update = {
            sportKey,
            sportTitle: sportTitle || event.sport_title,
            sportGroup,
            homeTeam: event.home_team,
            awayTeam: event.away_team,
            commenceTime: new Date(event.commence_time),
            odds: { home: odds.home, draw: odds.draw, away: odds.away },
            bookmakerKey: odds.bookmakerKey,
            bookmakerTitle: odds.bookmakerTitle,
            lastUpdate: odds.lastUpdate,
            isActive: true
        };

        try {
            await Match.findOneAndUpdate(
                { externalId: event.id },
                { $set: update, $setOnInsert: { status: 'upcoming' } },
                { upsert: true, new: true }
            );
            synced++;
        } catch (err) {
            if (err.code !== 11000) console.error('Match upsert error:', err.message);
        }
    }

    console.log(`[OddsProvider] ${sportKey}: ${synced} matches synced`);
    return { synced };
}

// ============================================
// Full refresh: sports list + top N sports' matches
// ============================================
async function fullRefresh() {
    await syncSports();

    // Sync matches for the most popular sports first
    const prioritySports = [
        { key: 'soccer_epl', group: 'Soccer', title: 'English Premier League' },
        { key: 'soccer_uefa_champs_league', group: 'Soccer', title: 'UEFA Champions League' },
        { key: 'soccer_spain_la_liga', group: 'Soccer', title: 'La Liga' },
        { key: 'soccer_italy_serie_a', group: 'Soccer', title: 'Serie A' },
        { key: 'soccer_germany_bundesliga', group: 'Soccer', title: 'Bundesliga' },
        { key: 'soccer_france_ligue_one', group: 'Soccer', title: 'Ligue 1' },
        { key: 'soccer_africa_cup_of_nations', group: 'Soccer', title: 'AFCON' },
        { key: 'basketball_nba', group: 'Basketball', title: 'NBA' },
        { key: 'tennis_atp_aus_open_singles', group: 'Tennis', title: 'ATP Australian Open' },
        { key: 'icehockey_nhl', group: 'Ice Hockey', title: 'NHL' }
    ];

    let totalSynced = 0;
    for (const s of prioritySports) {
        const result = await syncMatchesForSport(s.key, s.group, s.title);
        totalSynced += result.synced;
        // Space requests to avoid rate limits
        await new Promise(r => setTimeout(r, 300));
    }

    // Mark matches that have started as live, and old ones as inactive
    const now = new Date();
    await Match.updateMany(
        { commenceTime: { $lte: now }, status: 'upcoming' },
        { $set: { status: 'live' } }
    );
    await Match.updateMany(
        { commenceTime: { $lte: new Date(now.getTime() - 6 * 60 * 60 * 1000) }, status: { $in: ['upcoming', 'live'] } },
        { $set: { isActive: false } }
    );

    console.log(`[OddsProvider] Full refresh complete: ${totalSynced} matches`);
    return { totalSynced };
}

module.exports = {
    fetchSportsList,
    fetchMatchesForSport,
    syncSports,
    syncMatchesForSport,
    fullRefresh
};
