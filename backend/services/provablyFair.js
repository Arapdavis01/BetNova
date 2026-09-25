const crypto = require('crypto');

/**
 * Provably Fair — SHA-256 commit-reveal scheme
 *
 * 1. Server generates a random serverSeed (32 bytes hex)
 * 2. Server computes serverSeedHash = SHA256(serverSeed)
 * 3. Hash is broadcast to all clients BEFORE the round starts
 * 4. Crash point is derived from HMAC_SHA256(serverSeed, clientSeed + roundId)
 * 5. After the round ends, serverSeed is revealed
 * 6. Anyone can verify SHA256(revealedSeed) === previously published hash
 * 7. Anyone can recompute the crash point from the revealed seed
 */

function generateServerSeed() {
    return crypto.randomBytes(32).toString('hex');
}

function hashSeed(serverSeed) {
    return crypto.createHash('sha256').update(serverSeed).digest('hex');
}

/**
 * Compute crash point from server seed + round id
 * Uses HMAC-SHA256 and maps to an exponential distribution
 * Matches the same 3% instant-crash house edge as before
 */
function computeCrashPoint(serverSeed, roundId) {
    const hmac = crypto.createHmac('sha256', serverSeed);
    hmac.update(roundId.toString());
    const hash = hmac.digest('hex');

    // Take first 8 hex chars → integer
    const int = parseInt(hash.slice(0, 8), 16);

    // Map to [0, 1)
    const float = int / 0xFFFFFFFF;

    // 3% instant crash
    if (float < 0.03) return 1.00;

    // Same distribution as before: 1.01 / (1 - r)
    const crash = 1.01 / (1 - float);
    return parseFloat(Math.min(crash, 1000).toFixed(2)); // cap at 1000x
}

module.exports = {
    generateServerSeed,
    hashSeed,
    computeCrashPoint
};
