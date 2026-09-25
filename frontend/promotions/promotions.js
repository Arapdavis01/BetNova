// ============================================
// BetNova — Promotions & Jackpots Client
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

let currentUser = null;
let jackpotTimers = [];

// ============================================
// UTILS
// ============================================
function formatKES(n) {
    return parseFloat(n || 0).toLocaleString('en-KE', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 0
    });
}

function escapeHtml(t) {
    const d = document.createElement('div');
    d.textContent = t || '';
    return d.innerHTML;
}

let toastTimer = null;
function showToast(msg, type = 'info', duration = 3500) {
    const t = document.getElementById('toast');
    t.innerText = msg;
    t.className = `promo-toast ${type}`;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), duration);
}

// ============================================
// SESSION
// ============================================
function checkSession() {
    const user = localStorage.getItem('betnova_user');
    const userId = localStorage.getItem('betnova_userid');
    const balance = localStorage.getItem('betnova_balance');

    if (!user || !userId) {
        showToast('Sign in to access promotions', 'error');
        setTimeout(() => location.href = '/', 1500);
        return false;
    }

    currentUser = { userId, username: user };
    document.getElementById('balance-display').innerText = formatKES(balance || 0);
    return true;
}

// ============================================
// JACKPOTS
// ============================================
async function loadJackpots() {
    const container = document.getElementById('jackpots-list');
    container.innerHTML = '<div class="promo-loading">Loading jackpots...</div>';

    try {
        const res = await fetch(`${API_BASE}/api/promotions/jackpots`);
        const data = await res.json();

        if (!data.jackpots || data.jackpots.length === 0) {
            container.innerHTML = '<div class="promo-loading">No jackpots active yet. Check back soon!</div>';
            return;
        }

        // Clear existing timers
        jackpotTimers.forEach(t => clearInterval(t));
        jackpotTimers = [];

        container.innerHTML = data.jackpots.map(j => renderJackpotCard(j)).join('');

        // Start countdown timers
        data.jackpots.forEach(j => {
            if (j.nextDrawAt) startJackpotTimer(j.key, new Date(j.nextDrawAt));
        });
    } catch (err) {
        console.error('Jackpots error:', err);
        container.innerHTML = '<div class="promo-loading">Failed to load jackpots</div>';
    }
}

function renderJackpotCard(j) {
    const lastWinner = j.lastWinner
        ? `<div class="promo-jackpot-last-winner">
             Last winner: <strong>${escapeHtml(j.lastWinner.username)}</strong>
             — KES ${formatKES(j.lastWinner.amount)}
           </div>`
        : '';

    return `
        <div class="promo-jackpot-card ${escapeHtml(j.key)}">
            <div class="promo-jackpot-name">${escapeHtml(j.name)}</div>
            <div class="promo-jackpot-amount">KES ${formatKES(j.currentPool)}</div>
            <div class="promo-jackpot-meta">
                <span>${j.contributionPercent}% of bets</span>
                <span>${j.drawCount || 0} draws</span>
            </div>
            <div class="promo-jackpot-timer" id="timer-${escapeHtml(j.key)}">
                Next draw: computing...
            </div>
            ${lastWinner}
        </div>
    `;
}

function startJackpotTimer(key, targetDate) {
    const el = document.getElementById(`timer-${key}`);
    if (!el) return;

    function update() {
        const now = Date.now();
        const diff = targetDate.getTime() - now;

        if (diff <= 0) {
            el.innerText = 'Drawing now...';
            return;
        }

        const hours = Math.floor(diff / (1000 * 60 * 60));
        const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
        const seconds = Math.floor((diff % (1000 * 60)) / 1000);

        el.innerText = `Next draw: ${hours}h ${minutes}m ${seconds}s`;
    }

    update();
    const timerId = setInterval(update, 1000);
    jackpotTimers.push(timerId);
}

