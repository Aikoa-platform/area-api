/**
 * Shared type definitions for the locations server.
 */

// ============================================
// Geographic Types
// ============================================

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

// ============================================
// Area Types
// ============================================

/**
 * Main area type from the database schema.
 */
export interface Area {
  id: number;
  osm_id: number;
  osm_type: string;
  place_type: string;
  name: string;
  names: Record<string, string>;
  center_lat: number;
  center_lng: number;
  polygon: GeoJSON.Polygon | GeoJSON.MultiPolygon | null;
  postal_code: string | null;
  country_code: string;
  country_name: string;
  parent_city: string | null;
  parent_city_osm_id: number | null;
  parent_municipality: string | null;
  bbox_min_lat: number | null;
  bbox_min_lng: number | null;
  bbox_max_lat: number | null;
  bbox_max_lng: number | null;
}

/**
 * Raw area type used during ingestion.
 */
export interface RawArea {
  id: number;
  osm_id: number;
  osm_type: string;
  place_type: string;
  names: Record<string, string>;
  center_lat: number;
  center_lng: number;
  polygon: GeoJSON.Polygon | GeoJSON.MultiPolygon | null;
  bbox_min_lat: number | null;
  bbox_min_lng: number | null;
  bbox_max_lat: number | null;
  bbox_max_lng: number | null;
}

/**
 * Postal boundary type.
 */
export interface PostalBoundary {
  id: number;
  osm_id: number;
  postal_code: string;
  polygon: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  center_lat: number | null;
  center_lng: number | null;
  bbox_min_lat: number | null;
  bbox_min_lng: number | null;
  bbox_max_lat: number | null;
  bbox_max_lng: number | null;
}

/**
 * Administrative boundary type.
 */
export interface AdminBoundary {
  id: number;
  osm_id: number;
  admin_level: number;
  name: string;
  names: Record<string, string> | null;
  place_type: string | null;
  country_code: string | null;
  polygon: GeoJSON.Polygon | GeoJSON.MultiPolygon | null;
  center_lat: number | null;
  center_lng: number | null;
  bbox_min_lat: number | null;
  bbox_min_lng: number | null;
  bbox_max_lat: number | null;
  bbox_max_lng: number | null;
}

// ============================================
// API Result Types
// ============================================

/**
 * Area result returned by query functions.
 */
export interface AreaResult {
  id: number;
  osm_id: number;
  osm_type: string;
  place_type: string;
  name: string;
  names: Record<string, string>;
  center: {
    lat: number;
    lng: number;
  };
  postal_code: string | null;
  country_code: string;
  country_name: string;
  parent_city: string | null;
  parent_municipality: string | null;
  distance_meters?: number;
}

/**
 * Grouped area result with aggregated postal codes.
 */
export interface GroupedAreaResult {
  osm_id: number;
  osm_type: string;
  place_type: string;
  name: string;
  names: Record<string, string>;
  center: {
    lat: number;
    lng: number;
  };
  postal_codes: string[];
  country_code: string;
  country_name: string;
  parent_city: string | null;
  parent_municipality: string | null;
  distance_meters?: number;
}

/**
 * Adjacent area result with direction and level information.
 */
export interface AdjacentAreaResult {
  osm_id: number;
  osm_type: string;
  place_type: string;
  name: string;
  names: Record<string, string>;
  center: {
    lat: number;
    lng: number;
  };
  postal_codes: string[];
  country_code: string;
  country_name: string;
  parent_city: string | null;
  parent_municipality: string | null;
  distance_meters: number;
  /** Direction from center in degrees (0=N, 90=E, 180=S, 270=W), rounded to 45° */
  degrees: number;
  /** Cardinal direction (N, NE, E, SE, S, SW, W, NW) */
  direction: string;
  /** Level/ring from center (0=center, 1=adjacent, 2=next ring, etc.) */
  level: number;
}

/**
 * Adjacent search result with center and adjacent areas.
 */
export interface AdjacentSearchResult {
  center: GroupedAreaResult;
  adjacent: AdjacentAreaResult[];
}

// ============================================
// Search Types
// ============================================

/**
 * Options for area search.
 */
export interface SearchOptions {
  limit?: number;
  countryCode?: string;
  biasLat?: number;
  biasLng?: number;
  /** Weight for proximity scoring (0.0 to 1.0, default 0.2) */
  proximityWeight?: number;
}

/**
 * Search result with scoring information.
 */
export interface SearchResult {
  id: number;
  osm_id: number;
  osm_type: string;
  place_type: string;
  name: string;
  names: Record<string, string>;
  center: { lat: number; lng: number };
  postal_code: string | null;
  country_code: string;
  country_name: string;
  parent_city: string | null;
  parent_municipality: string | null;
  distance_meters?: number;
  /** Final combined score (0-1, higher is better) */
  score: number;
}
