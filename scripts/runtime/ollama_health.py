#!/usr/bin/env python3
from __future__ import annotations

import os
import urllib.error
import urllib.request

DEFAULT_OLLAMA_URL = "http://192.168.11.11:11434"
DEFAULT_OLLAMA_TIMEOUT = float(os.environ.get("OLLAMA_HEALTH_TIMEOUT", "3"))


def resolve_ollama_base_url() -> str:
    configured = (
        os.environ.get("OLLAMA_URL")
        or os.environ.get("OLLAMA_BASE_URL")
        or os.environ.get("OLLAMA_HOST")
        or DEFAULT_OLLAMA_URL
    )
    return configured.rstrip("/")


def check_ollama_health(timeout: float = DEFAULT_OLLAMA_TIMEOUT) -> dict:
    url = f"{resolve_ollama_base_url()}/api/tags"
    try:
        request = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return {"online": True, "url": url, "detail": f"HTTP {response.status}"}
    except urllib.error.HTTPError as exc:
        return {"online": False, "url": url, "detail": f"HTTP {exc.code}"}
    except urllib.error.URLError as exc:
        return {"online": False, "url": url, "detail": str(exc.reason)}
    except OSError as exc:
        return {"online": False, "url": url, "detail": str(exc)}
