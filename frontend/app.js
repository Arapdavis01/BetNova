// ============================================
// BetNova — Frontend Application
// Complete: Phase 1 + 2 + 3 (Email OTP)
// ============================================

// ---------- API Base Detection ----------
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
    reconnectionDelay: 1000
});

// ============================================
// DOM BINDINGS
// ============================================

// Auth & session
const gameLock = document.getElementById("game-lock");
const betLock = document.getElementById("bet-lock");
const authZone = document.getElementById("auth-zone");
const userZone = document.getElementById("user-zone");
const userDisplay = document.getElementById("user-display");
const userDisplayName = document.getElementById("user-display-name");
const balanceDisplay = document.getElementById("balance-display");

// Game
const multiplierText = document.getElementById("multiplier-text");
const statusText = document.getElementById("status-text");
const feedContainer = document.getElementById("feed-container");
const crashHistoryEl = document.getElementById("crash-history");
const activeCountEl = document.getElementById("active-count");
const betStatusEl = document.getElementById("bet-status");
const betInput = document.getElementById("bet-input");
const autoCashoutInput = document.getElementById("auto-cashout");
const placeBetBtn = document.getElementById("place-bet-btn");
const cashoutBtn = document.getElementById("cashout-btn");

// Provably fair
const pfRound = document.getElementById("pf-round");
const pfHash = document.getElementById("pf-hash");

// Chat
const chatMessagesEl = document.getElementById("chat-messages");
const chatInput = document.getElementById("chat-input");
const chatOnlineEl = document.getElementById("chat-online");

// Toast
const toast = document.getElementById("toast");

// ============================================
// CANVAS INIT
// ============================================
const canvas = document.getElementById("flight-canvas");
const ctx = canvas.getContext("2d");
let canvasWidth = canvas.clientWidth;
let canvasHeight = canvas.clientHeight;
canvas.width = canvasWidth;
canvas.height = canvasHeight;

window.addEventListener("resize", () => {
    canvasWidth = canvas.clientWidth;
    canvasHeight = canvas.clientHeight;
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
});

// ============================================
// STATE
// ============================================
let currentUser = null;
let myBet = null;
let lastStatus = null;
let currentCommit = null;
let currentReveal = null;
let lastTimerTick = null;

// ============================================
// SOUND MANAGER
// ============================================
const sounds = {
    cashout: new Audio('sounds/cashout.mp3'),
    crash: new Audio('sounds/crash.mp3'),
    tick: new Audio('sounds/tick.mp3'),
    placeBet: new Audio('sounds/place-bet.mp3')
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
// UTILITIES
// ============================================

function formatKES(amount) {
    return `KES ${parseFloat(amount).toLocaleString('en-KE', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    })}`;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ---------- Toast ----------
let toastTimer = null;
function showToast(message, type = 'info', duration = 3000) {
    if (!toast) return;
    toast.innerText = message;
    toast.className = `toast ${type}`;
    toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add('hidden'), duration);
}

// ---------- Feed ----------
function appendFeed(message, type = "info") {
    if (!feedContainer) return;
    const log = document.createElement("div");
    log.className = `feed-item ${type === 'alert' ? 'feed-alert' : type === 'success' ? 'feed-success' : ''}`;
    log.innerText = message;
    feedContainer.prepend(log);
    while (feedContainer.children.length > 40) {
        feedContainer.removeChild(feedContainer.lastChild);
    }
}

// ---------- Modals ----------
function openModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.remove("hidden");
}
function closeModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add("hidden");
}

document.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-overlay')) {
        e.target.classList.add('hidden');
    }
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        document.querySelectorAll('.modal-overlay:not(.hidden)').forEach(m => m.classList.add('hidden'));
    }
});

// ============================================
// SESSION
// ============================================

