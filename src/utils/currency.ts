export function formatCurrency(amount: number, symbol: string = '₦'): string {
  if (isNaN(amount)) return `${symbol}0`;
  return `${symbol}${amount.toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

export function formatTimestamp(isoString: string): string {
  try {
    const date = new Date(isoString);
    return date.toLocaleString('en-NG', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
      month: 'short',
      day: 'numeric'
    });
  } catch (e) {
    return isoString;
  }
}
