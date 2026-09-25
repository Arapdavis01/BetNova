// home.js — Home page specific logic
// Loads top leagues, popular matches, live now

document.addEventListener('DOMContentLoaded', () => {
    loadTopLeagues();
    loadLiveNow();
    loadPopularMatches();
});

// ============================================
// TOP LEAGUES
// ============================================
async function loadTopLeagues() {
    const container = document.getElementById('top-leagues');
    if (!container) return;

    const leagues = [
        { key: 'soccer_epl', title: 'Premier League', country: '🏴󠁧󠁢󠁥󠁮󠁧󠁿' },
        { key: 'soccer_spain_la_liga', title: 'La Liga', country: '🇪🇸' },
        { key: 'soccer_uefa_champs_league', title: 'Champions League', country: '🇪🇺' },
        { key: 'soccer_italy_serie_a', title: 'Serie A', country: '🇮🇹' },
        { key: 'soccer_germany_bundesliga', title: 'Bundesliga', country: '🇩🇪' },
        { key: 'soccer_africa_cup_of_nations', title: 'AFCON', country: '🌍' }
    ];

    container.innerHTML = leagues.map(l => `
        <a href="/soccer?sport=${l.key}" class="shell-league-card">
            <span class="shell-league-flag">${l.country}</span>
            <span class="shell-league-title">${l.title}</span>
            <i class="fa-solid fa-chevron-right shell-league-arrow"></i>
        </a>
    `).join('');
}

// ============================================
// LIVE NOW
// ============================================
async function loadLiveNow() {
    const section = document.getElementById('live-section');
    const container = document.getElementById('live-now');
    if (!section || !container) return;

    try {
        const res = await fetch(`${BetNova.API_BASE}/api/sports/matches/live?limit=6`);
        const data = await res.json();
        const matches = data.matches || [];

        if (matches.length === 0) {
            section.style.display = 'none';
            return;
        }

        section.style.display = 'block';
        container.innerHTML = matches.map(m => renderMatchCard(m, true)).join('');
        attachOddHandlers(container);
    } catch (err) {
        console.error('Live now error:', err);
        section.style.display = 'none';
    }
}

// ============================================
// POPULAR MATCHES
// ============================================
async function loadPopularMatches() {
    const container = document.getElementById('popular-matches');
    if (!container) return;

    try {
        const res = await fetch(`${BetNova.API_BASE}/api/sports/matches/popular?limit=6`);
        const data = await res.json();
        const matches = data.matches || [];

        if (matches.length === 0) {
            container.innerHTML = `
                <div class="shell-loading-inline">
                    <i class="fa-solid fa-futbol"></i>
                    <span>No matches available right now</span>
                </div>`;
            return;
        }

        container.innerHTML = matches.map(m => renderMatchCard(m, false)).join('');
        attachOddHandlers(container);
    } catch (err) {
        console.error('Popular matches error:', err);
        container.innerHTML = `
            <div class="shell-loading-inline">
                <i class="fa-solid fa-triangle-exclamation"></i>
                <span>Failed to load matches</span>
            </div>`;
    }
}

// ============================================
// RENDER MATCH CARD
// ============================================
function renderMatchCard(m, isLive) {
    const home = m.odds?.home || 0;
    const draw = m.odds?.draw || 0;
    const away = m.odds?.away || 0;
    const hasDraw = draw > 1.01;

    const time = new Date(m.commenceTime).toLocaleString('en-KE', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit'
    });

    const timeBadge = isLive
        ? `<span class="shell-match-live"><i class="fa-solid fa-circle"></i> LIVE</span>`
        : `<i class="fa-regular fa-clock"></i> ${time}`;

    const slip = BetNova.getBetSlip();
    const isSelected = (pick) => slip.some(s => s.matchExternalId === m.externalId && s.pick === pick);

    const dataAttrs = `data-match="${BetNova.escapeHtml(m.externalId)}" data-home="${BetNova.escapeHtml(m.homeTeam)}" data-away="${BetNova.escapeHtml(m.awayTeam)}" data-league="${BetNova.escapeHtml(m.sportTitle)}" data-time="${m.commenceTime}"`;

    return `
        <div class="shell-match-row">
            <div class="shell-match-info">
                <div class="shell-match-meta">
                    <span class="shell-match-league">${BetNova.escapeHtml(m.sportTitle)}</span>
                    <span class="shell-match-time">${timeBadge}</span>
                </div>
                <div class="shell-match-teams">
                    <div class="shell-match-team">${BetNova.escapeHtml(m.homeTeam)}</div>
                    <div class="shell-match-team">${BetNova.escapeHtml(m.awayTeam)}</div>
                </div>
            </div>
            <div class="shell-match-odds">
                <button class="shell-odd-btn ${isSelected('home') ? 'selected' : ''}"
                        ${dataAttrs} data-pick="home" data-odds="${home}">
                    <span class="shell-odd-label">1</span>
                    <span class="shell-odd-value">${home > 1.01 ? home.toFixed(2) : '—'}</span>
                </button>
                ${hasDraw ? `
                <button class="shell-odd-btn ${isSelected('draw') ? 'selected' : ''}"
                        ${dataAttrs} data-pick="draw" data-odds="${draw}">
                    <span class="shell-odd-label">X</span>
                    <span class="shell-odd-value">${draw.toFixed(2)}</span>
                </button>` : ''}
                <button class="shell-odd-btn ${isSelected('away') ? 'selected' : ''}"
                        ${dataAttrs} data-pick="away" data-odds="${away}">
                    <span class="shell-odd-label">2</span>
                    <span class="shell-odd-value">${away > 1.01 ? away.toFixed(2) : '—'}</span>
                </button>
            </div>
        </div>
    `;
}

// ============================================
// ATTACH ODD CLICK HANDLERS
// ============================================
function attachOddHandlers(container) {
    container.querySelectorAll('.shell-odd-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();

            const selection = {
                matchExternalId: btn.dataset.match,
                pick: btn.dataset.pick,
                homeTeam: btn.dataset.home,
                awayTeam: btn.dataset.away,
                sportTitle: btn.dataset.league,
                commenceTime: btn.dataset.time,
                odds: parseFloat(btn.dataset.odds)
            };

            BetNova.handleOddClick(selection);
            // Refresh selected states
            setTimeout(() => {
                loadLiveNow();
                loadPopularMatches();
            }, 300);
        });
    });
}
