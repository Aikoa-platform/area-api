/**
 * Resolve parent cities and country codes for raw areas using admin boundaries.
 */

import { Database } from "bun:sqlite";
import { pointInPolygon } from "../lib/geo";

interface RawAreaRow {
  id: number;
  osm_id: number;
  osm_type: string;
  place_type: string;
  names: string;
  center_lat: number;
  center_lng: number;
  polygon: string | null;
}

interface AdminBoundaryRow {
  id: number;
  osm_id: number;
  admin_level: number;
  name: string;
  names: string | null;
  place_type: string | null;
  country_code: string | null;
  polygon: string | null;
}

interface PlaceCandidate {
  osm_id: number;
  name: string;
  center_lat: number;
  center_lng: number;
  place_type: string;
}

export interface HierarchyResult {
  country_code: string | null;
  country_name: string | null;
  parent_city: string | null;
  parent_city_osm_id: number | null;
  parent_municipality: string | null;
}

/**
 * Find the containing admin boundaries for a point.
 */
export function findContainingBoundaries(
  db: Database,
  lat: number,
  lng: number
): AdminBoundaryRow[] {
  // Use R-tree to find candidate boundaries whose bbox contains the point
  const candidates = db
    .query<AdminBoundaryRow, [number, number, number, number]>(
      `
    SELECT ab.* FROM admin_boundaries ab
    INNER JOIN admin_rtree rt ON ab.id = rt.id
    WHERE rt.min_lat <= ? AND rt.max_lat >= ?
      AND rt.min_lng <= ? AND rt.max_lng >= ?
    ORDER BY ab.admin_level DESC
  `
    )
    .all(lat, lat, lng, lng);

  // Filter to those whose polygon actually contains the point
  const containing: AdminBoundaryRow[] = [];

  for (const candidate of candidates) {
    if (!candidate.polygon) continue;

    try {
      const polygon = JSON.parse(candidate.polygon) as
        | GeoJSON.Polygon
        | GeoJSON.MultiPolygon;
      if (pointInPolygon({ lat, lng }, polygon)) {
        containing.push(candidate);
      }
    } catch (error) {
      console.warn(
        `  Warning: Invalid polygon JSON for boundary '${candidate.name}' (osm_id=${candidate.osm_id}): ${error}`
      );
    }
  }

  return containing;
}

/**
 * Get priority weight for a place type.
 * Higher values = higher priority. Cities are larger so should be preferred.
 */
function getPlaceTypePriority(placeType: string): number {
  switch (placeType) {
    case "city":
      return 100;
    case "municipality":
      return 90;
    case "town":
      return 50;
    case "village":
      return 10;
    default:
      return 1;
  }
}

/**
 * Get approximate radius in degrees for a place type.
 * Cities are large, so their center can be far from a suburb that's still within the city.
 */
function getPlaceTypeRadius(placeType: string): number {
  switch (placeType) {
    case "city":
      return 0.25; // ~25km - cities can be large
    case "municipality":
      return 0.2; // ~20km
    case "town":
      return 0.08; // ~8km
    case "village":
      return 0.03; // ~3km
    default:
      return 0.05;
  }
}

/**
 * Find the best matching city/municipality for a point using weighted distance.
 * Prefers cities/municipalities over towns, accounting for their larger area.
 */
function findBestMatchingPlace(
  db: Database,
  lat: number,
  lng: number
): { name: string; osm_id: number } | null {
  // Search within a reasonable radius
  const searchRadius = 0.3; // ~30km
  const minLat = lat - searchRadius;
  const maxLat = lat + searchRadius;
  const minLng = lng - searchRadius;
  const maxLng = lng + searchRadius;

  // Find city/municipality/town places within bbox
  const candidates = db
    .query<PlaceCandidate, [number, number, number, number]>(
      `
      SELECT ab.osm_id, ab.name, ab.center_lat, ab.center_lng, ab.place_type
      FROM admin_boundaries ab
      INNER JOIN admin_rtree rt ON ab.id = rt.id
      WHERE rt.max_lat >= ? AND rt.min_lat <= ?
        AND rt.max_lng >= ? AND rt.min_lng <= ?
        AND ab.admin_level = 99
        AND ab.place_type IN ('city', 'municipality', 'town')
        AND ab.center_lat IS NOT NULL
    `
    )
    .all(minLat, maxLat, minLng, maxLng);

  if (candidates.length === 0) {
    return null;
  }

  // Score each candidate based on distance and place type
  let bestCandidate: PlaceCandidate | null = null;
  let bestScore = -Infinity;

  for (const candidate of candidates) {
    const distance = Math.sqrt(
      Math.pow(lat - candidate.center_lat, 2) +
        Math.pow(lng - candidate.center_lng, 2)
    );

    const priority = getPlaceTypePriority(candidate.place_type);
    const expectedRadius = getPlaceTypeRadius(candidate.place_type);

    // If within expected radius, give high score based on priority
    // If outside expected radius, penalize but still consider based on priority
    let score: number;
    if (distance <= expectedRadius) {
      // Within expected radius - high score, priority matters most
      score = priority * 10 - distance * 10;
    } else {
      // Outside expected radius - lower score, distance matters more
      const overflow = distance - expectedRadius;
      score = priority - overflow * 100;
    }

    if (score > bestScore) {
      bestScore = score;
      bestCandidate = candidate;
    }
  }

  if (bestCandidate) {
    return { name: bestCandidate.name, osm_id: bestCandidate.osm_id };
  }

  return null;
}