function checkSession() {
    const user = localStorage.getItem("betnova_user");
    const userId = localStorage.getItem("betnova_userid");
    const token = localStorage.getItem("betnova_token");
    const balance = localStorage.getItem("betnova_balance");

    if (token && user && userId) {
        currentUser = { userId, username: user };
        gameLock.classList.add("hidden");
        betLock.classList.add("hidden");
        authZone.classList.add("hidden");
        userZone.classList.remove("hidden");
        userZone.classList.add("flex");
        userDisplay.innerText = user.charAt(0).toUpperCase();
        userDisplayName.innerText = user;
        balanceDisplay.innerText = formatKES(balance || 0);
        refreshBalance();
        loadResponsibleStatus();

        // Join chat presence
        socket.emit('chat_join', { username: user });
    } else {
        currentUser = null;
        myBet = null;
        gameLock.classList.remove("hidden");
        betLock.classList.remove("hidden");
        authZone.classList.remove("hidden");
        userZone.classList.add("hidden");
        userZone.classList.remove("flex");
    }
    updateButtonStates(lastStatus);
}

async function refreshBalance() {
    if (!currentUser) return;
    try {
        const res = await fetch(`${API_BASE}/api/me/${currentUser.userId}`);
        if (!res.ok) return;
        const data = await res.json();
        localStorage.setItem("betnova_balance", data.balance);
        balanceDisplay.innerText = formatKES(data.balance);
    } catch (_) {}
}

