"""Твики Windows для Доты. Каждый твик можно включить и откатить:
прежние значения сохраняются в backup.json рядом со скриптом."""
import ctypes
import json
import re
import subprocess
import sys
from pathlib import Path

IS_WINDOWS = sys.platform == "win32"
if IS_WINDOWS:
    import winreg

HERE = Path(__file__).resolve().parent
BACKUP = HERE / "backup.json"
HIGH_PERF_PLAN = "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c"
IFEO = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\dota2.exe\PerfOptions"


def is_admin():
    if not IS_WINDOWS:
        return False
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except OSError:
        return False


def relaunch_as_admin():
    script = str(HERE / "build_pack.py")
    ctypes.windll.shell32.ShellExecuteW(None, "runas", sys.executable, f'"{script}"', str(HERE), 1)


def _load_backup():
    try:
        return json.loads(BACKUP.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _save_backup(data):
    BACKUP.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _hive(name):
    return {"HKCU": winreg.HKEY_CURRENT_USER, "HKLM": winreg.HKEY_LOCAL_MACHINE}[name]


def _reg_read(hive, key, name):
    try:
        with winreg.OpenKey(_hive(hive), key) as k:
            value, kind = winreg.QueryValueEx(k, name)
            return [value, kind]
    except OSError:
        return None


def _reg_write(hive, key, name, kind, value):
    with winreg.CreateKeyEx(_hive(hive), key, 0, winreg.KEY_SET_VALUE) as k:
        winreg.SetValueEx(k, name, 0, kind, value)


def _reg_delete(hive, key, name):
    try:
        with winreg.OpenKey(_hive(hive), key, 0, winreg.KEY_SET_VALUE) as k:
            winreg.DeleteValue(k, name)
    except OSError:
        pass


class RegistryTweak:
    """values: [(hive, key, name, kind, value)], kind: 'dword' или 'sz'."""

    def __init__(self, id, name, desc, values, admin=False, note=""):
        self.id, self.name, self.desc, self.admin, self.note = id, name, desc, admin, note
        self._values = values

    def values(self, dota):
        return self._values(dota) if callable(self._values) else self._values

    def _kind(self, kind):
        return winreg.REG_DWORD if kind == "dword" else winreg.REG_SZ

    def is_applied(self, dota):
        vals = self.values(dota)
        return bool(vals) and all((_reg_read(h, k, n) or [None])[0] == v for h, k, n, _, v in vals)

    def apply(self, dota):
        vals = self.values(dota)
        if not vals:
            raise RuntimeError("не найдена папка Доты")
        backup = _load_backup()
        saved = backup.setdefault(self.id, {})
        for h, k, n, kind, v in vals:
            saved.setdefault(f"{h}\\{k}\\{n}", _reg_read(h, k, n))
        _save_backup(backup)
        for h, k, n, kind, v in vals:
            _reg_write(h, k, n, self._kind(kind), v)

    def revert(self, dota):
        saved = _load_backup().get(self.id, {})
        for h, k, n, kind, v in self.values(dota):
            old = saved.get(f"{h}\\{k}\\{n}")
            if old is None:
                _reg_delete(h, k, n)
            else:
                _reg_write(h, k, n, old[1], old[0])
        backup = _load_backup()
        backup.pop(self.id, None)
        _save_backup(backup)


class PowerPlanTweak:
    id, name, admin, note = "power_plan", "Схема питания «Высокая производительность»", False, ""
    desc = "Процессор не сбрасывает частоты во время игры. На ноутбуке лучше играть от сети."

    def _active(self):
        out = subprocess.run(["powercfg", "/getactivescheme"], capture_output=True, text=True).stdout
        m = re.search(r"[0-9a-fA-F-]{36}", out)
        return m.group(0).lower() if m else None

    def is_applied(self, dota):
        return self._active() == HIGH_PERF_PLAN

    def apply(self, dota):
        backup = _load_backup()
        backup.setdefault(self.id, self._active())
        _save_backup(backup)
        r = subprocess.run(["powercfg", "/setactive", HIGH_PERF_PLAN], capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError("схема недоступна на этом ПК (часто на ноутбуках с Modern Standby)")

    def revert(self, dota):
        backup = _load_backup()
        old = backup.pop(self.id, None) or "381b4222-f694-41f0-9685-ff5bb260df2e"  # «Сбалансированная»
        subprocess.run(["powercfg", "/setactive", old], capture_output=True)
        _save_backup(backup)


def _dota_exe(dota):
    return str(dota / "game" / "bin" / "win64" / "dota2.exe") if dota else None


TWEAKS = [
    PowerPlanTweak(),
    RegistryTweak(
        "game_mode", "Игровой режим Windows",
        "Windows отдаёт приоритет игре и не ставит обновления во время матча.",
        [("HKCU", r"Software\Microsoft\GameBar", "AutoGameModeEnabled", "dword", 1),
         ("HKCU", r"Software\Microsoft\GameBar", "AllowAutoGameMode", "dword", 1)]),
    RegistryTweak(
        "game_dvr_off", "Отключить Xbox Game Bar и фоновую запись",
        "Фоновая запись видео ест FPS и добавляет задержку.",
        [("HKCU", r"System\GameConfigStore", "GameDVR_Enabled", "dword", 0),
         ("HKCU", r"Software\Microsoft\Windows\CurrentVersion\GameDVR", "AppCaptureEnabled", "dword", 0)]),
    RegistryTweak(
        "gpu_high_perf", "Дота на мощной видеокарте",
        "На ноутбуках с двумя GPU заставляет Доту работать на дискретной видеокарте.",
        lambda d: [("HKCU", r"Software\Microsoft\DirectX\UserGpuPreferences", _dota_exe(d), "sz",
                    "GpuPreference=2;")] if d else []),
    RegistryTweak(
        "cpu_priority", "Высокий приоритет процесса Доты",
        "dota2.exe всегда запускается с высоким приоритетом процессора.",
        [("HKLM", IFEO, "CpuPriorityClass", "dword", 3)], admin=True),
    RegistryTweak(
        "hags", "Аппаратное планирование GPU (HAGS)",
        "Снижает задержку кадра на видеокартах GTX 10xx / RX 5000 и новее.",
        [("HKLM", r"SYSTEM\CurrentControlSet\Control\GraphicsDrivers", "HwSchMode", "dword", 2)],
        admin=True, note="нужна перезагрузка"),
    RegistryTweak(
        "mouse_accel_off", "Отключить акселерацию мыши",
        "Курсор двигается ровно на столько, на сколько ты двигаешь мышь.",
        [("HKCU", r"Control Panel\Mouse", "MouseSpeed", "sz", "0"),
         ("HKCU", r"Control Panel\Mouse", "MouseThreshold1", "sz", "0"),
         ("HKCU", r"Control Panel\Mouse", "MouseThreshold2", "sz", "0")],
        note="нужен перезаход в Windows"),
    RegistryTweak(
        "fso_off", "Отключить оптимизацию во весь экран",
        "Иногда снижает задержку в полноэкранном режиме, иногда нет. Проверь на себе.",
        lambda d: [("HKCU", r"Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers",
                    _dota_exe(d), "sz", "~ DISABLEDXMAXIMIZEDWINDOWEDMODE")] if d else []),
    RegistryTweak(
        "net_throttling_off", "Отключить сетевой троттлинг",
        "Windows перестаёт урезать сеть во время воспроизведения звука. Эффект небольшой.",
        [("HKLM", r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile",
          "NetworkThrottlingIndex", "dword", 0xFFFFFFFF),
         ("HKLM", r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile",
          "SystemResponsiveness", "dword", 10)], admin=True),
]


def revert_all(dota, log=print):
    for t in TWEAKS:
        if t.id in _load_backup():
            try:
                t.revert(dota)
                log(f"Откат: {t.name}")
            except Exception as e:
                log(f"Не удалось откатить «{t.name}»: {e}")
