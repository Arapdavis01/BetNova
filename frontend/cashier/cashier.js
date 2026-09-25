// ============================================
// BetNova — Cashier Client
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
    transports: ['websocket', 'polling']
});

let currentUser = null;
let userSummary = null;

// ============================================
// UTILS
// ============================================
function formatKES(n) {
    return parseFloat(n || 0).toLocaleString('en-KE', {
        minimumFractionDigits: 2, maximumFractionDigits: 2
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
    t.innerText = msg;
    t.className = `csh-toast ${type}`;
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

    if (!user || !userId) {
        showToast('Sign in to access cashier', 'error');
        setTimeout(() => location.href = '/', 1500);
        return false;
    }

    currentUser = { userId, username: user };
    document.getElementById('balance-display').innerText = formatKES(balance || 0);
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

    if (name === 'history') loadHistory();
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

        document.getElementById('main-balance').innerText = `KES ${formatKES(data.balance)}`;
        document.getElementById('bonus-balance').innerText = `KES ${formatKES(data.bonusBalance)}`;
        document.getElementById('total-deposited').innerText = `KES ${formatKES(data.totalDeposited)}`;
        document.getElementById('total-withdrawn').innerText = `KES ${formatKES(data.totalWithdrawn)}`;
        document.getElementById('referral-count').innerText = data.referralCount || 0;
        document.getElementById('referral-earnings').innerText = `KES ${formatKES(data.referralEarnings || 0)}`;
        document.getElementById('daily-streak').innerText = data.dailyStreak || 0;

        // Wagering progress
        if (data.bonusWageringRequired > 0) {
            document.getElementById('bonus-progress-wrap').style.display = 'block';
            const wagered = data.bonusWagered || 0;
            const required = data.bonusWageringRequired;
            const percent = Math.min(100, (wagered / (wagered + required)) * 100);
            document.getElementById('wagering-text').innerText = `KES ${formatKES(wagered)} / KES ${formatKES(wagered + required)}`;
            document.getElementById('wagering-fill').style.width = `${percent}%`;
        } else {
            document.getElementById('bonus-progress-wrap').style.display = 'none';
        }

        // Referral link
        if (data.referralCode) {
            document.getElementById('referral-code').innerText = data.referralCode;
            document.getElementById('referral-link').value =
                `${window.location.origin}/?ref=${data.referralCode}`;
        } else {
            document.getElementById('referral-code').innerText = '—';
            await generateReferralCode();
        }

        // Streak visualization
        renderStreakDays(data.dailyStreak || 0);

        // Enable/disable daily bonus
        const canClaim = canClaimDaily(data.lastDailyClaim);
        document.getElementById('daily-bonus-btn').disabled = !canClaim;
        document.getElementById('daily-bonus-side-btn').disabled = !canClaim;
        if (!canClaim) {
            document.getElementById('daily-bonus-btn').innerHTML =
                '<i class="fa-solid fa-check"></i> Claimed Today';
            document.getElementById('daily-bonus-side-btn').innerHTML =
                '<i class="fa-solid fa-check"></i> Claimed Today';
        } else {
            document.getElementById('daily-bonus-btn').innerHTML =
                '<i class="fa-solid fa-gift"></i> Daily Bonus';
            document.getElementById('daily-bonus-side-btn').innerHTML =
                '<i class="fa-solid fa-gift"></i> Claim Today\'s Bonus';
        }
    } catch (err) {
        console.error('Summary error:', err);
        showToast('Failed to load wallet summary', 'error');
    }
}

function canClaimDaily(lastClaim) {
    if (!lastClaim) return true;
    const hoursSince = (Date.now() - new Date(lastClaim).getTime()) / (1000 * 60 * 60);
    return hoursSince >= 20;
}

function renderStreakDays(streak) {
    const container = document.getElementById('streak-days');
    container.innerHTML = '';
    for (let i = 1; i <= 7; i++) {
        const day = document.createElement('div');
        day.className = 'csh-streak-day' + (i <= streak ? ' active' : '');
        day.innerText = i;
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
    if (code === '—') return;

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
            text: 'Play Aviator, Sports, and more on BetNova. Use my code and get a signup bonus!',
            url: link
        }).catch(() => {});
    } else {
        navigator.clipboard.writeText(link).then(() => {
            showToast('Referral link copied!', 'success');
        });
    }
}

