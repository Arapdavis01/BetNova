// ============================================
// BetNova — Shared Shell Logic
// Loaded on every page that uses the shell layout
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

// ============================================
// STATE
// ============================================
let currentUser = null;
let currentCategory = 'featured';

// ============================================
// UTILS
// ============================================
function formatKES(n) {
    return parseFloat(n || 0).toLocaleString('en-KE', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

let toastTimer = null;
function showToast(msg, type = 'info', duration = 3000) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.innerText = msg;
    t.className = `shell-toast ${type}`;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), duration);
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
    if (e.target.classList.contains('shell-modal')) {
        e.target.classList.add('hidden');
    }
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        document.querySelectorAll('.shell-modal:not(.hidden)').forEach(m => m.classList.add('hidden'));
        const menu = document.getElementById('shell-user-menu');
        if (menu) menu.classList.add('hidden');
        const mob = document.getElementById('mobile-menu');
        if (mob) mob.classList.remove('open');
        const ov = document.getElementById('mobile-overlay');
        if (ov) ov.classList.add('hidden');
    }
});

// ============================================
// MOBILE MENU
// ============================================
function toggleMobileMenu() {
    const menu = document.getElementById('mobile-menu');
    const overlay = document.getElementById('mobile-overlay');
    if (!menu || !overlay) return;
    const isOpen = menu.classList.contains('open');
    menu.classList.toggle('open', !isOpen);
    overlay.classList.toggle('hidden', isOpen);
}

// ============================================
// USER MENU
// ============================================
function toggleUserMenu() {
    const menu = document.getElementById('shell-user-menu');
    if (!menu) return;
    menu.classList.toggle('hidden');
}

document.addEventListener('click', (e) => {
    const menu = document.getElementById('shell-user-menu');
    const wrap = document.querySelector('.shell-user-menu-wrap');
    if (menu && wrap && !wrap.contains(e.target)) {
        menu.classList.add('hidden');
    }
});

// ============================================
// SESSION
// ============================================
function checkSession() {
    const user = localStorage.getItem('betnova_user');
    const userId = localStorage.getItem('betnova_userid');
    const token = localStorage.getItem('betnova_token');
    const balance = localStorage.getItem('betnova_balance');

    if (token && user && userId) {
        currentUser = { userId, username: user };
        document.getElementById('shell-auth-zone')?.classList.add('hidden');
        const userZone = document.getElementById('shell-user-zone');
        userZone?.classList.remove('hidden');
        userZone?.classList.add('flex');

        const avatar = document.getElementById('shell-avatar');
        if (avatar) avatar.innerText = user.charAt(0).toUpperCase();

        const nameEl = document.getElementById('shell-username');
        if (nameEl) nameEl.innerText = user;

        const balEl = document.getElementById('shell-balance');
        if (balEl) balEl.innerText = formatKES(balance || 0);

        refreshBalance();
        socket.emit('chat_join', { username: user });
    } else {
        currentUser = null;
        document.getElementById('shell-auth-zone')?.classList.remove('hidden');
        const userZone = document.getElementById('shell-user-zone');
        userZone?.classList.add('hidden');
        userZone?.classList.remove('flex');
    }
}

async function refreshBalance() {
    if (!currentUser) return;
    try {
        const res = await fetch(`${API_BASE}/api/me/${currentUser.userId}`);
        if (!res.ok) return;
        const data = await res.json();
        localStorage.setItem('betnova_balance', data.balance);
        const balEl = document.getElementById('shell-balance');
        if (balEl) balEl.innerText = formatKES(data.balance);
    } catch (_) {}
}

async function handleAuth(event, type) {
    event.preventDefault();
    const username = document.getElementById(`${type}-user`).value.trim();
    const password = document.getElementById(`${type}-pass`).value;

    try {
        const res = await fetch(`${API_BASE}/api/${type}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();

        if (!res.ok) {
            showToast(data.error || 'Authentication failed', 'error');
            return;
        }

        if (type === 'signin') {
            localStorage.setItem('betnova_user', data.username);
            localStorage.setItem('betnova_userid', data.userId);
            localStorage.setItem('betnova_token', data.token);
            localStorage.setItem('betnova_balance', data.balance);
            closeModal('signin-modal');
            checkSession();
            showToast(`Welcome back, ${data.username}!`, 'success');
        } else {
            showToast('Account created. Please sign in.', 'success');
            closeModal('signup-modal');
            openModal('signin-modal');
        }
    } catch (err) {
        showToast('Network error', 'error');
    }
}

function handleLogout() {
    localStorage.clear();
    location.reload();
}

// ============================================
// PAYHERO
// ============================================
async function handleDeposit() {
    if (!currentUser) return showToast('Sign in first', 'error');
    const amount = parseFloat(document.getElementById('deposit-amount').value);
    const phone = document.getElementById('deposit-phone').value.trim();
    if (!amount || amount < 10) return showToast('Minimum KES 10', 'error');
    if (!phone) return showToast('Enter M-Pesa number', 'error');

    try {
        const res = await fetch(`${API_BASE}/api/payhero/deposit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser.userId, amount, phoneNumber: phone })
        });
        const data = await res.json();
        if (!res.ok) return showToast(data.error || 'Deposit failed', 'error');
        showToast('Check your phone for the M-Pesa PIN prompt', 'success', 5000);
        closeModal('deposit-modal');
    } catch (e) {
        showToast('Network error', 'error');
    }
}

