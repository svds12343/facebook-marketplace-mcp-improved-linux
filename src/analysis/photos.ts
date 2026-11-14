import crypto from "node:crypto";
import sharp from "sharp";
import { downloadListingImage } from "../facebook/images.js";
import type { MarketplaceListingDetail } from "../facebook/types.js";
import type { PhotoFingerprint, State } from "../storage/state.js";
import { listingMoney, priceSignals, type Signal } from "./prices.js";

export async function fingerprintImage(data: Buffer, photo = 1): Promise<PhotoFingerprint> {
  const image = sharp(data, { limitInputPixels: 20000000, failOn: "error" }).rotate();
  const metadata = await image.metadata();
  const { data: rgb, info } = await image.clone().resize(9, 8, { fit: "fill" }).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  const grey: number[] = [];
  const mean = [0, 0, 0];
  for (let i = 0; i < 72; i++) {
    const values = [rgb[i * info.channels], rgb[i * info.channels + 1], rgb[i * info.channels + 2]];
    for (let c = 0; c < 3; c++) mean[c] += values[c] / 72;
    grey.push(values[0] * .299 + values[1] * .587 + values[2] * .114);
  }
  let bits = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits = (bits << 1n) | BigInt(grey[y * 9 + x] > grey[y * 9 + x + 1] ? 1 : 0);
  const average = grey.reduce((a, b) => a + b, 0) / 72;
  const deviation = Math.sqrt(grey.reduce((sum, v) => sum + (v - average) ** 2, 0) / 72);
  const oneBits = bits.toString(2).replace(/0/g, "").length;
  return { sha256: crypto.createHash("sha256").update(data).digest("hex"), dhash: bits.toString(16).padStart(16, "0"),
    width: metadata.width ?? 0, height: metadata.height ?? 0, mean: mean.map(Math.round), photo,
    informative: deviation > 12 && oneBits > 4 && oneBits < 60 };
}

export function comparePhotos(a: PhotoFingerprint, b: PhotoFingerprint): "identical_bytes" | "visually_similar" | null {
  if (!a.informative || !b.informative) return null;
  if (a.sha256 === b.sha256) return "identical_bytes";
  const distance = (BigInt(`0x${a.dhash}`) ^ BigInt(`0x${b.dhash}`)).toString(2).replace(/0/g, "").length;
  const ratioA = Math.max(a.width, a.height) / Math.min(a.width, a.height);
  const ratioB = Math.max(b.width, b.height) / Math.min(b.width, b.height);
  const colorDistance = a.mean.reduce((sum, value, i) => sum + Math.abs(value - b.mean[i]), 0) / 3;
  return distance <= 4 && Math.abs(ratioA - ratioB) / ratioA < .1 && colorDistance < 20 ? "visually_similar" : null;
}

export async function inspectPhotos(listing: MarketplaceListingDetail) {
  const photos: PhotoFingerprint[] = [];
  const failures: Array<{ photo: number; error: string }> = [];
  for (const [i, url] of listing.images.slice(0, 3).entries()) {
    try {
      const image = await downloadListingImage(url);
      photos.push(await fingerprintImage(Buffer.from(image.data, "base64"), i + 1));
    } catch { failures.push({ photo: i + 1, error: "Photo could not be downloaded or decoded within the supported limits." }); }
  }
  return { photos, failures, totalPhotos: listing.images.length };
}

export function assessEvidence(listing: MarketplaceListingDetail, photos: PhotoFingerprint[], state: State,
  reference?: { amount: number; currency: string }) {
  const signals: Signal[] = priceSignals(listing, listing.description);
  const matches: Array<{ listingId: string; url: string; photo: number; otherPhoto: number; match: string; differentKnownSellers: boolean }> = [];
  for (const record of Object.values(state.listings)) {
    if (record.listing.id === listing.id) continue;
    for (const photo of photos) for (const other of record.photos ?? []) {
      const match = comparePhotos(photo, other);
      if (!match || matches.length >= 30) continue;
      matches.push({ listingId: record.listing.id, url: record.listing.url, photo: photo.photo, otherPhoto: other.photo,
        match, differentKnownSellers: Boolean(listing.sellerId && record.listing.sellerId && listing.sellerId !== record.listing.sellerId) });
      const current = listingMoney(listing), previous = listingMoney(record.listing);
      if (current && previous && current.currency === previous.currency && current.amount > 1 && current.amount < previous.amount * .5) {
        signals.push({ code: "lower_price_than_photo_match", evidence: `This offer is ${listing.price}; photo-matching listing ${record.listing.id} was observed at ${record.listing.price}. These are asking prices, not a verified market valuation.` });
      }
    }
    if (matches.length >= 30) break;
  }
  if (matches.length) signals.push({ code: "photo_reuse", evidence: `Matching/similar photos found on ${new Set(matches.map(m => m.listingId)).size} other observed listing(s). Stock photos and legitimate reposts can also match.` });
  for (const photo of photos) if (Math.max(photo.width, photo.height) < 600 || Math.min(photo.width, photo.height) < 300) {
    signals.push({ code: "low_resolution", evidence: `Photo ${photo.photo}: ${photo.width}×${photo.height} pixels. Facebook may have resized it; resolution alone is not evidence of fraud.` });
  }
  const price = listingMoney(listing);
  if (price && reference && price.currency === reference.currency && price.amount > 1 && price.amount < reference.amount * .5) {
    signals.push({ code: "below_supplied_reference", evidence: `${listing.price} is less than half the supplied reference ${reference.currency} ${reference.amount}. The reference is not an independently verified valuation.` });
  }
  return { status: signals.length ? "review_recommended" : !photos.length || !price ? "insufficient_evidence" : "no_flags_found", signals, photoMatches: matches,
    limitations: "These are review signals, not proof of fraud or authenticity. Matches cover only photos this server has inspected, not all Facebook or the web. Crops, edits, thumbnails and stock photos can cause missed or false matches. Image sharpness and seller identity are not verified." };
}
