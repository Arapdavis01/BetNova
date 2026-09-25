// ============================================
// BetNova — Odds Provider
// Fetches from The Odds API with priority top leagues
// ============================================

const axios = require('axios');
const Sport = require('../models/Sport');
const Match = require('../models/Match');

const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';
const API_KEY = () => process.env.ODDS_API_KEY;

// ============================================
// PRIORITY LEAGUES — order matters
// Fetched first, shown first on the frontend
// ============================================
const PRIORITY_LEAGUES = [
    // ---- Top European soccer ----
    { key: 'soccer_epl', group: 'Soccer', title: 'English Premier League', country: 'England', priority: 1 },
    { key: 'soccer_spain_la_liga', group: 'Soccer', title: 'La Liga', country: 'Spain', priority: 2 },
    { key: 'soccer_uefa_champs_league', group: 'Soccer', title: 'UEFA Champions League', country: 'Europe', priority: 3 },
    { key: 'soccer_italy_serie_a', group: 'Soccer', title: 'Serie A', country: 'Italy', priority: 4 },
    { key: 'soccer_germany_bundesliga', group: 'Soccer', title: 'Bundesliga', country: 'Germany', priority: 5 },
    { key: 'soccer_france_ligue_one', group: 'Soccer', title: 'Ligue 1', country: 'France', priority: 6 },
    { key: 'soccer_uefa_europa_league', group: 'Soccer', title: 'UEFA Europa League', country: 'Europe', priority: 7 },
    { key: 'soccer_uefa_europa_conference_league', group: 'Soccer', title: 'UEFA Conference League', country: 'Europe', priority: 8 },

    // ---- Africa (Kenya relevance) ----
    { key: 'soccer_africa_cup_of_nations', group: 'Soccer', title: 'Africa Cup of Nations', country: 'Africa', priority: 9 },
    { key: 'soccer_kenya_premier_league', group: 'Soccer', title: 'Kenyan Premier League', country: 'Kenya', priority: 10 },

    // ---- Other major soccer ----
    { key: 'soccer_efl_champ', group: 'Soccer', title: 'EFL Championship', country: 'England', priority: 11 },
    { key: 'soccer_netherlands_eredivisie', group: 'Soccer', title: 'Eredivisie', country: 'Netherlands', priority: 12 },
    { key: 'soccer_portugal_primeira_liga', group: 'Soccer', title: 'Primeira Liga', country: 'Portugal', priority: 13 },

    // ---- Other sports ----
    { key: 'basketball_nba', group: 'Basketball', title: 'NBA', country: 'USA', priority: 20 },
    { key: 'basketball_euroleague', group: 'Basketball', title: 'EuroLeague', country: 'Europe', priority: 21 },
    { key: 'tennis_atp_aus_open_singles', group: 'Tennis', title: 'ATP Australian Open', country: 'Australia', priority: 22 },
    { key: 'tennis_wta_aus_open_singles', group: 'Tennis', title: 'WTA Australian Open', country: 'Australia', priority: 23 },
    { key: 'icehockey_nhl', group: 'Ice Hockey', title: 'NHL', country: 'USA', priority: 24 },
    { key: 'americanfootball_nfl', group: 'American Football', title: 'NFL', country: 'USA', priority: 25 }
];

// ============================================
// SPORTS LIST
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
        // Only in-season sports
        if (!s.active) continue;
        // Skip outrights
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
// FETCH MATCHES FOR A SPORT
// ============================================
async function fetchMatchesForSport(sportKey, regions = 'eu,uk', markets = 'h2h') {
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
 * Extract 1X2 odds from the best available bookmaker.
 * Prefers well-known, high-liquidity bookmakers.
 */
function extractOdds(event) {
    if (!event.bookmakers || event.bookmakers.length === 0) return null;

    // Preferred bookmakers (high liquidity, accurate lines)
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
// SYNC ONE SPORT'S MATCHES
// ============================================
async function syncMatchesForSport(sportKey, sportGroup, sportTitle, country = null) {
    let events;
    try {
        events = await fetchMatchesForSport(sportKey);
    } catch (err) {
        // 422 = sport not in season, silently skip
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
            country: country || '',
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
// FULL REFRESH — priority leagues + all remaining
// ============================================
async function fullRefresh() {
    const startTime = Date.now();
    console.log('[OddsProvider] Starting full refresh...');

    // 1. Sync the sports list first
    await syncSports();

    // 2. Fetch matches for all priority leagues (parallel in batches of 4)
    const BATCH_SIZE = 4;
    let totalSynced = 0;

    for (let i = 0; i < PRIORITY_LEAGUES.length; i += BATCH_SIZE) {
        const batch = PRIORITY_LEAGUES.slice(i, i + BATCH_SIZE);

        const results = await Promise.all(
            batch.map(league =>
                syncMatchesForSport(
                    league.key,
                    league.group,
                    league.title,
                    league.country
                ).catch(err => {
                    console.error(`[OddsProvider] Batch error for ${league.key}:`, err.message);
                    return { synced: 0 };
                })
            )
        );

        totalSynced += results.reduce((sum, r) => sum + r.synced, 0);

        // Small delay between batches to respect rate limits
        if (i + BATCH_SIZE < PRIORITY_LEAGUES.length) {
            await new Promise(r => setTimeout(r, 400));
        }
    }

    // 3. Mark started matches as live
    const now = new Date();
    await Match.updateMany(
        { commenceTime: { $lte: now }, status: 'upcoming' },
        { $set: { status: 'live' } }
    );

    // 4. Deactivate old matches (6+ hours past start)
    await Match.updateMany(
        {
            commenceTime: { $lte: new Date(now.getTime() - 6 * 60 * 60 * 1000) },
            status: { $in: ['upcoming', 'live'] }
        },
        { $set: { isActive: false } }
    );

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[OddsProvider] Full refresh complete: ${totalSynced} matches in ${duration}s`);

    return { totalSynced, duration };
}

// ============================================
// MANUAL SYNC FOR A SPECIFIC SPORT
// ============================================
async function syncOneSport(sportKey) {
    const league = PRIORITY_LEAGUES.find(l => l.key === sportKey);
    if (!league) return { synced: 0, error: 'Unknown sport key' };
    return syncMatchesForSport(league.key, league.group, league.title, league.country);
}

module.exports = {
    fetchSportsList,
    fetchMatchesForSport,
    syncSports,
    syncMatchesForSport,
    syncOneSport,
    fullRefresh,
    PRIORITY_LEAGUES
};
