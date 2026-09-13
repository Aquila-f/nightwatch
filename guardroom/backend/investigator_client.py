"""Investigator HTTP boundary. No agent imports or access to its database."""
import copy
import json
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from jsonschema import Draft202012Validator


class InvestigatorUnavailable(Exception):
    pass


class InvestigatorResponseError(Exception):
    def __init__(self, status):
        self.status = status


class InvestigatorClient:
    def __init__(self, url, *, transport=None):
        parsed = urlsplit(url)
        if (parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.query
                or parsed.fragment or parsed.username or parsed.password):
            raise ValueError("INVESTIGATOR_URL must be an HTTP(S) base URL without credentials or query")
        self.client = httpx.AsyncClient(base_url=url.rstrip("/") + "/", timeout=2,
                                       follow_redirects=False, transport=transport)
        schema = json.loads((Path(__file__).resolve().parents[2] / "contracts/schemas/investigator.schema.json").read_text())
        self.validators = {name: Draft202012Validator({"$ref": f"#/$defs/{name}", "$defs": schema["$defs"]})
                           for name in ("State", "EventPage", "DetectionPage", "DetectionDetail")}
        self.last_state = None

    async def close(self):
        await self.client.aclose()

    async def read(self, path, shape, params=None):
        try:
            async with self.client.stream("GET", path, params=params) as response:
                if response.status_code in {404, 409, 422}:
                    raise InvestigatorResponseError(response.status_code)
                response.raise_for_status()
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > 4 * 1024 * 1024:
                        raise ValueError("Investigator response too large")
            value = json.loads(body)
            # Also rejects NaN and Infinity, which Python's JSON decoder otherwise accepts.
            json.dumps(value, allow_nan=False)
            self.validators[shape].validate(value)
            return value
        except InvestigatorResponseError:
            raise
        except Exception as error:
            raise InvestigatorUnavailable("Investigator 目前無法連線或回傳資料不符契約") from error

    async def state(self):
        value = await self.read("v1/state", "State")
        self.last_state = copy.deepcopy(value)
        return value

    async def events(self, after, stream_id, limit=100):
        value = await self.read("v1/events", "EventPage", {"after": after, "stream_id": stream_id, "limit": limit})
        cursors = [row["cursor"] for row in value["items"]]
        if (value["stream_id"] != stream_id or cursors != list(range(after + 1, after + 1 + len(cursors)))
                or value["next_after"] != (cursors[-1] if cursors else after)
                or (value["has_more"] and not cursors)):
            raise InvestigatorUnavailable("Investigator 事件順序或續傳位置不符契約")
        return value
