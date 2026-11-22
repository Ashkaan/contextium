// redact-secrets.test.ts — what is blanked, what kind it is said to be, and
// what is left alone.
//
// Run: node --test --experimental-strip-types packages/redact-secrets/redact-secrets.test.ts
//
// Every credential below is built at run time from a repeated pattern, so no
// credential-shaped literal sits in the repo for a secret scanner to flag. The
// shapes are what people really paste in chat: fine-grained GitHub tokens,
// Google and Epic sign-in codes, a Steam key, a client secret, T3 pairing codes,
// a calendar feed's sync code.

import assert from "node:assert/strict";
import { test } from "node:test";

import { entropy, redactSecrets } from "./redact-secrets.ts";

const blanks = (input: string, want: string): void => assert.equal(redactSecrets(input), want, input);
const keeps = (input: string): void => assert.equal(redactSecrets(input), input, `${input} should be left alone`);

const PAT = `github_pat_11ABCDEFG0${"a1B2c3D4e5".repeat(7)}Zq`;
const CLASSIC = `ghp_${"Xy7Wv3Ut9S".repeat(3)}Rq5Po4`;
const GOOGLE_CODE = `4/0A${"bC3dE5fG7h-J9".repeat(5)}kLm`;
const HEX = "0f8e7d6c5b4a39281706f5e4d3c2b1a0";
const RANDOM = "Qm7Zr2Lx9Wk4Tp8Vn3Bc6Hy1";

test("vendor formats are blanked and named", () => {
  blanks(`here is the token: ${PAT} thanks`, "here is the token: [redacted GitHub token] thanks");
  blanks(`old one ${CLASSIC}, now revoked`, "old one [redacted GitHub token], now revoked");
  blanks(GOOGLE_CODE, "[redacted Google sign-in code]");
  blanks(`ya29.${"a0Bc1De2Fg".repeat(3)}`, "[redacted Google token]");
  blanks(`AIza${"Sy0B1c2D3e4".repeat(3)}xy`, "[redacted API key]");
  blanks(`sk-ant-api03-${"Ab1Cd2Ef3G".repeat(3)}`, "[redacted API key]");
  blanks(`xai-${"Ab1Cd2Ef3G".repeat(3)}`, "[redacted API key]");
  blanks(`xoxb-${"1234567890".repeat(2)}-abcdef`, "[redacted Slack token]");
  blanks(`AKIA${"ABCD2345".repeat(2)} is the id`, "[redacted AWS key] is the id");
  blanks(`tr_prod_${"Ab1Cd2Ef3G".repeat(2)}`, "[redacted API key]");
  blanks(`ops_${"eyJhbGciOi".repeat(5)}`, "[redacted 1Password token]");
  blanks(`eyJ${"hbGciOiJI".repeat(2)}.eyJ${"zdWIiOiIx".repeat(2)}.${"Sfl".repeat(5)}`, "[redacted token]");
  blanks("https://share.1password.com/s#AbC-dEf_123", "https://share.1password.com/s#[redacted share key]");
  blanks(`Authorization: Bearer ${"a1B2c3D4e5".repeat(3)}`, "Authorization: Bearer [redacted token]");
});

test("a private key block is blanked whole, even without its END line", () => {
  const body = `${"MIIEvQIBADANBgkqhkiG9w0BAQEFAASC".repeat(2)}\n${"bm9uZQ".repeat(10)}`;
  blanks(
    `key:\n-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\ndone`,
    "key:\n[redacted private key]\ndone",
  );
  blanks(`-----BEGIN OPENSSH PRIVATE KEY-----\n${body}`, "[redacted private key]");
});

test("URLs: a password, a secret-named parameter, a secret in the path", () => {
  blanks("rtsp://admin:Hunter22x@192.0.2.56/live0", "rtsp://admin:[redacted password]@192.0.2.56/live0");
  blanks(`http://localhost/?code=${HEX}&state=x`, "http://localhost/?code=[redacted secret]&state=x");
  blanks("https://t3.example.com/pair#token=AB12CD34EF56", "https://t3.example.com/pair#token=[redacted secret]");
  blanks("cal.aspx?view=1&SyncCode=tj1pwcdtmv418sv70l0h&x=1", "cal.aspx?view=1&SyncCode=[redacted secret]&x=1");
  blanks("x?pairingUrl=http%3A%2F%2Fh%2Fpair%23token%3DAB12CD34EF56", "x?pairingUrl=http%3A%2F%2Fh%2Fpair%23token%3D[redacted secret]");
  blanks("https://hooks.slack.com/services/T000/B000/XXXXyyyy1234", "https://hooks.slack.com/services/[redacted secret]");
  blanks("https://status.example.com/api/push/Ab12Cd34Ef?status=up", "https://status.example.com/api/push/[redacted secret]?status=up");
  // A word in a code-named parameter is a command, not a secret.
  keeps("https://ww4.autotask.net/AutotaskExtend/ExecuteCommand.aspx?Code=OpenProject&ProjectID=51");
});

