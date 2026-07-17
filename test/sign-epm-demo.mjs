#!/usr/bin/env node
// eParaksts Mobile (ePM / LVRTC) signing - end-to-end cycle runner.
//
// Steps: 1) upload PDF -> document ID, 2) start ePM signing -> LVRTC auth URL,
//        3) you open the URL and authenticate; the return URL is captured,
//        4) exchange the auth code -> signer identity + LVRTC sign URL,
//        5) you open the sign URL and confirm; the return URL is captured,
//        6) finalize the signature, 7) poll if needed, 8) download the signed PDF.
//
// The two LVRTC legs need a human (eParaksts mobile app confirmation), so the
// script prints each URL and captures the redirect back in one of two modes:
//   - paste mode (default): after LVRTC redirects your browser to the return
//     page, copy the full address-bar URL and paste it into the terminal.
//   - listener mode (--listen <port>): a local HTTP server catches the redirect
//     automatically. Only works when the redirect URI registered with LVRTC
//     points at this machine (e.g. https://localhost:<port>/... via a tunnel).
//
// Usage:
//   ARCHIVE_BASE=https://<host>/archive/api \
//   CONTAINER_BASE=https://<host>/container/api \
//   AUTH_REDIRECT_URI=https://<your-app>/epm/return/auth \
//   SIGN_REDIRECT_URI=https://<your-app>/epm/return/sign \
//   [TOKEN=<keycloak-jwt>] [LOCALE=lv] [DOC_TYPE=DMSSDoc] \
//   [ACR_VALUES=urn:eparaksts:authentication:flow:mobileid] \
//   node sign-epm-demo.mjs [path-to.pdf] [--listen <port>]
//
// AUTH_REDIRECT_URI / SIGN_REDIRECT_URI are optional as a pair: leave BOTH unset
// to use the redirect URIs configured on the Container Service. Setting only one
// of them breaks the second token exchange, so the script refuses that.
//
// Requires Node 18+ (global fetch / FormData / Blob / AbortSignal.timeout).

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import readline from "node:readline/promises";

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));

const ARCHIVE_BASE = process.env.ARCHIVE_BASE;
const CONTAINER_BASE = process.env.CONTAINER_BASE;
const TOKEN = process.env.TOKEN || "";
const LOCALE = process.env.LOCALE || "lv";
const DOC_TYPE = process.env.DOC_TYPE || "DMSSDoc";
const ACR_VALUES = process.env.ACR_VALUES || "urn:eparaksts:authentication:flow:mobileid";
const AUTH_REDIRECT_URI = process.env.AUTH_REDIRECT_URI || "";
const SIGN_REDIRECT_URI = process.env.SIGN_REDIRECT_URI || "";

const args = process.argv.slice(2);
const listenIdx = args.indexOf("--listen");
const LISTEN_PORT = listenIdx >= 0 ? Number(args[listenIdx + 1]) : 0;
const positional = args.filter((a, i) => a !== "--listen" && i !== listenIdx + 1);
const PDF_PATH = positional[0] || here("./sample.pdf");

const REQUEST_TIMEOUT_MS = 30_000; // default per-request abort timeout
const POLL_INTERVAL_MS = 2_000;
const POLL_MAX_ROUNDS = 90;        // ~3 minutes on top of the server-side 60 s wait

function validateConfig() {
  if (!ARCHIVE_BASE || !CONTAINER_BASE) {
    console.error("Set ARCHIVE_BASE and CONTAINER_BASE environment variables.");
    process.exit(2);
  }
  if (!!AUTH_REDIRECT_URI !== !!SIGN_REDIRECT_URI) {
    console.error(
      "Set AUTH_REDIRECT_URI and SIGN_REDIRECT_URI together (or neither, to use the service defaults).\n" +
      "Passing only one leaves the other empty in the signing session and the second token exchange fails."
    );
    process.exit(2);
  }
  if (listenIdx >= 0 && (!Number.isInteger(LISTEN_PORT) || LISTEN_PORT <= 0)) {
    console.error("--listen requires a port number, e.g. --listen 8977");
    process.exit(2);
  }
}

const authHeaders = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
const log = (...a) => console.log(...a);

// fetch wrapper: always applies an abort timeout and parses JSON defensively.
async function call(url, { timeout = REQUEST_TIMEOUT_MS, ...options } = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout), ...options });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { res, body };
}

