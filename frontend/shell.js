// ============================================
// BetNova — Shared Shell Logic
// Session · Wallet · Bet Slip · Referral · KYC · Live Wins
// Shared across: home, aviator, sports, crash, cashier, promotions
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

// ---------- Socket ----------
const socket = io(API_BASE || undefined, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000
});

// ============================================
// GLOBAL STATE
// ============================================
let currentUser = null;
let currentCategory = 'featured';
let userSnapshot = null;
let pendingAuthAction = null;
let pendingSelection = null;

// ---------- Storage Keys ----------
const LS = {
    USER: 'betnova_user',
    USERID: 'betnova_userid',
    TOKEN: 'betnova_token',
    BALANCE: 'betnova_balance',
    REF: 'betnova_ref',
    SOUND: 'betnova_sound',
    BETSLIP: 'betnova_betslip',
    PENDING_SELECTION: 'betnova_pending_selection'
};

// ============================================
// EVENT BUS (cross-page communication)
// ============================================
const bus = new EventTarget();

function emitEvent(name, detail) {
    bus.dispatchEvent(new CustomEvent(name, { detail }));
    // Also fire on window so page scripts can listen with addEventListener
    try {
        window.dispatchEvent(new CustomEvent(name, { detail }));
    } catch (_) {}
}

// ============================================
// UTILITIES
// ============================================
function formatKES(n) {
    return parseFloat(n || 0).toLocaleString('en-KE', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
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

function pickAvatarColor(seed) {
    const colors = ['#ef4444', '#10b981', '#3b82f6', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4'];
    let hash = 0;
    for (let i = 0; i < (seed || '').length; i++) {
        hash = seed.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
}

// ============================================
// MODAL HELPERS
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
    if (e.target.classList && e.target.classList.contains('shell-modal')) {
        e.target.classList.add('hidden');
    }
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        document.querySelectorAll('.shell-modal:not(.hidden)').forEach(m => m.classList.add('hidden'));
        document.getElementById('shell-user-menu')?.classList.add('hidden');
        document.getElementById('mobile-menu')?.classList.remove('open');
        document.getElementById('mobile-overlay')?.classList.add('hidden');
    }
});

// ============================================
// REFERRAL CAPTURE
// ============================================
function captureReferralCode() {
    const params = new URLSearchParams(window.location.search);
    const ref = params.get('ref') || params.get('referral');
    if (ref && typeof ref === 'string' && ref.length > 0 && ref.length <= 20) {
        localStorage.setItem(LS.REF, ref.toUpperCase());
        console.log('[Referral] Captured code:', ref.toUpperCase());
    }
}

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
    const user = localStorage.getItem(LS.USER);
    const userId = localStorage.getItem(LS.USERID);
    const token = localStorage.getItem(LS.TOKEN);
    const balance = localStorage.getItem(LS.BALANCE);

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
        userSnapshot = null;
        document.getElementById('shell-auth-zone')?.classList.remove('hidden');
        const userZone = document.getElementById('shell-user-zone');
        userZone?.classList.add('hidden');
        userZone?.classList.remove('flex');
    }

    // Notify all listeners (crash.js, aviator.js, sports.js, etc.)
    emitEvent('session:changed', { user: currentUser });
}

async function refreshBalance() {
    if (!currentUser) return;
    try {
        const res = await fetch(`${API_BASE}/api/me/${currentUser.userId}`);
        if (!res.ok) return;
        const data = await res.json();
        userSnapshot = data;
        localStorage.setItem(LS.BALANCE, data.balance);
        const balEl = document.getElementById('shell-balance');
        if (balEl) balEl.innerText = formatKES(data.balance);
        updateSessionUI();
    } catch (_) {}
}

function updateSessionUI() {
    if (!userSnapshot) return;

    const avatar = document.getElementById('shell-avatar');
    if (avatar && userSnapshot.username) {
        avatar.innerText = userSnapshot.username.charAt(0).toUpperCase();
    }

    const fields = {
        'profile-name': userSnapshot.username || '—',
        'profile-balance': `KES ${formatKES(userSnapshot.balance)}`,
        'profile-bonus': `KES ${formatKES(userSnapshot.bonusBalance || 0)}`,
        'user-referral-code': userSnapshot.referralCode || '—'
    };

    Object.entries(fields).forEach(([id, text]) => {
        const el = document.getElementById(id);
        if (el) el.innerText = text;
    });

    const profileKyc = document.getElementById('profile-kyc');
    if (profileKyc) {
        const levels = ['Unverified', 'Email Verified', 'Email + Phone', 'Full KYC'];
        profileKyc.innerText = levels[userSnapshot.kycLevel || 0];
    }
}

