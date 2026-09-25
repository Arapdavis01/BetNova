// ---------- Socket & DOM Bindings ----------
const API_BASE = "http://localhost:5000";
const socket = io(API_BASE);

const gameLock = document.getElementById("game-lock");
const betLock = document.getElementById("bet-lock");
const authZone = document.getElementById("auth-zone");
const userZone = document.getElementById("user-zone");
const userDisplay = document.getElementById("user-display");
const balanceDisplay = document.getElementById("balance-display");
const multiplierText = document.getElementById("multiplier-text");
const statusText = document.getElementById("status-text");
const feedContainer = document.getElementById("feed-container");
const crashHistoryEl = document.getElementById("crash-history");
const activeCountEl = document.getElementById("active-count");
const betStatusEl = document.getElementById("bet-status");
const betInput = document.getElementById("bet-input");
const placeBetBtn = document.getElementById("place-bet-btn");
const cashoutBtn = document.getElementById("cashout-btn");

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

// ---------- Session State ----------
let currentUser = null;   // { userId, username }
let myBet = null;         // { amount, cashedOut }
let lastStatus = null;

// ---------- Feed ----------
function appendFeed(message, type = "info") {
    const log = document.createElement("div");
    const colorClass =
        type === "alert" ? "text-red-400" :
        type === "success" ? "text-green-400" :
        "text-gray-300";
    log.className = `p-2 bg-[#1e2235] rounded border border-[#2d314a] ${colorClass}`;
    log.innerText = `[${new Date().toLocaleTimeString()}] ${message}`;
    feedContainer.prepend(log);

    // Trim old entries
    while (feedContainer.children.length > 40) {
        feedContainer.removeChild(feedContainer.lastChild);
    }
}

// ---------- Modals ----------
function openModal(id) { document.getElementById(id).classList.remove("hidden"); }
function closeModal(id) { document.getElementById(id).classList.add("hidden"); }

// ---------- Session Handling ----------
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
        userDisplay.innerText = user;
        balanceDisplay.innerText = `$${parseFloat(balance || "0").toFixed(2)}`;
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
        balanceDisplay.innerText = `$${parseFloat(data.balance).toFixed(2)}`;
    } catch (_) { /* silent */ }
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
            alert(data.error || "Authentication structural mismatch.");
            return;
        }

        if (type === "signin") {
            localStorage.setItem("betnova_user", data.username);
            localStorage.setItem("betnova_userid", data.userId);
            localStorage.setItem("betnova_token", data.token);
            localStorage.setItem("betnova_balance", data.balance);
            closeModal("signin-modal");
            checkSession();
            appendFeed(`Session initialized for user: ${data.username}`, "success");
        } else {
            alert("Account registered successfully! Proceeding to Sign In.");
            closeModal("signup-modal");
            openModal("signin-modal");
        }
    } catch (err) {
        alert("Cannot resolve network route connection to database backend.");
    }
}

function handleLogout() {
    localStorage.clear();
    checkSession();
    appendFeed("Active user session terminated.", "alert");
}

// ---------- Canvas Drawing ----------
function drawFlightLine(progress) {
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    const startX = 50;
    const startY = canvasHeight - 50;
    const maxX = canvasWidth - 50;
    const maxY = 50;

    ctx.beginPath();
    ctx.strokeStyle = "#ef4444";
    ctx.lineWidth = 4;
    ctx.shadowBlur = 15;
    ctx.shadowColor = "rgba(239, 68, 68, 0.5)";
    ctx.moveTo(startX, startY);

    let targetX = startX;
    let targetY = startY;

    for (let i = 0; i <= 100; i++) {
        const step = i / 100;
        if (step > progress) break;
        const x = startX + (maxX - startX) * step;
        const y = startY - (startY - maxY) * Math.pow(step, 2);
        ctx.lineTo(x, y);
        targetX = x;
        targetY = y;
    }
    ctx.stroke();

    // Airplane node
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(targetX, targetY, 6, 0, 2 * Math.PI);
    ctx.fill();

    // Pulse ring
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(targetX, targetY, 12, 0, 2 * Math.PI);
    ctx.stroke();
}

