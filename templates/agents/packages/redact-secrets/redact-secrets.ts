// packages/redact-secrets — blank anything shaped like a key, token, password
// or sign-in code in chat text, before a copy of that text leaves the
// conversation it was typed in.
//
// WHY. T3 keeps every turn of every thread, and a reader that copies them out —
// .agents/skills/close/scripts/corrections.ts, into the Corrections a /close commits to
// a journal and into any prompt built from them — would carry every token, key
// and client secret the user ever pasted in chat to wherever the copy goes.
// Each reader passes its copy through `redactSecrets`; T3's own record is
// never touched.
//
// WHAT COUNTS. Shapes, not a list of the user's keys:
//   - vendor formats: GitHub, OpenAI and Anthropic, xAI, Slack, AWS, Google
//     (API keys, sign-in codes, access and refresh tokens), Stripe, a job
//     runner's `tr_` keys,
//     a 1Password service account; a JWT; a private key block; a 1Password
//     share link's key; a `Bearer` header;
//   - a password in a URL (`https://user:pass@host`) and a secret-named URL
//     parameter (`?code=`, `&token=`, `&key=` …);
//   - a value named by a credential word — `secret = …`, `Key: …`,
//     `"authorizationCode":"…"`, `the password is …` — when it mixes letters and
//     digits, as a key does and a word does not;
//   - an unnamed random-looking run: 32 hex characters (a Steam key, an Epic
//     code), or 24+ characters mixing cases and digits with a random string's
//     spread of characters.
// WHAT IS KEPT. The words around each value, and what kind of thing it was
// (`[redacted GitHub token]`), so a reader still sees that a key was pasted
// there — a finding in itself, since T3's secret card exists for exactly that.
// Identifiers that only look random stay: a 40-character commit, a thread id
// (a UUID), slugs, paths, words.
//
// A miss leaks a credential and a false hit blanks an id in a prompt, so the
// unnamed-run rule leans to blanking.

const mark = (kind: string): string => `[redacted ${kind}]`;
const MARK_PREFIX = "[redacted ";

/** Shannon entropy in bits per character. */
export function entropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

/** A private key block, or one pasted without its END line. */
const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;

/** `scheme://user:password@` — the scheme is bounded so a long line cannot
 *  backtrack quadratically. */
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]{0,31}:\/\/[^\s/:@]+):([^\s/@]+)@/gi;

/** Vendor formats, each with what it is. The lookbehind keeps a format from
 *  matching the tail of a longer word. */