/**
 * Resolve hierarchy for a single point.
 */
export function resolveHierarchy(
  db: Database,
  lat: number,
  lng: number,
  defaultCountryCode: string,
  defaultCountryName: string
): HierarchyResult {
  const boundaries = findContainingBoundaries(db, lat, lng);

  let country_code: string | null = null;
  let parent_city: string | null = null;
  let parent_city_osm_id: number | null = null;
  let parent_municipality: string | null = null;

  for (const boundary of boundaries) {
    // admin_level=2 is country
    if (boundary.admin_level === 2 && boundary.country_code) {
      country_code = boundary.country_code;
    }

    // admin_level=8 in Finland is municipality
    // In other countries this varies, but 8 is often municipality/city level
    if (boundary.admin_level === 8 && !parent_municipality) {
      parent_municipality = boundary.name;
      // In Finland (and many countries), municipality IS the city - use it as parent_city
      if (!parent_city) {
        parent_city = boundary.name;
        parent_city_osm_id = boundary.osm_id;
      }
    }

    // Look for city/town places (admin_level 99 = place-based)
    if (boundary.admin_level === 99) {
      if (boundary.place_type === "city" || boundary.place_type === "town") {
        if (!parent_city) {
          parent_city = boundary.name;
          parent_city_osm_id = boundary.osm_id;
        }
      }
    }

    // Some cities are admin_level=7 or lower
    if (boundary.admin_level >= 6 && boundary.admin_level < 8) {
      // Check if this looks like a city (has certain size indicators)
      if (!parent_city && boundary.place_type) {
        if (boundary.place_type === "city" || boundary.place_type === "town") {
          parent_city = boundary.name;
          parent_city_osm_id = boundary.osm_id;
        }
      }
    }
  }

  // If no parent city found from polygon containment, use weighted place matching
  // This accounts for the fact that cities are larger and their center can be
  // farther from a suburb than a nearby town's center
  if (!parent_city) {
    const bestMatch = findBestMatchingPlace(db, lat, lng);
    if (bestMatch) {
      parent_city = bestMatch.name;
      parent_city_osm_id = bestMatch.osm_id;
    }
  }

  // Set municipality from parent_city if not found via polygon
  if (!parent_municipality && parent_city) {
    parent_municipality = parent_city;
  }

  return {
    country_code: country_code || defaultCountryCode,
    country_name: defaultCountryName,
    parent_city,
    parent_city_osm_id,
    parent_municipality,
  };
}

/**
 * Resolve hierarchy for all raw areas and cache results.
 */
export function resolveAllHierarchies(
  db: Database,
  defaultCountryCode: string,
  defaultCountryName: string
): Map<number, HierarchyResult> {
  console.log("Resolving hierarchy for all areas...");

  const areas = db.query<RawAreaRow, []>("SELECT * FROM raw_areas").all();
  const results = new Map<number, HierarchyResult>();

  // Track how parent_city was resolved
  let polygonContainment = 0;
  let fallbackMatching = 0;
  let noParentCity = 0;

  let processed = 0;
  for (const area of areas) {
    const hierarchy = resolveHierarchy(
      db,
      area.center_lat,
      area.center_lng,
      defaultCountryCode,
      defaultCountryName
    );
    results.set(area.id, hierarchy);

    // Track method used
    if (hierarchy.parent_city) {
      // Check if it was from polygon containment by looking for municipality match
      if (hierarchy.parent_municipality === hierarchy.parent_city) {
        polygonContainment++;
      } else {
        fallbackMatching++;
      }
    } else {
      noParentCity++;
    }

    processed++;
    if (processed % 100 === 0) {
      console.log(`  Processed ${processed}/${areas.length} areas`);
    }
  }

  console.log(`  Resolved hierarchy for ${results.size} areas`);
  console.log(`  Parent city sources:`);
  console.log(`    - From polygon containment: ${polygonContainment}`);
  if (fallbackMatching > 0) {
    console.log(`    - Using distance-based fallback: ${fallbackMatching}`);
  }
  if (noParentCity > 0) {
    console.log(`    - No parent city found: ${noParentCity}`);
  }
  return results;
}
