#!/usr/bin/env python3
"""Publish a Markdown file to Confluence using the Confluence Markdown macro."""

import json
import os
import ssl
import sys
import urllib.error
import urllib.request


def usage() -> None:
    print("Usage: publish-confluence-markdown.py <page_id> <markdown_file>", file=sys.stderr)


def get_env(name: str, default: str = "") -> str:
    value = os.environ.get(name, default)
    return value.strip() if value else ""


def request_json(url: str, token: str, method: str = "GET", payload: dict | None = None) -> dict:
    data = None
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("Authorization", f"Bearer {token}")
    request.add_header("Content-Type", "application/json; charset=utf-8")

    context = ssl.create_default_context()
    if get_env("CONFLUENCE_INSECURE_SKIP_VERIFY").lower() == "true":
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE

    try:
        with urllib.request.urlopen(request, context=context) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Confluence API failed: {exc.code} {body}") from exc


def markdown_macro(markdown: str) -> str:
    escaped = markdown.replace("]]>", "]]]]><![CDATA[>")
    return (
        '<ac:structured-macro ac:name="markdown" ac:schema-version="1">\n'
        f"<ac:plain-text-body><![CDATA[{escaped}]]></ac:plain-text-body>\n"
        "</ac:structured-macro>"
    )


def main() -> int:
    if len(sys.argv) != 3:
        usage()
        return 2

    page_id = sys.argv[1]
    markdown_file = sys.argv[2]
    base_url = get_env("CONFLUENCE_BASE_URL").rstrip("/")
    if not base_url.startswith("https://"):
        print("Set CONFLUENCE_BASE_URL to your own HTTPS Confluence site.", file=sys.stderr)
        return 2
    token = get_env("CONFLUENCE_PAT") or get_env("CONFLUENCE_TOKEN")

    if not token:
        print("Missing CONFLUENCE_PAT or CONFLUENCE_TOKEN.", file=sys.stderr)
        return 2

    with open(markdown_file, "r", encoding="utf-8") as file:
        markdown = file.read()

    page = request_json(f"{base_url}/rest/api/content/{page_id}?expand=version", token)
    title = page["title"]
    next_version = int(page["version"]["number"]) + 1

    payload = {
        "id": page_id,
        "type": "page",
        "title": title,
        "body": {
            "storage": {
                "value": markdown_macro(markdown),
                "representation": "storage",
            }
        },
        "version": {"number": next_version},
    }

    result = request_json(f"{base_url}/rest/api/content/{page_id}", token, method="PUT", payload=payload)
    webui = result.get("_links", {}).get("webui", "")
    print(json.dumps({
        "page_id": page_id,
        "title": title,
        "version": result.get("version", {}).get("number", next_version),
        "url": f"{base_url}{webui}" if webui else "",
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
