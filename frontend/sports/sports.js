// ============================================
// BetNova — Soccer Betting Client
// Uses shared BetNova bet slip (localStorage)
// Client-side date bounds · Live tab · Auth-aware odds
// ============================================

// ---------- API Base Detection ----------
const SPORTS_API_BASE = (() => {
    const host = window.location.hostname;
    const port = window.location.port;
    if ((host === 'localhost' || host === '127.0.0.1') && port !== '5000') {
        return 'http://localhost:5000';
    }
    return '';
})();

// ============================================
// SHARED BETNOVA BRIDGE
// shell.js is loaded before sports.js on every page.
// Fallbacks keep this file functional if shell.js fails.
// ============================================
const Nova = window.BetNova || {};
const shellReady = typeof Nova.getBetSlip === 'function';

// Local fallbacks (should rarely trigger — shell.js owns these)
const _getBetSlip = shellReady ? Nova.getBetSlip : () => {
    try { return JSON.parse(localStorage.getItem('betnova_betslip') || '[]'); }
    catch (_) { return []; }
};
const _addToBetSlip = shellReady ? Nova.addToBetSlip : (sel) => {
    const slip = _getBetSlip();
    const i = slip.findIndex(s => s.matchExternalId === sel.matchExternalId);
    if (i >= 0) {
        if (slip[i].pick === sel.pick) slip.splice(i, 1);
        else slip[i] = sel;
    } else {
        slip.push(sel);
    }
    localStorage.setItem('betnova_betslip', JSON.stringify(slip));
    window.dispatchEvent(new CustomEvent('betslip:changed', { detail: { slip } }));
    return true;
};
const _removeFromBetSlip = shellReady ? Nova.removeFromBetSlip : (id) => {
    const slip = _getBetSlip().filter(s => s.matchExternalId !== id);
    localStorage.setItem('betnova_betslip', JSON.stringify(slip));
    window.dispatchEvent(new CustomEvent('betslip:changed', { detail: { slip } }));
};
const _clearBetSlip = shellReady ? Nova.clearSharedBetSlip : () => {
    localStorage.setItem('betnova_betslip', '[]');
    window.dispatchEvent(new CustomEvent('betslip:changed', { detail: { slip: [] } }));
};
const _handleOddClick = shellReady ? Nova.handleOddClick : (sel) => _addToBetSlip(sel);
const _showToast = shellReady ? Nova.showToast : (msg, type) => {
    const t = document.getElementById('toast');
    if (!t) return;
    t.innerText = msg;
    t.className = `spo-toast ${type || 'info'}`;
    t.classList.remove('hidden');
    clearTimeout(window.__sportsToast);
    window.__sportsToast = setTimeout(() => t.classList.add('hidden'), 3000);
};
const _formatKES = shellReady ? Nova.formatKES : (n) => parseFloat(n || 0).toLocaleString('en-KE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
});

// ============================================
// STATE
// ============================================
let currentUser = null;
let currentSport = null;
let currentGroup = null;
let currentDateRange = 'today';   // today | tomorrow | week | all | live
let currentSearch = '';
let matches = [];
let groupedMatches = [];
let collapsedLeagues = {};
let searchDebounceTimer = null;

// Country flags
const COUNTRY_FLAGS = {
    'England': '🏴󠁧󠁢󠁥󠁮󠁧󠁿',
    'Spain': '🇪🇸',
    'Italy': '🇮🇹',
    'Germany': '🇩🇪',
    'France': '🇫🇷',
    'Europe': '🇪🇺',
    'Africa': '🌍',
    'Kenya': '🇰🇪',
    'Netherlands': '🇳🇱',
    'Portugal': '🇵🇹',
    'USA': '🇺🇸',
    'Australia': '🇦🇺',
    'Turkey': '🇹🇷',
    'Scotland': '🏴󠁧󠁢󠁳󠁣󠁴󠁿',
    'Belgium': '🇧🇪',
    'Brazil': '🇧🇷'
};

// ============================================
// UTILS
// ============================================
function escapeHtml(t) {
    const d = document.createElement('div');
    d.textContent = t || '';
    return d.innerHTML;
}

