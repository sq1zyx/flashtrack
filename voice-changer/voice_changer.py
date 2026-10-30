"""
Voice Changer — изменение голоса в реальном времени.

Микрофон -> эффекты -> динамики или виртуальный кабель (VB-Cable),
чтобы использовать голос в Discord, играх, OBS.

Запуск с интерфейсом:
    python voice_changer.py

Обработка готового WAV-файла (без интерфейса):
    python voice_changer.py --file in.wav out.wav --preset "Демон" --boost 12
"""

import argparse
import sys
import wave

import numpy as np

SAMPLE_RATE = 48000
BLOCK_SIZE = 512
F32 = np.float32


def _read(buf, pos):
    """Чтение из буфера по дробным позициям с линейной интерполяцией."""
    i = np.floor(pos).astype(np.int64)
    f = (pos - i).astype(F32)
    return buf[i] * (1 - f) + buf[np.minimum(i + 1, len(buf) - 1)] * f


# ---------------------------------------------------------------- эффекты ---

class PitchShifter:
    """Сдвиг высоты тона через две скользящие линии задержки с кроссфейдом."""

    def __init__(self, sr, window_ms=40):
        self.W = int(sr * window_ms / 1000)
        self.hist = np.zeros(self.W + 2, dtype=F32)
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
        out = np.zeros(B, dtype=F32)
        for offset in (0.0, 0.5):
            p = (ph + offset) % 1.0
            # sin² + cos² = 1, поэтому две головки дают ровную громкость
            out += _read(buf, H + n - p * self.W) * np.sin(np.pi * p) ** 2
        return out


