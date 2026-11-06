// Manual handoff to a public fomo.family token page. This does not connect a
// wallet, start a session, or submit an order.

export const FOMO_ORIGIN = 'https://fomo.family';

const CHAIN_KIND = Object.freeze({
  solana: 'base58',
  base: 'evm',
  bnb: 'evm',
  monad: 'evm',
  ethereum: 'evm',
  robinhood: 'evm',
  arc: 'evm',
});

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM = /^0x[0-9a-fA-F]{40}$/;

export function fomoTokenUrl(chain, address) {
  const normalized = typeof chain === 'string' ? chain.trim().toLowerCase() : '';
  const kind = CHAIN_KIND[normalized];
  const raw = typeof address === 'string' ? address.trim() : '';
  if (!kind) return { ok: false, reason: 'chain-not-allowed', url: null };
  if (raw.includes('/') || raw.includes('?') || raw.includes('#') || raw.includes('%') || /\s/.test(raw)) {
    return { ok: false, reason: 'address-not-a-single-token', url: null };
  }
  if (kind === 'base58' && !BASE58.test(raw)) return { ok: false, reason: 'solana-address-invalid', url: null };
  if (kind === 'evm' && !EVM.test(raw)) return { ok: false, reason: 'evm-address-invalid', url: null };
  const url = `${FOMO_ORIGIN}/tokens/${normalized}/${raw}`;
  const parsed = new URL(url);
  if (parsed.origin !== FOMO_ORIGIN || parsed.pathname !== `/tokens/${normalized}/${raw}` || parsed.search || parsed.hash) {
    return { ok: false, reason: 'url-not-a-token-page', url: null };
  }
  return {
    ok: true,
    url,
    chain: normalized,
    address: raw,
    handoff: 'manual',
    order: false,
    wallet: false,
  };
}
