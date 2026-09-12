import json
import os
import sqlite3
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator

PRODUCTS = [
    dict(id=1, name="晨光陶瓷杯", category="居家生活", price=480, icon="☕", color="#e8d9c5", description="溫潤霧面釉色，盛裝每個美好的早晨。"),
    dict(id=2, name="日常帆布托特包", category="隨身好物", price=690, icon="👜", color="#dbe3d4", description="厚磅純棉、大容量，帶著喜歡的生活出門。"),
    dict(id=3, name="木質香氛蠟燭", category="居家生活", price=880, icon="🕯️", color="#ead9d3", description="雪松與佛手柑，為夜晚留一點安靜。"),
    dict(id=4, name="靈感方格筆記本", category="文具選物", price=320, icon="📓", color="#d5dedf", description="平攤裝訂與細緻紙張，收集生活的小靈感。"),
    dict(id=5, name="輕旅保溫水瓶", category="隨身好物", price=780, icon="🥤", color="#e5dfcd", description="輕巧不鏽鋼瓶身，剛剛好的隨行陪伴。"),
    dict(id=6, name="桌上綠意盆栽", category="居家生活", price=560, icon="🪴", color="#d9e3d7", description="一抹自然綠意，讓工作桌也能深呼吸。"),
]
CATALOG = {p["id"]: p for p in PRODUCTS}
DEFAULT_DB_PATH = "/data/shop.db"
CREATE_ORDERS_TABLE = """
CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    payload TEXT NOT NULL
)
"""


def database_path() -> Path:
    """Return the configured SQLite path and fail clearly for bad configuration."""
    configured = os.getenv("DB_PATH", DEFAULT_DB_PATH).strip()
    if not configured:
        raise RuntimeError("DB_PATH must point to a SQLite database file")
    return Path(configured)


def connect():
    path = database_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    return sqlite3.connect(path, timeout=10)


def init_db():
    with connect() as db:
        db.execute(CREATE_ORDERS_TABLE)


def persist_order(order, checkout):
    """Store the complete order, including checkout details, before returning success."""
    payload = {**order, "name": checkout.name, "address": checkout.address}
    with connect() as db:
        db.execute(
            "INSERT INTO orders (id, created_at, payload) VALUES (?, ?, ?)",
            (order["id"], order["created_at"], json.dumps(payload, ensure_ascii=False)),
        )


@asynccontextmanager
async def lifespan(app):
    init_db()
    yield


app = FastAPI(title="日日選物 API", lifespan=lifespan)


class Item(BaseModel):
    model_config = ConfigDict(extra="forbid")
    product_id: int = Field(strict=True, gt=0)
    quantity: int = Field(strict=True, ge=1, le=99)


class Checkout(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=80)
    address: str = Field(min_length=5, max_length=300)
    items: list[Item] = Field(min_length=1, max_length=50)

    @field_validator("name", "address", mode="before")
    @classmethod
    def strip_text(cls, value):
        return value.strip() if isinstance(value, str) else value


@app.get("/api/health")
def health():
    with connect() as db:
        db.execute("SELECT 1 FROM orders LIMIT 1")
    return {"status": "ok"}


@app.get("/api/products")
def products():
    return PRODUCTS


@app.post("/api/orders", status_code=201)
def create_order(checkout: Checkout):
    quantities = {}
    for item in checkout.items:
        if item.product_id not in CATALOG:
            raise HTTPException(400, "商品不存在，請重新整理商品列表。")
        quantities[item.product_id] = quantities.get(item.product_id, 0) + item.quantity
        if quantities[item.product_id] > 99:
            raise HTTPException(400, "每件商品最多可購買 99 件。")
    lines = [dict(product_id=pid, name=CATALOG[pid]["name"], price=CATALOG[pid]["price"], quantity=qty) for pid, qty in quantities.items()]
    total = sum(line["price"] * line["quantity"] for line in lines)
    order = dict(id=uuid4().hex, created_at=datetime.now(timezone.utc).isoformat(), total=total, items=lines)
    persist_order(order, checkout)
    return order