// ============================================
// PROMO CODE REDEMPTION
// ============================================
async function redeemPromoCode() {
    const input = document.getElementById('promo-code-input');
    const btn = document.getElementById('redeem-btn');
    const resultEl = document.getElementById('redeem-result');
    const code = input.value.trim().toUpperCase();

    if (!code) {
        return showToast('Enter a promo code', 'error');
    }

    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Redeeming...';
    resultEl.classList.add('hidden');

    try {
        const res = await fetch(`${API_BASE}/api/promotions/redeem`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, userId: currentUser.userId })
        });
        const data = await res.json();

        if (!res.ok) {
            resultEl.className = 'promo-redeem-result error';
            resultEl.innerText = data.error || 'Failed to redeem code';
            resultEl.classList.remove('hidden');
            return;
        }

        resultEl.className = 'promo-redeem-result success';
        resultEl.innerText = `✓ ${data.message} New bonus balance: KES ${formatKES(data.newBonusBalance)}`;
        resultEl.classList.remove('hidden');
        input.value = '';

        showToast(data.message, 'success', 5000);
        loadRedemptions();
    } catch (err) {
        resultEl.className = 'promo-redeem-result error';
        resultEl.innerText = 'Network error';
        resultEl.classList.remove('hidden');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-gift"></i> Redeem';
    }
}

// ============================================
// ACTIVE PROMOTIONS
// ============================================
async function loadActivePromotions() {
    const container = document.getElementById('active-promotions');
    container.innerHTML = '<div class="promo-loading">Loading promotions...</div>';

    try {
        const res = await fetch(`${API_BASE}/api/promotions/active`);
        const data = await res.json();

        if (!data.promotions || data.promotions.length === 0) {
            container.innerHTML = '<div class="promo-loading">No active promotions right now</div>';
            return;
        }

        container.innerHTML = data.promotions.map(p => renderPromoCard(p)).join('');
    } catch (err) {
        container.innerHTML = '<div class="promo-loading">Failed to load promotions</div>';
    }
}

function renderPromoCard(p) {
    const typeLabels = {
        fixed_bonus: 'Fixed Bonus',
        deposit_match: 'Deposit Match',
        free_bet: 'Free Bet'
    };

    let valueDisplay = '';
    if (p.type === 'fixed_bonus' || p.type === 'free_bet') {
        valueDisplay = `KES ${formatKES(p.amount)}`;
    } else if (p.type === 'deposit_match') {
        valueDisplay = `${Math.round(p.amount * 100)}% Match`;
    }

    const validity = p.validUntil
        ? `Expires ${new Date(p.validUntil).toLocaleDateString()}`
        : 'No expiry';

    return `
        <div class="promo-card">
            <span class="promo-type">${typeLabels[p.type] || p.type}</span>
            <h3>${escapeHtml(p.title)}</h3>
            <div class="promo-value">${valueDisplay}</div>
            <p class="promo-desc">${escapeHtml(p.description || '')}</p>
            <div class="promo-validity">${validity}</div>
        </div>
    `;
}

// ============================================
// REDEMPTION HISTORY
// ============================================
async function loadRedemptions() {
    const container = document.getElementById('my-redemptions');
    container.innerHTML = '<div class="promo-loading">Loading...</div>';

    try {
        const res = await fetch(`${API_BASE}/api/promotions/my-redemptions/${currentUser.userId}`);
        const data = await res.json();

        if (!data.redemptions || data.redemptions.length === 0) {
            container.innerHTML = '<div class="promo-loading">No redemptions yet</div>';
            return;
        }

        container.innerHTML = data.redemptions.map(r => `
            <div class="promo-redemption-item">
                <div class="promo-redemption-info">
                    <span class="promo-redemption-code">${escapeHtml(r.promoCode)}</span>
                    <span class="promo-redemption-time">${new Date(r.createdAt).toLocaleString('en-KE')}</span>
                </div>
                <div class="promo-redemption-amount">+KES ${formatKES(r.bonusAmount)}</div>
            </div>
        `).join('');
    } catch (err) {
        container.innerHTML = '<div class="promo-loading">Failed to load</div>';
    }
}

// ============================================
// SOCKET — REAL-TIME JACKPOT
// ============================================
socket.on('jackpot_won', (data) => {
    showToast(
        `🎉 ${data.winner} won the ${data.jackpotName} — KES ${formatKES(data.amount)}!`,
        'success',
        8000
    );
    loadJackpots();
});

socket.on('balance_update', (balance) => {
    localStorage.setItem('betnova_balance', balance);
    document.getElementById('balance-display').innerText = formatKES(balance);
});

// ============================================
// INIT
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    if (!checkSession()) return;

    loadJackpots();
    loadActivePromotions();
    loadRedemptions();

    // Handle Enter key on promo code input
    const input = document.getElementById('promo-code-input');
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') redeemPromoCode();
    });

    // Refresh every 60 seconds
    setInterval(loadJackpots, 60000);
});
