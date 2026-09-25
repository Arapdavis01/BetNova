// ============================================
// BetNova — Crash Game Client
// Reuses Aviator socket backend 100%
// Rising-bar visual + smooth multiplier
// Session sync with shell.js via BetNova.user
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

let displayMultiplier = 1.00;
let lastServerMultiplier = 1.00;
let crashedMultiplier = null;
let animationFrameId = null;
let isCrashed = false;

// ============================================
// CANVAS
// ============================================
const canvas = document.getElementById('cr-canvas');
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
    render(displayMultiplier, isCrashed);
}
window.addEventListener('resize', resizeCanvas);
window.addEventListener('orientationchange', () => setTimeout(resizeCanvas, 100));

// ============================================
// SOUND — Web Audio synthesis
// ============================================
const SoundKit = (() => {
    let ac = null;
    let soundEnabled = localStorage.getItem('betnova_sound') !== 'off';
    let unlocked = false;

    function getAc() {
        if (ac) return ac;
        const C = window.AudioContext || window.webkitAudioContext;
        if (!C) return null;
        ac = new C();
        return ac;
    }
    function unlock() {
        if (unlocked) return;
        const c = getAc();
        if (!c) return;
        if (c.state === 'suspended') c.resume().catch(() => {});
        unlocked = true;
        console.log('[Crash] Audio unlocked');
    }
    ['click','touchstart','keydown'].forEach(e =>
        document.addEventListener(e, unlock, { once: true, passive: true })
    );

    function tone({ freq, duration, type = 'sine', volume = 0.2, sweepTo = null, attack = 0.01, release = 0.1 }) {
        if (!soundEnabled) return;
        const c = getAc();
        if (!c) return;
        if (c.state === 'suspended') c.resume().catch(() => {});
        const now = c.currentTime;
        const osc = c.createOscillator();
        const gain = c.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, now);
        if (sweepTo !== null) {
            osc.frequency.exponentialRampToValueAtTime(Math.max(1, sweepTo), now + duration);
        }
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(volume, now + attack);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + duration + release);
        osc.connect(gain).connect(c.destination);
        osc.start(now);
        osc.stop(now + duration + release + 0.05);
    }

    function noise({ duration = 0.6, volume = 0.3, filterFreq = 800, filterSweepTo = 60 }) {
        if (!soundEnabled) return;
        const c = getAc();
        if (!c) return;
        if (c.state === 'suspended') c.resume().catch(() => {});
        const now = c.currentTime;
        const buffer = c.createBuffer(1, Math.max(1, Math.floor(c.sampleRate * duration)), c.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) {
            data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
        }
        const src = c.createBufferSource();
        src.buffer = buffer;
        const filter = c.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(filterFreq, now);
        filter.frequency.exponentialRampToValueAtTime(Math.max(20, filterSweepTo), now + duration);
        const gain = c.createGain();
        gain.gain.setValueAtTime(volume, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
        src.connect(filter).connect(gain).connect(c.destination);
        src.start(now);
        src.stop(now + duration);
    }

    function play(name) {
        if (!soundEnabled) return;
        switch (name) {
            case 'tick':
                tone({ freq: 880, duration: 0.06, type: 'square', volume: 0.15 });
                break;
            case 'cashout':
                tone({ freq: 1046, duration: 0.08, type: 'triangle', volume: 0.25 });
                setTimeout(() => tone({ freq: 1568, duration: 0.14, type: 'triangle', volume: 0.25 }), 70);
                break;
            case 'crash':
                noise({ duration: 0.7, volume: 0.35, filterFreq: 1200, filterSweepTo: 80 });
                tone({ freq: 220, duration: 0.5, type: 'sawtooth', volume: 0.18, sweepTo: 40 });
                break;
            case 'placeBet':
                tone({ freq: 520, duration: 0.05, type: 'sine', volume: 0.18, sweepTo: 720 });
                break;
        }
    }

    let engineOsc = null, engineGain = null;
    function startEngine() {
        if (!soundEnabled) return;
        const c = getAc();
        if (!c || engineOsc) return;
        if (c.state === 'suspended') c.resume().catch(() => {});
        engineOsc = c.createOscillator();
        engineGain = c.createGain();
        engineOsc.type = 'sawtooth';
        engineOsc.frequency.setValueAtTime(90, c.currentTime);
        engineGain.gain.setValueAtTime(0.0001, c.currentTime);
        engineGain.gain.linearRampToValueAtTime(0.06, c.currentTime + 0.4);
        const filter = c.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 500;
        engineOsc.connect(filter).connect(engineGain).connect(c.destination);
        engineOsc.start();
    }
    function setEnginePitch(m) {
        if (!engineOsc || !ac) return;
        const f = Math.min(90 + Math.log(m + 1) * 80, 600);
        engineOsc.frequency.setTargetAtTime(f, ac.currentTime, 0.2);
    }
    function stopEngine() {
        if (!engineOsc) return;
        try {
            engineGain.gain.cancelScheduledValues(ac.currentTime);
            engineGain.gain.setValueAtTime(engineGain.gain.value, ac.currentTime);
            engineGain.gain.linearRampToValueAtTime(0.0001, ac.currentTime + 0.15);
            engineOsc.stop(ac.currentTime + 0.2);
        } catch (_) {}
        engineOsc = null;
        engineGain = null;
    }

    function toggle() {
        soundEnabled = !soundEnabled;
        localStorage.setItem('betnova_sound', soundEnabled ? 'on' : 'off');
        if (!soundEnabled) stopEngine();
        else unlock();
        const btn = document.getElementById('sound-toggle');
        if (btn) {
            btn.innerHTML = soundEnabled
                ? '<i class="fa-solid fa-volume-high"></i>'
                : '<i class="fa-solid fa-volume-xmark"></i>';
            btn.classList.toggle('muted', !soundEnabled);
        }
    }

    return { play, startEngine, stopEngine, setEnginePitch, toggle, isEnabled: () => soundEnabled };
})();

