// Public X evidence is supplied by the operator. This process does not call X.
// Awaiting evidence is not a claim that X is unavailable. Recorded posts are
// not a successful verification, and missing older posts do not prove the
// story is new or recycled.

const RECYCLE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

function normalizeHandle(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/^@/, '').toLowerCase();
}

export function ingestSocialEvidence({ handle, evidence, now = Date.now() } = {}) {
  const expected = normalizeHandle(handle);
  if (!expected) {
    return {
      ok: true,
      failClosed: false,
      available: false,
      verified: false,
      verifiedReads: null,
      status: 'PASS_PARTIAL',
      reason: 'no-handle',
      awaitInput: false,
      recycledProof: null,
      connector: null,
      endpoint: null,
    };
  }
  if (evidence == null) {
    return {
      ok: true,
      failClosed: false,
      available: false,
      verified: false,
      verifiedReads: null,
      status: 'AWAIT_INPUT',
      reason: 'evidence-not-supplied',
      awaitInput: true,
      handle: expected,
      recycledProof: null,
      connector: null,
      endpoint: null,
    };
  }
  if (evidence.available === true || evidence.verified === true || Number.isFinite(evidence.verifiedReads) || evidence.status === 'PASS' || evidence.status === 'PASS_PARTIAL') {
    return { ok: false, failClosed: true, available: false, verified: false, verifiedReads: null, status: 'REJECTED', reason: 'social-claim-rejected', awaitInput: false, connector: null, endpoint: null };
  }
  if (evidence.source !== 'public-x-tool') {
    return { ok: false, failClosed: true, available: false, verified: false, verifiedReads: null, status: 'REJECTED', reason: 'social-source-untrusted', awaitInput: false, connector: null, endpoint: null };
  }
  if (normalizeHandle(evidence.handle) !== expected) {
    return { ok: false, failClosed: true, available: false, verified: false, verifiedReads: null, status: 'REJECTED', reason: 'social-handle-mismatch', awaitInput: false, connector: null, endpoint: null };
  }
  if (!Number.isFinite(evidence.retrievedAt)) {
    return { ok: false, failClosed: true, available: false, verified: false, verifiedReads: null, status: 'REJECTED', reason: 'social-provenance-missing', awaitInput: false, connector: null, endpoint: null };
  }
  if (!Number.isFinite(now) || evidence.retrievedAt > now + 120_000) {
    return { ok: false, failClosed: true, available: false, verified: false, verifiedReads: null, status: 'REJECTED', reason: 'social-provenance-future', awaitInput: false, connector: null, endpoint: null };
  }
  const posts = Array.isArray(evidence.posts) ? evidence.posts : null;
  if (!posts || posts.length === 0) {
    return {
      ok: false,
      failClosed: true,
      available: false,
      verified: false,
      verifiedReads: null,
      status: 'REJECTED',
      reason: 'posts-missing-cannot-prove-not-recycled',
      recycledProof: false,
      awaitInput: false,
      connector: null,
      endpoint: null,
    };
  }
  for (const post of posts) {
    if (!post || typeof post.id !== 'string' || post.id.trim() === '' || !Number.isFinite(post.createdAt)) {
      return { ok: false, failClosed: true, available: false, verified: false, verifiedReads: null, status: 'REJECTED', reason: 'social-post-timestamp-missing', awaitInput: false, connector: null, endpoint: null };
    }
    if (post.createdAt > evidence.retrievedAt + 120_000) {
      return { ok: false, failClosed: true, available: false, verified: false, verifiedReads: null, status: 'REJECTED', reason: 'social-post-after-retrieval', awaitInput: false, connector: null, endpoint: null };
    }
  }
  const created = posts.map((post) => post.createdAt);
  const oldestPostAt = Math.min(...created);
  const newestPostAt = Math.max(...created);
  const hasOlderPosts = oldestPostAt <= evidence.retrievedAt - RECYCLE_LOOKBACK_MS;
  return {
    ok: true,
    failClosed: false,
    available: false,
    verified: false,
    verifiedReads: null,
    status: 'EVIDENCE_RECORDED',
    reason: 'recorded-not-verified',
    awaitInput: false,
    recycledProof: false,
    recycleReason: hasOlderPosts ? 'older-posts-present-still-not-a-verification' : 'missing-older-posts-cannot-prove-not-recycled',
    postCount: posts.length,
    oldestPostAt,
    newestPostAt,
    retrievedAt: evidence.retrievedAt,
    source: 'public-x-tool',
    handle: expected,
    connector: null,
    endpoint: null,
  };
}