async function handleWithdraw() {
    if (!currentUser) return showToast('Sign in first', 'error');
    const amount = parseFloat(document.getElementById('withdraw-amount').value);
    const phone = document.getElementById('withdraw-phone').value.trim();
    if (!amount || amount < 50) return showToast('Minimum KES 50', 'error');
    if (!phone) return showToast('Enter M-Pesa number', 'error');

    try {
        const res = await fetch(`${API_BASE}/api/payhero/withdraw`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser.userId, amount, phoneNumber: phone })
        });
        const data = await res.json();
        if (!res.ok) return showToast(data.error || 'Withdrawal failed', 'error');
        showToast('Withdrawal sent successfully', 'success', 5000);
        closeModal('withdraw-modal');
    } catch (e) {
        showToast('Network error', 'error');
    }
}

// ============================================
// KYC
// ============================================
async function sendOTP() {
    if (!currentUser) return;
    const email = document.getElementById('kyc-email').value.trim();
    if (!email) return showToast('Enter your email', 'error');

    try {
        const res = await fetch(`${API_BASE}/api/kyc/send-otp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser.userId, email })
        });
        const data = await res.json();
        if (!res.ok) return showToast(data.error || 'Failed', 'error');
        showToast('Code sent. Check your inbox.', 'success');
        document.getElementById('kyc-step-1').classList.add('hidden');
        document.getElementById('kyc-step-2').classList.remove('hidden');
    } catch (e) {
        showToast('Network error', 'error');
    }
}

async function verifyOTP() {
    if (!currentUser) return;
    const email = document.getElementById('kyc-email').value.trim();
    const code = document.getElementById('kyc-code').value.trim();
    if (!code || code.length !== 6) return showToast('Enter 6-digit code', 'error');

    try {
        const res = await fetch(`${API_BASE}/api/kyc/verify-otp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser.userId, email, code })
        });
        const data = await res.json();
        if (!res.ok) return showToast(data.error || 'Invalid code', 'error');
        showToast('Email verified!', 'success');
        closeModal('kyc-modal');
    } catch (e) {
        showToast('Network error', 'error');
    }
}

// ============================================
// RESPONSIBLE GAMBLING
// ============================================
async function saveLimits() {
    if (!currentUser) return;
    const dep = document.getElementById('limit-deposit').value;
    const wag = document.getElementById('limit-wager').value;

    try {
        const res = await fetch(`${API_BASE}/api/responsible/limits`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: currentUser.userId,
                dailyDepositLimit: dep === '' ? null : Number(dep),
                dailyWagerLimit: wag === '' ? null : Number(wag)
            })
        });
        const data = await res.json();
        if (!res.ok) return showToast(data.error || 'Failed', 'error');
        showToast('Limits saved', 'success');
        closeModal('responsible-modal');
    } catch (e) {
        showToast('Network error', 'error');
    }
}

// ============================================
// SOCKET — BALANCE
// ============================================
socket.on('balance_update', (balance) => {
    localStorage.setItem('betnova_balance', balance);
    const el = document.getElementById('shell-balance');
    if (el) el.innerText = formatKES(balance);
});

// ============================================
// SOCKET — LIVE WINS (real events from server)
// ============================================
// The server emits `feed` events whenever a player cashes out.
// We use those to display recent wins in the live wins section.
const liveWins = [];       // Rolling window of recent wins
const MAX_LIVE_WINS = 8;

socket.on('feed', ({ msg, type }) => {
    if (type !== 'success') return;

    // Parse "username cashed out at X.XXx for KES YYY"
    const match = msg.match(/^(.+?) cashed out at ([\d.]+)x for KES ([\d,.]+)/);
    if (!match) return;

    const username = match[1].replace(/\s+/g, ' ').trim();
    const multi = parseFloat(match[2]);
    const amount = parseFloat(match[3].replace(/,/g, ''));

    // Mask username for privacy
    const maskedName = username.length > 4
        ? username.slice(0, 4) + '***'
        : username.charAt(0) + '***';

    liveWins.unshift({
        user: maskedName,
        game: 'Aviator',
        multi,
        amount,
        color: pickAvatarColor(username)
    });
    if (liveWins.length > MAX_LIVE_WINS) liveWins.pop();

    renderLiveWins();
});

