import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Format SOCCERHUNT amount from wei to human-readable format
 * @param weiAmount - Amount in wei (string or bigint)
 * @param decimals - Number of decimal places to show (default: 2)
 * @returns Formatted string with SOCCERHUNT suffix
 */
export function formatSOCCERHUNT(weiAmount: string | bigint, decimals: number = 2): string {
  try {
    // Convert to bigint if string
    const wei = typeof weiAmount === 'string' ? BigInt(weiAmount) : weiAmount;
    
    // SOCCERHUNT has 18 decimals
    const token = Number(wei) / 1e18;
    
    // Format with specified decimal places
    if (token < 0.01 && token > 0) {
      return `<0.01 SOCCERHUNT`;
    }
    
    return `${token.toFixed(decimals)} SOCCERHUNT`;
  } catch (error) {
    console.error('Error formatting SOCCERHUNT:', error);
    return '0 SOCCERHUNT';
  }
}

// Legacy alias to ease refactor
export const formatFBC = formatSOCCERHUNT;
