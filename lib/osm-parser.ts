/**
 * OSM PBF Parser for extracting places, boundaries, and building geometries.
 */

import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Writable } from "node:stream";

// @ts-ignore - osm-pbf-parser doesn't have types
import createParser from "osm-pbf-parser";
import { centroid as calculatePolygonCentroid } from "./geo";

export interface OSMNode {
  type: "node";
  id: number;
  lat: number;
  lon: number;
  tags: Record<string, string>;
}

export interface OSMWay {
  type: "way";
  id: number;
  refs: number[];
  tags: Record<string, string>;
}

export interface OSMRelation {
  type: "relation";
  id: number;
  members: Array<{
    type: "node" | "way" | "relation";
    id: number; // osm-pbf-parser uses 'id' not 'ref'
    role: string;
  }>;
  tags: Record<string, string>;
}

export type OSMElement = OSMNode | OSMWay | OSMRelation;

export interface ParsedPlace {
  osm_id: number;
  osm_type: "node" | "way" | "relation";
  place_type: string;
  names: Record<string, string>;
  center_lat: number;
  center_lng: number;
  polygon: GeoJSON.Polygon | GeoJSON.MultiPolygon | null;
}

export interface ParsedBoundary {
  osm_id: number;
  osm_type: "node" | "way" | "relation";
  boundary_type: "postal_code" | "administrative";
  postal_code?: string;
  admin_level?: number;
  name: string;
  names: Record<string, string>;
  country_code?: string;
  place_type?: string;
  center_lat?: number;
  center_lng?: number;
  polygon: GeoJSON.Polygon | GeoJSON.MultiPolygon | null;
}

/**
 * First pass: collect all node coordinates for way geometry resolution.
 */
export async function collectNodeCoords(
  pbfPath: string
): Promise<Map<number, [number, number]>> {
  const nodes = new Map<number, [number, number]>();
  const parser = createParser();

  await pipeline(
    createReadStream(pbfPath),
    parser,
    new Writable({
      objectMode: true,
      write(items: OSMElement[], _encoding, callback) {
        for (const item of items) {
          if (item.type === "node") {
            nodes.set(item.id, [item.lon, item.lat]);
          }
        }
        callback();
      },
    })
  );

  return nodes;
}

/**
 * Second pass: collect way geometries for relation resolution.
 */
export async function collectWayGeometries(
  pbfPath: string,
  nodeCoords: Map<number, [number, number]>
): Promise<Map<number, GeoJSON.Position[]>> {
  const ways = new Map<number, GeoJSON.Position[]>();
  const parser = createParser();

  await pipeline(
    createReadStream(pbfPath),
    parser,
    new Writable({
      objectMode: true,
      write(items: OSMElement[], _encoding, callback) {
        for (const item of items) {
          if (item.type === "way") {
            const coords: GeoJSON.Position[] = [];
            for (const ref of item.refs) {
              const coord = nodeCoords.get(ref);
              if (coord) {
                coords.push(coord);
              }
            }
            if (coords.length >= 2) {
              ways.set(item.id, coords);
            }
          }
        }
        callback();
      },
    })
  );

  return ways;
}

/**
 * Extract name translations from tags.
 */
export function extractNames(
  tags: Record<string, string>
): Record<string, string> {
  const names: Record<string, string> = {};

  // Default name
  if (tags.name) {
    names.default = tags.name;
  }

  // All name:* translations
  for (const [key, value] of Object.entries(tags)) {
    if (key.startsWith("name:")) {
      const lang = key.slice(5);
      names[lang] = value;
    }
    // Also handle alt_name, official_name, etc.
    if (key === "alt_name") {
      names.alt = value;
    }
    if (key === "official_name") {
      names.official = value;
    }
  }

  return names;
}

/**
 * Build polygon from way coordinates (assumes closed ring).
 */
export function buildPolygonFromWay(
  coords: GeoJSON.Position[]
): GeoJSON.Polygon | null {
  if (coords.length < 4) return null;

  // Ensure ring is closed
  const first = coords[0]!;
  const last = coords[coords.length - 1]!;
  if (first[0] !== last[0] || first[1] !== last[1]) {
    coords = [...coords, first];
  }

  return {
    type: "Polygon",
    coordinates: [coords],
  };
}

/**
 * Build polygon from relation members (outer and inner rings).
 */