class Spectral:
    """
    Обработка в частотной области (STFT): сдвиг формант (тембра),
    шёпот, фильтр низких частот и эквалайзер «улучшения голоса».
    """

    def __init__(self, sr, n=1024, lifter=40):
        self.sr, self.n, self.hop, self.lifter = sr, n, n // 4, lifter
        self.win = np.hanning(n + 1)[:-1].astype(F32)
        self.frame = np.zeros(n, dtype=F32)
        self.acc = np.zeros(n, dtype=F32)
        self.inq = np.zeros(0, dtype=F32)
        self.outq = np.zeros(n, dtype=F32)
        self.freqs = np.fft.rfftfreq(n, 1 / sr)
        self.bins = np.arange(n // 2 + 1, dtype=np.float64)
        self.rng = np.random.default_rng()
        self._curve_key = None
        self._curve = None

    def _eq_curve(self, enhance, lowpass):
        key = (round(enhance, 3), round(lowpass))
        if key == self._curve_key:
            return self._curve
        f = np.maximum(self.freqs, 1.0)

        def bell(fc, width):
            return np.exp(-0.5 * (np.log2(f / fc) / width) ** 2)

        # меньше «бубнения» на 300 Гц, больше разборчивости 2–5 кГц, немного «воздуха»
        db = enhance * (-3.0 * bell(300, 0.8) + 4.5 * bell(3500, 1.0)
                        + 3.0 / (1 + (9000 / f) ** 2))
        curve = 10 ** (db / 20)
        if enhance > 0:  # срезаем гул и стук по столу ниже ~90 Гц
            curve *= (1 / np.sqrt(1 + (90 / f) ** 4)) ** enhance
        if lowpass < 19000:
            curve *= 1 / np.sqrt(1 + (f / lowpass) ** 8)
        self._curve_key, self._curve = key, curve
        return curve

    def process(self, x, formant_ratio, whisper, enhance, lowpass):
        n, hop = self.n, self.hop
        curve = self._eq_curve(enhance, lowpass)
        self.inq = np.concatenate([self.inq, x])
        outs = [self.outq]
        while len(self.inq) >= hop:
            self.frame = np.concatenate([self.frame[hop:], self.inq[:hop]])
            self.inq = self.inq[hop:]
            X = np.fft.rfft(self.frame * self.win)

            if abs(formant_ratio - 1) > 1e-3 or whisper > 0:
                # огибающая спектра через кепстр = форманты голоса
                cep = np.fft.irfft(np.log(np.abs(X) + 1e-7), n)
                cep[self.lifter:n - self.lifter + 1] = 0
                env = np.fft.rfft(cep).real
                if abs(formant_ratio - 1) > 1e-3:
                    warped = np.interp(self.bins / formant_ratio, self.bins, env)
                    X *= np.exp(np.clip(warped - env, -3, 3))
                    env = warped
                if whisper > 0:
                    # шёпот = шум, окрашенный формантами (без связок)
                    noise = np.exp(env) * np.exp(1j * self.rng.uniform(0, 2 * np.pi, len(env)))
                    noise *= np.sqrt(np.sum(np.abs(X) ** 2) / (np.sum(np.abs(noise) ** 2) + 1e-12))
                    X = X * (1 - whisper) + noise * whisper

            y = np.fft.irfft(X * curve, n).astype(F32) * self.win / 1.5
            self.acc += y
            outs.append(self.acc[:hop].copy())
            self.acc = np.concatenate([self.acc[hop:], np.zeros(hop, dtype=F32)])
        q = np.concatenate(outs)
        self.outq = q[len(x):]
        return q[:len(x)]


class Vibrato:
    """Дрожание голоса: задержка, которая покачивается по синусоиде."""

    def __init__(self, sr):
        self.sr = sr
        self.base = sr * 0.006
        self.depth = sr * 0.005
        self.hist = np.zeros(int(self.base + self.depth) + 3, dtype=F32)
        self.phase = 0.0

    def process(self, x, amount, rate):
        B, H = len(x), len(self.hist)
        buf = np.concatenate([self.hist, x])
        self.hist = buf[-H:]
        if amount <= 0:
            return x
        n = np.arange(B)
        inc = 2 * np.pi * rate / self.sr
        lfo = np.sin(self.phase + inc * n)
        self.phase = (self.phase + inc * B) % (2 * np.pi)
        return _read(buf, H + n - (self.base + amount * self.depth * lfo))


class Chorus:
    """Хор: три слегка расстроенные и задержанные копии голоса."""

    VOICES = ((0.015, 0.6), (0.021, 0.9), (0.027, 1.3))  # (задержка, частота LFO)

    def __init__(self, sr):
        self.sr = sr
        self.depth = sr * 0.003
        self.hist = np.zeros(int(sr * 0.03 + self.depth) + 3, dtype=F32)
        self.phases = [0.0, 2.0, 4.0]

    def process(self, x, amount):
        B, H = len(x), len(self.hist)
        buf = np.concatenate([self.hist, x])
        self.hist = buf[-H:]
        if amount <= 0:
            return x
        n = np.arange(B)
        wet = np.zeros(B, dtype=F32)
        for k, (delay, rate) in enumerate(self.VOICES):
            inc = 2 * np.pi * rate / self.sr
            lfo = np.sin(self.phases[k] + inc * n)
            self.phases[k] = (self.phases[k] + inc * B) % (2 * np.pi)
            wet += _read(buf, H + n - (delay * self.sr + self.depth * lfo))
        return (x + wet * amount) / (1 + amount * 1.7)


class Reverb:
    """Реверберация Шрёдера: 4 гребенчатых фильтра + 2 фазовращателя."""

    COMBS_MS = (29.7, 37.1, 41.1, 43.7)
    ALLPASS_MS = (12.1, 17.3)

    def __init__(self, sr):
        self.combs = [np.zeros(int(sr * ms / 1000) + 1, dtype=F32) for ms in self.COMBS_MS]
        self.allpass = [np.zeros(int(sr * ms / 1000), dtype=F32) for ms in self.ALLPASS_MS]

    def process(self, x, amount):
        B = len(x)
        fb = 0.72 + 0.22 * amount
        wet = np.zeros(B, dtype=F32)
        for k, buf in enumerate(self.combs):
            D, L = len(buf) - 1, len(buf)
            d0 = buf[L - D:L - D + B]
            d1 = buf[L - D - 1:L - D - 1 + B]
            damped = 0.6 * d0 + 0.4 * d1  # высокие частоты затухают быстрее
            self.combs[k] = np.concatenate([buf[B:], x + fb * damped])
            wet += damped
        wet *= 0.25
        for k, buf in enumerate(self.allpass):
            vd = buf[:B]
            v = wet + 0.5 * vd
            wet = -0.5 * v + vd
            self.allpass[k] = np.concatenate([buf[B:], v])
        if amount <= 0:
            return x
        return x * (1 - 0.45 * amount) + wet * amount * 0.9


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
        carrier = np.sin(self.phase + inc * n).astype(F32)
        self.phase = (self.phase + inc * len(x)) % (2 * np.pi)
        return x * (1 - amount) + x * carrier * amount * 1.6


def bitcrush(x, amount):
    """Звук старой приставки: меньше бит и меньше частота дискретизации."""
    if amount <= 0:
        return x
    k = (1, 2, 4, 8)[min(3, int(amount * 4))]
    held = np.repeat(x[::k], k)[:len(x)]
    levels = 2 ** (12 - 8 * amount)
    crushed = np.round(held * levels) / levels
    return x * (1 - amount) + crushed * amount


class Radio:
    """Полосовой FIR-фильтр 300–3400 Гц: звук рации / телефона."""

    def __init__(self, sr, taps=129):
        t = np.arange(taps) - (taps - 1) / 2

        def lowpass(fc):
            return 2 * fc / sr * np.sinc(2 * fc / sr * t)

        h = (lowpass(3400) - lowpass(300)) * np.hamming(taps)
        self.h = h.astype(F32)
        self.state = np.zeros(taps - 1, dtype=F32)

    def process(self, x, amount):
        buf = np.concatenate([self.state, x])
        self.state = buf[-len(self.state):]
        if amount <= 0:
            return x
        y = np.convolve(buf, self.h, mode="valid").astype(F32)
        y = np.tanh(y * 3.0) * 0.6
        return x * (1 - amount) + y * amount


class Echo:
    """Эхо с обратной связью."""

    def __init__(self, sr, max_ms=1000):
        self.sr = sr
        self.buf = np.zeros(int(sr * max_ms / 1000), dtype=F32)

    def process(self, x, amount, delay_ms):
        B = len(x)
        D = min(max(int(self.sr * delay_ms / 1000), B), len(self.buf))
        start = len(self.buf) - D
        y = x + self.buf[start:start + B] * amount
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
        g = np.linspace(self.gain, new_gain, len(x), dtype=F32)
        self.gain = new_gain
        return x * g


class Dynamics:
    """
    Компрессор + усиление + лимитер.
    Компрессор выравнивает тихие и громкие слова, усиление делает голос
    громче, а лимитер не даёт ему хрипеть и «клиповать».
    """

    CHUNK = 32

    def __init__(self, sr):
        t = self.CHUNK / sr
        self.att = np.exp(-t / 0.005)
        self.rel = np.exp(-t / 0.15)
        self.lim_rel = np.exp(-t / 0.08)
        self.env_db = -60.0
        self.gain = 1.0
        self.lim = 1.0

    def process(self, x, enhance, boost_db):
        B, C = len(x), self.CHUNK
        pad = (-B) % C
        chunks = np.pad(x, (0, pad)).reshape(-1, C)

        # компрессор (порог и степень сжатия зависят от «улучшения»)
        thr = -14.0 - 16.0 * enhance
        ratio = 1.0 + 4.0 * enhance
        makeup = -thr * (1 - 1 / ratio) * 0.7
        levels = 10 * np.log10(np.mean(chunks ** 2, axis=1) + 1e-10)
        gains = np.empty(len(chunks))
        for i, lvl in enumerate(levels):
            a = self.att if lvl > self.env_db else self.rel
            self.env_db = a * self.env_db + (1 - a) * lvl
            reduction = max(0.0, self.env_db - thr) * (1 - 1 / ratio)
            gains[i] = 10 ** ((makeup - reduction + boost_db) / 20)
        chunks = chunks * self._ramp(gains, "gain")

        # лимитер: пики не выше -1 дБ
        peaks = np.abs(chunks).max(axis=1)
        lims = np.empty(len(chunks))
        for i, peak in enumerate(peaks):
            target = min(1.0, 0.89 / (peak + 1e-9))
            self.lim = target if target < self.lim else self.lim_rel * self.lim + (1 - self.lim_rel) * target
            lims[i] = self.lim
        y = (chunks * self._ramp(lims, "lim")).reshape(-1)[:B]

        # мягкое ограничение того, что всё-таки проскочило
        a = np.abs(y)
        knee = np.sign(y) * (0.8 + 0.2 * np.tanh((a - 0.8) / 0.2))
        return np.where(a > 0.8, knee, y).astype(F32)

    def _ramp(self, values, attr):
        """Плавный переход коэффициента между кусками, чтобы не было щелчков."""
        start = np.concatenate([[getattr(self, "_last_" + attr, values[0])], values[:-1]])
        setattr(self, "_last_" + attr, values[-1])
        if attr == "lim":  # лимитер прижимает пик сразу, а отпускает плавно
            start = np.minimum(start, values)
        t = (np.arange(self.CHUNK) + 1) / self.CHUNK
        return (start[:, None] + (values - start)[:, None] * t).astype(F32)


# ----------------------------------------------------------------- голоса ---

# Параметры «голоса» — их меняют пресеты.
VOICE_DEFAULTS = {
    "pitch": 0.0,         # высота тона, полутоны
    "formant": 0.0,       # тембр (размер «головы»), полутоны
    "whisper": 0.0,       # 0..1
    "vibrato": 0.0,       # глубина дрожания 0..1
    "vibrato_rate": 5.0,  # Гц
    "robot": 0.0,         # 0..1
    "robot_freq": 60.0,   # Гц
    "crush": 0.0,         # 8-бит 0..1
    "radio": 0.0,         # 0..1
    "distortion": 0.0,    # 0..1
    "chorus": 0.0,        # 0..1
    "echo": 0.0,          # 0..0.9
    "echo_ms": 250.0,
    "reverb": 0.0,        # 0..1
    "lowpass": 20000.0,   # Гц, глухость
}

# Параметры «звука» — пресеты их не трогают, чтобы усиление сохранялось.
SOUND_DEFAULTS = {
    "enhance": 0.0,       # улучшение: эквалайзер + компрессор, 0..1
    "boost_db": 0.0,      # усиление, дБ
    "gate": 0.01,         # порог шумодава
}

LOUD_PRESET = {"enhance": 1.0, "boost_db": 12.0, "gate": 0.02}

PRESETS = {
    "Обычный": {},
    "Женский": {"pitch": 5, "formant": 2.5},
    "Мужской": {"pitch": -5, "formant": -2.5},
    "Ребёнок": {"pitch": 7, "formant": 4.5},
    "Подросток": {"pitch": 2, "formant": 2},
    "Бас": {"pitch": -3, "formant": -1.5, "lowpass": 7000},
    "Старик": {"pitch": -2, "formant": -1, "vibrato": 0.35, "vibrato_rate": 5.5,
               "whisper": 0.15, "lowpass": 6000},
    "Бабушка": {"pitch": 3, "formant": 1.5, "vibrato": 0.45, "vibrato_rate": 6,
                "whisper": 0.15, "lowpass": 6500},
    "Великан": {"pitch": -9, "formant": -6, "reverb": 0.4},
    "Гном": {"pitch": -3, "formant": 4},
    "Эльф": {"pitch": 4, "formant": 5, "chorus": 0.25, "reverb": 0.35},
    "Бурундук": {"pitch": 9, "formant": 9},
    "Мультяшка": {"pitch": 12, "formant": 3, "vibrato": 0.15, "vibrato_rate": 8},
    "Демон": {"pitch": -8, "formant": -4, "distortion": 0.35, "reverb": 0.3, "chorus": 0.3},
    "Монстр": {"pitch": -12, "formant": -8, "distortion": 0.5, "chorus": 0.4},
    "Зомби": {"pitch": -6, "formant": -2, "distortion": 0.3, "vibrato": 0.6,
              "vibrato_rate": 1.5, "whisper": 0.3, "lowpass": 3000},
    "Злодей в маске": {"pitch": -4, "formant": -3, "radio": 0.3, "reverb": 0.2,
                       "distortion": 0.15},
    "Робот": {"robot": 0.85, "robot_freq": 55, "echo": 0.15, "echo_ms": 60},
    "Андроид": {"robot": 0.5, "robot_freq": 120, "chorus": 0.5, "crush": 0.3},
    "Инопланетянин": {"pitch": 3, "formant": 6, "robot": 0.5, "robot_freq": 220,
                      "vibrato": 0.3, "vibrato_rate": 9},
    "Ретро 8-бит": {"pitch": 2, "crush": 1.0},
    "Шёпот": {"whisper": 1.0},
    "Призрак": {"whisper": 0.7, "pitch": -2, "reverb": 0.7, "vibrato": 0.3,
                "vibrato_rate": 2, "echo": 0.3, "echo_ms": 400},
    "Нервный": {"vibrato": 1.0, "vibrato_rate": 7},
    "Под водой": {"lowpass": 600, "vibrato": 0.6, "vibrato_rate": 1.5, "chorus": 0.5},
    "Хор": {"chorus": 1.0, "reverb": 0.3},
    "Рация": {"radio": 1.0, "distortion": 0.2},
    "Телефон": {"radio": 0.8, "crush": 0.2},
    "Мегафон": {"radio": 0.7, "distortion": 0.6, "reverb": 0.15},
    "Диктор": {"pitch": -2, "formant": -1, "reverb": 0.1},
    "Пещера": {"echo": 0.55, "echo_ms": 350, "reverb": 0.5},
    "Собор": {"reverb": 0.9},
}


class VoiceEngine:
    """Цепочка эффектов. Параметры можно менять на лету из другого потока."""

    def __init__(self, sr=SAMPLE_RATE):
        self.params = {**VOICE_DEFAULTS, **SOUND_DEFAULTS}
        self.gate = NoiseGate()
        self.pitch = PitchShifter(sr)
        self.spectral = Spectral(sr)
        self.vibrato = Vibrato(sr)
        self.robot = Robot(sr)
        self.radio = Radio(sr)
        self.chorus = Chorus(sr)
        self.echo = Echo(sr)
        self.reverb = Reverb(sr)
        self.dynamics = Dynamics(sr)

    def apply_preset(self, name):
        self.params.update(VOICE_DEFAULTS)
        self.params.update(PRESETS[name])

    def process(self, x):
        x = x.astype(F32)
        if len(x) > BLOCK_SIZE:
            return np.concatenate([self.process(x[i:i + BLOCK_SIZE])
                                   for i in range(0, len(x), BLOCK_SIZE)])
        p = self.params
        x = self.gate.process(x, p["gate"])
        x = self.pitch.process(x, p["pitch"])
        # сдвиг тона двигает и форманты — компенсируем до нужного тембра
        formant_ratio = 2.0 ** ((p["formant"] - p["pitch"]) / 12.0)
        x = self.spectral.process(x, formant_ratio, p["whisper"], p["enhance"], p["lowpass"])
        x = self.vibrato.process(x, p["vibrato"], p["vibrato_rate"])
        x = self.robot.process(x, p["robot"], p["robot_freq"])
        x = bitcrush(x, p["crush"])
        x = self.radio.process(x, p["radio"])
        if p["distortion"] > 0:
            drive = 1 + p["distortion"] * 15
            x = np.tanh(x * drive) / np.tanh(drive) * 0.8
        x = self.chorus.process(x, p["chorus"])
        x = self.echo.process(x, p["echo"], p["echo_ms"])
        x = self.reverb.process(x, p["reverb"])
        return self.dynamics.process(x, p["enhance"], p["boost_db"])


# ------------------------------------------------------- режим WAV-файла ---

def process_file(src, dst, preset, enhance=0.0, boost_db=0.0):
    with wave.open(src, "rb") as w:
        sr, ch, width = w.getframerate(), w.getnchannels(), w.getsampwidth()
        if width != 2:
            sys.exit("Поддерживаются только 16-битные WAV-файлы")
        data = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    mono = data.reshape(-1, ch).mean(axis=1).astype(F32) / 32768.0

    engine = VoiceEngine(sr)
    engine.apply_preset(preset)
    engine.params.update(gate=0.0, enhance=enhance, boost_db=boost_db)
    out = engine.process(mono)

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
    in_box = ttk.Combobox(dev_frame, textvariable=in_var, values=inputs, width=60, state="readonly")
    in_box.grid(row=0, column=1, **pad)
    ttk.Label(dev_frame, text="Вывод:").grid(row=1, column=0, sticky="w")
    out_var = tk.StringVar()
    out_box = ttk.Combobox(dev_frame, textvariable=out_var, values=outputs, width=60, state="readonly")
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
    preset_frame = ttk.LabelFrame(root, text="Голоса")
    preset_frame.grid(row=1, column=0, sticky="ew", **pad)
    current = tk.StringVar(value="Обычный")

    # --- ползунки во вкладках
    tabs = ttk.Notebook(root)
    tabs.grid(row=2, column=0, sticky="ew", **pad)
    sliders = {}
    spec = {
        "Голос": [
            ("pitch", "Высота тона (полутоны)", -12, 12),
            ("formant", "Тембр / форманты (полутоны)", -12, 12),
            ("whisper", "Шёпот", 0, 1),
            ("vibrato", "Дрожание", 0, 1),
            ("vibrato_rate", "Скорость дрожания (Гц)", 0.5, 10),
            ("lowpass", "Глухость (срез, Гц)", 300, 20000),
        ],
        "Эффекты": [
            ("robot", "Робот", 0, 1),
            ("robot_freq", "Частота робота (Гц)", 20, 400),
            ("crush", "8-бит", 0, 1),
            ("radio", "Рация", 0, 1),
            ("distortion", "Искажение", 0, 1),
            ("chorus", "Хор", 0, 1),
            ("echo", "Эхо", 0, 0.9),
            ("echo_ms", "Задержка эха (мс)", 30, 1000),
            ("reverb", "Реверберация (зал)", 0, 1),
        ],
        "Громкость и качество": [
            ("enhance", "Улучшение голоса", 0, 1),
            ("boost_db", "Усиление (дБ)", -12, 30),
            ("gate", "Шумодав", 0, 0.1),
        ],
    }
    for tab_name, rows in spec.items():
        tab = ttk.Frame(tabs)
        tabs.add(tab, text=tab_name)
        for row, (key, text, lo, hi) in enumerate(rows):
            ttk.Label(tab, text=text).grid(row=row, column=0, sticky="w", padx=8)
            var = tk.DoubleVar(value=engine.params[key])
            value_lbl = ttk.Label(tab, width=7)
            value_lbl.grid(row=row, column=2)

            def on_change(_=None, key=key, var=var, value_lbl=value_lbl):
                engine.params[key] = var.get()
                value_lbl.config(text=f"{var.get():.2f}")

            ttk.Scale(tab, from_=lo, to=hi, variable=var, length=320,
                      command=on_change).grid(row=row, column=1, padx=8, pady=2)
            on_change()
            sliders[key] = (var, on_change)

    def sync_sliders():
        for key, (var, on_change) in sliders.items():
            var.set(engine.params[key])
            on_change()

    def apply_preset(name):
        engine.apply_preset(name)
        current.set(name)
        sync_sliders()

    def set_sound(values):
        engine.params.update(values)
        sync_sliders()

    loud_tab = tabs.winfo_children()[-1]
    btns = ttk.Frame(loud_tab)
    btns.grid(row=len(spec["Громкость и качество"]), column=0, columnspan=3, sticky="w", **pad)
    ttk.Button(btns, text="🔊 Громкий и чистый голос",
               command=lambda: set_sound(LOUD_PRESET)).pack(side="left", padx=4)
    ttk.Button(btns, text="🔊🔊 Максимум",
               command=lambda: set_sound({**LOUD_PRESET, "boost_db": 24.0})).pack(side="left", padx=4)
    ttk.Button(btns, text="Сбросить",
               command=lambda: set_sound(SOUND_DEFAULTS)).pack(side="left", padx=4)
    ttk.Label(loud_tab, foreground="#666", text=(
        "Улучшение: убирает гул, добавляет разборчивость и выравнивает громкость.\n"
        "Лимитер не даст голосу хрипеть даже на максимальном усилении."
    )).grid(row=len(spec["Громкость и качество"]) + 1, column=0, columnspan=3, sticky="w", **pad)

    columns = 6
    for i, name in enumerate(PRESETS):
        ttk.Button(preset_frame, text=name, width=14,
                   command=lambda n=name: apply_preset(n)).grid(
            row=i // columns, column=i % columns, padx=3, pady=3, sticky="ew")

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
    ttk.Label(ctrl, text="Голос:").pack(side="left")
    ttk.Label(ctrl, textvariable=current, font=("", 10, "bold")).pack(side="left", padx=4)
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
    parser.add_argument("--preset", default="Обычный", choices=list(PRESETS),
                        help="голос для режима --file")
    parser.add_argument("--enhance", type=float, default=0.0,
                        help="улучшение голоса 0..1 для режима --file")
    parser.add_argument("--boost", type=float, default=0.0,
                        help="усиление в дБ для режима --file")
    parser.add_argument("--list-presets", action="store_true")
    args = parser.parse_args()

    if args.list_presets:
        print("\n".join(PRESETS))
    elif args.file:
        process_file(args.file[0], args.file[1], args.preset, args.enhance, args.boost)
    else:
        run_gui()


if __name__ == "__main__":
    main()
