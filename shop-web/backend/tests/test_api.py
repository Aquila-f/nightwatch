import json
import os
import sqlite3
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

BASE = os.getenv("TEST_BASE_URL", "http://127.0.0.1:8000")
DB_PATH = os.getenv("TEST_DB_PATH", os.getenv("DB_PATH", "/data/shop.db"))


class ApiTests(unittest.TestCase):
    def request(self, path, payload=None):
        req = Request(BASE + path, data=json.dumps(payload).encode() if payload is not None else None, headers={"Content-Type": "application/json"})
        try:
            with urlopen(req, timeout=5) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            return error.code, json.load(error)

    def checkout(self, items, **kwargs):
        return self.request("/api/orders", {"name": "測試顧客", "address": "台北市測試路 1 號", "items": items, **kwargs})

    def test_health_and_catalog(self):
        self.assertEqual(self.request("/api/health"), (200, {"status": "ok"}))
        status, products = self.request("/api/products")
        self.assertEqual(status, 200)
        self.assertEqual(len(products), 6)

    def test_server_prices_and_duplicate_lines(self):
        status, order = self.checkout([{"product_id": 1, "quantity": 2}, {"product_id": 1, "quantity": 1}])
        self.assertEqual(status, 201)
        self.assertEqual(order["total"], 1440)
        self.assertEqual(len(order["items"]), 1)

    def test_order_is_persisted_with_checkout_details(self):
        status, order = self.checkout(
            [{"product_id": 2, "quantity": 1}],
            name="  持久化顧客  ",
            address="  台北市持久化路 1 號  ",
        )
        self.assertEqual(status, 201)

        # Open a new connection so the assertion covers the transaction commit,
        # rather than observing an uncommitted connection in the API process.
        with sqlite3.connect(DB_PATH) as db:
            row = db.execute(
                "SELECT created_at, payload FROM orders WHERE id = ?",
                (order["id"],),
            ).fetchone()
        self.assertIsNotNone(row)
        created_at, payload = row
        saved = json.loads(payload)
        self.assertEqual(created_at, order["created_at"])
        self.assertEqual(saved["name"], "持久化顧客")
        self.assertEqual(saved["address"], "台北市持久化路 1 號")
        self.assertEqual(saved["total"], 690)
        self.assertEqual(saved["items"], order["items"])

    def test_invalid_orders(self):
        for items, expected in [([], 422), ([{"product_id": 999, "quantity": 1}], 400), ([{"product_id": 1, "quantity": 0}], 422), ([{"product_id": 1, "quantity": 1.5}], 422), ([{"product_id": 1, "quantity": 100}], 422), ([{"product_id": 1, "quantity": 99}, {"product_id": 1, "quantity": 1}], 400), ([{"product_id": 1, "quantity": 1, "price": 1}], 422), ([{"product_id": True, "quantity": 1}], 422), ([{"product_id": 1.0, "quantity": 1}], 422)]:
            with self.subTest(items=items):
                self.assertEqual(self.checkout(items)[0], expected)
        self.assertEqual(self.checkout([{"product_id": 1, "quantity": 1}], name="   ")[0], 422)
        self.assertEqual(self.checkout([{"product_id": 1, "quantity": 1}], address="     ")[0], 422)


if __name__ == "__main__":
    unittest.main()
