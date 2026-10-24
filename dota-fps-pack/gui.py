"""Меню FPS Pack: тёмный интерфейс с боковыми вкладками."""
import json
import os
import queue
import subprocess
import sys
import threading
import tkinter as tk
from pathlib import Path
from tkinter import filedialog

import build_pack
import game_cfg
import tweaks

HERE = Path(__file__).resolve().parent
SETTINGS = HERE / "settings.json"
WIN = sys.platform == "win32"

BG = "#0b0b10"
SIDEBAR = "#101017"
CARD = "#15151d"
CARD_HI = "#1c1c27"
BORDER = "#23232f"
TRACK = "#2a2a38"
ACCENT = "#8b5cf6"
ACCENT_HI = "#a78bfa"
TEXT = "#ececf4"
MUTED = "#7d7d93"
OK = "#34d399"
WARN = "#fbbf24"
ERR = "#f87171"
FONT = "Segoe UI" if WIN else "Inter"
MONO = "Consolas" if WIN else "DejaVu Sans Mono"

RECOMMENDED_TWEAKS = {"power_plan", "game_mode", "game_dvr_off", "gpu_high_perf", "hags", "cpu_priority"}

DEFAULTS = {"mods": {}, "lang": "russian", "api": "vulkan", "fps": 0, "novid": True, "high": True,
            "use_lang": True, "portrait": True, "embers": True, "dota": ""}


def load_settings():
    try:
        return {**DEFAULTS, **json.loads(SETTINGS.read_text(encoding="utf-8"))}
    except (OSError, ValueError):
        return dict(DEFAULTS)


# --- Виджеты ---

class Toggle(tk.Canvas):
    W, H = 38, 20

    def __init__(self, parent, value=False, command=None, enabled=True):
        super().__init__(parent, width=self.W, height=self.H, bg=parent["bg"], highlightthickness=0,
                         cursor="hand2" if enabled else "arrow")
        self.value, self.command, self.enabled = value, command, enabled
        self.pos = 1.0 if value else 0.0
        self.bind("<Button-1>", self._click)
        self._draw()

    def _draw(self):
        self.delete("all")
        h, w, r = self.H, self.W, self.H / 2
        on = self.pos > 0.5
        color = (ACCENT if on else TRACK) if self.enabled else BORDER
        self.create_oval(0, 0, h, h, fill=color, outline=color)
        self.create_oval(w - h, 0, w, h, fill=color, outline=color)
        self.create_rectangle(r, 0, w - r, h, fill=color, outline=color)
        x = 3 + self.pos * (w - h)
        knob = TEXT if self.enabled else MUTED
        self.create_oval(x, 3, x + h - 6, h - 3, fill=knob, outline=knob)

    def _animate(self):
        target = 1.0 if self.value else 0.0
        self.pos += (target - self.pos) * 0.5
        if abs(target - self.pos) < 0.05:
            self.pos = target
        self._draw()
        if self.pos != target:
            self.after(12, self._animate)

    def set(self, value):
        self.value = bool(value)
        self._animate()

    def _click(self, _):
        if not self.enabled:
            return
        self.set(not self.value)
        if self.command:
            self.command(self.value)


class Slider(tk.Canvas):
    def __init__(self, parent, lo, hi, step, value, command=None, width=170):
        super().__init__(parent, width=width, height=20, bg=parent["bg"], highlightthickness=0, cursor="hand2")
        self.lo, self.hi, self.step, self.value, self.command, self.w = lo, hi, step, value, command, width
        self.bind("<Button-1>", self._drag)
        self.bind("<B1-Motion>", self._drag)
        self._draw()

    def _draw(self):
        self.delete("all")
        x = 8 + (self.value - self.lo) / (self.hi - self.lo) * (self.w - 16)
        self.create_line(8, 10, self.w - 8, 10, fill=TRACK, width=4, capstyle="round")
        self.create_line(8, 10, x, 10, fill=ACCENT, width=4, capstyle="round")
        self.create_oval(x - 7, 3, x + 7, 17, fill=TEXT, outline=ACCENT, width=2)

    def _drag(self, e):
        frac = min(max((e.x - 8) / (self.w - 16), 0), 1)
        value = round((self.lo + frac * (self.hi - self.lo)) / self.step) * self.step
        if value != self.value:
            self.value = value
            self._draw()
            if self.command:
                self.command(value)


