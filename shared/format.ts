// Currency formatting utilities for consistent USD display across agent-forge.

/**
 * Formats a USD amount as a string with proper currency symbol, thousands
 * separators, and two decimal places (cents).
 *
 * Examples:
 *   formatUsd(1.3)      → "$1.30"
 *   formatUsd(0)        → "$0.00"
 *   formatUsd(1234.5)   → "$1,234.50"
 *   formatUsd(-4.5)     → "-$4.50"
 *   formatUsd(1.005)    → "$1.01" (rounded to nearest cent)
 *
 * @param usd - The USD amount to format (can be negative)
 * @returns Formatted string with $ prefix, thousands separators, and exactly 2 decimal places
 */
export function formatUsd(usd: number): string {
  // Normalize negative zero to positive zero to avoid "-$0.00" output.
  // JavaScript's Intl.NumberFormat preserves the sign of -0, but for currency
  // display we want consistent "$0.00" regardless of sign.
  const normalized = usd === 0 ? 0 : usd;

  // Use Intl.NumberFormat to handle locale-aware formatting with thousands separators
  // and proper rounding to 2 decimal places.
  const formatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  return formatter.format(normalized);
}
