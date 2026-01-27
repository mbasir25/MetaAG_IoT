import * as turf from "@turf/turf";

export function checkInsidePolygon(point, polygons) {
  const pt = turf.point(point); // [lng, lat]
  for (const feature of polygons.features) {
    if (turf.booleanPointInPolygon(pt, feature)) {
      return feature.properties.name;
    }
  }
  return null;
}



/**
 * Compute centroid of a polygon ring [[lng, lat], ...].
 * Works well for small field polygons (planar approximation).
 */
export function polygonCentroid(lngLatRing) {
  let area = 0, cx = 0, cy = 0;
  const n = lngLatRing.length;
  if (n < 3) {
    const m = lngLatRing.reduce((a, [x, y]) => [a[0] + x, a[1] + y], [0, 0]);
    return { lng: m[0] / n, lat: m[1] / n };
  }
  for (let i = 0; i < n - 1; i++) {
    const [x1, y1] = lngLatRing[i];
    const [x2, y2] = lngLatRing[i + 1];
    const w = x1 * y2 - x2 * y1;
    area += w;
    cx += (x1 + x2) * w;
    cy += (y1 + y2) * w;
  }
  area *= 0.5;
  if (Math.abs(area) < 1e-12) {
    const m = lngLatRing.reduce((a, [x, y]) => [a[0] + x, a[1] + y], [0, 0]);
    return { lng: m[0] / n, lat: m[1] / n };
  }
  return { lng: cx / (6 * area), lat: cy / (6 * area) };
}

/** Normalize field names for comparison (trim, lowercase, collapse spaces) */
export function normalizeFieldName(s) {
  return String(s)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** Find a polygon feature by its (normalized) name */
export function findFeatureByName(polygons, fieldName) {
  const target = normalizeFieldName(fieldName);
  return polygons.features.find(
    f => normalizeFieldName(f?.properties?.name) === target
  );
}