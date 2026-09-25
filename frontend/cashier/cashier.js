// ============================================
// BetNova — Cashier Client
// Handles: deposit, withdraw, history, referral, daily bonus, wagering progress
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
    reconnectionAttempts: 10
});

// ============================================
// STATE
// ============================================
let currentUser = null;
let userSummary = null;
let refreshInterval = null;

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
    d.textContent = t;
    return d.innerHTML;
}

let toastTimer = null;
function showToast(msg, type = 'info', duration = 3000) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.innerText = msg;
    t.className = `csh-toast ${type}`;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), duration);
}

function isValidPhone(phone) {
    // Kenyan phone: 254XXXXXXXXX (12 digits) after normalization, or 0XXXXXXXXX (10 digits)
    const cleaned = phone.replace(/\s/g, '').replace(/^\+/, '');
    return /^(254\d{9}|0\d{9})$/.test(cleaned);
}

// ============================================
// SESSION
// ============================================
function checkSession() {
    const user = localStorage.getItem('betnova_user');
    const userId = localStorage.getItem('betnova_userid');
    const token = localStorage.getItem('betnova_token');
    const balance = localStorage.getItem('betnova_balance');

    if (!user || !userId || !token) {
        showToast('Sign in to access cashier', 'error');
        setTimeout(() => location.href = '/', 1500);
        return false;
    }

    currentUser = { userId, username: user };
    const balEl = document.getElementById('balance-display');
    if (balEl) balEl.innerText = formatKES(balance || 0);

    // Notify shell to sync state
    socket.emit('chat_join', { username: user });
    return true;
}

// ============================================
// TABS
// ============================================
function openTab(name) {
    document.querySelectorAll('.csh-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === name);
    });
    document.querySelectorAll('.csh-tab-content').forEach(c => {
        c.classList.toggle('active', c.dataset.content === name);
    });

    // Update URL hash for deep linking
    history.replaceState(null, '', `#${name}`);

    // Lazy-load expensive data
    if (name === 'history') loadHistory();
    if (name === 'referral') {
        // Ensure referral code exists
        if (userSummary && !userSummary.referralCode) {
            generateReferralCode();
        }
    }
}

function getInitialTab() {
    const hash = window.location.hash.replace('#', '');
    const valid = ['deposit', 'withdraw', 'history', 'referral'];
    return valid.includes(hash) ? hash : 'deposit';
}

