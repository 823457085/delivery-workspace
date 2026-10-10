#!/usr/bin/env python3
"""Wrap Markdown in Confluence storage format (markdown macro)."""
import sys
import uuid
from pathlib import Path


def markdown_to_storage(md: str) -> str:
    # CDATA cannot contain ]]> — split if present
    safe = md.replace("]]>", "]]]]><![CDATA[>")
    macro_id = str(uuid.uuid4())
    return (
        f'<ac:structured-macro ac:name="markdown" ac:schema-version="1" '
        f'ac:macro-id="{macro_id}">'
        f"<ac:plain-text-body><![CDATA[{safe}]]></ac:plain-text-body>"
        f"</ac:structured-macro><p><br /></p>"
    )


def main() -> None:
    if len(sys.argv) != 2:
        print("Usage: build-confluence-storage.py <markdown-file>", file=sys.stderr)
        sys.exit(1)
    path = Path(sys.argv[1])
    md = path.read_text(encoding="utf-8")
    sys.stdout.write(markdown_to_storage(md))


if __name__ == "__main__":
    main()
