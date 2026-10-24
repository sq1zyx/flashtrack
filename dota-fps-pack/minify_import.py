"""Подключение готовых модов из открытого проекта Minify (GPL-3.0):
https://github.com/egezenn/dota2-minify

Файлы мода скачиваются с GitHub при сборке и кэшируются в cache/minify.
Поддерживается формат мода: папка files/ (скомпилированные файлы) и blacklist.txt
(пути, которые заменяются пустыми файлами).
"""
import json
import re
import urllib.parse
import urllib.request
from pathlib import Path

REPO = "egezenn/dota2-minify"
BRANCH = "main"
MODS_DIR = "Minify/mods"
BLANKS_DIR = "Minify/bin/blank-files"
CACHE = Path(__file__).resolve().parent / "cache" / "minify"


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "dota-fps-pack"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.read()
    except OSError as e:  # URLError и HTTPError — наследники OSError
        raise RuntimeError(f"не удалось скачать {url}: {e}. Проверь интернет или попробуй через час "
                           "(у GitHub лимит 60 запросов в час)") from e


def _raw_url(path):
    return f"https://raw.githubusercontent.com/{REPO}/{BRANCH}/{urllib.parse.quote(path)}"


def _tree():
    data = json.loads(_get(f"https://api.github.com/repos/{REPO}/git/trees/{BRANCH}?recursive=1"))
    return [(e["path"], e["sha"]) for e in data["tree"] if e["type"] == "blob"]


def fetch(mod_names, log=print):
    """Скачивает моды и пустые файлы-заглушки. Уже скачанные файлы с тем же sha не перекачиваются."""
    log("Получаю список файлов Minify с GitHub ...")
    tree = _tree()
    prefixes = [f"{MODS_DIR}/{name}/" for name in mod_names] + [f"{BLANKS_DIR}/"]
    wanted = [(p, sha) for p, sha in tree if p.startswith(tuple(prefixes))]
    for name in mod_names:
        if not any(p.startswith(f"{MODS_DIR}/{name}/") for p, _ in wanted):
            raise RuntimeError(f"мод «{name}» не найден в Minify — возможно, его переименовали")

    index_file = CACHE / "index.json"
    try:
        index = json.loads(index_file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        index = {}
    todo = [(p, sha) for p, sha in wanted if index.get(p) != sha or not (CACHE / p).is_file()]
    for i, (path, sha) in enumerate(todo, 1):
        out = CACHE / path
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(_get(_raw_url(path)))
        index[path] = sha
        if i % 25 == 0 or i == len(todo):
            log(f"  скачано {i}/{len(todo)}")
            index_file.write_text(json.dumps(index), encoding="utf-8")
    if not todo:
        log("  всё уже в кэше")


def blank_files():
    return {p.suffix: p.read_bytes() for p in (CACHE / BLANKS_DIR).glob("blank.*")}


def _settings(mod_dir):
    try:
        manifest = json.loads((mod_dir / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return {s["key"]: s.get("default") for s in manifest.get("settings", []) if "key" in s}


def _active_lines(lines, settings):
    """Учитывает директивы #if:<ключ> / #endif из manifest.json мода."""
    stack, out = [], []
    for line in lines:
        s = line.strip()
        m = re.match(r"#\s*if:(.+)$", s, re.I)
        if m:
            stack.append((not stack or stack[-1]) and bool(settings.get(m.group(1).strip())))
        elif re.match(r"#\s*endif", s, re.I):
            if stack:
                stack.pop()
        elif not stack or stack[-1]:
            out.append(s)
    return out


def blacklist(mod_name, pak_paths, log=print):
    """Возвращает пути из pak01, которые мод заменяет пустыми файлами."""
    mod_dir = CACHE / MODS_DIR / mod_name
    bl = mod_dir / "blacklist.txt"
    if not bl.is_file():
        return []
    exts = tuple(blank_files())
    include, exclude = [], set()
    for line in _active_lines(bl.read_text(encoding="utf-8").splitlines(), _settings(mod_dir)):
        if not line or line.startswith("#"):
            continue
        if line.startswith(">>"):
            needle = line[2:] + "/"
            include += [p for p in pak_paths if needle in p]
        elif line.startswith("**"):
            rx = re.compile(line[2:])
            include += [p for p in pak_paths if rx.search(p)]
        elif line.startswith("*-"):
            rx = re.compile(line[2:])
            exclude.update(p for p in pak_paths if rx.search(p))
        elif line.startswith("--"):
            exclude.add(line[2:])
        elif line.endswith(exts):
            include.append(line)
    return [p for p in dict.fromkeys(include) if p not in exclude and p.endswith(exts)]


def files_dir(mod_name):
    return CACHE / MODS_DIR / mod_name / "files"
