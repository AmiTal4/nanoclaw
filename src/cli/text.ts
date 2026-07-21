/**
 * Truncate without splitting a UTF-16 surrogate pair.
 *
 * `Array.from` iterates Unicode code points, unlike `String#slice`, whose
 * indices are UTF-16 code units. The returned string therefore never ends in
 * a lone surrogate that could make a later JSON/API request invalid.
 */
export function truncateCodePoints(value: string, maxLength: number, suffix = ''): string {
  if (maxLength < 0) throw new RangeError('maxLength must be non-negative');

  const points = Array.from(value);
  if (points.length <= maxLength) return value;

  const suffixPoints = Array.from(suffix);
  return points.slice(0, Math.max(0, maxLength - suffixPoints.length)).join('') + suffixPoints.join('');
}
