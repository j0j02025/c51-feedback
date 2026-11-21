"""Build v3/manifest.json from the lesson metadata and the served HTML bytes."""

import hashlib
import json
from pathlib import Path
import re


V3 = Path(__file__).resolve().parents[1]
PAGE = {"id": "c51-feedback-v3", "title": "C51 看课评审 v3"}


def digest(path):
    sha = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            sha.update(chunk)
    return sha.hexdigest()


def build():
    output = V3 / "manifest.json"
    previous = json.loads(output.read_text(encoding="utf-8")) if output.exists() else {}
    data = json.loads((V3 / "lessons.json").read_text(encoding="utf-8"))
    lessons = data["lessons"] if isinstance(data, dict) else data

    listed = {}
    missing = []
    for lesson in lessons:
        file = lesson.get("file")
        if not file and lesson.get("status") == "制作中":
            continue
        if not isinstance(file, str) or not re.fullmatch(r"lessons/[^/\\]+\.html", file):
            raise ValueError(f"无效的课件路径，课号 {lesson.get('no')}: {file!r}")
        if not (V3 / file).is_file():
            missing.append(file)
        if file in listed:
            raise ValueError(f"课件路径重复: {file}")
        listed[file] = lesson

    if missing:
        raise ValueError("课件 HTML 查不到: " + ", ".join(missing))

    # Keep historical variants while their files are still in the served directory.
    # Keep existing order so a content-only edit changes only that lesson's SHA.
    known = {
        item["file"]: item
        for item in previous.get("items", [])
        if isinstance(item.get("file"), str)
        and re.fullmatch(r"lessons/[^/\\]+\.html", item["file"])
        and (V3 / item["file"]).is_file()
    }
    known.update(listed)
    items = [
        {
            "id": Path(file).stem,
            "no": lesson.get("no"),
            "subject": lesson.get("subject"),
            "title": lesson.get("title") or "",
            "file": file,
            "sha": digest(V3 / file),
        }
        for file, lesson in known.items()
    ]
    value = {"page": previous.get("page", PAGE), "items": items}
    rendered = json.dumps(value, ensure_ascii=False, indent=1) + "\n"
    if not output.exists() or output.read_text(encoding="utf-8") != rendered:
        temp = output.with_suffix(".json.tmp")
        temp.write_text(rendered, encoding="utf-8")
        temp.replace(output)
    print(f"{output.name}: {len(items)} 节")


if __name__ == "__main__":
    try:
        build()
    except (OSError, ValueError) as exc:
        raise SystemExit(str(exc))