function pickAvatarColor(seed) {
    const colors = ['#ef4444', '#10b981', '#3b82f6', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4'];
    let hash = 0;
    for (let i = 0; i < seed.length; i++) hash = seed.charCodeAt(i) + ((hash << 5) - hash);
    return colors[Math.abs(hash) % colors.length];
}

function renderLiveWins() {
    const container = document.getElementById('live-wins');
    if (!container) return;

    if (liveWins.length === 0) {
        container.innerHTML = `
            <div class="shell-win-card shell-win-empty">
                <i class="fa-solid fa-hourglass-half"></i>
                <span>Waiting for the first cashout...</span>
            </div>
        `;
        return;
    }

    container.innerHTML = liveWins.slice(0, 4).map(w => `
        <div class="shell-win-card">
            <div class="shell-win-avatar" style="background:${w.color}">${w.user.charAt(0).toUpperCase()}</div>
            <div class="shell-win-info">
                <p class="shell-win-user">${escapeHtml(w.user)}</p>
                <p class="shell-win-game">${w.game} · ${w.multi.toFixed(2)}x</p>
            </div>
            <div class="shell-win-amount">+KES ${formatKES(w.amount)}</div>
        </div>
    `).join('');
}

// ============================================
// JACKPOT TICKER (server-driven if available, else simulated)
// ============================================
let jackpot = 1247890;

socket.on('jackpot_update', (value) => {
    if (typeof value === 'number') {
        jackpot = value;
        const el = document.getElementById('jackpot-amount');
        if (el) el.innerText = jackpot.toLocaleString('en-KE');
    }
});

function bumpJackpot() {
    // Simulated growth — replace with server-driven value when ready
    jackpot += Math.floor(Math.random() * 500);
    const el = document.getElementById('jackpot-amount');
    if (el) el.innerText = jackpot.toLocaleString('en-KE');
}

// ============================================
// CATEGORY FILTER
// ============================================
function initCategoryFilter() {
    const btns = document.querySelectorAll('.shell-cat-btn');
    if (btns.length === 0) return;

    btns.forEach(btn => {
        btn.addEventListener('click', () => {
            btns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            const cat = btn.dataset.cat || 'featured';
            currentCategory = cat;

            const title = document.getElementById('games-section-title');
            const titles = {
                featured: 'Featured Games',
                crash: 'Crash Games',
                casino: 'Casino Games',
                virtuals: 'Virtual Sports',
                live: 'Live Games'
            };
            if (title) title.innerText = titles[cat] || 'Games';

            document.querySelectorAll('.shell-game-card').forEach(card => {
                const show = cat === 'featured' || card.dataset.cat === cat;
                card.style.display = show ? '' : 'none';
            });
        });
    });
}

// ============================================
// SEARCH (optional — only if a search input exists)
// ============================================
function initSearch() {
    const input = document.getElementById('shell-search-input');
    if (!input) return;

    input.addEventListener('input', () => {
        const q = input.value.trim().toLowerCase();

        document.querySelectorAll('.shell-game-card').forEach(card => {
            const title = card.querySelector('h3')?.innerText.toLowerCase() || '';
            const sub = card.querySelector('p')?.innerText.toLowerCase() || '';
            const matches = title.includes(q) || sub.includes(q);
            card.style.display = matches ? '' : 'none';
        });
    });
}

// ============================================
// GAME NAV HIGHLIGHT (mark current page in nav)
// ============================================
function highlightCurrentPage() {
    const path = window.location.pathname;

    document.querySelectorAll('.shell-nav-link, .shell-bottom-item, .shell-mobile-links a').forEach(link => {
        const href = link.getAttribute('href');
        if (!href) return;

        // Exact match or sub-path match
        const isActive = href === path
            || (href === '/' && path === '/')
            || (href !== '/' && path.startsWith(href));

        if (isActive) {
            link.classList.add('active');
        } else {
            link.classList.remove('active');
        }
    });
}

// ============================================
// SOCKET — CONNECT / DISCONNECT LOG
// ============================================
socket.on('connect', () => {
    console.log('[Shell] Socket connected:', socket.id);
    if (currentUser) {
        socket.emit('chat_join', { username: currentUser.username });
    }
});

socket.on('disconnect', (reason) => {
    console.log('[Shell] Socket disconnected:', reason);
});

// ============================================
// INIT
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    checkSession();
    setInterval(refreshBalance, 15000);

    initCategoryFilter();
    initSearch();
    highlightCurrentPage();

    renderLiveWins();
    bumpJackpot();
    setInterval(bumpJackpot, 2000);

    // Fallback: if no real `feed` events arrive, seed with a couple of examples
    setTimeout(() => {
        if (liveWins.length === 0) {
            liveWins.push(
                { user: 'john***', game: 'Aviator', multi: 3.35, amount: 6700, color: '#ef4444' },
                { user: 'mary***', game: 'JetX', multi: 8.12, amount: 24360, color: '#10b981' }
            );
            renderLiveWins();
        }
    }, 4000);
});