export function buildPolygonFromRelation(
  members: OSMRelation["members"],
  wayGeometries: Map<number, GeoJSON.Position[]>
): GeoJSON.Polygon | GeoJSON.MultiPolygon | null {
  const outerRings: GeoJSON.Position[][] = [];
  const innerRings: GeoJSON.Position[][] = [];

  // Collect way references by role
  const outerWayRefs: number[] = [];
  const innerWayRefs: number[] = [];

  for (const member of members) {
    if (member.type === "way") {
      if (member.role === "outer" || member.role === "") {
        outerWayRefs.push(member.id);
      } else if (member.role === "inner") {
        innerWayRefs.push(member.id);
      }
    }
  }

  // Build outer rings by joining ways
  const outerJoined = joinWays(outerWayRefs, wayGeometries);
  for (const ring of outerJoined) {
    if (ring.length >= 4) {
      outerRings.push(ensureClosed(ring));
    }
  }

  // Build inner rings
  const innerJoined = joinWays(innerWayRefs, wayGeometries);
  for (const ring of innerJoined) {
    if (ring.length >= 4) {
      innerRings.push(ensureClosed(ring));
    }
  }

  if (outerRings.length === 0) return null;

  if (outerRings.length === 1) {
    return {
      type: "Polygon",
      coordinates: [outerRings[0]!, ...innerRings],
    };
  }

  // Multiple outer rings = MultiPolygon
  // Note: Inner rings are dropped for MultiPolygons because we'd need point-in-polygon
  // tests to associate each inner ring with the correct outer ring. This affects
  // very few boundaries (mostly islands with lakes) and the impact is minimal.
  if (innerRings.length > 0) {
    console.warn(
      `  Warning: Dropping ${innerRings.length} inner ring(s) from MultiPolygon with ${outerRings.length} outer rings`
    );
  }
  return {
    type: "MultiPolygon",
    coordinates: outerRings.map((outer) => [outer]),
  };
}

/**
 * Join ways that share endpoints into continuous rings.
 */
function joinWays(
  wayRefs: number[],
  wayGeometries: Map<number, GeoJSON.Position[]>
): GeoJSON.Position[][] {
  const rings: GeoJSON.Position[][] = [];
  const remaining = new Set(wayRefs);

  while (remaining.size > 0) {
    const firstRef = remaining.values().next().value!;
    remaining.delete(firstRef);

    const firstCoords = wayGeometries.get(firstRef);
    if (!firstCoords || firstCoords.length < 2) continue;

    let ring = [...firstCoords];

    // Keep trying to extend the ring
    let extended = true;
    while (extended && remaining.size > 0) {
      extended = false;
      const ringStart = ring[0]!;
      const ringEnd = ring[ring.length - 1]!;

      for (const ref of remaining) {
        const coords = wayGeometries.get(ref);
        if (!coords || coords.length < 2) {
          remaining.delete(ref);
          continue;
        }

        const wayStart = coords[0]!;
        const wayEnd = coords[coords.length - 1]!;

        // Check if this way connects to our ring
        if (coordsEqual(ringEnd, wayStart)) {
          ring = [...ring, ...coords.slice(1)];
          remaining.delete(ref);
          extended = true;
          break;
        } else if (coordsEqual(ringEnd, wayEnd)) {
          ring = [...ring, ...coords.slice(0, -1).reverse()];
          remaining.delete(ref);
          extended = true;
          break;
        } else if (coordsEqual(ringStart, wayEnd)) {
          ring = [...coords.slice(0, -1), ...ring];
          remaining.delete(ref);
          extended = true;
          break;
        } else if (coordsEqual(ringStart, wayStart)) {
          ring = [...coords.reverse().slice(0, -1), ...ring];
          remaining.delete(ref);
          extended = true;
          break;
        }
      }
    }

    if (ring.length >= 4) {
      rings.push(ring);
    }
  }

  return rings;
}

function coordsEqual(a: GeoJSON.Position, b: GeoJSON.Position): boolean {
  return (
    Math.abs((a[0] ?? 0) - (b[0] ?? 0)) < 1e-9 &&
    Math.abs((a[1] ?? 0) - (b[1] ?? 0)) < 1e-9
  );
}

function ensureClosed(ring: GeoJSON.Position[]): GeoJSON.Position[] {
  if (ring.length < 2) return ring;
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  if (!coordsEqual(first, last)) {
    return [...ring, first];
  }
  return ring;
}

/**
 * Calculate centroid from coordinates.
 */
export function calculateCentroid(
  coords: GeoJSON.Position[]
): [number, number] {
  if (coords.length === 0) return [0, 0];

  let sumLon = 0;
  let sumLat = 0;
  for (const coord of coords) {
    sumLon += coord[0] ?? 0;
    sumLat += coord[1] ?? 0;
  }

  return [sumLon / coords.length, sumLat / coords.length];
}

