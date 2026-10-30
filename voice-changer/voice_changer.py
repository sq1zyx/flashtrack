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

VOICE_GROUPS = {
    "Люди": ["Обычный", "Женский", "Мужской", "Ребёнок", "Подросток",
             "Бас", "Старик", "Бабушка", "Диктор", "Нервный"],
    "Персонажи": ["Великан", "Гном", "Эльф", "Бурундук", "Мультяшка",
                  "Демон", "Монстр", "Зомби", "Злодей в маске", "Призрак"],
    "Техника": ["Робот", "Андроид", "Инопланетянин", "Ретро 8-бит",
                "Рация", "Телефон", "Мегафон"],
    "Атмосфера": ["Шёпот", "Под водой", "Хор", "Пещера", "Собор"],
}

VOICE_INFO = {
    "Обычный": "без изменений",
    "Женский": "выше и мягче",
    "Мужской": "ниже и грубее",
    "Ребёнок": "тонкий, детский",
    "Подросток": "чуть моложе",
    "Бас": "глубокий и плотный",
    "Старик": "хриплый, с дрожью",
    "Бабушка": "старческий, выше",
    "Диктор": "как на радио",
    "Нервный": "голос дрожит",
    "Великан": "огромный и гулкий",
    "Гном": "низкий, но мелкий",
    "Эльф": "звонкий, лёгкий",
    "Бурундук": "быстрый писк",
    "Мультяшка": "смешной",
    "Демон": "низкий рык с эхом",
    "Монстр": "самый страшный",
    "Зомби": "хрипящий и глухой",
    "Злодей в маске": "через маску",
    "Призрак": "шёпот с эхом",
    "Робот": "металлический",
    "Андроид": "цифровой",
    "Инопланетянин": "странный, чужой",
    "Ретро 8-бит": "как из приставки",
    "Рация": "шипящая связь",
    "Телефон": "как в трубке",
    "Мегафон": "громкий и рваный",
    "Шёпот": "только шёпот",
    "Под водой": "глухо и плывёт",
    "Хор": "много голосов",
    "Пещера": "далёкое эхо",
    "Собор": "огромный зал",
}

# Цвета те же, что в версии для телефона
THEME = {
    "bg": "#0E1117", "panel": "#171B23", "card": "#222834", "card_hover": "#2C3342",
    "line": "#2A303B", "text": "#EDF0F5", "muted": "#98A0AF",
    "accent": "#FF6544", "accent_hover": "#FF7E61", "accent_text": "#1A0A05",
    "live": "#3DDC97", "danger": "#E5484D", "danger_hover": "#F0616A",
}


def _signed(v, unit):
    return f"{'+' if v > 0 else ''}{v:g} {unit}"


def _pct(v):
    return f"{round(v * 100)}%"


SLIDER_TABS = {
    "Голос": [
        ("pitch", "Высота тона", -12, 12, 48, lambda v: _signed(round(v * 2) / 2, "пт")),
        ("formant", "Тембр (размер голоса)", -12, 12, 48, lambda v: _signed(round(v * 2) / 2, "пт")),
        ("whisper", "Шёпот", 0, 1, 20, _pct),
        ("vibrato", "Дрожание", 0, 1, 20, _pct),
        ("vibrato_rate", "Скорость дрожания", 0.5, 10, 19, lambda v: f"{v:.1f} Гц"),
        ("lowpass", "Глухость", 300, 20000, 197,
         lambda v: "выкл" if v >= 19000 else f"{v / 1000:.1f} кГц"),
    ],
    "Эффекты": [
        ("robot", "Робот", 0, 1, 20, _pct),
        ("robot_freq", "Частота робота", 20, 400, 76, lambda v: f"{v:.0f} Гц"),
        ("crush", "8-бит", 0, 1, 20, _pct),
        ("radio", "Рация", 0, 1, 20, _pct),
        ("distortion", "Искажение", 0, 1, 20, _pct),
        ("chorus", "Хор", 0, 1, 20, _pct),
        ("echo", "Эхо", 0, 0.9, 18, _pct),
        ("echo_ms", "Задержка эха", 30, 1000, 97, lambda v: f"{v:.0f} мс"),
        ("reverb", "Зал (реверберация)", 0, 1, 20, _pct),
    ],
    "Громкость и качество": [
        ("enhance", "Улучшение голоса", 0, 1, 20, _pct),
        ("boost_db", "Усиление", -12, 30, 42, lambda v: _signed(round(v), "дБ")),
        ("gate", "Шумодав", 0, 0.1, 20, lambda v: "выкл" if v <= 0 else f"{v * 1000:.0f}"),
    ],
}


