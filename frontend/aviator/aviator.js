// ============================================
// BetNova — Aviator Client
// Smooth 60fps curve · Smooth plane motion · Provably fair
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

// Animation state — driven at 60fps by RAF
let flightStartTime = null;
let lastServerMultiplier = 1.00;
let displayMultiplier = 1.00;
let targetMultiplier = 1.00;
let crashedMultiplier = null;
let animationFrameId = null;
let isCrashed = false;

// ============================================
// CANVAS
// ============================================
const canvas = document.getElementById('avi-canvas');
const ctx = canvas ? canvas.getContext('2d') : null;
let W = 0, H = 0;
let DPR = window.devicePixelRatio || 1;

function resizeCanvas() {
    if (!canvas || !ctx) return;
    DPR = window.devicePixelRatio || 1;
    W = canvas.clientWidth;
    H = canvas.clientHeight;
    canvas.width = W * DPR;
    canvas.height = H * DPR;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(DPR, DPR);

    // Redraw current frame at new size
    render(displayMultiplier, isCrashed);
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
// SESSION
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

function updateActionButton(panel) {
    const btn = document.getElementById(`action-${panel}`);
    const btnAuto = document.getElementById(`action-${panel}-auto`);
    const stakeInput = document.getElementById(`stake-${panel}`);
    if (!btn || !stakeInput) return;

    const stake = parseFloat(stakeInput.value) || 0;
    const bet = myBets[panel];

    if (lastStatus && lastStatus.status === 'FLYING' && bet && !bet.cashedOut) {
        const payout = (bet.amount * displayMultiplier).toFixed(2);
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
// SMOOTH ANIMATION LOOP (60fps)
// ============================================
function startAnimation() {
    if (animationFrameId) return;
    let lastFrameTime = performance.now();

    function frame(now) {
        const deltaMs = now - lastFrameTime;
        lastFrameTime = now;

        // Smoothly interpolate displayMultiplier toward targetMultiplier
        // Use exponential ease so it catches up fast but never overshoots
        if (lastStatus && lastStatus.status === 'FLYING') {
            const target = lastServerMultiplier;
            const diff = target - displayMultiplier;

            if (Math.abs(diff) < 0.005) {
                displayMultiplier = target;
            } else {
                // Ease toward target at roughly 30% of remaining gap per frame
                // This makes the multiplier roll smoothly instead of jumping
                displayMultiplier += diff * Math.min(1, deltaMs / 100);
            }
        } else if (lastStatus && lastStatus.status === 'CRASHED' && crashedMultiplier !== null) {
            // Snap to crash point
            displayMultiplier = crashedMultiplier;
        }

        // Update the DOM multiplier
        updateMultiplierDisplay();

        // Render the canvas
        render(displayMultiplier, isCrashed);

        animationFrameId = requestAnimationFrame(frame);
    }
    animationFrameId = requestAnimationFrame(frame);
}

function stopAnimation() {
    if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
    }
}

function updateMultiplierDisplay() {
    const multiplierEl = document.getElementById('multiplier');
    if (!multiplierEl) return;

    if (!lastStatus) return;

    if (lastStatus.status === 'WAITING') {
        // Already set by tick handler
        return;
    }

    if (lastStatus.status === 'FLYING') {
        multiplierEl.innerHTML = `${displayMultiplier.toFixed(2)}<span>x</span>`;
        multiplierEl.style.color = '#ffffff';
        multiplierEl.classList.remove('crashed');
    } else if (lastStatus.status === 'CRASHED') {
        multiplierEl.innerHTML = `${displayMultiplier.toFixed(2)}<span>x</span>`;
        multiplierEl.style.color = '#ef4444';
        multiplierEl.classList.add('crashed');
    }
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

    const statusBadge = document.getElementById('status-badge');

    // ---------- WAITING ----------
    if (state.status === 'WAITING') {
        flightStartTime = null;
        lastServerMultiplier = 1.00;
        displayMultiplier = 1.00;
        crashedMultiplier = null;
        isCrashed = false;

        const multiplierEl = document.getElementById('multiplier');
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
        if (!flightStartTime) {
            flightStartTime = Date.now();
            displayMultiplier = 1.00;
        }

        lastServerMultiplier = state.multiplier;
        isCrashed = false;

        if (statusBadge) statusBadge.innerText = 'In flight — cash out before crash';

        // Auto-cashout check against server multiplier (authoritative)
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
        crashedMultiplier = state.multiplier;
        lastServerMultiplier = state.multiplier;
        displayMultiplier = state.multiplier;
        isCrashed = true;

        if (statusBadge) statusBadge.innerText = 'FLEW AWAY!';
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
// PAYHERO
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
// CANVAS — Smooth exponential curve
// ============================================
function clearCanvas() {
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
}

function render(multiplier, crashed) {
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);

    const padL = 40;
    const padR = 40;
    const padT = 55;
    const padB = 30;

    const startX = padL;
    const startY = H - padB;
    const endX = W - padR;
    const endY = padT;
    const spanX = endX - startX;
    const spanY = startY - endY;

    // ---------- Grid ----------
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 5; i++) {
        const y = startY - spanY * (i / 5);
        ctx.beginPath();
        ctx.moveTo(startX, y);
        ctx.lineTo(endX, y);
        ctx.stroke();
    }

    // ---------- Curve math ----------
    const safeMul = Math.max(1.001, multiplier);

    // X progress: how far across the canvas we are (based on log of multiplier)
    // At 1.00x → 0, at 2x → ~0.42, at 10x → ~0.68, at 100x → ~0.87
    const progress = Math.min(0.97, Math.log(safeMul) / Math.log(1000) + (safeMul - 1) * 0.03);

    // Y height: how high the curve has climbed (non-linear, accelerates)
    // Felt factor makes the curve rise more dramatically as multiplier grows
    const heightFactor = Math.min(0.97,
        1 - Math.exp(-(safeMul - 1) * 0.35) + (safeMul - 1) * 0.008);

    // ---------- Build curve points ----------
    const points = [];
    const STEPS = 120;
    for (let i = 0; i <= STEPS; i++) {
        const t = i / STEPS;

        // Position along the curve (0 to progress)
        const tt = t * progress;
        const x = startX + spanX * tt;

        // Y climbs exponentially: steeper as t increases
        const yProgress = Math.pow(t, 1.4) * heightFactor;
        const y = startY - spanY * yProgress;

        points.push({ x, y });
    }

    // ---------- Draw ----------
    if (points.length > 1) {
        const head = points[points.length - 1];

        // 1. Gradient fill under curve
        const grad = ctx.createLinearGradient(startX, startY, head.x, head.y);
        if (crashed) {
            grad.addColorStop(0, 'rgba(239, 68, 68, 0.04)');
            grad.addColorStop(0.5, 'rgba(239, 68, 68, 0.18)');
            grad.addColorStop(1, 'rgba(239, 68, 68, 0.42)');
        } else {
            grad.addColorStop(0, 'rgba(217, 29, 54, 0.04)');
            grad.addColorStop(0.5, 'rgba(217, 29, 54, 0.16)');
            grad.addColorStop(1, 'rgba(217, 29, 54, 0.35)');
        }

        ctx.beginPath();
        ctx.moveTo(startX, startY);
        points.forEach(p => ctx.lineTo(p.x, p.y));
        ctx.lineTo(head.x, startY);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();

        // 2. Outer glow line
        ctx.beginPath();
        ctx.strokeStyle = crashed ? '#ef4444' : '#d91d36';
        ctx.lineWidth = 5;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.shadowBlur = 22;
        ctx.shadowColor = crashed
            ? 'rgba(239, 68, 68, 0.9)'
            : 'rgba(217, 29, 54, 0.85)';
        points.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
        ctx.stroke();

        // 3. Bright core line
        ctx.beginPath();
        ctx.strokeStyle = crashed ? '#fca5a5' : '#ff2d55';
        ctx.lineWidth = 2;
        ctx.shadowBlur = 14;
        ctx.shadowColor = 'rgba(255, 45, 85, 1)';
        points.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
        ctx.stroke();
        ctx.shadowBlur = 0;

        // 4. Particle trail
        for (let i = 1; i <= 10; i++) {
            const idx = points.length - 1 - i;
            if (idx < 0) break;
            const p = points[idx];
            const alpha = 0.6 * (1 - i / 10);
            const radius = Math.max(5 - i * 0.45, 0.5);
            ctx.fillStyle = crashed
                ? `rgba(239, 68, 68, ${alpha})`
                : `rgba(255, 150, 150, ${alpha})`;
            ctx.beginPath();
            ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
            ctx.fill();
        }

        // 5. Plane at head
        const prev = points[points.length - 2];
        let angle = 0;
        if (prev) {
            angle = Math.atan2(head.y - prev.y, head.x - prev.x);
        }

        ctx.save();
        ctx.translate(head.x, head.y);
        ctx.rotate(angle);

        ctx.fillStyle = crashed ? '#ef4444' : '#d91d36';
        ctx.shadowBlur = 18;
        ctx.shadowColor = 'rgba(217, 29, 54, 0.9)';

        // Body
        ctx.beginPath();
        ctx.moveTo(20, 0);
        ctx.lineTo(-9, -10);
        ctx.lineTo(-3, 0);
        ctx.lineTo(-9, 10);
        ctx.closePath();
        ctx.fill();

        // Top wing
        ctx.beginPath();
        ctx.moveTo(3, -3);
        ctx.lineTo(-6, -18);
        ctx.lineTo(-1, -3);
        ctx.closePath();
        ctx.fill();

        // Bottom wing
        ctx.beginPath();
        ctx.moveTo(3, 3);
        ctx.lineTo(-6, 18);
        ctx.lineTo(-1, 3);
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
    startAnimation();

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

// Cleanup on unload
window.addEventListener('beforeunload', () => {
    stopAnimation();
});
