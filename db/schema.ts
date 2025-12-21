import { Database } from "bun:sqlite";

export function initializeDatabase(dbPath: string): Database {
  const db = new Database(dbPath, { create: true });

  // Enable WAL mode for better concurrent read performance
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA cache_size = -64000"); // 64MB cache

  // Create raw areas table (intermediate, for processing)
  db.exec(`
    CREATE TABLE IF NOT EXISTS raw_areas (
      id INTEGER PRIMARY KEY,
      osm_id INTEGER NOT NULL,
      osm_type TEXT NOT NULL,
      place_type TEXT NOT NULL,
      names TEXT NOT NULL,
      center_lat REAL NOT NULL,
      center_lng REAL NOT NULL,
      polygon TEXT,
      bbox_min_lat REAL,
      bbox_min_lng REAL,
      bbox_max_lat REAL,
      bbox_max_lng REAL,
      UNIQUE(osm_type, osm_id)
    )
  `);

  // Create postal code boundaries table
  db.exec(`
    CREATE TABLE IF NOT EXISTS postal_boundaries (
      id INTEGER PRIMARY KEY,
      osm_id INTEGER NOT NULL,
      postal_code TEXT NOT NULL,
      polygon TEXT NOT NULL,
      center_lat REAL,
      center_lng REAL,
      bbox_min_lat REAL,
      bbox_min_lng REAL,
      bbox_max_lat REAL,
      bbox_max_lng REAL,
      UNIQUE(osm_id)
    )
  `);

  // Create administrative boundaries table
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_boundaries (
      id INTEGER PRIMARY KEY,
      osm_id INTEGER NOT NULL,
      admin_level INTEGER NOT NULL,
      name TEXT NOT NULL,
      names TEXT,
      place_type TEXT,
      country_code TEXT,
      polygon TEXT,
      center_lat REAL,
      center_lng REAL,
      bbox_min_lat REAL,
      bbox_min_lng REAL,
      bbox_max_lat REAL,
      bbox_max_lng REAL,
      UNIQUE(osm_id)
    )
  `);

  // Create final denormalized areas table
  db.exec(`
    CREATE TABLE IF NOT EXISTS areas (
      id INTEGER PRIMARY KEY,
      osm_id INTEGER NOT NULL,
      osm_type TEXT NOT NULL,
      place_type TEXT NOT NULL,
      name TEXT NOT NULL,
      names TEXT NOT NULL,
      center_lat REAL NOT NULL,
      center_lng REAL NOT NULL,
      polygon TEXT,
      postal_code TEXT,
      country_code TEXT NOT NULL,
      parent_city TEXT,
      parent_city_osm_id INTEGER,
      parent_municipality TEXT,
      bbox_min_lat REAL,
      bbox_min_lng REAL,
      bbox_max_lat REAL,
      bbox_max_lng REAL,
      UNIQUE(osm_type, osm_id, postal_code)
    )
  `);

  // Create R-tree spatial index for areas
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS areas_rtree USING rtree(
      id,
      min_lat, max_lat,
      min_lng, max_lng
    )
  `);

  // Create R-tree for postal boundaries (used during processing)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS postal_rtree USING rtree(
      id,
      min_lat, max_lat,
      min_lng, max_lng
    )
  `);

  // Create R-tree for admin boundaries (used during processing)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS admin_rtree USING rtree(
      id,
      min_lat, max_lat,
      min_lng, max_lng
    )
  `);

  // Create address points table for postal code sampling
  db.exec(`
    CREATE TABLE IF NOT EXISTS address_points (
      id INTEGER PRIMARY KEY,
      osm_id INTEGER NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      postal_code TEXT NOT NULL,
      UNIQUE(osm_id)
    )
  `);

  // R-tree for address points
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS address_rtree USING rtree(
      id,
      min_lat, max_lat,
      min_lng, max_lng
    )
  `);

  // Create indexes
  db.exec(`CREATE INDEX IF NOT EXISTS idx_areas_name ON areas(name)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_areas_postal ON areas(postal_code)`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_areas_country ON areas(country_code)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_admin_level ON admin_boundaries(admin_level)`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_admin_country ON admin_boundaries(country_code)`
  );

  return db;
}

export function clearProcessingTables(db: Database): void {
  db.exec("DELETE FROM raw_areas");
  db.exec("DELETE FROM postal_boundaries");
  db.exec("DELETE FROM admin_boundaries");
  db.exec("DELETE FROM address_points");
  db.exec("DELETE FROM postal_rtree");
  db.exec("DELETE FROM admin_rtree");
  db.exec("DELETE FROM address_rtree");
}

export function clearFinalTables(db: Database): void {
  db.exec("DELETE FROM areas");
  db.exec("DELETE FROM areas_rtree");
}

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
  parent_city: string | null;
  parent_city_osm_id: number | null;
  parent_municipality: string | null;
  bbox_min_lat: number | null;
  bbox_min_lng: number | null;
  bbox_max_lat: number | null;
  bbox_max_lng: number | null;
}