// ============================================
// SUMMARY
// ============================================
async function loadSummary() {
    try {
        const res = await fetch(`${API_BASE}/api/wallet/summary/${currentUser.userId}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        userSummary = data;

        // Balance displays
        document.getElementById('main-balance').innerText = `KES ${formatKES(data.balance)}`;
        document.getElementById('bonus-balance').innerText = `KES ${formatKES(data.bonusBalance)}`;
        document.getElementById('total-deposited').innerText = `KES ${formatKES(data.totalDeposited)}`;
        document.getElementById('total-withdrawn').innerText = `KES ${formatKES(data.totalWithdrawn)}`;

        // Sync balance in header + localStorage
        localStorage.setItem('betnova_balance', data.balance);
        const hdrBal = document.getElementById('balance-display');
        if (hdrBal) hdrBal.innerText = formatKES(data.balance);

        // Referral stats
        document.getElementById('referral-count').innerText = data.referralCount || 0;
        document.getElementById('referral-earnings').innerText = `KES ${formatKES(data.referralEarnings || 0)}`;

        // Daily streak
        document.getElementById('daily-streak').innerText = data.dailyStreak || 0;
        renderStreakDays(data.dailyStreak || 0);

        // Wagering progress
        renderWageringProgress(data);

        // Referral code
        if (data.referralCode) {
            document.getElementById('referral-code').innerText = data.referralCode;
            document.getElementById('referral-link').value =
                `${window.location.origin}/?ref=${data.referralCode}`;
        } else {
            document.getElementById('referral-code').innerText = '—';
            await generateReferralCode();
        }

        // Daily bonus button state
        updateDailyBonusButtons(data.lastDailyClaim);
    } catch (err) {
        console.error('Summary error:', err);
        showToast('Failed to load wallet summary', 'error');
    }
}

function renderWageringProgress(data) {
    const wrap = document.getElementById('bonus-progress-wrap');
    if (!wrap) return;

    if (data.bonusWageringRequired > 0) {
        wrap.style.display = 'block';
        const wagered = data.bonusWagered || 0;
        const required = data.bonusWageringRequired;
        const total = wagered + required;
        const percent = Math.min(100, (wagered / total) * 100);

        document.getElementById('wagering-text').innerText =
            `KES ${formatKES(wagered)} / KES ${formatKES(total)}`;

        const fill = document.getElementById('wagering-fill');
        if (fill) {
            fill.style.width = `${percent}%`;
            // Color shift: red → yellow → green as user progresses
            if (percent >= 100) fill.style.background = 'linear-gradient(90deg, #00c853, #00e05e)';
            else if (percent >= 50) fill.style.background = 'linear-gradient(90deg, #fbbf24, #00c853)';
            else fill.style.background = 'linear-gradient(90deg, #fbbf24, #d97706)';
        }
    } else {
        wrap.style.display = 'none';
    }
}

function canClaimDaily(lastClaim) {
    if (!lastClaim) return true;
    const hoursSince = (Date.now() - new Date(lastClaim).getTime()) / (1000 * 60 * 60);
    return hoursSince >= 20;
}

function updateDailyBonusButtons(lastClaim) {
    const canClaim = canClaimDaily(lastClaim);

    const btn1 = document.getElementById('daily-bonus-btn');
    const btn2 = document.getElementById('daily-bonus-side-btn');

    [btn1, btn2].forEach(btn => {
        if (!btn) return;
        btn.disabled = !canClaim;
        if (!canClaim) {
            btn.innerHTML = '<i class="fa-solid fa-check"></i> Claimed Today';
            btn.style.opacity = '0.6';
        } else {
            btn.innerHTML = btn === btn1
                ? '<i class="fa-solid fa-gift"></i> Daily Bonus'
                : '<i class="fa-solid fa-gift"></i> Claim Today\'s Bonus';
            btn.style.opacity = '1';
        }
    });
}

function renderStreakDays(streak) {
    const container = document.getElementById('streak-days');
    if (!container) return;
    container.innerHTML = '';

    for (let i = 1; i <= 7; i++) {
        const day = document.createElement('div');
        day.className = 'csh-streak-day' + (i <= streak ? ' active' : '');
        day.innerText = i;
        day.title = i <= streak ? `Day ${i} claimed` : `Day ${i} locked`;
        container.appendChild(day);
    }
}

// ============================================
// REFERRAL
// ============================================
async function generateReferralCode() {
    try {
        const res = await fetch(`${API_BASE}/api/wallet/referral/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser.userId })
        });
        const data = await res.json();
        if (!res.ok) return;

        document.getElementById('referral-code').innerText = data.referralCode;
        document.getElementById('referral-link').value = data.referralLink;
    } catch (_) {}
}

function copyReferral() {
    const code = document.getElementById('referral-code').innerText;
    if (!code || code === '—') return;

    navigator.clipboard.writeText(code).then(() => {
        showToast('Referral code copied!', 'success');
    }).catch(() => {
        showToast('Copy failed — select manually', 'error');
    });
}

function shareReferral() {
    const link = document.getElementById('referral-link').value;
    if (!link) return;

    if (navigator.share) {
        navigator.share({
            title: 'Join BetNova',
            text: 'Play Aviator, Sports, and more on BetNova. Use my code and get a KES 50 signup bonus!',
            url: link
        }).catch(() => {});
    } else {
        navigator.clipboard.writeText(link).then(() => {
            showToast('Referral link copied!', 'success');
        }).catch(() => {
            showToast('Copy failed', 'error');
        });
    }
}

// ============================================
// AMOUNT SHORTCUTS
// ============================================
function setAmount(type, amount) {
    const el = document.getElementById(`${type}-amount`);
    if (el) el.value = amount;
}

function adjustAmount(type, delta) {
    const input = document.getElementById(`${type}-amount`);
    if (!input) return;
    const current = parseFloat(input.value) || 0;
    const min = type === 'deposit' ? 10 : 50;
    input.value = Math.max(min, current + delta);
}

function setMaxWithdraw() {
    if (!userSummary) return;
    const input = document.getElementById('withdraw-amount');
    if (!input) return;

    // Withdrawable is ONLY main balance — bonus is locked until wagered
    const available = userSummary.balance || 0;

    if (available < 50) {
        return showToast('Minimum withdrawal is KES 50', 'error');
    }
    input.value = Math.floor(available);
}

