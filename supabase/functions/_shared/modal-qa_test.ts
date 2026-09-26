import {
  decodeBase64Image,
  encodeBase64,
  estimateModalGpuCostUsd,
  MAX_MODAL_WORKER_RUNTIME_SECONDS,
  modalGenerateEndpoint,
  modalQaConfigForUser,
} from "./modal-qa.ts";

Deno.test("Modal QA only accepts a private HTTPS Modal hostname", () => {
  if (
    modalGenerateEndpoint("https://vai--http-api.modal.run") !==
      "https://vai--http-api.modal.run/generate"
  ) {
    throw new Error("Modal endpoint path was not normalized");
  }
  for (
    const url of [
      "http://vai--http-api.modal.run",
      "https://example.com",
      "https://vai--http-api.modal.run.evil.example",
      "https://vai--http-api.modal.run:8443",
      "https://vai--http-api.modal.run/other",
      "https://user:pass@vai--http-api.modal.run",
    ]
  ) {
    let rejected = false;
    try {
      modalGenerateEndpoint(url);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error(`Unexpectedly accepted ${url}`);
  }
});

Deno.test("Modal QA base64 decoding round-trips bytes and enforces its cap", () => {
  const original = new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]);
  const decoded = decodeBase64Image(encodeBase64(original), original.length);
  if (decoded.some((value, index) => value !== original[index])) {
    throw new Error("Base64 image round-trip changed bytes");
  }
  let rejected = false;
  try {
    decodeBase64Image(encodeBase64(original), original.length - 1);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("Oversized base64 image was accepted");
});

Deno.test("Modal QA config requires the QA environment and an allowlisted user", () => {
  const values: Record<string, string> = {
    QA_MODAL_ENABLED: "true",
    QA_MODAL_ENVIRONMENT: "qa",
    QA_MODAL_USER_IDS: "11111111-1111-4111-8111-111111111111",
    MODAL_QA_ENDPOINT: "https://vai--http-api.modal.run",
    MODAL_PROXY_TOKEN_ID: "test-token-id",
    MODAL_PROXY_TOKEN_SECRET: "test-token-secret",
    QA_MODAL_A100_USD_PER_SECOND: "0.000694",
  };
  const original = new Map(
    Object.keys(values).map((key) => [key, Deno.env.get(key)]),
  );
  try {
    for (const [key, value] of Object.entries(values)) Deno.env.set(key, value);
    modalQaConfigForUser("11111111-1111-4111-8111-111111111111");
    for (
      const [environment, userId] of [
        ["production", "11111111-1111-4111-8111-111111111111"],
        ["qa", "22222222-2222-4222-8222-222222222222"],
      ]
    ) {
      Deno.env.set("QA_MODAL_ENVIRONMENT", environment);
      Deno.env.set("QA_MODAL_USER_IDS", values.QA_MODAL_USER_IDS);
      let rejected = false;
      try {
        modalQaConfigForUser(userId);
      } catch {
        rejected = true;
      }
      if (!rejected) {
        throw new Error("Unapproved Modal QA configuration was accepted");
      }
    }
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
});

Deno.test("Modal QA cost includes cold-start and scale-down reserve", () => {
  if (estimateModalGpuCostUsd(10, 0.000694) !== 0.03) {
    throw new Error(
      "Modal GPU estimate should include startup and scale-down reserve",
    );
  }
  if (estimateModalGpuCostUsd(0, 0.000694) !== 0) {
    throw new Error("A zero-duration request should not accrue GPU cost");
  }
  if (
    estimateModalGpuCostUsd(MAX_MODAL_WORKER_RUNTIME_SECONDS, 0.000694) !== 0.09
  ) {
    throw new Error(
      "Maximum Modal worker runtime should be capped and rounded up",
    );
  }
});