export interface ParsedAddressPoint {
  osm_id: number;
  lat: number;
  lng: number;
  postal_code: string;
}

export interface ParseResult {
  places: ParsedPlace[];
  postalBoundaries: ParsedBoundary[];
  adminBoundaries: ParsedBoundary[];
  addressPoints: ParsedAddressPoint[];
}

const PLACE_TYPES = new Set([
  "suburb",
  "city_district",
  "borough",
  "neighbourhood",
  "quarter",
]);

const PARENT_PLACE_TYPES = new Set(["city", "town", "municipality", "village"]);

/**
 * Full parse of a filtered PBF file.
 * The PBF should already be filtered with osmium to contain only relevant elements.
 */
export async function parsePBF(pbfPath: string): Promise<ParseResult> {
  console.log("Pass 1: Collecting node coordinates...");
  const nodeCoords = await collectNodeCoords(pbfPath);
  console.log(`  Found ${nodeCoords.size} nodes`);

  console.log("Pass 2: Building way geometries...");
  const wayGeometries = await collectWayGeometries(pbfPath, nodeCoords);
  console.log(`  Built ${wayGeometries.size} way geometries`);

  console.log("Pass 3: Extracting places, boundaries, and address points...");
  const result = await extractElements(pbfPath, nodeCoords, wayGeometries);
  console.log(`  Found ${result.places.length} places`);
  console.log(`  Found ${result.postalBoundaries.length} postal boundaries`);
  console.log(`  Found ${result.adminBoundaries.length} admin boundaries`);
  console.log(
    `  Found ${result.addressPoints.length} address points with postal codes`
  );

  return result;
}

async function extractElements(
  pbfPath: string,
  nodeCoords: Map<number, [number, number]>,
  wayGeometries: Map<number, GeoJSON.Position[]>
): Promise<ParseResult> {
  const places: ParsedPlace[] = [];
  const postalBoundaries: ParsedBoundary[] = [];
  const adminBoundaries: ParsedBoundary[] = [];
  const addressPoints: ParsedAddressPoint[] = [];

  const parser = createParser();

  await pipeline(
    createReadStream(pbfPath),
    parser,
    new Writable({
      objectMode: true,
      write(items: OSMElement[], _encoding, callback) {
        for (const item of items) {
          const tags = item.tags || {};

          // Check for places
          const placeType = tags.place;
          if (placeType && PLACE_TYPES.has(placeType)) {
            const place = processPlace(item, nodeCoords, wayGeometries);
            if (place) places.push(place);
          }

          // Check for parent places (cities, towns, etc.) - also store as admin boundaries
          if (placeType && PARENT_PLACE_TYPES.has(placeType)) {
            const boundary = processParentPlace(item, wayGeometries);
            if (boundary) adminBoundaries.push(boundary);
          }

          // Check for postal code boundaries
          if (tags.boundary === "postal_code") {
            const boundary = processPostalBoundary(item, wayGeometries);
            if (boundary) postalBoundaries.push(boundary);
          }

          // Check for administrative boundaries
          if (tags.boundary === "administrative" && tags.admin_level) {
            const boundary = processAdminBoundary(item, wayGeometries);
            if (boundary) adminBoundaries.push(boundary);
          }

          // Check for address points with postal codes
          if (item.type === "node" && tags["addr:postcode"]) {
            addressPoints.push({
              osm_id: item.id,
              lat: item.lat,
              lng: item.lon,
              postal_code: tags["addr:postcode"],
            });
          }
        }
        callback();
      },
    })
  );

  return { places, postalBoundaries, adminBoundaries, addressPoints };
}

