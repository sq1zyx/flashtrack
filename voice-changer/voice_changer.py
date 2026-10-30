"""
Voice Changer — изменение голоса в реальном времени.

Микрофон -> эффекты (высота тона, робот, радио, эхо, искажение) -> динамики
или виртуальный кабель (VB-Cable), чтобы использовать голос в Discord, играх, OBS.

Запуск с интерфейсом:
    python voice_changer.py

Обработка готового WAV-файла (без интерфейса):
    python voice_changer.py --file in.wav out.wav --preset "Демон"
"""

import argparse
import sys
import wave

import numpy as np

SAMPLE_RATE = 48000
BLOCK_SIZE = 512


# ---------------------------------------------------------------- эффекты ---

class PitchShifter:
    """Сдвиг высоты тона через две скользящие линии задержки с кроссфейдом."""

    def __init__(self, sr, window_ms=40):
        self.W = int(sr * window_ms / 1000)
        self.hist = np.zeros(self.W + 2, dtype=np.float32)
        self.phase = 0.0

    def process(self, x, semitones):
        B = len(x)
        H = len(self.hist)
        buf = np.concatenate([self.hist, x])
        self.hist = buf[-H:]
        if abs(semitones) < 0.01:
            return x
        ratio = 2.0 ** (semitones / 12.0)
        n = np.arange(B)
        step = (1.0 - ratio) / self.W
        ph = (self.phase + step * n) % 1.0
        self.phase = (self.phase + step * B) % 1.0
        out = np.zeros(B, dtype=np.float32)
        for offset in (0.0, 0.5):
            p = (ph + offset) % 1.0
            pos = H + n - p * self.W
            i = np.floor(pos).astype(np.int64)
            f = pos - i
            s = buf[i] * (1 - f) + buf[np.minimum(i + 1, H + B - 1)] * f
            # sin² + cos² = 1, поэтому две головки дают ровную громкость
            out += s * np.sin(np.pi * p) ** 2
        return out


class Robot:
    """Кольцевая модуляция — металлический «роботизированный» голос."""

    def __init__(self, sr):
        self.sr = sr
        self.phase = 0.0

    def process(self, x, amount, freq):
        if amount <= 0:
            return x
        n = np.arange(len(x))
        inc = 2 * np.pi * freq / self.sr
        carrier = np.sin(self.phase + inc * n).astype(np.float32)
        self.phase = (self.phase + inc * len(x)) % (2 * np.pi)
        return x * (1 - amount) + x * carrier * amount * 1.6


class Radio:
    """Полосовой FIR-фильтр 300–3400 Гц: звук рации / телефона."""

    def __init__(self, sr, taps=129):
        t = np.arange(taps) - (taps - 1) / 2

        def lowpass(fc):
            return 2 * fc / sr * np.sinc(2 * fc / sr * t)

        h = (lowpass(3400) - lowpass(300)) * np.hamming(taps)
        self.h = h.astype(np.float32)
        self.state = np.zeros(taps - 1, dtype=np.float32)

    def process(self, x, amount):
        buf = np.concatenate([self.state, x])
        self.state = buf[-len(self.state):]
        if amount <= 0:
            return x
        y = np.convolve(buf, self.h, mode="valid").astype(np.float32)
        y = np.tanh(y * 3.0) * 0.6
        return x * (1 - amount) + y * amount


class Echo:
    """Эхо с обратной связью."""

    def __init__(self, sr, max_ms=1000):
        self.sr = sr
        self.buf = np.zeros(int(sr * max_ms / 1000), dtype=np.float32)

    def process(self, x, amount, delay_ms):
        B = len(x)
        D = max(int(self.sr * delay_ms / 1000), B)
        D = min(D, len(self.buf))
        start = len(self.buf) - D
        delayed = self.buf[start:start + B]
        y = x + delayed * amount
        self.buf = np.concatenate([self.buf[B:], y])
        return y


class NoiseGate:
    """Глушит тихий фоновый шум, когда вы молчите."""

    def __init__(self):
        self.gain = 1.0

    def process(self, x, threshold):
        if threshold <= 0:
            return x
        rms = float(np.sqrt(np.mean(x * x)) + 1e-9)
        target = 1.0 if rms > threshold else 0.0
        coef = 0.5 if target > self.gain else 0.15
        new_gain = self.gain + (target - self.gain) * coef
        g = np.linspace(self.gain, new_gain, len(x), dtype=np.float32)
        self.gain = new_gain
        return x * g


DEFAULT_PARAMS = {
    "pitch": 0.0,         # полутоны, -12..+12
    "robot": 0.0,         # 0..1
    "robot_freq": 60.0,   # Гц
    "radio": 0.0,         # 0..1
    "echo": 0.0,          # 0..0.9
    "echo_ms": 250.0,
    "distortion": 0.0,    # 0..1
    "gate": 0.01,         # порог шумодава
    "volume": 1.0,
}