async function handleAuth(event, type) {
    event.preventDefault();
    const username = document.getElementById(`${type}-user`).value.trim();
    const password = document.getElementById(`${type}-pass`).value;

    try {
        const res = await fetch(`${API_BASE}/api/${type}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();

        if (!res.ok) {
            showToast(data.error || "Authentication failed", "error");
            return;
        }

        if (type === "signin") {
            localStorage.setItem("betnova_user", data.username);
            localStorage.setItem("betnova_userid", data.userId);
            localStorage.setItem("betnova_token", data.token);
            localStorage.setItem("betnova_balance", data.balance);
            closeModal("signin-modal");
            checkSession();
            showToast(`Welcome back, ${data.username}!`, "success");
        } else {
            showToast("Account created. Please sign in.", "success");
            closeModal("signup-modal");
            openModal("signin-modal");
        }
    } catch (err) {
        console.error(err);
        showToast("Network error. Try again.", "error");
    }
}

function handleLogout() {
    localStorage.clear();
    checkSession();
    showToast("Signed out", "info");
}

// ============================================
// BET SHORTCUTS
// ============================================

function setBet(amount) {
    betInput.value = amount;
}

function setDeposit(amount) {
    const el = document.getElementById("deposit-amount");
    if (el) el.value = amount;
}

// ============================================
// PAYHERO: DEPOSIT
// ============================================

async function handleDeposit() {
    if (!currentUser) return showToast("Sign in first", "error");

    const amount = parseFloat(document.getElementById("deposit-amount").value);
    const phone = document.getElementById("deposit-phone").value.trim();

    if (!amount || amount < 10) return showToast("Minimum deposit is KES 10", "error");
    if (!phone) return showToast("Enter your M-Pesa phone number", "error");

    const btn = event.target;
    btn.disabled = true;
    btn.innerText = "Sending...";

    try {
        const res = await fetch(`${API_BASE}/api/payhero/deposit`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId: currentUser.userId, amount, phoneNumber: phone })
        });
        const data = await res.json();

        if (!res.ok) {
            showToast(data.error || "Deposit failed", "error");
            return;
        }

        showToast("Check your phone for the M-Pesa PIN prompt", "success", 5000);
        closeModal("deposit-modal");
    } catch (err) {
        console.error(err);
        showToast("Network error. Try again.", "error");
    } finally {
        btn.disabled = false;
        btn.innerText = "Send M-Pesa Request";
    }
}

// ============================================
// PAYHERO: WITHDRAW
// ============================================

async function handleWithdraw() {
    if (!currentUser) return showToast("Sign in first", "error");

    const amount = parseFloat(document.getElementById("withdraw-amount").value);
    const phone = document.getElementById("withdraw-phone").value.trim();

    if (!amount || amount < 50) return showToast("Minimum withdrawal is KES 50", "error");
    if (!phone) return showToast("Enter your M-Pesa phone number", "error");

    const balance = parseFloat(localStorage.getItem("betnova_balance") || 0);
    if (amount > balance) return showToast("Insufficient balance", "error");

    const btn = event.target;
    btn.disabled = true;
    btn.innerText = "Processing...";

    try {
        const res = await fetch(`${API_BASE}/api/payhero/withdraw`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId: currentUser.userId, amount, phoneNumber: phone })
        });
        const data = await res.json();

        if (!res.ok) {
            showToast(data.error || "Withdrawal failed", "error");
            return;
        }

        showToast("Withdrawal sent. Check your M-Pesa shortly.", "success", 5000);
        closeModal("withdraw-modal");
    } catch (err) {
        console.error(err);
        showToast("Network error. Try again.", "error");
    } finally {
        btn.disabled = false;
        btn.innerText = "Withdraw to M-Pesa";
    }
}

// ============================================
// CANVAS — FLIGHT PATH WITH PLANE SPRITE
// ============================================

function drawFlightLine(progress) {
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    const startX = 60;
    const startY = canvasHeight - 60;
    const maxX = canvasWidth - 60;
    const maxY = 100;

    // Grid
    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 6; i++) {
        const y = startY - (startY - maxY) * (i / 6);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvasWidth, y);
        ctx.stroke();
    }

    // Compute points along the trajectory
    const points = [];
    for (let i = 0; i <= 100; i++) {
        const step = i / 100;
        if (step > progress) break;
        const x = startX + (maxX - startX) * step;
        const y = startY - (startY - maxY) * Math.pow(step, 1.8);
        points.push({ x, y });
    }

    if (points.length > 1) {
        // Outer glow trail
        ctx.beginPath();
        ctx.strokeStyle = "rgba(239, 68, 68, 0.25)";
        ctx.lineWidth = 14;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        points.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
        ctx.stroke();

        // Bright inner line
        ctx.beginPath();
        ctx.strokeStyle = "#ef4444";
        ctx.lineWidth = 3;
        ctx.shadowBlur = 20;
        ctx.shadowColor = "rgba(239, 68, 68, 0.8)";
        points.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
        ctx.stroke();
        ctx.shadowBlur = 0;
    }

    // Draw plane at the head
    const head = points[points.length - 1];
    if (head) {
        // Particle trail
        for (let i = 1; i <= 8; i++) {
            const idx = Math.max(0, points.length - 1 - i);
            const p = points[idx];
            if (!p) continue;
            const alpha = 0.5 * (1 - i / 8);
            const radius = Math.max(4 - (i * 0.4), 0.5);
            ctx.fillStyle = `rgba(255, 200, 100, ${alpha})`;
            ctx.beginPath();
            ctx.arc(p.x, p.y, radius, 0, 2 * Math.PI);
            ctx.fill();
        }

        // Plane direction
        let angle = 0;
        if (points.length > 1) {
            const prev = points[points.length - 2];
            angle = Math.atan2(head.y - prev.y, head.x - prev.x);
        }

        ctx.save();
        ctx.translate(head.x, head.y);
        ctx.rotate(angle);

        // Plane body
        ctx.fillStyle = '#ffffff';
        ctx.shadowBlur = 15;
        ctx.shadowColor = 'rgba(255, 255, 255, 0.8)';
        ctx.beginPath();
        ctx.moveTo(14, 0);
        ctx.lineTo(-8, -7);
        ctx.lineTo(-4, 0);
        ctx.lineTo(-8, 7);
        ctx.closePath();
        ctx.fill();

        // Cockpit dot
        ctx.shadowBlur = 0;
        ctx.fillStyle = '#ef4444';
        ctx.beginPath();
        ctx.arc(2, 0, 2, 0, 2 * Math.PI);
        ctx.fill();

        ctx.restore();
    }
}

function clearCanvas() {
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);
}

// ============================================
// BUTTON STATE MACHINE
// ============================================

function updateButtonStates(state) {
    if (!currentUser || !state) {
        placeBetBtn.disabled = true;
        cashoutBtn.disabled = true;
        return;
    }

    if (state.status === "WAITING") {
        placeBetBtn.disabled = !!myBet;
        placeBetBtn.innerText = myBet ? "Bet Placed" : "Place Bet";
        cashoutBtn.disabled = true;
        cashoutBtn.innerText = "Cash Out";
        betStatusEl.innerText = myBet ? `Bet locked: ${formatKES(myBet.amount)}` : "Ready to bet";
    } else if (state.status === "FLYING") {
        placeBetBtn.disabled = true;
        placeBetBtn.innerText = "Round Live";
        if (myBet && !myBet.cashedOut) {
            cashoutBtn.disabled = false;
            const payout = (myBet.amount * state.multiplier).toFixed(2);
            cashoutBtn.innerText = `Cash Out ${formatKES(payout)}`;
            betStatusEl.innerText = `Live bet: ${formatKES(myBet.amount)}`;
        } else if (myBet && myBet.cashedOut) {
            cashoutBtn.disabled = true;
            cashoutBtn.innerText = "Cashed Out";
            betStatusEl.innerText = `Cashed out at ${myBet.cashoutMultiplier?.toFixed(2)}x`;
        } else {
            cashoutBtn.disabled = true;
            cashoutBtn.innerText = "Cash Out";
            betStatusEl.innerText = "No active bet";
        }
    } else if (state.status === "CRASHED") {
        placeBetBtn.disabled = true;
        placeBetBtn.innerText = "Next Round Soon";
        cashoutBtn.disabled = true;
        cashoutBtn.innerText = "Cash Out";
    }
}

// ============================================
// SOCKET — CONNECTION
// ============================================

socket.on("connect", () => {
    console.log("Socket connected:", socket.id);
    if (currentUser) {
        socket.emit('chat_join', { username: currentUser.username });
    }
});

socket.on("disconnect", (reason) => {
    console.log("Socket disconnected:", reason);
});

// ============================================
// SOCKET — GAME TICK
// ============================================

socket.on("betnova_tick", (state) => {
    lastStatus = state;

    if (!currentUser) {
        updateButtonStates(state);
        return;
    }

    if (state.status === "WAITING") {
        multiplierText.innerHTML = `Starts in ${state.timer}<span class="text-4xl">s</span>`;
        multiplierText.style.color = "#f59e0b";
        multiplierText.classList.remove('won', 'crashed');
        statusText.innerText = "Waiting for Takeoff";
        clearCanvas();

        // Tick sound in last 3 seconds
        if (state.timer !== lastTimerTick && state.timer >= 0 && state.timer <= 3) {
            playSound('tick');
            lastTimerTick = state.timer;
        }
    } else if (state.status === "FLYING") {
        multiplierText.innerHTML = `${state.multiplier.toFixed(2)}<span class="text-4xl">x</span>`;
        multiplierText.style.color = "#ffffff";
        multiplierText.classList.remove('won', 'crashed');
        statusText.innerText = "In Flight";
        const progress = Math.min(1, (state.multiplier - 1) / 9);
        drawFlightLine(progress);

        // Auto-cashout
        const target = parseFloat(autoCashoutInput.value);
        if (myBet && !myBet.cashedOut && target >= 1.01 && state.multiplier >= target) {
            socket.emit("cash_out");
        }
    } else if (state.status === "CRASHED") {
        multiplierText.innerHTML = `${state.multiplier.toFixed(2)}<span class="text-4xl">x</span>`;
        multiplierText.style.color = "#ef4444";
        multiplierText.classList.add('crashed');
        statusText.innerText = "Flew Away!";
        drawFlightLine(1);
    }

    updateButtonStates(state);
});

// ============================================
// SOCKET — ROUND COMMIT / REVEAL (Provably Fair)
// ============================================

socket.on('round_commit', (data) => {
    currentCommit = data;
    currentReveal = null;

    if (pfRound) pfRound.innerText = `#${data.roundId}`;
    if (pfHash) {
        pfHash.innerText = data.serverSeedHash.slice(0, 16) + '...';
        pfHash.title = data.serverSeedHash;
    }

    const vRound = document.getElementById('verify-round');
    const vHash = document.getElementById('verify-hash');
    const vSeed = document.getElementById('verify-seed');
    const vCrash = document.getElementById('verify-crash');
    const vResult = document.getElementById('verify-result');

    if (vRound) vRound.innerText = `#${data.roundId}`;
    if (vHash) vHash.innerText = data.serverSeedHash;
    if (vSeed) vSeed.innerText = 'Waiting for reveal...';
    if (vCrash) vCrash.innerText = '—';
    if (vResult) {
        vResult.className = 'mt-4 text-xs text-gray-500';
        vResult.innerText = 'Round in progress. Seed will be revealed after crash.';
    }
});

socket.on('round_reveal', async (data) => {
    currentReveal = data;

    const vSeed = document.getElementById('verify-seed');
    const vCrash = document.getElementById('verify-crash');
    const vResult = document.getElementById('verify-result');

    if (vSeed) vSeed.innerText = data.serverSeed;
    if (vCrash) vCrash.innerText = `${data.crashPoint.toFixed(2)}x`;

    if (currentCommit && currentCommit.roundId === data.roundId) {
        const hashValid = await verifySeed(data.serverSeed, currentCommit.serverSeedHash);
        const recomputed = await recomputeCrashPoint(data.serverSeed, data.roundId);
        const crashValid = Math.abs(recomputed - data.crashPoint) < 0.01;

        if (hashValid && crashValid && vResult) {
            vResult.className = 'mt-4 text-xs text-green-400 font-bold';
            vResult.innerText = 'Verified — SHA-256 hash matches and crash point reproduces correctly';
        } else if (vResult) {
            vResult.className = 'mt-4 text-xs text-red-400 font-bold';
            vResult.innerText = `Verification failed — hash=${hashValid}, crash=${crashValid}`;
        }
    }
});

// ---------- Client-side SHA-256 & HMAC Verification ----------
async function verifySeed(serverSeed, expectedHash) {
    const encoder = new TextEncoder();
    const data = encoder.encode(serverSeed);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex === expectedHash;
}

async function recomputeCrashPoint(serverSeed, roundId) {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(serverSeed),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(roundId.toString()));
    const hashArray = Array.from(new Uint8Array(signature));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    const int = parseInt(hashHex.slice(0, 8), 16);
    const float = int / 0xFFFFFFFF;
    if (float < 0.03) return 1.00;
    const crash = 1.01 / (1 - float);
    return parseFloat(Math.min(crash, 1000).toFixed(2));
}