// ============================================
// AMOUNTS
// ============================================
function setAmount(type, amount) {
    document.getElementById(`${type}-amount`).value = amount;
}

function adjustAmount(type, delta) {
    const input = document.getElementById(`${type}-amount`);
    const current = parseFloat(input.value) || 0;
    const min = type === 'deposit' ? 10 : 50;
    input.value = Math.max(min, current + delta);
}

function setMaxWithdraw() {
    if (!userSummary) return;
    const input = document.getElementById('withdraw-amount');
    input.value = Math.floor(userSummary.balance);
}

// ============================================
// DEPOSIT / WITHDRAW
// ============================================
async function handleDeposit() {
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
    } catch (e) {
        showToast('Network error', 'error');
    }
}

async function handleWithdraw() {
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
        showToast('Withdrawal sent', 'success', 5000);
        setTimeout(loadSummary, 2000);
    } catch (e) {
        showToast('Network error', 'error');
    }
}

// ============================================
// HISTORY
// ============================================
async function loadHistory() {
    const list = document.getElementById('history-list');
    list.innerHTML = '<p style="text-align:center;color:#64748b;padding:20px;">Loading...</p>';

    try {
        const res = await fetch(`${API_BASE}/api/wallet/transactions/${currentUser.userId}?limit=50`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        if (!data.transactions || data.transactions.length === 0) {
            list.innerHTML = '<p style="text-align:center;color:#64748b;padding:40px;">No transactions yet</p>';
            return;
        }

        list.innerHTML = data.transactions.map(t => renderTransaction(t)).join('');
    } catch (err) {
        list.innerHTML = '<p style="color:#ef4444;text-align:center;padding:20px;">Failed to load</p>';
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
        SPORTS_PENDING: 'fa-clock'
    };
    const colors = isPositive ? 'green' : 'red';
    const icon = icons[t.type] || 'fa-circle';

    const label = t.type.replace(/_/g, ' ');
    const time = new Date(t.createdAt).toLocaleString('en-KE', {
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
    });

    return `
        <div class="csh-history-item">
            <div class="csh-history-icon ${colors}">
                <i class="fa-solid ${icon}"></i>
            </div>
            <div class="csh-history-info">
                <div class="csh-history-type">${escapeHtml(label)}</div>
                <div class="csh-history-sub">${time} · ${escapeHtml((t.reference || '').slice(0, 30))}</div>
            </div>
            <div class="csh-history-amount ${isPositive ? 'positive' : 'negative'}">
                ${isPositive ? '+' : ''}KES ${formatKES(Math.abs(t.amount))}
            </div>
            <div class="csh-history-status ${t.status}">${t.status}</div>
        </div>
    `;
}

// ============================================
// DAILY BONUS
// ============================================
async function claimDailyBonus() {
    try {
        const res = await fetch(`${API_BASE}/api/wallet/daily-bonus`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: currentUser.userId })
        });
        const data = await res.json();
        if (!res.ok) return showToast(data.error || 'Already claimed', 'error');

        showToast(`Day ${data.streak} bonus: KES ${formatKES(data.amount)}!`, 'success', 5000);
        loadSummary();
    } catch (e) {
        showToast('Network error', 'error');
    }
}

// ============================================
// SOCKET — BALANCE
// ============================================
socket.on('balance_update', (balance) => {
    localStorage.setItem('betnova_balance', balance);
    document.getElementById('balance-display').innerText = formatKES(balance);
    loadSummary();
});

// ============================================
// INIT
// ============================================
document.addEventListener('DOMContentLoaded', () => {
    if (!checkSession()) return;
    loadSummary();
    setInterval(loadSummary, 30000);
});