class Segmented(tk.Frame):
    def __init__(self, parent, options, value, command=None):
        super().__init__(parent, bg=BORDER, padx=2, pady=2)
        self.value, self.command, self.items = value, command, {}
        for key, label in options:
            lbl = tk.Label(self, text=label, font=(FONT, 9, "bold"), padx=10, pady=3, cursor="hand2")
            lbl.pack(side="left", padx=1)
            lbl.bind("<Button-1>", lambda _, k=key: self.select(k))
            self.items[key] = lbl
        self._paint()

    def _paint(self):
        for key, lbl in self.items.items():
            on = key == self.value
            lbl.configure(bg=ACCENT if on else CARD_HI, fg=TEXT if on else MUTED)

    def select(self, key):
        self.value = key
        self._paint()
        if self.command:
            self.command(key)


class Button(tk.Label):
    def __init__(self, parent, text, command, primary=False):
        self.base = ACCENT if primary else CARD_HI
        self.hover = ACCENT_HI if primary else BORDER
        super().__init__(parent, text=text, bg=self.base, fg=TEXT, font=(FONT, 9, "bold"),
                         padx=14, pady=7, cursor="hand2")
        self.command = command
        self.bind("<Enter>", lambda _: self.configure(bg=self.hover))
        self.bind("<Leave>", lambda _: self.configure(bg=self.base))
        self.bind("<Button-1>", lambda _: self.command())


class ScrollFrame(tk.Frame):
    def __init__(self, parent):
        super().__init__(parent, bg=BG)
        self.canvas = tk.Canvas(self, bg=BG, highlightthickness=0)
        self.canvas.pack(fill="both", expand=True)
        self.inner = tk.Frame(self.canvas, bg=BG)
        win = self.canvas.create_window(0, 0, window=self.inner, anchor="nw")
        self.inner.bind("<Configure>", lambda _: self.canvas.configure(scrollregion=self.canvas.bbox("all")))
        self.canvas.bind("<Configure>", lambda e: self.canvas.itemconfigure(win, width=e.width))
        self.canvas.bind("<Enter>", lambda _: self._wheel(True))
        self.canvas.bind("<Leave>", lambda _: self._wheel(False))

    def _scroll(self, e):
        if self.inner.winfo_height() <= self.canvas.winfo_height():
            return
        delta = -1 if (e.num == 4 or e.delta > 0) else 1
        self.canvas.yview_scroll(delta * 2, "units")

    def _wheel(self, on):
        for seq in ("<MouseWheel>", "<Button-4>", "<Button-5>"):
            if on:
                self.canvas.bind_all(seq, self._scroll)
            else:
                self.canvas.unbind_all(seq)


def card(parent, title, column, row=0, columnspan=1, rowspan=1):
    outer = tk.Frame(parent, bg=BORDER, padx=1, pady=1)
    outer.grid(row=row, column=column, columnspan=columnspan, rowspan=rowspan, sticky="nsew", padx=6, pady=6)
    body = tk.Frame(outer, bg=CARD, padx=14, pady=10)
    body.pack(fill="both", expand=True)
    head = tk.Frame(body, bg=CARD)
    head.pack(fill="x", pady=(0, 6))
    tk.Frame(head, bg=ACCENT, width=3, height=14).pack(side="left", padx=(0, 8))
    tk.Label(head, text=title.upper(), bg=CARD, fg=TEXT, font=(FONT, 9, "bold")).pack(side="left")
    return body