function showToast(msg, type = 'info', duration = 3000) {
    _showToast(msg, type, duration);
}

function formatKES(n) {
    return _formatKES(n);
}

/**
 * Compute the ISO timestamp bounds for a given date range.
 * Runs on the CLIENT so the timezone is the user's local time.
 */
function getDateRangeBounds(range) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    switch (range) {
        case 'today': {
            const end = new Date(today);
            end.setDate(end.getDate() + 1);
            return { from: today, to: end };
        }
        case 'tomorrow': {
            const start = new Date(today);
            start.setDate(start.getDate() + 1);
            const end = new Date(start);
            end.setDate(end.getDate() + 1);
            return { from: start, to: end };
        }
        case 'week': {
            const end = new Date(today);
            end.setDate(end.getDate() + 7);
            return { from: today, to: end };
        }
        case 'all':
        default:
            return { from: null, to: null };
    }
}

function formatMatchTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const time = d.toLocaleTimeString('en-KE', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    });

    const dDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());

    if (dDay.getTime() === today.getTime()) return `Today · ${time}`;
    if (dDay.getTime() === tomorrow.getTime()) return `Tomorrow · ${time}`;

    return d.toLocaleDateString('en-KE', {
        day: '2-digit',
        month: 'short'
    }) + ` · ${time}`;
}

function getFlag(country) {
    if (!country) return '';
    return COUNTRY_FLAGS[country] || '';
}

// ============================================
// SESSION
// ============================================
function checkSession() {
    const user = localStorage.getItem('betnova_user');
    const userId = localStorage.getItem('betnova_userid');
    const balance = localStorage.getItem('betnova_balance');

    if (user && userId) {
        currentUser = { userId, username: user };
        const balEl = document.getElementById('balance-display');
        if (balEl) balEl.innerText = formatKES(balance || 0);
    } else {
        currentUser = null;
    }

    // Re-render odds selected state on signin/logout
    refreshOddHighlights();
    renderBetSlip();
    updateBetslipCount();
}

async function refreshBalance() {
    if (!currentUser) return;
    try {
        const res = await fetch(`${SPORTS_API_BASE}/api/me/${currentUser.userId}`);
        if (!res.ok) return;
        const data = await res.json();
        localStorage.setItem('betnova_balance', data.balance);
        const balEl = document.getElementById('balance-display');
        if (balEl) balEl.innerText = formatKES(data.balance);
    } catch (_) {}
}

// ============================================
// DATE RANGE
// ============================================
function setDateRange(range) {
    currentDateRange = range;
    document.querySelectorAll('.spo-date-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.range === range);
    });
    loadMatches();
}

// ============================================
// SPORT GROUP FILTER (mobile chips)
// ============================================
function setSportGroup(group) {
    currentGroup = group === 'all' ? null : group;
    currentSport = null;
    document.querySelectorAll('.spo-sport-chip').forEach(c => {
        c.classList.toggle('active', c.dataset.group === group);
    });
    document.querySelectorAll('.spo-sport-item').forEach(b => b.classList.remove('active'));
    if (window.innerWidth <= 900) toggleSidebar();
    loadMatches();
}

// ============================================
// SIDEBAR
// ============================================
function toggleSidebar() {
    const sidebar = document.getElementById('sports-sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    if (!sidebar || !overlay) return;

    sidebar.classList.toggle('mobile-open');
    overlay.classList.toggle('hidden', !sidebar.classList.contains('mobile-open'));
}

// ============================================
// BET SLIP DRAWER
// The shared shell.js drawer is the source of truth.
// This just proxies the header button and Escape key.
// ============================================
function toggleBetSlip() {
    if (typeof window.openBetslipDrawer === 'function') {
        window.openBetslipDrawer();
    } else {
        // Fallback: local drawer if shell.js drawer is missing
        const betslip = document.getElementById('betslip');
        const overlay = document.getElementById('betslip-overlay');
        if (!betslip || !overlay) return;
        betslip.classList.toggle('mobile-open');
        overlay.classList.toggle('hidden', !betslip.classList.contains('mobile-open'));
    }
}

// ============================================
// SEARCH
// ============================================
function debouncedFilter() {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
        filterMatches();
    }, 300);
}

