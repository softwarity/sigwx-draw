/**
 * Geographic coordinate helpers. SIGWX has no TAC text form (unlike SIGMET), so
 * this is a trimmed copy of sigmet-draw's `coord.ts`: just the `LatLng` type and
 * the decimal-degree formatters used for FL/position labels. We always work in
 * decimal degrees (lon, lat) to stay aligned with GeoJSON, turf and MapLibre.
 */

/** A geographic position in decimal degrees. */
export interface LatLng {
  /** Latitude in decimal degrees, south negative. Range [-90, 90]. */
  lat: number;
  /** Longitude in decimal degrees, west negative. Range [-180, 180]. */
  lon: number;
}

/** Split a signed decimal degree value into whole degrees + rounded minutes. */
function toDegMin(value: number): { deg: number; min: number } {
  const abs = Math.abs(value);
  let deg = Math.floor(abs);
  let min = Math.round((abs - deg) * 60);
  if (min === 60) {
    deg += 1;
    min = 0;
  }
  return { deg, min };
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/** Encode a latitude (decimal degrees) as `Nnnmm` / `Snnmm` (always 4 digits). */
export function formatLat(lat: number): string {
  lat = Math.min(90, Math.max(-90, lat));
  const hemi = lat < 0 ? "S" : "N";
  const { deg, min } = toDegMin(lat);
  return `${hemi}${pad(deg, 2)}${pad(min, 2)}`;
}

/** Encode a longitude (decimal degrees) as `Wnnnmm` / `Ennnmm` (always 5 digits). */
export function formatLon(lon: number): string {
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  const hemi = lon < 0 ? "W" : "E";
  const { deg, min } = toDegMin(lon);
  return `${hemi}${pad(deg, 3)}${pad(min, 2)}`;
}

/** Encode a position as a coordinate pair, e.g. `N2706 W07306`. */
export function formatLatLng(p: LatLng): string {
  return `${formatLat(p.lat)} ${formatLon(p.lon)}`;
}
