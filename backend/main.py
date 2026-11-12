import base64
import io
import logging
import os
import re
import time
from contextlib import asynccontextmanager
from pathlib import Path

import cv2
import numpy as np
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from PIL import Image
from ultralytics import YOLO

# ---------------------------------------------------------------------------
# Configuração de logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger("sentinela")

# ---------------------------------------------------------------------------
# Caminhos e constantes
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent.parent
MODEL_PATH = BASE_DIR / "best.pt"

MAX_IMAGE_BYTES = 10 * 1024 * 1024   # 10 MB
MAX_SIDE_PX = 1920                    # redimensiona se maior
MAX_DETECTIONS = 100                  # limite de detecções por imagem
JPEG_QUALITY = 88

REQUIRED_EPIS = {
    "capacete":            ["capacete", "helmet", "hardhat", "hard-hat", "hard_hat"],
    "oculos":              ["oculos", "óculos", "goggles", "glasses", "safety-glasses"],
    "luvas":               ["luva", "luvas", "gloves", "glove"],
    "mascara":             ["mascara", "máscara", "mask", "face-mask"],
    "bota":                ["bota", "botas", "boots", "boot", "safety-boot"],
    "colete":              ["colete", "vest", "safety-vest", "hi-vis"],
    "protetor_auricular":  ["protetor", "ear", "earmuff", "earplug"],
}

# Cores fixas por estado (BGR, usado pelo OpenCV)
#   present = azul (EPI identificado) · absent = vermelho (classe "no-*")
STATE_COLORS = {
    "present": (235, 99, 37),    # #2563eb
    "absent":  (38, 38, 220),    # #dc2626
}

# ---------------------------------------------------------------------------
# Estado global (carregado no lifespan)
# ---------------------------------------------------------------------------
_model: YOLO | None = None
_class_names: dict[int, str] = {}
_start_time: float = 0.0


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _model, _class_names, _start_time
    logger.info("Carregando modelo de %s…", MODEL_PATH)
    if not MODEL_PATH.exists():
        raise RuntimeError(f"Arquivo best.pt não encontrado em {MODEL_PATH}")
    _model = YOLO(str(MODEL_PATH))
    _class_names = (
        _model.names
        if isinstance(_model.names, dict)
        else {i: n for i, n in enumerate(_model.names)}
    )
    _start_time = time.monotonic()
    logger.info("Modelo carregado. Classes: %s", list(_class_names.values()))
    yield
    logger.info("Desligando — modelo liberado.")
    _model = None


# ---------------------------------------------------------------------------
# Aplicação
# ---------------------------------------------------------------------------
_allowed_origins = os.getenv("ALLOWED_ORIGINS", "*").split(",")

app = FastAPI(title="EPI Vision API", version="1.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Utilitários
# ---------------------------------------------------------------------------
def normalize(label: str) -> str:
    return label.lower().replace(" ", "").replace("-", "").replace("_", "")


_ABSENT_PREFIX = re.compile(r"^(no|sem|without)[\s_\-]+(.+)$", re.IGNORECASE)


def classify_epi(label: str) -> tuple[str | None, str]:
    """Retorna (categoria do checklist, estado).

    estado = "absent" para classes de ausência ("no-helmet", "sem capacete"…)
    e "present" nos demais casos.
    """
    state = "present"
    m = _ABSENT_PREFIX.match(label.strip())
    if m:
        state, label = "absent", m.group(2)
    norm = normalize(label)
    for key, aliases in REQUIRED_EPIS.items():
        for alias in aliases:
            if normalize(alias) in norm or norm in normalize(alias):
                return key, state
    return None, state


def resize_if_large(img: np.ndarray) -> np.ndarray:
    """Redimensiona para MAX_SIDE_PX no lado maior (mantém proporção)."""
    h, w = img.shape[:2]
    max_side = max(h, w)
    if max_side <= MAX_SIDE_PX:
        return img
    scale = MAX_SIDE_PX / max_side
    new_w, new_h = int(w * scale), int(h * scale)
    return cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)


def encode_jpeg(image_rgb: np.ndarray, quality: int = JPEG_QUALITY) -> str:
    """Converte array RGB para JPEG base64."""
    pil = Image.fromarray(image_rgb)
    buf = io.BytesIO()
    pil.save(buf, format="JPEG", quality=quality)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def draw_detections(image: np.ndarray, detections: list[dict]) -> np.ndarray:
    output = image.copy()
    h, w = output.shape[:2]
    thickness = max(2, int(min(w, h) * 0.003))
    font_scale = max(0.5, min(w, h) * 0.0009)

    for det in detections:
        x1, y1, x2, y2 = map(int, det["box"])
        color = STATE_COLORS[det["state"]]
        label = f"{det['label']} {det['confidence'] * 100:.0f}%"

        cv2.rectangle(output, (x1, y1), (x2, y2), color, thickness)

        (text_w, text_h), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_DUPLEX, font_scale, 1)
        pad = 6
        bg_y1 = max(0, y1 - text_h - pad * 2)
        bg_x2 = min(w, x1 + text_w + pad * 2)

        overlay = output.copy()
        cv2.rectangle(overlay, (x1, bg_y1), (bg_x2, y1), color, -1)
        cv2.addWeighted(overlay, 0.85, output, 0.15, 0, output)

        cv2.putText(
            output, label,
            (x1 + pad, y1 - pad),
            cv2.FONT_HERSHEY_DUPLEX, font_scale,
            (255, 255, 255), 1, cv2.LINE_AA,
        )

    return output


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@app.get("/")
def root():
    return {
        "name": "EPI Vision API",
        "version": "1.1.0",
        "docs": "/docs",
        "endpoints": ["/api/health", "/api/classes", "/api/analyze"],
    }