function toggleSound() { SoundKit.toggle(); }

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
    t.className = `cr-toast ${type}`;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), duration);
}

// ============================================
// SESSION — reads from BetNova (shell.js) first, then localStorage
// ============================================
function readSession() {
    // 1. Prefer shell.js session (authoritative — it manages login)
    const nova = window.BetNova;
    if (nova && nova.user && nova.user.userId && nova.user.username) {
        return {
            userId: nova.user.userId,
            username: nova.user.username
        };
    }

    // 2. Fallback to localStorage — require token as proof of a real session
    const user = localStorage.getItem('betnova_user');
    const userId = localStorage.getItem('betnova_userid');
    const token = localStorage.getItem('betnova_token');

    if (user && userId && token) {
        return { userId, username: user };
    }

    return null;
}

function checkSession() {
    const session = readSession();
    const lock = document.getElementById('game-lock');

    if (session) {
        currentUser = session;
        lock?.classList.add('hidden');

        const balance = localStorage.getItem('betnova_balance') || '0';
        const balEl = document.getElementById('balance-display');
        if (balEl) balEl.innerText = formatKES(balance);

        refreshBalance();
        socket.emit('chat_join', { username: session.username });
    } else {
        currentUser = null;
        lock?.classList.remove('hidden');
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
    document.getElementById(id)?.classList.remove('hidden');
}
function closeModal(id) {
    document.getElementById(id)?.classList.add('hidden');
}

document.addEventListener('click', (e) => {
    if (e.target.classList && e.target.classList.contains('cr-modal')) {
        e.target.classList.add('hidden');
    }
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        document.querySelectorAll('.cr-modal:not(.hidden)').forEach(m => m.classList.add('hidden'));
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

document.querySelectorAll('.cr-bet-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        const panel = tab.dataset.panel;
        const mode = tab.dataset.mode;
        const parent = tab.parentElement;
        if (parent) parent.querySelectorAll('.cr-bet-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const panelEl = document.getElementById(`bet-panel-${panel}`);
        if (!panelEl) return;
        panelEl.querySelectorAll('.cr-bet-body').forEach(body => {
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
        applyButtonState(btn, 'cr-action-cashout', false, 'CASH OUT', `KES ${formatKES(payout)}`);
        if (btnAuto) applyButtonState(btnAuto, 'cr-action-cashout', false, 'CASH OUT', `KES ${formatKES(payout)}`);
        return;
    }

    if (bet && (bet.cashedOut || (lastStatus && lastStatus.status !== 'CRASHED'))) {
        const title = bet.cashedOut ? 'CASHED OUT' : 'BET PLACED';
        const subtext = bet.cashedOut
            ? `@ ${bet.cashoutMultiplier.toFixed(2)}x`
            : `KES ${formatKES(bet.amount)}`;
        applyButtonState(btn, 'cr-action-waiting', true, title, subtext);
        if (btnAuto) applyButtonState(btnAuto, 'cr-action-waiting', true, title, subtext);
        return;
    }

    const canBet = lastStatus && lastStatus.status === 'WAITING';
    applyButtonState(btn, 'cr-action-bet', !canBet, 'BET', `KES ${formatKES(stake)}`);
    if (btnAuto) applyButtonState(btnAuto, 'cr-action-bet', !canBet, 'BET', `KES ${formatKES(stake)}`);
}

function applyButtonState(btn, className, disabled, title, subtext) {
    btn.className = `cr-action-btn ${className}`;
    btn.disabled = disabled;
    const titleEl = btn.querySelector('.cr-btn-title');
    const subtextEl = btn.querySelector('.cr-btn-subtext');
    if (titleEl && subtextEl) {
        titleEl.innerText = title;
        subtextEl.innerText = subtext;
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
        // Delegate to shell.js sign-in prompt (opens modal, restores action)
        if (window.BetNova && typeof window.BetNova.requireAuth === 'function') {
            window.BetNova.requireAuth(() => handleBetAction(panel), 'Sign in to place your bet');
        } else {
            showToast('Sign in to place bets', 'error');
        }
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
// ANIMATION LOOP
// ============================================
function startAnimation() {
    if (animationFrameId) return;
    let lastFrameTime = performance.now();

    function frame(now) {
        const deltaMs = now - lastFrameTime;
        lastFrameTime = now;

        if (lastStatus && lastStatus.status === 'FLYING') {
            const target = lastServerMultiplier;
            const diff = target - displayMultiplier;
            if (Math.abs(diff) < 0.005) displayMultiplier = target;
            else displayMultiplier += diff * Math.min(1, deltaMs / 100);
        } else if (lastStatus && lastStatus.status === 'CRASHED' && crashedMultiplier !== null) {
            displayMultiplier = crashedMultiplier;
        }

        updateMultiplierDisplay();
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
    const el = document.getElementById('multiplier');
    const fill = document.getElementById('multiplier-fill');
    if (!el) return;
    if (!lastStatus) return;

    if (lastStatus.status === 'WAITING') return;

    if (lastStatus.status === 'FLYING') {
        el.innerHTML = `${displayMultiplier.toFixed(2)}<span>x</span>`;
        el.style.color = '#ffffff';
        el.classList.remove('crashed');
        if (fill) {
            const pct = Math.min(100, (Math.log(displayMultiplier) / Math.log(100)) * 100);
            fill.style.width = `${pct}%`;
            fill.classList.remove('crashed');
        }
    } else if (lastStatus.status === 'CRASHED') {
        el.innerHTML = `${displayMultiplier.toFixed(2)}<span>x</span>`;
        el.style.color = '#ef4444';
        el.classList.add('crashed');
        if (fill) {
            const pct = Math.min(100, (Math.log(displayMultiplier) / Math.log(100)) * 100);
            fill.style.width = `${pct}%`;
            fill.classList.add('crashed');
        }
    }
}

// ============================================
// SOCKET — CONNECTION
// ============================================
socket.on('connect', () => {
    console.log('[Crash] Socket connected:', socket.id);
    if (currentUser) socket.emit('chat_join', { username: currentUser.username });
});

socket.on('disconnect', (reason) => {
    console.log('[Crash] Socket disconnected:', reason);
});

socket.on('reconnect', () => {
    console.log('[Crash] Socket reconnected');
    refreshBalance();
});

// ============================================
// SOCKET — GAME TICK
// ============================================
socket.on('betnova_tick', (state) => {
    lastStatus = state;
    const badge = document.getElementById('status-badge');

    // WAITING
    if (state.status === 'WAITING') {
        lastServerMultiplier = 1.00;
        displayMultiplier = 1.00;
        crashedMultiplier = null;
        isCrashed = false;

        if (state.timer === 5 || state.timer === 4) lastTimerTick = null;

        const multEl = document.getElementById('multiplier');
        if (multEl) {
            multEl.innerHTML = `${state.timer}<span>s</span>`;
            multEl.style.color = '#fbbf24';
            multEl.classList.remove('crashed');
        }
        const fill = document.getElementById('multiplier-fill');
        if (fill) {
            fill.style.width = '0%';
            fill.classList.remove('crashed');
        }
        if (badge) badge.innerText = 'Waiting for next round...';
        clearCanvas();

        if (state.timer >= 0 && state.timer <= 3 &&
            lastTimerTick !== null && state.timer < lastTimerTick) {
            SoundKit.play('tick');
        }
        lastTimerTick = state.timer;
    }

    // FLYING
    else if (state.status === 'FLYING') {
        const justStarted = lastServerMultiplier === 1.00 && state.multiplier < 1.1;
        if (justStarted) SoundKit.startEngine();

        lastServerMultiplier = state.multiplier;
        isCrashed = false;
        SoundKit.setEnginePitch(state.multiplier);

        if (badge) badge.innerText = 'Rising — cash out before crash';

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

    // CRASHED
    else if (state.status === 'CRASHED') {
        SoundKit.stopEngine();
        SoundKit.play('crash');

        crashedMultiplier = state.multiplier;
        lastServerMultiplier = state.multiplier;
        displayMultiplier = state.multiplier;
        isCrashed = true;

        if (badge) badge.innerText = 'CRASHED!';

        const flash = document.getElementById('crash-flash');
        if (flash) {
            flash.classList.remove('active');
            void flash.offsetWidth;
            flash.classList.add('active');
        }
    }

    updateActionButton(1);
    updateActionButton(2);
});

// ============================================
// SOCKET — BALANCE / BETS
// ============================================
socket.on('balance_update', (balance) => {
    localStorage.setItem('betnova_balance', balance);
    const el = document.getElementById('balance-display');
    if (el) el.innerText = formatKES(balance);
});

socket.on('bet_placed', ({ amount, panel }) => {
    myBets[panel] = { amount, cashedOut: false, cashoutMultiplier: null };
    SoundKit.play('placeBet');
    showToast(`Bet placed: KES ${formatKES(amount)}`, 'success');
    updateActionButton(panel);
});

socket.on('bet_cashed', ({ payout, multiplier, panel, auto }) => {
    if (myBets[panel]) {
        myBets[panel].cashedOut = true;
        myBets[panel].cashoutMultiplier = multiplier;
    }
    SoundKit.play('cashout');
    showToast(
        `${auto ? 'AUTO ' : ''}Cashed out @ ${multiplier.toFixed(2)}x — KES ${formatKES(payout)}`,
        'success', 4000
    );
    updateActionButton(panel);
});

socket.on('bet_lost', ({ amount, panel }) => {
    showToast(`Lost KES ${formatKES(amount)}`, 'error');
    myBets[panel] = null;
    updateActionButton(panel);
});

socket.on('bet_error', (msg) => showToast(msg, 'error'));

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
            <div class="cr-empty-state">
                <i class="fa-solid fa-chart-line"></i>
                <span>Waiting for players...</span>
            </div>`;
        return;
    }

    list.innerHTML = bets.map(b => {
        const color = b.avatarColor || '#f97316';
        const initial = (b.username || '?').charAt(0).toUpperCase();
        const winAmount = b.cashedOut ? formatKES(b.amount * b.cashoutMultiplier) : '—';
        const multi = b.cashedOut ? `${b.cashoutMultiplier.toFixed(2)}x` : '—';

        return `
            <div class="cr-bet-row ${b.cashedOut ? 'won' : ''}">
                <div class="cr-bet-username">
                    <div class="cr-bet-avatar" style="background:${color}">${initial}</div>
                    ${escapeHtml(b.username)}
                </div>
                <div class="cr-bet-amount">${formatKES(b.amount)}</div>
                <div class="cr-bet-multi">${multi}</div>
                <div class="cr-bet-win">${winAmount}</div>
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
    if (!history || history.length === 0) { strip.innerHTML = ''; return; }
    strip.innerHTML = history.slice(0, 20).map(v => {
        const cls = v >= 10 ? 'high' : v >= 2 ? 'mid' : 'low';
        return `<span class="cr-history-chip ${cls}">${v.toFixed(2)}x</span>`;
    }).join('');
});

// ============================================
// SOCKET — PROVABLY FAIR
// ============================================
socket.on('round_commit', (data) => {
    currentCommit = data;
    lastTimerTick = null;
    const roundTagEl = document.getElementById('cr-round-id');
    if (roundTagEl) roundTagEl.innerText = data.roundId;
});

socket.on('round_reveal', (data) => {
    console.log('[Crash] Round reveal:', data);
});

// ============================================
// SOCKET — CHAT
// ============================================
function sendChat() {
    if (!currentUser) { showToast('Sign in to chat', 'error'); return; }
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
    box.querySelector('.cr-chat-empty')?.remove();

    const el = document.createElement('div');
    el.className = 'cr-chat-msg';
    const time = new Date(msg.createdAt).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' });
    el.innerHTML = `
        <span class="cr-chat-user">${escapeHtml(msg.username)}</span>
        <span class="cr-chat-time">${time}</span>
        <div class="cr-chat-text">${escapeHtml(msg.message)}</div>
    `;
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
    while (box.children.length > 100) box.removeChild(box.firstChild);
}

socket.on('chat_history', (messages) => {
    const box = document.getElementById('chat-messages');
    if (!box) return;
    box.innerHTML = '';
    if (!messages || messages.length === 0) {
        box.innerHTML = `
            <div class="cr-chat-empty">
                <i class="fa-solid fa-comments"></i>
                <span>Be the first to say something</span>
            </div>`;
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
    document.getElementById('chat-panel')?.classList.toggle('mobile-open');
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
    if (btn) { btn.disabled = true; btn.innerText = 'Sending...'; }

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
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-bolt"></i> Send M-Pesa Request'; }
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
    if (btn) { btn.disabled = true; btn.innerText = 'Processing...'; }

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
            return showToast(data.error || 'Withdrawal failed', 'error');
        }
        showToast('Withdrawal sent to M-Pesa', 'success', 5000);
        closeModal('withdraw-modal');
        setTimeout(refreshBalance, 3000);
    } catch (e) {
        showToast('Network error', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-money-bill-transfer"></i> Withdraw to M-Pesa'; }
    }
}

// ============================================
// CANVAS — Rising bar visualization
// ============================================
function clearCanvas() {
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
}

function render(multiplier, crashed) {
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);

    const padL = 30, padR = 30, padT = 30, padB = 30;
    const baseX = padL;
    const baseY = H - padB;
    const topY = padT;

    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 6; i++) {
        const y = baseY - (baseY - topY) * (i / 6);
        ctx.beginPath();
        ctx.moveTo(baseX, y);
        ctx.lineTo(W - padR, y);
        ctx.stroke();
    }

    const safeMul = Math.max(1.001, multiplier);
    const BAR_COUNT = 30;
    const spacing = (W - padL - padR) / BAR_COUNT;
    const barWidth = spacing * 0.75;

    const filled = Math.min(BAR_COUNT, Math.max(1, Math.round(
        Math.log(safeMul) / Math.log(100) * BAR_COUNT
    )));

    for (let i = 0; i < BAR_COUNT; i++) {
        const x = padL + i * spacing;
        const t = i / BAR_COUNT;

        let heightRatio;
        if (i < filled) {
            heightRatio = 0.15 + Math.pow((i + 1) / BAR_COUNT, 1.4) * 0.85;
        } else {
            heightRatio = 0.04;
        }

        const barH = (baseY - topY) * heightRatio;
        const y = baseY - barH;

        let color;
        if (crashed) {
            color = i < filled ? 'rgba(239,68,68,0.9)' : 'rgba(239,68,68,0.15)';
        } else {
            const intensity = 0.4 + (i / BAR_COUNT) * 0.6;
            color = i < filled
                ? `rgba(${Math.round(249 + (239-249)*t)}, ${Math.round(115 - t*50)}, ${Math.round(22 + t*40)}, ${intensity})`
                : 'rgba(255,255,255,0.04)';
        }

        ctx.fillStyle = color;

        const radius = Math.min(barWidth / 2, 4);
        ctx.beginPath();
        ctx.moveTo(x, y + radius);
        ctx.lineTo(x, baseY - radius);
        ctx.quadraticCurveTo(x, baseY, x + radius, baseY);
        ctx.lineTo(x + barWidth - radius, baseY);
        ctx.quadraticCurveTo(x + barWidth, baseY, x + barWidth, baseY - radius);
        ctx.lineTo(x + barWidth, y + radius);
        ctx.quadraticCurveTo(x + barWidth, y, x + barWidth - radius, y);
        ctx.lineTo(x + radius, y);
        ctx.quadraticCurveTo(x, y, x, y + radius);
        ctx.closePath();
        ctx.fill();

        if (i === filled - 1 && !crashed) {
            ctx.shadowBlur = 20;
            ctx.shadowColor = 'rgba(249,115,22,0.9)';
            ctx.fill();
            ctx.shadowBlur = 0;
        }
    }

    if (!crashed) {
        const leadX = padL + Math.min(filled, BAR_COUNT - 1) * spacing + barWidth / 2;
        const leadT = Math.min(filled, BAR_COUNT) / BAR_COUNT;
        const leadH = (baseY - topY) * (0.15 + Math.pow(leadT, 1.4) * 0.85);

        ctx.fillStyle = '#ff2d55';
        ctx.shadowBlur = 22;
        ctx.shadowColor = 'rgba(255,45,85,1)';
        ctx.beginPath();
        ctx.arc(leadX, baseY - leadH, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
    }
}

// ============================================
// SESSION SYNC LISTENERS
// ============================================
// Re-check session on any visibility change (login in another tab)
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
        checkSession();
        refreshBalance();
    }
});

// Re-check when localStorage changes (another tab logs in/out)
window.addEventListener('storage', (e) => {
    if (e.key === 'betnova_user' ||
        e.key === 'betnova_userid' ||
        e.key === 'betnova_token' ||
        e.key === 'betnova_balance') {
        console.log('[Crash] Session storage changed — re-checking');
        checkSession();
    }
});

// Re-check when shell.js fires session change (same-tab login)
if (window.BetNova && window.BetNova.bus) {
    try {
        window.BetNova.bus.addEventListener('session:changed', () => {
            console.log('[Crash] BetNova session:changed — re-checking');
            checkSession();
        });
    } catch (_) {}
}

// Also poll a couple of times in the first 3 seconds after load
// to catch shell.js writing the session slightly after us.
let earlyPolls = 0;
const earlyPollTimer = setInterval(() => {
    earlyPolls++;
    if (currentUser) { clearInterval(earlyPollTimer); return; }
    checkSession();
    if (earlyPolls >= 6) clearInterval(earlyPollTimer);
}, 500);

// ============================================
// INIT
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    resizeCanvas();
    checkSession();
    startAnimation();

    const btn = document.getElementById('sound-toggle');
    if (btn) {
        const enabled = SoundKit.isEnabled();
        btn.innerHTML = enabled
            ? '<i class="fa-solid fa-volume-high"></i>'
            : '<i class="fa-solid fa-volume-xmark"></i>';
        btn.classList.toggle('muted', !enabled);
    }

    setInterval(refreshBalance, 15000);
});

window.addEventListener('beforeunload', () => {
    stopAnimation();
    SoundKit.stopEngine();
});
