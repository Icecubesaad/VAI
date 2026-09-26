"""VAI QA try-on on Modal (Qwen Image Edit 2511) — CLI + web endpoint.

The Supabase `render-tryon` pipeline calls the web endpoint (see
`supabase/functions/_shared/modal-qa.ts`) with proxy-auth headers:

    POST /generate
    Modal-Key / Modal-Secret headers
    {"person_image": <b64>, "garment_images": [<b64>, <b64>?], "seed": <int>}
    → {"ok": true, "image_base64": <png b64>, "worker_runtime_seconds": <num>}

Local CLI usage (same model, one output image):
    modal run scripts/qwen_modal.py \
        --person-image ./person.jpg --garment-images ./dress.webp \
        --out-dir ./.hoplite/artifacts/qwen

Bulk (one person × every garment image in a folder; containers run in
parallel, each amortizing one model load across its batch):
    modal run scripts/qwen_modal.py bulk \
        --person-image ./person.jpg --garments-dir ./dresses \
        --batches 4

Setup: `uv tool install modal && modal setup` (never paste tokens into source).
Model weights cache in a persistent Volume; inputs/outputs are not stored.
"""

import base64
import binascii
import io
import time
from pathlib import Path

import modal


# Qwen Image 2.1 is research-only; Edit-2511 is Apache-2.0 and supports person + product refs.
MODEL_ID = "Qwen/Qwen-Image-Edit-2511"
APP_NAME = "vai-qwen-image-edit-2511"
GPU_TYPE = "A100-80GB"
CACHE_DIR = "/cache"
WIDTH, HEIGHT = 1024, 1536  # 2:3 portrait — keeps runtime inside the 90s QA budget
MAX_INPUT_BYTES = 8 * 1024 * 1024
MAX_TOTAL_BYTES = 16 * 1024 * 1024

app = modal.App(APP_NAME)

cache_image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("huggingface_hub")
    .env({"HF_HOME": CACHE_DIR, "HF_XET_HIGH_PERFORMANCE": "1"})
)

inference_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git")
    .pip_install(
        "torch>=2.4.0",
        "torchvision",
        "transformers>=5.17",
        "accelerate",
        "pillow",
        "huggingface_hub",
        "sentencepiece",
        "protobuf",
        "fastapi",
    )
    .pip_install("https://github.com/huggingface/diffusers/archive/refs/heads/main.tar.gz")
    .env({"HF_HOME": CACHE_DIR, "HF_XET_HIGH_PERFORMANCE": "1"})
)

model_cache = modal.Volume.from_name(
    "vai-qwen-image-edit-2511-cache",
    create_if_missing=True,
)


def _tryon_prompt(garment_count: int) -> str:
    refs = ", ".join(f"image {i}" for i in range(2, garment_count + 2))
    return (
        "Create a photorealistic virtual try-on. Image 1 is the adult person and is the "
        "identity, pose, framing, lighting, and background source. Keep that same person, "
        "face, body proportions, pose, camera angle, and background unchanged. "
        f"Use {refs} only as garment references; dress the person in those exact items, "
        "preserving their colors, cut, pattern, fabric, and details. Do not add other "
        "clothing or accessories."
    )


def _load_pipe():
    import torch
    from diffusers import QwenImageEditPlusPipeline

    model_cache.reload()
    return QwenImageEditPlusPipeline.from_pretrained(
        MODEL_ID,
        torch_dtype=torch.bfloat16,
        cache_dir=CACHE_DIR,
    ).to("cuda")


def _run_pipe(pipe, person: bytes, garments: list[bytes], steps: int, seed: int) -> bytes:
    import torch
    from PIL import Image

    references = [
        Image.open(io.BytesIO(data)).convert("RGB")
        for data in [person, *garments]
    ]
    with torch.inference_mode():
        result = pipe(
            image=references,
            prompt=_tryon_prompt(len(garments)),
            generator=torch.Generator(device="cuda").manual_seed(seed),
            # CFG-free single-pass editing — fits the QA runtime budget.
            true_cfg_scale=1.0,
            num_inference_steps=steps,
            guidance_scale=1.0,
            num_images_per_prompt=1,
            width=WIDTH,
            height=HEIGHT,
        ).images[0]
    output = io.BytesIO()
    result.save(output, format="PNG")
    return output.getvalue()


def _run_pipe_prompt(pipe, person: bytes, garments: list[bytes], prompt: str, steps: int, seed: int) -> bytes:
    import torch
    from PIL import Image

    references = [
        Image.open(io.BytesIO(data)).convert("RGB")
        for data in [person, *garments]
    ]
    with torch.inference_mode():
        result = pipe(
            image=references,
            prompt=prompt,
            generator=torch.Generator(device="cuda").manual_seed(seed),
            true_cfg_scale=1.0,
            num_inference_steps=steps,
            guidance_scale=1.0,
            num_images_per_prompt=1,
            width=WIDTH,
            height=HEIGHT,
        ).images[0]
    output = io.BytesIO()
    result.save(output, format="PNG")
    return output.getvalue()


