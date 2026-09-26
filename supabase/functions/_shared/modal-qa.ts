import { HttpError } from "./http.ts";

export const QA_MODAL_PROVIDER = "modal-qwen-qa";

const MAX_INPUT_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_API_RESPONSE_BYTES = 18 * 1024 * 1024;
export const MAX_MODAL_WORKER_RUNTIME_SECONDS = 90;
const STARTUP_RESERVE_SECONDS = 30;
const SCALE_DOWN_RESERVE_SECONDS = 1;
const MAX_ESTIMATED_BILLABLE_SECONDS = MAX_MODAL_WORKER_RUNTIME_SECONDS +
  STARTUP_RESERVE_SECONDS +
  SCALE_DOWN_RESERVE_SECONDS;
const IMAGE_FETCH_TIMEOUT_MS = 10_000;
// QA cold starts include a ~60-90s model load before inference.
const MODAL_REQUEST_TIMEOUT_MS = 300_000;

export interface ModalQaConfig {
  endpoint: string;
  tokenId: string;
  tokenSecret: string;
  gpuUsdPerSecond: number;
}

export interface ModalQaResult {
  imageBytes: Uint8Array;
  workerRuntimeSeconds: number;
  gpuUsdPerSecond: number;
}

export class ModalQaError extends Error {
  constructor(
    message: string,
    readonly workerRuntimeSeconds?: number,
    readonly gpuUsdPerSecond?: number,
  ) {
    super(message);
    this.name = "ModalQaError";
  }
}

export class ModalQaAlreadyClaimedError extends Error {
  constructor() {
    super("Modal QA request is already being processed.");
    this.name = "ModalQaAlreadyClaimedError";
  }
}

export function modalGenerateEndpoint(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid Modal QA endpoint");
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".modal.run") ||
    url.port !== "" ||
    url.username ||
    url.password ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search ||
    url.hash
  ) {
    throw new Error("Modal QA endpoint must be an HTTPS Modal URL");
  }
  return new URL("/generate", url.origin).toString();
}

function unavailable(): HttpError {
  return new HttpError(
    503,
    "qa_modal_unavailable",
    "Modal QA is not available on this backend.",
  );
}

export function modalQaConfigForUser(userId: string): ModalQaConfig {
  if (
    Deno.env.get("QA_MODAL_ENABLED") !== "true" ||
    Deno.env.get("QA_MODAL_ENVIRONMENT") !== "qa"
  ) {
    throw new HttpError(
      403,
      "qa_modal_disabled",
      "Modal QA is not enabled on this backend.",
    );
  }

  const allowedUsers = (Deno.env.get("QA_MODAL_USER_IDS") ?? "")
    .split(",")
    .map((id) => id.trim().toLowerCase())
    .filter(Boolean);
  if (!allowedUsers.includes(userId.toLowerCase())) {
    throw new HttpError(
      403,
      "qa_modal_not_allowed",
      "Modal QA is limited to approved test accounts.",
    );
  }

  const rawEndpoint = Deno.env.get("MODAL_QA_ENDPOINT") ?? "";
  const tokenId = Deno.env.get("MODAL_PROXY_TOKEN_ID") ?? "";
  const tokenSecret = Deno.env.get("MODAL_PROXY_TOKEN_SECRET") ?? "";
  const rawRate = Deno.env.get("QA_MODAL_A100_USD_PER_SECOND") ?? "";
  const gpuUsdPerSecond = Number(rawRate);
  if (
    !rawEndpoint ||
    !tokenId ||
    !tokenSecret ||
    !Number.isFinite(gpuUsdPerSecond) ||
    gpuUsdPerSecond <= 0 ||
    gpuUsdPerSecond > 0.01
  ) {
    throw unavailable();
  }

  try {
    return {
      endpoint: modalGenerateEndpoint(rawEndpoint),
      tokenId,
      tokenSecret,
      gpuUsdPerSecond,
    };
  } catch {
    throw unavailable();
  }
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
}