function filterMatches() {
    const search = document.getElementById('team-search');
    if (!search) return;
    currentSearch = search.value.trim();
    loadMatches();
}

function filterLeagues() {
    const search = document.getElementById('league-search');
    if (!search) return;
    const q = search.value.trim().toLowerCase();

    document.querySelectorAll('.spo-sport-item').forEach(btn => {
        const title = (btn.dataset.title || '').toLowerCase();
        btn.style.display = !q || title.includes(q) ? '' : 'none';
    });
}

// ============================================
// LOAD LEAGUES (sidebar)
// ============================================
async function loadSports() {
    const container = document.getElementById('sports-list');
    if (!container) return;

    try {
        const res = await fetch(`${SPORTS_API_BASE}/api/sports/leagues`);
        const data = await res.json();

        if (!data.leagues || data.leagues.length === 0) {
            container.innerHTML = `
                <div class="spo-loading">
                    <i class="fa-solid fa-futbol"></i>
                    <span>No leagues available yet</span>
                </div>`;
            return;
        }

        const grouped = {};
        data.leagues.forEach(l => {
            if (!grouped[l.sportGroup]) grouped[l.sportGroup] = [];
            grouped[l.sportGroup].push(l);
        });

        let html = '';
        Object.keys(grouped).sort().forEach(group => {
            html += `<div class="spo-sport-group">`;
            html += `<div class="spo-sport-group-title">${escapeHtml(group)}</div>`;
            grouped[group].forEach(l => {
                const flag = getFlag(l.country);
                html += `
                    <button class="spo-sport-item"
                            data-sport="${l.sportKey}"
                            data-group="${escapeHtml(l.sportGroup)}"
                            data-title="${escapeHtml(l.sportTitle)}">
                        ${flag ? `<span>${flag}</span>` : ''}
                        <span>${escapeHtml(l.sportTitle)}</span>
                        <span class="spo-sport-count">${l.matchCount}</span>
                    </button>`;
            });
            html += `</div>`;
        });

        container.innerHTML = html;

        container.querySelectorAll('.spo-sport-item').forEach(btn => {
            btn.addEventListener('click', () => {
                container.querySelectorAll('.spo-sport-item').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                currentSport = btn.dataset.sport;
                currentGroup = btn.dataset.group;

                if (window.innerWidth <= 900) toggleSidebar();
                loadMatches();
            });
        });
    } catch (err) {
        console.error('Sports load error:', err);
        container.innerHTML = `
            <div class="spo-loading">
                <i class="fa-solid fa-triangle-exclamation"></i>
                <span>Failed to load leagues</span>
            </div>`;
    }
}

// ============================================
// LOAD MATCHES — sends ISO from/to, handles live
// ============================================
async function loadMatches() {
    const container = document.getElementById('matches-list');
    if (!container) return;

    container.innerHTML = `
        <div class="spo-loading">
            <i class="fa-solid fa-spinner fa-spin"></i>
            <span>Loading matches...</span>
        </div>`;

    try {
        const params = new URLSearchParams();
        if (currentSport) params.set('sport', currentSport);
        else if (currentGroup) params.set('group', currentGroup);

        if (currentDateRange === 'live') {
            params.set('status', 'live');
        } else {
            params.set('status', 'upcoming');
            if (currentDateRange !== 'all') {
                const { from, to } = getDateRangeBounds(currentDateRange);
                if (from) params.set('from', from.toISOString());
                if (to) params.set('to', to.toISOString());
            }
        }

        params.set('limit', '300');
        params.set('format', 'grouped');
        if (currentSearch && currentSearch.length >= 2) {
            params.set('search', currentSearch);
        }

        const res = await fetch(`${SPORTS_API_BASE}/api/sports/matches?${params}`);
        const data = await res.json();

        groupedMatches = data.groups || [];
        matches = groupedMatches.flatMap(g => g.matches);

        if (matches.length === 0) {
            container.innerHTML = `
                <div class="spo-empty-state">
                    <i class="fa-solid fa-futbol"></i>
                    <h3>No matches found</h3>
                    <p>${currentSearch ? 'Try a different team name' : 'Try a different date filter'}</p>
                    ${currentDateRange === 'live' ? '<p class="spo-live-hint">No matches are live right now</p>' : ''}
                </div>`;
            return;
        }

        container.innerHTML = groupedMatches.map(g => renderLeagueSection(g)).join('');

        // League collapse
        container.querySelectorAll('.spo-league-header').forEach(header => {
            header.addEventListener('click', () => {
                const section = header.closest('.spo-league-section');
                if (!section) return;
                const key = section.dataset.league;
                collapsedLeagues[key] = !collapsedLeagues[key];
                section.classList.toggle('collapsed', collapsedLeagues[key]);
            });
        });

        // Odd button handlers — route through shared handler
        container.querySelectorAll('.spo-odd-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                handleOddButtonClick(btn);
            });
        });

        refreshOddHighlights();

        // Restore collapsed state
        container.querySelectorAll('.spo-league-section').forEach(section => {
            if (collapsedLeagues[section.dataset.league]) {
                section.classList.add('collapsed');
            }
        });
    } catch (err) {
        console.error('Matches load error:', err);
        container.innerHTML = `
            <div class="spo-loading">
                <i class="fa-solid fa-triangle-exclamation"></i>
                <span>Failed to load matches</span>
            </div>`;
    }
}