@app.get("/api/health")
def health():
    uptime = round(time.monotonic() - _start_time, 1) if _start_time else 0
    return {
        "status": "ok",
        "model": str(MODEL_PATH.name),
        "model_path": str(MODEL_PATH),
        "classes": list(_class_names.values()),
        "uptime_s": uptime,
    }


@app.get("/api/classes")
def classes():
    items = [
        {"id": int(cid), "name": name, **dict(zip(("category", "state"), classify_epi(name)))}
        for cid, name in _class_names.items()
    ]
    return {"classes": items, "required_epis": list(REQUIRED_EPIS.keys())}


@app.post("/api/analyze")
async def analyze(
    file: UploadFile = File(...),
    confidence: float = 0.35,
):
    # Validação de tipo
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="O arquivo precisa ser uma imagem.")

    raw = await file.read()

    # Validação de tamanho
    if len(raw) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Imagem acima de 10 MB.")

    # Decodificação
    try:
        pil_image = Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Imagem inválida: {exc}")

    orig_w, orig_h = pil_image.width, pil_image.height

    # BGR para OpenCV + redimensionamento opcional
    image_bgr = cv2.cvtColor(np.array(pil_image), cv2.COLOR_RGB2BGR)
    image_bgr = resize_if_large(image_bgr)

    # Inferência
    start = time.perf_counter()
    results = _model.predict(source=image_bgr, conf=confidence, verbose=False)
    elapsed_ms = (time.perf_counter() - start) * 1000

    detections: list[dict] = []
    summary: dict[str, int] = {}
    present_conf: dict[str, float] = {}
    absent_conf: dict[str, float] = {}

    for result in results:
        if result.boxes is None:
            continue
        boxes = result.boxes
        for i in range(min(len(boxes), MAX_DETECTIONS)):
            class_id = int(boxes.cls[i].item())
            label = _class_names.get(class_id, f"classe_{class_id}")
            conf = float(boxes.conf[i].item())
            xyxy = boxes.xyxy[i].tolist()
            category, state = classify_epi(label)

            detections.append({
                "class_id": class_id,
                "label": label,
                "category": category,
                "state": state,
                "confidence": round(conf, 4),
                "box": [round(v, 1) for v in xyxy],
            })
            summary[label] = summary.get(label, 0) + 1
            if category:
                bucket = present_conf if state == "present" else absent_conf
                bucket[category] = max(bucket.get(category, 0.0), conf)

    # Imagem anotada
    annotated_bgr = draw_detections(image_bgr, detections)
    annotated_rgb = cv2.cvtColor(annotated_bgr, cv2.COLOR_BGR2RGB)
    annotated_b64 = encode_jpeg(annotated_rgb)

    # Conformidade
    # Estado por EPI: identificado (azul) · ausente (vermelho) · indeterminado (cinza)
    items: dict[str, str] = {}
    for c in REQUIRED_EPIS:
        p, a = present_conf.get(c), absent_conf.get(c)
        if p is not None and (a is None or p >= a):
            items[c] = "present"
        elif a is not None:
            items[c] = "absent"
        else:
            items[c] = "unknown"

    detected_required = [c for c, st in items.items() if st == "present"]
    missing_required  = [c for c, st in items.items() if st != "present"]

    if not detections:
        compliance_score = 0
        status = "nenhum_epi"
    elif not missing_required:
        compliance_score = 100
        status = "conforme"
    else:
        compliance_score = round((len(detected_required) / len(REQUIRED_EPIS)) * 100)
        status = "parcial" if detected_required else "nao_conforme"

    avg_conf = (
        sum(d["confidence"] for d in detections) / len(detections)
        if detections else 0
    )

    logger.info(
        "analyze: %d detecções, score=%d, tempo=%.1f ms",
        len(detections), compliance_score, elapsed_ms,
    )

    return JSONResponse({
        "detections": detections,
        "summary": summary,
        "annotated_image": f"data:image/jpeg;base64,{annotated_b64}",
        "image_size": {"width": orig_w, "height": orig_h},
        "processing_time_ms": round(elapsed_ms, 2),
        "average_confidence": round(avg_conf, 4),
        "compliance": {
            "score": compliance_score,
            "status": status,
            "detected": detected_required,
            "missing": missing_required,
            "items": items,
            "required": list(REQUIRED_EPIS.keys()),
        },
    })
