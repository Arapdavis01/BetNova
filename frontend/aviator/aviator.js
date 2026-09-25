// ============================================
// BetNova — Aviator Client
// Handles: dual bet panels, all-bets feed, chat, provably fair
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
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000
});

// ============================================
// STATE
// ============================================
let currentUser = null;
let myBets = { 1: null, 2: null };  // { amount, cashedOut, cashoutMultiplier }
let lastStatus = null;
let currentCommit = null;
let lastTimerTick = null;
let autoBetEnabled = { 1: false, 2: false };

// ============================================
// CANVAS
// ============================================
const canvas = document.getElementById('avi-canvas');
const ctx = canvas ? canvas.getContext('2d') : null;
let W = 0, H = 0;

function resizeCanvas() {
    if (!canvas || !ctx) return;
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = W * window.devicePixelRatio;
    canvas.height = H * window.devicePixelRatio;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
}
window.addEventListener('resize', resizeCanvas);
window.addEventListener('orientationchange', () => {
    setTimeout(resizeCanvas, 100);
});

// ============================================
// SOUND MANAGER
// ============================================
const sounds = {
    cashout: new Audio('/sounds/cashout.mp3'),
    crash: new Audio('/sounds/crash.mp3'),
    tick: new Audio('/sounds/tick.mp3'),
    placeBet: new Audio('/sounds/place-bet.mp3')
};
Object.values(sounds).forEach(a => {
    a.preload = 'auto';
    a.volume = 0.5;
});
let soundEnabled = localStorage.getItem('betnova_sound') !== 'off';

function playSound(name) {
    if (!soundEnabled) return;
    const s = sounds[name];
    if (!s) return;
    try {
        s.currentTime = 0;
        s.play().catch(() => {});
    } catch (_) {}
}

function toggleSound() {
    soundEnabled = !soundEnabled;
    localStorage.setItem('betnova_sound', soundEnabled ? 'on' : 'off');
    const btn = document.getElementById('sound-toggle');
    if (btn) {
        btn.innerHTML = soundEnabled
            ? '<i class="fa-solid fa-volume-high"></i>'
            : '<i class="fa-solid fa-volume-xmark"></i>';
        btn.classList.toggle('muted', !soundEnabled);
    }
}

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
    t.className = `avi-toast ${type}`;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), duration);
}

// ============================================
// SESSION (lenient — no token required)
// ============================================
function checkSession() {
    const user = localStorage.getItem('betnova_user');
    const userId = localStorage.getItem('betnova_userid');
    const balance = localStorage.getItem('betnova_balance');

    if (user && userId) {
        currentUser = { userId, username: user };

        // Hide the lock overlay
        const lock = document.getElementById('game-lock');
        if (lock) lock.classList.add('hidden');

        // Update balance display
        const balEl = document.getElementById('balance-display');
        if (balEl) balEl.innerText = formatKES(balance || 0);

        // Update profile modal
        const profileName = document.getElementById('profile-name');
        if (profileName) profileName.innerText = user;

        // Refresh from server + join chat
        refreshBalance();
        socket.emit('chat_join', { username: user });
    } else {
        currentUser = null;
        const lock = document.getElementById('game-lock');
        if (lock) lock.classList.remove('hidden');
    }
    updateActionButton(1);
    updateActionButton(2);
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

function handleLogout() {
    localStorage.clear();
    location.href = '/';
}

// ============================================
// MODALS
// ============================================
function openModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.remove('hidden');
}
function closeModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
}

document.addEventListener('click', (e) => {
    if (e.target.classList && e.target.classList.contains('avi-modal')) {
        e.target.classList.add('hidden');
    }
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        document.querySelectorAll('.avi-modal:not(.hidden)').forEach(m => m.classList.add('hidden'));
    }
});

// ============================================
// BET PANEL CONTROLS
// ============================================
function setStake(panel, amount) {
    const input = document.getElementById(`stake-${panel}`);
    if (input) input.value = amount;
    updateActionButton(panel);
}

function adjustStake(panel, delta) {
    const input = document.getElementById(`stake-${panel}`);
    if (!input) return;
    const val = Math.max(10, (parseFloat(input.value) || 10) + delta);
    input.value = val;
    updateActionButton(panel);
}

