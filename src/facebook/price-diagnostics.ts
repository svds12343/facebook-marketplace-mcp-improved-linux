// Explicit, read-only diagnostics for a single listing. Never return page HTML,
// headers, cookies, arbitrary strings, descriptions or seller information.
type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => typeof value === "object" && value !== null && !Array.isArray(value);
const priceKey = /price|pricing|discount|markdown|strikethrough/i;
const privateKey = /token|cookie|secret|password|session|authorization|email|phone|address/i;
const safeKey = (key: string) => /^[a-z_][a-z0-9_:-]{0,79}$/i.test(key) && !privateKey.test(key);
const moneyKeys = new Set(["amount", "amount_with_offset_in_currency", "formatted_amount", "formatted_amount_zeros_stripped",
  "formattedAmountWithoutDecimals", "currency", "currency_code", "value", "text", "label", "type"]);
const numericText = /^-?\d+(?:\.\d+)?$/;
const priceText = /^\s*(?:(?:[A-Z]{3}|S?Fr\.|[$€£¥₹])\s*)?-?\d[\d\s.,'’]*(?:[–—-])?\s*(?:[A-Z]{3}|S?Fr\.|[$€£¥₹])?\s*$/u;

function safeValue(value: unknown, key: string, depth = 0): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) && Math.abs(value) <= 1e12 ? value : "[invalid number]";
  if (typeof value === "string") {
    if (value.length > 100 || privateKey.test(value)) return "[omitted string]";
    if ((key === "type" || key.endsWith("_type")) && /^[A-Z][A-Z_]{0,59}$/.test(value)) return value;
    if (/^currency(?:_code)?$/.test(key) && /^[A-Z]{3}$/i.test(value)) return value;
    return numericText.test(value) || priceText.test(value) ? value : "[omitted string]";
  }
  if (depth >= 3) return "[nested value omitted]";
  if (Array.isArray(value)) return value.slice(0, 5).map(item => safeValue(item, key, depth + 1));
  if (record(value)) return Object.fromEntries(Object.entries(value)
    .filter(([name]) => safeKey(name) && (moneyKeys.has(name) || priceKey.test(name)))
    .slice(0, 20).map(([name, item]) => [name, safeValue(item, name, depth + 1)]));
  return "[unavailable]";
}

export function inspectListingPriceData(html: string, listingId: string) {
  const records: RecordValue[] = [];
  const fieldCounts: Record<string, number> = Object.create(null);
  let jsonBlocks = 0, invalidJsonBlocks = 0, stringWrappedPriceData = 0, truncated = false;
  const listingIds = new Set([listingId]);
  for (const match of html.matchAll(/<script[^>]+type=["']application\/json["'][^>]*>(.*?)<\/script>/gis)) {
    jsonBlocks++;
    let payload: unknown;
    try { payload = JSON.parse(match[1]); } catch { invalidJsonBlocks++; continue; }
    const queue = [payload];
    for (let i = 0; i < queue.length; i++) {
      if (records.length >= 100000 || i >= 200000) { truncated = true; break; }
      const node = queue[i];
      if (Array.isArray(node)) { queue.push(...node); continue; }
      if (!record(node)) {
        if (typeof node === "string" && /^\s*[{[]/.test(node) && /strikethrough|listing_price|comparable_price/.test(node)) stringWrappedPriceData++;
        continue;
      }
      records.push(node);
      if (record(node.product_item) && String(node.product_item.id) === listingId &&
        (typeof node.id === "string" || typeof node.id === "number")) listingIds.add(String(node.id));
      for (const [key, value] of Object.entries(node)) {
        if (safeKey(key) && priceKey.test(key) && (Object.hasOwn(fieldCounts, key) || Object.keys(fieldCounts).length < 50)) {
          fieldCounts[key] = (fieldCounts[key] ?? 0) + 1;
        }
        queue.push(value);
      }
    }
    if (truncated) break;
  }
  const matches = records.filter(node => (typeof node.id === "string" || typeof node.id === "number") && listingIds.has(String(node.id)));
  const matchingFragments = matches.slice(0, 20).map((node, index) => {
    const fields: Array<{ field: string; kind: string; keys?: string[]; value: unknown }> = [];
    const queue: Array<{ node: unknown; path: string; depth: number }> = [{ node, path: "", depth: 0 }];
    for (let i = 0; i < queue.length && i < 500 && fields.length < 30; i++) {
      const current = queue[i];
      if (current.depth > 5) { truncated = true; continue; }
      if (Array.isArray(current.node)) {
        current.node.slice(0, 10).forEach((item, position) => queue.push({ node: item, path: `${current.path}[${position}]`, depth: current.depth + 1 }));
        continue;
      }
      if (!record(current.node)) continue;
      // A nested recommendation/seller record with a different ID is not this offer.
      if (current.node.id != null && !listingIds.has(String(current.node.id))) continue;
      for (const [key, value] of Object.entries(current.node)) {
        if (!safeKey(key)) continue;
        const field = current.path ? `${current.path}.${key}` : key;
        if (priceKey.test(key)) {
          // Show safe key names even when their values are not allowlisted. An
          // empty sanitized value must not imply that Facebook sent an empty object.
          const keys = record(value) ? Object.keys(value).filter(safeKey) : undefined;
          if (keys && keys.length > 20) truncated = true;
          fields.push({ field, kind: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
            ...(keys ? { keys: keys.slice(0, 20) } : {}), value: safeValue(value, key) });
        } else if (record(value) || Array.isArray(value)) queue.push({ node: value, path: field, depth: current.depth + 1 });
        if (fields.length >= 30) break;
      }
    }
    if (queue.length > 500 || fields.length >= 30) truncated = true;
    return { fragment: index + 1, fields };
  });
  return { requestedListingId: listingId, jsonBlocks, invalidJsonBlocks, matchedFragmentCount: matches.length,
    matchingFragments, priceFieldNamesAnywhereInJson: fieldCounts, stringWrappedPriceData,
    rawHtmlMentions: Object.fromEntries(["strikethrough_price", "strikethroughPrice", "comparable_price", "previous_price", "original_price"]
      .map(key => [key, html.includes(key)])),
    truncated: truncated || matches.length > 20,
    note: "Only allowlisted price values from matching listing fragments are shown. Object keys list safe field names, including fields whose values are omitted. An empty sanitized value does not necessarily mean an empty source object. Page-wide field names/mentions may refer to other offers or code, not this listing. Other strings and unrelated values are omitted. No reduction is inferred from comparison prices." };
}