// ============================================
// SOCKET — OTHER GAME EVENTS
// ============================================

socket.on("active_bets_count", (count) => {
    activeCountEl.innerText = count;
});

socket.on("crash_history", (history) => {
    if (!history || history.length === 0) {
        crashHistoryEl.innerHTML = `<span class="text-xs text-gray-500">No data yet</span>`;
        return;
    }
    crashHistoryEl.innerHTML = history.map(v => {
        const cls = v >= 2 ? 'high' : v >= 1.5 ? 'mid' : 'low';
        return `<span class="crash-chip ${cls}">${v.toFixed(2)}x</span>`;
    }).join("");
});

socket.on("balance_update", (balance) => {
    localStorage.setItem("betnova_balance", balance);
    balanceDisplay.innerText = formatKES(balance);
});

socket.on("bet_placed", ({ amount }) => {
    myBet = { amount, cashedOut: false, cashoutMultiplier: null };
    playSound('placeBet');
    showToast(`Bet placed: ${formatKES(amount)}`, "success");
    updateButtonStates(lastStatus);
});

socket.on("bet_cashed", ({ payout, multiplier }) => {
    if (myBet) {
        myBet.cashedOut = true;
        myBet.cashoutMultiplier = multiplier;
    }
    playSound('cashout');
    showToast(`Cashed out at ${multiplier.toFixed(2)}x for ${formatKES(payout)}`, "success", 4000);
    updateButtonStates(lastStatus);
});