function toggleAutoBet(panel) {
    autoBetEnabled[panel] = !autoBetEnabled[panel];
    const toggle = document.querySelector(`[data-panel="${panel}"][data-auto="true"] .avi-toggle`);
    if (toggle) toggle.classList.toggle('on', autoBetEnabled[panel]);
}

// Tab switching (Bet / Auto) inside each panel
document.querySelectorAll('.avi-bet-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        const panel = tab.dataset.panel;
        const mode = tab.dataset.mode;

        // Toggle active on tab
        const parent = tab.parentElement;
        if (parent) {
            parent.querySelectorAll('.avi-bet-tab').forEach(t => t.classList.remove('active'));
        }
        tab.classList.add('active');

        // Show correct body
        const panelEl = document.getElementById(`bet-panel-${panel}`);
        if (!panelEl) return;
        panelEl.querySelectorAll('.avi-bet-body').forEach(body => {
            const isAuto = body.dataset.auto === 'true';
            const shouldShow = (mode === 'auto' && isAuto) || (mode === 'bet' && !isAuto);
            body.classList.toggle('hidden', !shouldShow);
        });
    });
});

// Update button label based on state
function updateActionButton(panel) {
    const btn = document.getElementById(`action-${panel}`);
    const btnAuto = document.getElementById(`action-${panel}-auto`);
    const stakeInput = document.getElementById(`stake-${panel}`);
    if (!btn || !stakeInput) return;

    const stake = parseFloat(stakeInput.value) || 0;
    const bet = myBets[panel];

    // If in flight and we have an active bet that hasn't cashed out
    if (lastStatus && lastStatus.status === 'FLYING' && bet && !bet.cashedOut) {
        const payout = (bet.amount * lastStatus.multiplier).toFixed(2);
        const title = 'CASH OUT';
        const subtext = `KES ${formatKES(payout)}`;

        applyButtonState(btn, 'avi-action-cashout', false, title, subtext);
        if (btnAuto) applyButtonState(btnAuto, 'avi-action-cashout', false, title, subtext);
        return;
    }

    // If we have a bet in this round (placed or cashed)
    if (bet && (bet.cashedOut || (lastStatus && lastStatus.status !== 'CRASHED'))) {
        const title = bet.cashedOut ? 'CASHED OUT' : 'BET PLACED';
        const subtext = bet.cashedOut
            ? `@ ${bet.cashoutMultiplier.toFixed(2)}x`
            : `KES ${formatKES(bet.amount)}`;

        applyButtonState(btn, 'avi-action-waiting', true, title, subtext);
        if (btnAuto) applyButtonState(btnAuto, 'avi-action-waiting', true, title, subtext);
        return;
    }

    // Default: ready to bet
    const title = 'BET';
    const subtext = `KES ${formatKES(stake)}`;
    const canBet = lastStatus && lastStatus.status === 'WAITING';

    applyButtonState(btn, 'avi-action-bet', !canBet, title, subtext);
    if (btnAuto) applyButtonState(btnAuto, 'avi-action-bet', !canBet, title, subtext);
}

function applyButtonState(btn, className, disabled, title, subtext) {
    // Update class
    btn.className = `avi-action-btn ${className}`;
    btn.disabled = disabled;

    // Update inner text — preserve two-line structure if present
    const titleEl = btn.querySelector('.avi-btn-title');
    const subtextEl = btn.querySelector('.avi-btn-subtext');

    if (titleEl && subtextEl) {
        titleEl.innerText = title;
        subtextEl.innerText = subtext;
    } else {
        // Fallback for old markup
        btn.innerText = subtext ? `${title} ${subtext}` : title;
    }
}

// Watch stake input changes
[1, 2].forEach(panel => {
    const el = document.getElementById(`stake-${panel}`);
    if (el) el.addEventListener('input', () => updateActionButton(panel));
});