// ---------- UI State Helpers ----------
function updateButtonStates(state) {
    const authed = !!currentUser;

    if (!authed) {
        placeBetBtn.disabled = true;
        cashoutBtn.disabled = true;
        return;
    }

    if (!state) {
        placeBetBtn.disabled = true;
        cashoutBtn.disabled = true;
        return;
    }

    if (state.status === "WAITING") {
        placeBetBtn.disabled = !!myBet;
        placeBetBtn.innerText = myBet ? "Bet Placed" : "Place Bet";
        cashoutBtn.disabled = true;
        cashoutBtn.innerText = "Cash Out";
        betStatusEl.innerText = myBet ? `Bet locked: $${myBet.amount.toFixed(2)}` : "No active bet";
    } else if (state.status === "FLYING") {
        placeBetBtn.disabled = true;
        placeBetBtn.innerText = "Round Live";
        if (myBet && !myBet.cashedOut) {
            cashoutBtn.disabled = false;
            const payout = (myBet.amount * state.multiplier).toFixed(2);
            cashoutBtn.innerText = `Cash Out $${payout}`;
            betStatusEl.innerText = `Live bet: $${myBet.amount.toFixed(2)}`;
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
        placeBetBtn.innerText = "Crashed";
        cashoutBtn.disabled = true;
        cashoutBtn.innerText = "Cash Out";
    }
}

// ---------- Socket Events ----------
socket.on("betnova_tick", (state) => {
    lastStatus = state;

    if (!currentUser) {
        updateButtonStates(state);
        return;
    }

    if (state.status === "WAITING") {
        multiplierText.innerText = `Starts in ${state.timer}s`;
        multiplierText.style.color = "#f59e0b";
        statusText.innerText = "Waiting for takeoff";
        ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    } else if (state.status === "FLYING") {
        multiplierText.innerText = `${state.multiplier.toFixed(2)}x`;
        multiplierText.style.color = "#ffffff";
        statusText.innerText = "In flight — cash out before crash";
        const progress = Math.min(1, (state.multiplier - 1) / 9);
        drawFlightLine(progress);
    } else if (state.status === "CRASHED") {
        multiplierText.innerText = `FLEW AWAY AT ${state.multiplier.toFixed(2)}x`;
        multiplierText.style.color = "#ef4444";
        statusText.innerText = "Crashed — next round soon";
        drawFlightLine(1);
    }

    updateButtonStates(state);
});

socket.on("active_bets_count", (count) => {
    activeCountEl.innerText = count;
});

socket.on("crash_history", (history) => {
    if (!history || history.length === 0) {
        crashHistoryEl.innerHTML = `<span class="text-xs text-gray-500">— no data —</span>`;
        return;
    }
    crashHistoryEl.innerHTML = history.map(v => {
        const color = v >= 2 ? "text-green-400" : v >= 1.5 ? "text-yellow-400" : "text-red-400";
        return `<span class="text-xs px-2 py-0.5 rounded bg-[#1e2235] border border-[#2d314a] ${color} font-bold">${v.toFixed(2)}x</span>`;
    }).join("");
});

socket.on("balance_update", (balance) => {
    localStorage.setItem("betnova_balance", balance);
    balanceDisplay.innerText = `$${parseFloat(balance).toFixed(2)}`;
});

socket.on("bet_placed", ({ amount }) => {
    myBet = { amount, cashedOut: false, cashoutMultiplier: null };
    appendFeed(`Bet placed: $${amount.toFixed(2)}`, "success");
    updateButtonStates(lastStatus);
});

socket.on("bet_cashed", ({ payout, multiplier }) => {
    if (myBet) {
        myBet.cashedOut = true;
        myBet.cashoutMultiplier = multiplier;
    }
    appendFeed(`Cashed out at ${multiplier.toFixed(2)}x for $${payout.toFixed(2)}`, "success");
    updateButtonStates(lastStatus);
});

socket.on("bet_lost", ({ amount }) => {
    appendFeed(`Bet lost: $${amount.toFixed(2)}`, "alert");
    myBet = null;
    updateButtonStates(lastStatus);
});

socket.on("bet_error", (msg) => {
    alert(msg);
});

socket.on("feed", ({ msg, type }) => {
    appendFeed(msg, type);
});

// ---------- Button Handlers ----------
placeBetBtn.addEventListener("click", () => {
    if (!currentUser) return;
    const amount = parseFloat(betInput.value);
    if (!amount || amount <= 0) {
        alert("Enter a valid bet amount.");
        return;
    }
    socket.emit("place_bet", { userId: currentUser.userId, amount });
});

cashoutBtn.addEventListener("click", () => {
    if (!currentUser) return;
    socket.emit("cash_out");
});

// ---------- Init ----------
document.addEventListener("DOMContentLoaded", checkSession);

// Periodic balance resync (in case of missed socket updates)
setInterval(refreshBalance, 15000);
