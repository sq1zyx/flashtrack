"""Сборщик FPS-пака для Dota 2.

Заменяет выбранные косметические партиклы пустым партиклом из самой игры,
пакует результат в pak01_dir.vpk и кладёт его в game/dota_<язык>/.

Запуск без аргументов открывает окно с галочками, подробности: --help.
"""
import argparse
import json
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path

try:
    import vpk
except ImportError:
    sys.exit("Нужна библиотека vpk: pip install vpk")

HERE = Path(__file__).resolve().parent
DOTA_DIR_NAME = "dota 2 beta"


def load_config():
    with open(HERE / "mods.json", encoding="utf-8") as f:
        return json.load(f)


def steam_roots():
    roots = []
    if sys.platform == "win32":
        import winreg
        for hive, key in ((winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam"),
                          (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Valve\Steam")):
            try:
                with winreg.OpenKey(hive, key) as k:
                    for name in ("SteamPath", "InstallPath"):
                        try:
                            roots.append(Path(winreg.QueryValueEx(k, name)[0]))
                        except OSError:
                            pass
            except OSError:
                pass
        roots.append(Path(r"C:\Program Files (x86)\Steam"))
    else:
        roots += [Path.home() / ".steam/steam", Path.home() / ".local/share/Steam"]
    return [r for r in roots if r.is_dir()]


def find_dota():
    libraries = []
    for root in steam_roots():
        libraries.append(root)
        vdf = root / "steamapps" / "libraryfolders.vdf"
        if vdf.is_file():
            text = vdf.read_text(encoding="utf-8", errors="ignore")
            for path in re.findall(r'"path"\s+"([^"]+)"', text):
                libraries.append(Path(path.replace("\\\\", "\\")))
    for lib in libraries:
        dota = lib / "steamapps" / "common" / DOTA_DIR_NAME
        if (dota / "game" / "dota" / "pak01_dir.vpk").is_file():
            return dota
    return None


def match_files(pak, mods):
    """Возвращает {id мода: [пути файлов]} для выбранных модов."""
    compiled = {m["id"]: [re.compile(p) for p in m["patterns"]] for m in mods}
    result = {m["id"]: [] for m in mods}
    for path in pak:
        if not path.endswith(".vpcf_c"):
            continue
        for mod_id, patterns in compiled.items():
            if any(p.search(path) for p in patterns):
                result[mod_id].append(path)
    return result


def build(dota, selected_ids, lang, dry_run=False, log=print):
    config = load_config()
    mods = [m for m in config["mods"] if m["id"] in selected_ids]
    if not mods:
        raise ValueError("Не выбрано ни одного мода")

    pak_path = dota / "game" / "dota" / "pak01_dir.vpk"
    log(f"Читаю {pak_path} ...")
    pak = vpk.open(str(pak_path))

    blank_path = next((c for c in config["blank_particle_candidates"] if c in pak), None)
    if blank_path is None:
        raise RuntimeError("Не нашёл пустой партикл в игре. Укажи свой в mods.json → blank_particle_candidates")
    blank_data = pak.get_file(blank_path).read()

    matches = match_files(pak, mods)
    total = 0
    for mod in mods:
        files = [f for f in matches[mod["id"]] if f != blank_path]
        matches[mod["id"]] = files
        total += len(files)
        log(f"  {mod['name']}: {len(files)} файлов")
    if total == 0:
        raise RuntimeError("Ни один файл не подошёл — возможно, Valve переименовала пути после патча")
    if dry_run:
        log("Пробный запуск, ничего не записано.")
        return None

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        for files in matches.values():
            for f in files:
                out = tmp / f
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_bytes(blank_data)
        target_dir = dota / "game" / f"dota_{lang}"
        target_dir.mkdir(exist_ok=True)
        target = target_dir / "pak01_dir.vpk"
        vpk.new(str(tmp)).save(str(target))

    log(f"Готово: {target}")
    log(f"Добавь в параметры запуска Dota 2 в Steam:  -language {lang}")
    return target


def uninstall(dota, lang, log=print):
    target_dir = dota / "game" / f"dota_{lang}"
    target = target_dir / "pak01_dir.vpk"
    if target.is_file():
        target.unlink()
        log(f"Удалён {target}")
    else:
        log("Пак не установлен")
    if target_dir.is_dir() and not any(target_dir.iterdir()):
        shutil.rmtree(target_dir)


SCAN_KEYWORDS = ("terrain", "tree", "grass", "ground", "cliff", "water", "river", "rock", "dirt", "blend")


def scan(dota, out_path, log=print):
    """Сохраняет список файлов ландшафта и деревьев — по нему подбираются пути для замены."""
    pak = vpk.open(str(dota / "game" / "dota" / "pak01_dir.vpk"))
    lines = []
    for path in sorted(pak):
        low = path.lower()
        if low.startswith("maps/") or any(k in low for k in SCAN_KEYWORDS):
            lines.append(f"{path}\t{pak.get_file_meta(path)['file_length']}")
    tools = dota / "game" / "bin" / "win64" / "resourcecompiler.exe"
    header = [f"resourcecompiler: {'есть' if tools.is_file() else 'нет'}", f"files: {len(lines)}", ""]
    Path(out_path).write_text("\n".join(header + lines), encoding="utf-8")
    log(f"Найдено {len(lines)} файлов, список сохранён в {out_path}")


def main():
    config = load_config()
    parser = argparse.ArgumentParser(description="Сборщик FPS-пака для Dota 2")
    parser.add_argument("--dota", type=Path, help=f"путь к папке «{DOTA_DIR_NAME}» (по умолчанию ищется через Steam)")
    parser.add_argument("--lang", default="russian", help="папка dota_<lang> и параметр -language (по умолчанию russian)")
    parser.add_argument("--mods", help="id модов через запятую (по умолчанию все)")
    parser.add_argument("--list", action="store_true", help="показать список модов")
    parser.add_argument("--dry-run", action="store_true", help="только посчитать файлы, ничего не записывать")
    parser.add_argument("--uninstall", action="store_true", help="удалить установленный пак")
    parser.add_argument("--scan", action="store_true", help="сохранить список файлов ландшафта в scan.txt")
    parser.add_argument("--cli", action="store_true", help="без окна, сразу собрать")
    args = parser.parse_args()

    if args.list:
        for m in config["mods"]:
            print(f"{m['id']:18} {m['name']} — {m['description']}")
        return

    dota = args.dota or find_dota()
    if len(sys.argv) == 1:
        import gui
        gui.main(dota)
        return
    if dota is None:
        sys.exit(f"Не нашёл Dota 2, укажи путь: --dota \"D:\\SteamLibrary\\steamapps\\common\\{DOTA_DIR_NAME}\"")

    if args.scan:
        scan(dota, HERE / "scan.txt")
        return
    if args.uninstall:
        uninstall(dota, args.lang)
        return
    ids = args.mods.split(",") if args.mods else [m["id"] for m in config["mods"]]
    try:
        build(dota, ids, args.lang, dry_run=args.dry_run)
    except (ValueError, RuntimeError) as e:
        sys.exit(f"Ошибка: {e}")


if __name__ == "__main__":
    main()