// ============================================
// AUTH — SIGN IN / SIGN UP
// ============================================
async function handleAuth(event, type) {
    event.preventDefault();
    const username = document.getElementById(`${type}-user`).value.trim();
    const password = document.getElementById(`${type}-pass`).value;

    const submitBtn = event.target.querySelector('button[type="submit"]');
    const originalText = submitBtn ? submitBtn.innerText : null;
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerText = type === 'signin' ? 'Signing in...' : 'Creating account...';
    }

    try {
        const body = { username, password };

        if (type === 'signup') {
            const refCode = localStorage.getItem(LS.REF);
            if (refCode) body.referralCode = refCode;
        }

        const res = await fetch(`${API_BASE}/api/${type}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json();

        if (!res.ok) {
            showToast(data.error || 'Authentication failed', 'error');
            return;
        }

        if (type === 'signin') {
            localStorage.setItem(LS.USER, data.username);
            localStorage.setItem(LS.USERID, data.userId);
            localStorage.setItem(LS.TOKEN, data.token);
            localStorage.setItem(LS.BALANCE, data.balance);

            closeModal('signin-modal');
            checkSession();
            showToast(`Welcome back, ${data.username}!`, 'success');

            restorePendingSelection();

            if (typeof pendingAuthAction === 'function') {
                const action = pendingAuthAction;
                pendingAuthAction = null;
                try { action(); } catch (_) {}
            }
        } else {
            localStorage.removeItem(LS.REF);

            if (data.signupBonus && data.signupBonus > 0) {
                showToast(
                    `Welcome! You received a KES ${formatKES(data.signupBonus)} signup bonus. Sign in to play!`,
                    'success',
                    6000
                );
            } else {
                showToast('Account created. Please sign in.', 'success');
            }

            closeModal('signup-modal');
            openModal('signin-modal');
        }
    } catch (err) {
        console.error('Auth error:', err);
        showToast('Network error — try again', 'error');
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerText = originalText || (type === 'signin' ? 'Sign In' : 'Create Account');
        }
    }
}

function handleLogout() {
    if (currentUser) {
        fetch(`${API_BASE}/api/logout`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser.userId })
        }).catch(() => {});
    }
    localStorage.removeItem(LS.USER);
    localStorage.removeItem(LS.USERID);
    localStorage.removeItem(LS.TOKEN);
    localStorage.removeItem(LS.BALANCE);
    location.reload();
}

// ============================================
// AUTH PROMPT — opens Sign In with a custom action
// ============================================
function requireAuth(action = null, message = 'Sign in to continue') {
    if (currentUser) {
        if (typeof action === 'function') action();
        return true;
    }

    pendingAuthAction = action;
    showSignInPrompt(message);
    return false;
}

function showSignInPrompt(message) {
    const signinTitle = document.querySelector('#signin-modal h3');
    if (signinTitle) signinTitle.innerText = message || 'Sign In';

    openModal('signin-modal');

    setTimeout(() => {
        document.getElementById('signin-user')?.focus();
    }, 100);
}

// ============================================
// SHARED BET SLIP (localStorage-backed)
// ============================================
function getBetSlip() {
    try {
        return JSON.parse(localStorage.getItem(LS.BETSLIP) || '[]');
    } catch (_) {
        return [];
    }
}

function saveBetSlip(slip) {
    localStorage.setItem(LS.BETSLIP, JSON.stringify(slip));
    emitEvent('betslip:changed', { slip });
    updateBetslipBadge();
}

function addToBetSlip(selection) {
    const slip = getBetSlip();
    const existingIdx = slip.findIndex(s => s.matchExternalId === selection.matchExternalId);

    if (existingIdx >= 0) {
        if (slip[existingIdx].pick === selection.pick) {
            slip.splice(existingIdx, 1);
        } else {
            slip[existingIdx] = selection;
        }
    } else {
        if (slip.length >= 20) {
            showToast('Maximum 20 selections per bet', 'error');
            return false;
        }
        slip.push(selection);
    }

    saveBetSlip(slip);
    return true;
}

function removeFromBetSlip(matchExternalId) {
    const slip = getBetSlip().filter(s => s.matchExternalId !== matchExternalId);
    saveBetSlip(slip);
}

// ✅ Canonical name — this is what the export uses
function clearSharedBetSlip() {
    saveBetSlip([]);
}

function getBetSlipCount() {
    return getBetSlip().length;
}

function updateBetslipBadge() {
    const count = getBetSlipCount();
    document.querySelectorAll('.spo-betslip-count, .shell-betslip-count, #betslip-count').forEach(el => {
        el.innerText = count;
        el.dataset.count = count;
    });
    document.querySelectorAll('#betslip-count-badge').forEach(el => {
        el.innerText = count;
    });
}

// ============================================
// PENDING SELECTION
// ============================================
function storePendingSelection(selection) {
    localStorage.setItem(LS.PENDING_SELECTION, JSON.stringify(selection));
}

function restorePendingSelection() {
    const raw = localStorage.getItem(LS.PENDING_SELECTION);
    if (!raw) return;

    try {
        const pending = JSON.parse(raw);
        localStorage.removeItem(LS.PENDING_SELECTION);

        if (addToBetSlip(pending)) {
            showToast(
                `Saved to bet slip: ${pending.homeTeam} vs ${pending.awayTeam}`,
                'success',
                3500
            );
        }
    } catch (err) {
        console.error('Failed to restore pending selection:', err);
    }
}

// ============================================
// HANDLE ODD CLICK FROM ANY PAGE
// ============================================
function handleOddClick(selection) {
    if (!currentUser) {
        storePendingSelection(selection);

        requireAuth(
            () => {
                addToBetSlip(selection);
            },
            'Sign in to save your bet'
        );
        return;
    }

    if (addToBetSlip(selection)) {
        showToast(
            `${selection.homeTeam} vs ${selection.awayTeam} added`,
            'success',
            1800
        );
    }
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

    const btn = event?.target;
    const originalText = btn?.innerHTML;
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sending...';
    }

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
        setTimeout(refreshBalance, 8000);
    } catch (e) {
        showToast('Network error', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalText || '<i class="fa-solid fa-bolt"></i> Send M-Pesa Request';
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

    const btn = event?.target;
    const originalText = btn?.innerHTML;
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Processing...';
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
                closeModal('withdraw-modal');
                openModal('kyc-modal');
                return showToast('Verify your email to withdraw', 'error', 4000);
            }
            if (data.code === 'WAGERING_REQUIRED') {
                return showToast(data.error, 'error', 5000);
            }
            return showToast(data.error || 'Withdrawal failed', 'error');
        }

        showToast('Withdrawal sent successfully', 'success', 5000);
        closeModal('withdraw-modal');
        setTimeout(refreshBalance, 2000);
    } catch (e) {
        showToast('Network error', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalText || '<i class="fa-solid fa-money-bill-transfer"></i> Withdraw to M-Pesa';
        }
    }
}

// ============================================
// KYC — EMAIL OTP
// ============================================
async function sendOTP() {
    if (!currentUser) return;
    const emailEl = document.getElementById('kyc-email');
    if (!emailEl) return;

    const email = emailEl.value.trim();
    if (!email) return showToast('Enter your email', 'error');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
        return showToast('Enter a valid email address', 'error');
    }

    const btn = event?.target;
    const originalText = btn?.innerHTML;
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sending...';
    }

    try {
        const res = await fetch(`${API_BASE}/api/kyc/send-otp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser.userId, email })
        });
        const data = await res.json();
        if (!res.ok) return showToast(data.error || 'Failed', 'error');

        showToast('Code sent. Check your inbox.', 'success');
        document.getElementById('kyc-step-1')?.classList.add('hidden');
        document.getElementById('kyc-step-2')?.classList.remove('hidden');
    } catch (e) {
        showToast('Network error', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalText || '<i class="fa-solid fa-paper-plane"></i> Send Code';
        }
    }
}