// ============================================
// RENDER — League section
// ============================================
function renderLeagueSection(group) {
    const flag = getFlag(group.country);
    const matchCount = group.matches.length;

    return `
        <div class="spo-league-section" data-league="${escapeHtml(group.sportKey)}">
            <div class="spo-league-header">
                ${flag ? `<span class="spo-league-flag">${flag}</span>` : ''}
                <span class="spo-league-title">${escapeHtml(group.sportTitle)}</span>
                <span class="spo-league-count">${matchCount} ${matchCount === 1 ? 'match' : 'matches'}</span>
                <i class="fa-solid fa-chevron-down spo-league-toggle"></i>
            </div>
            <div class="spo-league-matches">
                ${group.matches.map(m => renderMatch(m)).join('')}
            </div>
        </div>
    `;
}

// ============================================
// RENDER — Match row
// ============================================
function renderMatch(m) {
    const home = m.odds?.home || 0;
    const draw = m.odds?.draw || 0;
    const away = m.odds?.away || 0;
    const hasDraw = draw && draw > 1.01;

    const inBetSlip = (pick) => _getBetSlip().some(s =>
        s.matchExternalId === m.externalId && s.pick === pick
    );

    const isLive = new Date(m.commenceTime) <= new Date();
    const timeDisplay = isLive
        ? `<span class="spo-time-live"><i class="fa-solid fa-circle"></i> LIVE</span>`
        : `<i class="fa-regular fa-clock"></i> ${formatMatchTime(m.commenceTime)}`;

    // Data attrs carry everything the shared handler needs
    const d = `data-match="${escapeHtml(m.externalId)}"
               data-home="${escapeHtml(m.homeTeam)}"
               data-away="${escapeHtml(m.awayTeam)}"
               data-league="${escapeHtml(m.sportTitle)}"
               data-time="${escapeHtml(m.commenceTime || '')}"`;

    return `
        <div class="spo-match" data-match="${escapeHtml(m.externalId)}">
            <div class="spo-match-info">
                <div class="spo-match-time">
                    ${timeDisplay}
                </div>
                <div class="spo-match-teams">
                    <div class="spo-match-team">${escapeHtml(m.homeTeam)}</div>
                    <div class="spo-match-team">${escapeHtml(m.awayTeam)}</div>
                </div>
            </div>
            <div class="spo-odds-row">
                <button class="spo-odd-btn ${inBetSlip('home') ? 'selected' : ''}"
                        ${d}
                        data-pick="home"
                        data-odds="${home}"
                        ${home > 1.01 ? '' : 'disabled'}>
                    <span class="spo-odd-label">1</span>
                    <span class="spo-odd-value">${home > 1.01 ? home.toFixed(2) : '—'}</span>
                </button>
                ${hasDraw ? `
                <button class="spo-odd-btn ${inBetSlip('draw') ? 'selected' : ''}"
                        ${d}
                        data-pick="draw"
                        data-odds="${draw}">
                    <span class="spo-odd-label">X</span>
                    <span class="spo-odd-value">${draw.toFixed(2)}</span>
                </button>` : ''}
                <button class="spo-odd-btn ${inBetSlip('away') ? 'selected' : ''}"
                        ${d}
                        data-pick="away"
                        data-odds="${away}"
                        ${away > 1.01 ? '' : 'disabled'}>
                    <span class="spo-odd-label">2</span>
                    <span class="spo-odd-value">${away > 1.01 ? away.toFixed(2) : '—'}</span>
                </button>
            </div>
        </div>
    `;
}

