// ============================================
// BetNova — Sports Betting Client
// Grouped matches, date filters, mobile drawers, correct odds math
// ============================================

const API_BASE = (() => {
    const host = window.location.hostname;
    const port = window.location.port;
    if ((host === 'localhost' || host === '127.0.0.1') && port !== '5000') {
        return 'http://localhost:5000';
    }
    return '';
})();

const socket = io(API_BASE || undefined, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 10
});

// ============================================
// STATE
// ============================================
let currentUser = null;
let currentSport = null;         // Single league key (e.g., soccer_epl)
let currentGroup = null;         // Sport group (e.g., Soccer)
let currentDateRange = 'today';  // today | tomorrow | week | all
let currentSearch = '';          // Team search term
let matches = [];                // All currently loaded matches (flat)
let groupedMatches = [];         // [{ sportKey, sportTitle, country, matches: [] }]
let betSlip = [];                // [{ matchExternalId, homeTeam, awayTeam, sportTitle, commenceTime, pick, odds }]
let collapsedLeagues = {};       // { sportKey: true/false }
let searchDebounceTimer = null;

// Country flags (emoji)
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
function formatKES(n) {
    return parseFloat(n || 0).toLocaleString('en-KE', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

function escapeHtml(t) {
    const d = document.createElement('div');
    d.textContent = t || '';
    return d.innerHTML;
}

let toastTimer = null;
function showToast(msg, type = 'info', duration = 3000) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.innerText = msg;
    t.className = `spo-toast ${type}`;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), duration);
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
}