// ============================================
// BET ACTIONS
// ============================================
function handleBetAction(panel) {
    if (!currentUser) {
        showToast('Sign in to place bets', 'error');
        return;
    }

    const bet = myBets[panel];
    const isFlying = lastStatus && lastStatus.status === 'FLYING';

    // Cash out
    if (isFlying && bet && !bet.cashedOut) {
        socket.emit('cash_out', { panel });
        return;
    }

    // Place bet
    if (!lastStatus || lastStatus.status !== 'WAITING') {
        showToast('Round in progress — wait for next', 'error');
        return;
    }
    if (bet) {
        showToast('Bet already placed on this panel', 'error');
        return;
    }

    const stakeInput = document.getElementById(`stake-${panel}`);
    const amount = parseFloat(stakeInput.value);
    if (!amount || amount < 10) {
        showToast('Minimum bet is KES 10', 'error');
        return;
    }

    const autoEl = document.getElementById(`auto-cashout-${panel}`);
    const autoCashout = autoEl ? parseFloat(autoEl.value) : NaN;

    socket.emit('place_bet', {
        userId: currentUser.userId,
        amount,
        panel,
        autoCashout: autoCashout >= 1.01 ? autoCashout : null
    });
}

// ============================================
// SOCKET — CONNECTION
// ============================================
socket.on('connect', () => {
    console.log('[Aviator] Socket connected:', socket.id);
    if (currentUser) {
        socket.emit('chat_join', { username: currentUser.username });
    }
});

socket.on('disconnect', (reason) => {
    console.log('[Aviator] Socket disconnected:', reason);
});

socket.on('reconnect', () => {
    console.log('[Aviator] Socket reconnected');
    refreshBalance();
});

// ============================================
// SOCKET — GAME TICK
// ============================================
socket.on('betnova_tick', (state) => {
    lastStatus = state;

    const multiplierEl = document.getElementById('multiplier');
    const statusBadge = document.getElementById('status-badge');

    if (state.status === 'WAITING') {
        if (multiplierEl) {
            multiplierEl.innerHTML = `${state.timer}<span>s</span>`;
            multiplierEl.style.color = '#fbbf24';
            multiplierEl.classList.remove('crashed');
        }
        if (statusBadge) statusBadge.innerText = 'Waiting for next round...';
        clearCanvas();

        // Tick sound in last 3 seconds
        if (state.timer !== lastTimerTick && state.timer >= 0 && state.timer <= 3) {
            playSound('tick');
            lastTimerTick = state.timer;
        }
    }
    else if (state.status === 'FLYING') {
        if (multiplierEl) {
            multiplierEl.innerHTML = `${state.multiplier.toFixed(2)}<span>x</span>`;
            multiplierEl.style.color = '#ffffff';
            multiplierEl.classList.remove('crashed');
        }
        if (statusBadge) statusBadge.innerText = 'In flight — cash out before crash';
        drawCurve(state.multiplier);

        // Auto-cashout check
        [1, 2].forEach(panel => {
            const bet = myBets[panel];
            if (bet && !bet.cashedOut) {
                const autoEl = document.getElementById(`auto-cashout-${panel}`);
                const target = autoEl ? parseFloat(autoEl.value) : NaN;
                if (target >= 1.01 && state.multiplier >= target) {
                    socket.emit('cash_out', { panel });
                }
            }
        });
    }
    else if (state.status === 'CRASHED') {
        if (multiplierEl) {
            multiplierEl.innerHTML = `${state.multiplier.toFixed(2)}<span>x</span>`;
            multiplierEl.style.color = '#ef4444';
            multiplierEl.classList.add('crashed');
        }
        if (statusBadge) statusBadge.innerText = 'FLEW AWAY!';
        drawCurve(1, true);
    }

    updateActionButton(1);
    updateActionButton(2);
});

// ============================================
// SOCKET — BALANCE UPDATE
// ============================================
socket.on('balance_update', (balance) => {
    localStorage.setItem('betnova_balance', balance);
    const el = document.getElementById('balance-display');
    if (el) el.innerText = formatKES(balance);
});

// ============================================
// SOCKET — BET EVENTS
// ============================================
socket.on('bet_placed', ({ amount, panel }) => {
    myBets[panel] = { amount, cashedOut: false, cashoutMultiplier: null };
    playSound('placeBet');
    showToast(`Bet placed: KES ${formatKES(amount)}`, 'success');
    updateActionButton(panel);
});