def row(parent, title, desc="", tag=None, tag_color=WARN, below=False):
    """Строка настройки; возвращает контейнер для контрола (справа или, если below, под текстом)."""
    frame = tk.Frame(parent, bg=CARD)
    frame.pack(fill="x", pady=5)
    right = tk.Frame(frame, bg=CARD)
    if below:
        right.pack(side="bottom", anchor="w", pady=(6, 0))
    else:
        right.pack(side="right", padx=(10, 0))
    left = tk.Frame(frame, bg=CARD)
    left.pack(side="left", fill="x", expand=True)
    top = tk.Frame(left, bg=CARD)
    top.pack(anchor="w")
    tk.Label(top, text=title, bg=CARD, fg=TEXT, font=(FONT, 10)).pack(side="left")
    if tag:
        tk.Label(top, text=tag.upper(), bg=CARD, fg=tag_color, font=(FONT, 7, "bold")).pack(side="left", padx=6)
    if desc:
        tk.Label(left, text=desc, bg=CARD, fg=MUTED, font=(FONT, 8), wraplength=250,
                 justify="left").pack(anchor="w")
    return right


# --- Приложение ---

class App:
    PAGES = [("visual", "◈  Визуал"), ("game", "▶  Игра"), ("system", "⚙  Система"), ("tools", "✦  Утилиты")]

    def __init__(self, dota):
        self.s = load_settings()
        if self.s["dota"] and Path(self.s["dota"]).is_dir():
            dota = Path(self.s["dota"])
        self.dota = dota
        self.config = build_pack.load_config()
        self.logq = queue.Queue()
        self.busy = False

        self.root = tk.Tk()
        self.root.title("FPS Pack")
        self.root.configure(bg=BG)
        self.root.geometry("980x660")
        self.root.minsize(900, 560)
        self.root.protocol("WM_DELETE_WINDOW", self.close)

        self._sidebar()
        main = tk.Frame(self.root, bg=BG)
        main.pack(side="left", fill="both", expand=True)
        self._header(main)
        self.page_host = tk.Frame(main, bg=BG)
        self.page_host.pack(fill="both", expand=True, padx=12)
        self._console(main)

        self.pages = {}
        for key, builder in (("visual", self._page_visual), ("game", self._page_game),
                             ("system", self._page_system), ("tools", self._page_tools)):
            sf = ScrollFrame(self.page_host)
            grid = sf.inner
            grid.columnconfigure(0, weight=1, uniform="c")
            grid.columnconfigure(1, weight=1, uniform="c")
            builder(grid)
            self.pages[key] = sf
        self.show("visual")
        self.refresh_status()
        self.log("FPS Pack готов. Dota: " + (str(self.dota) if self.dota else "не найдена — укажи папку во вкладке «Утилиты»"))
        self.root.after(100, self._drain_log)

    # каркас

    def _sidebar(self):
        bar = tk.Frame(self.root, bg=SIDEBAR, width=200)
        bar.pack(side="left", fill="y")
        bar.pack_propagate(False)
        logo = tk.Frame(bar, bg=SIDEBAR, pady=22)
        logo.pack(fill="x")
        tk.Label(logo, text="◆", bg=SIDEBAR, fg=ACCENT, font=(FONT, 20, "bold")).pack(side="left", padx=(20, 8))
        names = tk.Frame(logo, bg=SIDEBAR)
        names.pack(side="left")
        tk.Label(names, text="FPS PACK", bg=SIDEBAR, fg=TEXT, font=(FONT, 13, "bold")).pack(anchor="w")
        tk.Label(names, text="dota 2 optimizer", bg=SIDEBAR, fg=MUTED, font=(FONT, 8)).pack(anchor="w")

        self.tabs = {}
        for key, label in self.PAGES:
            item = tk.Frame(bar, bg=SIDEBAR, cursor="hand2")
            item.pack(fill="x", pady=1)
            mark = tk.Frame(item, bg=SIDEBAR, width=3)
            mark.pack(side="left", fill="y")
            lbl = tk.Label(item, text=label, bg=SIDEBAR, fg=MUTED, font=(FONT, 10, "bold"), anchor="w",
                           padx=20, pady=10)
            lbl.pack(side="left", fill="x", expand=True)
            for w in (item, lbl):
                w.bind("<Button-1>", lambda _, k=key: self.show(k))
            self.tabs[key] = (item, mark, lbl)

        tk.Label(bar, text="только косметика\nбез влияния на геймплей", bg=SIDEBAR, fg=MUTED,
                 font=(FONT, 8), justify="left").pack(side="bottom", anchor="w", padx=20, pady=16)

    def _header(self, parent):
        head = tk.Frame(parent, bg=BG)
        head.pack(fill="x", padx=18, pady=(16, 6))
        self.title = tk.Label(head, bg=BG, fg=TEXT, font=(FONT, 16, "bold"))
        self.title.pack(side="left")
        self.chips = tk.Frame(head, bg=BG)
        self.chips.pack(side="right")

    def _console(self, parent):
        wrap = tk.Frame(parent, bg=BORDER, padx=1, pady=1)
        wrap.pack(fill="x", padx=18, pady=(4, 14))
        self.console = tk.Text(wrap, height=5, bg="#08080c", fg=MUTED, insertbackground=TEXT, relief="flat",
                               highlightthickness=0,
                               font=(MONO, 9), padx=10, pady=8, state="disabled", wrap="word")
        self.console.pack(fill="x")
        self.console.tag_configure("p", foreground=ACCENT)
        self.console.tag_configure("err", foreground=ERR)

    def chip(self, text, color):
        tk.Label(self.chips, text=f"●  {text}", bg=CARD, fg=color, font=(FONT, 8, "bold"),
                 padx=10, pady=4).pack(side="left", padx=4)

    def refresh_status(self):
        for w in self.chips.winfo_children():
            w.destroy()
        self.chip("Dota найдена" if self.dota else "Dota не найдена", OK if self.dota else ERR)
        if WIN:
            self.chip("Админ" if tweaks.is_admin() else "Без админа", OK if tweaks.is_admin() else WARN)
        if self.busy:
            self.chip("Работаю…", ACCENT_HI)

    def show(self, key):
        for k, (item, mark, lbl) in self.tabs.items():
            on = k == key
            item.configure(bg=CARD if on else SIDEBAR)
            mark.configure(bg=ACCENT if on else SIDEBAR)
            lbl.configure(bg=CARD if on else SIDEBAR, fg=TEXT if on else MUTED)
        for k, page in self.pages.items():
            page.pack_forget()
        self.pages[key].pack(fill="both", expand=True)
        self.title.configure(text=dict(self.PAGES)[key][3:])

    # лог и фоновые задачи

    def log(self, msg):
        self.logq.put(str(msg))

    def _drain_log(self):
        while not self.logq.empty():
            msg = self.logq.get()
            self.console.configure(state="normal")
            self.console.insert("end", "› ", "p")
            self.console.insert("end", msg + "\n", "err" if msg.startswith("Ошибка") else "")
            self.console.see("end")
            self.console.configure(state="disabled")
        self.root.after(100, self._drain_log)

    def run(self, fn, need_dota=True):
        if self.busy:
            self.log("Подожди, предыдущая операция ещё идёт")
            return
        if need_dota and not self.dota:
            self.log("Ошибка: не указана папка Доты (вкладка «Утилиты»)")
            return

        def worker():
            try:
                fn()
            except Exception as e:
                self.log(f"Ошибка: {e}")
            finally:
                self.busy = False
                self.root.after(0, self.refresh_status)

        self.busy = True
        self.refresh_status()
        threading.Thread(target=worker, daemon=True).start()

    def setting(self, key):
        def set_value(value):
            self.s[key] = value
            self.update_preview()
        return set_value

    # вкладка «Визуал»

    def _page_visual(self, grid):
        for title, group, col, r, span in (("Партиклы", None, 0, 0, 4), ("Ландшафт и карта · Minify", "terrain", 1, 1, 1)):
            body = card(grid, title, col, row=r, rowspan=span)
            for mod in self.config["mods"]:
                if mod.get("group") != group:
                    continue
                on = self.s["mods"].get(mod["id"], mod.get("default", True))
                Toggle(row(body, mod["name"], mod["description"]), on,
                       lambda v, i=mod["id"]: self.s["mods"].__setitem__(i, v)).pack()

        body = card(grid, "Пак модов", 1)
        lang = row(body, "Язык игры", "Пак ставится в папку dota_<язык>, Дота запускается с -language <язык>.")
        Segmented(lang, [("russian", "RU"), ("english", "EN")], self.s["lang"], self.setting("lang")).pack()
        btns = tk.Frame(body, bg=CARD)
        btns.pack(fill="x", pady=(10, 0))
        Button(btns, "Собрать и установить", lambda: self.build(False), primary=True).pack(side="left")
        Button(btns, "Проверить", lambda: self.build(True)).pack(side="left", padx=6)
        Button(btns, "Удалить", lambda: self.run(lambda: build_pack.uninstall(
            self.dota, self.s["lang"], log=self.log))).pack(side="left")

        body = card(grid, "Как это работает", 1, row=2)
        tk.Label(body, bg=CARD, fg=MUTED, font=(FONT, 9), justify="left", wraplength=320, text=(
            "Выбранные косметические эффекты заменяются пустыми. Эффекты способностей, радиусы и всё, "
            "что влияет на игру, не трогаются.\n\nМоды ландшафта скачиваются из открытого проекта Minify "
            "(github.com/egezenn/dota2-minify, GPL-3.0) при сборке. Для них в инвентаре должен стоять "
            "стандартный ландшафт, а в настройках видео выключена трава.\n\n«Проверить» показывает, сколько файлов найдено для "
            "каждого мода, ничего не меняя. После крупных патчей пак стоит пересобрать.")).pack(anchor="w")

    def build(self, dry):
        ids = [m["id"] for m in self.config["mods"] if self.s["mods"].get(m["id"], m.get("default", True))]
        self.run(lambda: build_pack.build(self.dota, ids, self.s["lang"], dry_run=dry, log=self.log))

    # вкладка «Игра»

    def _page_game(self, grid):
        body = card(grid, "Параметры запуска", 0)
        Segmented(row(body, "Графический API", "Vulkan чаще быстрее, DX11 стабильнее на старых картах.", below=True),
                  [("vulkan", "Vulkan"), ("dx11", "DX11"), ("auto", "Авто")], self.s["api"],
                  self.setting("api")).pack()
        fps_right = row(body, "Лимит FPS", "Выше частоты монитора. С G-Sync — на 3 ниже частоты. 0 — без лимита.", below=True)
        self.fps_label = tk.Label(fps_right, bg=CARD, fg=ACCENT_HI, font=(FONT, 10, "bold"), width=4)
        Slider(fps_right, 0, 400, 5, self.s["fps"], self._set_fps, width=260).pack(side="left")
        self.fps_label.pack(side="left", padx=8)
        Toggle(row(body, "Язык пака модов", "Добавить -language, чтобы подгрузился пак."),
               self.s["use_lang"], self.setting("use_lang")).pack()
        Toggle(row(body, "Без интро-видео", "-novid"), self.s["novid"], self.setting("novid")).pack()
        Toggle(row(body, "Высокий приоритет", "-high"), self.s["high"], self.setting("high")).pack()

        self.preview = tk.Label(body, bg="#08080c", fg=ACCENT_HI, font=(MONO, 9), anchor="w", justify="left",
                                padx=10, pady=8, wraplength=330)
        self.preview.pack(fill="x", pady=(10, 6))
        btns = tk.Frame(body, bg=CARD)
        btns.pack(fill="x")
        Button(btns, "Копировать", self.copy_options, primary=True).pack(side="left")
        Button(btns, "Записать в Steam", lambda: self.run(lambda: game_cfg.write_steam_launch_options(
            build_pack.steam_roots(), self.options(), log=self.log), need_dota=False)).pack(side="left", padx=6)

        body = card(grid, "autoexec.cfg", 1)
        Toggle(row(body, "Статичный портрет героя", "dota_portrait_animate 0"),
               self.s["portrait"], self.setting("portrait")).pack()
        Toggle(row(body, "Без искр в меню", "dota_embers 0"), self.s["embers"], self.setting("embers")).pack()
        tk.Label(body, text="Лимит FPS берётся из слайдера слева. Свои строки в autoexec.cfg не стираются.",
                 bg=CARD, fg=MUTED, font=(FONT, 8), wraplength=320, justify="left").pack(anchor="w", pady=4)
        Button(body, "Записать autoexec", lambda: self.run(lambda: game_cfg.write_autoexec(
            self.dota, game_cfg.autoexec_commands(self.s["fps"], self.s["portrait"], self.s["embers"]),
            log=self.log)), primary=True).pack(anchor="w", pady=(6, 0))

        body = card(grid, "Настройки видео в игре", 1, row=1)
        for name, value in (("Режим окна", "Полный экран"), ("Верт. синхронизация", "Выкл"),
                            ("Качество рендера", "70–85%"), ("Тени", "Выкл / низко"),
                            ("Ambient Occlusion", "Выкл"), ("Трава, ветер, туман", "Выкл"),
                            ("Анимированный портрет", "Выкл"), ("Текстуры / эффекты", "Средне")):
            r = tk.Frame(body, bg=CARD)
            r.pack(fill="x", pady=2)
            tk.Label(r, text=name, bg=CARD, fg=TEXT, font=(FONT, 9)).pack(side="left")
            tk.Label(r, text=value, bg=CARD, fg=ACCENT_HI, font=(FONT, 9, "bold")).pack(side="right")
        self._set_fps(self.s["fps"])

    def _set_fps(self, value):
        self.s["fps"] = value
        self.fps_label.configure(text="∞" if value == 0 else str(value))
        self.update_preview()

    def options(self):
        return game_cfg.launch_options(self.s["api"], self.s["lang"] if self.s["use_lang"] else "",
                                       self.s["fps"], self.s["novid"], self.s["high"])

    def update_preview(self):
        if hasattr(self, "preview"):
            self.preview.configure(text=self.options())

    def copy_options(self):
        self.root.clipboard_clear()
        self.root.clipboard_append(self.options())
        self.log("Параметры скопированы: Steam → Dota 2 → Свойства → Параметры запуска")

    # вкладка «Система»

    def _page_system(self, grid):
        body = card(grid, "Твики Windows", 0, columnspan=2)
        self.tweak_toggles = {}
        for t in tweaks.TWEAKS:
            tag, color = ("админ", WARN) if t.admin else (None, WARN)
            desc = t.desc + (f"  ({t.note})" if t.note else "")
            tg = Toggle(row(body, t.name, desc, tag, color), False,
                        lambda v, t=t: self.toggle_tweak(t, v), enabled=WIN)
            tg.pack()
            self.tweak_toggles[t.id] = tg
        btns = tk.Frame(body, bg=CARD)
        btns.pack(fill="x", pady=(10, 0))
        Button(btns, "Применить рекомендуемые", self.apply_recommended, primary=True).pack(side="left")
        Button(btns, "Откатить всё", lambda: self.run(self._revert_all, need_dota=False)).pack(side="left", padx=6)
        if WIN and not tweaks.is_admin():
            Button(btns, "Перезапустить от админа", self.relaunch_admin).pack(side="left")
        if not WIN:
            tk.Label(body, text="Твики работают только в Windows.", bg=CARD, fg=WARN,
                     font=(FONT, 9)).pack(anchor="w", pady=(8, 0))
        self.sync_tweaks()

    def sync_tweaks(self):
        if not WIN:
            return
        for t in tweaks.TWEAKS:
            try:
                self.tweak_toggles[t.id].set(t.is_applied(self.dota))
            except Exception:
                pass

    def _tweak(self, t, on):
        if t.admin and not tweaks.is_admin():
            raise RuntimeError(f"«{t.name}» требует запуска от администратора")
        (t.apply if on else t.revert)(self.dota)
        self.log(("Включено: " if on else "Выключено: ") + t.name + (f" — {t.note}" if t.note else ""))

    def toggle_tweak(self, t, on):
        def job():
            try:
                self._tweak(t, on)
            finally:
                self.root.after(0, self.sync_tweaks)
        self.run(job, need_dota=False)

    def apply_recommended(self):
        def job():
            for t in tweaks.TWEAKS:
                if t.id in RECOMMENDED_TWEAKS:
                    try:
                        self._tweak(t, True)
                    except Exception as e:
                        self.log(f"Ошибка: {e}")
            self.root.after(0, self.sync_tweaks)
        if WIN:
            self.run(job, need_dota=False)

    def _revert_all(self):
        tweaks.revert_all(self.dota, log=self.log)
        self.root.after(0, self.sync_tweaks)

    def relaunch_admin(self):
        self.save()
        tweaks.relaunch_as_admin()
        self.root.destroy()

    # вкладка «Утилиты»

    def _page_tools(self, grid):
        body = card(grid, "Кэш и сеть", 0)
        Button(row(body, "Кэш шейдеров", "NVIDIA / AMD / DirectX и кэш Steam для Доты. "
                                         "Помогает при фризах после обновления драйвера."),
               "Очистить", lambda: self.run(lambda: game_cfg.clear_dirs(
                   game_cfg.shader_cache_dirs(build_pack.steam_roots()), log=self.log), need_dota=False)).pack()
        Button(row(body, "DNS-кэш", "Сброс при проблемах с подключением к серверам."),
               "Сбросить", lambda: self.run(lambda: game_cfg.flush_dns(log=self.log), need_dota=False)).pack()

        body = card(grid, "Папки", 1)
        self.path_label = tk.Label(body, bg="#08080c", fg=MUTED, font=(MONO, 8), anchor="w", padx=8, pady=6,
                                   wraplength=320, justify="left")
        self.path_label.pack(fill="x", pady=(0, 8))
        btns = tk.Frame(body, bg=CARD)
        btns.pack(fill="x")
        Button(btns, "Выбрать папку Доты", self.pick_dota, primary=True).pack(side="left")
        Button(btns, "Открыть", lambda: self.open_dir(self.dota)).pack(side="left", padx=6)
        Button(btns, "cfg", lambda: self.open_dir(self.dota and self.dota / "game" / "dota" / "cfg")).pack(side="left")
        self._show_path()

        body = card(grid, "Скан для ландшафта", 0, row=1)
        tk.Label(body, text="Сохраняет список файлов ландшафта и деревьев в scan.txt — по нему делается мод "
                            "плоского ландшафта.", bg=CARD, fg=MUTED, font=(FONT, 8), wraplength=320,
                 justify="left").pack(anchor="w", pady=(0, 8))
        Button(body, "Сканировать", lambda: self.run(lambda: build_pack.scan(
            self.dota, HERE / "scan.txt", log=self.log))).pack(anchor="w")

    def _show_path(self):
        self.path_label.configure(text=str(self.dota) if self.dota else "не указана")

    def pick_dota(self):
        path = filedialog.askdirectory(title="Папка «dota 2 beta»")
        if not path:
            return
        path = Path(path)
        if not (path / "game" / "dota" / "pak01_dir.vpk").is_file():
            self.log("Ошибка: это не папка «dota 2 beta»")
            return
        self.dota = path
        self.s["dota"] = str(path)
        self._show_path()
        self.refresh_status()
        self.sync_tweaks()
        self.log(f"Папка Доты: {path}")

    def open_dir(self, path):
        if not path or not Path(path).is_dir():
            self.log("Ошибка: папка не найдена")
        elif WIN:
            os.startfile(path)
        else:
            subprocess.Popen(["xdg-open", str(path)])

    # сохранение

    def save(self):
        try:
            SETTINGS.write_text(json.dumps(self.s, ensure_ascii=False, indent=2), encoding="utf-8")
        except OSError:
            pass

    def close(self):
        self.save()
        self.root.destroy()


def main(dota=None):
    App(dota).root.mainloop()


if __name__ == "__main__":
    main(build_pack.find_dota())
