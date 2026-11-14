import type { MarketplaceListing } from "../facebook/types.js";
import type { State, ListingRecord } from "../storage/state.js";

export interface Money { amount: number; currency: string }
export interface Signal { code: string; evidence: string }

export function parseMoney(formatted: string, currencyHint?: string): Money | null {
  const currency = /\bCHF\b|\bS?Fr\./i.test(formatted) ? "CHF"
    : /\bEUR\b|€/.test(formatted) ? "EUR" : /\bUSD\b/.test(formatted) ? "USD"
    : /\bGBP\b|£/.test(formatted) ? "GBP" : currencyHint?.toUpperCase();
  if (!currency || !/^[A-Z]{3}$/.test(currency)) return null;
  let raw = formatted.replace(/CHF|S?Fr\.|EUR|USD|GBP|[$€£]/gi, "").trim()
    .replace(/[’'\s\u00a0\u202f]/g, "").replace(/[.,][–—-]$/, "");
  if (!/^\d+(?:[.,]\d+)*$/.test(raw)) return null;
  const lastDot = raw.lastIndexOf(".");
  const lastComma = raw.lastIndexOf(",");
  const last = Math.max(lastDot, lastComma);
  if (last >= 0) {
    const decimals = raw.length - last - 1;
    if (decimals === 1 || decimals === 2) raw = raw.slice(0, last).replace(/[.,]/g, "") + "." + raw.slice(last + 1);
    else if (decimals === 3 && /^\d{1,3}(?:[.,]\d{3})+$/.test(raw)) raw = raw.replace(/[.,]/g, "");
    else return null;
  }
  const amount = Number(raw);
  return Number.isFinite(amount) && amount >= 0 && amount <= 1e12 ? { amount, currency } : null;
}

export function listingMoney(listing: MarketplaceListing): Money | null {
  if (typeof listing.priceAmount === "number" && Number.isFinite(listing.priceAmount) && listing.priceAmount >= 0
    && listing.currency && /^[A-Z]{3}$/.test(listing.currency)) return { amount: listing.priceAmount, currency: listing.currency };
  return parseMoney(listing.price, listing.currency);
}

export function priceSignals(listing: MarketplaceListing, description = ""): Signal[] {
  const advertised = listingMoney(listing);
  if (!advertised) return [];
  const signals: Signal[] = [];
  if (advertised.amount <= 1) signals.push({ code: "possible_placeholder", evidence: `Advertised ${listing.price}. This may be a placeholder or a genuinely free/cheap offer; confirm the asking price.` });
  const amounts = description.matchAll(/(?:\b(?:CHF|EUR|USD|GBP)|S?Fr\.|[€£])\s*\d[\d '\u2019.,]*\d|(?:\b(?:CHF|EUR|USD|GBP)|S?Fr\.|[€£])\s*\d|\d[\d '\u2019.,]*\s*(?:CHF|EUR|USD|GBP|S?Fr\.|[€£])/gi);
  for (const match of amounts) {
    const candidate = parseMoney(match[0]);
    if (!candidate || candidate.currency !== advertised.currency || candidate.amount === advertised.amount) continue;
    const before = description.slice(Math.max(0, match.index! - 65), match.index).split(/[\n;!?]/).at(-1) ?? "";
    const roles = [...before.matchAll(/prix de vente|prix demandé|asking|selling|vends|vente|price|prix|acheté|achat|neuf|retail|original|valeur|livraison|shipping|acompte|deposit|mensuel/gi)];
    const role = roles.at(-1)?.[0].toLowerCase();
    const after = description.slice(match.index! + match[0].length, match.index! + match[0].length + 30);
    const asking = role && /^(prix de vente|prix demandé|asking|selling|vends|vente|price|prix)$/.test(role);
    if (!asking && !/à discuter|négociable|negotiable/i.test(after)) continue;
    signals.push({ code: "description_price_difference", evidence: `Advertised ${listing.price}; description appears to quote ${candidate.currency} ${candidate.amount}: ${description.slice(Math.max(0, match.index! - 30), match.index! + match[0].length + 30).trim()}. Verify what this amount covers.` });
  }
  return signals.slice(0, 5);
}

export function observeListing(state: State, listing: MarketplaceListing, now: string, description?: string, markSeen = false): ListingRecord {
  const old = state.listings[listing.id];
  const record: ListingRecord = old ?? { listing, firstSeen: now, lastSeen: now, history: [] };
  record.listing = { ...record.listing, ...listing, priceAmount: listing.priceAmount, currency: listing.currency };
  record.lastSeen = now;
  if (description !== undefined) record.description = description;
  if (markSeen) record.seenAt = now;
  const money = listingMoney(listing);
  const last = record.history.at(-1);
  if (money && (!last || last.amount !== money.amount || last.currency !== money.currency)) {
    record.history.push({ ...money, at: now, formatted: listing.price });
    record.history = record.history.slice(-365);
  }
  state.listings[listing.id] = record;
  return record;
}