def run_gui():
    import os
    import webbrowser
    from tkinter import messagebox

    try:
        import customtkinter as ctk
    except ImportError:
        sys.exit("Нужен модуль интерфейса: pip install customtkinter")
    import sounddevice as sd

    T = THEME
    ctk.set_appearance_mode("dark")
    engine = VoiceEngine()
    state = {"stream": None, "level": 0.0, "shown": 0.0, "voice": "Обычный", "group": "Люди"}

    root = ctk.CTk(fg_color=T["bg"])
    root.title("Voice Changer")
    root.geometry("1180x760")
    root.minsize(1060, 700)
    root.grid_columnconfigure(1, weight=1)
    root.grid_rowconfigure(0, weight=1)

    def font(size, weight="normal"):
        return ctk.CTkFont(size=size, weight=weight)

    def caption(parent, text):
        return ctk.CTkLabel(parent, text=text, font=font(12, "bold"), text_color=T["muted"], anchor="w")

    def hint(parent, text, wrap=270):
        return ctk.CTkLabel(parent, text=text, font=font(12), text_color=T["muted"],
                            anchor="w", justify="left", wraplength=wrap)

    # ------------------------------------------------ устройства
    hostapis = sd.query_hostapis()
    devices = sd.query_devices()

    def device_lists(show_all):
        # MME есть на любом Windows и работает со всеми устройствами — показываем его,
        # остальные драйверы только по галочке, чтобы список не дублировался 3-4 раза
        mme = [i for i, a in enumerate(hostapis) if "MME" in a["name"]]
        ins, outs = {}, {}
        for i, d in enumerate(devices):
            if not show_all and mme and d["hostapi"] not in mme:
                continue
            name = d["name"] if not show_all else f"{d['name']}  ·  {hostapis[d['hostapi']]['name']}"
            if d["max_input_channels"] > 0:
                ins.setdefault(name, i)
            if d["max_output_channels"] > 0:
                outs.setdefault(name, i)
        return ins, outs

    inputs, outputs = device_lists(False)

    # ------------------------------------------------ левая панель
    side = ctk.CTkFrame(root, fg_color=T["panel"], corner_radius=0, width=330)
    side.grid(row=0, column=0, sticky="nsew")
    side.grid_propagate(False)
    side.grid_columnconfigure(0, weight=1)
    pad = {"padx": 24}

    ctk.CTkLabel(side, text="Voice Changer", font=font(26, "bold"), text_color=T["text"],
                 anchor="w").grid(row=0, column=0, sticky="ew", pady=(28, 0), **pad)
    hint(side, "Меняет голос в реальном времени —\nв наушниках, Discord и играх").grid(
        row=1, column=0, sticky="ew", pady=(4, 22), **pad)

    caption(side, "1   МИКРОФОН").grid(row=2, column=0, sticky="ew", **pad)
    in_menu = ctk.CTkOptionMenu(side, values=list(inputs) or ["Нет микрофона"], width=282, height=36,
                                dynamic_resizing=False, fg_color=T["card"], button_color=T["card"],
                                button_hover_color=T["card_hover"], dropdown_fg_color=T["card"],
                                text_color=T["text"], font=font(13))
    in_menu.grid(row=3, column=0, sticky="ew", pady=(6, 18), **pad)

    caption(side, "2   КУДА ВЫВОДИТЬ ГОЛОС").grid(row=4, column=0, sticky="ew", **pad)
    route = ctk.CTkSegmentedButton(side, values=["Наушники", "Discord и игры"], height=36, font=font(13),
                                   selected_color=T["accent"], selected_hover_color=T["accent_hover"],
                                   unselected_color=T["card"], unselected_hover_color=T["card_hover"],
                                   fg_color=T["card"], text_color=T["text"])
    route.grid(row=5, column=0, sticky="ew", pady=(6, 8), **pad)
    out_menu = ctk.CTkOptionMenu(side, values=list(outputs) or ["Нет устройства"], width=282, height=36,
                                 dynamic_resizing=False, fg_color=T["card"], button_color=T["card"],
                                 button_hover_color=T["card_hover"], dropdown_fg_color=T["card"],
                                 text_color=T["text"], font=font(13))
    out_menu.grid(row=6, column=0, sticky="ew", **pad)
    route_hint = hint(side, "")
    route_hint.grid(row=7, column=0, sticky="ew", pady=(8, 0), **pad)
    cable_btn = ctk.CTkButton(side, text="Установить VB-Cable", height=32, font=font(13),
                              fg_color=T["card"], hover_color=T["card_hover"], text_color=T["text"])
    show_all = ctk.BooleanVar(value=False)
    ctk.CTkCheckBox(side, text="Показать все драйверы", variable=show_all, font=font(12),
                    text_color=T["muted"], fg_color=T["accent"], hover_color=T["accent_hover"],
                    border_color=T["line"], checkbox_width=18, checkbox_height=18,
                    command=lambda: refresh_devices()).grid(row=9, column=0, sticky="w", pady=(10, 0), **pad)

    caption(side, "3   ВКЛЮЧИТЬ").grid(row=10, column=0, sticky="ew", pady=(24, 0), **pad)
    start_btn = ctk.CTkButton(side, text="▶  Старт", height=54, corner_radius=14, font=font(18, "bold"),
                              fg_color=T["accent"], hover_color=T["accent_hover"], text_color=T["accent_text"])
    start_btn.grid(row=11, column=0, sticky="ew", pady=(8, 10), **pad)
    status_row = ctk.CTkFrame(side, fg_color="transparent")
    status_row.grid(row=12, column=0, sticky="ew", **pad)
    status_row.grid_columnconfigure(1, weight=1)
    status_dot = ctk.CTkLabel(status_row, text="●", font=font(14), text_color=T["muted"], width=16)
    status_dot.grid(row=0, column=0)
    status_lbl = ctk.CTkLabel(status_row, text="Выключено", font=font(13), text_color=T["muted"], anchor="w")
    status_lbl.grid(row=0, column=1, sticky="w", padx=(4, 0))
    meter = ctk.CTkProgressBar(side, height=8, corner_radius=4, fg_color=T["card"], progress_color=T["live"])
    meter.set(0)
    meter.grid(row=13, column=0, sticky="ew", pady=(8, 0), **pad)

    side.grid_rowconfigure(14, weight=1)
    hint(side, "Совет: слушайте себя только в наушниках —\nс колонками будет свист.").grid(
        row=15, column=0, sticky="ew", pady=(0, 24), **pad)

    # ------------------------------------------------ основная часть
    main = ctk.CTkFrame(root, fg_color="transparent")
    main.grid(row=0, column=1, sticky="nsew", padx=28, pady=24)
    main.grid_columnconfigure(0, weight=1)
    main.grid_rowconfigure(3, weight=1)

    # карточка «сейчас»
    now = ctk.CTkFrame(main, fg_color=T["panel"], corner_radius=18)
    now.grid(row=0, column=0, sticky="ew")
    now.grid_columnconfigure(0, weight=1)
    caption(now, "СЕЙЧАС ВЫБРАН ГОЛОС").grid(row=0, column=0, sticky="w", padx=24, pady=(20, 0))
    voice_lbl = ctk.CTkLabel(now, text="", font=font(34, "bold"), text_color=T["text"], anchor="w")
    voice_lbl.grid(row=1, column=0, sticky="w", padx=24)
    voice_info = ctk.CTkLabel(now, text="", font=font(14), text_color=T["muted"], anchor="w")
    voice_info.grid(row=2, column=0, sticky="w", padx=24, pady=(0, 20))

    loud_box = ctk.CTkFrame(now, fg_color="transparent")
    loud_box.grid(row=0, column=1, rowspan=3, padx=20, pady=16, sticky="e")
    caption(loud_box, "ГРОМКОСТЬ").grid(row=0, column=0, columnspan=3, sticky="w", pady=(0, 6))
    loud_buttons = {}
    for col, (key, text) in enumerate((("normal", "Обычная"), ("loud", "Громкий и чистый"), ("max", "Максимум"))):
        b = ctk.CTkButton(loud_box, text=text, height=40, corner_radius=12, font=font(13, "bold"),
                          fg_color=T["card"], hover_color=T["card_hover"], text_color=T["text"],
                          width=96 if key != "loud" else 160)
        b.grid(row=1, column=col, padx=(0 if col == 0 else 8, 0))
        loud_buttons[key] = b
    loud_hint = hint(loud_box, "", wrap=380)
    loud_hint.grid(row=2, column=0, columnspan=3, sticky="w", pady=(8, 0))

    # выбор голоса
    head = ctk.CTkFrame(main, fg_color="transparent")
    head.grid(row=1, column=0, sticky="ew", pady=(24, 10))
    head.grid_columnconfigure(0, weight=1)
    ctk.CTkLabel(head, text="Голоса", font=font(20, "bold"), text_color=T["text"], anchor="w").grid(
        row=0, column=0, sticky="w")
    groups = ctk.CTkSegmentedButton(head, values=list(VOICE_GROUPS), height=34, font=font(13),
                                    selected_color=T["accent"], selected_hover_color=T["accent_hover"],
                                    unselected_color=T["panel"], unselected_hover_color=T["card"],
                                    fg_color=T["panel"], text_color=T["text"])
    groups.grid(row=0, column=1, sticky="e")

    grid = ctk.CTkFrame(main, fg_color="transparent")
    grid.grid(row=2, column=0, sticky="ew")
    COLS = 5
    for c in range(COLS):
        grid.grid_columnconfigure(c, weight=1, uniform="voice")
    cards = {}

    # тонкая настройка
    tabs = ctk.CTkTabview(main, fg_color=T["panel"], corner_radius=18,
                          segmented_button_fg_color=T["bg"], segmented_button_selected_color=T["card_hover"],
                          segmented_button_selected_hover_color=T["card_hover"],
                          segmented_button_unselected_color=T["bg"],
                          segmented_button_unselected_hover_color=T["card"], text_color=T["text"])
    tabs.grid(row=3, column=0, sticky="nsew", pady=(18, 0))
    sliders = {}
    for tab_name, rows in SLIDER_TABS.items():
        tab = tabs.add(tab_name)
        tab.grid_columnconfigure(1, weight=1)
        tab.grid_columnconfigure(4, weight=1)
        for i, (key, label, lo, hi, steps, fmt) in enumerate(rows):
            r, c = i % 5, (i // 5) * 3  # до 5 строк в колонке, потом вторая колонка
            ctk.CTkLabel(tab, text=label, font=font(13), text_color=T["text"], anchor="w", width=170).grid(
                row=r, column=c, sticky="w", padx=(16, 8), pady=7)
            value = ctk.CTkLabel(tab, text="", font=font(13), text_color=T["muted"], width=64, anchor="e")

            def on_change(v, key=key, fmt=fmt, value=value):
                engine.params[key] = float(v)
                value.configure(text=fmt(float(v)))
                if key in SOUND_DEFAULTS:
                    update_loud_buttons()

            s = ctk.CTkSlider(tab, from_=lo, to=hi, number_of_steps=steps, command=on_change, height=18,
                              button_color=T["accent"], button_hover_color=T["accent_hover"],
                              progress_color=T["accent"], fg_color=T["card"])
            s.grid(row=r, column=c + 1, sticky="ew", pady=7)
            value.grid(row=r, column=c + 2, sticky="e", padx=(8, 16))
            sliders[key] = (s, on_change)
    tabs.set("Голос")

    # ------------------------------------------------ логика
    def sync_sliders():
        for key, (s, on_change) in sliders.items():
            s.set(engine.params[key])
            on_change(engine.params[key])

    def voice_meta(name):
        p = PRESETS[name]
        parts = [VOICE_INFO[name]]
        if p.get("pitch"):
            parts.append(f"тон {_signed(p['pitch'], 'пт')}")
        if p.get("formant"):
            parts.append(f"тембр {_signed(p['formant'], 'пт')}")
        return "  ·  ".join(parts)

    def style_cards():
        for name, (card, title, sub) in cards.items():
            on = name == state["voice"]
            card.configure(fg_color=T["accent"] if on else T["card"])
            title.configure(text_color=T["accent_text"] if on else T["text"])
            sub.configure(text_color=T["accent_text"] if on else T["muted"])

    def make_card(name):
        card = ctk.CTkFrame(grid, fg_color=T["card"], corner_radius=14, height=70, cursor="hand2")
        card.grid_propagate(False)
        card.grid_columnconfigure(0, weight=1)
        card.grid_rowconfigure((0, 3), weight=1)
        title = ctk.CTkLabel(card, text=name, font=font(15, "bold"), anchor="w", height=20)
        title.grid(row=1, column=0, sticky="ew", padx=14)
        sub = ctk.CTkLabel(card, text=VOICE_INFO[name], font=font(12), anchor="w", height=16)
        sub.grid(row=2, column=0, sticky="ew", padx=14)

        def hover(on):
            if name != state["voice"]:
                card.configure(fg_color=T["card_hover"] if on else T["card"])

        for w in (card, title, sub):
            w.bind("<Button-1>", lambda e: select_voice(name))
            w.bind("<Enter>", lambda e: hover(True))
            w.bind("<Leave>", lambda e: hover(False))
        return card, title, sub

    def select_voice(name):
        state["voice"] = name
        engine.apply_preset(name)
        voice_lbl.configure(text=name)
        voice_info.configure(text=voice_meta(name))
        style_cards()
        sync_sliders()

    def show_group(group):
        state["group"] = group
        for w in grid.winfo_children():
            w.destroy()
        cards.clear()
        for i, name in enumerate(VOICE_GROUPS[group]):
            cards[name] = make_card(name)
            cards[name][0].grid(row=i // COLS, column=i % COLS, sticky="ew", padx=5, pady=5)
        style_cards()

    LOUD_LEVELS = {
        "normal": dict(SOUND_DEFAULTS),
        "loud": dict(LOUD_PRESET),
        "max": {**LOUD_PRESET, "boost_db": 24.0},
    }
    LOUD_HINTS = {
        "normal": "Голос как есть, без обработки громкости.",
        "loud": "Убирает гул, делает речь разборчивой и выравнивает громкость.",
        "max": "Очень громко. Лимитер не даёт голосу хрипеть.",
        None: "Настроено вручную во вкладке «Громкость и качество».",
    }

    def update_loud_buttons():
        current = None
        for key, values in LOUD_LEVELS.items():
            if all(abs(engine.params[k] - v) < 1e-6 for k, v in values.items()):
                current = key
        for key, b in loud_buttons.items():
            on = key == current
            b.configure(fg_color=T["accent"] if on else T["card"],
                        hover_color=T["accent_hover"] if on else T["card_hover"],
                        text_color=T["accent_text"] if on else T["text"])
        loud_hint.configure(text=LOUD_HINTS[current])

    def set_loud(key):
        engine.params.update(LOUD_LEVELS[key])
        sync_sliders()
        update_loud_buttons()

    for key, b in loud_buttons.items():
        b.configure(command=lambda k=key: set_loud(k))

    def find_cable():
        return next((n for n in outputs if "CABLE Input" in n), None)

    def install_cable():
        script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "install_vbcable.bat")
        if os.name == "nt" and os.path.exists(script):
            os.startfile(script)
        else:
            webbrowser.open("https://vb-audio.com/Cable/")

    cable_btn.configure(command=install_cable)

    def on_route(choice):
        cable_btn.grid_forget()
        if choice == "Discord и игры":
            cable = find_cable()
            if cable:
                out_menu.set(cable)
                route_hint.configure(text="В Discord, игре или OBS выберите микрофон\n«CABLE Output (VB-Audio Virtual Cable)».",
                                     text_color=T["text"])
            else:
                route_hint.configure(text="Нужен бесплатный драйвер VB-Cable. Установите его\nи перезагрузите компьютер.",
                                     text_color=T["accent"])
                cable_btn.grid(row=8, column=0, sticky="ew", pady=(8, 0), **pad)
        else:
            default_out = sd.default.device[1]
            name = next((n for n, i in outputs.items() if i == default_out), None)
            if name and "CABLE" not in name:
                out_menu.set(name)
            route_hint.configure(text="Вы слышите свой новый голос в наушниках.", text_color=T["muted"])
        restart_if_running()

    route.configure(command=on_route)

    def refresh_devices():
        nonlocal inputs, outputs
        inputs, outputs = device_lists(show_all.get())
        in_menu.configure(values=list(inputs) or ["Нет микрофона"])
        out_menu.configure(values=list(outputs) or ["Нет устройства"])
        pick_defaults()

    def pick_defaults():
        din, dout = sd.default.device
        for menu, items, default in ((in_menu, inputs, din), (out_menu, outputs, dout)):
            name = next((n for n, i in items.items() if i == default), None) or next(iter(items), None)
            if name:
                menu.set(name)

    in_menu.configure(command=lambda _: restart_if_running())
    out_menu.configure(command=lambda _: restart_if_running())

    def callback(indata, outdata, frames, time_info, status_flags):
        y = engine.process(indata[:, 0])
        outdata[:] = y[:, None]
        state["level"] = max(state["level"], float(np.abs(y).max()))

    def start():
        stop()
        try:
            in_dev = inputs[in_menu.get()]
            out_dev = outputs[out_menu.get()]
            out_ch = min(2, devices[out_dev]["max_output_channels"])
            stream = sd.Stream(
                device=(in_dev, out_dev), samplerate=SAMPLE_RATE, blocksize=BLOCK_SIZE,
                channels=(1, out_ch), dtype="float32", latency="low", callback=callback)
            stream.start()
        except KeyError:
            messagebox.showerror("Voice Changer", "Выберите микрофон и устройство вывода.")
            return
        except Exception as e:  # noqa: BLE001 — показываем пользователю любую ошибку звука
            messagebox.showerror("Voice Changer", "Не получилось включить звук:\n\n"
                                 f"{e}\n\nПопробуйте другой микрофон или включите «Показать все драйверы».")
            return
        state["stream"] = stream
        start_btn.configure(text="■  Стоп", fg_color=T["danger"], hover_color=T["danger_hover"], text_color="#FFFFFF")
        status_dot.configure(text_color=T["live"])
        status_lbl.configure(text="Работает — говорите", text_color=T["text"])

    def stop():
        if state["stream"] is not None:
            state["stream"].stop()
            state["stream"].close()
            state["stream"] = None
        start_btn.configure(text="▶  Старт", fg_color=T["accent"], hover_color=T["accent_hover"],
                            text_color=T["accent_text"])
        status_dot.configure(text_color=T["muted"])
        status_lbl.configure(text="Выключено", text_color=T["muted"])

    def restart_if_running():
        if state["stream"] is not None:
            start()

    start_btn.configure(command=lambda: stop() if state["stream"] else start())

    def poll_meter():
        # звук идёт в другом потоке — индикатор обновляем из интерфейса
        level, state["level"] = state["level"], 0.0
        state["shown"] = max(level, state["shown"] * 0.85)
        meter.set(min(1.0, state["shown"]))
        root.after(50, poll_meter)

    def on_close():
        stop()
        root.destroy()

    groups.configure(command=show_group)
    groups.set("Люди")
    show_group("Люди")
    select_voice("Обычный")
    pick_defaults()
    route.set("Наушники")
    on_route("Наушники")
    update_loud_buttons()
    poll_meter()
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