// Extract code+state from a redirect URL. Handles both the plain shape
// (.../return?code=...&state=...) and the wrapped shape where the interesting
// values sit inside an encoded redirect_uri query parameter.
export function extractCodeState(rawUrl) {
  let url;
  try { url = new URL(rawUrl.trim()); } catch { return null; }

  const direct = { code: url.searchParams.get("code"), state: url.searchParams.get("state") };
  if (direct.code && direct.state) return direct;

  const nested = url.searchParams.get("redirect_uri");
  if (nested) {
    try {
      const inner = new URL(decodeURIComponent(nested));
      const code = inner.searchParams.get("code");
      const state = inner.searchParams.get("state");
      if (code && state) return { code, state };
    } catch { /* fall through */ }
  }

  const error = url.searchParams.get("error");
  if (error) return { error, description: url.searchParams.get("error_description") || "" };
  return null;
}

// Paste mode: ask the operator for the full redirected URL.
async function captureByPaste(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = await rl.question(`${prompt}\n> `);
      const parsed = extractCodeState(answer);
      if (parsed?.error) throw new Error(`LVRTC returned error=${parsed.error} ${parsed.description}`);
      if (parsed?.code) return parsed;
      console.log("Could not find code+state in that URL, paste the full address-bar URL.");
    }
  } finally {
    rl.close();
  }
}

// Listener mode: catch the browser redirect on a local port.
function captureByListener(port, label) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const parsed = extractCodeState(`http://localhost:${port}${req.url}`);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<html><body><h3>${label}: received. You can return to the terminal.</h3></body></html>`);
      if (parsed?.code || parsed?.error) {
        server.close();
        if (parsed.error) reject(new Error(`LVRTC returned error=${parsed.error} ${parsed.description}`));
        else resolve(parsed);
      }
    });
    server.listen(port, () => log(`   listening on http://localhost:${port} for the ${label} redirect ...`));
    server.on("error", reject);
  });
}

async function captureRedirect(label) {
  if (LISTEN_PORT) return captureByListener(LISTEN_PORT, label);
  return captureByPaste(
    `After ${label}, your browser lands on the return page. Paste the full URL from the address bar:`
  );
}

async function uploadPdf(path) {
  const filename = basename(path);
  const form = new FormData();
  form.append("file", new Blob([await readFile(path)], { type: "application/pdf" }), filename);
  const documentData = JSON.stringify({
    documentFilename: filename,
    objectName: filename,
    documentType: DOC_TYPE,
  });
  const url = `${ARCHIVE_BASE}/document/create?documentData=${encodeURIComponent(documentData)}`;
  const { res, body } = await call(url, { method: "POST", headers: authHeaders, body: form });
  if (!res.ok || !body?.id) throw new Error(`upload failed: HTTP ${res.status} ${JSON.stringify(body)}`);
  return body.id;
}

// The service hands back LVRTC URLs in the Location header: as a real 302 on
// versions up to 24.3.0.49, as a 200 from 24.3.0.56. Never auto-follow those.
async function startSigning(docId, state) {
  const params = new URLSearchParams({ state, locale: LOCALE, acrValues: ACR_VALUES });
  if (AUTH_REDIRECT_URI) {
    params.set("authRedirectUri", AUTH_REDIRECT_URI);
    params.set("signRedirectUri", SIGN_REDIRECT_URI);
  }
  const url = `${CONTAINER_BASE}/signing/lvrtc/pdf/${encodeURIComponent(docId)}/sign?${params}`;
  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders,
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status === 403) {
    throw new Error(
      "HTTP 403: the Container Service has no lvrtc.clientId configured. " +
      "Apply the LVRTC block in application.yml and restart the service (manual, section 7)."
    );
  }
  const authUrl = res.headers.get("location");
  if (!authUrl || (res.status !== 200 && res.status !== 302)) {
    throw new Error(`start signing failed: HTTP ${res.status} ${await res.text()}`);
  }
  // session id: `session-id` header on 24.3.0.56+, JSON body { sessionId } before that
  let sessionId = res.headers.get("session-id");
  if (!sessionId) {
    try { sessionId = JSON.parse(await res.text())?.sessionId; } catch { /* empty body on new versions */ }
  }
  return { authUrl, sessionId: sessionId || state };
}

async function signingIdentity(state, code) {
  const url = `${CONTAINER_BASE}/signing/lvrtc/signing-identity?` + new URLSearchParams({ state, code });
  const { res, body } = await call(url, {
    method: "POST", headers: authHeaders, redirect: "manual", timeout: 60_000,
  });
  // sign URL: JSON `location` field on 24.3.0.56+, Location header on earlier versions
  const signUrl = body?.location || res.headers.get("location");
  if ((res.status !== 200 && res.status !== 302) || !signUrl) {
    throw new Error(`signing-identity failed: HTTP ${res.status} ${JSON.stringify(body)} ` +
      "(401 usually means an expired/reused code, an expired session, or a redirect-URI mismatch)");
  }
  return { ...body, signUrl };
}

