export const ASSET_COLORS = [
  "#4cc9f0",
  "#7bd88f",
  "#f2c94c",
  "#ff8f70",
  "#b794f4",
  "#5eead4",
  "#f472b6"
] as const;

export function pickAssetColor(index: number): string {
  const normalizedIndex = Math.abs(Math.trunc(index)) % ASSET_COLORS.length;
  return ASSET_COLORS[normalizedIndex];
}

export function pickAssetColorByName(name: string): string {
  return pickAssetColor(hashString(name));
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return hash;
}
