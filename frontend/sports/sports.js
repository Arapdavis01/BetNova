// ============================================
// BetNova — Sports Betting Client
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
    transports: ['websocket', 'polling']
});

// ============================================
// STATE
// ============================================
let currentUser = null;
let currentSport = null;
let currentGroup = null;
let matches = [];
let betSlip = [];  // [{ matchExternalId, homeTeam, awayTeam, sportTitle, commenceTime, pick, odds }]

// ============================================
// UTILS
// ============================================
function formatKES(n) {
    return parseFloat(n || 0).toLocaleString('en-KE', {
        minimumFractionDigits: 2, maximumFractionDigits: 2
    });
}

let toastTimer = null;
function showToast(msg, type = 'info', duration = 3000) {
    const t = document.getElementById('toast');
    t.innerText = msg;
    t.className = `spo-toast ${type}`;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), duration);
}

function escapeHtml(t) {
    const d = document.createElement('div');
    d.textContent = t;
    return d.innerHTML;
}

function formatMatchTime(iso) {
    const d = new Date(iso);
    const today = new Date();
    const isToday = d.toDateString() === today.toDateString();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const isTomorrow = d.toDateString() === tomorrow.toDateString();

    const time = d.toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' });
    if (isToday) return `Today, ${time}`;
    if (isTomorrow) return `Tomorrow, ${time}`;
    return d.toLocaleDateString('en-KE', { day: '2-digit', month: 'short' }) + `, ${time}`;
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
        document.getElementById('balance-display').innerText = formatKES(balance || 0);
    } else {
        currentUser = null;
    }
}

// ============================================
// SPORTS LIST
// ============================================
async function loadSports() {
    try {
        const res = await fetch(`${API_BASE}/api/sports`);
        const sports = await res.json();

        const container = document.getElementById('sports-list');
        if (!Array.isArray(sports) || sports.length === 0) {
            container.innerHTML = '<div class="spo-loading">No sports available yet. Try again in a minute.</div>';
            return;
        }

        // Group by sport.group
        const grouped = {};
        sports.forEach(s => {
            if (!grouped[s.group]) grouped[s.group] = [];
            grouped[s.group].push(s);
        });

        let html = '';
        Object.keys(grouped).sort().forEach(group => {
            html += `<div class="spo-sport-group">`;
            html += `<div class="spo-sport-group-title">${escapeHtml(group)}</div>`;
            grouped[group].forEach(s => {
                html += `<button class="spo-sport-item" data-sport="${s.key}" data-group="${escapeHtml(s.group)}" data-title="${escapeHtml(s.title)}">
                    ${escapeHtml(s.title)}
                </button>`;
            });
            html += `</div>`;
        });

        container.innerHTML = html;

        // Attach handlers
        container.querySelectorAll('.spo-sport-item').forEach(btn => {
            btn.addEventListener('click', () => {
                container.querySelectorAll('.spo-sport-item').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                currentSport = btn.dataset.sport;
                currentGroup = btn.dataset.group;
                document.getElementById('matches-title').innerText = btn.dataset.title;
                loadMatches();
            });
        });

        // Auto-load first
        const firstBtn = container.querySelector('.spo-sport-item');
        if (firstBtn) firstBtn.click();
    } catch (err) {
        console.error('Sports load error:', err);
        document.getElementById('sports-list').innerHTML = '<div class="spo-loading">Failed to load sports.</div>';
    }
}

// ============================================
// MATCHES
// ============================================
async function loadMatches() {
    const container = document.getElementById('matches-list');
    container.innerHTML = '<div class="spo-loading">Loading matches...</div>';

    try {
        const params = new URLSearchParams();
        if (currentSport) params.set('sport', currentSport);
        else if (currentGroup) params.set('group', currentGroup);
        params.set('status', 'upcoming');
        params.set('limit', '100');

        const res = await fetch(`${API_BASE}/api/sports/matches?${params}`);
        const data = await res.json();

        matches = data.matches || [];

        if (matches.length === 0) {
            container.innerHTML = `
                <div class="spo-empty-state">
                    <i class="fa-solid fa-futbol"></i>
                    <p>No upcoming matches for this sport.</p>
                    <p style="font-size:11px;margin-top:6px;opacity:0.6">Matches are refreshed every 30 minutes.</p>
                </div>`;
            return;
        }

        container.innerHTML = matches.map(m => renderMatch(m)).join('');

        // Attach odd click handlers
        container.querySelectorAll('.spo-odd-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const externalId = btn.dataset.match;
                const pick = btn.dataset.pick;
                toggleSelection(externalId, pick);
            });
        });

        // Re-apply selected state for existing picks
        betSlip.forEach(sel => {
            const btn = container.querySelector(`.spo-odd-btn[data-match="${sel.matchExternalId}"][data-pick="${sel.pick}"]`);
            if (btn) btn.classList.add('selected');
        });
    } catch (err) {
        console.error('Matches load error:', err);
        container.innerHTML = '<div class="spo-loading">Failed to load matches.</div>';
    }
}

