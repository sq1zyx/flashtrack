"""Настройки самой Доты: параметры запуска, autoexec.cfg, очистка кэшей."""
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

DOTA_APP_ID = "570"
AUTOEXEC_BEGIN = "// >>> dota-fps-pack"
AUTOEXEC_END = "// <<< dota-fps-pack"


def launch_options(api="vulkan", lang="russian", fps_max=0, novid=True, high=True):
    parts = []
    if api in ("vulkan", "dx11"):
        parts.append(f"-{api}")
    if lang:
        parts.append(f"-language {lang}")
    if novid:
        parts.append("-novid")
    if high:
        parts.append("-high")
    parts.append(f"+fps_max {fps_max}")
    return " ".join(parts)


# --- Минимальный парсер текстового VDF (формат конфигов Steam) ---

def _tokens(text):
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c.isspace():
            i += 1
        elif text.startswith("//", i):
            i = text.find("\n", i) if "\n" in text[i:] else n
        elif c in "{}":
            yield c
            i += 1
        elif c == '"':
            j, buf = i + 1, []
            while j < n and text[j] != '"':
                if text[j] == "\\" and j + 1 < n:
                    buf.append(text[j:j + 2])
                    j += 2
                else:
                    buf.append(text[j])
                    j += 1
            yield ("s", "".join(buf))
            i = j + 1
        else:
            j = i
            while j < n and not text[j].isspace() and text[j] not in '{}"':
                j += 1
            yield ("s", text[i:j])
            i = j


def vdf_loads(text):
    """Возвращает список пар [ключ, значение], значение — строка или такой же список."""
    stack = [[]]
    key = None
    for tok in _tokens(text):
        if tok == "{":
            child = []
            stack[-1].append([key, child])
            stack.append(child)
            key = None
        elif tok == "}":
            stack.pop()
        elif key is None:
            key = tok[1]
        else:
            stack[-1].append([key, tok[1]])
            key = None
    return stack[0]


def vdf_dumps(pairs, depth=0):
    out, pad = [], "\t" * depth
    for k, v in pairs:
        if isinstance(v, list):
            out.append(f'{pad}"{k}"\n{pad}{{\n{vdf_dumps(v, depth + 1)}{pad}}}\n')
        else:
            out.append(f'{pad}"{k}"\t\t"{v}"\n')
    return "".join(out)


def _child(pairs, key, create=False):
    for k, v in pairs:
        if k.lower() == key.lower() and isinstance(v, list):
            return v
    if create:
        node = []
        pairs.append([key, node])
        return node
    return None


def steam_running():
    if sys.platform != "win32":
        return False
    out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq steam.exe"], capture_output=True, text=True).stdout
    return "steam.exe" in out.lower()


def write_steam_launch_options(steam_roots, options, log=print):
    """Прописывает параметры запуска Доты во все локальные конфиги Steam. Steam должен быть закрыт."""
    if steam_running():
        raise RuntimeError("закрой Steam полностью (в трее тоже), иначе он перезапишет настройки")
    escaped = options.replace("\\", "\\\\").replace('"', '\\"')
    done = 0
    for root in steam_roots:
        for cfg in (root / "userdata").glob("*/config/localconfig.vdf"):
            data = vdf_loads(cfg.read_text(encoding="utf-8", errors="ignore"))
            node = data
            for key in ("UserLocalConfigStore", "Software", "Valve", "Steam", "apps"):
                node = _child(node, key, create=key == "apps")
                if node is None:
                    break
            if node is None:
                continue
            app = _child(node, DOTA_APP_ID, create=True)
            for pair in app:
                if pair[0].lower() == "launchoptions":
                    pair[1] = escaped
                    break
            else:
                app.append(["LaunchOptions", escaped])
            shutil.copy2(cfg, cfg.with_name("localconfig.vdf.bak"))
            cfg.write_text(vdf_dumps(data), encoding="utf-8")
            log(f"Записано: {cfg}")
            done += 1
    if not done:
        raise RuntimeError("не нашёл localconfig.vdf — вставь параметры в Steam вручную")


# --- autoexec.cfg ---

def autoexec_commands(fps_max=0, no_portrait=True, no_embers=True):
    cmds = [f"fps_max {fps_max}"]
    if no_portrait:
        cmds.append("dota_portrait_animate 0")
    if no_embers:
        cmds.append("dota_embers 0")
    return cmds


def write_autoexec(dota, commands, log=print):
    """Пишет свой блок в autoexec.cfg, не трогая строки, которые там уже были."""
    cfg = dota / "game" / "dota" / "cfg" / "autoexec.cfg"
    cfg.parent.mkdir(parents=True, exist_ok=True)
    text = cfg.read_text(encoding="utf-8", errors="ignore") if cfg.is_file() else ""
    text = re.sub(rf"{re.escape(AUTOEXEC_BEGIN)}.*?{re.escape(AUTOEXEC_END)}\n?", "", text, flags=re.S)
    if commands:
        block = "\n".join([AUTOEXEC_BEGIN, *commands, AUTOEXEC_END]) + "\n"
        text = text.rstrip("\n") + ("\n" if text.strip() else "") + block
    cfg.write_text(text, encoding="utf-8")
    log(f"autoexec.cfg обновлён: {cfg}")


# --- Кэши ---

def shader_cache_dirs(steam_roots):
    local = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    dirs = [local / "NVIDIA" / "DXCache", local / "NVIDIA" / "GLCache", local / "D3DSCache",
            local / "AMD" / "DxCache", local / "AMD" / "DxcCache", local / "AMD" / "VkCache"]
    dirs += [root / "steamapps" / "shadercache" / DOTA_APP_ID for root in steam_roots]
    return [d for d in dirs if d.is_dir()]


def clear_dirs(dirs, log=print):
    freed = 0
    for d in dirs:
        for item in d.iterdir():
            try:
                size = item.stat().st_size if item.is_file() else sum(
                    f.stat().st_size for f in item.rglob("*") if f.is_file())
                shutil.rmtree(item) if item.is_dir() else item.unlink()
                freed += size
            except OSError:
                pass  # файл занят — пропускаем
        log(f"Очищено: {d}")
    log(f"Освобождено ~{freed // (1024 * 1024)} МБ. Первый запуск игры может немного подлагивать, пока кэш собирается заново.")


def flush_dns(log=print):
    r = subprocess.run(["ipconfig", "/flushdns"], capture_output=True, text=True)
    log("DNS-кэш сброшен" if r.returncode == 0 else "Не удалось сбросить DNS-кэш")