PRESETS = {
    "Обычный": {},
    "Бурундук": {"pitch": 7.0},
    "Ребёнок": {"pitch": 4.0},
    "Великан": {"pitch": -5.0},
    "Демон": {"pitch": -8.0, "distortion": 0.35, "echo": 0.25, "echo_ms": 120},
    "Робот": {"robot": 0.85, "robot_freq": 55.0, "echo": 0.15, "echo_ms": 60},
    "Инопланетянин": {"pitch": 3.0, "robot": 0.6, "robot_freq": 220.0},
    "Рация": {"radio": 1.0, "distortion": 0.2},
    "Пещера": {"echo": 0.6, "echo_ms": 350},
}


class VoiceEngine:
    """Цепочка эффектов. Параметры можно менять на лету из другого потока."""

    def __init__(self, sr=SAMPLE_RATE):
        self.params = dict(DEFAULT_PARAMS)
        self.gate = NoiseGate()
        self.pitch = PitchShifter(sr)
        self.robot = Robot(sr)
        self.radio = Radio(sr)
        self.echo = Echo(sr)

    def apply_preset(self, name):
        self.params.update(DEFAULT_PARAMS)
        self.params.update(PRESETS[name])

    def process(self, x):
        p = self.params
        x = x.astype(np.float32)
        x = self.gate.process(x, p["gate"])
        x = self.pitch.process(x, p["pitch"])
        x = self.robot.process(x, p["robot"], p["robot_freq"])
        x = self.radio.process(x, p["radio"])
        if p["distortion"] > 0:
            drive = 1 + p["distortion"] * 15
            x = np.tanh(x * drive) / np.tanh(drive) * 0.8
        x = self.echo.process(x, p["echo"], p["echo_ms"])
        return np.clip(x * p["volume"], -1.0, 1.0)


# ------------------------------------------------------- режим WAV-файла ---