test("a value named by a credential word is blanked when it looks like a key", () => {
  blanks(`4) id = n5rq8w2k / secret = ${"wsvk3j9x0q2m8".repeat(2)}`, "4) id = n5rq8w2k / secret = [redacted secret]");
  blanks("Your Steam Web API Key\nKey: A1B2C3D4E5F60718293A4B5C6D7E8F90 Domain", "Your Steam Web API Key\nKey: [redacted secret] Domain");
  blanks(`{"authorizationCode":"${HEX}","exchangeCode":null}`, '{"authorizationCode":"[redacted secret]","exchangeCode":null}');
  blanks("the password is Hunter2x9", "the password is [redacted secret]");
  blanks("API_TOKEN=abc123def456ghi", "API_TOKEN=[redacted secret]");
  blanks("Pairing code: `AB12CD34EF56` (expires 1:37 PM)", "Pairing code: `[redacted secret]` (expires 1:37 PM)");
  blanks("Your pairing code for my-server is **AB12CD34EF56**.", "Your pairing code for my-server is **[redacted secret]**.");
});

test("a named value that is not a key is left alone", () => {
  keeps("the key is understanding the customer");
  keeps("the password is in 1Password");
  keeps("token: 5, max_tokens=4096, input_tokens: 12345");
  keeps('"exchangeCode":null,"sid":null');
  keeps("secret: op://Private/GitHub PAT - deploy/credential");
  keeps("password: process.env.SMTP_PASSWORD");
  keeps("key: apps/tools/digest/src/lib/t3-messages.ts");
  keeps("key: https://github.com/example/workbench/issues/922");
});

test("an unnamed random run is blanked; ids, commits, slugs, paths and words are not", () => {
  blanks(`1) yes 2) done. ${RANDOM}`, "1) yes 2) done. [redacted key]");
  blanks(`clientId=x and ${HEX} alone`, "clientId=x and [redacted key] alone");
  keeps("the deploy at fe20c5a7caf2f65092e1709cb989988c2b57ed04 broke");
  keeps("thread 52345678-1111-2222-3333-444444444444 and 01a1773c-a16e-7243-801b-094f84dc86dd");
  keeps("projects/ops/2026-01-01_mail-rules/specs/008-fix-labels-for-a-sender/README.md");
  keeps("registered_1624597571044 and NSNavPanelFileListModeForOpenMode2 and supercalifragilisticexpialidocious");
  keeps(`https://docs.google.com/spreadsheets/d/1qV${RANDOM}x9/edit?gid=0#gid=0`);
  keeps(`https://drive.google.com/file/d/1iW${RANDOM}Ab/view and https://drive.google.com/drive/folders/1Zx${RANDOM}`);
  keeps(`https://sites.google.com/d/1Ab${RANDOM}/edit and https://drive.google.com/open?id=1Cd${RANDOM}`);
  keeps(`![x](t3-context://v1/files/${"x".repeat(2500)})`);
});

test("edges: empty, already redacted, a long text with nothing to find", () => {
  assert.equal(redactSecrets(""), "");
  const once = redactSecrets(`a ${PAT} b ${HEX} c secret = Abc123xyz`);
  assert.equal(redactSecrets(once), once, "redacting twice changes nothing more");
  const long = "the quick brown fox jumps over the lazy dog 2026-11-20 ".repeat(20_000);
  const t0 = Date.now();
  assert.equal(redactSecrets(long), long);
  assert.ok(Date.now() - t0 < 3_000, `a 1.1 MB text took ${Date.now() - t0}ms`);
});

test("entropy: bits a character", () => {
  assert.equal(entropy(""), 0);
  assert.equal(entropy("aaaa"), 0);
  assert.equal(entropy("ab"), 1);
  assert.ok(entropy(RANDOM) > 4.0);
});