async function refreshBalance() {
    if (!currentUser) return;
    try {
        const res = await fetch(`${API_BASE}/api/me/${currentUser.userId}`);
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
    // Clear sidebar active state
    document.querySelectorAll('.spo-sport-item').forEach(b => b.classList.remove('active'));
    // Close sidebar on mobile if open
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
// BET SLIP DRAWER (mobile)
// ============================================
function toggleBetSlip() {
    const betslip = document.getElementById('betslip');
    const overlay = document.getElementById('betslip-overlay');
    if (!betslip || !overlay) return;

    betslip.classList.toggle('mobile-open');
    overlay.classList.toggle('hidden', !betslip.classList.contains('mobile-open'));
}

// ============================================
// DEBOUNCED SEARCH
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
// LOAD SPORTS (sidebar)
// ============================================
async function loadSports() {
    const container = document.getElementById('sports-list');
    if (!container) return;

    try {
        const res = await fetch(`${API_BASE}/api/sports/leagues`);
        const data = await res.json();

        if (!data.leagues || data.leagues.length === 0) {
            container.innerHTML = `
                <div class="spo-loading">
                    <i class="fa-solid fa-futbol"></i>
                    <span>No leagues available yet</span>
                </div>`;
            return;
        }

        // Group leagues by sportGroup
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

        // Attach click handlers
        container.querySelectorAll('.spo-sport-item').forEach(btn => {
            btn.addEventListener('click', () => {
                container.querySelectorAll('.spo-sport-item').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                currentSport = btn.dataset.sport;
                currentGroup = btn.dataset.group;

                // Close mobile sidebar
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
// LOAD MATCHES
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
        params.set('status', 'upcoming');
        params.set('range', currentDateRange);
        params.set('limit', '300');
        params.set('format', 'grouped');
        if (currentSearch && currentSearch.length >= 2) {
            params.set('search', currentSearch);
        }

        const res = await fetch(`${API_BASE}/api/sports/matches?${params}`);
        const data = await res.json();

        groupedMatches = data.groups || [];
        matches = groupedMatches.flatMap(g => g.matches);

        if (matches.length === 0) {
            container.innerHTML = `
                <div class="spo-empty-state">
                    <i class="fa-solid fa-futbol"></i>
                    <h3>No matches found</h3>
                    <p>${currentSearch ? 'Try a different team name' : 'Try a different date filter'}</p>
                </div>`;
            return;
        }

        container.innerHTML = groupedMatches.map(g => renderLeagueSection(g)).join('');

        // Attach league collapse handlers
        container.querySelectorAll('.spo-league-header').forEach(header => {
            header.addEventListener('click', () => {
                const section = header.closest('.spo-league-section');
                if (!section) return;
                const key = section.dataset.league;
                collapsedLeagues[key] = !collapsedLeagues[key];
                section.classList.toggle('collapsed', collapsedLeagues[key]);
            });
        });

        // Attach odd button handlers
        container.querySelectorAll('.spo-odd-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const externalId = btn.dataset.match;
                const pick = btn.dataset.pick;
                toggleSelection(externalId, pick);
            });
        });

        // Re-apply selected state
        refreshOddHighlights();

        // Apply any previously-collapsed leagues
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

    const inBetSlip = (pick) => betSlip.some(s =>
        s.matchExternalId === m.externalId && s.pick === pick
    );

    return `
        <div class="spo-match" data-match="${escapeHtml(m.externalId)}">
            <div class="spo-match-info">
                <div class="spo-match-time">
                    <i class="fa-regular fa-clock"></i>
                    ${formatMatchTime(m.commenceTime)}
                </div>
                <div class="spo-match-teams">
                    <div class="spo-match-team">${escapeHtml(m.homeTeam)}</div>
                    <div class="spo-match-team">${escapeHtml(m.awayTeam)}</div>
                </div>
            </div>
            <div class="spo-odds-row">
                <button class="spo-odd-btn ${inBetSlip('home') ? 'selected' : ''}"
                        data-match="${escapeHtml(m.externalId)}"
                        data-pick="home"
                        ${home > 1.01 ? '' : 'disabled'}>
                    <span class="spo-odd-label">1</span>
                    <span class="spo-odd-value">${home > 1.01 ? home.toFixed(2) : '—'}</span>
                </button>
                ${hasDraw ? `
                <button class="spo-odd-btn ${inBetSlip('draw') ? 'selected' : ''}"
                        data-match="${escapeHtml(m.externalId)}"
                        data-pick="draw">
                    <span class="spo-odd-label">X</span>
                    <span class="spo-odd-value">${draw.toFixed(2)}</span>
                </button>` : ''}
                <button class="spo-odd-btn ${inBetSlip('away') ? 'selected' : ''}"
                        data-match="${escapeHtml(m.externalId)}"
                        data-pick="away"
                        ${away > 1.01 ? '' : 'disabled'}>
                    <span class="spo-odd-label">2</span>
                    <span class="spo-odd-value">${away > 1.01 ? away.toFixed(2) : '—'}</span>
                </button>
            </div>
        </div>
    `;
}

// ============================================
// BET SLIP — Selection toggle
// ============================================
function toggleSelection(matchExternalId, pick) {
    const match = matches.find(m => m.externalId === matchExternalId);
    if (!match) return;

    const odds = match.odds[pick];
    if (!odds || odds <= 1.01) return;

    const existingIdx = betSlip.findIndex(s => s.matchExternalId === matchExternalId);

    if (existingIdx >= 0) {
        if (betSlip[existingIdx].pick === pick) {
            // Toggle off — user clicked the same pick
            betSlip.splice(existingIdx, 1);
            showToast('Removed from bet slip', 'info', 1500);
        } else {
            // Replace pick — user clicked a different outcome
            betSlip[existingIdx] = {
                matchExternalId,
                homeTeam: match.homeTeam,
                awayTeam: match.awayTeam,
                sportTitle: match.sportTitle,
                commenceTime: match.commenceTime,
                pick,
                odds
            };
            showToast('Pick updated', 'info', 1500);
        }
    } else {
        if (betSlip.length >= 20) {
            showToast('Maximum 20 selections per bet', 'error');
            return;
        }
        betSlip.push({
            matchExternalId,
            homeTeam: match.homeTeam,
            awayTeam: match.awayTeam,
            sportTitle: match.sportTitle,
            commenceTime: match.commenceTime,
            pick,
            odds
        });
        showToast(`Added: ${match.homeTeam} vs ${match.awayTeam}`, 'success', 1500);
    }

    renderBetSlip();
    refreshOddHighlights();
    updateBetslipCount();
}

// ============================================
// BET SLIP — Render
// ============================================
function renderBetSlip() {
    const body = document.getElementById('betslip-body');
    const footer = document.getElementById('betslip-footer');
    if (!body || !footer) return;

    if (betSlip.length === 0) {
        body.innerHTML = `
            <div class="spo-betslip-empty">
                <i class="fa-solid fa-ticket"></i>
                <p>Click on odds to add selections</p>
                <span>Combine picks for bigger odds</span>
            </div>`;
        footer.style.display = 'none';
        return;
    }

    body.innerHTML = betSlip.map((s, i) => {
        const pickLabel = s.pick === 'home' ? '1' :
                         s.pick === 'draw' ? 'X' : '2';
        return `
            <div class="spo-slip-item">
                <button class="spo-slip-item-remove" onclick="removeSelection(${i})" aria-label="Remove">&times;</button>
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

function removeSelection(index) {
    if (index < 0 || index >= betSlip.length) return;
    betSlip.splice(index, 1);
    renderBetSlip();
    refreshOddHighlights();
    updateBetslipCount();
}

function clearBetSlip() {
    if (betSlip.length === 0) return;
    betSlip = [];
    renderBetSlip();
    refreshOddHighlights();
    updateBetslipCount();
    showToast('Bet slip cleared', 'info', 1500);
}

function refreshOddHighlights() {
    document.querySelectorAll('.spo-odd-btn').forEach(btn => btn.classList.remove('selected'));
    betSlip.forEach(sel => {
        const btn = document.querySelector(
            `.spo-odd-btn[data-match="${sel.matchExternalId}"][data-pick="${sel.pick}"]`
        );
        if (btn) btn.classList.add('selected');
    });
}

function updateBetslipCount() {
    const countEl = document.getElementById('betslip-count');
    const badgeEl = document.getElementById('betslip-count-badge');
    const count = betSlip.length;
    if (countEl) {
        countEl.innerText = count;
        countEl.dataset.count = count;
    }
    if (badgeEl) badgeEl.innerText = count;
}

// ============================================
// BET SLIP — Recalculate
// ============================================
function recalcBetSlip() {
    // ⭐ CRITICAL: total odds = MULTIPLY all selection odds together
    // Example: 1.20 × 10.30 = 12.36
    const totalOdds = betSlip.reduce((acc, s) => acc * s.odds, 1);

    const stakeInput = document.getElementById('betslip-stake');
    const stake = stakeInput ? parseFloat(stakeInput.value) || 0 : 0;
    const payout = totalOdds * stake;

    const oddsEl = document.getElementById('betslip-total-odds');
    const payoutEl = document.getElementById('betslip-payout');
    const selectionsEl = document.getElementById('betslip-selections-count');

    if (oddsEl) oddsEl.innerText = totalOdds.toFixed(2);
    if (payoutEl) payoutEl.innerText = `KES ${formatKES(payout)}`;
    if (selectionsEl) selectionsEl.innerText = betSlip.length;
}

function adjustStake(delta) {
    const input = document.getElementById('betslip-stake');
    if (!input) return;
    const current = parseFloat(input.value) || 0;
    const next = Math.max(10, current + delta);
    input.value = next;
    recalcBetSlip();
}

function setStake(amount) {
    const input = document.getElementById('betslip-stake');
    if (!input) return;
    input.value = amount;
    recalcBetSlip();
}

// ============================================
// PLACE BET
// ============================================
async function placeBet() {
    if (!currentUser) {
        showToast('Sign in to place bets', 'error');
        return;
    }
    if (betSlip.length === 0) {
        showToast('Add selections first', 'error');
        return;
    }

    const stakeInput = document.getElementById('betslip-stake');
    const stake = parseFloat(stakeInput.value);
    if (!stake || stake < 10) {
        showToast('Minimum stake is KES 10', 'error');
        return;
    }

    const balance = parseFloat(localStorage.getItem('betnova_balance') || 0);
    if (stake > balance) {
        showToast(`Insufficient balance. Available: KES ${formatKES(balance)}`, 'error');
        return;
    }

    const btn = document.getElementById('place-bet-btn');
    const originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Placing...';

    try {
        const res = await fetch(`${API_BASE}/api/sports/bets`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: currentUser.userId,
                stake,
                selections: betSlip.map(s => ({
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

        // Update balance
        localStorage.setItem('betnova_balance', data.newBalance);
        const balEl = document.getElementById('balance-display');
        if (balEl) balEl.innerText = formatKES(data.newBalance);

        showToast(
            `Bet placed! Odds: ${data.totalOdds.toFixed(2)}x · Payout: KES ${formatKES(data.potentialPayout)}`,
            'success',
            5000
        );

        clearBetSlip();

        // Close mobile drawer
        if (window.innerWidth <= 900) {
            const betslip = document.getElementById('betslip');
            const overlay = document.getElementById('betslip-overlay');
            betslip?.classList.remove('mobile-open');
            overlay?.classList.add('hidden');
        }
    } catch (err) {
        console.error('Place bet error:', err);
        showToast('Network error — try again', 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalHtml;
    }
}

// ============================================
// MY BETS
// ============================================
async function openMyBets() {
    if (!currentUser) {
        showToast('Sign in to view your bets', 'error');
        return;
    }
    const modal = document.getElementById('mybets-modal');
    if (modal) modal.classList.remove('hidden');

    const list = document.getElementById('mybets-list');
    if (!list) return;
    list.innerHTML = `
        <div class="spo-loading">
            <i class="fa-solid fa-spinner fa-spin"></i>
            <span>Loading...</span>
        </div>`;

    try {
        const res = await fetch(`${API_BASE}/api/sports/bets/${currentUser.userId}`);
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
    const modal = document.getElementById('mybets-modal');
    if (modal) modal.classList.add('hidden');
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
// SOCKET — Live balance updates
// ============================================
socket.on('connect', () => {
    console.log('[Sports] Socket connected');
});

socket.on('balance_update', (balance) => {
    localStorage.setItem('betnova_balance', balance);
    const el = document.getElementById('balance-display');
    if (el) el.innerText = formatKES(balance);
});

// ============================================
// KEYBOARD SHORTCUTS
// ============================================
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        // Close modals and drawers
        document.getElementById('mybets-modal')?.classList.add('hidden');
        document.getElementById('sports-sidebar')?.classList.remove('mobile-open');
        document.getElementById('sidebar-overlay')?.classList.add('hidden');
        document.getElementById('betslip')?.classList.remove('mobile-open');
        document.getElementById('betslip-overlay')?.classList.add('hidden');
    }
});

// ============================================
// INIT
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    checkSession();
    loadSports();
    loadMatches();
    renderBetSlip();
    updateBetslipCount();

    // Periodic balance refresh
    setInterval(refreshBalance, 15000);

    // Auto-refresh matches every 60s
    setInterval(() => {
        if (!document.hidden) loadMatches();
    }, 60000);
});

// Cleanup on page hide
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
        refreshBalance();
        loadMatches();
    }
});