// ============================================
// ODD CLICK — routes through shared handler
// Anonymous → store pending + open Sign In
// Logged in → add to shared slip
// ============================================
function handleOddButtonClick(btn) {
    const odds = parseFloat(btn.dataset.odds);
    if (!odds || odds <= 1.01) return;

    const selection = {
        matchExternalId: btn.dataset.match,
        pick: btn.dataset.pick,
        homeTeam: btn.dataset.home,
        awayTeam: btn.dataset.away,
        sportTitle: btn.dataset.league,
        commenceTime: btn.dataset.time,
        odds
    };

    _handleOddClick(selection);

    // Local re-render of selected state (fast, no refetch)
    setTimeout(() => {
        refreshOddHighlights();
        updateBetslipCount();
    }, 100);
}

// ============================================
// BET SLIP — Proxy render into the shared drawer
// The shell.js drawer is the real UI. This function
// exists so pages that still have the old markup
// can render a local slip. New pages use the drawer.
// ============================================
function renderBetSlip() {
    // Shared drawer elements (shell.js)
    const sharedBody = document.getElementById('betslip-drawer-body');
    const sharedFooter = document.getElementById('betslip-drawer-footer');
    const slip = _getBetSlip();

    if (sharedBody) {
        if (slip.length === 0) {
            sharedBody.innerHTML = `
                <div class="shell-betslip-empty">
                    <i class="fa-solid fa-ticket"></i>
                    <p>Click on odds to add selections</p>
                    <span>Combine picks for bigger odds</span>
                </div>`;
            if (sharedFooter) sharedFooter.style.display = 'none';
        } else {
            sharedBody.innerHTML = slip.map(s => {
                const pickLabel = s.pick === 'home' ? '1' : s.pick === 'draw' ? 'X' : '2';
                return `
                    <div class="shell-betslip-item">
                        <div class="shell-betslip-item-top">
                            <div class="shell-betslip-item-teams">
                                ${escapeHtml(s.homeTeam)} vs ${escapeHtml(s.awayTeam)}
                            </div>
                            <button class="shell-betslip-item-remove"
                                    onclick="sportsRemoveSelection('${escapeHtml(s.matchExternalId)}')"
                                    aria-label="Remove">&times;</button>
                        </div>
                        <div class="shell-betslip-item-meta">
                            <span class="shell-betslip-item-pick">
                                <i class="fa-solid fa-check"></i> ${pickLabel}
                            </span>
                            <span class="shell-betslip-item-odds">${s.odds.toFixed(2)}x</span>
                        </div>
                    </div>
                `;
            }).join('');
            if (sharedFooter) sharedFooter.style.display = 'flex';
            recalcBetSlip();
        }
        return;
    }

    // Legacy local drawer (for old markup)
    const body = document.getElementById('betslip-body');
    const footer = document.getElementById('betslip-footer');
    if (!body || !footer) return;

    if (slip.length === 0) {
        body.innerHTML = `
            <div class="spo-betslip-empty">
                <i class="fa-solid fa-ticket"></i>
                <p>Click on odds to add selections</p>
                <span>Combine picks for bigger odds</span>
            </div>`;
        footer.style.display = 'none';
        return;
    }

    body.innerHTML = slip.map((s, i) => {
        const pickLabel = s.pick === 'home' ? '1' : s.pick === 'draw' ? 'X' : '2';
        return `
            <div class="spo-slip-item">
                <button class="spo-slip-item-remove"
                        onclick="sportsRemoveSelection('${escapeHtml(s.matchExternalId)}')"
                        aria-label="Remove">&times;</button>
                <div class="spo-slip-teams">${escapeHtml(s.homeTeam)} vs ${escapeHtml(s.awayTeam)}</div>
                <div class="spo-slip-pick">
                    <span class="spo-slip-pick-label">${pickLabel}</span>
                    <span class="spo-slip-odds">${s.odds.toFixed(2)}</span>
                </div>
            </div>
        `;
    }).join('');

    footer.style.display = 'block';
    recalcBetSlip();
}