@app.function(
    image=cache_image,
    volumes={CACHE_DIR: model_cache},
    timeout=15 * 60,
    max_containers=1,
    min_containers=0,
)
def cache_model() -> None:
    from huggingface_hub import snapshot_download

    model_cache.reload()
    snapshot_download(repo_id=MODEL_ID, cache_dir=CACHE_DIR)
    model_cache.commit()


@app.cls(
    image=inference_image,
    gpu=GPU_TYPE,
    volumes={CACHE_DIR: model_cache},
    timeout=15 * 60,
    max_containers=1,
    min_containers=0,
    scaledown_window=240,  # QA window: stay warm between the direct test and app test
)
@modal.concurrent(max_inputs=1)
class VaiTryon:
    @modal.enter()
    def load(self) -> None:
        self.pipe = _load_pipe()

    def _generate(self, person: bytes, garments: list[bytes], steps: int, seed: int) -> bytes:
        return _run_pipe(self.pipe, person, garments, steps, seed)

    @modal.method()
    def generate(
        self,
        person_image: bytes,
        garment_images: list[bytes],
        steps: int = 40,
        seed: int = 42,
    ) -> bytes:
        return self._generate(person_image, garment_images, steps, seed)

    @modal.asgi_app(requires_proxy_auth=True, label="vai-tryon-qa")
    def web(self):
        from fastapi import FastAPI, Request
        from fastapi.responses import JSONResponse

        web = FastAPI()

        @web.post("/generate")
        async def generate_route(request: Request) -> JSONResponse:
            started = time.time()
            try:
                body = await request.json()
                person_b64 = body.get("person_image")
                garment_b64 = body.get("garment_images")
                if not isinstance(person_b64, str) or not isinstance(garment_b64, list):
                    raise ValueError("person_image and garment_images are required")
                if not 1 <= len(garment_b64) <= 2:
                    raise ValueError("Pass one or two garment images.")
                person = base64.b64decode(person_b64, validate=True)
                garments = [base64.b64decode(g, validate=True) for g in garment_b64]
                if not person or len(person) > MAX_INPUT_BYTES:
                    raise ValueError("Person image size is invalid.")
                if any(not g or len(g) > MAX_INPUT_BYTES for g in garments):
                    raise ValueError("Garment image size is invalid.")
                if len(person) + sum(map(len, garments)) > MAX_TOTAL_BYTES:
                    raise ValueError("Total input size exceeds the limit.")
                seed = int(body.get("seed") or 0) & 0x7FFFFFFF
                steps = 24
                png = self._generate(person, garments, steps, seed)
                return JSONResponse(
                    {
                        "ok": True,
                        "image_base64": base64.b64encode(png).decode(),
                        "worker_runtime_seconds": round(time.time() - started, 2),
                    }
                )
            except (ValueError, binascii.Error) as error:
                return JSONResponse(
                    {"ok": False, "error": str(error)}, status_code=400
                )

        return web


@app.function(
    image=inference_image,
    gpu=GPU_TYPE,
    volumes={CACHE_DIR: model_cache},
    timeout=60 * 60,
    min_containers=0,
)
def bulk_batch(
    person_image: bytes,
    garment_images: list[bytes],
    steps: int = 24,
    base_seed: int = 42,
    prompts: list[str] | None = None,
) -> list[bytes]:
    # One model load per container, then sequential generations — the cheap
    # way to batch: load cost is amortized over the whole chunk.
    pipe = _load_pipe()
    if prompts is not None and len(prompts) != len(garment_images):
        raise ValueError("prompts must align with garment_images")
    outputs = []
    for index, garment in enumerate(garment_images):
        if prompts is not None:
            outputs.append(
                _run_pipe_prompt(pipe, person_image, [garment], prompts[index], steps, base_seed + index)
            )
        else:
            outputs.append(_run_pipe(pipe, person_image, [garment], steps, base_seed + index))
    return outputs


@app.local_entrypoint()
def main(
    person_image: str,
    garment_images: str,
    out_dir: str = "./.hoplite/artifacts/qwen",
    steps: int = 40,
    seed: int = 42,
) -> None:
    person_path = Path(person_image)
    garment_paths = [Path(part.strip()) for part in garment_images.split(",") if part.strip()]
    if not person_path.is_file():
        raise FileNotFoundError(f"Person image not found: {person_path}")
    if not 1 <= len(garment_paths) <= 2:
        raise ValueError("Pass one or two comma-separated garment image paths.")
    missing = [path for path in garment_paths if not path.is_file()]
    if missing:
        raise FileNotFoundError(f"Garment image not found: {missing[0]}")

    print(f"Model: {MODEL_ID} | GPU: {GPU_TYPE} | output count: 1")
    cache_model.remote()
    png = VaiTryon().generate.remote(
        person_image=person_path.read_bytes(),
        garment_images=[path.read_bytes() for path in garment_paths],
        steps=steps,
        seed=seed,
    )
    destination = Path(out_dir)
    destination.mkdir(parents=True, exist_ok=True)
    output_path = destination / f"vai_tryon_{time.strftime('%Y%m%d-%H%M%S', time.gmtime())}.png"
    output_path.write_bytes(png)
    print(f"Saved one try-on image: {output_path}")


IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp"}


@app.local_entrypoint()
def bulk(
    person_image: str,
    garments_dir: str,
    out_dir: str = "./.hoplite/artifacts/qwen/bulk",
    steps: int = 24,
    seed: int = 42,
    batches: int = 4,
    limit: int = 0,
) -> None:
    person_path = Path(person_image)
    if not person_path.is_file():
        raise FileNotFoundError(f"Person image not found: {person_path}")
    files = sorted(
        path for path in Path(garments_dir).iterdir()
        if path.suffix.lower() in IMAGE_EXTS
    )
    if limit > 0:
        files = files[:limit]
    if not files:
        raise FileNotFoundError(f"No garment images in: {garments_dir}")

    chunks = [files[index::batches] for index in range(batches)]
    chunks = [chunk for chunk in chunks if chunk]
    person_bytes = person_path.read_bytes()
    print(
        f"Bulk: {len(files)} garments × 1 person | {len(chunks)} parallel "
        f"containers | {steps} steps each | ~75s load + ~55s per image"
    )

    results = list(
        bulk_batch.starmap(
            [
                (person_bytes, [path.read_bytes() for path in chunk], steps, seed)
                for chunk in chunks
            ]
        )
    )

    destination = Path(out_dir)
    destination.mkdir(parents=True, exist_ok=True)
    for chunk, images in zip(chunks, results):
        for path, image in zip(chunk, images):
            out = destination / f"tryon_{path.stem}.png"
            out.write_bytes(image)
            print(f"Saved: {out}")
    print("Bulk complete.")


def _reel_prompt(theme: str) -> str:
    if theme == "cover":
        return (
            "High-fashion magazine cover photograph of this exact person wearing the "
            "garment from image 2. Editorial studio lighting, elegant pose, confident "
            "gaze, large chic masthead text 'VAI' at the top, small cover lines at the "
            "sides. Keep her face, identity, and body exactly as in image 1."
        )
    places = {
        "santorini": "white-washed cliffside terraces of Santorini, Greece at golden hour, blue domes and the Aegean sea behind her",
        "maldives": "a Maldives overwater villa deck at sunrise, turquoise lagoon and wooden walkway behind her",
        "paris": "a quiet Parisian street at dusk with the Eiffel Tower glowing softly in the distance",
        "kyoto": "the vermilion torii gate path of Fushimi Inari in Kyoto in soft morning light",
        "amalfi": "the Amalfi Coast cliff road with pastel villages and the Mediterranean sparkling behind her",
        "alps": "an alpine lake dock in the Swiss Alps with snow-capped peaks mirrored in still water",
        "dubai": "the Dubai Marina skyline at night, illuminated towers reflecting on the water",
        "bali": "a lush Bali jungle swing terrace with rice terraces and palm valley behind her",
    }
    if theme not in places:
        raise ValueError(f"Unknown reel theme: {theme}")
    return (
        f"Full-body editorial fashion photograph of this exact person wearing the "
        f"garment from image 2, striking a new confident pose in front of {places[theme]}. "
        "Keep her face, identity, and body exactly as in image 1. Photorealistic, "
        "golden-hour light, shallow depth of field, magazine-editorial composition."
    )


@app.local_entrypoint()
def reel(
    person_image: str,
    garments_dir: str,
    themes: str = "cover,santorini,maldives,paris,kyoto,amalfi,alps,dubai",
    out_dir: str = "./.hoplite/artifacts/qwen/reel",
    steps: int = 24,
    seed: int = 42,
    batches: int = 4,
) -> None:
    person_path = Path(person_image)
    if not person_path.is_file():
        raise FileNotFoundError(f"Person image not found: {person_path}")
    theme_list = [part.strip() for part in themes.split(",") if part.strip()]
    files = sorted(
        path for path in Path(garments_dir).iterdir()
        if path.suffix.lower() in IMAGE_EXTS
    )
    if not files:
        raise FileNotFoundError(f"No garment images in: {garments_dir}")

    pairs = [(files[index % len(files)], theme) for index, theme in enumerate(theme_list)]
    chunks = [pairs[index::batches] for index in range(batches)]
    chunks = [chunk for chunk in chunks if chunk]
    person_bytes = person_path.read_bytes()
    print(f"Reel: {len(pairs)} images | {len(chunks)} parallel containers")

    results = list(
        bulk_batch.starmap(
            [
                (
                    person_bytes,
                    [path.read_bytes() for path, _ in chunk],
                    steps,
                    seed,
                    [_reel_prompt(theme) for _, theme in chunk],
                )
                for chunk in chunks
            ]
        )
    )

    destination = Path(out_dir)
    destination.mkdir(parents=True, exist_ok=True)
    for chunk, images in zip(chunks, results):
        for (path, theme), image in zip(chunk, images):
            out = destination / f"reel_{theme}_{path.stem}.png"
            out.write_bytes(image)
            print(f"Saved: {out}")
    print("Reel complete.")