const VENDOR: [RegExp, string][] = [
  [/(?<![A-Za-z0-9_])(?:github_pat_[A-Za-z0-9_]{22,}|gh[pousr]_[A-Za-z0-9]{30,})/g, "GitHub token"],
  [/(?<![A-Za-z0-9])sk-(?:ant-|proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, "API key"],
  [/(?<![A-Za-z0-9])xai-[A-Za-z0-9]{20,}/g, "API key"],
  [/(?<![A-Za-z0-9])xox[abposr]-[A-Za-z0-9-]{10,}/g, "Slack token"],
  [/(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])/g, "AWS key"],
  [/(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}/g, "API key"],
  [/(?<![A-Za-z0-9])4\/0[A-Za-z0-9_-]{20,}/g, "Google sign-in code"],
  [/(?<![A-Za-z0-9])(?:1\/\/0[A-Za-z0-9_-]{20,}|ya29\.[A-Za-z0-9_-]{20,})/g, "Google token"],
  [/(?<![A-Za-z0-9])(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, "API key"],
  [/(?<![A-Za-z0-9])tr_(?:dev|prod|stg|pat)_[A-Za-z0-9]{16,}/g, "API key"],
  [/(?<![A-Za-z0-9])ops_[A-Za-z0-9_-]{40,}/g, "1Password token"],
  [/(?<![A-Za-z0-9_-])ey[A-Za-z0-9_-]{10,}\.ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, "token"],
];

/** A secret carried in a URL path rather than a parameter: the host and path
 *  stay, so the text still says what kind of link it was. */
const URL_PATH_SECRETS: RegExp[] = [
  /(hooks\.slack\.com\/(?:services|workflows|triggers)\/)[A-Za-z0-9/_-]+/g,
  /(discord(?:app)?\.com\/api\/webhooks\/\d+\/)[A-Za-z0-9_-]+/g,
  /(\/api\/push\/)[A-Za-z0-9]{8,}/g,
  /(api\.telegram\.org\/bot)\d{6,}:[A-Za-z0-9_-]{30,}/g,
];

/** The fragment after `share.1password.com/s#` decrypts the shared item; the
 *  host stays so the text still reads as "a link was shared". */
const ONEPASSWORD_SHARE = /(share\.1password\.com\/s#)[A-Za-z0-9_-]+/g;

const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]{16,}=*/g;

/** A URL parameter whose name ends in what it carries: `?code=`, `&SyncCode=`
 *  (a calendar feed), `&access_token=`, `&X-Amz-Signature=`, `#token=` (a T3
 *  pairing link). */
const URL_PARAM =
  /([?&#;][A-Za-z0-9_.-]*?(?:code|token|key|secret|password|passwd|pass|pwd|sig|signature|credential)=)([^&#\s"'<>)\]]{6,})/gi;
/** The same inside a URL that is itself a parameter, percent-encoded
 *  (`pairingUrl=…%2Fpair%23token%3D…`). */
const URL_PARAM_ENCODED =
  /((?:%3[Ff]|%26|%23)[A-Za-z0-9_.-]*?(?:code|token|key|secret|password|passwd|pass|pwd|sig|signature|credential)%3[Dd])([^&%#\s"'<>)\]]{6,})/gi;

/** A value named by a credential word: prose (`the password is …`, `your
 *  pairing code for my-server is …`), a label (`Key: …`, `secret = …`), env
 *  (`API_TOKEN=…`) or JSON (`"apiKey":"…"`), markdown bold and code marks
 *  included. */
const LABELLED =
  /(?<![A-Za-z0-9])((?:client[_ -]?secret|secret[_ -]?key|secret|api[_ -]?key|access[_ -]?key|private[_ -]?key|auth(?:orization)?[_ -]?code|exchange[_ -]?code|(?:pairing|sign[_ -]?in|login|verification|security|one[_ -]?time)[_ -]?code(?:\s+(?:for|from|on)\s+[\w.-]+)?|refresh[_ -]?token|access[_ -]?token|auth[_ -]?token|id[_ -]?token|token|password|passwd|passphrase|pwd|passcode|key)["'`*]*\s*(?:[:=]|\bis\b)[\s*_"'`]*)([^\s"'`*,;<>()[\]{}]+)/gi;

/** A labelled value is a credential when it mixes letters and digits, as every
 *  key does and a word does not ("the key is understanding" stays). A value
 *  that is a reference to where a secret lives, or a URL, is not one. */
function looksLikeSecret(label: string, value: string): boolean {
  if (value.startsWith(MARK_PREFIX) || value.length < 6) return false;
  if (/^(?:op:\/\/|\$|%|process\.env|CREDS\.)/.test(value) || value.includes("://")) return false;
  // A bare "key" names too much (a map key, a file); it needs a key's shape.
  if (/^key/i.test(label) && /[./]/.test(value)) return false;
  return /\d/.test(value) && /[A-Za-z]/.test(value);
}

/** 32 hex characters on their own: a Steam key, an Epic sign-in code, an MD5.
 *  A 40-character commit and a dashed UUID are not this length. */
const HEX32 = /(?<![A-Za-z0-9])[0-9a-fA-F]{32}(?![A-Za-z0-9])/g;

/** A run that could be a key with no name beside it. `/`, `.` and `:` end a
 *  run, so a path, a domain or a URL is pieces, not one run. */
const RUN = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{24,}(?![A-Za-z0-9_-])/g;

/** Mixed case and digits — which no commit, UUID or slug has, being one case —
 *  with a random string's spread of characters: 4.0 bits a character for a run
 *  under 32, 4.2 from 32 (a measured cut: a long identifier,
 *  `NSNavPanelFileListModeForOpenMode2`, reaches 4.14). */
function isRandomRun(run: string): boolean {
  if (!(/[a-z]/.test(run) && /[A-Z]/.test(run) && /\d/.test(run))) return false;
  return entropy(run) >= (run.length < 32 ? 4.0 : 4.2);
}

/** A Google Docs, Sheets, Slides or Drive address: the id after `/d/` or
 *  `/folders/` names a document, which its sharing settings guard, and is the
 *  one random-looking run that turns up in nearly every session. */
const GOOGLE_DOC_ID_BEFORE =
  /(?:(?:docs|drive|sites)\.google\.com\/(?:\S*\/)?(?:d|folders)\/|drive\.google\.com\/(?:open|uc)\?(?:\S*&)?id=)$/;

/** The text with every credential-shaped value blanked. */
export function redactSecrets(text: string): string {
  let out = text.replace(PRIVATE_KEY, mark("private key"));
  out = out.replace(URL_PASSWORD, (_m, head: string) => `${head}:${mark("password")}@`);
  for (const [re, kind] of VENDOR) out = out.replace(re, mark(kind));
  out = out.replace(ONEPASSWORD_SHARE, (_m, head: string) => `${head}${mark("share key")}`);
  for (const re of URL_PATH_SECRETS) out = out.replace(re, (_m, head: string) => `${head}${mark("secret")}`);
  out = out.replace(BEARER, (_m, scheme: string) => `${scheme} ${mark("token")}`);
  // A parameter's value is a code when it has a digit or a key's length; a word
  // is a command (Autotask's `?Code=OpenProject`), not a secret.
  const param = (m: string, head: string, value: string): string =>
    value.startsWith(MARK_PREFIX) || !(/\d/.test(value) || value.length >= 20) ? m : `${head}${mark("secret")}`;
  out = out.replace(URL_PARAM, param).replace(URL_PARAM_ENCODED, param);
  out = out.replace(LABELLED, (m, head: string, value: string) =>
    looksLikeSecret(head, value) ? `${head}${mark("secret")}` : m,
  );
  out = out.replace(HEX32, (hex) => (/\d/.test(hex) && /[a-fA-F]/.test(hex) ? mark("key") : hex));
  out = out.replace(RUN, (run, at: number, whole: string) =>
    isRandomRun(run) && !GOOGLE_DOC_ID_BEFORE.test(whole.slice(Math.max(0, at - 200), at)) ? mark("key") : run,
  );
  return out;
}