async function finalizeSignature(state, code) {
  const url = `${CONTAINER_BASE}/signing/lvrtc/signature?` + new URLSearchParams({ state, code });
  // The server blocks up to 60 s for single documents; allow for that plus latency.
  const { res, body } = await call(url, { method: "POST", headers: authHeaders, timeout: 90_000 });
  if (!res.ok) {
    throw new Error(`finalize failed: HTTP ${res.status} ${JSON.stringify(body)} ` +
      "(401 usually means an expired/reused code, an expired session, or a redirect-URI mismatch)");
  }
  return body;
}

async function waitForResult(state) {
  for (let round = 1; round <= POLL_MAX_ROUNDS; round++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const url = `${CONTAINER_BASE}/signing/lvrtc/session/${encodeURIComponent(state)}/status`;
    const { res, body } = await call(url, { headers: authHeaders });
    const result = body?.result;
    log(`   status: ${result}${res.ok ? "" : ` (HTTP ${res.status})`}`);
    if (result === "SIGNING_COMPLETED") return body;
    if (result === "SIGNING_IN_PROGRESS" || result === "SIGNING_STARTED") continue;
    throw new Error(`signing did not complete: HTTP ${res.status} ${JSON.stringify(body)}`);
  }
  throw new Error(`timed out waiting for SIGNING_COMPLETED after ${POLL_MAX_ROUNDS} rounds`);
}

async function download(docId, outPath) {
  const url = `${ARCHIVE_BASE}/document/${encodeURIComponent(docId)}/download`;
  const res = await fetch(url, { headers: authHeaders, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} ${await res.text()}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(outPath, buf);
  const pdf = buf.toString("latin1");
  const signed = pdf.includes("/Type /Sig") || pdf.includes("/ByteRange");
  return { bytes: buf.length, signed };
}

async function main() {
  validateConfig();
  log("eParaksts Mobile (ePM) signing cycle");
  log(`  archive   : ${ARCHIVE_BASE}`);
  log(`  container : ${CONTAINER_BASE}`);
  log(`  returns   : ${AUTH_REDIRECT_URI ? `${AUTH_REDIRECT_URI} / ${SIGN_REDIRECT_URI}` : "(service defaults)"}`);
  log(`  capture   : ${LISTEN_PORT ? `local listener on port ${LISTEN_PORT}` : "paste mode"}`);
  log(`  pdf       : ${PDF_PATH}\n`);

  log("1) upload PDF ...");
  const docId = await uploadPdf(PDF_PATH);
  log(`   document id: ${docId}\n`);

  log("2) start ePM signing ...");
  const state = randomUUID();
  const { authUrl, sessionId } = await startSigning(docId, state);
  if (sessionId !== state) log(`   note: service session-id ${sessionId} differs from requested state`);
  log(`   state: ${state}`);
  log(`\n   Open this URL in a browser and authenticate with eParaksts Mobile:\n   ${authUrl}\n`);

  log("3) waiting for the authentication redirect ...");
  const auth = await captureRedirect("authentication");
  if (auth.state !== state) throw new Error(`state mismatch on auth leg: got ${auth.state}`);
  log("   auth code received.\n");

  log("4) exchange auth code for identity + sign URL ...");
  const identity = await signingIdentity(state, auth.code);
  log(`   signer : ${identity.name} (${identity.serialNumber})`);
  log(`\n   Open this URL in a browser and confirm the signature in eParaksts Mobile:\n   ${identity.signUrl}\n`);

  log("5) waiting for the signing redirect ...");
  const sign = await captureRedirect("signing confirmation");
  if (sign.state !== state) throw new Error(`state mismatch on sign leg: got ${sign.state}`);
  log("   sign code received.\n");

  log("6) finalize signature ...");
  const outcome = await finalizeSignature(state, sign.code);
  log(`   result: ${outcome.result}`);
  if (outcome.result === "SIGNING_FAILED") {
    throw new Error("SIGNING_FAILED: finalization failed, check the Container Service logs");
  }
  if (outcome.result !== "SIGNING_COMPLETED") {
    log("6a) polling session status ...");
    await waitForResult(state);
  }
  log("   -> SIGNING_COMPLETED\n");

  log("7) download signed document ...");
  const { bytes, signed } = await download(docId, here("./signed.pdf"));
  log(`   saved signed.pdf (${bytes} bytes), signature present: ${signed}\n`);

  log(signed ? "OK: cycle completed, signed PDF downloaded." : "WARN: downloaded file has no signature marker.");
  process.exit(signed ? 0 : 1);
}

// Only run the cycle when executed directly (the parser is importable for tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    const msg = e?.name === "TimeoutError" ? "request timed out" : e?.message || String(e);
    console.error(`\nERROR: ${msg}`);
    process.exit(1);
  });
}
