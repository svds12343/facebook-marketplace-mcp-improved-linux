import { SecurityStopError } from "../activity/control.js";

export function checkResponseStatus(response: Response, image = false): void {
  if (response.status === 429) {
    const value = response.headers.get("retry-after") ?? "";
    const until = /^\d+$/.test(value) ? Date.now() + Number(value) * 1000 : Date.parse(value);
    throw new SecurityStopError("Facebook HTTP 429; all requests paused. Review the account manually before resuming.", Number.isFinite(until) ? Math.max(0, until) : 0);
  }
  // CDN 403 usually means an expired signed photo URL, not rejected account credentials.
  if (!image && [401, 403].includes(response.status)) throw new SecurityStopError(`Facebook HTTP ${response.status}; session rejected. Review Facebook manually and use npm run login if needed. All requests paused.`);
  if (!image && response.status >= 300 && response.status < 400) throw new SecurityStopError("Facebook redirected the request. All requests paused; inspect login/checkpoints manually.");
}

export function checkResponsePage(html: string): void {
  // Structural markers only: seller descriptions and JS can legitimately mention checkpoints.
  if (/<form\b[^>]*(?:id=["']login_form|action=["'][^"']*\/(?:login|checkpoint|two_step_verification)(?:\/|\?|["']))/i.test(html)
    || /<(?:title|h1)\b[^>]*>[^<]*(?:confirm (?:your identity|you(?:'|’)?re (?:a )?(?:real person|human))|security check|video selfie|temporarily blocked|confirmez votre identité|vérification de sécurité)[^<]*<\//i.test(html)) {
    throw new SecurityStopError("Facebook returned a login/security-check page. All requests paused; complete the checkpoint manually.");
  }
}
