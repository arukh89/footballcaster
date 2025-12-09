import type { WalletClient, PublicClient } from 'viem';
import { parseUnits, formatUnits } from 'viem';
import { readContract, waitForTransactionReceipt, simulateContract } from 'viem/actions';
import { base } from 'viem/chains';
import { CONTRACT_ADDRESSES } from './constants';
import { sendTx } from '@/lib/onchain/sendTx';
const OX_QUOTE_URL = '/api/zeroex/quote';
const WETH_BASE: `0x${string}` = '0x4200000000000000000000000000000000000006';
const UNISWAP_V3_QUOTER_V2: `0x${string}` = '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a';
const UNISWAP_V3_SWAP_ROUTER_02: `0x${string}` = '0x2626664c2603336E57B271c5C0b26F421741e481';
const V3_FEE_TIERS: number[] = [100, 500, 3000, 10000];
// USDC (official) with env-extensible list to avoid hardcoding unknowns
const USDC_DEFAULTS: `0x${string}`[] = [
  '0x833589fCD6edb6E08f4c7C76f99918fCae4f2dE0',
];
const USDC_ENV = (process.env.NEXT_PUBLIC_USDC_ADDRESSES || process.env.USDC_ADDRESSES || '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => /^0x[a-fA-F0-9]{40}$/.test(s)) as `0x${string}`[];
const USDC_BASES: `0x${string}`[] = Array.from(new Set([...USDC_DEFAULTS, ...USDC_ENV]));

// ERC20 ABI for approve and transfer functions
const ERC20_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'transfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

// QuoterV2 ABI (single and multi-hop)
const QUOTER_V2_ABI = [
  {
    name: 'quoteExactOutputSingle',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{
      components: [
        { name: 'tokenIn', type: 'address' },
        { name: 'tokenOut', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'fee', type: 'uint24' },
        { name: 'sqrtPriceLimitX96', type: 'uint160' },
      ],
      name: 'params',
      type: 'tuple'
    }],
    outputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'sqrtPriceX96After', type: 'uint160' },
      { name: 'initializedTicksCrossed', type: 'uint32' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
  {
    name: 'quoteExactOutput',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'path', type: 'bytes' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'sqrtPriceX96AfterList', type: 'uint160[]' },
      { name: 'initializedTicksCrossedList', type: 'uint32[]' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
] as const;

// SwapRouter02 ABI (single and multi-hop)
const ROUTER_V2_ABI = [
  {
    name: 'exactOutputSingle',
    type: 'function',
    stateMutability: 'payable',
    inputs: [{
      components: [
        { name: 'tokenIn', type: 'address' },
        { name: 'tokenOut', type: 'address' },
        { name: 'fee', type: 'uint24' },
        { name: 'recipient', type: 'address' },
        { name: 'deadline', type: 'uint256' },
        { name: 'amountOut', type: 'uint256' },
        { name: 'amountInMaximum', type: 'uint256' },
        { name: 'sqrtPriceLimitX96', type: 'uint160' },
      ],
      name: 'params',
      type: 'tuple'
    }],
    outputs: [ { name: 'amountIn', type: 'uint256' } ],
  },
  {
    name: 'exactOutput',
    type: 'function',
    stateMutability: 'payable',
    inputs: [{
      components: [
        { name: 'path', type: 'bytes' },
        { name: 'recipient', type: 'address' },
        { name: 'deadline', type: 'uint256' },
        { name: 'amountOut', type: 'uint256' },
        { name: 'amountInMaximum', type: 'uint256' },
      ],
      name: 'params',
      type: 'tuple'
    }],
    outputs: [ { name: 'amountIn', type: 'uint256' } ],
  },
] as const;

function strip0x(h: string): string { return h.startsWith('0x') ? h.slice(2) : h; }
function addrToBytes20(addr: `0x${string}`): string { return strip0x(addr.toLowerCase()); }
function feeTo3BytesHex(fee: number): string {
  const hex = fee.toString(16).padStart(6, '0');
  return hex;
}
// For exactOutput, path is encoded from tokenOut -> ... -> tokenIn with 3-byte fee between tokens
function encodeV3PathExactOutput(tokens: `0x${string}`[], fees: number[]): `0x${string}` {
  // tokens length = fees length + 1
  let hex = '';
  for (let i = 0; i < tokens.length; i++) {
    hex += addrToBytes20(tokens[i]);
    if (i < fees.length) hex += feeTo3BytesHex(fees[i]);
  }
  return ('0x' + hex) as `0x${string}`;
}

/**
 * Ensure SOCCERHUNT token allowance for a spender
 */
export async function ensureAllowance(
  walletClient: WalletClient,
  publicClient: PublicClient,
  spender: `0x${string}`,
  minAmount: string
): Promise<boolean> {
  try {
    const [account] = await walletClient.getAddresses();
    if (!account) {
      throw new Error('No account connected');
    }

    // Check current allowance using public client
    const currentAllowance = await readContract(publicClient, {
      address: CONTRACT_ADDRESSES.soccerhunt,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [account, spender],
    });

    const minAmountBigInt = BigInt(minAmount);

    // If allowance is sufficient, return true
    if (currentAllowance >= minAmountBigInt) {
      return true;
    }

    // Request approval
    const hash = await walletClient.writeContract({
      address: CONTRACT_ADDRESSES.soccerhunt,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [spender, minAmountBigInt],
      account,
      chain: base,
    });

    // Wait for transaction confirmation
    await waitForTransactionReceipt(publicClient, { hash });

    return true;
  } catch (err) {
    console.error('Allowance error:', err);
    throw err;
  }
}

/**
 * Pay in SOCCERHUNT tokens
 * Optionally batches approve + transfer if EIP-5792 is supported
 */
export async function payInSOCCERHUNT(
  walletClient: WalletClient,
  publicClient: PublicClient,
  to: `0x${string}`,
  amount: string,
): Promise<{ hash: `0x${string}`; success: boolean }> {
  try {
    const amountBigInt = BigInt(amount);
    const [account] = await walletClient.getAddresses();
    if (!account) throw new Error('No account connected');

    // Pre-check balance to surface friendly error before simulate/write
    const balance = await readContract(publicClient, {
      address: CONTRACT_ADDRESSES.soccerhunt,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [account],
    });
    if (balance < amountBigInt) {
      const have = formatUnits(balance, 18);
      const need = formatUnits(amountBigInt, 18);
      throw new Error(`Insufficient SOCCERHUNT balance. You have ${have}, need ${need}.`);
    }

    // Standardized: simulate → write → wait via wagmi actions
    const { hash } = await sendTx({
      address: CONTRACT_ADDRESSES.soccerhunt,
      abi: ERC20_ABI as any,
      functionName: 'transfer',
      args: [to, amountBigInt],
      confirmations: 2,
    });

    return { hash, success: true };
  } catch (err) {
    console.error('Payment error:', err);
    throw err;
  }
}

/**
 * Send SOCCERHUNT tokens (alias for payInSOCCERHUNT)
 */
export const sendSOCCERHUNT = payInSOCCERHUNT;
// Temporary legacy alias
export const sendFBC = payInSOCCERHUNT;

/**
 * Format SOCCERHUNT amount from wei to readable format
 */
export function formatSOCCERHUNT(amountWei: string | bigint): string {
  return formatUnits(BigInt(amountWei), 18);
}
// Legacy alias
export const formatFBC = formatSOCCERHUNT;

/**
 * Parse SOCCERHUNT amount from readable format to wei
 */
export function parseSOCCERHUNT(amount: string): string {
  return parseUnits(amount, 18).toString();
}
// Legacy alias
export const parseFBC = parseSOCCERHUNT;

/**
 * Calculate fee amount
 */
export function calculateFee(amount: string, feeBps: number): string {
  const amountBigInt = BigInt(amount);
  const fee = (amountBigInt * BigInt(feeBps)) / BigInt(10000);
  return fee.toString();
}
