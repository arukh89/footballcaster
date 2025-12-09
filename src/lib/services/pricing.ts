/**
 * Pricing Service - Token/USD via Mint.club SDK
 * Primary source: Mint.club getUsdRate; Fallbacks: override → custom URL
 */

import { CONTRACT_ADDRESSES, CHAIN_CONFIG } from '@/lib/constants';
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import { mintclub } from 'mint.club-v2-sdk';

const CUSTOM_PRICE_URL = process.env.NEXT_PUBLIC_PRICE_URL || process.env.PRICE_URL || '';
// Optional manual override for local/dev: set any of these envs to a positive number
const PRICE_OVERRIDE_ENV =
  process.env.NEXT_PUBLIC_FBC_PRICE_USD ||
  process.env.NEXT_PUBLIC_PRICE_OVERRIDE ||
  process.env.FBC_PRICE_USD ||
  process.env.PRICE_OVERRIDE_USD ||
  process.env.PRICE_OVERRIDE;

interface PriceData {
  priceUsd: string;
  source: 'mintclub' | 'custom' | 'override';
  timestamp: number;
}

let cachedPrice: PriceData | null = null;
const CACHE_TTL = 30 * 1000; // 30 seconds

const publicClient = createPublicClient({ chain: base, transport: http(CHAIN_CONFIG.rpcUrl) });

/**
 * Fetch price via Mint.club SDK
 */
async function fetchFromMintClub(): Promise<string | null> {
  try {
    const tokenAddr = (process.env.NEXT_PUBLIC_SOCCERHUNT_ADDRESS || process.env.NEXT_PUBLIC_FBC_ADDRESS || CONTRACT_ADDRESSES.fbc) as `0x${string}`;
    const sdk = mintclub.withPublicClient(publicClient);
    const res = await sdk.network('base').token(tokenAddr).getUsdRate({ amount: 1 });
    const rate = res?.usdRate;
    if (typeof rate === 'number' && isFinite(rate) && rate > 0) {
      // Normalize to string
      return String(rate);
    }
    return null;
  } catch (err) {
    console.error('Mint.club price fetch error:', err);
    return null;
  }
}

/**
 * Fetch price from a custom endpoint if provided via env (NEXT_PUBLIC_PRICE_URL or PRICE_URL)
 */
async function fetchFromCustom(): Promise<string | null> {
  if (!CUSTOM_PRICE_URL) return null;
  try {
    const response = await fetch(CUSTOM_PRICE_URL, {
      headers: {
        'accept': 'application/json,*/*',
        'user-agent': 'Mozilla/5.0',
      },
      cache: 'no-store',
    });
    const text = await response.text();

    // Try JSON first when possible
    try {
      const data = JSON.parse(text);
      const candidates = [
        (data as any).priceUsd,
        (data as any).price_usd,
        (data as any).price,
        (data as any).usd,
        (data as any)?.data?.priceUsd,
        (data as any)?.data?.price_usd,
      ];
      for (const c of candidates) {
        const v = typeof c === 'number' ? c : typeof c === 'string' ? parseFloat(c) : NaN;
        if (!isNaN(v) && v > 0) return String(v);
      }
    } catch {}

    // Fallback: parse numeric from text
    let match = text.match(/priceUsd"?\s*[:=]\s*"?([0-9]+(?:\.[0-9]+)?)/i);
    if (match?.[1]) return match[1];
    match = text.match(/\$\s*([0-9]+(?:\.[0-9]+)?)/);
    if (match?.[1]) return match[1];
    return null;
  } catch (error) {
    console.error('Custom price fetch error:', error);
    return null;
  }
}

/**
 * Get current price with caching
 */
export async function getFBCPrice(): Promise<PriceData> {
  // Return cached price if valid
  if (cachedPrice && Date.now() - cachedPrice.timestamp < CACHE_TTL) {
    return cachedPrice;
  }

  // Manual override
  const override = (() => {
    if (!PRICE_OVERRIDE_ENV) return null;
    const v = parseFloat(String(PRICE_OVERRIDE_ENV));
    return !isNaN(v) && v > 0 ? String(v) : null;
  })();
  if (override) {
    cachedPrice = { priceUsd: override, source: 'override', timestamp: Date.now() };
    return cachedPrice;
  }

  // Mint.club
  let priceUsd: string | null = await fetchFromMintClub();
  let source: PriceData['source'] = 'mintclub';

  // Custom URL fallback
  if (!priceUsd && CUSTOM_PRICE_URL) {
    priceUsd = await fetchFromCustom();
    if (priceUsd) source = 'custom';
  }

  if (!priceUsd) {
    throw new Error('Unable to fetch price from Mint.club or fallback');
  }

  const price = parseFloat(priceUsd);
  if (isNaN(price) || price <= 0) {
    throw new Error('Invalid price data received');
  }

  // Cache and return
  cachedPrice = { priceUsd, source, timestamp: Date.now() };
  return cachedPrice;
}

/**
 * Calculate token amount (wei) for USD value
 */
export function calculateFBCAmount(usdAmount: string, priceUsd: string): string {
  const toScaled = (s: string, scale: number): bigint => {
    const [i, f = ''] = String(s).trim().split('.');
    const ii = (i || '0').replace(/[^0-9]/g, '');
    const ff = f.replace(/[^0-9]/g, '');
    const frac = (ff + '0'.repeat(scale)).slice(0, scale);
    try { return BigInt(ii + frac); } catch { return 0n; }
  };

  const usdScaled18 = toScaled(usdAmount, 18);     // usd * 1e18
  const priceScaled18 = toScaled(priceUsd, 18);    // price * 1e18
  if (usdScaled18 <= 0n || priceScaled18 <= 0n) {
    throw new Error('Invalid USD or price value');
  }
  const amountWei = (usdScaled18 * (10n ** 18n)) / priceScaled18;
  return amountWei.toString();
}

/**
 * Quote for USD amount in token wei
 */
export async function getQuote(usdAmount: string): Promise<{ amountWei: string; priceUsd: string; source: string }> {
  const priceData = await getFBCPrice();
  const amountWei = calculateFBCAmount(usdAmount, priceData.priceUsd);
  return { amountWei, priceUsd: priceData.priceUsd, source: priceData.source };
}
