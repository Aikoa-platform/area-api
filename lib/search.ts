/**
 * Search Service for area name and postal code fuzzy search.
 *
 * Provides a clean interface for searching areas with:
 * - FTS5 trigram-based candidate retrieval
 * - TypeScript-based fuzzy scoring for typo tolerance
 * - Combined name + postal code query support
 * - Proximity-weighted ranking
 */

import { Database } from "bun:sqlite";
import { haversineDistance } from "./geo";
import type { SearchOptions, SearchResult } from "../types";

// ============================================
// Types
// ============================================

interface AreaRow {
  id: number;
  osm_id: number;
  osm_type: string;
  place_type: string;
  name: string;
  names: string;
  center_lat: number;
  center_lng: number;
  postal_code: string | null;
  country_code: string;
  country_name: string;
  parent_city: string | null;
  parent_municipality: string | null;
}

interface ParsedQuery {
  fullQuery: string;
  namePart: string | null;
  postalPart: string | null;
  isPostalOnly: boolean;
}

// ============================================
// Text Utilities
// ============================================

/**
 * Normalize text for fuzzy matching:
 * - Lowercase
 * - Remove diacritics (ä→a, ö→o, å→a, etc.)
 * - Trim whitespace
 */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

/**
 * Calculate Jaro similarity between two strings (0-1, higher is better).
 * Better for short strings than Levenshtein.
 */
export function jaroSimilarity(s1: string, s2: string): number {
  if (s1 === s2) return 1.0;
  if (s1.length === 0 || s2.length === 0) return 0.0;

  const matchWindow = Math.max(
    0,
    Math.floor(Math.max(s1.length, s2.length) / 2) - 1
  );

  const s1Matches = new Array(s1.length).fill(false);
  const s2Matches = new Array(s2.length).fill(false);

  let matches = 0;
  let transpositions = 0;

  // Find matches
  for (let i = 0; i < s1.length; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, s2.length);

    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0.0;

  // Count transpositions
  let k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }

  const jaro =
    (matches / s1.length +
      matches / s2.length +
      (matches - transpositions / 2) / matches) /
    3;

  return jaro;
}

/**
 * Calculate Jaro-Winkler similarity (0-1, higher is better).
 * Gives bonus for matching prefixes.
 */
export function jaroWinklerSimilarity(
  s1: string,
  s2: string,
  prefixScale = 0.1
): number {
  const jaro = jaroSimilarity(s1, s2);

  // Find common prefix (up to 4 chars)
  let prefixLength = 0;
  const maxPrefix = Math.min(4, s1.length, s2.length);
  for (let i = 0; i < maxPrefix; i++) {
    if (s1[i] === s2[i]) {
      prefixLength++;
    } else {
      break;
    }
  }

  return jaro + prefixLength * prefixScale * (1 - jaro);
}

/**
 * Generate character n-grams from a string.
 */
export function generateNgrams(text: string, n: number = 3): Set<string> {
  const ngrams = new Set<string>();
  const padded = " ".repeat(n - 1) + text + " ".repeat(n - 1);
  for (let i = 0; i <= padded.length - n; i++) {
    ngrams.add(padded.slice(i, i + n));
  }
  return ngrams;
}

/**
 * Calculate n-gram similarity (Jaccard index) between two strings.
 */
