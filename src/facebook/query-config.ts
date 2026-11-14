import fs from "node:fs";
import { queriesFile } from "../config.js";
import { writePrivateJson } from "../utils/private-file.js";

export type QueryKind = "marketplace_search" | "city_street_search";
export type QueryIds = Partial<Record<QueryKind, string>>;

export function readQueryIds(): QueryIds {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(queriesFile(), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("Cannot read queries.json. Run npm run capture-queries to refresh it.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid queries.json: expected an object.");
  }
  const result: QueryIds = {};
  for (const kind of ["marketplace_search", "city_street_search"] as const) {
    const value = (parsed as Record<string, unknown>)[kind];
    if (value === undefined) continue;
    if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error(`Invalid doc_id for ${kind}.`);
    result[kind] = value;
  }
  return result;
}

export function queryDocId(kind: QueryKind, fallback: string): string {
  const envName = kind === "marketplace_search" ? "FB_SEARCH_DOC_ID" : "FB_LOCATION_DOC_ID";
  const override = process.env[envName];
  if (override !== undefined) {
    if (!/^\d+$/.test(override)) throw new Error(`${envName} must contain only digits.`);
    return override;
  }
  return readQueryIds()[kind] ?? fallback;
}

/** Only recognize requests with the variable shape used by this client. */
export function identifyQuery(postData: string): { kind: QueryKind; docId: string } | undefined {
  const params = new URLSearchParams(postData);
  const docId = params.get("doc_id") ?? "";
  if (!/^\d+$/.test(docId)) return;
  try {
    const vars = JSON.parse(params.get("variables") ?? "{}");
    if (vars?.params?.bqf?.callsite === "COMMERCE_MKTPLACE_WWW") {
      return { kind: "marketplace_search", docId };
    }
    if (vars?.params?.caller === "MARKETPLACE") return { kind: "city_street_search", docId };
  } catch { /* Not a supported query. */ }
}

export function saveQueryIds(ids: QueryIds): void {
  // Validate without retaining variables, search terms, tokens, or unrelated requests.
  for (const value of Object.values(ids)) {
    if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error("Invalid query ID.");
  }
  writePrivateJson(queriesFile(), ids);
}