socket.on('bet_cashed', ({ payout, multiplier, panel, auto }) => {
    if (myBets[panel]) {
        myBets[panel].cashedOut = true;
        myBets[panel].cashoutMultiplier = multiplier;
    }
    playSound('cashout');
    showToast(
        `${auto ? 'AUTO ' : ''}Cashed out @ ${multiplier.toFixed(2)}x — KES ${formatKES(payout)}`,
        'success',
        4000
    );
    updateActionButton(panel);
});

socket.on('bet_lost', ({ amount, panel }) => {
    playSound('crash');
    showToast(`Lost KES ${formatKES(amount)}`, 'error');
    myBets[panel] = null;
    updateActionButton(panel);
});

socket.on('bet_error', (msg) => {
    showToast(msg, 'error');
});

// ============================================
// SOCKET — ALL BETS FEED
// ============================================
socket.on('all_bets_update', (bets) => {
    const list = document.getElementById('bets-list');
    const countEl = document.getElementById('bets-count');
    if (!list) return;

    if (countEl) countEl.innerText = bets.length;

    if (bets.length === 0) {
        list.innerHTML = `
            <div class="avi-empty-state">
                <i class="fa-solid fa-plane-circle-check"></i>
                <span>Waiting for players...</span>
            </div>
        `;
        return;
    }

    list.innerHTML = bets.map(b => {
        const color = b.avatarColor || '#ef4444';
        const initial = (b.username || '?').charAt(0).toUpperCase();
        const winAmount = b.cashedOut
            ? formatKES(b.amount * b.cashoutMultiplier)
            : '—';
        const multi = b.cashedOut ? `${b.cashoutMultiplier.toFixed(2)}x` : '—';

        return `
            <div class="avi-bet-row ${b.cashedOut ? 'won' : ''}">
                <div class="avi-bet-avatar" style="background: ${color}">${initial}</div>
                <div class="avi-bet-username">${escapeHtml(b.username)}</div>
                <div class="avi-bet-amount">${formatKES(b.amount)}</div>
                <div class="avi-bet-multi">${multi}</div>
                <div class="avi-bet-win">${winAmount}</div>
            </div>
        `;
    }).join('');
});

// ============================================
// SOCKET — CRASH HISTORY
// ============================================
socket.on('crash_history', (history) => {
    const strip = document.getElementById('history-strip');
    if (!strip) return;

    if (!history || history.length === 0) {
        strip.innerHTML = '';
        return;
    }

    strip.innerHTML = history.slice(0, 20).map(v => {
        const cls = v >= 10 ? 'high' : v >= 2 ? 'mid' : 'low';
        return `<span class="avi-history-chip ${cls}">${v.toFixed(2)}x</span>`;
    }).join('');
});

// ============================================
// SOCKET — PROVABLY FAIR
// ============================================
socket.on('round_commit', (data) => {
    currentCommit = data;

    const roundEl = document.getElementById('pf-round');
    const hashEl = document.getElementById('pf-hash');
    const seedEl = document.getElementById('pf-seed');
    const crashEl = document.getElementById('pf-crash');
    const resultEl = document.getElementById('pf-result');
    const roundTagEl = document.getElementById('avi-round-id');

    if (roundEl) roundEl.innerText = `#${data.roundId}`;
    if (hashEl) hashEl.innerText = data.serverSeedHash;
    if (seedEl) seedEl.innerText = 'Waiting for reveal...';
    if (crashEl) crashEl.innerText = '—';
    if (roundTagEl) roundTagEl.innerText = data.roundId;
    if (resultEl) {
        resultEl.className = 'avi-fairness-result';
        resultEl.style.color = '';
        resultEl.innerText = 'Round in progress. Seed will be revealed after crash.';
    }
});

