// JWS / X.509 verification primitives for billing webhooks (Deno, strict TS).
// No third-party deps: a minimal DER walker + WebCrypto.
//
// - Apple App Store Server Notifications v2 (`verifyAppleJws`): ES256 JWS whose
//   x5c chain must cryptographically anchor to Apple Root CA - G3 — every link
//   signature is verified, the root must be self-signed with that exact CN,
//   and every certificate must be inside its validity window. Trust comes from
//   the root's KEY (chain signatures verified), not from any pinned constant.
// - Google Pub/Sub push (`verifyGoogleOidcToken`): RS256 OIDC JWT verified
//   against Google's published JWKS (cached 1h per isolate).
//
// Fail closed: any structural, cryptographic, or temporal anomaly throws
// HttpError(401, "bad_signature").

import { HttpError } from "./http.ts";

const badSig = (message: string) => new HttpError(401, "bad_signature", message);

// ------------------------------------------------------------------ util ---

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function b64UrlToBytes(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (s.length % 4)) % 4);
  return b64ToBytes(padded);
}

function b64UrlToString(s: string): string {
  return new TextDecoder().decode(b64UrlToBytes(s));
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

// ------------------------------------------------------------- DER walker ---

interface DerNode {
  tag: number;
  /** Offset of the full TLV (tag + length + content). */
  tlvStart: number;
  contentStart: number;
  /** Offset one past the content end. */
  end: number;
  children: DerNode[];
}

function readDerLength(buf: Uint8Array, pos: number, end: number): { len: number; next: number } {
  if (pos >= end) throw new Error("der: truncated length");
  const b0 = buf[pos]!;
  if (b0 < 0x80) return { len: b0, next: pos + 1 };
  const n = b0 & 0x7f;
  if (n === 0 || n > 4) throw new Error("der: unsupported length form");
  if (pos + 1 + n > end) throw new Error("der: truncated length bytes");
  let len = 0;
  for (let i = 0; i < n; i++) len = len * 0x100 + buf[pos + 1 + i]!;
  return { len, next: pos + 1 + n };
}

function parseDerNode(buf: Uint8Array, start: number, end: number): DerNode {
  if (start + 2 > end) throw new Error("der: truncated node");
  const tag = buf[start]!;
  const { len, next } = readDerLength(buf, start + 1, end);
  const contentStart = next;
  const contentEnd = next + len;
  if (contentEnd > end) throw new Error("der: node overruns parent");
  const node: DerNode = { tag, tlvStart: start, contentStart, end: contentEnd, children: [] };
  if ((tag & 0x20) !== 0) {
    let p = contentStart;
    while (p < contentEnd) {
      const child = parseDerNode(buf, p, contentEnd);
      node.children.push(child);
      p = child.end;
    }
  }
  return node;
}

const OID_RSA_ENCRYPTION = "1.2.840.113549.1.1.1";
const OID_SHA256_RSA = "1.2.840.113549.1.1.11";
const OID_EC_PUBLIC_KEY = "1.2.840.10045.2.1";
const OID_ECDSA_SHA256 = "1.2.840.10045.4.3.2";
const OID_ECDSA_SHA384 = "1.2.840.10045.4.3.3";
const CURVE_P256 = "1.2.840.10045.3.1.7";
const CURVE_P384 = "1.3.132.0.34";

function oidOf(buf: Uint8Array, algOrOid: DerNode): string {
  const oidNode = algOrOid.tag === 0x06 ? algOrOid : algOrOid.children[0];
  if (!oidNode || oidNode.tag !== 0x06) throw new Error("der: expected OID");
  const bytes = buf.subarray(oidNode.contentStart, oidNode.end);
  if (bytes.length === 0) throw new Error("der: empty OID");
  const parts: number[] = [Math.floor(bytes[0]! / 40), bytes[0]! % 40];
  let val = 0;
  for (let i = 1; i < bytes.length; i++) {
    val = val * 0x80 + (bytes[i]! & 0x7f);
    if ((bytes[i]! & 0x80) === 0) {
      parts.push(val);
      val = 0;
    }
  }
  return parts.join(".");
}

/** Common Name (OID 2.5.4.3) of an X.509 Name, if present. */
function cnOfName(buf: Uint8Array, name: DerNode): string | null {
  for (const rdn of name.children) {
    for (const atv of rdn.children) {
      if (atv.children.length < 2) continue;
      const oidNode = atv.children[0]!;
      if (oidNode.tag !== 0x06) continue;
      const b = buf.subarray(oidNode.contentStart, oidNode.end);
      if (b.length === 3 && b[0] === 0x55 && b[1] === 0x04 && b[2] === 0x03) {
        const v = atv.children[1]!;
        return new TextDecoder().decode(buf.subarray(v.contentStart, v.end));
      }
    }
  }
  return null;
}

/** UTCTime (0x17) / GeneralizedTime (0x18) → epoch ms (0 when unparsable). */
function asn1TimeToMs(buf: Uint8Array, node: DerNode): number {
  const s = new TextDecoder().decode(buf.subarray(node.contentStart, node.end));
  const generalized = node.tag === 0x18;
  const re = generalized
    ? /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z?$/
    : /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z?$/;
  const m = re.exec(s);
  if (!m) return 0;
  const year = generalized
    ? Number(m[1])
    : (Number(m[1]) >= 50 ? 1900 + Number(m[1]) : 2000 + Number(m[1]));
  return Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

interface ParsedCert {
  der: Uint8Array;
  tbs: DerNode;
  spki: DerNode;
  algOid: string;
  /** Signature bytes (BIT STRING content, unused-bits byte stripped). */
  signature: Uint8Array;
  issuer: DerNode;
  subject: DerNode;
  notBeforeMs: number;
  notAfterMs: number;
}

function parseCert(der: Uint8Array): ParsedCert {
  const cert = parseDerNode(der, 0, der.length);
  if (cert.tag !== 0x30 || cert.children.length < 3) throw badSig("malformed certificate");
  const tbs = cert.children[0]!;
  const sigAlg = cert.children[1]!;
  const sigVal = cert.children[2]!;
  if (sigVal.tag !== 0x03) throw badSig("malformed certificate signature");
  let idx = 0;
  if (tbs.children[0]?.tag === 0xa0) idx = 1; // explicit [0] version
  const serial = tbs.children[idx++];
  const tbsSigAlg = tbs.children[idx++];
  const issuer = tbs.children[idx++];
  const validity = tbs.children[idx++];
  const subject = tbs.children[idx++];
  const spki = tbs.children[idx++];
  if (!serial || !tbsSigAlg || !issuer || !validity || !subject || !spki) {
    throw badSig("malformed TBSCertificate");
  }
  const validityTimes = validity.children.filter((c) => c.tag === 0x17 || c.tag === 0x18);
  if (validityTimes.length < 2) throw badSig("malformed certificate validity");
  return {
    der,
    tbs,
    spki,
    algOid: oidOf(der, sigAlg),
    signature: der.subarray(sigVal.contentStart + 1, sigVal.end),
    issuer,
    subject,
    notBeforeMs: asn1TimeToMs(der, validityTimes[0]!),
    notAfterMs: asn1TimeToMs(der, validityTimes[1]!),
  };
}

async function importSubjectPublicKey(cert: ParsedCert): Promise<CryptoKey> {
  const keyAlgOid = oidOf(cert.der, cert.spki.children[0]!);
  const spkiBytes = cert.der.subarray(cert.spki.tlvStart, cert.spki.end);
  if (keyAlgOid === OID_RSA_ENCRYPTION) {
    return crypto.subtle.importKey(
      "spki",
      spkiBytes,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  }
  if (keyAlgOid === OID_EC_PUBLIC_KEY) {
    const curveOid = oidOf(cert.der, cert.spki.children[0]!.children[1]!);
    return crypto.subtle.importKey(
      "spki",
      spkiBytes,
      { name: "ECDSA", namedCurve: curveOid === CURVE_P384 ? "P-384" : "P-256" },
      false,
      ["verify"],
    );
  }
  throw badSig("unsupported certificate public key");
}

/** X.509 ECDSA signatures are DER (SEQUENCE of r,s) — WebCrypto wants raw r||s. */
function derEcdsaSigToRaw(der: Uint8Array): Uint8Array {
  const seq = parseDerNode(der, 0, der.length);
  const r = seq.children[0]!;
  const s = seq.children[1]!;
  const rBytes = der.subarray(r.contentStart, r.end);
  const sBytes = der.subarray(s.contentStart, s.end);
  const half = Math.max(rBytes.length, sBytes.length);
  const raw = new Uint8Array(half * 2);
  raw.set(rBytes, half - rBytes.length);
  raw.set(sBytes, half * 2 - sBytes.length);
  return raw;
}

async function verifyCertSignature(child: ParsedCert, issuer: ParsedCert): Promise<void> {
  const key = await importSubjectPublicKey(issuer);
  const tbsBytes = child.der.subarray(child.tbs.tlvStart, child.tbs.end);
  let algo: AlgorithmIdentifier;
  let sig = child.signature;
  switch (child.algOid) {
    case OID_SHA256_RSA:
      algo = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
      break;
    case OID_ECDSA_SHA256:
    case OID_ECDSA_SHA384: {
      algo = { name: "ECDSA", hash: child.algOid === OID_ECDSA_SHA384 ? "SHA-384" : "SHA-256" };
      sig = derEcdsaSigToRaw(sig);
      break;
    }
    default:
      throw badSig("unsupported certificate signature algorithm");
  }
  const ok = await crypto.subtle.verify(algo, key, sig, tbsBytes);
  if (!ok) throw badSig("certificate chain signature invalid");
}

// ------------------------------------------------- Apple ASN v2 (ES256) ---

const APPLE_ROOT_CN = "Apple Root CA - G3";

/**
 * Verify an Apple App Store Server Notifications v2 signed payload end-to-end
 * and return the decoded payload. Throws HttpError(401, "bad_signature") on
 * ANY failure — callers must treat the output as trusted only after this
 * returns.
 */
export async function verifyAppleJws<T>(jws: string): Promise<T> {
  const parts = jws.split(".");
  if (parts.length !== 3) throw badSig("malformed JWS");
  let header: { alg?: string; x5c?: string[] };
  try {
    header = JSON.parse(b64UrlToString(parts[0]!)) as { alg?: string; x5c?: string[] };
  } catch {
    throw badSig("malformed JWS header");
  }
  if (header.alg !== "ES256") throw badSig("unsupported JWS algorithm");
  const x5c = header.x5c ?? [];
  if (x5c.length < 3) throw badSig("x5c chain too short");

  let certs: Uint8Array[];
  let parsed: ParsedCert[];
  try {
    certs = x5c.map(b64ToBytes);
    parsed = certs.map(parseCert);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw badSig("unparsable certificate chain");
  }

  const nowMs = Date.now();
  for (const [i, c] of parsed.entries()) {
    if (c.notBeforeMs === 0 || c.notAfterMs === 0) throw badSig("unparsable certificate validity");
    if (nowMs < c.notBeforeMs || nowMs > c.notAfterMs) throw badSig(`certificate ${i} outside validity`);
  }

  // Verify every link: cert[i] must be signed by cert[i+1]'s key and its
  // issuer name must match that certificate's subject.
  for (let i = 0; i < parsed.length - 1; i++) {
    const child = parsed[i]!;
    const parent = parsed[i + 1]!;
    if (!bytesEqual(child.der.subarray(child.issuer.tlvStart, child.issuer.end), parent.der.subarray(parent.subject.tlvStart, parent.subject.end))) {
      throw badSig("certificate chain issuer/subject mismatch");
    }
    await verifyCertSignature(child, parent);
  }

  // Anchor: root must be self-signed, self-consistent, and Apple Root CA - G3.
  const root = parsed[parsed.length - 1]!;
  const rootNameSpan = root.der.subarray(root.subject.tlvStart, root.subject.end);
  if (!bytesEqual(root.der.subarray(root.issuer.tlvStart, root.issuer.end), rootNameSpan)) {
    throw badSig("chain root is not self-signed");
  }
  const rootCn = (cnOfName(root.der, root.subject) ?? "").replace(/\s+/g, " ").trim();
  if (rootCn !== APPLE_ROOT_CN) throw badSig("chain does not anchor to Apple Root CA");
  await verifyCertSignature(root, root);

  // The JWS signature itself: ES256 raw r||s over header.payload, leaf key.
  const leafKey = await importSubjectPublicKey(parsed[0]!);
  const signedData = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    leafKey,
    b64UrlToBytes(parts[2]!),
    signedData,
  );
  if (!ok) throw badSig("JWS signature invalid");

  try {
    return JSON.parse(b64UrlToString(parts[1]!)) as T;
  } catch {
    throw badSig("malformed JWS payload");
  }
}

// ---------------------------------------------- Google Pub/Sub OIDC (RS256) ---

interface GoogleJwk {
  kty?: string;
  kid?: string;
  n?: string;
  e?: string;
}

let jwksCache: { keys: GoogleJwk[]; fetchedAt: number } | null = null;

async function googleJwks(): Promise<GoogleJwk[]> {
  if (jwksCache && Date.now() - jwksCache.fetchedAt < 3_600_000) return jwksCache.keys;
  const res = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  if (!res.ok) throw badSig("Google JWKS unavailable");
  const body = (await res.json()) as { keys?: GoogleJwk[] };
  if (!body.keys?.length) throw badSig("Google JWKS empty");
  jwksCache = { keys: body.keys, fetchedAt: Date.now() };
  return body.keys;
}

export interface OidcClaims {
  iss?: string;
  sub?: string;
  email?: string;
  exp?: number;
}

/**
 * Verify a Google Pub/Sub push OIDC token (RS256 against Google's JWKS).
 * Issuer must be accounts.google.com and exp must be in the future (60s
 * skew). `aud` is NOT enforced — Pub/Sub sets it to the push endpoint URL,
 * which this function cannot know; the caller pins the service-account email.
 */
export async function verifyGoogleOidcToken(token: string): Promise<OidcClaims> {
  const parts = token.split(".");
  if (parts.length !== 3) throw badSig("malformed OIDC JWT");
  let header: { alg?: string; kid?: string };
  try {
    header = JSON.parse(b64UrlToString(parts[0]!)) as { alg?: string; kid?: string };
  } catch {
    throw badSig("malformed OIDC JWT header");
  }
  if (header.alg !== "RS256" || !header.kid) throw badSig("unsupported OIDC JWT");
  const jwk = (await googleJwks()).find((k) => k.kid === header.kid);
  if (!jwk || jwk.kty !== "RSA" || !jwk.n || !jwk.e) throw badSig("unknown OIDC signing key");
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", use: "sig" },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    key,
    b64UrlToBytes(parts[2]!),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) throw badSig("OIDC signature invalid");
  let claims: OidcClaims;
  try {
    claims = JSON.parse(b64UrlToString(parts[1]!)) as OidcClaims;
  } catch {
    throw badSig("malformed OIDC claims");
  }
  if (claims.iss !== "accounts.google.com" && claims.iss !== "https://accounts.google.com") {
    throw badSig("OIDC issuer not Google");
  }
  if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now() - 60_000) {
    throw badSig("OIDC token expired");
  }
  return claims;
}