async function verifyOTP() {
    if (!currentUser) return;
    const email = document.getElementById('kyc-email')?.value.trim();
    const code = document.getElementById('kyc-code')?.value.trim();
    if (!code || code.length !== 6) return showToast('Enter 6-digit code', 'error');

    const btn = event?.target;
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
        if (!res.ok) return showToast(data.error || 'Invalid code', 'error');

        showToast('Email verified!', 'success');
        closeModal('kyc-modal');
        refreshBalance();

        setTimeout(() => {
            document.getElementById('kyc-step-1')?.classList.remove('hidden');
            document.getElementById('kyc-step-2')?.classList.add('hidden');
            const codeInput = document.getElementById('kyc-code');
            if (codeInput) codeInput.value = '';
        }, 500);
    } catch (e) {
        showToast('Network error', 'error');
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
// SOCKET — BALANCE UPDATE
// ============================================
socket.on('balance_update', (balance) => {
    localStorage.setItem(LS.BALANCE, balance);
    const el = document.getElementById('shell-balance');
    if (el) el.innerText = formatKES(balance);
    if (userSnapshot) userSnapshot.balance = balance;
});

// ============================================
// SOCKET — LIVE WINS FEED
// ============================================
const liveWins = [];
const MAX_LIVE_WINS = 8;

socket.on('feed', ({ msg, type }) => {
    if (type !== 'success') return;

    const match = msg.match(/^(.+?) cashed out at ([\d.]+)x for KES ([\d,.]+)/);
    if (!match) return;

    const username = match[1].replace(/\s+/g, ' ').trim();
    const multi = parseFloat(match[2]);
    const amount = parseFloat(match[3].replace(/,/g, ''));

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
// JACKPOT TICKER
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
// SEARCH
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
// NAV HIGHLIGHT
// ============================================
function highlightCurrentPage() {
    const path = window.location.pathname;
    const normalized = path.startsWith('/sports') ? '/soccer' + path.slice(7) : path;

    document.querySelectorAll('.shell-nav-link, .shell-bottom-item, .shell-mobile-links a, .spo-quick-nav a, .spo-bottom-item, .avi-quick-nav a, .cr-quick-nav a, .cr-bottom-item').forEach(link => {
        const href = link.getAttribute('href');
        if (!href) return;
        const hrefNorm = href.startsWith('/sports') ? '/soccer' + href.slice(7) : href;

        const isActive = hrefNorm === normalized
            || (hrefNorm === '/' && normalized === '/')
            || (hrefNorm !== '/' && normalized.startsWith(hrefNorm));

        if (isActive) {
            link.classList.add('active');
        } else {
            link.classList.remove('active');
        }
    });
}

// ============================================
// SOCKET LIFECYCLE
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

socket.on('reconnect', () => {
    console.log('[Shell] Reconnected');
    refreshBalance();
});

// ============================================
// INIT
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    captureReferralCode();
    checkSession();
    setInterval(refreshBalance, 15000);

    initCategoryFilter();
    initSearch();
    highlightCurrentPage();
    updateBetslipBadge();

    renderLiveWins();
    bumpJackpot();
    setInterval(bumpJackpot, 2000);

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

// ============================================
// GLOBAL EXPORTS
// ============================================
window.BetNova = {
    // State
    get user() { return currentUser; },
    get socket() { return socket; },
    API_BASE,

    // Utilities
    formatKES,
    escapeHtml,
    showToast,
    pickAvatarColor,

    // Modals
    openModal,
    closeModal,
    toggleMobileMenu,
    toggleUserMenu,

    // Session
    checkSession,
    refreshBalance,
    handleAuth,
    handleLogout,
    requireAuth,
    showSignInPrompt,

    // Bet slip
    getBetSlip,
    addToBetSlip,
    removeFromBetSlip,
    clearSharedBetSlip,          // ✅ FIXED — now points to the real function
    getBetSlipCount,
    handleOddClick,
    updateBetslipBadge,

    // Payments
    handleDeposit,
    handleWithdraw,

    // KYC
    sendOTP,
    verifyOTP,
    saveLimits,

    // Events
    bus,
    emitEvent
};