function processPlace(
  item: OSMElement,
  nodeCoords: Map<number, [number, number]>,
  wayGeometries: Map<number, GeoJSON.Position[]>
): ParsedPlace | null {
  const tags = item.tags || {};
  const names = extractNames(tags);

  if (!names.default && Object.keys(names).length === 0) return null;

  let center_lat: number;
  let center_lng: number;
  let polygon: GeoJSON.Polygon | GeoJSON.MultiPolygon | null = null;

  if (item.type === "node") {
    center_lat = item.lat;
    center_lng = item.lon;
  } else if (item.type === "way") {
    const coords = wayGeometries.get(item.id);
    if (!coords || coords.length < 2) return null;

    const [lon, lat] = calculateCentroid(coords);
    center_lat = lat;
    center_lng = lon;
    polygon = buildPolygonFromWay(coords);
  } else {
    // Relation
    polygon = buildPolygonFromRelation(item.members, wayGeometries);
    if (polygon) {
      const center = calculatePolygonCentroid(polygon);
      center_lat = center.lat;
      center_lng = center.lng;
    } else {
      // Polygon could not be built from relation - calculate center from member way centroids
      // This happens when way geometries are incomplete or malformed
      console.warn(
        `  Warning: Could not build polygon for relation ${item.id}, using member centroid fallback`
      );
      let sumLat = 0;
      let sumLng = 0;
      let count = 0;
      for (const member of item.members) {
        if (member.type === "way") {
          const coords = wayGeometries.get(member.id);
          if (coords) {
            const [lon, lat] = calculateCentroid(coords);
            sumLat += lat;
            sumLng += lon;
            count++;
          }
        }
      }
      if (count === 0) return null;
      center_lat = sumLat / count;
      center_lng = sumLng / count;
    }
  }

  return {
    osm_id: item.id,
    osm_type: item.type,
    place_type: tags.place!,
    names,
    center_lat,
    center_lng,
    polygon,
  };
}

function processPostalBoundary(
  item: OSMElement,
  wayGeometries: Map<number, GeoJSON.Position[]>
): ParsedBoundary | null {
  if (item.type === "node") return null;

  const tags = item.tags || {};
  const postalCode = tags.postal_code || tags.ref;
  if (!postalCode) return null;

  let polygon: GeoJSON.Polygon | GeoJSON.MultiPolygon | null = null;

  if (item.type === "way") {
    const coords = wayGeometries.get(item.id);
    if (coords) {
      polygon = buildPolygonFromWay(coords);
    }
  } else {
    polygon = buildPolygonFromRelation(item.members, wayGeometries);
  }

  if (!polygon) return null;

  const names = extractNames(tags);

  return {
    osm_id: item.id,
    osm_type: item.type,
    boundary_type: "postal_code",
    postal_code: postalCode,
    name: tags.name || postalCode,
    names,
    polygon,
  };
}

function processAdminBoundary(
  item: OSMElement,
  wayGeometries: Map<number, GeoJSON.Position[]>
): ParsedBoundary | null {
  if (item.type === "node") return null;

  const tags = item.tags || {};
  const adminLevel = parseInt(tags.admin_level!, 10);
  if (isNaN(adminLevel)) return null;

  const name = tags.name;
  if (!name) return null;

  let polygon: GeoJSON.Polygon | GeoJSON.MultiPolygon | null = null;

  if (item.type === "way") {
    const coords = wayGeometries.get(item.id);
    if (coords) {
      polygon = buildPolygonFromWay(coords);
    }
  } else {
    polygon = buildPolygonFromRelation(item.members, wayGeometries);
  }

  const names = extractNames(tags);
  const countryCode =
    tags["ISO3166-1:alpha2"] || tags["ISO3166-1"] || undefined;

  return {
    osm_id: item.id,
    osm_type: item.type,
    boundary_type: "administrative",
    admin_level: adminLevel,
    name,
    names,
    country_code: countryCode,
    polygon,
  };
}

function processParentPlace(
  item: OSMElement,
  wayGeometries: Map<number, GeoJSON.Position[]>
): ParsedBoundary | null {
  const tags = item.tags || {};
  const name = tags.name;
  if (!name) return null;

  let polygon: GeoJSON.Polygon | GeoJSON.MultiPolygon | null = null;
  let centerLat: number | undefined;
  let centerLng: number | undefined;

  if (item.type === "node") {
    centerLat = item.lat;
    centerLng = item.lon;
  } else if (item.type === "way") {
    const coords = wayGeometries.get(item.id);
    if (coords) {
      polygon = buildPolygonFromWay(coords);
      const [lon, lat] = calculateCentroid(coords);
      centerLat = lat;
      centerLng = lon;
    }
  } else {
    polygon = buildPolygonFromRelation(item.members, wayGeometries);
    if (polygon) {
      const center = calculatePolygonCentroid(polygon);
      centerLat = center.lat;
      centerLng = center.lng;
    }
  }

  const names = extractNames(tags);

  return {
    osm_id: item.id,
    osm_type: item.type,
    boundary_type: "administrative",
    admin_level: 99, // Use 99 for place-based boundaries (city, town, etc.)
    center_lat: centerLat,
    center_lng: centerLng,
    name,
    names,
    place_type: tags.place,
    polygon,
  };
}
