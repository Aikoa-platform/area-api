/**
 * Geospatial utilities for the area server.
 * Implements haversine distance, point-in-polygon, and polygon intersection.
 */

export interface Point {
  lat: number;
  lng: number;
}

export interface BBox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

const EARTH_RADIUS_METERS = 6371008.8;

/**
 * Calculate bearing (direction) from point A to point B in degrees.
 * 0 = North, 90 = East, 180 = South, 270 = West
 */
export function calculateBearing(from: Point, to: Point): number {
  const lat1 = (from.lat * Math.PI) / 180;
  const lat2 = (to.lat * Math.PI) / 180;
  const deltaLng = ((to.lng - from.lng) * Math.PI) / 180;

  const y = Math.sin(deltaLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(deltaLng);

  let bearing = (Math.atan2(y, x) * 180) / Math.PI;
  // Normalize to 0-360
  bearing = (bearing + 360) % 360;
  return bearing;
}

/**
 * Round bearing to nearest sector (1/8 = 45 degrees).
 * Returns 0, 45, 90, 135, 180, 225, 270, or 315.
 */
export function roundBearingToSector(
  bearing: number,
  sectors: number = 8
): number {
  const sectorSize = 360 / sectors;
  const halfSector = sectorSize / 2;
  // Shift by half sector so 0° is centered on North
  const adjusted = (bearing + halfSector) % 360;
  const sectorIndex = Math.floor(adjusted / sectorSize);
  return (sectorIndex * sectorSize) % 360;
}

/**
 * Get cardinal direction name from bearing.
 */
export function bearingToCardinal(bearing: number): string {
  const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const index = Math.round(bearing / 45) % 8;
  return directions[index] ?? "N";
}

/**
 * Calculate haversine distance between two points in meters.
 */
export function haversineDistance(p1: Point, p2: Point): number {
  const lat1Rad = (p1.lat * Math.PI) / 180;
  const lat2Rad = (p2.lat * Math.PI) / 180;
  const deltaLat = ((p2.lat - p1.lat) * Math.PI) / 180;
  const deltaLng = ((p2.lng - p1.lng) * Math.PI) / 180;

  const a =
    Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(lat1Rad) *
      Math.cos(lat2Rad) *
      Math.sin(deltaLng / 2) *
      Math.sin(deltaLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return EARTH_RADIUS_METERS * c;
}

/**
 * Calculate bounding box that encompasses a circle around a point.
 */
export function boundingBoxFromRadius(
  center: Point,
  radiusMeters: number
): BBox {
  // Approximate degrees per meter (varies with latitude)
  const latDelta = radiusMeters / 111320;
  const lngDelta =
    radiusMeters / (111320 * Math.cos((center.lat * Math.PI) / 180));

  return {
    minLat: center.lat - latDelta,
    maxLat: center.lat + latDelta,
    minLng: center.lng - lngDelta,
    maxLng: center.lng + lngDelta,
  };
}

/**
 * Check if two bounding boxes intersect.
 */
export function bboxIntersects(a: BBox, b: BBox): boolean {
  return !(
    a.maxLat < b.minLat ||
    a.minLat > b.maxLat ||
    a.maxLng < b.minLng ||
    a.minLng > b.maxLng
  );
}

/**
 * Check if a point is inside a bounding box.
 */
export function pointInBBox(point: Point, bbox: BBox): boolean {
  return (
    point.lat >= bbox.minLat &&
    point.lat <= bbox.maxLat &&
    point.lng >= bbox.minLng &&
    point.lng <= bbox.maxLng
  );
}

/**
 * Calculate bounding box from a GeoJSON polygon.
 */
export function bboxFromPolygon(
  polygon: GeoJSON.Polygon | GeoJSON.MultiPolygon
): BBox {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;

  const processCoords = (coords: GeoJSON.Position[]) => {
    for (const [lng, lat] of coords) {
      if (lng === undefined || lat === undefined) continue;

      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
    }
  };

  if (polygon.type === "Polygon") {
    for (const ring of polygon.coordinates) {
      processCoords(ring);
    }
  } else {
    for (const poly of polygon.coordinates) {
      for (const ring of poly) {
        processCoords(ring);
      }
    }
  }

  return { minLat, maxLat, minLng, maxLng };
}

/**
 * Calculate centroid of a polygon.
 */
export function centroid(
  polygon: GeoJSON.Polygon | GeoJSON.MultiPolygon
): Point {
  let sumLat = 0;
  let sumLng = 0;
  let count = 0;

  const processCoords = (coords: GeoJSON.Position[]) => {
    // Skip the last point since it's a duplicate of the first in closed rings
    for (let i = 0; i < coords.length - 1; i++) {
      const lng = coords[i]?.[0];
      const lat = coords[i]?.[1];
      if (lng === undefined || lat === undefined) continue;

      sumLng += lng;
      sumLat += lat;
      count++;
    }
  };

  if (polygon.type === "Polygon") {
    // Only use the outer ring for centroid calculation
    processCoords(polygon.coordinates[0] ?? []);
  } else {
    // For MultiPolygon, use all outer rings
    for (const poly of polygon.coordinates) {
      processCoords(poly[0] ?? []);
    }
  }

  return {
    lat: sumLat / count,
    lng: sumLng / count,
  };
}

/**
 * Check if a point is inside a polygon using ray casting algorithm.
 */
export function pointInPolygon(
  point: Point,
  polygon: GeoJSON.Polygon | GeoJSON.MultiPolygon
): boolean {
  const { lng: x, lat: y } = point;

  const checkRing = (ring: GeoJSON.Position[]): boolean => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const ringI = ring[i];
      const ringJ = ring[j];

      if (ringI?.[0] === undefined || ringI?.[1] === undefined) continue;
      if (ringJ?.[0] === undefined || ringJ?.[1] === undefined) continue;

      const xi = ringI[0];
      const yi = ringI[1];
      const xj = ringJ[0];
      const yj = ringJ[1];

      const intersect =
        yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;

      if (intersect) inside = !inside;
    }
    return inside;
  };

  if (polygon.type === "Polygon") {
    // Check if in outer ring
    if (!checkRing(polygon.coordinates[0] ?? [])) return false;
    // Check if in any holes
    for (let i = 1; i < polygon.coordinates.length; i++) {
      if (checkRing(polygon.coordinates[i] ?? [])) return false;
    }
    return true;
  } else {
    // MultiPolygon: check if in any of the polygons
    for (const poly of polygon.coordinates) {
      if (checkRing(poly[0] ?? [])) {
        // In outer ring, check holes
        let inHole = false;
        for (let i = 1; i < poly.length; i++) {
          if (checkRing(poly[i] ?? [])) {
            inHole = true;
            break;
          }
        }
        if (!inHole) return true;
      }
    }
    return false;
  }
}