function renderMatch(m) {
    const home = m.odds.home || 0;
    const draw = m.odds.draw || 0;
    const away = m.odds.away || 0;

    return `
        <div class="spo-match" data-match="${m.externalId}">
            <div class="spo-match-info">
                <div class="spo-match-league">${escapeHtml(m.sportTitle)}</div>
                <div class="spo-match-teams">
                    <div class="spo-match-team">${escapeHtml(m.homeTeam)}</div>
                    <div class="spo-match-team">${escapeHtml(m.awayTeam)}</div>
                </div>
                <div class="spo-match-time">${formatMatchTime(m.commenceTime)}</div>
            </div>
            <div class="spo-odds-row">
                <button class="spo-odd-btn" data-match="${m.externalId}" data-pick="home" ${home ? '' : 'disabled'}>
                    <span class="spo-odd-label">1</span>
                    <span class="spo-odd-value">${home ? home.toFixed(2) : '—'}</span>
                </button>
                ${draw ? `
                <button class="spo-odd-btn" data-match="${m.externalId}" data-pick="draw">
                    <span class="spo-odd-label">X</span>
                    <span class="spo-odd-value">${draw.toFixed(2)}</span>
                </button>` : ''}
                <button class="spo-odd-btn" data-match="${m.externalId}" data-pick="away" ${away ? '' : 'disabled'}>
                    <span class="spo-odd-label">2</span>
                    <span class="spo-odd-value">${away ? away.toFixed(2) : '—'}</span>
                </button>
            </div>
        </div>
    `;
}

// ============================================
// BET SLIP
// ============================================
function toggleSelection(matchExternalId, pick) {
    const match = matches.find(m => m.externalId === matchExternalId);
    if (!match) return;

    const odds = match.odds[pick];
    if (!odds) return;

    // Remove if already exists with same match (allows switching picks)
    const existingIdx = betSlip.findIndex(s => s.matchExternalId === matchExternalId);

    if (existingIdx >= 0) {
        if (betSlip[existingIdx].pick === pick) {
            // Toggle off
            betSlip.splice(existingIdx, 1);
        } else {
            // Replace pick
            betSlip[existingIdx] = {
                matchExternalId,
                homeTeam: match.homeTeam,
                awayTeam: match.awayTeam,
                sportTitle: match.sportTitle,
                commenceTime: match.commenceTime,
                pick,
                odds
            };
        }
    } else {
        if (betSlip.length >= 20) {
            showToast('Maximum 20 selections per bet.', 'error');
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
    }

    renderBetSlip();
    refreshOddHighlights();
}

function renderBetSlip() {
    const body = document.getElementById('betslip-body');
    const footer = document.getElementById('betslip-footer');
    const count = document.getElementById('betslip-count');

    count.innerText = betSlip.length;

    if (betSlip.length === 0) {
        body.innerHTML = `
            <div class="spo-betslip-empty">
                <i class="fa-solid fa-ticket"></i>
                <p>Click on odds to add selections</p>
            </div>`;
        footer.style.display = 'none';
        return;
    }

    body.innerHTML = betSlip.map((s, i) => {
        const pickLabel = s.pick === 'home' ? '1' : s.pick === 'draw' ? 'X' : '2';
        return `
            <div class="spo-slip-item">
                <button class="spo-slip-item-remove" onclick="removeSelection(${i})" aria-label="Remove">&times;</button>
                <div class="spo-slip-teams">${escapeHtml(s.homeTeam)} vs ${escapeHtml(s.awayTeam)}</div>
                <div class="spo-slip-pick">
                    <span>${pickLabel}</span>
                    <span class="spo-slip-odds">${s.odds.toFixed(2)}</span>
                </div>
            </div>
        `;
    }).join('');

    footer.style.display = 'block';
    recalcBetSlip();
}

function removeSelection(index) {
    betSlip.splice(index, 1);
    renderBetSlip();
    refreshOddHighlights();
}

function clearBetSlip() {
    betSlip = [];
    renderBetSlip();
    refreshOddHighlights();
}

function refreshOddHighlights() {
    document.querySelectorAll('.spo-odd-btn').forEach(btn => btn.classList.remove('selected'));
    betSlip.forEach(sel => {
        const btn = document.querySelector(`.spo-odd-btn[data-match="${sel.matchExternalId}"][data-pick="${sel.pick}"]`);
        if (btn) btn.classList.add('selected');
    });
}

function recalcBetSlip() {
    const totalOdds = betSlip.reduce((acc, s) => acc * s.odds, 1);
    const stake = parseFloat(document.getElementById('betslip-stake').value) || 0;
    const payout = totalOdds * stake;

    document.getElementById('betslip-total-odds').innerText = totalOdds.toFixed(2);
    document.getElementById('betslip-payout').innerText = `KES ${formatKES(payout)}`;
}

function setStake(amount) {
    document.getElementById('betslip-stake').value = amount;
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

    const stake = parseFloat(document.getElementById('betslip-stake').value);
    if (!stake || stake < 10) return showToast('Minimum stake is KES 10', 'error');

    const balance = parseFloat(localStorage.getItem('betnova_balance') || 0);
    if (stake > balance) return showToast('Insufficient balance', 'error');

    const btn = document.getElementById('place-bet-btn');
    btn.disabled = true;
    btn.innerText = 'Placing...';

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
            showToast(data.error || 'Failed to place bet', 'error');
            return;
        }

        localStorage.setItem('betnova_balance', data.newBalance);
        document.getElementById('balance-display').innerText = formatKES(data.newBalance);

        showToast(`Bet placed! Odds: ${data.totalOdds}x · Payout: KES ${formatKES(data.potentialPayout)}`, 'success', 5000);
        clearBetSlip();
    } catch (err) {
        console.error('Place bet error:', err);
        showToast('Network error', 'error');
    } finally {
        btn.disabled = false;
        btn.innerText = 'Place Bet';
    }
}