socket.on("bet_lost", ({ amount }) => {
    playSound('crash');
    showToast(`Bet lost: ${formatKES(amount)}`, "error");
    myBet = null;
    updateButtonStates(lastStatus);
});

socket.on("bet_error", (msg) => {
    showToast(msg, "error");
});

socket.on("feed", ({ msg, type }) => {
    appendFeed(msg, type);
});

// ============================================
// SOCKET — CHAT
// ============================================

function renderChatMessage(msg) {
    if (!chatMessagesEl) return;
    const el = document.createElement('div');
    el.className = 'chat-msg';
    const time = new Date(msg.createdAt).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' });
    el.innerHTML = `<span class="chat-user">${escapeHtml(msg.username)}</span>
                    <span class="chat-time">${time}</span>
                    <div class="chat-text">${escapeHtml(msg.message)}</div>`;
    chatMessagesEl.appendChild(el);
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;

    while (chatMessagesEl.children.length > 100) {
        chatMessagesEl.removeChild(chatMessagesEl.firstChild);
    }
}

function sendChat() {
    if (!currentUser) return showToast('Sign in to chat', 'error');
    const input = document.getElementById('chat-input');
    const message = input.value.trim();
    if (!message) return;
    socket.emit('chat_message', {
        userId: currentUser.userId,
        username: currentUser.username,
        message
    });
    input.value = '';
}

