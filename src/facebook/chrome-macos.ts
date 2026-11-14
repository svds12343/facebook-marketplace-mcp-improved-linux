import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import type { FacebookCookie } from "./types.js";

const CHROME_SALT = "saltysalt";
const CHROME_ITERATIONS = 1003;
const CHROME_KEY_LENGTH = 16;
const CHROME_IV = Buffer.alloc(16, " ");

function getChromePassword(): string {
  try {
    return execFileSync(
      "security", ["find-generic-password", "-w", "-s", "Chrome Safe Storage", "-a", "Chrome"],
      { stdio: ["pipe", "pipe", "pipe"] }
    )
      .toString()
      .trim();
  } catch {
    throw new Error(
      "Failed to get Chrome password from Keychain. " +
        "Make sure Chrome is installed and you approve the Keychain prompt."
    );
  }
}

function deriveChromeKey(password: string): Buffer {
  return crypto.pbkdf2Sync(
    password,
    CHROME_SALT,
    CHROME_ITERATIONS,
    CHROME_KEY_LENGTH,
    "sha1"
  );
}

function decryptCookieValue(encrypted: Buffer, key: Buffer): string {
  if (encrypted.length === 0) return "";

  // Check for v10 prefix (macOS Chrome encryption)
  const prefix = encrypted.slice(0, 3).toString("ascii");
  if (prefix !== "v10") {
    // Not encrypted or unknown format
    return encrypted.toString("utf8");
  }

  const data = encrypted.slice(3);
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, CHROME_IV);
  decipher.setAutoPadding(false);

  let decoded = Buffer.concat([decipher.update(data), decipher.final()]);

  // Remove PKCS7 padding
  const padding = decoded[decoded.length - 1];
  if (padding && padding > 0 && padding <= 16) {
    decoded = decoded.slice(0, decoded.length - padding);
  }

  // Chrome prepends a 32-byte header to cookie values before encrypting.
  // Skip it to get the actual value.
  if (decoded.length > 32) {
    decoded = decoded.slice(32);
  }

  return decoded.toString("utf8");
}

function getCookieDbPath(profile = "Default"): string {
  return path.join(
    os.homedir(),
    "Library/Application Support/Google/Chrome",
    profile,
    "Cookies"
  );
}

export function extractChromeCookies(
  domain: string,
  profile = "Default"
): FacebookCookie[] {
  const cookiePath = getCookieDbPath(profile);

  // Chrome locks the DB while running — copy it first
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-chrome-"));
  const tmpPath = path.join(tmpDir, "Cookies");
  let db: Database.Database | undefined;
  try {
    fs.copyFileSync(cookiePath, tmpPath);
    const key = deriveChromeKey(getChromePassword());
    db = new Database(tmpPath, { readonly: true });
    const rows = db
      .prepare(
        `SELECT host_key, name, value, encrypted_value, path, expires_utc,
                is_secure, is_httponly
         FROM cookies
         WHERE host_key = ? OR host_key LIKE ?`
      )
      .all(domain, `%.${domain}`) as Array<{
      host_key: string;
      name: string;
      value: string;
      encrypted_value: Buffer;
      path: string;
      expires_utc: number;
      is_secure: number;
      is_httponly: number;
    }>;

    return rows.map((row) => {
      let value = row.value;
      if (
        !value &&
        row.encrypted_value &&
        row.encrypted_value.length > 0
      ) {
        value = decryptCookieValue(row.encrypted_value, key);
      }
      return {
        host: row.host_key,
        name: row.name,
        value,
        path: row.path,
        expires: row.expires_utc > 0 ? row.expires_utc / 1_000_000 - 11644473600 : -1,
        secure: !!row.is_secure,
        httpOnly: !!row.is_httponly,
      };
    });
  } finally {
    db?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