socket.on('round_reveal', async (data) => {
    const seedEl = document.getElementById('pf-seed');
    const crashEl = document.getElementById('pf-crash');
    const resultEl = document.getElementById('pf-result');

    if (seedEl) seedEl.innerText = data.serverSeed;
    if (crashEl) crashEl.innerText = `${data.crashPoint.toFixed(2)}x`;

    if (currentCommit && currentCommit.roundId === data.roundId) {
        const hashValid = await verifySeed(data.serverSeed, currentCommit.serverSeedHash);
        const recomputed = await recomputeCrash(data.serverSeed, data.roundId);
        const crashValid = Math.abs(recomputed - data.crashPoint) < 0.01;

        if (resultEl) {
            if (hashValid && crashValid) {
                resultEl.className = 'avi-fairness-result';
                resultEl.style.color = '#00c853';
                resultEl.innerText = '✓ Verified — hash matches, crash reproduces correctly';
            } else {
                resultEl.className = 'avi-fairness-result';
                resultEl.style.color = '#ef4444';
                resultEl.innerText = `✗ Verification failed (hash=${hashValid}, crash=${crashValid})`;
            }
        }
    }
});

// Client-side SHA-256 verification
async function verifySeed(seed, expected) {
    try {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed));
        const hex = Array.from(new Uint8Array(buf))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
        return hex === expected;
    } catch (_) {
        return false;
    }
}

// Client-side HMAC-SHA256 crash reproduction
async function recomputeCrash(seed, roundId) {
    try {
        const key = await crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode(seed),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign']
        );
        const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(roundId.toString()));
        const hex = Array.from(new Uint8Array(sig))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
        const int = parseInt(hex.slice(0, 8), 16);
        const float = int / 0xFFFFFFFF;
        if (float < 0.03) return 1.00;
        return parseFloat(Math.min(1.01 / (1 - float), 1000).toFixed(2));
    } catch (_) {
        return 0;
    }
}

// ============================================
// SOCKET — CHAT
// ============================================
function sendChat() {
    if (!currentUser) {
        showToast('Sign in to chat', 'error');
        return;
    }
    const input = document.getElementById('chat-input');
    if (!input) return;
    const message = input.value.trim();
    if (!message) return;

    socket.emit('chat_message', {
        userId: currentUser.userId,
        username: currentUser.username,
        message
    });
    input.value = '';
}

function renderChatMessage(msg) {
    const box = document.getElementById('chat-messages');
    if (!box) return;

    const empty = box.querySelector('.avi-chat-empty');
    if (empty) empty.remove();

    const el = document.createElement('div');
    el.className = 'avi-chat-msg';
    const time = new Date(msg.createdAt).toLocaleTimeString('en-KE', {
        hour: '2-digit', minute: '2-digit'
    });
    el.innerHTML = `
        <span class="avi-chat-user">${escapeHtml(msg.username)}</span>
        <span class="avi-chat-time">${time}</span>
        <div class="avi-chat-text">${escapeHtml(msg.message)}</div>
    `;
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;

    while (box.children.length > 100) {
        box.removeChild(box.firstChild);
    }
}

socket.on('chat_history', (messages) => {
    const box = document.getElementById('chat-messages');
    if (!box) return;

    box.innerHTML = '';
    if (!messages || messages.length === 0) {
        box.innerHTML = `
            <div class="avi-chat-empty">
                <i class="fa-solid fa-comments"></i>
                <span>Be the first to say something</span>
            </div>
        `;
        return;
    }
    messages.forEach(renderChatMessage);
});

socket.on('chat_message', renderChatMessage);

socket.on('chat_online', (count) => {
    const el = document.getElementById('chat-online');
    if (el) el.innerText = count;
});

function toggleChat() {
    const panel = document.getElementById('chat-panel');
    if (panel) panel.classList.toggle('mobile-open');
}