// ============================================
// DEPOSIT
// ============================================
async function handleDeposit() {
    const amountEl = document.getElementById('deposit-amount');
    const phoneEl = document.getElementById('deposit-phone');
    if (!amountEl || !phoneEl) return;

    const amount = parseFloat(amountEl.value);
    const phone = phoneEl.value.trim();

    // ---------- Client-side validation ----------
    if (!amount || amount < 10) return showToast('Minimum KES 10', 'error');
    if (amount > 150000) return showToast('Maximum KES 150,000', 'error');
    if (!phone) return showToast('Enter M-Pesa number', 'error');
    if (!isValidPhone(phone)) return showToast('Enter a valid Kenyan phone number', 'error');

    // Disable button during request
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
            body: JSON.stringify({
                userId: currentUser.userId,
                amount,
                phoneNumber: phone
            })
        });
        const data = await res.json();

        if (!res.ok) {
            // Handle specific errors
            if (data.error && data.error.includes('Daily deposit limit')) {
                return showToast(data.error, 'error', 6000);
            }
            return showToast(data.error || 'Deposit failed', 'error');
        }

        showToast('Check your phone for the M-Pesa PIN prompt', 'success', 5000);

        // Poll for balance update after 5-15 seconds
        setTimeout(loadSummary, 5000);
        setTimeout(loadSummary, 15000);
    } catch (e) {
        console.error('Deposit error:', e);
        showToast('Network error', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalText || '<i class="fa-solid fa-bolt"></i> Send M-Pesa Request';
        }
    }
}

// ============================================
// WITHDRAW
// ============================================
async function handleWithdraw() {
    const amountEl = document.getElementById('withdraw-amount');
    const phoneEl = document.getElementById('withdraw-phone');
    if (!amountEl || !phoneEl) return;

    const amount = parseFloat(amountEl.value);
    const phone = phoneEl.value.trim();

    // ---------- Client-side validation ----------
    if (!amount || amount < 50) return showToast('Minimum KES 50', 'error');
    if (!phone) return showToast('Enter M-Pesa number', 'error');
    if (!isValidPhone(phone)) return showToast('Enter a valid Kenyan phone number', 'error');

    if (userSummary && amount > userSummary.balance) {
        return showToast(`Insufficient balance. Available: KES ${formatKES(userSummary.balance)}`, 'error', 4000);
    }

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
            body: JSON.stringify({
                userId: currentUser.userId,
                amount,
                phoneNumber: phone
            })
        });
        const data = await res.json();

        if (!res.ok) {
            // ---------- Handle specific error codes ----------
            if (data.code === 'KYC_REQUIRED') {
                showToast('Verify your email to withdraw. Opening KYC...', 'error', 4000);
                // Redirect to home where KYC modal is
                setTimeout(() => {
                    location.href = '/#kyc';
                }, 1500);
                return;
            }

            if (data.code === 'WAGERING_REQUIRED') {
                return showToast(data.error, 'error', 6000);
            }

            return showToast(data.error || 'Withdrawal failed', 'error');
        }

        showToast('Withdrawal sent successfully', 'success', 5000);
        amountEl.value = 100;

        // Refresh summary to reflect deduction
        setTimeout(loadSummary, 1500);
        setTimeout(loadSummary, 5000);
    } catch (e) {
        console.error('Withdraw error:', e);
        showToast('Network error', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalText || '<i class="fa-solid fa-money-bill-transfer"></i> Withdraw to M-Pesa';
        }
    }
}