socket.on('chat_history', (messages) => {
    if (!chatMessagesEl) return;
    chatMessagesEl.innerHTML = '';
    messages.forEach(renderChatMessage);
});

socket.on('chat_message', renderChatMessage);

socket.on('chat_online', (count) => {
    if (chatOnlineEl) chatOnlineEl.innerText = count;
});

// ============================================
// KYC — EMAIL OTP
// ============================================

async function sendOTP() {
    if (!currentUser) return showToast('Sign in first', 'error');

    const emailEl = document.getElementById('kyc-email');
    const email = emailEl ? emailEl.value.trim() : '';

    if (!email) return showToast('Enter your email address', 'error');

    // Basic client-side validation
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
        return showToast('Please enter a valid email address', 'error');
    }

    // Disable button during request
    const btn = event && event.target ? event.target : null;
    if (btn) {
        btn.disabled = true;
        btn.innerText = 'Sending...';
    }

    try {
        const res = await fetch(`${API_BASE}/api/kyc/send-otp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser.userId, email })
        });
        const data = await res.json();

        if (!res.ok) {
            showToast(data.error || 'Failed to send verification code', 'error');
            return;
        }

        showToast('Code sent. Check your email inbox.', 'success', 5000);

        // Advance to step 2
        document.getElementById('kyc-step-1').classList.add('hidden');
        document.getElementById('kyc-step-2').classList.remove('hidden');
    } catch (err) {
        console.error('Send OTP error:', err);
        showToast('Network error. Try again.', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> Send Code';
        }
    }
}

async function verifyOTP() {
    if (!currentUser) return;

    const email = document.getElementById('kyc-email').value.trim();
    const code = document.getElementById('kyc-code').value.trim();

    if (!code || code.length !== 6) {
        return showToast('Enter the 6-digit code from your email', 'error');
    }

    const btn = event && event.target ? event.target : null;
    if (btn) {
        btn.disabled = true;
        btn.innerText = 'Verifying...';
    }

    try {
        const res = await fetch(`${API_BASE}/api/kyc/verify-otp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser.userId, email, code })
        });
        const data = await res.json();

        if (!res.ok) {
            showToast(data.error || 'Invalid verification code', 'error');
            return;
        }

        showToast('Email verified successfully!', 'success');
        closeModal('kyc-modal');

        // Reset modal state for future opens
        setTimeout(() => {
            document.getElementById('kyc-step-1').classList.remove('hidden');
            document.getElementById('kyc-step-2').classList.add('hidden');
            const codeEl = document.getElementById('kyc-code');
            if (codeEl) codeEl.value = '';
        }, 500);
    } catch (err) {
        console.error('Verify OTP error:', err);
        showToast('Network error. Try again.', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerText = 'Verify';
        }
    }
}

// ============================================
// RESPONSIBLE GAMBLING
// ============================================