def process_file(src, dst, preset):
    with wave.open(src, "rb") as w:
        sr, ch, width = w.getframerate(), w.getnchannels(), w.getsampwidth()
        if width != 2:
            sys.exit("Поддерживаются только 16-битные WAV-файлы")
        data = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    mono = data.reshape(-1, ch).mean(axis=1).astype(np.float32) / 32768.0

    engine = VoiceEngine(sr)
    engine.apply_preset(preset)
    engine.params["gate"] = 0.0
    out = np.concatenate([
        engine.process(mono[i:i + BLOCK_SIZE])
        for i in range(0, len(mono), BLOCK_SIZE)
    ])

    with wave.open(dst, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((out * 32767).astype(np.int16).tobytes())
    print(f"Готово: {dst} (пресет «{preset}»)")


# ---------------------------------------------------------------- интерфейс ---

def run_gui():
    import tkinter as tk
    from tkinter import messagebox, ttk

    import sounddevice as sd

    engine = VoiceEngine()
    state = {"stream": None}

    root = tk.Tk()
    root.title("Voice Changer")
    root.resizable(False, False)
    pad = {"padx": 8, "pady": 4}

    # --- устройства
    devices = sd.query_devices()
    hostapis = sd.query_hostapis()

    def label(i, d):
        return f"{i}: {d['name']} ({hostapis[d['hostapi']]['name']})"

    inputs = [label(i, d) for i, d in enumerate(devices) if d["max_input_channels"] > 0]
    outputs = [label(i, d) for i, d in enumerate(devices) if d["max_output_channels"] > 0]
    default_in, default_out = sd.default.device

    dev_frame = ttk.LabelFrame(root, text="Устройства")
    dev_frame.grid(row=0, column=0, sticky="ew", **pad)
    ttk.Label(dev_frame, text="Микрофон:").grid(row=0, column=0, sticky="w")
    in_var = tk.StringVar()
    in_box = ttk.Combobox(dev_frame, textvariable=in_var, values=inputs, width=55, state="readonly")
    in_box.grid(row=0, column=1, **pad)
    ttk.Label(dev_frame, text="Вывод:").grid(row=1, column=0, sticky="w")
    out_var = tk.StringVar()
    out_box = ttk.Combobox(dev_frame, textvariable=out_var, values=outputs, width=55, state="readonly")
    out_box.grid(row=1, column=1, **pad)
    ttk.Label(
        dev_frame,
        text="Для Discord/игр выберите вывод «CABLE Input» (VB-Cable),\n"
             "а в Discord — микрофон «CABLE Output».",
        foreground="#666",
    ).grid(row=2, column=0, columnspan=2, sticky="w", **pad)

    for box, items, default in ((in_box, inputs, default_in), (out_box, outputs, default_out)):
        match = [s for s in items if s.startswith(f"{default}:")]
        if match:
            box.set(match[0])
        elif items:
            box.set(items[0])

    # --- пресеты
    preset_frame = ttk.LabelFrame(root, text="Пресеты")
    preset_frame.grid(row=1, column=0, sticky="ew", **pad)

    # --- ползунки
    slider_frame = ttk.LabelFrame(root, text="Настройки")
    slider_frame.grid(row=2, column=0, sticky="ew", **pad)
    sliders = {}
    spec = [
        ("pitch", "Высота тона (полутоны)", -12, 12),
        ("robot", "Робот", 0, 1),
        ("robot_freq", "Частота робота (Гц)", 20, 400),
        ("radio", "Рация", 0, 1),
        ("distortion", "Искажение", 0, 1),
        ("echo", "Эхо", 0, 0.9),
        ("echo_ms", "Задержка эха (мс)", 30, 1000),
        ("gate", "Шумодав", 0, 0.1),
        ("volume", "Громкость", 0, 3),
    ]
    for row, (key, text, lo, hi) in enumerate(spec):
        ttk.Label(slider_frame, text=text).grid(row=row, column=0, sticky="w", padx=8)
        var = tk.DoubleVar(value=engine.params[key])
        value_lbl = ttk.Label(slider_frame, width=6)
        value_lbl.grid(row=row, column=2)

        def on_change(_=None, key=key, var=var, value_lbl=value_lbl):
            engine.params[key] = var.get()
            value_lbl.config(text=f"{var.get():.2f}")

        ttk.Scale(slider_frame, from_=lo, to=hi, variable=var, length=300,
                  command=on_change).grid(row=row, column=1, padx=8, pady=2)
        on_change()
        sliders[key] = (var, on_change)

    def apply_preset(name):
        engine.apply_preset(name)
        for key, (var, on_change) in sliders.items():
            var.set(engine.params[key])
            on_change()

    for i, name in enumerate(PRESETS):
        ttk.Button(preset_frame, text=name, command=lambda n=name: apply_preset(n)).grid(
            row=i // 5, column=i % 5, padx=4, pady=4, sticky="ew")

    # --- старт / стоп
    status = tk.StringVar(value="Остановлено")
    level = tk.DoubleVar(value=0)

    def callback(indata, outdata, frames, time_info, status_flags):
        y = engine.process(indata[:, 0])
        outdata[:] = y[:, None]
        level.set(min(100.0, float(np.abs(y).max()) * 100))

    def start():
        stop()
        try:
            in_dev = int(in_var.get().split(":")[0])
            out_dev = int(out_var.get().split(":")[0])
            out_ch = min(2, devices[out_dev]["max_output_channels"])
            stream = sd.Stream(
                device=(in_dev, out_dev), samplerate=SAMPLE_RATE, blocksize=BLOCK_SIZE,
                channels=(1, out_ch), dtype="float32", latency="low", callback=callback)
            stream.start()
        except Exception as e:  # noqa: BLE001 — показываем пользователю любую ошибку звука
            messagebox.showerror("Ошибка звука", str(e))
            return
        state["stream"] = stream
        status.set("▶ Работает")

    def stop():
        if state["stream"] is not None:
            state["stream"].stop()
            state["stream"].close()
            state["stream"] = None
        status.set("Остановлено")
        level.set(0)

    ctrl = ttk.Frame(root)
    ctrl.grid(row=3, column=0, sticky="ew", **pad)
    ttk.Button(ctrl, text="▶ Старт", command=start).pack(side="left", padx=4)
    ttk.Button(ctrl, text="■ Стоп", command=stop).pack(side="left", padx=4)
    ttk.Label(ctrl, textvariable=status).pack(side="left", padx=12)
    ttk.Progressbar(ctrl, variable=level, maximum=100, length=180).pack(side="right", padx=4)

    ttk.Label(root, text="Совет: слушайте себя в наушниках, иначе будет эффект обратной связи.",
              foreground="#666").grid(row=4, column=0, sticky="w", **pad)

    def on_close():
        stop()
        root.destroy()

    root.protocol("WM_DELETE_WINDOW", on_close)
    root.mainloop()


def main():
    parser = argparse.ArgumentParser(description="Voice Changer — изменение голоса")
    parser.add_argument("--file", nargs=2, metavar=("IN_WAV", "OUT_WAV"),
                        help="обработать WAV-файл вместо микрофона")
    parser.add_argument("--preset", default="Демон", choices=list(PRESETS),
                        help="пресет для режима --file")
    parser.add_argument("--list-presets", action="store_true")
    args = parser.parse_args()

    if args.list_presets:
        print("\n".join(PRESETS))
    elif args.file:
        process_file(args.file[0], args.file[1], args.preset)
    else:
        run_gui()


if __name__ == "__main__":
    main()