/**
 * Check if two polygons intersect.
 * This is a simplified check - it checks if any vertex of one polygon
 * is inside the other, or if the bounding boxes overlap and edges intersect.
 */
export function polygonsIntersect(
  a: GeoJSON.Polygon | GeoJSON.MultiPolygon,
  b: GeoJSON.Polygon | GeoJSON.MultiPolygon
): boolean {
  // First, quick bounding box check
  const bboxA = bboxFromPolygon(a);
  const bboxB = bboxFromPolygon(b);

  if (!bboxIntersects(bboxA, bboxB)) {
    return false;
  }

  // Get all coordinates from both polygons
  const getOuterCoords = (
    poly: GeoJSON.Polygon | GeoJSON.MultiPolygon
  ): GeoJSON.Position[][] => {
    if (poly.type === "Polygon") {
      return [poly.coordinates[0] ?? []];
    }
    return poly.coordinates.map((p) => p[0] ?? []);
  };

  const coordsA = getOuterCoords(a);
  const coordsB = getOuterCoords(b);

  // Check if any vertex of A is inside B
  for (const ring of coordsA) {
    for (const [lng, lat] of ring) {
      if (pointInPolygon({ lat: lat ?? 0, lng: lng ?? 0 }, b)) {
        return true;
      }
    }
  }

  // Check if any vertex of B is inside A
  for (const ring of coordsB) {
    for (const [lng, lat] of ring) {
      if (pointInPolygon({ lat: lat ?? 0, lng: lng ?? 0 }, a)) {
        return true;
      }
    }
  }

  // Check for edge intersections (for cases where polygons cross but no vertex is inside)
  for (const ringA of coordsA) {
    for (const ringB of coordsB) {
      if (ringsIntersect(ringA, ringB)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if two rings have any intersecting edges.
 */
function ringsIntersect(
  ringA: GeoJSON.Position[],
  ringB: GeoJSON.Position[]
): boolean {
  for (let i = 0; i < ringA.length - 1; i++) {
    const a1 = ringA[i] ?? [0, 0];
    const a2 = ringA[i + 1] ?? [0, 0];

    for (let j = 0; j < ringB.length - 1; j++) {
      const b1 = ringB[j] ?? [0, 0];
      const b2 = ringB[j + 1] ?? [0, 0];

      if (segmentsIntersect(a1, a2, b1, b2)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Check if two line segments intersect.
 */
function segmentsIntersect(
  a1: GeoJSON.Position,
  a2: GeoJSON.Position,
  b1: GeoJSON.Position,
  b2: GeoJSON.Position
): boolean {
  const d1 = direction(b1, b2, a1);
  const d2 = direction(b1, b2, a2);
  const d3 = direction(a1, a2, b1);
  const d4 = direction(a1, a2, b2);

  if (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  ) {
    return true;
  }

  if (d1 === 0 && onSegment(b1, b2, a1)) return true;
  if (d2 === 0 && onSegment(b1, b2, a2)) return true;
  if (d3 === 0 && onSegment(a1, a2, b1)) return true;
  if (d4 === 0 && onSegment(a1, a2, b2)) return true;

  return false;
}

function direction(
  p1: GeoJSON.Position,
  p2: GeoJSON.Position,
  p3: GeoJSON.Position
): number {
  return (
    (p3[0]! - p1[0]!) * (p2[1]! - p1[1]!) -
    (p2[0]! - p1[0]!) * (p3[1]! - p1[1]!)
  );
}

function onSegment(
  p1: GeoJSON.Position,
  p2: GeoJSON.Position,
  p: GeoJSON.Position
): boolean {
  return (
    Math.min(p1[0]!, p2[0]!) <= p[0]! &&
    p[0]! <= Math.max(p1[0]!, p2[0]!) &&
    Math.min(p1[1]!, p2[1]!) <= p[1]! &&
    p[1]! <= Math.max(p1[1]!, p2[1]!)
  );
}

/**
 * Create a simple polygon from a bounding box (for areas without proper polygons).
 */
export function polygonFromBBox(bbox: BBox): GeoJSON.Polygon {
  return {
    type: "Polygon",
    coordinates: [
      [
        [bbox.minLng, bbox.minLat],
        [bbox.maxLng, bbox.minLat],
        [bbox.maxLng, bbox.maxLat],
        [bbox.minLng, bbox.maxLat],
        [bbox.minLng, bbox.minLat],
      ],
    ],
  };
}

/**
 * Create a circular polygon approximation around a point.
 */
export function circlePolygon(
  center: Point,
  radiusMeters: number,
  segments: number = 32
): GeoJSON.Polygon {
  const coords: GeoJSON.Position[] = [];

  for (let i = 0; i <= segments; i++) {
    const angle = (i / segments) * 2 * Math.PI;
    const latDelta = (radiusMeters * Math.cos(angle)) / 111320;
    const lngDelta =
      (radiusMeters * Math.sin(angle)) /
      (111320 * Math.cos((center.lat * Math.PI) / 180));

    coords.push([center.lng + lngDelta, center.lat + latDelta]);
  }

  return {
    type: "Polygon",
    coordinates: [coords],
  };
}
