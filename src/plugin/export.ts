export function base64Encode(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const hasSecond = index + 1 < bytes.length;
    const hasThird = index + 2 < bytes.length;
    const second = hasSecond ? bytes[index + 1] : 0;
    const third = hasThird ? bytes[index + 2] : 0;
    const value = (first << 16) | (second << 8) | third;
    output += alphabet[(value >> 18) & 63];
    output += alphabet[(value >> 12) & 63];
    output += hasSecond ? alphabet[(value >> 6) & 63] : '=';
    output += hasThird ? alphabet[value & 63] : '=';
  }
  return output;
}

export function computeExportScale(
  bounds: { width: number; height: number } | null,
  requestedScale: number,
  maxDimension?: number,
): number {
  let scale = requestedScale;
  if (typeof maxDimension === 'number' && bounds && Math.max(bounds.width, bounds.height) > 0) {
    scale = Math.min(scale, maxDimension / Math.max(bounds.width, bounds.height));
  }
  return Math.max(0.01, Math.min(scale, 4));
}
