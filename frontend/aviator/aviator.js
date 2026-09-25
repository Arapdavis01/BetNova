// ============================================
// BetNova — Aviator Client
// Handles: dual bet panels, all-bets feed, chat, provably fair
// Moving graph: exponential, time-based, climbing plane
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
let myBets = { 1: null, 2: null };
let lastStatus = null;
let currentCommit = null;
let lastTimerTick = null;
let autoBetEnabled = { 1: false, 2: false };

// Flight tracking (for time-based graph)
let flightStartTime = null;
let flightEndTime = null;
let lastMultiplier = 1.00;

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
    // Redraw if we're mid-flight
    if (flightStartTime && lastMultiplier > 1.01) {
        drawCurve(lastMultiplier, false);
    }
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

        const lock = document.getElementById('game-lock');
        if (lock) lock.classList.add('hidden');

        const balEl = document.getElementById('balance-display');
        if (balEl) balEl.innerText = formatKES(balance || 0);

        const profileName = document.getElementById('profile-name');
        if (profileName) profileName.innerText = user;

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

// Tab switching
document.querySelectorAll('.avi-bet-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        const panel = tab.dataset.panel;
        const mode = tab.dataset.mode;

        const parent = tab.parentElement;
        if (parent) {
            parent.querySelectorAll('.avi-bet-tab').forEach(t => t.classList.remove('active'));
        }
        tab.classList.add('active');

        const panelEl = document.getElementById(`bet-panel-${panel}`);
        if (!panelEl) return;
        panelEl.querySelectorAll('.avi-bet-body').forEach(body => {
            const isAuto = body.dataset.auto === 'true';
            const shouldShow = (mode === 'auto' && isAuto) || (mode === 'bet' && !isAuto);
            body.classList.toggle('hidden', !shouldShow);
        });
    });
});

// Update button label
function updateActionButton(panel) {
    const btn = document.getElementById(`action-${panel}`);
    const btnAuto = document.getElementById(`action-${panel}-auto`);
    const stakeInput = document.getElementById(`stake-${panel}`);
    if (!btn || !stakeInput) return;

    const stake = parseFloat(stakeInput.value) || 0;
    const bet = myBets[panel];

    if (lastStatus && lastStatus.status === 'FLYING' && bet && !bet.cashedOut) {
        const payout = (bet.amount * lastStatus.multiplier).toFixed(2);
        const title = 'CASH OUT';
        const subtext = `KES ${formatKES(payout)}`;

        applyButtonState(btn, 'avi-action-cashout', false, title, subtext);
        if (btnAuto) applyButtonState(btnAuto, 'avi-action-cashout', false, title, subtext);
        return;
    }

    if (bet && (bet.cashedOut || (lastStatus && lastStatus.status !== 'CRASHED'))) {
        const title = bet.cashedOut ? 'CASHED OUT' : 'BET PLACED';
        const subtext = bet.cashedOut
            ? `@ ${bet.cashoutMultiplier.toFixed(2)}x`
            : `KES ${formatKES(bet.amount)}`;

        applyButtonState(btn, 'avi-action-waiting', true, title, subtext);
        if (btnAuto) applyButtonState(btnAuto, 'avi-action-waiting', true, title, subtext);
        return;
    }

    const title = 'BET';
    const subtext = `KES ${formatKES(stake)}`;
    const canBet = lastStatus && lastStatus.status === 'WAITING';

    applyButtonState(btn, 'avi-action-bet', !canBet, title, subtext);
    if (btnAuto) applyButtonState(btnAuto, 'avi-action-bet', !canBet, title, subtext);
}