// ============================================
// PAYHERO — DEPOSIT
// ============================================
async function handleDeposit() {
    if (!currentUser) return showToast('Sign in first', 'error');
    const amountEl = document.getElementById('deposit-amount');
    const phoneEl = document.getElementById('deposit-phone');
    if (!amountEl || !phoneEl) return;

    const amount = parseFloat(amountEl.value);
    const phone = phoneEl.value.trim();
    if (!amount || amount < 10) return showToast('Minimum KES 10', 'error');
    if (!phone) return showToast('Enter M-Pesa number', 'error');

    const btn = event && event.target ? event.target : null;
    if (btn) {
        btn.disabled = true;
        btn.innerText = 'Sending...';
    }

    try {
        const res = await fetch(`${API_BASE}/api/payhero/deposit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser.userId, amount, phoneNumber: phone })
        });
        const data = await res.json();
        if (!res.ok) return showToast(data.error || 'Deposit failed', 'error');
        showToast('Check your phone for PIN prompt', 'success', 5000);
        closeModal('deposit-modal');
        setTimeout(refreshBalance, 8000);
    } catch (e) {
        showToast('Network error', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-bolt"></i> Send M-Pesa Request';
        }
    }
}

// ============================================
// PAYHERO — WITHDRAW
// ============================================
async function handleWithdraw() {
    if (!currentUser) return showToast('Sign in first', 'error');
    const amountEl = document.getElementById('withdraw-amount');
    const phoneEl = document.getElementById('withdraw-phone');
    if (!amountEl || !phoneEl) return;

    const amount = parseFloat(amountEl.value);
    const phone = phoneEl.value.trim();
    if (!amount || amount < 50) return showToast('Minimum KES 50', 'error');
    if (!phone) return showToast('Enter M-Pesa number', 'error');

    const btn = event && event.target ? event.target : null;
    if (btn) {
        btn.disabled = true;
        btn.innerText = 'Processing...';
    }

    try {
        const res = await fetch(`${API_BASE}/api/payhero/withdraw`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser.userId, amount, phoneNumber: phone })
        });
        const data = await res.json();

        if (!res.ok) {
            if (data.code === 'KYC_REQUIRED') {
                showToast('Verify your email in Cashier first', 'error', 5000);
                closeModal('withdraw-modal');
                setTimeout(() => location.href = '/cashier#kyc', 1500);
                return;
            }
            if (data.code === 'WAGERING_REQUIRED') {
                showToast(data.error, 'error', 5000);
                return;
            }
            return showToast(data.error || 'Withdrawal failed', 'error');
        }

        showToast('Withdrawal sent to M-Pesa', 'success', 5000);
        closeModal('withdraw-modal');
        setTimeout(refreshBalance, 3000);
    } catch (e) {
        showToast('Network error', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-money-bill-transfer"></i> Withdraw to M-Pesa';
        }
    }
}

// ============================================
// BET HISTORY
// ============================================
async function loadHistory() {
    if (!currentUser) return;
    const list = document.getElementById('history-list');
    if (!list) return;

    list.innerHTML = '<p style="text-align:center;color:#6b7280;padding:20px;">Loading...</p>';

    try {
        const res = await fetch(`${API_BASE}/api/bets/user/${currentUser.userId}?limit=20`);
        const data = await res.json();

        if (!data.bets || data.bets.length === 0) {
            list.innerHTML = '<p style="text-align:center;color:#6b7280;padding:20px;">No bets yet</p>';
            return;
        }

        list.innerHTML = data.bets.map(b => {
            const win = b.cashedOut;
            const profit = b.profit >= 0
                ? `+KES ${formatKES(b.profit)}`
                : `KES ${formatKES(b.profit)}`;
            const time = new Date(b.createdAt).toLocaleTimeString('en-KE', {
                hour: '2-digit', minute: '2-digit'
            });
            return `
                <div style="display:grid;grid-template-columns:70px 1fr 70px 100px;gap:8px;padding:8px;border-bottom:1px solid rgba(255,255,255,0.05);align-items:center;font-size:12px;">
                    <span style="color:#6b7280;font-family:monospace">${time}</span>
                    <span>KES ${formatKES(b.amount)}</span>
                    <span style="color:#fbbf24;font-family:monospace">
                        ${win ? b.cashoutMultiplier.toFixed(2) + 'x' : '—'}
                    </span>
                    <span style="color:${b.profit >= 0 ? '#00c853' : '#ef4444'};font-weight:700;text-align:right;font-family:monospace">
                        ${profit}
                    </span>
                </div>
            `;
        }).join('');
    } catch (err) {
        list.innerHTML = '<p style="color:#ef4444;text-align:center">Failed to load</p>';
    }
}

// ============================================
// CANVAS DRAWING
// ============================================
function clearCanvas() {
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
}

function drawCurve(progress, crashed = false) {
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);

    const startX = 60;
    const startY = H - 40;
    const maxX = W - 60;
    const maxY = 60;

    // Grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 6; i++) {
        const y = startY - (startY - maxY) * (i / 6);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
    }

    // Build curve points
    const points = [];
    const steps = Math.max(2, Math.floor(progress * 100));
    for (let i = 0; i <= steps; i++) {
        const step = i / 100;
        const x = startX + (maxX - startX) * step;
        const y = startY - (startY - maxY) * Math.pow(step, 1.6);
        points.push({ x, y });
    }

    if (points.length > 1) {
        // Gradient fill under curve
        const gradient = ctx.createLinearGradient(0, startY, 0, maxY);
        if (crashed) {
            gradient.addColorStop(0, 'rgba(239, 68, 68, 0.35)');
            gradient.addColorStop(1, 'rgba(239, 68, 68, 0)');
        } else {
            gradient.addColorStop(0, 'rgba(255, 45, 85, 0.3)');
            gradient.addColorStop(1, 'rgba(255, 45, 85, 0)');
        }
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        points.forEach(p => ctx.lineTo(p.x, p.y));
        ctx.lineTo(points[points.length - 1].x, startY);
        ctx.closePath();
        ctx.fill();

        // Glowing path line
        ctx.beginPath();
        ctx.strokeStyle = crashed ? '#ef4444' : '#ff2d55';
        ctx.lineWidth = 3;
        ctx.shadowBlur = 20;
        ctx.shadowColor = crashed
            ? 'rgba(239, 68, 68, 0.9)'
            : 'rgba(255, 45, 85, 0.8)';
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        points.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
        ctx.stroke();
        ctx.shadowBlur = 0;
    }

    // Plane at the head
    const head = points[points.length - 1];
    if (head) {
        // Particle trail
        for (let i = 1; i <= 6; i++) {
            const idx = points.length - 1 - i;
            if (idx < 0) break;
            const p = points[idx];
            ctx.fillStyle = `rgba(255, 200, 100, ${0.5 * (1 - i / 6)})`;
            ctx.beginPath();
            ctx.arc(p.x, p.y, Math.max(4 - i * 0.5, 0.5), 0, Math.PI * 2);
            ctx.fill();
        }

        // Rotation angle based on trajectory
        let angle = 0;
        if (points.length > 1) {
            const prev = points[points.length - 2];
            angle = Math.atan2(head.y - prev.y, head.x - prev.x);
        }

        ctx.save();
        ctx.translate(head.x, head.y);
        ctx.rotate(angle);

        // Plane color
        ctx.fillStyle = crashed ? '#ef4444' : '#ff2d55';
        ctx.shadowBlur = 15;
        ctx.shadowColor = 'rgba(255, 45, 85, 0.8)';

        // Main body (triangle)
        ctx.beginPath();
        ctx.moveTo(16, 0);
        ctx.lineTo(-6, -8);
        ctx.lineTo(-2, 0);
        ctx.lineTo(-6, 8);
        ctx.closePath();
        ctx.fill();

        // Top wing
        ctx.beginPath();
        ctx.moveTo(2, -2);
        ctx.lineTo(-4, -14);
        ctx.lineTo(-1, -2);
        ctx.closePath();
        ctx.fill();

        // Bottom wing
        ctx.beginPath();
        ctx.moveTo(2, 2);
        ctx.lineTo(-4, 14);
        ctx.lineTo(-1, 2);
        ctx.closePath();
        ctx.fill();

        ctx.shadowBlur = 0;
        ctx.restore();
    }
}

// ============================================
// INIT
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    resizeCanvas();
    checkSession();

    // Set initial sound button state
    const btn = document.getElementById('sound-toggle');
    if (btn) {
        btn.innerHTML = soundEnabled
            ? '<i class="fa-solid fa-volume-high"></i>'
            : '<i class="fa-solid fa-volume-xmark"></i>';
        btn.classList.toggle('muted', !soundEnabled);
    }

    // Periodic balance refresh
    setInterval(refreshBalance, 15000);

    // Auto-refresh history modal if open
    setInterval(() => {
        const hist = document.getElementById('history-modal');
        if (hist && !hist.classList.contains('hidden')) {
            loadHistory();
        }
    }, 30000);
});