async function saveLimits() {
    if (!currentUser) return;
    const dailyDepositLimit = document.getElementById('limit-deposit').value;
    const dailyWagerLimit = document.getElementById('limit-wager').value;
    const sessionTimeLimit = document.getElementById('limit-session').value;

    try {
        const res = await fetch(`${API_BASE}/api/responsible/limits`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: currentUser.userId,
                dailyDepositLimit: dailyDepositLimit === '' ? null : Number(dailyDepositLimit),
                dailyWagerLimit: dailyWagerLimit === '' ? null : Number(dailyWagerLimit),
                sessionTimeLimit: sessionTimeLimit === '' ? null : Number(sessionTimeLimit)
            })
        });
        const data = await res.json();
        if (!res.ok) return showToast(data.error || 'Failed', 'error');

        showToast('Limits saved', 'success');
        closeModal('responsible-modal');
    } catch (err) {
        showToast('Network error', 'error');
    }
}

async function selfExclude(hours) {
    if (!currentUser) return;
    if (!confirm(`Self-exclude for ${hours} hours? You will not be able to bet during this period.`)) return;

    try {
        const res = await fetch(`${API_BASE}/api/responsible/self-exclude`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser.userId, durationHours: hours })
        });
        const data = await res.json();
        if (!res.ok) return showToast(data.error || 'Failed', 'error');

        showToast('Self-exclusion active', 'success');
        closeModal('responsible-modal');
        setTimeout(() => location.reload(), 2000);
    } catch (err) {
        showToast('Network error', 'error');
    }
}

async function loadResponsibleStatus() {
    if (!currentUser) return;
    try {
        const res = await fetch(`${API_BASE}/api/responsible/status/${currentUser.userId}`);
        const data = await res.json();
        if (data.selfExcluded) {
            showToast(`You are self-excluded until ${new Date(data.selfExcludedUntil).toLocaleString()}`, 'error', 8000);
            placeBetBtn.disabled = true;
        }
        if (data.limits) {
            const ld = document.getElementById('limit-deposit');
            const lw = document.getElementById('limit-wager');
            const ls = document.getElementById('limit-session');
            if (ld) ld.value = data.limits.dailyDepositLimit || '';
            if (lw) lw.value = data.limits.dailyWagerLimit || '';
            if (ls) ls.value = data.limits.sessionTimeLimit || '';
        }
    } catch (_) {}
}

// ============================================
// SUPPORT
// ============================================

async function submitTicket() {
    if (!currentUser) return;
    const category = document.getElementById('support-category').value;
    const subject = document.getElementById('support-subject').value.trim();
    const message = document.getElementById('support-message').value.trim();

    if (!subject || !message) return showToast('Fill in all fields', 'error');

    try {
        const res = await fetch(`${API_BASE}/api/support`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: currentUser.userId,
                username: currentUser.username,
                category, subject, message
            })
        });
        const data = await res.json();
        if (!res.ok) return showToast(data.error || 'Failed', 'error');

        showToast('Ticket submitted. We will respond soon.', 'success');
        closeModal('support-modal');
    } catch (err) {
        showToast('Network error', 'error');
    }
}

// ============================================
// LEADERBOARD
// ============================================

async function loadLeaderboard(period = 'daily') {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.period === period);
    });

    const list = document.getElementById('leaderboard-list');
    if (!list) return;
    list.innerHTML = `<p class="text-gray-500 text-center py-4">Loading...</p>`;

    try {
        const res = await fetch(`${API_BASE}/api/leaderboard/${period}?limit=10`);
        const data = await res.json();

        if (!data.leaders || data.leaders.length === 0) {
            list.innerHTML = `<p class="text-gray-500 text-center py-4">No winners yet</p>`;
            return;
        }

        list.innerHTML = data.leaders.map(l => {
            const rankClass = l.rank === 1 ? 'rank-1' : l.rank === 2 ? 'rank-2' : l.rank === 3 ? 'rank-3' : 'rank-other';
            const profitColor = l.totalProfit > 0 ? '#10b981' : '#ef4444';
            return `
                <div class="leaderboard-row">
                    <div class="leaderboard-rank ${rankClass}">${l.rank}</div>
                    <div class="leaderboard-name">${escapeHtml(l.username)}</div>
                    <div class="leaderboard-profit" style="color: ${profitColor}">+${formatKES(l.totalProfit)}</div>
                </div>
            `;
        }).join('');
    } catch (err) {
        console.error('Leaderboard error:', err);
        list.innerHTML = `<p class="text-red-400 text-center py-4">Failed to load</p>`;
    }
}