// Expose for inline onclick
window.sportsRemoveSelection = function (matchExternalId) {
    _removeFromBetSlip(matchExternalId);
    renderBetSlip();
    refreshOddHighlights();
    updateBetslipCount();
};

window.sportsClearBetSlip = function () {
    if (_getBetSlip().length === 0) return;
    _clearBetSlip();
    renderBetSlip();
    refreshOddHighlights();
    updateBetslipCount();
    showToast('Bet slip cleared', 'info', 1500);
};

// ============================================
// BET SLIP — Highlight selected odds
// ============================================
function refreshOddHighlights() {
    const slip = _getBetSlip();
    document.querySelectorAll('.spo-odd-btn').forEach(btn => {
        const isSelected = slip.some(s =>
            s.matchExternalId === btn.dataset.match && s.pick === btn.dataset.pick
        );
        btn.classList.toggle('selected', isSelected);
    });
}

function updateBetslipCount() {
    const count = _getBetSlip().length;

    // Shared shell badge
    document.querySelectorAll('.shell-betslip-count, #betslip-count').forEach(el => {
        el.innerText = count;
        el.dataset.count = count;
    });

    // Legacy local badge
    const badgeEl = document.getElementById('betslip-count-badge');
    if (badgeEl) badgeEl.innerText = count;
}

// ============================================
// BET SLIP — Recalculate (odds MULTIPLIED)
// Reads input from either the shared drawer or the
// legacy local drawer, whichever is present.
// ============================================
function recalcBetSlip() {
    const slip = _getBetSlip();

    // ⭐ Total odds = MULTIPLY all selection odds
    const totalOdds = slip.reduce((acc, s) => acc * s.odds, 1);

    // Shared drawer stake input
    const sharedStake = document.getElementById('betslip-drawer-stake');
    if (sharedStake) {
        const stake = parseFloat(sharedStake.value) || 0;
        const payout = totalOdds * stake;
        const oddsEl = document.getElementById('betslip-drawer-total-odds');
        const payoutEl = document.getElementById('betslip-drawer-payout');
        const countEl = document.getElementById('betslip-drawer-selections');
        if (oddsEl) oddsEl.innerText = totalOdds.toFixed(2);
        if (payoutEl) payoutEl.innerText = `KES ${formatKES(payout)}`;
        if (countEl) countEl.innerText = slip.length;
    }

    // Legacy local drawer
    const stakeInput = document.getElementById('betslip-stake');
    if (stakeInput) {
        const stake = parseFloat(stakeInput.value) || 0;
        const payout = totalOdds * stake;
        const oddsEl = document.getElementById('betslip-total-odds');
        const payoutEl = document.getElementById('betslip-payout');
        const countEl = document.getElementById('betslip-selections-count');
        if (oddsEl) oddsEl.innerText = totalOdds.toFixed(2);
        if (payoutEl) payoutEl.innerText = `KES ${formatKES(payout)}`;
        if (countEl) countEl.innerText = slip.length;
    }
}

// ============================================
// STAKE CONTROLS — proxy for shared drawer
// ============================================
function adjustStake(delta) {
    const input = document.getElementById('betslip-stake')
               || document.getElementById('betslip-drawer-stake');
    if (!input) return;
    const current = parseFloat(input.value) || 0;
    input.value = Math.max(10, current + delta);
    recalcBetSlip();
}

function setStake(amount) {
    const input = document.getElementById('betslip-stake')
               || document.getElementById('betslip-drawer-stake');
    if (!input) return;
    input.value = amount;
    recalcBetSlip();
}