// ============================================
// HISTORY
// ============================================
async function loadHistory() {
    const list = document.getElementById('history-list');
    if (!list) return;

    list.innerHTML = '<p style="text-align:center;color:#64748b;padding:20px;">Loading...</p>';

    try {
        const res = await fetch(`${API_BASE}/api/wallet/transactions/${currentUser.userId}?limit=50`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        if (!data.transactions || data.transactions.length === 0) {
            list.innerHTML = `
                <div class="csh-history-empty">
                    <i class="fa-solid fa-receipt"></i>
                    <p>No transactions yet</p>
                    <span>Your deposits, withdrawals, and bets will appear here</span>
                </div>
            `;
            return;
        }

        list.innerHTML = data.transactions.map(t => renderTransaction(t)).join('');
    } catch (err) {
        console.error('History error:', err);
        list.innerHTML = '<p style="color:#ef4444;text-align:center;padding:20px;">Failed to load history</p>';
    }
}

function renderTransaction(t) {
    const isPositive = t.amount > 0;

    const icons = {
        DEPOSIT: 'fa-arrow-down',
        WITHDRAWAL: 'fa-arrow-up',
        WIN: 'fa-trophy',
        BET_LOSS: 'fa-chart-line',
        SPORTS_WON: 'fa-futbol',
        SPORTS_LOST: 'fa-futbol',
        SPORTS_PENDING: 'fa-clock',
        SPORTS_WON_: 'fa-futbol'
    };

    const colorMap = {
        DEPOSIT: 'green',
        WITHDRAWAL: 'red',
        WIN: 'green',
        BET_LOSS: 'red',
        SPORTS_WON: 'green',
        SPORTS_LOST: 'red',
        SPORTS_PENDING: 'yellow'
    };

    const icon = icons[t.type] || 'fa-circle';
    const color = colorMap[t.type] || (isPositive ? 'green' : 'red');

    const label = (t.type || '')
        .replace(/_/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());

    const time = new Date(t.createdAt).toLocaleString('en-KE', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit'
    });

    const ref = t.reference ? String(t.reference).slice(0, 24) : '';

    return `
        <div class="csh-history-item">
            <div class="csh-history-icon ${color}">
                <i class="fa-solid ${icon}"></i>
            </div>
            <div class="csh-history-info">
                <div class="csh-history-type">${escapeHtml(label)}</div>
                <div class="csh-history-sub">${time}${ref ? ' · ' + escapeHtml(ref) : ''}</div>
            </div>
            <div class="csh-history-amount ${isPositive ? 'positive' : 'negative'}">
                ${isPositive ? '+' : ''}KES ${formatKES(Math.abs(t.amount))}
            </div>
            <div class="csh-history-status ${t.status || ''}">${escapeHtml(t.status || '')}</div>
        </div>
    `;
}

// ============================================
// DAILY BONUS
// ============================================
async function claimDailyBonus() {
    if (!canClaimDaily(userSummary?.lastDailyClaim)) {
        return showToast('Already claimed today. Come back tomorrow!', 'error');
    }

    const btn = event?.target;
    const originalText = btn?.innerHTML;
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Claiming...';
    }

    try {
        const res = await fetch(`${API_BASE}/api/wallet/daily-bonus`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser.userId })
        });
        const data = await res.json();

        if (!res.ok) {
            return showToast(data.error || 'Already claimed', 'error');
        }

        showToast(
            `Day ${data.streak} bonus: KES ${formatKES(data.amount)}! Keep the streak alive 🔥`,
            'success',
            5000
        );

        // Refresh summary to show new bonus
        setTimeout(loadSummary, 800);
    } catch (e) {
        console.error('Daily bonus error:', e);
        showToast('Network error', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalText;
        }
    }
}

// ============================================
// SOCKET — LIVE BALANCE SYNC
// ============================================
socket.on('balance_update', (balance) => {
    localStorage.setItem('betnova_balance', balance);

    const hdrBal = document.getElementById('balance-display');
    if (hdrBal) hdrBal.innerText = formatKES(balance);

    // Refresh summary so all numbers stay in sync
    if (currentUser) loadSummary();
});

socket.on('connect', () => {
    console.log('[Cashier] Socket connected');
});

// ============================================
// KEYBOARD SHORTCUTS
// ============================================
document.addEventListener('keydown', (e) => {
    // Alt + 1-4 for tab switching
    if (e.altKey && ['1', '2', '3', '4'].includes(e.key)) {
        const tabs = ['deposit', 'withdraw', 'history', 'referral'];
        openTab(tabs[parseInt(e.key) - 1]);
        e.preventDefault();
    }
});

// ============================================
// INIT
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    if (!checkSession()) return;

    // Restore last tab from URL hash
    openTab(getInitialTab());

    // Initial load
    loadSummary();

    // Periodic refresh every 30s
    refreshInterval = setInterval(loadSummary, 30000);

    // Also refresh on page visibility change
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) loadSummary();
    });
});

// Cleanup on unload
window.addEventListener('beforeunload', () => {
    if (refreshInterval) clearInterval(refreshInterval);
});