function currentLeaderboardPeriod() {
    const active = document.querySelector('.tab-btn.active');
    return active ? active.dataset.period : 'daily';
}

// ============================================
// BET HISTORY
// ============================================

async function openHistory() {
    if (!currentUser) return showToast('Sign in first', 'error');
    openModal('history-modal');

    const list = document.getElementById('history-list');
    if (!list) return;
    list.innerHTML = `<p class="text-gray-500 text-center py-4">Loading...</p>`;

    try {
        const res = await fetch(`${API_BASE}/api/bets/user/${currentUser.userId}?limit=30`);
        const data = await res.json();

        if (!data.bets || data.bets.length === 0) {
            list.innerHTML = `<p class="text-gray-500 text-center py-8">No bets yet</p>`;
            return;
        }

        list.innerHTML = data.bets.map(b => {
            const isWin = b.cashedOut;
            const rowClass = isWin ? 'history-row win' : 'history-row loss';
            const profitStr = b.profit >= 0 ? `+${formatKES(b.profit)}` : formatKES(b.profit);
            const profitColor = b.profit >= 0 ? '#10b981' : '#ef4444';
            const time = new Date(b.createdAt).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' });

            return `
                <div class="${rowClass}">
                    <div class="text-gray-500 font-mono text-[10px]">${time}</div>
                    <div class="text-white">${formatKES(b.amount)}</div>
                    <div class="text-gray-400 font-mono text-[11px]">${isWin ? b.cashoutMultiplier.toFixed(2) + 'x' : '—'}</div>
                    <div class="font-mono font-bold text-right" style="color: ${profitColor}">${profitStr}</div>
                </div>
            `;
        }).join('');
    } catch (err) {
        console.error('History error:', err);
        list.innerHTML = `<p class="text-red-400 text-center py-4">Failed to load</p>`;
    }
}

// ============================================
// BUTTON HANDLERS
// ============================================

placeBetBtn.addEventListener("click", () => {
    if (!currentUser) return;
    const amount = parseFloat(betInput.value);
    if (!amount || amount < 10) {
        showToast("Minimum bet is KES 10", "error");
        return;
    }
    socket.emit("place_bet", { userId: currentUser.userId, amount });
});

cashoutBtn.addEventListener("click", () => {
    if (!currentUser) return;
    socket.emit("cash_out");
});

// ============================================
// INIT
// ============================================

document.addEventListener("DOMContentLoaded", () => {
    // Inject sound toggle button
    const btn = document.createElement('button');
    btn.id = 'sound-toggle';
    btn.className = 'sound-toggle' + (soundEnabled ? '' : ' muted');
    btn.innerHTML = soundEnabled
        ? '<i class="fa-solid fa-volume-high"></i>'
        : '<i class="fa-solid fa-volume-xmark"></i>';
    btn.title = 'Toggle sound';
    btn.onclick = toggleSound;
    document.body.appendChild(btn);

    // Session + balance
    checkSession();
    setInterval(refreshBalance, 15000);

    // Leaderboard
    loadLeaderboard('daily');
    setInterval(() => loadLeaderboard(currentLeaderboardPeriod()), 30000);

    // Chat input
    if (chatInput) {
        chatInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') sendChat();
        });
    }

    // Session timeout (based on user's sessionTimeLimit)
    let sessionStart = Date.now();
    setInterval(() => {
        if (!currentUser) return;
        const limit = parseInt(document.getElementById('limit-session')?.value || 0);
        if (limit > 0) {
            const elapsed = (Date.now() - sessionStart) / 60000;
            if (elapsed >= limit) {
                showToast('Session time limit reached. Please take a break.', 'error', 10000);
                socket.disconnect();
                setTimeout(() => location.reload(), 3000);
            }
        }
    }, 60000);
});