// ============================================
// MY BETS
// ============================================
async function openMyBets() {
    if (!currentUser) return showToast('Sign in first', 'error');
    document.getElementById('mybets-modal').classList.remove('hidden');
    const list = document.getElementById('mybets-list');
    list.innerHTML = 'Loading...';

    try {
        const res = await fetch(`${API_BASE}/api/sports/bets/${currentUser.userId}`);
        const data = await res.json();

        if (!data.bets || data.bets.length === 0) {
            list.innerHTML = '<p style="text-align:center;padding:20px;color:#6b7280">No bets yet</p>';
            return;
        }

        list.innerHTML = data.bets.map(b => renderMyBet(b)).join('');
    } catch (err) {
        list.innerHTML = '<p style="color:#ef4444;text-align:center">Failed to load</p>';
    }
}

function closeMyBets() {
    document.getElementById('mybets-modal').classList.add('hidden');
}

function renderMyBet(b) {
    const pickLabel = p => p === 'home' ? '1' : p === 'draw' ? 'X' : '2';
    return `
        <div class="spo-mybets-item">
            <div class="spo-mybets-header">
                <span class="spo-mybets-status ${b.status}">${b.status}</span>
                <span class="spo-mybets-odds">${b.totalOdds.toFixed(2)}x</span>
            </div>
            <div class="spo-mybets-selections">
                ${b.selections.map(s => `
                    <div>${pickLabel(s.pick)} · ${escapeHtml(s.homeTeam)} vs ${escapeHtml(s.awayTeam)}
                        <span style="color:${s.result === 'won' ? '#00c853' : s.result === 'lost' ? '#ef4444' : '#94a3b8'}">[${s.result}]</span>
                    </div>
                `).join('')}
            </div>
            <div class="spo-mybets-footer">
                <span>Stake: <strong>KES ${formatKES(b.stake)}</strong></span>
                <span>Payout: <strong style="color:#00c853">KES ${formatKES(b.actualPayout || b.potentialPayout)}</strong></span>
            </div>
        </div>
    `;
}

// ============================================
// MOBILE BET SLIP DRAWER
// ============================================
document.getElementById('betslip')?.addEventListener('click', (e) => {
    if (window.innerWidth > 900) return;
    const header = e.target.closest('.spo-betslip-header');
    if (header) {
        document.getElementById('betslip').classList.toggle('open');
    }
});

// ============================================
// SOCKET — balance updates
// ============================================
socket.on('balance_update', (balance) => {
    localStorage.setItem('betnova_balance', balance);
    const el = document.getElementById('balance-display');
    if (el) el.innerText = formatKES(balance);
});

// ============================================
// INIT
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    checkSession();
    loadSports();
    renderBetSlip();

    // Auto-refresh matches every 60 seconds
    setInterval(() => {
        if (currentSport) loadMatches();
    }, 60000);
});