// ============================================
// PLACE BET
// Triggered from the shared shell drawer's button,
// which calls window.placeDrawerBet(). That function
// delegates here when on /soccer.
// ============================================
async function placeBet() {
    if (!currentUser) {
        // Shell's requireAuth opens sign-in modal
        if (shellReady && typeof Nova.requireAuth === 'function') {
            Nova.requireAuth(() => placeBet(), 'Sign in to place your bet');
        } else {
            showToast('Sign in to place bets', 'error');
        }
        return;
    }

    const slip = _getBetSlip();
    if (slip.length === 0) {
        showToast('Add selections first', 'error');
        return;
    }

    const stakeInput = document.getElementById('betslip-drawer-stake')
                    || document.getElementById('betslip-stake');
    const stake = stakeInput ? parseFloat(stakeInput.value) : 0;

    if (!stake || stake < 10) {
        showToast('Minimum stake is KES 10', 'error');
        return;
    }

    const balance = parseFloat(localStorage.getItem('betnova_balance') || 0);
    if (stake > balance) {
        showToast(`Insufficient balance. Available: KES ${formatKES(balance)}`, 'error');
        return;
    }

    const btn = document.getElementById('betslip-drawer-place')
             || document.getElementById('place-bet-btn');
    const originalHtml = btn ? btn.innerHTML : null;
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Placing...';
    }

    try {
        const res = await fetch(`${SPORTS_API_BASE}/api/sports/bets`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: currentUser.userId,
                stake,
                selections: slip.map(s => ({
                    matchExternalId: s.matchExternalId,
                    pick: s.pick
                }))
            })
        });
        const data = await res.json();

        if (!res.ok) {
            showToast(data.error || 'Failed to place bet', 'error', 5000);
            return;
        }

        localStorage.setItem('betnova_balance', data.newBalance);
        const balEl = document.getElementById('balance-display');
        if (balEl) balEl.innerText = formatKES(data.newBalance);
        const shellBal = document.getElementById('shell-balance');
        if (shellBal) shellBal.innerText = formatKES(data.newBalance);

        showToast(
            `Bet placed! Odds: ${data.totalOdds.toFixed(2)}x · Payout: KES ${formatKES(data.potentialPayout)}`,
            'success',
            5000
        );

        _clearBetSlip();
        renderBetSlip();
        refreshOddHighlights();
        updateBetslipCount();

        if (window.innerWidth <= 900 && typeof window.closeBetslipDrawer === 'function') {
            window.closeBetslipDrawer();
        }
    } catch (err) {
        console.error('Place bet error:', err);
        showToast('Network error — try again', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalHtml;
        }
    }
}

// Expose for the shared drawer button
window.placeDrawerBet = function () { placeBet(); };
window.sportsPlaceBet = placeBet;

// ============================================
// MY BETS
// ============================================
async function openMyBets() {
    if (!currentUser) {
        if (shellReady && typeof Nova.requireAuth === 'function') {
            Nova.requireAuth(() => openMyBets(), 'Sign in to view your bets');
        } else {
            showToast('Sign in to view your bets', 'error');
        }
        return;
    }

    // Prefer the shared shell history modal if present
    const sharedModal = document.getElementById('history-modal');
    const modal = sharedModal || document.getElementById('mybets-modal');
    if (modal) modal.classList.remove('hidden');

    const list = document.getElementById('history-list')
              || document.getElementById('mybets-list');
    if (!list) return;

    list.innerHTML = `
        <div class="spo-loading">
            <i class="fa-solid fa-spinner fa-spin"></i>
            <span>Loading...</span>
        </div>`;

    try {
        const res = await fetch(`${SPORTS_API_BASE}/api/sports/bets/${currentUser.userId}`);
        const data = await res.json();

        if (!data.bets || data.bets.length === 0) {
            list.innerHTML = `
                <div class="spo-empty-state" style="padding:40px 20px;">
                    <i class="fa-solid fa-ticket"></i>
                    <h3>No bets yet</h3>
                    <p>Place your first sports bet to see it here</p>
                </div>`;
            return;
        }

        list.innerHTML = data.bets.map(b => renderMyBet(b)).join('');
    } catch (err) {
        console.error('My bets error:', err);
        list.innerHTML = `
            <div class="spo-empty-state" style="padding:40px 20px;">
                <i class="fa-solid fa-triangle-exclamation"></i>
                <h3>Failed to load bets</h3>
                <p>Try again later</p>
            </div>`;
    }
}