export function decodeBase64Image(
  value: string,
  maxBytes = MAX_OUTPUT_IMAGE_BYTES,
): Uint8Array {
  if (value.length > Math.ceil(maxBytes * 4 / 3) + 4) {
    throw new Error("Image exceeds the allowed size");
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error("Invalid base64 image");
  }
  if (binary.length === 0 || binary.length > maxBytes) {
    throw new Error("Image exceeds the allowed size");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function readLimitedBody(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error("Image response exceeds the allowed size");
  }
  if (!response.body) throw new Error("Image response has no body");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("Image response exceeds the allowed size");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function fetchImage(url: string): Promise<Uint8Array> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Image fetch failed (HTTP ${response.status})`);
  }
  const bytes = await readLimitedBody(response, MAX_INPUT_IMAGE_BYTES);
  if (bytes.length === 0) throw new Error("Image is empty");
  return bytes;
}

function isPng(bytes: Uint8Array): boolean {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  return signature.every((value, index) => bytes[index] === value);
}

async function readApiJson(
  response: Response,
): Promise<Record<string, unknown>> {
  const bytes = await readLimitedBody(response, MAX_API_RESPONSE_BYTES);
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Modal QA response");
  }
  return value as Record<string, unknown>;
}

export async function runModalQaTryon(input: {
  userId: string;
  renderId: string;
  personImageUrl: string;
  garmentImageUrls: string[];
  claimDispatch: () => Promise<boolean>;
}): Promise<ModalQaResult> {
  const config = modalQaConfigForUser(input.userId);
  if (input.garmentImageUrls.length < 1 || input.garmentImageUrls.length > 2) {
    throw new ModalQaError("Modal QA accepts one or two garments.");
  }

  const [personImage, ...garmentImages] = await Promise.all([
    fetchImage(input.personImageUrl),
    ...input.garmentImageUrls.map(fetchImage),
  ]);
  const totalBytes = personImage.length +
    garmentImages.reduce((sum, image) => sum + image.length, 0);
  if (totalBytes > MAX_TOTAL_INPUT_BYTES) {
    throw new ModalQaError("Modal QA inputs exceed the size limit.");
  }

  const idPart = input.renderId.replaceAll("-", "").slice(0, 8);
  const seed = Number.parseInt(idPart, 16);
  if (!Number.isFinite(seed)) {
    throw new ModalQaError("Invalid render id for Modal QA.");
  }

  if (!(await input.claimDispatch())) throw new ModalQaAlreadyClaimedError();

  const startedAt = Date.now();
  try {
    const response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Modal-Key": config.tokenId,
        "Modal-Secret": config.tokenSecret,
      },
      body: JSON.stringify({
        person_image: encodeBase64(personImage),
        garment_images: garmentImages.map(encodeBase64),
        seed,
      }),
      signal: AbortSignal.timeout(MODAL_REQUEST_TIMEOUT_MS),
    });
    const payload = await readApiJson(response);
    const reportedRuntime = Number(payload.worker_runtime_seconds);
    const workerRuntimeSeconds =
      Number.isFinite(reportedRuntime) && reportedRuntime >= 0
        ? Math.min(reportedRuntime, MAX_MODAL_WORKER_RUNTIME_SECONDS)
        : undefined;

    if (
      !response.ok || payload.ok !== true ||
      typeof payload.image_base64 !== "string"
    ) {
      throw new ModalQaError(
        "Modal QA inference failed.",
        workerRuntimeSeconds ??
          ([400, 413, 503].includes(response.status)
            ? 0
            : MAX_MODAL_WORKER_RUNTIME_SECONDS),
        config.gpuUsdPerSecond,
      );
    }

    const imageBytes = decodeBase64Image(payload.image_base64);
    if (!isPng(imageBytes)) {
      throw new ModalQaError(
        "Modal QA returned an invalid image.",
        workerRuntimeSeconds ?? MAX_MODAL_WORKER_RUNTIME_SECONDS,
        config.gpuUsdPerSecond,
      );
    }
    return {
      imageBytes,
      workerRuntimeSeconds: workerRuntimeSeconds && workerRuntimeSeconds > 0
        ? workerRuntimeSeconds
        : Math.min(
          (Date.now() - startedAt) / 1000,
          MAX_MODAL_WORKER_RUNTIME_SECONDS,
        ),
      gpuUsdPerSecond: config.gpuUsdPerSecond,
    };
  } catch (error) {
    if (error instanceof ModalQaError) throw error;
    throw new ModalQaError(
      "Modal QA request timed out or could not be reached.",
      MAX_MODAL_WORKER_RUNTIME_SECONDS,
      config.gpuUsdPerSecond,
    );
  }
}

export function estimateModalGpuCostUsd(
  runtimeSeconds: number,
  rateUsdPerSecond: number,
): number {
  if (
    !Number.isFinite(runtimeSeconds) ||
    runtimeSeconds <= 0 ||
    !Number.isFinite(rateUsdPerSecond) ||
    rateUsdPerSecond <= 0
  ) return 0;
  const billableSeconds = Math.min(
    runtimeSeconds + STARTUP_RESERVE_SECONDS + SCALE_DOWN_RESERVE_SECONDS,
    MAX_ESTIMATED_BILLABLE_SECONDS,
  );
  return Math.ceil(billableSeconds * rateUsdPerSecond * 100) / 100;
}