export function ngramSimilarity(s1: string, s2: string, n: number = 3): number {
  const ngrams1 = generateNgrams(s1, n);
  const ngrams2 = generateNgrams(s2, n);

  let intersection = 0;
  for (const ng of ngrams1) {
    if (ngrams2.has(ng)) intersection++;
  }

  const union = ngrams1.size + ngrams2.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ============================================
// Query Parser
// ============================================

/**
 * Parse a search query to extract potential name and postal code parts.
 */
export function parseQuery(query: string): ParsedQuery {
  const trimmed = query.trim();
  const tokens = trimmed.split(/\s+/);

  let postalPart: string | null = null;
  let namePart: string | null = null;

  if (tokens.length > 1) {
    const lastToken = tokens[tokens.length - 1]!;
    // Postal codes typically start with digits
    if (/^\d/.test(lastToken)) {
      postalPart = lastToken;
      namePart = tokens.slice(0, -1).join(" ");
    } else {
      // Check if first token is a postal code (e.g., "01700 Kivistö")
      const firstToken = tokens[0]!;
      if (/^\d/.test(firstToken)) {
        postalPart = firstToken;
        namePart = tokens.slice(1).join(" ");
      }
    }
  }

  // If the entire query looks like just a postal code
  const isPostalOnly = !namePart && /^[\d]{2,10}$/.test(trimmed);
  if (isPostalOnly) {
    postalPart = trimmed;
  }

  return {
    fullQuery: trimmed,
    namePart,
    postalPart,
    isPostalOnly,
  };
}

// ============================================
// Fuzzy Scoring
// ============================================

/**
 * Calculate comprehensive fuzzy match score (0-1, higher is better).
 * Uses multiple signals: exact match, prefix, Jaro-Winkler, n-gram similarity.
 */
export function fuzzyScore(query: string, target: string): number {
  const normalizedQuery = normalizeText(query);
  const normalizedTarget = normalizeText(target);

  // Exact match (normalized)
  if (normalizedTarget === normalizedQuery) {
    return 1.0;
  }

  // Exact match ignoring case (but with diacritics preserved in comparison)
  if (target.toLowerCase() === query.toLowerCase()) {
    return 0.99;
  }

  // Prefix match (very important for autocomplete)
  if (normalizedTarget.startsWith(normalizedQuery)) {
    // Score decreases slightly for longer targets
    const lengthPenalty = Math.min(
      0.15,
      (normalizedTarget.length - normalizedQuery.length) * 0.02
    );
    return 0.95 - lengthPenalty;
  }

  // Check if query is a prefix of any word in target
  const targetWords = normalizedTarget.split(/\s+/);
  for (const word of targetWords) {
    if (word.startsWith(normalizedQuery)) {
      return 0.85;
    }
  }

  // Contains query (substring match)
  if (normalizedTarget.includes(normalizedQuery)) {
    const position = normalizedTarget.indexOf(normalizedQuery);
    return Math.max(0.6, 0.75 - position * 0.02);
  }

  // Use Jaro-Winkler for typo tolerance (better for short strings)
  const jwScore = jaroWinklerSimilarity(normalizedQuery, normalizedTarget);

  // Use n-gram similarity for partial matches
  const ngScore = ngramSimilarity(normalizedQuery, normalizedTarget);

  // Combine Jaro-Winkler and n-gram scores
  const combinedFuzzy = jwScore * 0.6 + ngScore * 0.4;

  // Only accept if reasonably close
  if (combinedFuzzy >= 0.65) {
    // Scale to 0.3-0.55 range for fuzzy matches
    return 0.3 + combinedFuzzy * 0.35;
  }

  // Check individual words with Jaro-Winkler
  for (const word of targetWords) {
    const wordJW = jaroWinklerSimilarity(normalizedQuery, word);
    if (wordJW >= 0.85) {
      return 0.5 + (wordJW - 0.85) * 2;
    }
  }

  return 0;
}

/**
 * Calculate postal code match score.
 */
export function postalScore(query: string, postalCode: string | null): number {
  if (!postalCode) return 0;

  const queryLower = query.toLowerCase();
  const postalLower = postalCode.toLowerCase();

  if (postalLower === queryLower) {
    return 1.0; // Exact match
  }

  if (postalLower.startsWith(queryLower)) {
    // Prefix match - score based on match completeness
    return 0.8 + (queryLower.length / postalLower.length) * 0.15;
  }

  return 0;
}

/**
 * Calculate proximity score using exponential decay.
 * Returns 1.0 at distance 0, decays to ~0.5 at decayRadius.
 */
export function proximityScore(
  distanceMeters: number,
  decayRadius: number = 50000 // 50km default
): number {
  return Math.exp(-distanceMeters / decayRadius);
}

// ============================================
// Search Service
// ============================================

export class SearchService {
  private static instances = new WeakMap<Database, SearchService>();
  private db: Database;
  private hasFTS: boolean = false;

  private constructor(db: Database) {
    this.db = db;
    this.initializeFTSIndex();
  }

  /**
   * Get or create a SearchService instance for a database connection.
   */
  static getInstance(db: Database): SearchService {
    let instance = SearchService.instances.get(db);
    if (!instance) {
      instance = new SearchService(db);
      SearchService.instances.set(db, instance);
    }
    return instance;
  }

  /**
   * Check if FTS5 index exists and has data, create/populate if needed.
   */
  private initializeFTSIndex(): void {
    try {
      // Check if table exists
      const tableExists = this.db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='areas_fts'"
        )
        .get();

      if (!tableExists) {
        // Create the FTS5 table
        this.db.run(`
          CREATE VIRTUAL TABLE IF NOT EXISTS areas_fts USING fts5(
            area_id UNINDEXED,
            name,
            name_normalized,
            postal_code,
            all_names,
            tokenize="trigram"
          )
        `);
      }

      // Check if it has data
      const count = this.db
        .query<{ count: number }, []>("SELECT COUNT(*) as count FROM areas_fts")
        .get();

      if (!count || count.count === 0) {
        // Populate from areas table
        this.populateFTSIndex();
      }

      this.hasFTS = true;
    } catch (e) {
      // FTS5 not available or error - use fallback
      console.warn("FTS5 index not available, using LIKE fallback:", e);
      this.hasFTS = false;
    }
  }

  /**
   * Populate FTS5 index from existing areas table.
   */
  private populateFTSIndex(): void {
    try {
      const areas = this.db
        .query<
          {
            id: number;
            name: string;
            names: string;
            postal_code: string | null;
          },
          []
        >("SELECT id, name, names, postal_code FROM areas")
        .all();

      const insert = this.db.prepare(`
        INSERT INTO areas_fts (area_id, name, name_normalized, postal_code, all_names)
        VALUES (?, ?, ?, ?, ?)
      `);

      const insertMany = this.db.transaction(() => {
        for (const area of areas) {
          let allNames = "";
          try {
            const names = JSON.parse(area.names) as Record<string, string>;
            allNames = Object.values(names).join(" ");
          } catch {
            allNames = area.name;
          }

          insert.run(
            area.id,
            area.name,
            normalizeText(area.name),
            area.postal_code,
            allNames
          );
        }
      });

      insertMany();
      console.log(`Populated FTS5 index with ${areas.length} entries`);
    } catch (e) {
      console.warn("Failed to populate FTS5 index:", e);
    }
  }

  /**
   * Search areas by name or postal code.
   */
  search(query: string, options: SearchOptions = {}): SearchResult[] {
    const {
      limit = 20,
      countryCode,
      biasLat,
      biasLng,
      proximityWeight = 0.2,
    } = options;

    const parsed = parseQuery(query);
    const candidateLimit = Math.max(limit * 5, 100);
    const normalizedQuery = normalizeText(parsed.namePart ?? parsed.fullQuery);

    // For very short queries (< 3 chars), use simple LIKE instead of FTS
    // FTS5 trigram tokenizer needs at least 3 characters
    let candidates: AreaRow[];
    if (normalizedQuery.length < 3 && !parsed.postalPart) {
      candidates = this.getCandidatesLike(parsed, candidateLimit, countryCode);
    } else {
      candidates = this.getCandidatesFTS(parsed, candidateLimit, countryCode);
    }

    // If still few results, try even broader prefix search for typo tolerance
    if (candidates.length < limit) {
      const prefixResults = this.getCandidatesByPrefix(
        parsed,
        candidateLimit,
        countryCode
      );
      const seen = new Set(candidates.map((c) => c.id));
      for (const row of prefixResults) {
        if (!seen.has(row.id)) {
          candidates.push(row);
          seen.add(row.id);
        }
      }
    }

    // Score and rank candidates
    const hasBias = biasLat !== undefined && biasLng !== undefined;
    const scored: Array<{ row: AreaRow; score: number; distance?: number }> =
      [];

    for (const row of candidates) {
      // Calculate text score
      const textScore = this.calculateTextScore(parsed, row);

      if (textScore <= 0) continue;

      // Calculate distance if bias provided
      let distance: number | undefined;
      let proxScore = 0;

      if (hasBias) {
        distance = haversineDistance(
          { lat: biasLat, lng: biasLng },
          { lat: row.center_lat, lng: row.center_lng }
        );
        proxScore = proximityScore(distance);
      }

      // Combine text and proximity scores
      let finalScore: number;
      if (hasBias && proximityWeight > 0) {
        finalScore =
          textScore * (1 - proximityWeight) + proxScore * proximityWeight;
      } else {
        finalScore = textScore;
      }

      scored.push({ row, score: finalScore, distance });
    }

    // Sort by score (descending)
    scored.sort((a, b) => b.score - a.score);

    // Convert to results
    return scored.slice(0, limit).map(({ row, score, distance }) => ({
      id: row.id,
      osm_id: row.osm_id,
      osm_type: row.osm_type,
      place_type: row.place_type,
      name: row.name,
      names: JSON.parse(row.names) as Record<string, string>,
      center: { lat: row.center_lat, lng: row.center_lng },
      postal_code: row.postal_code,
      country_code: row.country_code,
      country_name: row.country_name,
      parent_city: row.parent_city,
      parent_municipality: row.parent_municipality,
      distance_meters:
        distance !== undefined ? Math.round(distance) : undefined,
      score,
    }));
  }

  /**
   * Calculate combined text score for a candidate.
   */
  private calculateTextScore(parsed: ParsedQuery, row: AreaRow): number {
    let nameScoreVal = 0;
    let postalScoreVal = 0;

    // Score name matching
    const queryForName = parsed.namePart ?? parsed.fullQuery;
    nameScoreVal = fuzzyScore(queryForName, row.name);

    // Also check translated names
    try {
      const names = JSON.parse(row.names) as Record<string, string>;
      for (const translatedName of Object.values(names)) {
        const translatedScore = fuzzyScore(queryForName, translatedName);
        if (translatedScore > nameScoreVal) {
          nameScoreVal = translatedScore;
        }
      }
    } catch {
      // Ignore JSON parse errors
    }

    // Score postal code matching
    if (parsed.postalPart && row.postal_code) {
      postalScoreVal = postalScore(parsed.postalPart, row.postal_code);
    } else if (parsed.isPostalOnly && row.postal_code) {
      postalScoreVal = postalScore(parsed.fullQuery, row.postal_code);
    }

    // Combine scores based on query type
    if (parsed.namePart && parsed.postalPart) {
      // Combined query: boost results that match BOTH
      if (nameScoreVal > 0.5 && postalScoreVal > 0.5) {
        return Math.min(1.0, (nameScoreVal + postalScoreVal) / 2 + 0.2);
      } else if (nameScoreVal > 0.5 && postalScoreVal > 0) {
        return nameScoreVal * 0.7 + postalScoreVal * 0.3 + 0.1;
      }
      return Math.max(nameScoreVal, postalScoreVal);
    }

    if (parsed.isPostalOnly) {
      return postalScoreVal > 0 ? postalScoreVal : nameScoreVal;
    }

    return Math.max(nameScoreVal, postalScoreVal);
  }

  /**
   * Get candidates using FTS5 trigram index.
   */
  private getCandidatesFTS(
    parsed: ParsedQuery,
    limit: number,
    countryCode?: string
  ): AreaRow[] {
    const searchTerms: string[] = [];
    const normalizedQuery = normalizeText(parsed.fullQuery);

    // For typo tolerance, also search with a shorter prefix
    const shortPrefix = normalizedQuery.slice(
      0,
      Math.min(4, normalizedQuery.length)
    );

    // Build FTS5 query - search both original and normalized columns
    if (parsed.namePart) {
      const normalizedName = normalizeText(parsed.namePart);
      if (normalizedName.length >= 3) {
        // Search both name and name_normalized columns
        searchTerms.push(`name : "${parsed.namePart}"`);
        searchTerms.push(`name_normalized : "${normalizedName}"`);
        // Add short prefix for typo tolerance
        const shortNamePrefix = normalizedName.slice(
          0,
          Math.min(4, normalizedName.length)
        );
        if (shortNamePrefix.length >= 3) {
          searchTerms.push(`name_normalized : "${shortNamePrefix}"`);
        }
      }
    }

    if (parsed.postalPart) {
      searchTerms.push(`postal_code : "${parsed.postalPart}"`);
    }

    if (searchTerms.length === 0 && normalizedQuery.length >= 3) {
      // Search both name and name_normalized columns
      searchTerms.push(`name : "${parsed.fullQuery}"`);
      searchTerms.push(`name_normalized : "${normalizedQuery}"`);
      // Add short prefix for typo tolerance
      if (shortPrefix.length >= 3) {
        searchTerms.push(`name_normalized : "${shortPrefix}"`);
      }
    }

    if (searchTerms.length === 0) {
      return [];
    }

    const ftsQuery = searchTerms.join(" OR ");

    try {
      let sql: string;
      let params: (string | number)[];

      if (countryCode) {
        sql = `
          SELECT a.id, a.osm_id, a.osm_type, a.place_type, a.name, a.names,
                 a.center_lat, a.center_lng, a.postal_code, a.country_code,
                 a.country_name, a.parent_city, a.parent_municipality
          FROM areas_fts fts
          JOIN areas a ON a.id = fts.area_id
          WHERE areas_fts MATCH ? AND a.country_code = ?
          LIMIT ?
        `;
        params = [ftsQuery, countryCode, limit];
      } else {
        sql = `
          SELECT a.id, a.osm_id, a.osm_type, a.place_type, a.name, a.names,
                 a.center_lat, a.center_lng, a.postal_code, a.country_code,
                 a.country_name, a.parent_city, a.parent_municipality
          FROM areas_fts fts
          JOIN areas a ON a.id = fts.area_id
          WHERE areas_fts MATCH ?
          LIMIT ?
        `;
        params = [ftsQuery, limit];
      }

      return this.db.query<AreaRow, (string | number)[]>(sql).all(...params);
    } catch (e) {
      // FTS query failed, fall back to LIKE
      console.warn("FTS query failed, check that FTS is available:", e);
    }

    return [];
  }

  /**
   * Get candidates using simple LIKE for very short queries (< 3 chars).
   * Simple prefix matching on normalized name using FTS table.
   */
  private getCandidatesLike(
    parsed: ParsedQuery,
    limit: number,
    countryCode?: string
  ): AreaRow[] {
    const normalizedQuery = normalizeText(parsed.namePart ?? parsed.fullQuery);
    const pattern = `${normalizedQuery}%`;

    if (countryCode) {
      return this.db
        .query<AreaRow, [string, string, number]>(
          `
          SELECT DISTINCT a.id, a.osm_id, a.osm_type, a.place_type, a.name, a.names,
                 a.center_lat, a.center_lng, a.postal_code, a.country_code,
                 a.country_name, a.parent_city, a.parent_municipality
          FROM areas_fts fts
          JOIN areas a ON a.id = fts.area_id
          WHERE a.country_code = ? AND fts.name_normalized LIKE ?
          LIMIT ?
        `
        )
        .all(countryCode, pattern, limit);
    }

    return this.db
      .query<AreaRow, [string, number]>(
        `
        SELECT DISTINCT a.id, a.osm_id, a.osm_type, a.place_type, a.name, a.names,
               a.center_lat, a.center_lng, a.postal_code, a.country_code,
               a.country_name, a.parent_city, a.parent_municipality
        FROM areas_fts fts
        JOIN areas a ON a.id = fts.area_id
        WHERE fts.name_normalized LIKE ?
        LIMIT ?
      `
      )
      .all(pattern, limit);
  }

  /**
   * Get candidates using very short prefix matching for typo tolerance.
   * Uses first 2-3 characters to cast a wide net, relies on fuzzy scoring to filter.
   */
  private getCandidatesByPrefix(
    parsed: ParsedQuery,
    limit: number,
    countryCode?: string
  ): AreaRow[] {
    const normalizedQuery = normalizeText(parsed.namePart ?? parsed.fullQuery);

    // Use first 2-3 characters for broad matching
    const prefix = normalizedQuery.slice(
      0,
      Math.min(3, normalizedQuery.length)
    );
    if (prefix.length < 2) {
      return [];
    }

    // Search FTS5 name_normalized column with short prefix
    if (this.hasFTS) {
      try {
        const ftsQuery = `name_normalized : "${prefix}"`;
        let sql: string;
        let params: (string | number)[];

        if (countryCode) {
          sql = `
            SELECT a.id, a.osm_id, a.osm_type, a.place_type, a.name, a.names,
                   a.center_lat, a.center_lng, a.postal_code, a.country_code,
                   a.country_name, a.parent_city, a.parent_municipality
            FROM areas_fts fts
            JOIN areas a ON a.id = fts.area_id
            WHERE areas_fts MATCH ? AND a.country_code = ?
            LIMIT ?
          `;
          params = [ftsQuery, countryCode, limit];
        } else {
          sql = `
            SELECT a.id, a.osm_id, a.osm_type, a.place_type, a.name, a.names,
                   a.center_lat, a.center_lng, a.postal_code, a.country_code,
                   a.country_name, a.parent_city, a.parent_municipality
            FROM areas_fts fts
            JOIN areas a ON a.id = fts.area_id
            WHERE areas_fts MATCH ?
            LIMIT ?
          `;
          params = [ftsQuery, limit];
        }

        return this.db.query<AreaRow, (string | number)[]>(sql).all(...params);
      } catch {
        // Fall through to LIKE-based search
      }
    }

    // Fallback to LIKE with short prefix
    const pattern = `${prefix}%`;

    if (countryCode) {
      return this.db
        .query<AreaRow, [string, string, number]>(
          `
          SELECT DISTINCT id, osm_id, osm_type, place_type, name, names,
                 center_lat, center_lng, postal_code, country_code,
                 country_name, parent_city, parent_municipality
          FROM areas
          WHERE country_code = ? AND LOWER(name) LIKE ?
          LIMIT ?
        `
        )
        .all(countryCode, pattern, limit);
    }

    return this.db
      .query<AreaRow, [string, number]>(
        `
        SELECT DISTINCT id, osm_id, osm_type, place_type, name, names,
               center_lat, center_lng, postal_code, country_code,
               country_name, parent_city, parent_municipality
        FROM areas
        WHERE LOWER(name) LIKE ?
        LIMIT ?
      `
      )
      .all(pattern, limit);
  }
}