function closeMyBets() {
    document.getElementById('mybets-modal')?.classList.add('hidden');
}

function renderMyBet(b) {
    const pickLabel = p => p === 'home' ? '1' : p === 'draw' ? 'X' : '2';
    const stake = formatKES(b.stake || 0);
    const payout = b.status === 'won'
        ? formatKES(b.actualPayout || 0)
        : formatKES(b.potentialPayout || 0);
    const statusClass = b.status || 'pending';

    return `
        <div class="spo-mybets-item">
            <div class="spo-mybets-header">
                <span class="spo-mybets-status ${statusClass}">${escapeHtml(statusClass)}</span>
                <span class="spo-mybets-odds">${(b.totalOdds || 0).toFixed(2)}x</span>
            </div>
            <div class="spo-mybets-selections">
                ${(b.selections || []).map(s => {
                    const resultClass = s.result === 'won' ? 'spo-selection-won' :
                                       s.result === 'lost' ? 'spo-selection-lost' : '';
                    return `<div class="${resultClass}">
                        <strong>${pickLabel(s.pick)}</strong> ${escapeHtml(s.homeTeam)} vs ${escapeHtml(s.awayTeam)}
                        · ${(s.odds || 0).toFixed(2)}x
                    </div>`;
                }).join('')}
            </div>
            <div class="spo-mybets-footer">
                <span>Stake: <strong>KES ${stake}</strong></span>
                <span>Payout: <strong style="color:${b.status === 'won' ? '#00c853' : '#ffffff'}">KES ${payout}</strong></span>
            </div>
        </div>
    `;
}

// ============================================
// CROSS-PAGE BET SLIP SYNC
// When the shared slip changes (from home, drawer, another tab),
// update our odds highlights + drawer render.
// ============================================
window.addEventListener('betslip:changed', () => {
    refreshOddHighlights();
    renderBetSlip();
    updateBetslipCount();
});

// Same-tab, cross-tab session changes
window.addEventListener('storage', (e) => {
    if (e.key === 'betnova_user' || e.key === 'betnova_userid' || e.key === 'betnova_balance') {
        checkSession();
    }
    if (e.key === 'betnova_betslip') {
        refreshOddHighlights();
        renderBetSlip();
        updateBetslipCount();
    }
});

// ============================================
// KEYBOARD SHORTCUTS
// ============================================
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        document.getElementById('mybets-modal')?.classList.add('hidden');
        document.getElementById('sports-sidebar')?.classList.remove('mobile-open');
        document.getElementById('sidebar-overlay')?.classList.add('hidden');
        // Shared drawer handles its own close, but ensure local one too
        document.getElementById('betslip')?.classList.remove('mobile-open');
        document.getElementById('betslip-overlay')?.classList.add('hidden');
    }
});

// ============================================
// SOCKET — Live balance updates
// ============================================
const sportsSocket = (shellReady && Nova.socket) ? Nova.socket : null;

if (sportsSocket) {
    sportsSocket.on('balance_update', (balance) => {
        localStorage.setItem('betnova_balance', balance);
        const el = document.getElementById('balance-display');
        if (el) el.innerText = formatKES(balance);
        const shellEl = document.getElementById('shell-balance');
        if (shellEl) shellEl.innerText = formatKES(balance);
    });
    sportsSocket.on('connect', () => console.log('[Soccer] Socket connected'));
} else {
    console.warn('[Soccer] Shared socket not available — page will not receive live updates');
}

// ============================================
// INIT
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    checkSession();
    loadSports();
    loadMatches();
    renderBetSlip();
    updateBetslipCount();
    refreshOddHighlights();

    setInterval(refreshBalance, 15000);

    setInterval(() => {
        if (!document.hidden) loadMatches();
    }, 60000);
});

// Re-sync when tab becomes visible
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
        refreshBalance();
        loadMatches();
        renderBetSlip();
        refreshOddHighlights();
        updateBetslipCount();
    }
});
