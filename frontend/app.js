// ============================================
// BetNova — Frontend Application
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
    reconnectionDelay: 1000
});

// ---------- DOM ----------
const gameLock = document.getElementById("game-lock");
const betLock = document.getElementById("bet-lock");
const authZone = document.getElementById("auth-zone");
const userZone = document.getElementById("user-zone");
const userDisplay = document.getElementById("user-display");
const userDisplayName = document.getElementById("user-display-name");
const balanceDisplay = document.getElementById("balance-display");
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
const toast = document.getElementById("toast");

// ---------- Canvas ----------
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

// ---------- State ----------
let currentUser = null;
let myBet = null;
let lastStatus = null;

// ---------- Currency ----------
function formatKES(amount) {
    return `KES ${parseFloat(amount).toLocaleString('en-KE', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    })}`;
}

// ---------- Toast ----------
let toastTimer = null;
function showToast(message, type = 'info', duration = 3000) {
    toast.innerText = message;
    toast.className = `toast ${type}`;
    toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add('hidden'), duration);
}

// ---------- Feed ----------
function appendFeed(message, type = "info") {
    const log = document.createElement("div");
    log.className = `feed-item ${type === 'alert' ? 'feed-alert' : type === 'success' ? 'feed-success' : ''}`;
    log.innerText = message;
    feedContainer.prepend(log);
    while (feedContainer.children.length > 40) {
        feedContainer.removeChild(feedContainer.lastChild);
    }
}

// ---------- Modals ----------
function openModal(id) { document.getElementById(id).classList.remove("hidden"); }
function closeModal(id) { document.getElementById(id).classList.add("hidden"); }

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

// ---------- Session ----------
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

// ---------- Bet Shortcuts ----------
function setBet(amount) {
    betInput.value = amount;
}

function setDeposit(amount) {
    document.getElementById("deposit-amount").value = amount;
}

// ---------- PayHero: Deposit ----------
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

// ---------- PayHero: Withdraw ----------
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

// ---------- Canvas Drawing ----------
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

    // Flight path
    ctx.beginPath();
    ctx.strokeStyle = "#ef4444";
    ctx.lineWidth = 4;
    ctx.shadowBlur = 20;
    ctx.shadowColor = "rgba(239, 68, 68, 0.7)";
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.moveTo(startX, startY);

    let targetX = startX;
    let targetY = startY;

    for (let i = 0; i <= 100; i++) {
        const step = i / 100;
        if (step > progress) break;
        const x = startX + (maxX - startX) * step;
        const y = startY - (startY - maxY) * Math.pow(step, 1.8);
        ctx.lineTo(x, y);
        targetX = x;
        targetY = y;
    }
    ctx.stroke();

    // Glow trail
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.3)';
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    for (let i = 0; i <= 100; i++) {
        const step = i / 100;
        if (step > progress) break;
        const x = startX + (maxX - startX) * step;
        const y = startY - (startY - maxY) * Math.pow(step, 1.8);
        ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Plane node
    ctx.fillStyle = "#ffffff";
    ctx.shadowBlur = 25;
    ctx.shadowColor = "rgba(255, 255, 255, 0.9)";
    ctx.beginPath();
    ctx.arc(targetX, targetY, 7, 0, 2 * Math.PI);
    ctx.fill();

    // Pulse ring
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "rgba(255,255,255,0.4)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(targetX, targetY, 16, 0, 2 * Math.PI);
    ctx.stroke();
}

function clearCanvas() {
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);
}

// ---------- Button State ----------
function updateButtonStates(state) {
    if (!currentUser || !state) {
        placeBetBtn.disabled = true;
        cashoutBtn.disabled = true;
        return;
    }

    if (state.status === "WAITING") {
        placeBetBtn.disabled = !!myBet;
        placeBetBtn.innerText = myBet ? "Bet Placed ✓" : "Place Bet";
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
            cashoutBtn.innerText = "Cashed Out ✓";
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

// ---------- Socket Events ----------
socket.on("connect", () => {
    console.log("✅ Socket connected:", socket.id);
});

socket.on("disconnect", (reason) => {
    console.log("❌ Socket disconnected:", reason);
});

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
    } else if (state.status === "FLYING") {
        multiplierText.innerHTML = `${state.multiplier.toFixed(2)}<span class="text-4xl">x</span>`;
        multiplierText.style.color = "#ffffff";
        multiplierText.classList.remove('won', 'crashed');
        statusText.innerText = "In Flight";
        const progress = Math.min(1, (state.multiplier - 1) / 9);
        drawFlightLine(progress);

        // Auto-cashout check
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
    showToast(`Bet placed: ${formatKES(amount)}`, "success");
    updateButtonStates(lastStatus);
});

socket.on("bet_cashed", ({ payout, multiplier }) => {
    if (myBet) {
        myBet.cashedOut = true;
        myBet.cashoutMultiplier = multiplier;
    }
    showToast(`Cashed out at ${multiplier.toFixed(2)}x for ${formatKES(payout)}`, "success", 4000);
    updateButtonStates(lastStatus);
});

socket.on("bet_lost", ({ amount }) => {
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

// ---------- Button Handlers ----------
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

// ---------- Init ----------
document.addEventListener("DOMContentLoaded", () => {
    checkSession();
    setInterval(refreshBalance, 15000);
});