function applyButtonState(btn, className, disabled, title, subtext) {
    btn.className = `avi-action-btn ${className}`;
    btn.disabled = disabled;

    const titleEl = btn.querySelector('.avi-btn-title');
    const subtextEl = btn.querySelector('.avi-btn-subtext');

    if (titleEl && subtextEl) {
        titleEl.innerText = title;
        subtextEl.innerText = subtext;
    } else {
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

    if (isFlying && bet && !bet.cashedOut) {
        socket.emit('cash_out', { panel });
        return;
    }

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
// SOCKET — GAME TICK (main game loop)
// ============================================
socket.on('betnova_tick', (state) => {
    lastStatus = state;

    const multiplierEl = document.getElementById('multiplier');
    const statusBadge = document.getElementById('status-badge');

    // ---------- WAITING ----------
    if (state.status === 'WAITING') {
        // Reset flight tracking
        flightStartTime = null;
        flightEndTime = null;
        lastMultiplier = 1.00;

        if (multiplierEl) {
            multiplierEl.innerHTML = `${state.timer}<span>s</span>`;
            multiplierEl.style.color = '#fbbf24';
            multiplierEl.classList.remove('crashed');
        }
        if (statusBadge) statusBadge.innerText = 'Waiting for next round...';
        clearCanvas();

        if (state.timer !== lastTimerTick && state.timer >= 0 && state.timer <= 3) {
            playSound('tick');
            lastTimerTick = state.timer;
        }
    }

    // ---------- FLYING ----------
    else if (state.status === 'FLYING') {
        // Capture flight start time on first FLYING tick
        if (!flightStartTime) {
            flightStartTime = Date.now();
        }

        lastMultiplier = state.multiplier;

        if (multiplierEl) {
            multiplierEl.innerHTML = `${state.multiplier.toFixed(2)}<span>x</span>`;
            multiplierEl.style.color = '#ffffff';
            multiplierEl.classList.remove('crashed');
        }
        if (statusBadge) statusBadge.innerText = 'In flight — cash out before crash';

        // Draw the moving curve
        drawCurve(state.multiplier, false);

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

    // ---------- CRASHED ----------
    else if (state.status === 'CRASHED') {
        flightEndTime = Date.now();
        lastMultiplier = state.multiplier;

        if (multiplierEl) {
            multiplierEl.innerHTML = `${state.multiplier.toFixed(2)}<span>x</span>`;
            multiplierEl.style.color = '#ef4444';
            multiplierEl.classList.add('crashed');
        }
        if (statusBadge) statusBadge.innerText = 'FLEW AWAY!';

        // Redraw with the actual crash multiplier (frozen)
        drawCurve(state.multiplier, true);
    }

    updateActionButton(1);
    updateActionButton(2);
});

// ============================================
// SOCKET — BALANCE
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
// PAYHERO — DEPOSIT / WITHDRAW
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
// CANVAS DRAWING — Exponential moving curve
// ============================================
function clearCanvas() {
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
}

/**
 * Draw the Aviator curve.
 *
 * @param {number} multiplier - Current multiplier (e.g. 2.45)
 * @param {boolean} crashed - Whether the round has crashed
 *
 * The curve is drawn as:
 *  - X axis: time-progress normalized to 0..1 (based on multiplier)
 *  - Y axis: exponential climb (multiplier ^ exponent)
 *  - The plane sits at the head of the curve
 *  - The area under the curve is filled with a red gradient
 */
function drawCurve(multiplier, crashed = false) {
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);

    // ---------- Geometry ----------
    const padL = 50;
    const padR = 50;
    const padT = 60;
    const padB = 40;

    const startX = padL;
    const startY = H - padB;
    const endX = W - padR;
    const endY = padT;

    const spanX = endX - startX;
    const spanY = startY - endY;

    // ---------- Grid ----------
    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 6; i++) {
        const y = startY - spanY * (i / 6);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
    }
    for (let i = 1; i < 8; i++) {
        const x = startX + spanX * (i / 8);
        ctx.beginPath();
        ctx.moveTo(x, endY);
        ctx.lineTo(x, startY);
        ctx.stroke();
    }

    // ---------- Normalize multiplier to curve progress ----------
    // progress = 0 at 1.00x, approaching 1.0 as multiplier grows
    const safeMul = Math.max(1.00, multiplier);
    const progress = Math.min(0.98, 1 - Math.pow(1 / safeMul, 1.15));

    // Exponential climb factor — plane rises fast as multiplier grows
    const climb = Math.pow(safeMul - 1, 0.65);

    // ---------- Build curve points ----------
    const points = [];
    const STEPS = 100;
    for (let i = 0; i <= STEPS; i++) {
        const t = (i / STEPS) * progress;

        // Curve x position
        const x = startX + spanX * t;

        // Curve y position — exponential climb normalized by max climb
        // We compute where this step would land in the (0..progress) range
        const normalizedT = progress > 0 ? (t / progress) : 0;
        const climbAtT = Math.pow(safeMul - 1, 0.65) * normalizedT;
        const yOffset = climbAtT / Math.max(climb, 0.001);

        const y = startY - spanY * yOffset * 0.95;

        points.push({ x, y });
    }

    // ---------- Draw ----------
    if (points.length > 1) {
        const head = points[points.length - 1];

        // 1. Fill under curve (gradient red)
        const gradient = ctx.createLinearGradient(startX, startY, head.x, head.y);
        if (crashed) {
            gradient.addColorStop(0, 'rgba(239, 68, 68, 0.05)');
            gradient.addColorStop(0.6, 'rgba(239, 68, 68, 0.20)');
            gradient.addColorStop(1, 'rgba(239, 68, 68, 0.45)');
        } else {
            gradient.addColorStop(0, 'rgba(217, 29, 54, 0.05)');
            gradient.addColorStop(0.6, 'rgba(217, 29, 54, 0.18)');
            gradient.addColorStop(1, 'rgba(217, 29, 54, 0.38)');
        }

        ctx.beginPath();
        ctx.moveTo(startX, startY);
        points.forEach(p => ctx.lineTo(p.x, p.y));
        ctx.lineTo(head.x, startY);
        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.fill();

        // 2. Base curve line (glowing)
        ctx.beginPath();
        ctx.strokeStyle = crashed ? '#ef4444' : '#d91d36';
        ctx.lineWidth = 3.5;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.shadowBlur = 18;
        ctx.shadowColor = crashed
            ? 'rgba(239, 68, 68, 0.85)'
            : 'rgba(217, 29, 54, 0.85)';
        points.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
        ctx.stroke();

        // 3. Bright accent line on top
        ctx.beginPath();
        ctx.strokeStyle = crashed ? '#f87171' : '#ff2d55';
        ctx.lineWidth = 1.5;
        ctx.shadowBlur = 12;
        ctx.shadowColor = 'rgba(255, 45, 85, 0.9)';
        points.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
        ctx.stroke();
        ctx.shadowBlur = 0;

        // 4. Particle trail behind the plane
        for (let i = 1; i <= 8; i++) {
            const idx = points.length - 1 - i;
            if (idx < 0) break;
            const p = points[idx];
            const alpha = 0.55 * (1 - i / 8);
            const radius = Math.max(4.5 - i * 0.5, 0.5);
            ctx.fillStyle = crashed
                ? `rgba(239, 68, 68, ${alpha})`
                : `rgba(255, 130, 130, ${alpha})`;
            ctx.beginPath();
            ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
            ctx.fill();
        }

        // 5. Plane sprite at the head
        const prev = points[points.length - 2];
        let angle = 0;
        if (prev) {
            angle = Math.atan2(head.y - prev.y, head.x - prev.x);
        }

        ctx.save();
        ctx.translate(head.x, head.y);
        ctx.rotate(angle);

        ctx.fillStyle = crashed ? '#ef4444' : '#d91d36';
        ctx.shadowBlur = 16;
        ctx.shadowColor = 'rgba(217, 29, 54, 0.9)';

        // Body
        ctx.beginPath();
        ctx.moveTo(18, 0);
        ctx.lineTo(-8, -9);
        ctx.lineTo(-3, 0);
        ctx.lineTo(-8, 9);
        ctx.closePath();
        ctx.fill();

        // Top wing
        ctx.beginPath();
        ctx.moveTo(3, -2);
        ctx.lineTo(-5, -16);
        ctx.lineTo(-1, -2);
        ctx.closePath();
        ctx.fill();

        // Bottom wing
        ctx.beginPath();
        ctx.moveTo(3, 2);
        ctx.lineTo(-5, 16);
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

    const btn = document.getElementById('sound-toggle');
    if (btn) {
        btn.innerHTML = soundEnabled
            ? '<i class="fa-solid fa-volume-high"></i>'
            : '<i class="fa-solid fa-volume-xmark"></i>';
        btn.classList.toggle('muted', !soundEnabled);
    }

    setInterval(refreshBalance, 15000);

    setInterval(() => {
        const hist = document.getElementById('history-modal');
        if (hist && !hist.classList.contains('hidden')) {
            loadHistory();
        }
    }, 30000);
});
