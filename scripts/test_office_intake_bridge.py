#!/usr/bin/env python3
import json
import os
import sys
import urllib.error
import urllib.request


DEFAULT_URL = "http://127.0.0.1:19000/gateway/intake"


def build_payload() -> dict:
    return {
        "type": "visitor.inquiry.detected",
        "source": "formspree",
        "received_at": "2026-04-27T02:13:02.495Z",
        "category": "other",
        "service": "other",
        "has_email": True,
        "has_company": True,
        "has_phone": True,
        "has_message": True,
        "summary": "Formspree inquiry detected",
        "raw_details_hidden": True,
        "name": "Formspree intake",
        "message": (
            "Formspree inquiry detected "
            "(category=other, service=other, has_email=true, has_company=true, "
            "has_phone=true, has_message=true, raw_details_hidden=true)."
        ),
    }


def main() -> int:
    url = os.environ.get("OFFICE_UI_INTAKE_URL", DEFAULT_URL).strip() or DEFAULT_URL
    payload = build_payload()
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            body = response.read().decode("utf-8", errors="replace")
            print(f"sent=true status_code={response.status} url={url}")
            print(body)
            return 0
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        print(f"sent=false status_code={error.code} url={url}", file=sys.stderr)
        print(body, file=sys.stderr)
        return 1
    except Exception as error:  # noqa: BLE001
        print(f"sent=false error={error} url={url}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
