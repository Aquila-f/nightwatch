"""HTTP adapter for the shared graph contract."""
import json
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from jsonschema import Draft202012Validator
from referencing import Registry, Resource


SCHEMAS = Path(__file__).resolve().parents[2] / "contracts" / "schemas"


def graph_validator():
    resources = []
    for name in ("snapshot", "node", "edge"):
        filename = f"{name}.schema.json"
        resources.append((filename, Resource.from_contents(json.loads((SCHEMAS / filename).read_text()))))
    return Draft202012Validator(json.loads((SCHEMAS / "snapshot.schema.json").read_text()),
                                 registry=Registry().with_resources(resources))


class GraphSource:
    def __init__(self, url: str, client: httpx.AsyncClient):
        parsed = urlsplit(url)
        if (parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.query
                or parsed.fragment or parsed.username or parsed.password):
            raise ValueError("Graph URL must be a live HTTP(S) endpoint without credentials or query")
        self.url, self.client = url, client
        self.validator = graph_validator()

    async def read(self) -> dict:
        async with self.client.stream("GET", self.url) as response:
            response.raise_for_status()
            data = bytearray()
            async for chunk in response.aiter_bytes():
                data.extend(chunk)
                if len(data) > 512 * 1024:
                    raise ValueError("Graph exceeds 512 KiB")
        graph = json.loads(data, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Nonfinite JSON")))
        self.validator.validate(graph)
        ids = [node["id"] for node in graph["nodes"]]
        if any(not node_id for node_id in ids) or len(set(ids)) != len(ids):
            raise ValueError("Graph node identities must be nonempty and unique")
        if any(edge["from"] not in ids or edge["to"] not in ids for edge in graph["edges"]):
            raise ValueError("Graph contains unknown edge endpoints")
        return graph
