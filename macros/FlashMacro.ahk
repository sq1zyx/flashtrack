; FlashMacro — макросы для клавиатуры и мыши (Fortnite) на AutoHotkey v2.
; Меню открывается при запуске и по клику на иконку в трее. Настройки сохраняются в config.ini.

#Requires AutoHotkey v2.0
#SingleInstance Force
#UseHook True
#MaxThreadsPerHotkey 1
InstallKeybdHook
InstallMouseHook
SendMode "Input"
SetKeyDelay -1, -1
SetMouseDelay -1
SetWinDelay -1
SetControlDelay -1
A_MaxHotkeysPerInterval := 5000
CoordMode "Mouse", "Screen"
ProcessSetPriority "High"

; Точность Sleep до ~1 мс вместо ~15 мс
DllCall("winmm\timeBeginPeriod", "UInt", 1)
OnExit((*) => DllCall("winmm\timeEndPeriod", "UInt", 1))

; ───── Подписка ─────
; Адрес сервера оплаты и проверки ключей (папка flashmacro-server), например "https://flashmacro.ru".
; Пусто — проверка подписки выключена и всё работает без ключа (для разработки).
LICENSE_API := ""
APP_VERSION := "3.1"
LIC_GRACE_H := 72      ; сколько часов программа работает без интернета после последней проверки

; ───────────────────────── Настройки по умолчанию ─────────────────────────
; Это же шаблон config.ini: порядок секций и ключей при сохранении берётся отсюда.

DEFAULT_INI := "
(
[General]
; Язык меню: ru или en (пусто — по языку Windows)
Language=
; Клавиша вкл/выкл всех макросов
SuspendKey=PgDn
; 1 = макросы работают только в окне Fortnite
OnlyInGame=1
GameExe=FortniteClient-Win64-Shipping.exe
; 1 = лог нажатий макросов (Settings → справа)
Debug=0
KeyHoldMs=5
ClickHoldMs=5
StartHidden=0
; Оформление: red, blue, purple, emerald, orange, pink, custom / dark, midnight, amoled
Theme=red
Base=dark
AccentColor=E11D2E
; 1 = короткие уведомления внизу экрана
ShowOSD=1
; Клавиша, открывающая меню поверх игры
MenuKey=Insert
MenuOnTop=1
; 1 = точка-индикатор в углу экрана (зелёная — макросы работают)
Indicator=0
Profile=Основной

[License]
Key=
Plan=
ExpiresTs=
LastOk=
; Свой адрес сервера (необязательно, иначе LICENSE_API из FlashMacro.ahk)
Api=
BuyUrl=

[Game]
; Твои бинды из настроек Fortnite
Edit=g
Select=LButton
Wall=z
Floor=x
Stairs=c
Cone=v
Crouch=LCtrl
Jump=Space
Sprint=LShift
Interact=e
Pickaxe=1
Slot1=2
Slot2=3
Slot3=4
Slot4=5
Slot5=6

[DragEdit]
Enabled=0
Trigger=g
ConfirmBy=release
EnterDelay=10
ConfirmDelay=10

[InfiniteEdit]
Enabled=0
Trigger=XButton1
ConfirmBy=release
EnterDelay=10
ConfirmDelay=10
StepDelay=0
FPS=240
FramesPerStep=3

[InstantEdit]
Enabled=0
Trigger=XButton2
ConfirmBy=release
EnterDelay=10
ConfirmDelay=10

[InstantBuild]
Enabled=0
WallTrigger=z
FloorTrigger=x
StairsTrigger=c
ConeTrigger=v
PlaceDelay=10
Continuous=0
StopKeys=1,2,3,4,5,6,LShift

[Competitive]
Enabled=0
PeekKey=RButton

[AutoSprint]
Enabled=0
Delay=10

[Pickup]
Enabled=0
Trigger=MButton
Delay=20

[RapidFire]
Enabled=0
Trigger=
Delay=30

[AntiAFK]
Enabled=0
Interval=60

[Optimize]
AutoGame=0
Lite=0

[Crosshair]
Enabled=0
ShowOnStart=1
ToggleKey=F9
Style=crossdot
Color=00FF00
Length=8
Thickness=2
Gap=4
DotSize=2
Radius=9
Opacity=100
Outline=0
OutlineColor=000000
OffsetX=0
OffsetY=0

; Пресеты и свои макросы. Sequence: число = пауза (мс), X = нажать,
; +X = зажать, -X = отпустить, {Имя} = бинд из [Game]
[Macro:WallRetake]
Enabled=0
Trigger=F1
Mode=once
Sequence={Wall}, 10, {Select}, 15, {Slot1}
Speed=1
Interval=10

[Macro:Prefire]
Enabled=0
Trigger=F2
Mode=once
Sequence={Edit}, 10, {Select}, 10, {Edit}, 15, {Slot1}, 20, {Select}
Speed=1
Interval=10

[Macro:SprintReset]
Enabled=0
Trigger=F3
Mode=once
Sequence={Sprint}, 30, {Sprint}
Speed=1
Interval=10

[Macro:Mantle]
Enabled=0
Trigger=F4
Mode=once
Sequence=+{Sprint}, 20, {Jump}, 60, -{Sprint}
Speed=1
Interval=10

[Macro:SimpleEdit]
Enabled=0
Trigger=F5
Mode=once
Sequence={Edit}, 10, {Select}, 10, {Edit}
Speed=1
Interval=10

[Macro:CrouchPeek]
Enabled=0
Trigger=F6
Mode=once
Sequence={Crouch}, 120, {Crouch}
Speed=1
Interval=10
)"

CFG := A_ScriptDir "\config.ini"
TPL := NewMap()
ParseInto(DEFAULT_INI, TPL)
C := NewMap()
ParseInto(DEFAULT_INI, C)
if FileExist(CFG)
    ParseInto(FileRead(CFG, "UTF-8"), C)
SaveIni()

PRESETS := ["WallRetake", "Prefire", "SprintReset", "Mantle", "SimpleEdit", "CrouchPeek"]
BUILTIN := [
    {sec: "DragEdit", name: "Drag edit"},
    {sec: "InfiniteEdit", name: "Infinite edit"},
    {sec: "InstantEdit", name: "Instant edit"},
    {sec: "InstantBuild", name: "Instant build", badge: "BUILD"},
    {sec: "Macro:WallRetake", name: "Wall retake"},
    {sec: "Macro:Prefire", name: "Prefire"},
    {sec: "Macro:SprintReset", name: "Sprint reset"},
    {sec: "Macro:Mantle", name: "Mantle"},
    {sec: "Macro:SimpleEdit", name: "Simple edit"},
    {sec: "Macro:CrouchPeek", name: "Crouch peek"},
    {sec: "Pickup", name: "Pick-up"},
    {sec: "RapidFire", name: "Rapid fire"},
    {sec: "AutoSprint", name: "Auto sprint", badge: "AUTO"},
    {sec: "Competitive", name: "Competitive", badge: "PEEK"},
    {sec: "AntiAFK", name: "Anti-AFK", badge: "AFK"},
]

; Состояние движка
Registered := []
Used := Map()
Macros := []
Placing := false
DebugOn := false
HoldMs := 5
ClickHold := 5
Pressed := Map()
Stats := NewMap(), StatsVer := 0
PROF_DEFAULT := "Основной"
PrevWin := 0
IFEO_KEY := "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\FortniteClient-Win64-Shipping.exe\PerfOptions"
KERNEL_KEY := "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\kernel"
GFX_KEY := "HKLM\SYSTEM\CurrentControlSet\Control\GraphicsDrivers"
LAYERS_KEY := "HKCU\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers"
DVR_KEY1 := "HKCU\System\GameConfigStore"
DVR_KEY2 := "HKCU\Software\Microsoft\Windows\CurrentVersion\GameDVR"
GAMEBAR_KEY := "HKCU\Software\Microsoft\GameBar"
PLAN_ULT := "e9a42b02-d5df-448d-aa00-03f14749eb61", PLAN_HIGH := "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c", PLAN_BAL := "381b4222-f694-41f0-9685-ff5bb260df2e"
OptCache := Map(), GameRunning := false

; Состояние интерфейса
THEME_ORDER := ["red", "blue", "purple", "emerald", "orange", "pink"]
THEMES := Map("red", ["Красная", "E11D2E", "3A1217", "7A1A24"], "blue", ["Синяя", "3B82F6", "14233F", "1E3A6E"]
    , "purple", ["Фиолетовая", "8B5CF6", "241A3D", "45307A"], "emerald", ["Изумрудная", "10B981", "0F2E25", "145C46"]
    , "orange", ["Оранжевая", "F97316", "3A1E0C", "7A3A12"], "pink", ["Розовая", "EC4899", "3A1328", "7A1F4F"])
BASES := Map("dark", ["0E0E11", "121216", "17171C", "1C1C22", "26262D", "2A2A31"]
    , "midnight", ["0B0F1A", "0F1424", "141A2E", "182036", "222B45", "263052"]
    , "amoled", ["000000", "08080A", "0E0E11", "131316", "1E1E23", "25252B"])
CLR := MakePalette()
W := 1120, H := 740
UI := 0, WB := 0, Wnd := 0, DPI := 1, UIShown := false
XG := 0, XR := []
XVisible := Bool("Crosshair", "ShowOnStart", true)
if (Get("General", "Language") = "") {
    SetVal("General", "Language", (A_Language ~= "^(0419|0422|0423|043F|0428|0443)$") ? "ru" : "en")
    SaveIni()
}
Lic := LicFromCache()
LastLang := Lang()
CurPage := "Dashboard"
FORMS := Map(), HintText := Map(), OsdG := 0, LogLines := [], ImportFound := Map()
SEQ_HELP := "Последовательность через запятую: число — пауза в мс, X — нажать, +X — зажать, -X — отпустить, {Edit} — бинд со страницы Keybinds. Пример: {Wall}, 10, LButton, 15, {Slot1}"

ApplyEngine()
BuildOverlay()
InitForms()
InitHints()
BuildUI()
SetupTray()
UpdateCrosshair()
if Bool("Optimize", "AutoGame")
    SetTimer(GameWatch, 3000)
SetTimer(LicenseCheck, -300)
SetTimer(LicPeriodic, 6 * 3600 * 1000)
if !Bool("General", "StartHidden")
    ShowUI()
Notify("FlashMacro запущен")

; ───────────────────────── Конфиг ─────────────────────────

NewMap() {
    m := Map()
    m.CaseSense := "Off"
    return m
}

ParseInto(text, cfg) {
    sec := ""
    for line in StrSplit(text, "`n", "`r") {
        line := Trim(line)
        if (line = "" || SubStr(line, 1, 1) = ";")
            continue
        if RegExMatch(line, "^\[(.+)\]$", &m) {
            sec := Trim(m[1])
            if !cfg.Has(sec)
                cfg[sec] := NewMap()
            continue
        }
        if (sec != "" && (p := InStr(line, "=")))
            cfg[sec][Trim(SubStr(line, 1, p - 1))] := RegExReplace(Trim(SubStr(line, p + 1)), "\s+;.*$")
    }
}

SaveIni(path := "") {
    out := "", sec := ""
    for line in StrSplit(DEFAULT_INI, "`n", "`r") {
        t := Trim(line)
        if RegExMatch(t, "^\[(.+)\]$", &m) {
            out .= Extras(sec, TPL.Has(sec) ? TPL[sec] : Map())
            sec := m[1]
            out .= t "`r`n"
            continue
        }
        if (sec != "" && SubStr(t, 1, 1) != ";" && (p := InStr(t, "="))) {
            k := Trim(SubStr(t, 1, p - 1))
            out .= k "=" Get(sec, k) "`r`n"
            continue
        }
        out .= t "`r`n"
    }
    out .= Extras(sec, TPL.Has(sec) ? TPL[sec] : Map())
    order := ["Enabled", "Trigger", "Mode", "Sequence", "Speed", "Interval"]
    known := NewMap()
    for k in order
        known[k] := true
    for s, keys in C {
        if TPL.Has(s)
            continue
        out .= "`r`n[" s "]`r`n"
        for k in order
            if keys.Has(k)
                out .= k "=" keys[k] "`r`n"
        out .= Extras(s, known)
    }
    try {
        f := FileOpen(path != "" ? path : CFG, "w", "UTF-8-RAW")
        f.Write(out)
        f.Close()
    } catch Error as e {
        Notify("Не удалось сохранить config.ini: " e.Message)
    }
}

; Ключи секции, которых нет в шаблоне
Extras(sec, known) {
    s := ""
    if (sec = "" || !C.Has(sec))
        return s
    for k, v in C[sec]
        if !known.Has(k)
            s .= k "=" v "`r`n"
    return s
}

Get(sec, key, def := "") {
    return (C.Has(sec) && C[sec].Has(key) && C[sec][key] != "") ? C[sec][key] : def
}

SetVal(sec, key, v) {
    if (sec = "")
        return
    if !C.Has(sec)
        C[sec] := NewMap()
    C[sec][key] := v
}

Num(sec, key, def) {
    v := Get(sec, key, def)
    return IsNumber(v) ? Number(v) : def
}

ToBool(v) {
    v := StrLower(String(v))
    return v = "1" || v = "true" || v = "on" || v = "yes"
}

Bool(sec, key, def := false) => ToBool(Get(sec, key, def ? "1" : "0"))

; Игровой бинд из секции [Game]
B(name) => Get("Game", name, "")

IsPreset(sec) {
    for p in PRESETS
        if (sec = "Macro:" p)
            return true
    return false
}

CustomList() {
    r := []
    for s in C
        if (s ~= "i)^Macro:") && !IsPreset(s)
            r.Push(s)
    return r
}

; ───────────────────────── Ввод ─────────────────────────

IsMouse(k) => k ~= "i)^([LRM]Button|XButton[12]|Wheel(Up|Down|Left|Right))$"
IsWheel(k) => k ~= "i)^Wheel"
Held(k) => k != "" && !IsWheel(k) && GetKeyState(k, "P")

Norm(k) {
    if (k = "")
        return ""
    n := GetKeyName(k)
    return StrLower(n != "" ? n : k)
}

Down(k) {
    if (k = "")
        return
    SendInput(IsWheel(k) ? "{Blind}{" k "}" : "{Blind}{" k " down}")
    if UIShown
        Pressed[Norm(k)] := {down: !IsWheel(k), t: A_TickCount}
    DebugLog(k " down")
}

Up(k) {
    if (k = "" || IsWheel(k))
        return
    SendInput "{Blind}{" k " up}"
    if UIShown
        Pressed[Norm(k)] := {down: false, t: A_TickCount}
    DebugLog(k " up")
}

Tap(k, hold := -1) {
    if (hold < 0)
        hold := IsMouse(k) ? ClickHold : HoldMs
    Down(k)
    Wait(hold)
    Up(k)
}

Wait(ms) {
    if (ms > 0)
        Sleep Round(ms)
}

; ───────────────────────── Регистрация горячих клавиш ─────────────────────────

; ctx: "" — везде, "*" — везде, кроме окна FlashMacro, иначе — имя процесса игры
SetCtx(ctx) {
    if (ctx = "")
        HotIf()
    else if (ctx = "*")
        HotIf(NotInMenu)
    else
        HotIfWinActive("ahk_exe " ctx)
}

NotInMenu(*) => !(UI && WinActive("ahk_id " UI.Hwnd))

Reg(ctx, trig, fn, owner, opts := "S0") {
    if (trig = "")
        return false
    k := StrLower(trig)
    if Used.Has(k) {
        Notify(KeyLabel(trig) " уже занята (" Used[k] "), " owner " не назначен")
        return false
    }
    ok := RegRaw(ctx, (IsMouse(trig) ? "*" : "$*") trig, fn, opts)
    if ok
        Used[k] := owner
    else
        Notify("Не удалось назначить клавишу " trig " (" owner ")")
    return ok
}

RegRaw(ctx, name, fn, opts := "S0") {
    SetCtx(ctx)
    ok := true
    try {
        Hotkey(name, fn, "On " opts)
        Registered.Push({name: name, ctx: ctx})
    } catch
        ok := false
    HotIf()
    return ok
}

ApplyEngine() {
    global Registered, Used, Macros, DebugOn, HoldMs, ClickHold
    StopPlace()
    for m in Macros
        if m.active
            SetTimer(m.timer, 0)
    for h in Registered {
        SetCtx(h.ctx)
        try Hotkey(h.name, "Off")
    }
    HotIf()
    Registered := [], Used := Map(), Macros := []
    DebugOn := Bool("General", "Debug")
    HoldMs := Num("General", "KeyHoldMs", 5)
    ClickHold := Num("General", "ClickHoldMs", 5)
    if !DebugOn
        ToolTip(, , , 2)

    ; Глобальные клавиши
    Reg("", Get("General", "SuspendKey"), ToggleSuspend, "Macros toggle", "S")
    Reg("", Get("General", "MenuKey"), ToggleMenu, "Open menu", "S")
    if Bool("Crosshair", "Enabled")
        Reg("", Get("Crosshair", "ToggleKey"), ToggleCrosshair, "Crosshair toggle")

    ; Без активной подписки работают только меню, клавиши меню и оптимизация
    if !Lic.ok {
        SetTimer(AntiAFKTick, 0)
        return
    }

    ctx := Bool("General", "OnlyInGame", true) ? Get("General", "GameExe", "FortniteClient-Win64-Shipping.exe") : "*"

    if Bool("DragEdit", "Enabled") {
        t := Get("DragEdit", "Trigger")
        Reg(ctx, t, Counted.Bind("DragEdit", DragEdit.Bind(t)), "Drag edit")
    }
    if Bool("InfiniteEdit", "Enabled") {
        t := Get("InfiniteEdit", "Trigger")
        Reg(ctx, t, Counted.Bind("InfiniteEdit", InfiniteEdit.Bind(t)), "Infinite edit")
    }
    if Bool("InstantEdit", "Enabled")
        Reg(ctx, Get("InstantEdit", "Trigger"), Counted.Bind("InstantEdit", InstantEdit), "Instant edit")
    if Bool("InstantBuild", "Enabled") {
        for piece in ["Wall", "Floor", "Stairs", "Cone"]
            Reg(ctx, Get("InstantBuild", piece "Trigger"), Counted.Bind("InstantBuild", Build.Bind(piece)), "Instant build")
    }
    if Bool("Pickup", "Enabled") {
        t := Get("Pickup", "Trigger")
        Reg(ctx, t, Counted.Bind("Pickup", Pickup.Bind(t)), "Pick-up")
    }
    if Bool("RapidFire", "Enabled") {
        t := Get("RapidFire", "Trigger")
        Reg(ctx, t, Counted.Bind("RapidFire", RapidFire.Bind(t)), "Rapid fire")
    }
    SetTimer(AntiAFKTick, Bool("AntiAFK", "Enabled") ? 5000 : 0)

    ; Переназначение клавиш: секции [Remap:N]
    for sec in C {
        if !(sec ~= "i)^Remap:") || !Bool(sec, "Enabled")
            continue
        from := Get(sec, "From"), to := Get(sec, "To")
        if (from = "" || to = "")
            continue
        if Reg(ctx, from, RemapKey.Bind(to, "down"), "Remap → " KeyLabel(to))
            RegRaw(ctx, (IsMouse(from) ? "*" : "$*") from " up", RemapKey.Bind(to, "up"))
    }

    ; Пресеты и свои макросы: секции [Macro:Имя]
    for sec in C {
        if !(sec ~= "i)^Macro:") || !Bool(sec, "Enabled")
            continue
        m := {}
        m.name := SubStr(sec, 7)
        m.mode := StrLower(Get(sec, "Mode", "once"))
        m.steps := ParseSeq(Get(sec, "Sequence"))
        m.speed := Max(Num(sec, "Speed", 1), 0.1)
        m.interval := Num(sec, "Interval", 10)
        m.active := false
        m.timer := RunOnce.Bind(m)
        Macros.Push(m)
        t := Get(sec, "Trigger")
        Reg(ctx, t, Counted.Bind(sec, MacroPress.Bind(m, t)), m.name)
    }

    ; Непрерывная стройка: эти клавиши отпускают «ЛКМ» (сами клавиши проходят в игру)
    if Bool("InstantBuild", "Enabled") && Bool("InstantBuild", "Continuous") {
        for k in StrSplit(Get("InstantBuild", "StopKeys"), ",", " `t")
            if (k != "" && !Used.Has(StrLower(k)))
                RegRaw(ctx, "~*" k, (*) => StopPlace())
        sel := B("Select")
        if (sel != "" && !Used.Has(StrLower(sel)))
            RegRaw(ctx, "~*" sel " up", PlaceReleased)
    }
}

; ───────────────────────── Макросы ─────────────────────────

; Считает срабатывания для карточек на Dashboard
Counted(sec, fn, args*) {
    global StatsVer
    Stats[sec] := Stats.Get(sec, 0) + 1
    StatsVer++
    fn(args*)
}

RemapKey(to, dir, *) {
    if IsWheel(to) {
        if (dir = "down")
            SendInput "{Blind}{" to "}"
        return
    }
    SendInput "{Blind}{" to " " dir "}"
}

; Пока держишь — кликает «Выбор/выстрел» с заданным интервалом
RapidFire(trig, *) {
    StopPlace()
    loop {
        Tap(B("Select"))
        Wait(Num("RapidFire", "Delay", 30))
    } until !Held(trig)
}

; Если долго нет ввода, подпрыгивает, чтобы игра не выкинула за бездействие
AntiAFKTick() {
    global StatsVer
    if A_IsSuspended || !WinActive("ahk_exe " Get("General", "GameExe", "FortniteClient-Win64-Shipping.exe"))
        return
    if (A_TimeIdlePhysical < Max(Num("AntiAFK", "Interval", 60), 10) * 1000)
        return
    Tap(B("Jump"))
    Stats["AntiAFK"] := Stats.Get("AntiAFK", 0) + 1
    StatsVer++
}

AutoSprint() {
    if Bool("AutoSprint", "Enabled") {
        Wait(Num("AutoSprint", "Delay", 10))
        Tap(B("Sprint"))
    }
}

StopPlace() {
    global Placing
    if Placing {
        Placing := false
        Up(B("Select"))
    }
}

PlaceReleased(*) {
    global Placing
    Placing := false
}

; Competitive Mode: авто-подтверждение выключено, подтверждаем клавишей.
; Пока зажата клавиша peek — редакт остаётся открытым (можно смотреть сквозь конус).
Confirm(sec) {
    comp := Bool("Competitive", "Enabled")
    if !comp && Get(sec, "ConfirmBy", "release") != "key"
        return
    Wait(Num(sec, "ConfirmDelay", 10))
    if comp {
        peek := Get("Competitive", "PeekKey")
        while Held(peek)
            Sleep 5
    }
    Tap(B("Edit"))
}

; Одно редактирование: войти в редактирование → выбрать тайл → подтвердить
EditCycle(sec) {
    Tap(B("Edit"))
    Wait(Num(sec, "EnterDelay", 10))
    Tap(B("Select"))
    Confirm(sec)
}

; Зажал триггер — вошёл в редактирование и держишь выбор; отпустил — подтверждение
DragEdit(trig, *) {
    StopPlace()
    Tap(B("Edit"))
    Wait(Num("DragEdit", "EnterDelay", 10))
    Down(B("Select"))
    if !IsWheel(trig)
        KeyWait trig
    Up(B("Select"))
    Confirm("DragEdit")
    AutoSprint()
}

InstantEdit(*) {
    StopPlace()
    EditCycle("InstantEdit")
    AutoSprint()
}

; Пока держишь — повторяет одиночные редакты с частотой, привязанной к FPS
InfiniteEdit(trig, *) {
    StopPlace()
    step := Num("InfiniteEdit", "StepDelay", 0)
    if (step <= 0)
        step := 1000 / Max(Num("InfiniteEdit", "FPS", 240), 30) * Num("InfiniteEdit", "FramesPerStep", 3)
    loop {
        EditCycle("InfiniteEdit")
        Wait(step)
    } until !Held(trig)
    AutoSprint()
}

Build(piece, *) {
    global Placing
    Tap(B(piece))
    if Placing                      ; ЛКМ уже зажата — достаточно сменить постройку
        return
    Wait(Num("InstantBuild", "PlaceDelay", 10))
    if Bool("InstantBuild", "Continuous") {
        Down(B("Select"))
        Placing := true
    } else {
        Tap(B("Select"))
        AutoSprint()
    }
}

Pickup(trig, *) {
    StopPlace()
    loop {
        Tap(B("Interact"))
        Wait(Num("Pickup", "Delay", 20))
    } until !Held(trig)
}

; Последовательность: "{Edit}, 10, LButton, +{Sprint}, 50, -{Sprint}"
;   число — пауза в мс; X — нажать; +X — зажать; -X — отпустить; {Имя} — бинд из [Game]
ParseSeq(s) {
    steps := []
    for t in StrSplit(s, ",", " `t") {
        if (t = "")
            continue
        if IsNumber(t) {
            steps.Push({op: "wait", ms: Number(t)})
            continue
        }
        op := "tap"
        c := SubStr(t, 1, 1)
        if ((c = "+" || c = "-") && StrLen(t) > 1) {
            op := (c = "+") ? "down" : "up"
            t := SubStr(t, 2)
        }
        if RegExMatch(t, "^\{(.+)\}$", &mm)
            t := B(mm[1])
        if (t != "")
            steps.Push({op: op, key: t})
    }
    return steps
}

RunSeq(steps, speed) {
    for st in steps {
        switch st.op {
            case "wait": Wait(st.ms / speed)
            case "down": Down(st.key)
            case "up": Up(st.key)
            default: Tap(st.key)
        }
    }
}

RunOnce(m) => RunSeq(m.steps, m.speed)

MacroPress(m, trig, *) {
    StopPlace()
    switch m.mode {
        case "repeat":
            loop {
                RunSeq(m.steps, m.speed)
                Wait(m.interval)
            } until !Held(trig)
        case "toggle":
            m.active := !m.active
            SetTimer m.timer, m.active ? Max(m.interval, 1) : 0
            Notify(m.name (m.active ? ": ВКЛ" : ": ВЫКЛ"))
        default:
            RunSeq(m.steps, m.speed)
    }
}

ToggleSuspend(*) {
    StopPlace()
    for m in Macros {
        if m.active {
            m.active := false
            SetTimer m.timer, 0
        }
    }
    Suspend(-1)
    Notify(A_IsSuspended ? "Макросы выключены" : "Макросы включены")
    PushState()
    UpdateIndicator()
}

; ───────────────────────── Импорт биндов из Fortnite ─────────────────────────
; Ищет пары ActionName/Key в конфигах игры. Если игра хранит бинды только
; в облаке/бинарном файле, ничего не найдётся — тогда бинды задаются вручную.

ImportFromFortnite(*) {
    global ImportFound
    dir := EnvGet("LOCALAPPDATA") "\FortniteGame\Saved\Config\WindowsClient"
    if !DirExist(dir) {
        try Wnd.importNone("Папка настроек Fortnite не найдена:`n" dir)
        return
    }
    rules := [["Edit", "i)edit"], ["Wall", "i)wall"], ["Floor", "i)floor"], ["Stairs", "i)stair"]
        , ["Cone", "i)roof|cone"], ["Crouch", "i)crouch"], ["Jump", "i)jump"], ["Sprint", "i)sprint"]
        , ["Interact", "i)interact|^use$"], ["Pickaxe", "i)harvest|pickaxe"]]
    found := Map()
    loop files dir "\*.ini" {
        txt := FileRead(A_LoopFileFullPath)
        pos := 1
        while (pos := RegExMatch(txt, 'i)ActionName="?([\w ]+)"?[^)\r\n]*?Key=(\w+)', &m, pos)) {
            pos += m.Len
            for r in rules
                if (m[1] ~= r[2]) && !found.Has(r[1]) && !(m[1] ~= "i)reset|release|toggle")
                    found[r[1]] := FromUEKey(m[2])
        }
    }
    ImportFound := found
    msg := "В файлах настроек Fortnite бинды не найдены — игра хранит их в своём формате. Укажи бинды вручную на этой странице."
    if found.Count {
        try Wnd.importAsk(Json(found))
    } else {
        try Wnd.importNone(msg)
    }
}

FromUEKey(k) {
    static m := Map("LeftMouseButton", "LButton", "RightMouseButton", "RButton", "MiddleMouseButton", "MButton"
        , "ThumbMouseButton", "XButton1", "ThumbMouseButton2", "XButton2", "SpaceBar", "Space"
        , "LeftShift", "LShift", "RightShift", "RShift", "LeftControl", "LCtrl", "RightControl", "RCtrl"
        , "LeftAlt", "LAlt", "RightAlt", "RAlt", "Tab", "Tab", "CapsLock", "CapsLock"
        , "MouseScrollUp", "WheelUp", "MouseScrollDown", "WheelDown"
        , "One", "1", "Two", "2", "Three", "3", "Four", "4", "Five", "5", "Six", "6", "Seven", "7", "Eight", "8", "Nine", "9", "Zero", "0")
    return m.Has(k) ? m[k] : StrLower(k)
}

; ───────────────────────── Прицел ─────────────────────────

BuildOverlay() {
    global XG
    DllCall("LoadLibrary", "str", "gdiplus", "ptr")
    si := Buffer(24, 0)
    NumPut("uint", 1, si)
    DllCall("gdiplus\GdiplusStartup", "ptr*", &tok := 0, "ptr", si, "ptr", 0)
    XG := Gui("+AlwaysOnTop -Caption +ToolWindow +E0x80020 -DPIScale")
}

CrossColor(key := "Color", def := "00FF00") {
    c := Get("Crosshair", key, def)
    return (c ~= "^[0-9A-Fa-f]{6}$") ? c : def
}

; Фигуры прицела относительно центра: линии, точка, кольцо
CrossShapes() {
    style := StrLower(Get("Crosshair", "Style", "crossdot"))
    len := Max(Round(Num("Crosshair", "Length", 8)), 1)
    th := Max(Round(Num("Crosshair", "Thickness", 2)), 1)
    gap := Max(Round(Num("Crosshair", "Gap", 4)), 0)
    dot := Max(Round(Num("Crosshair", "DotSize", 2)), 1)
    rad := Max(Round(Num("Crosshair", "Radius", 9)), 2)
    o := th // 2
    sh := {rects: [], dot: 0, ring: 0, th: th}
    if (style ~= "^(cross|crossdot|t|tdot|crosscircle)$") {
        sh.rects.Push([-gap - len, -o, len, th], [gap + (th & 1), -o, len, th], [-o, gap + (th & 1), th, len])
        if !(style ~= "^t")
            sh.rects.Push([-o, -gap - len, th, len])
    }
    if (style ~= "dot$")
        sh.dot := dot
    if (style ~= "circle")
        sh.ring := rad
    ext := Max(sh.rects.Length ? gap + len + 1 : 0, sh.dot / 2 + 1, sh.ring ? sh.ring + th : 0) + 3
    sh.size := Ceil(ext) * 2 + 1
    return sh
}

DrawCrosshair(x, y) {
    sh := CrossShapes()
    n := sh.size, c := n // 2
    alpha := Round(Max(Min(Num("Crosshair", "Opacity", 100), 100), 5) * 2.55)
    argb := (alpha << 24) | Integer("0x" CrossColor())
    oargb := (alpha << 24) | Integer("0x" CrossColor("OutlineColor", "000000"))
    bi := Buffer(40, 0)
    NumPut("uint", 40, "int", n, "int", -n, "ushort", 1, "ushort", 32, bi)
    hdc := DllCall("CreateCompatibleDC", "ptr", 0, "ptr")
    hbm := DllCall("CreateDIBSection", "ptr", hdc, "ptr", bi, "uint", 0, "ptr*", 0, "ptr", 0, "uint", 0, "ptr")
    obm := DllCall("SelectObject", "ptr", hdc, "ptr", hbm, "ptr")
    DllCall("gdiplus\GdipCreateFromHDC", "ptr", hdc, "ptr*", &g := 0)
    passes := Bool("Crosshair", "Outline") ? [[oargb, 1], [argb, 0]] : [[argb, 0]]
    for ps in passes {
        col := ps[1], e := ps[2]
        DllCall("gdiplus\GdipCreateSolidFill", "uint", col, "ptr*", &br := 0)
        DllCall("gdiplus\GdipSetSmoothingMode", "ptr", g, "int", 3)
        for r in sh.rects
            DllCall("gdiplus\GdipFillRectangle", "ptr", g, "ptr", br, "float", c + r[1] - e, "float", c + r[2] - e, "float", r[3] + 2 * e, "float", r[4] + 2 * e)
        DllCall("gdiplus\GdipSetSmoothingMode", "ptr", g, "int", 4)
        if sh.dot {
            d := sh.dot + 2 * e
            DllCall("gdiplus\GdipFillEllipse", "ptr", g, "ptr", br, "float", c + 0.5 - d / 2, "float", c + 0.5 - d / 2, "float", d, "float", d)
        }
        if sh.ring {
            DllCall("gdiplus\GdipCreatePen1", "uint", col, "float", sh.th + 2 * e, "int", 2, "ptr*", &pen := 0)
            rr := sh.ring
            DllCall("gdiplus\GdipDrawEllipse", "ptr", g, "ptr", pen, "float", c + 0.5 - rr, "float", c + 0.5 - rr, "float", rr * 2, "float", rr * 2)
            DllCall("gdiplus\GdipDeletePen", "ptr", pen)
        }
        DllCall("gdiplus\GdipDeleteBrush", "ptr", br)
    }
    DllCall("gdiplus\GdipDeleteGraphics", "ptr", g)
    pt := Buffer(8), sz := Buffer(8), src := Buffer(8, 0), blend := Buffer(4)
    NumPut("int", x - c, "int", y - c, pt)
    NumPut("int", n, "int", n, sz)
    NumPut("uchar", 0, "uchar", 0, "uchar", 255, "uchar", 1, blend)
    DllCall("UpdateLayeredWindow", "ptr", XG.Hwnd, "ptr", 0, "ptr", pt, "ptr", sz, "ptr", hdc, "ptr", src, "uint", 0, "ptr", blend, "uint", 2)
    DllCall("SelectObject", "ptr", hdc, "ptr", obm)
    DllCall("DeleteObject", "ptr", hbm)
    DllCall("DeleteDC", "ptr", hdc)
}

UpdateCrosshair() {
    if (Bool("Crosshair", "Enabled") && XVisible && Lic.ok) {
        XG.Show("NA")
        DrawCrosshair(A_ScreenWidth // 2 + Round(Num("Crosshair", "OffsetX", 0)), A_ScreenHeight // 2 + Round(Num("Crosshair", "OffsetY", 0)))
    } else
        XG.Hide()
}

ToggleCrosshair(*) {
    global XVisible
    XVisible := !XVisible
    UpdateCrosshair()
}

; ───────────────────────── Меню (HTML) ─────────────────────────
; Меню — страница ui.html во встроенном движке Windows (WebBrowser/IE11).
; Страница вызывает методы класса Bridge, а скрипт передаёт ей состояние через render().

MakePalette() {
    tid := Get("General", "Theme", "red")
    acc := (tid = "custom") ? Get("General", "AccentColor", "E11D2E") : (THEMES.Has(tid) ? THEMES[tid][2] : "E11D2E")
    bs := BASES.Has(Get("General", "Base", "dark")) ? BASES[Get("General", "Base", "dark")] : BASES["dark"]
    return {bg: bs[1], key: bs[5], text: "ECECF1", accent: acc}
}

BuildUI() {
    global UI, WB, Wnd, DPI
    DPI := A_ScreenDPI / 96
    SplitPath(A_AhkPath, &exe)
    ; Современный режим движка (IE11) для этой программы
    try RegWrite(11001, "REG_DWORD", "HKCU\Software\Microsoft\Internet Explorer\Main\FeatureControl\FEATURE_BROWSER_EMULATION", exe)
    try RegWrite(1, "REG_DWORD", "HKCU\Software\Microsoft\Internet Explorer\Main\FeatureControl\FEATURE_GPU_RENDERING", exe)
    UI := Gui("-Caption -Border -MaximizeBox", "FlashMacro")
    UI.BackColor := BASES.Has(Get("General", "Base", "dark")) ? BASES[Get("General", "Base", "dark")][1] : "0E0E11"
    UI.MarginX := 0, UI.MarginY := 0
    try DllCall("dwmapi\DwmSetWindowAttribute", "ptr", UI.Hwnd, "int", 20, "int*", 1, "int", 4)
    win11 := VerCompare(A_OSVersion, "10.0.22000") >= 0
    if win11
        try DllCall("dwmapi\DwmSetWindowAttribute", "ptr", UI.Hwnd, "int", 33, "int*", 2, "int", 4)
    UI.OnEvent("Close", (*) => HideUI())
    WB := UI.Add("ActiveX", Format("x0 y0 w{} h{}", W, H), "Shell.Explorer").Value
    WB.Silent := true
    page := A_ScriptDir "\ui.html"
    if !FileExist(page) {
        MsgBox "Не найден файл меню ui.html рядом с FlashMacro.ahk.`nМакросы работают, но меню недоступно.", "FlashMacro", "Icon!"
        UI := 0
        return
    }
    WB.Navigate(page)
    t := A_TickCount
    while (WB.ReadyState != 4 || WB.Busy) && A_TickCount - t < 10000
        Sleep 20
    Wnd := WB.document.parentWindow
    Wnd.setBridge(Bridge())
    Wnd.init(MetaJson())
    ; Масштаб страницы под DPI экрана
    try WB.ExecWB(63, 2, Round(DPI * 100), 0)
    OnMessage(0x100, WBKeys)
    OnMessage(0x101, WBKeys)
}

; Клавиши навигации и правки в полях ввода передаём движку страницы (иначе он их не видит)
WBKeys(wp, lp, msg, hwnd) {
    static keys := Map(8, 1, 9, 1, 13, 1, 33, 1, 34, 1, 35, 1, 36, 1, 37, 1, 38, 1, 39, 1, 40, 1, 46, 1)
    if !(UI && WB && WinActive("ahk_id " UI.Hwnd))
        return
    if !(keys.Has(wp) || (GetKeyState("Ctrl") && InStr("ACVXZ", Chr(wp))))
        return
    kMsg := Buffer(48, 0)
    NumPut("ptr", hwnd, "uint", msg, "uint", 0, "uptr", wp, "ptr", lp, kMsg)
    try {
        pipa := ComObjQuery(WB, "{00000117-0000-0000-C000-000000000046}")
        if (ComCall(5, pipa, "ptr", kMsg, "int") = 0)
            return 0
    }
}

class Bridge {
    setVal(sec, key, val) {
        SetVal(sec, key, val)
        Commit()
        return 1
    }
    capture(sec, key) {
        SetTimer(DoCapture.Bind(sec, key), -10)
        return 1
    }
    toggleMacros() {
        ToggleSuspend()
        return 1
    }
    newCustom() => NewCustom()
    deleteCustom(sec) {
        if C.Has(sec) && !IsPreset(sec)
            C.Delete(sec)
        Commit()
        return 1
    }
    renameCustom(old, new) => RenameCustom(old, new)
    importBinds() {
        SetTimer(ImportFromFortnite, -10)
        return 1
    }
    applyImport() {
        for k, v in ImportFound
            SetVal("Game", k, v)
        Commit()
        Notify("Бинды импортированы")
        return 1
    }
    switchProfile(n) {
        SetTimer(SwitchProfile.Bind(n), -10)
        return 1
    }
    newProfile() {
        SetTimer(NewProfile, -10)
        return 1
    }
    dupProfile(n) {
        SetTimer(DupProfile.Bind(n), -10)
        return 1
    }
    renameProfile(o, n) {
        SetTimer(RenameProfile.Bind(o, n), -10)
        return 1
    }
    deleteProfile(n) {
        SetTimer(DeleteProfile.Bind(n), -10)
        return 1
    }
    exportProfile(n) {
        SetTimer(ExportProfile.Bind(n), -10)
        return 1
    }
    importProfile() {
        SetTimer(ImportProfile, -10)
        return 1
    }
    resetSec(sec) {
        ResetSections([sec])
        Notify("Сброшено к стандартным")
        return 1
    }
    resetGroup(g) {
        list := []
        if (g = "binds")
            list.Push("Game")
        else if (g = "crosshair")
            list.Push("Crosshair")
        else
            for sec in TPL
                if !(sec ~= "i)^(General|Game|Crosshair|Optimize|License)$")
                    list.Push(sec)
        ResetSections(list)
        Notify("Сброшено к стандартным")
        return 1
    }
    newRemap() {
        n := 1
        while C.Has("Remap:" n)
            n++
        for k, v in Map("Enabled", "1", "From", "", "To", "")
            SetVal("Remap:" n, k, v)
        Commit()
        return "Remap:" n
    }
    deleteSec(sec) {
        if C.Has(sec) && (sec ~= "i)^Remap:")
            C.Delete(sec)
        Commit()
        return 1
    }
    licActivate(key) {
        global Lic
        key := StrUpper(Trim(RegExReplace(key, "\s")))
        SetVal("License", "Key", key)
        SetVal("License", "LastOk", "")
        SaveIni()
        Lic := {ok: 0, state: key = "" ? "nokey" : "checking"}
        PushState()
        SetTimer(LicenseCheck, -10)
        return 1
    }
    licRemove() {
        for k in ["Key", "Plan", "ExpiresTs", "LastOk"]
            SetVal("License", k, "")
        SaveIni()
        SetTimer(LicenseCheck, -10)
        return 1
    }
    licRecheck() {
        SetTimer(LicenseCheck, -10)
        return 1
    }
    openBuy() {
        u := BuyUrl()
        if (u != "")
            Run(u)
        return u != "" ? 1 : 0
    }
    optToggle(id, on) => Json(OptApply(id, on ? true : false))
    optRefresh() {
        SetTimer(RefreshOpt, -10)
        return 1
    }
    optRecommended() {
        SetTimer(OptRecommended, -10)
        return 1
    }
    optRevert() {
        SetTimer(OptRevertAll, -10)
        return 1
    }
    clean() {
        SetTimer(CleanJunk, -10)
        return 1
    }
    procs() {
        SetTimer(ListHeavy, -10)
        return 1
    }
    killProc(pid) {
        ok := ProcessClose(pid)
        SetTimer(ListHeavy, -400)
        return ok ? 1 : 0
    }
    elevate() {
        SetTimer(Elevate, -10)
        return 1
    }
    setPage(p) {
        global CurPage
        CurPage := p
        return 1
    }
    openConfig() {
        Run('notepad.exe "' CFG '"')
        return 1
    }
    openFolder() {
        Run(A_ScriptDir)
        return 1
    }
    quit() {
        SetTimer(() => ExitApp(), -10)
        return 1
    }
    minimize() {
        SetTimer(() => UI.Minimize(), -10)
        return 1
    }
    hide() {
        SetTimer(() => (UI.Hide(), HideUI()), -10)
        return 1
    }
    drag() {
        DllCall("ReleaseCapture")
        PostMessage(0xA1, 2, 0, , "ahk_id " UI.Hwnd)
        return 1
    }
}

DoCapture(sec, key) {
    r := CaptureKey()
    if r.ok
        SetVal(sec, key, r.key)
    Commit()
    try Wnd.captureDone()
}

; Ждёт нажатие клавиши/кнопки мыши. Esc — отмена, Backspace — очистить.
CaptureKey() {
    static busy := false
    if busy
        return {ok: false}
    busy := true
    wasSusp := A_IsSuspended
    Suspend(1)
    res := {k: ""}
    ih := InputHook("L0 T8")
    ih.KeyOpt("{All}", "E")
    btns := ["LButton", "RButton", "MButton", "XButton1", "XButton2", "WheelUp", "WheelDown"]
    Sleep 150
    HotIf()
    for b in btns
        try Hotkey("*" b, MouseCap.Bind(res, ih, b), "On S")
    ih.Start()
    ih.Wait()
    for b in btns
        try Hotkey("*" b, "Off")
    Suspend(wasSusp ? 1 : 0)
    busy := false
    k := res.k != "" ? res.k : (ih.EndReason = "EndKey" ? ih.EndKey : "")
    if (k = "" || k = "Escape")
        return {ok: false}
    if (k = "Backspace")
        k := ""
    return {ok: true, key: k}
}

MouseCap(res, ih, b, *) {
    res.k := b
    ih.Stop()
}

SecList(prefix) {
    r := []
    for s in C
        if (SubStr(s, 1, StrLen(prefix)) = prefix)
            r.Push(s)
    return r
}

; ───── Профили: файлы profiles\<имя>.ini; общие настройки [General] не меняются при переключении
ProfDir() => A_ScriptDir "\profiles"
ProfPath(n) => ProfDir() "\" n ".ini"
CleanName(n) => Trim(RegExReplace(n, '[\\/:*?"<>|\[\]=;]'))

ProfileList() {
    r := [], cur := Get("General", "Profile", PROF_DEFAULT), has := false
    if DirExist(ProfDir())
        loop files ProfDir() "\*.ini" {
            n := SubStr(A_LoopFileName, 1, -4)
            r.Push(n)
            has := has || (n = cur)
        }
    if !has
        r.InsertAt(1, cur)
    return r
}

SaveCurrentProfile() {
    DirCreate(ProfDir())
    SaveIni(ProfPath(Get("General", "Profile", PROF_DEFAULT)))
}

UniqueProfile(base) {
    n := base, i := 2
    while FileExist(ProfPath(n)) || n = Get("General", "Profile", PROF_DEFAULT)
        n := base " " i++
    return n
}

SwitchProfile(name) {
    global C
    if (name = Get("General", "Profile", PROF_DEFAULT))
        return
    SaveCurrentProfile()
    gen := C["General"]
    nc := NewMap()
    ParseInto(DEFAULT_INI, nc)
    if FileExist(ProfPath(name))
        ParseInto(FileRead(ProfPath(name), "UTF-8"), nc)
    nc["General"] := gen
    for keep in ["Optimize", "OptBackup", "License"]
        if C.Has(keep)
            nc[keep] := C[keep]
    C := nc
    SetVal("General", "Profile", name)
    Commit()
    Notify("Профиль: " name)
}

NewProfile() {
    SaveCurrentProfile()
    n := UniqueProfile("Профиль")
    FileOpen(ProfPath(n), "w", "UTF-8-RAW").Write(DEFAULT_INI)
    SwitchProfile(n)
}

DupProfile(name) {
    SaveCurrentProfile()
    n := UniqueProfile(name " копия")
    if FileExist(ProfPath(name))
        FileCopy(ProfPath(name), ProfPath(n))
    PushState()
    Notify("Создан профиль «" n "»")
}

RenameProfile(old, new) {
    new := CleanName(new)
    if (new = "" || new = old)
        return PushState()
    if FileExist(ProfPath(new)) {
        Notify("Профиль с таким названием уже есть")
        return PushState()
    }
    if FileExist(ProfPath(old))
        FileMove(ProfPath(old), ProfPath(new))
    if (old = Get("General", "Profile", PROF_DEFAULT)) {
        SetVal("General", "Profile", new)
        SaveIni()
        SaveCurrentProfile()
    }
    PushState()
}

DeleteProfile(name) {
    if (name = Get("General", "Profile", PROF_DEFAULT)) {
        Notify("Нельзя удалить активный профиль")
        return
    }
    try FileDelete(ProfPath(name))
    PushState()
    Notify("Профиль «" name "» удалён")
}

ExportProfile(name) {
    UI.Opt("+OwnDialogs")
    path := FileSelect("S16", A_Desktop "\FlashMacro - " name ".ini", "Экспорт профиля", "Профиль FlashMacro (*.ini)")
    if (path = "")
        return
    if !(path ~= "i)\.ini$")
        path .= ".ini"
    if (name = Get("General", "Profile", PROF_DEFAULT))
        SaveIni(path)
    else
        FileCopy(ProfPath(name), path, 1)
    Notify("Профиль сохранён в файл")
}

ImportProfile() {
    UI.Opt("+OwnDialogs")
    path := FileSelect(1, A_Desktop, "Импорт профиля", "Профиль FlashMacro (*.ini)")
    if (path = "")
        return
    SplitPath(path, , , , &base)
    SaveCurrentProfile()
    n := UniqueProfile(CleanName(RegExReplace(base, "^FlashMacro - ")))
    FileCopy(path, ProfPath(n))
    PushState()
    Notify("Импортирован профиль «" n "»")
}

; Сброс секций к стандартным значениям (свои макросы и переназначения не трогаем)
ResetSections(list) {
    for sec in list {
        if !TPL.Has(sec)
            continue
        m := NewMap()
        for k, v in TPL[sec]
            m[k] := v
        C[sec] := m
    }
    Commit()
}

NewCustom() {
    n := 1
    while C.Has("Macro:Macro " n)
        n++
    sec := "Macro:Macro " n
    for k, v in Map("Enabled", "0", "Trigger", "", "Mode", "once", "Sequence", "", "Speed", "1", "Interval", "10")
        SetVal(sec, k, v)
    Commit()
    return sec
}

RenameCustom(old, new) {
    new := Trim(RegExReplace(new, "[\[\]=;:]"))
    if (!C.Has(old) || new = "" || "Macro:" new = old)
        return old
    target := "Macro:" new
    if C.Has(target) {
        Notify("Макрос с таким названием уже есть")
        return old
    }
    C[target] := C[old]
    C.Delete(old)
    Commit()
    return target
}

Commit(*) {
    global CLR, LastLang
    SaveIni()
    if (Lang() != LastLang) {
        LastLang := Lang()
        SetupTray()
    }
    ApplyEngine()
    CLR := MakePalette()
    PushState()
    UpdateCrosshair()
    UpdateIndicator()
}

EnabledTriggers() {
    r := []
    for s in ["DragEdit", "InfiniteEdit", "InstantEdit", "Pickup"]
        if Bool(s, "Enabled")
            r.Push(Get(s, "Trigger"))
    if Bool("InstantBuild", "Enabled")
        for p in ["Wall", "Floor", "Stairs", "Cone"]
            r.Push(Get("InstantBuild", p "Trigger"))
    if Bool("Competitive", "Enabled")
        r.Push(Get("Competitive", "PeekKey"))
    if Bool("RapidFire", "Enabled")
        r.Push(Get("RapidFire", "Trigger"))
    for s in C {
        if (s ~= "i)^Macro:") && Bool(s, "Enabled")
            r.Push(Get(s, "Trigger"))
        if (s ~= "i)^Remap:") && Bool(s, "Enabled")
            r.Push(Get(s, "From"))
    }
    return r
}

; Состояние для страницы: конфиг, подсветка клавиш, кто какую клавишу занимает
PushState() {
    if !(UI && Wnd)
        return
    caps := Map()
    for t in EnabledTriggers()
        if (t != "")
            caps[Norm(t)] := "trig"
    if (k := Get("General", "SuspendKey"))
        caps[Norm(k)] := "sus"
    if Bool("Crosshair", "Enabled") && (k := Get("Crosshair", "ToggleKey"))
        caps[Norm(k)] := "xh"
    usedBy := Map()
    for k, owner in Used
        n := Norm(k), usedBy[n] := (usedBy.Has(n) ? usedBy[n] ", " : "") owner
    binds := Map()
    if C.Has("Game")
        for name, val in C["Game"]
            if (val != "")
                n := Norm(val), binds[n] := (binds.Has(n) ? binds[n] ", " : "") name
    custom := CustomList()
    active := 0
    for m in BUILTIN
        active += Bool(m.sec, "Enabled")
    for s in custom
        active += Bool(s, "Enabled")
    if (k := Get("General", "MenuKey")) && !caps.Has(Norm(k))
        caps[Norm(k)] := "menu"
    st := Map("cfg", C, "suspended", A_IsSuspended ? 1 : 0, "caps", caps, "used", usedBy, "binds", binds
        , "custom", custom, "active", active, "total", BUILTIN.Length + custom.Length
        , "remaps", SecList("Remap:"), "profiles", ProfileList(), "profile", Get("General", "Profile", PROF_DEFAULT), "stats", Stats
        , "opt", OptCache, "admin", A_IsAdmin ? 1 : 0, "license", LicState(), "lang", Lang())
    try Wnd.render(Json(st))
}

; Описание макросов, полей и подсказок для страницы (передаётся один раз)
MetaJson() {
    kb := []
    for row in KbRows() {
        r := []
        for k in row
            r.Push([k[1], k[2] = "" ? "" : Norm(k[2]), k[3]])
        kb.Push(r)
    }
    return Json(Map("builtin", BUILTIN, "forms", FORMS, "macroFields", MacroFields(), "hints", HintText
        , "themes", THEMES, "themeOrder", THEME_ORDER, "bases", BASES, "kb", kb, "version", "v" APP_VERSION))
}

Json(v) {
    if IsObject(v) {
        if (v is Func)
            return "null"
        s := "", i := 0
        if (v is Array) {
            for x in v
                s .= (i++ ? "," : "") Json(x)
            return "[" s "]"
        }
        if (v is Map) {
            for k, x in v
                s .= (i++ ? "," : "") Json(String(k)) ":" Json(x)
            return "{" s "}"
        }
        for k, x in v.OwnProps()
            s .= (i++ ? "," : "") Json(k) ":" Json(x)
        return "{" s "}"
    }
    if (Type(v) = "Integer" || Type(v) = "Float")
        return String(v)
    v := StrReplace(v, "\", "\\")
    v := StrReplace(v, '"', '\"')
    v := StrReplace(v, "`n", "\n")
    v := StrReplace(v, "`r", "\r")
    v := StrReplace(v, "`t", "\t")
    v := StrReplace(v, "/", "\/")
    v := StrReplace(v, Chr(0x2028), " ")
    v := StrReplace(v, Chr(0x2029), " ")
    return '"' v '"'
}

; Подсветка клавиш, которые макрос нажимает прямо сейчас (только на Dashboard)
FlashTick() {
    static last := ""
    if (CurPage != "Dashboard" || !Wnd)
        return
    now := A_TickCount, s := ""
    for n, p in Pressed.Clone() {
        if (p.down || now - p.t < 150)
            s .= n ","
        else
            Pressed.Delete(n)
    }
    if (s != last) {
        last := s
        try Wnd.flash(s)
    }
}

ShowUI(*) {
    global UIShown
    if !UI
        BuildUI()
    if !UI
        return
    UI.Opt(Bool("General", "MenuOnTop", true) ? "+AlwaysOnTop" : "-AlwaysOnTop")
    UI.Show("w" W " h" H)
    UIShown := true
    PushState()
    SetTimer(FlashTick, 40)
    SetTimer(StatsTick, 500)
}

; Клавиша меню: открыть поверх игры / вернуться в игру
ToggleMenu(*) {
    global PrevWin
    if (UI && UIShown && WinActive("ahk_id " UI.Hwnd)) {
        UI.Hide()
        HideUI(true)
        if (PrevWin && WinExist("ahk_id " PrevWin))
            try WinActivate("ahk_id " PrevWin)
        return
    }
    PrevWin := WinExist("A")
    ShowUI()
    try WinActivate("ahk_id " UI.Hwnd)
}

StatsTick() {
    static last := -1
    if (StatsVer != last && Wnd) {
        last := StatsVer
        try Wnd.stats(Json(Stats))
    }
}

; Точка-индикатор в углу экрана: зелёная — макросы работают, серая — пауза
UpdateIndicator() {
    static ig := 0
    if !Bool("General", "Indicator") {
        if ig
            ig.Hide()
        return
    }
    if !ig {
        ig := Gui("+AlwaysOnTop -Caption +ToolWindow +E0x20 -DPIScale")
        ig.Show("x10 y10 w12 h12 NA")
        RoundWin(ig, 12, 12, 12)
    }
    ig.BackColor := A_IsSuspended ? "6B6B76" : "22C55E"
    ig.Show("x10 y10 w12 h12 NA")
}

HideUI(quiet := false) {
    global UIShown
    static told := false
    UIShown := false
    SetTimer(FlashTick, 0)
    SetTimer(StatsTick, 0)
    if Bool("Optimize", "Lite")
        SetTimer(UnloadUI, -20000)
    if (!told && !quiet) {
        told := true
        Notify("FlashMacro работает в трее. Клик по иконке — открыть меню.", 2500)
    }
}

KbRows() {
    one(s) {
        a := []
        for ch in StrSplit(s)
            a.Push([StrUpper(ch), ch, 1])
        return a
    }
    r0 := [["Esc", "Escape", 1], ["", "", 1]]
    for grp in [[1, 4], [5, 8], [9, 12]] {
        if (grp[1] > 1)
            r0.Push(["", "", 0.5])
        loop grp[2] - grp[1] + 1
            r0.Push(["F" (grp[1] + A_Index - 1), "F" (grp[1] + A_Index - 1), 1])
    }
    r1 := [["~", "``", 1]], r1.Push(one("1234567890")*), r1.Push(["-", "-", 1], ["=", "=", 1], ["←", "Backspace", 2])
    r2 := [["Tab", "Tab", 1.5]], r2.Push(one("qwertyuiop")*), r2.Push(["[", "[", 1], ["]", "]", 1], ["\", "\", 1.5])
    r3 := [["Caps", "CapsLock", 1.75]], r3.Push(one("asdfghjkl")*), r3.Push([";", ";", 1], ["'", "'", 1], ["Enter", "Enter", 2.25])
    r4 := [["Shift", "LShift", 2.25]], r4.Push(one("zxcvbnm")*), r4.Push([",", ",", 1], [".", ".", 1], ["/", "/", 1], ["Shift", "RShift", 2.75])
    r5 := [["Ctrl", "LCtrl", 1.25], ["Win", "LWin", 1.25], ["Alt", "LAlt", 1.25], ["Space", "Space", 6.25]
        , ["Alt", "RAlt", 1.25], ["Win", "RWin", 1.25], ["Menu", "AppsKey", 1.25], ["Ctrl", "RCtrl", 1.25]]
    return [r0, r1, r2, r3, r4, r5]
}

KeyLabel(k) {
    static m := 0
    if !m {
        m := NewMap()
        for p in [["LButton", "LMB"], ["RButton", "RMB"], ["MButton", "MMB"], ["XButton1", "MB4"], ["XButton2", "MB5"]
            , ["WheelUp", "WhUp"], ["WheelDown", "WhDn"], ["LShift", "Shift"], ["LControl", "Ctrl"], ["LCtrl", "Ctrl"]
            , ["RControl", "RCtrl"], ["Escape", "Esc"], ["CapsLock", "Caps"], ["Backspace", "Bksp"], ["Space", "Space"]
            , ["Enter", "Enter"], ["Tab", "Tab"], ["PgDn", "PgDn"], ["PgUp", "PgUp"], ["LAlt", "Alt"], ["Home", "Home"]
            , ["End", "End"], ["Insert", "Ins"], ["Delete", "Del"]]
            m[p[1]] := p[2]
    }
    if (k = "")
        return "—"
    return m.Has(k) ? m[k] : StrUpper(k)
}

; ───────────────────────── Описания макросов и подсказки ─────────────────────────

Fld(t, k, label, extra := 0) {
    o := {t: t, k: k, label: label}
    if IsObject(extra)
        for p, v in extra.OwnProps()
            o.%p% := v
    return o
}

InitForms() {
    en := Fld("toggle", "Enabled", "Включён")
    tr := Fld("key", "Trigger", "Клавиша запуска")
    cb := Fld("choice", "ConfirmBy", "Подтверждение", {o: ["release", "key"], l: ["Отпусканием", "Клавишей"], bw: 110})
    ed := Fld("num", "EnterDelay", "Задержка входа в редакт")
    cd := Fld("num", "ConfirmDelay", "Задержка подтверждения")
    FORMS["DragEdit"] := {desc: "Держишь клавишу — входишь в редактирование и выделяешь тайлы мышкой. Отпустил — редакт подтверждается.", fields: [en, tr, cb, ed, cd]}
    FORMS["InfiniteEdit"] := {desc: "Пока держишь клавишу — спамит одиночные редакты тайла под прицелом. Темп подстраивается под твой FPS.", fields: [en, tr, cb, ed, cd
        , Fld("num", "FPS", "Твой FPS", {u: "fps"}), Fld("num", "FramesPerStep", "Кадров на один редакт", {u: "кадр."})
        , Fld("num", "StepDelay", "Шаг вручную (0 = по FPS)")]}
    FORMS["InstantEdit"] := {desc: "Одно нажатие — один редакт тайла под прицелом: вход, выбор, подтверждение.", fields: [en, tr, cb, ed, cd]}
    FORMS["InstantBuild"] := {desc: "Нажал клавишу постройки — она сразу ставится. В непрерывном режиме ЛКМ остаётся зажатой, пока не нажмёшь редакт, смену оружия или спринт.", fields: [en
        , Fld("key", "WallTrigger", "Стена"), Fld("key", "FloorTrigger", "Пол"), Fld("key", "StairsTrigger", "Лестница")
        , Fld("key", "ConeTrigger", "Конус"), Fld("num", "PlaceDelay", "Задержка установки")
        , Fld("toggle", "Continuous", "Непрерывная стройка"), Fld("text", "StopKeys", "Клавиши, отпускающие ЛКМ", {w: 200})]}
    FORMS["Pickup"] := {desc: "Пока держишь клавишу — спамит «Взаимодействие», чтобы быстро подбирать лут.", fields: [en, tr, Fld("num", "Delay", "Интервал")]}
    FORMS["RapidFire"] := {desc: "Пока держишь клавишу — быстро кликает «Выбор/выстрел» с заданным интервалом.", fields: [en, tr, Fld("num", "Delay", "Интервал кликов")]}
    FORMS["AntiAFK"] := {desc: "Если долго не трогать клавиатуру и мышь, персонаж изредка подпрыгивает, чтобы игра не выкинула за бездействие. Работает только в окне Fortnite.", fields: [en, Fld("num", "Interval", "Прыгать после бездействия", {u: "сек"})]}
    FORMS["AutoSprint"] := {desc: "После каждой постройки и редакта снова нажимает спринт.", fields: [en, Fld("num", "Delay", "Задержка после действия")]}
    FORMS["Competitive"] := {desc: "Для игры с выключенным «Авто-подтверждением редактирования»: макросы подтверждают редакт клавишей редактирования. Пока держишь клавишу peek, редакт остаётся открытым — можно смотреть сквозь конус.", fields: [en, Fld("key", "PeekKey", "Клавиша peek")]}
    pd := Map("WallRetake", "Ставит стену и сразу переключает на оружие из слота 1."
        , "Prefire", "Открывает редакт, подтверждает, достаёт оружие из слота 1 и стреляет."
        , "SprintReset", "Сбрасывает спринт двойным нажатием клавиши спринта."
        , "Mantle", "Зажимает спринт и прыгает — чтобы залезть на уступ."
        , "SimpleEdit", "Простой редакт: вход, выбор тайла, подтверждение."
        , "CrouchPeek", "Быстро приседает и встаёт, чтобы выглянуть из-за укрытия.")
    for p in PRESETS
        FORMS["Macro:" p] := {desc: pd[p], fields: MacroFields()}
}

MacroFields() => [Fld("toggle", "Enabled", "Включён"), Fld("key", "Trigger", "Клавиша запуска")
    , Fld("choice", "Mode", "Режим", {o: ["once", "repeat", "toggle"], l: ["Один раз", "Пока держишь", "Вкл/выкл"], bw: 104})
    , Fld("text", "Sequence", "Последовательность", {w: 320}), Fld("num", "Speed", "Скорость", {u: "x"})
    , Fld("num", "Interval", "Пауза между повторами")]

InitHints() {
    for k, v in Map("Enabled", "Включает или выключает эту функцию. Изменения применяются сразу."
        , "Trigger", "Клавиша запуска. Кликни и нажми нужную клавишу или кнопку мыши. Esc — отмена, Backspace — очистить."
        , "ConfirmBy", "Как подтверждать редакт. «Отпусканием» — если в Fortnite включено «Подтверждать при отпускании». «Клавишей» — макрос сам нажмёт клавишу редактирования ещё раз."
        , "EnterDelay", "Пауза после входа в режим редактирования, перед выбором тайла. Если редакт не срабатывает — увеличь до 15–20 мс."
        , "ConfirmDelay", "Пауза перед подтверждением редакта."
        , "FPS", "Твой FPS в игре. По нему считается темп спама редактов."
        , "FramesPerStep", "Сколько кадров уходит на один редакт. Меньше — быстрее, но игра может не успевать."
        , "StepDelay", "Фиксированный интервал между редактами в мс. 0 — считать автоматически по FPS."
        , "WallTrigger", "Клавиша, по которой мгновенно ставится стена."
        , "FloorTrigger", "Клавиша, по которой мгновенно ставится пол."
        , "StairsTrigger", "Клавиша, по которой мгновенно ставится лестница."
        , "ConeTrigger", "Клавиша, по которой мгновенно ставится конус."
        , "PlaceDelay", "Пауза между выбором постройки и её установкой."
        , "Continuous", "ЛКМ остаётся зажатой после постройки — строишь без остановки. Отпускается при редакте, смене оружия или спринте. Нужна «Турбо-стройка» в Fortnite."
        , "StopKeys", "Клавиши через запятую, которые прекращают непрерывную стройку (слоты оружия, спринт)."
        , "Pickup.Delay", "Как часто нажимать «Взаимодействие», пока держишь клавишу."
        , "AutoSprint.Delay", "Пауза после постройки или редакта перед повторным нажатием спринта."
        , "PeekKey", "Пока держишь эту клавишу, редакт не подтверждается — можно посмотреть сквозь открытый конус."
        , "Mode", "«Один раз» — выполнить последовательность. «Пока держишь» — повторять, пока клавиша зажата. «Вкл/выкл» — первое нажатие запускает повтор, второе останавливает."
        , "Sequence", SEQ_HELP
        , "Speed", "Множитель скорости: 2 — в два раза быстрее (паузы короче), 0.5 — в два раза медленнее."
        , "Interval", "Пауза между повторами в режимах «Пока держишь» и «Вкл/выкл»."
        , "Crosshair.Enabled", "Включает прицел поверх экрана."
        , "ShowOnStart", "Показывать прицел сразу при запуске FlashMacro."
        , "ToggleKey", "Клавиша, которая прячет и показывает прицел прямо в игре."
        , "Style", "Форма прицела: точка, крест, крест с точкой, T или T с точкой."
        , "Color", "Цвет прицела: выбери готовый или впиши свой в формате RRGGBB."
        , "Length", "Длина каждой линии прицела в пикселях."
        , "Thickness", "Толщина линий прицела."
        , "Gap", "Расстояние от центра до начала линий."
        , "DotSize", "Размер центральной точки."
        , "OffsetX", "Сдвиг прицела вправо (+) или влево (−) в пикселях."
        , "OffsetY", "Сдвиг прицела вниз (+) или вверх (−) в пикселях."
        , "SuspendKey", "Горячая клавиша, которая включает и выключает все макросы разом. Работает и в игре."
        , "OnlyInGame", "Если включено, макросы работают только когда активно окно Fortnite. Выключи, чтобы проверить их в Блокноте."
        , "GameExe", "Имя процесса игры. Менять не нужно, если только Fortnite его не переименует."
        , "Debug", "Записывает все нажатия макросов в лог справа — удобно для проверки, что макрос жмёт."
        , "KeyHoldMs", "Сколько миллисекунд макрос держит клавишу клавиатуры при одиночном нажатии."
        , "ClickHoldMs", "Сколько миллисекунд макрос держит кнопку мыши при одиночном клике."
        , "StartHidden", "Запускать FlashMacro свёрнутым в трей, без открытия меню."
        , "ShowOSD", "Показывать короткие уведомления внизу экрана, например «Макросы выключены»."
        , "Theme", "Цвет акцента меню — применяется сразу."
        , "Base", "Оттенок фона меню — применяется сразу."
        , "page.Dashboard", "Обзор: клавиатура с подсветкой и все макросы с быстрыми тумблерами."
        , "page.Keybinds", "Твои бинды из Fortnite — макросы нажимают именно эти клавиши."
        , "page.Macros", "Подробные настройки каждого макроса: задержки, режимы, FPS."
        , "page.Custom", "Свои макросы из любых последовательностей нажатий."
        , "page.Crosshair", "Свой прицел поверх игры с живым превью."
        , "page.Settings", "Горячая клавиша, режим работы, лог нажатий, темы оформления."
        , "RapidFire.Delay", "Пауза между кликами в мс. Меньше — быстрее."
        , "AntiAFK.Interval", "Через сколько секунд без нажатий персонаж подпрыгнет (минимум 10)."
        , "MenuKey", "Клавиша, которая открывает это меню поверх игры и закрывает его обратно. Игра должна быть в режиме «Оконный полноэкранный»."
        , "MenuOnTop", "Меню всегда поверх других окон, в том числе поверх Fortnite."
        , "Indicator", "Маленькая точка в левом верхнем углу экрана: зелёная — макросы работают, серая — на паузе."
        , "Radius", "Радиус кольца для стилей с кругом."
        , "Opacity", "Непрозрачность прицела: 100 — полностью видимый."
        , "Outline", "Тёмная обводка вокруг прицела — его видно и на светлом фоне."
        , "OutlineColor", "Цвет обводки в формате RRGGBB."
        , "From", "Клавиша, которую ты нажимаешь."
        , "To", "Клавиша, которую получит игра вместо неё."
        , "AccentColor", "Свой цвет акцента меню."
        , "page.Remap", "Переназначение: одна клавиша нажимает другую, например боковая кнопка мыши = Shift."
        , "page.Configs", "Профили настроек: создать, переключить, дублировать, сохранить в файл, загрузить из файла, сбросить."
        , "Language", "Язык меню и уведомлений."
        , "page.License", "Подписка, ключ и продление."
        , "page.Optimize", "Оптимизация Windows и игры: приоритет, питание, ускорение мыши, Game DVR, очистка кэша, тяжёлые программы."
        , "page.Support", "Как начать, нужные настройки Fortnite и что делать, если не работает.")
        HintText[k] := v
}

; ───────────────────────── Оптимизация Windows ─────────────────────────
; Каждый пункт можно включить и выключить. Перед изменением старое значение сохраняется
; в [OptBackup], «Вернуть как было» откатывает только то, что включал FlashMacro.

RegGet(key, name, def := "") {
    try return RegRead(key, name)
    return def
}

Bk(name, def := "") => Get("OptBackup", name, def)

SetBk(name, v) {
    SetVal("OptBackup", name, v)
}

; Выполнить консольную команду скрыто и вернуть её вывод
ShellOut(cmd) {
    tmp := A_Temp "\flashmacro_out.txt"
    try FileDelete(tmp)
    try {
        RunWait(A_ComSpec ' /c ' cmd ' > "' tmp '" 2>&1', , "Hide")
    } catch {
        return ""
    }
    try return FileRead(tmp, "CP" DllCall("GetOEMCP", "uint"))
    return ""
}

ActivePlan() {
    out := ShellOut("powercfg /getactivescheme")
    if RegExMatch(out, "i)([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\s*\((.*)\)", &m)
        return {guid: m[1], name: Trim(m[2])}
    return {guid: "", name: ""}
}

; Схема «Максимальная производительность» (создаётся один раз), иначе «Высокая производительность»
FastPlan() {
    g := Bk("PowerFast")
    if (g != "" && InStr(ShellOut("powercfg /list"), g))
        return g
    out := ShellOut("powercfg /duplicatescheme " PLAN_ULT)
    if RegExMatch(out, "i)[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", &m) {
        SetBk("PowerFast", m[0])
        return m[0]
    }
    return PLAN_HIGH
}

FortnitePath() {
    exe := Get("General", "GameExe", "FortniteClient-Win64-Shipping.exe")
    if (pid := ProcessExist(exe)) {
        try {
            p := ProcessGetPath(pid)
            if (p != Bk("FortnitePath"))
                SetBk("FortnitePath", p)
            return p
        }
    }
    p := Bk("FortnitePath")
    if (p != "" && FileExist(p))
        return p
    dat := EnvGet("ProgramData") "\Epic\UnrealEngineLauncher\LauncherInstalled.dat"
    if FileExist(dat) {
        txt := FileRead(dat, "UTF-8")
        if RegExMatch(txt, 's)\{[^{}]*"AppName"\s*:\s*"Fortnite"[^{}]*\}', &o) && RegExMatch(o[0], '"InstallLocation"\s*:\s*"([^"]+)"', &l) {
            p := StrReplace(StrReplace(l[1], "\\", "\"), "/", "\") "\FortniteGame\Binaries\Win64\FortniteClient-Win64-Shipping.exe"
            if FileExist(p)
                return p
        }
    }
    p := "C:\Program Files\Epic Games\Fortnite\FortniteGame\Binaries\Win64\FortniteClient-Win64-Shipping.exe"
    return FileExist(p) ? p : ""
}

MouseAccel() {
    buf := Buffer(12, 0)
    DllCall("SystemParametersInfo", "uint", 0x3, "uint", 0, "ptr", buf, "uint", 0)
    return [NumGet(buf, 0, "int"), NumGet(buf, 4, "int"), NumGet(buf, 8, "int")]
}

SetMouseAccel(a) {
    buf := Buffer(12, 0)
    NumPut("int", a[1], "int", a[2], "int", a[3], buf)
    DllCall("SystemParametersInfo", "uint", 0x4, "uint", 0, "ptr", buf, "uint", 3)
}

; Текущее состояние всех пунктов (читается из системы, а не из конфига)
RefreshOpt(push := true) {
    global OptCache
    st := Map()
    st["priority"] := RegGet(IFEO_KEY, "CpuPriorityClass", 0) = 3
    plan := ActivePlan()
    st["power"] := plan.guid != "" && (plan.guid = Bk("PowerFast") || plan.guid = PLAN_HIGH || plan.guid = PLAN_ULT
        || (plan.name ~= "i)ultimate|максимальн|high perf|высок") > 0)
    st["planName"] := plan.name
    st["gamedvr"] := RegGet(DVR_KEY1, "GameDVR_Enabled", 1) = 0 && RegGet(DVR_KEY2, "AppCaptureEnabled", 1) = 0
    st["timer"] := RegGet(KERNEL_KEY, "GlobalTimerResolutionRequests", 0) = 1
    st["mouseaccel"] := MouseAccel()[3] = 0
    st["hags"] := RegGet(GFX_KEY, "HwSchMode", 0) = 2
    st["gamemode"] := RegGet(GAMEBAR_KEY, "AutoGameModeEnabled", 1) != 0
    fp := FortnitePath()
    st["fsoPath"] := fp
    st["fso"] := fp != "" && InStr(RegGet(LAYERS_KEY, fp, ""), "DISABLEDXMAXIMIZEDWINDOWEDMODE") > 0
    st["autogame"] := Bool("Optimize", "AutoGame")
    st["lite"] := Bool("Optimize", "Lite")
    st["gameRunning"] := GameRunning ? 1 : 0
    OptCache := st
    if push
        PushState()
}

Touch(id, on) {
    list := StrSplit(Bk("Touched"), ",", " ")
    out := ""
    for x in list
        if (x != "" && x != id)
            out .= x ","
    if on
        out .= id ","
    SetBk("Touched", RTrim(out, ","))
}

; Включить/выключить пункт. Возвращает {ok, msg, need}
OptApply(id, on, refresh := true) {
    static adminIds := Map("priority", 1, "timer", 1, "hags", 1)
    if adminIds.Has(id) && !A_IsAdmin
        return {ok: 0, need: "admin", msg: "Нужны права администратора"}
    msg := ""
    try {
        switch id {
            case "priority":
                if on {
                    RegWrite(3, "REG_DWORD", IFEO_KEY, "CpuPriorityClass")
                    try ProcessSetPriority("High", Get("General", "GameExe", "FortniteClient-Win64-Shipping.exe"))
                } else {
                    try RegDelete(IFEO_KEY, "CpuPriorityClass")
                }
            case "power":
                if on {
                    cur := ActivePlan().guid
                    if (cur != "" && cur != Bk("PowerFast") && cur != PLAN_HIGH)
                        SetBk("PowerPrev", cur)
                    g := FastPlan()
                    ShellOut("powercfg /setactive " g)
                    if (ActivePlan().guid != g)
                        throw Error("Windows не дал включить эту схему питания (бывает на ноутбуках с режимом Modern Standby).")
                } else {
                    ShellOut("powercfg /setactive " Bk("PowerPrev", PLAN_BAL))
                }
            case "gamedvr":
                if on {
                    if (Bk("DvrPrev") = "")
                        SetBk("DvrPrev", RegGet(DVR_KEY1, "GameDVR_Enabled", 1) "," RegGet(DVR_KEY2, "AppCaptureEnabled", 1))
                    RegWrite(0, "REG_DWORD", DVR_KEY1, "GameDVR_Enabled")
                    RegWrite(0, "REG_DWORD", DVR_KEY2, "AppCaptureEnabled")
                } else {
                    p := StrSplit(Bk("DvrPrev", "1,1"), ",")
                    RegWrite(p[1] = "0" ? 1 : p[1], "REG_DWORD", DVR_KEY1, "GameDVR_Enabled")
                    RegWrite(p.Length > 1 && p[2] != "0" ? p[2] : 1, "REG_DWORD", DVR_KEY2, "AppCaptureEnabled")
                    SetBk("DvrPrev", "")
                }
            case "timer":
                if on {
                    RegWrite(1, "REG_DWORD", KERNEL_KEY, "GlobalTimerResolutionRequests")
                } else {
                    try RegDelete(KERNEL_KEY, "GlobalTimerResolutionRequests")
                }
                msg := "Изменение вступит в силу после перезагрузки ПК"
            case "mouseaccel":
                if on {
                    a := MouseAccel()
                    if (a[3] != 0)
                        SetBk("MousePrev", a[1] "," a[2] "," a[3])
                    SetMouseAccel([0, 0, 0])
                } else {
                    p := StrSplit(Bk("MousePrev", "6,10,1"), ",")
                    SetMouseAccel([Integer(p[1]), Integer(p[2]), Integer(p[3])])
                }
            case "hags":
                if on {
                    if (Bk("HagsPrev") = "")
                        SetBk("HagsPrev", RegGet(GFX_KEY, "HwSchMode", ""))
                    RegWrite(2, "REG_DWORD", GFX_KEY, "HwSchMode")
                } else {
                    prev := Bk("HagsPrev")
                    if (prev = "" || prev = "2") {
                        RegWrite(1, "REG_DWORD", GFX_KEY, "HwSchMode")
                    } else {
                        RegWrite(Integer(prev), "REG_DWORD", GFX_KEY, "HwSchMode")
                    }
                    SetBk("HagsPrev", "")
                }
                msg := "Изменение вступит в силу после перезагрузки ПК"
            case "gamemode":
                RegWrite(on ? 1 : 0, "REG_DWORD", GAMEBAR_KEY, "AutoGameModeEnabled")
                RegWrite(on ? 1 : 0, "REG_DWORD", GAMEBAR_KEY, "AllowAutoGameMode")
            case "fso":
                fp := FortnitePath()
                if (fp = "")
                    throw Error("Не нашёл Fortnite. Запусти игру один раз при включённом FlashMacro — путь запомнится.")
                cur := Trim(RegExReplace(RegGet(LAYERS_KEY, fp, ""), "\s*DISABLEDXMAXIMIZEDWINDOWEDMODE"))
                if on
                    cur := (cur = "" ? "~" : cur) " DISABLEDXMAXIMIZEDWINDOWEDMODE"
                if (cur = "" || cur = "~") {
                    try RegDelete(LAYERS_KEY, fp)
                } else {
                    RegWrite(cur, "REG_SZ", LAYERS_KEY, fp)
                }
            case "autogame":
                SetVal("Optimize", "AutoGame", on ? "1" : "0")
                SetTimer(GameWatch, on ? 3000 : 0)
                if !on && GameRunning
                    GameLeave()
            case "lite":
                SetVal("Optimize", "Lite", on ? "1" : "0")
            default:
                throw Error("Неизвестный пункт: " id)
        }
    } catch Error as e {
        return {ok: 0, msg: e.Message}
    }
    if !(id ~= "^(autogame|lite)$")
        Touch(id, on)
    SaveIni()
    if refresh
        RefreshOpt()
    return {ok: 1, msg: msg}
}

OptRecommended() {
    ids := ["power", "gamedvr", "mouseaccel", "gamemode", "fso", "autogame"]
    if A_IsAdmin
        ids.Push("priority")
    bad := ""
    for id in ids {
        r := OptApply(id, true, false)
        if !r.ok
            bad .= (bad = "" ? "" : ", ") OptName(id)
    }
    RefreshOpt()
    Notify(bad = "" ? "Рекомендуемые настройки применены" : "Применено, кроме: " bad)
}

OptRevertAll() {
    skipped := ""
    for id in StrSplit(Bk("Touched"), ",", " ") {
        if (id = "")
            continue
        r := OptApply(id, false, false)
        if !r.ok
            skipped .= (skipped = "" ? "" : ", ") OptName(id)
    }
    if Bool("Optimize", "AutoGame")
        OptApply("autogame", false, false)
    RefreshOpt()
    Notify(skipped = "" ? "Настройки Windows возвращены как были" : "Возвращено, кроме (нужны права администратора): " skipped)
}

OptName(id) {
    static e := Map("priority", "priority", "power", "power plan", "gamedvr", "Game DVR", "timer", "timer", "mouseaccel", "mouse acceleration"
        , "hags", "GPU scheduling", "gamemode", "game mode", "fso", "fullscreen optimizations", "autogame", "FlashMacro game mode")
    if (Lang() = "en")
        return e.Has(id) ? e[id] : id
    static n := Map("priority", "приоритет", "power", "схема питания", "gamedvr", "Game DVR", "timer", "таймер", "mouseaccel", "ускорение мыши"
        , "hags", "планирование GPU", "gamemode", "игровой режим", "fso", "оптимизация во весь экран", "autogame", "игровой режим FlashMacro")
    return n.Has(id) ? n[id] : id
}

; Игровой режим FlashMacro: следит за запуском Fortnite
GameWatch() {
    global GameRunning
    isRun := ProcessExist(Get("General", "GameExe", "FortniteClient-Win64-Shipping.exe")) != 0
    if (isRun = GameRunning)
        return
    if isRun
        GameEnter()
    else
        GameLeave()
}

GameEnter() {
    global GameRunning
    GameRunning := true
    exe := Get("General", "GameExe", "FortniteClient-Win64-Shipping.exe")
    FortnitePath()
    if !OptCache.Get("power", 0) {
        cur := ActivePlan().guid
        if (cur != "") {
            SetBk("AutoPrev", cur)
            ShellOut("powercfg /setactive " FastPlan())
            SetBk("AutoActive", "1")
        }
    }
    try ProcessSetPriority("High", exe)
    res := 0
    DllCall("ntdll\NtSetTimerResolution", "uint", 5000, "int", 1, "uint*", &res)
    SaveIni()
    Notify("Игровой режим включён")
    PushOptLater()
}

GameLeave() {
    global GameRunning
    GameRunning := false
    if (Bk("AutoActive") = "1") {
        ShellOut("powercfg /setactive " Bk("AutoPrev", PLAN_BAL))
        SetBk("AutoActive", "")
    }
    res := 0
    DllCall("ntdll\NtSetTimerResolution", "uint", 5000, "int", 0, "uint*", &res)
    SaveIni()
    Notify("Игровой режим выключен")
    PushOptLater()
}

PushOptLater() {
    if UIShown
        SetTimer(RefreshOpt, -50)
}

; Очистка временных файлов и кэша шейдеров. Занятые файлы пропускаются.
CleanJunk() {
    la := EnvGet("LOCALAPPDATA")
    dirs := [A_Temp, la "\D3DSCache", la "\NVIDIA\DXCache", la "\NVIDIA\GLCache", la "\AMD\DxCache", la "\AMD\DxcCache", la "\AMD\VkCache"]
    if A_IsAdmin
        dirs.Push(A_WinDir "\Temp")
    freed := 0, files := 0, skipped := 0
    for d in dirs {
        if !DirExist(d)
            continue
        loop files d "\*", "FR" {
            sz := A_LoopFileSize
            try {
                FileDelete(A_LoopFileFullPath)
                freed += sz, files++
            } catch {
                skipped++
            }
        }
        loop files d "\*", "D"
            try DirDelete(A_LoopFileFullPath, true)
    }
    try Wnd.cleanDone(Json(Map("mb", Round(freed / 1048576, 1), "files", files, "skipped", skipped)))
}

; Самые тяжёлые фоновые программы (системные процессы и игра не показываются)
ListHeavy() {
    static skip := "i)^(system|idle|_total|registry|smss|csrss|wininit|services|lsass|lsaiso|winlogon|svchost|dwm|explorer|fontdrvhost|memory compression|secure system|audiodg|ctfmon|sihost|taskhostw|runtimebroker|msmpeng|nissrv|securityhealthservice|searchhost|searchindexer|startmenuexperiencehost|textinputhost|shellexperiencehost|spoolsv|wudfhost|dllhost|conhost|wmiprvse|autohotkey.*|fortniteclient.*|easyanticheat.*|epicgameslauncher|epicwebhelper)$"
    cores := Max(Integer(EnvGet("NUMBER_OF_PROCESSORS") || 1), 1)
    list := []
    try {
        for p in ComObjGet("winmgmts:").ExecQuery("SELECT Name, IDProcess, PercentProcessorTime, WorkingSetPrivate FROM Win32_PerfFormattedData_PerfProc_Process") {
            name := RegExReplace(p.Name, "#\d+$")
            if (p.IDProcess = 0 || name ~= skip)
                continue
            list.Push(Map("pid", p.IDProcess, "name", name, "cpu", Round(p.PercentProcessorTime / cores, 1), "mb", Round(p.WorkingSetPrivate / 1048576)))
        }
    }
    if !list.Length {
        try {
            for p in ComObjGet("winmgmts:").ExecQuery("SELECT Name, ProcessId, WorkingSetSize FROM Win32_Process") {
                name := RegExReplace(p.Name, "i)\.exe$")
                if (p.ProcessId = 0 || name ~= skip)
                    continue
                list.Push(Map("pid", p.ProcessId, "name", name, "cpu", -1, "mb", Round(p.WorkingSetSize / 1048576)))
            }
        }
    }
    ; сортировка по памяти, затем по процессору
    loop list.Length - 1 {
        i := A_Index + 1
        x := list[i], j := i - 1
        while (j >= 1 && (list[j]["mb"] < x["mb"])) {
            list[j + 1] := list[j]
            j--
        }
        list[j + 1] := x
    }
    top := []
    for x in list {
        top.Push(x)
        if (top.Length >= 14)
            break
    }
    try Wnd.procs(Json(top))
}

Elevate() {
    try {
        Run('*RunAs "' A_AhkPath '" /restart "' A_ScriptFullPath '"')
        ExitApp
    } catch {
        Notify("Запуск от имени администратора отменён")
    }
}

; Лёгкий режим: меню выгружается из памяти, пока закрыто
UnloadUI() {
    global UI, WB, Wnd
    if (UIShown || !UI || !Bool("Optimize", "Lite"))
        return
    UI.Destroy()
    UI := 0, WB := 0, Wnd := 0
    DllCall("psapi\EmptyWorkingSet", "ptr", DllCall("GetCurrentProcess", "ptr"))
}

; ───────────────────────── Уведомления, трей, лог ─────────────────────────

RoundWin(g, w, h, r) {
    rgn := DllCall("CreateRoundRectRgn", "int", 0, "int", 0, "int", w + 1, "int", h + 1, "int", r, "int", r, "ptr")
    DllCall("SetWindowRgn", "ptr", g.Hwnd, "ptr", rgn, "int", 1)
}

Notify(msg, ms := 1600) {
    global OsdG
    msg := Tr(msg)
    inMenu := UIShown && UI && WinActive("ahk_id " UI.Hwnd)
    if (inMenu && Wnd) {
        try Wnd.toast(msg)
        return
    }
    if !Bool("General", "ShowOSD", true)
        return
    HideOSD()
    OsdG := Gui("+AlwaysOnTop -Caption +ToolWindow +E0x20 -DPIScale")
    OsdG.BackColor := CLR.key
    OsdG.MarginX := Round(18 * DPI), OsdG.MarginY := Round(10 * DPI)
    OsdG.SetFont("s10 c" CLR.accent, "Segoe UI")
    OsdG.AddText("", "●")
    OsdG.SetFont("s10 c" CLR.text, "Segoe UI")
    OsdG.AddText("x+8 yp", msg)
    OsdG.Show("Hide AutoSize")
    OsdG.GetPos(, , &w, &h)
    x := (A_ScreenWidth - w) // 2, y := A_ScreenHeight - h - Round(90 * DPI)
    RoundWin(OsdG, w, h, Round(20 * DPI))
    OsdG.Show(Format("x{} y{} NA", x, y))
    SetTimer(HideOSD, -ms)
}

HideOSD(*) {
    global OsdG
    if OsdG {
        OsdG.Destroy()
        OsdG := 0
    }
}

SetupTray() {
    A_IconTip := "FlashMacro"
    t := A_TrayMenu
    t.Delete()
    t.Add(Tr("Открыть меню"), ShowUI)
    t.Add(Tr("Макросы вкл/выкл"), ToggleSuspend)
    t.Add(Tr("Прицел вкл/выкл"), ToggleCrosshair)
    t.Add()
    t.Add(Tr("Выход"), (*) => ExitApp())
    t.Default := Tr("Открыть меню")
    t.ClickCount := 1
}

; Лог нажатий показывается в меню (Settings)
DebugLog(msg) {
    if !DebugOn
        return
    LogLines.InsertAt(1, FormatTime(, "HH:mm:ss") "." Format("{:03}", A_MSec) "  " msg)
    if (LogLines.Length > 26)
        LogLines.Pop()
    if (UIShown && CurPage = "Settings" && Wnd) {
        s := ""
        for l in LogLines
            s .= l "`n"
        try Wnd.setLog(s)
    }
}

; ───────────────────────── Подписка ─────────────────────────
; Ключ проверяется на сервере при запуске и каждые 6 часов. Без интернета программа
; работает LIC_GRACE_H часов после последней успешной проверки.

LicApi() => RTrim(Get("License", "Api", LICENSE_API), "/")

BuyUrl() {
    u := Get("License", "BuyUrl")
    if (u = "" && LicApi() != "")
        u := LicApi() "/#pricing"
    return u
}

Hwid() {
    static id := ""
    if (id = "") {
        g := RegGet("HKLM\SOFTWARE\Microsoft\Cryptography", "MachineGuid", "")
        id := (g != "") ? "MG-" g : "PC-" A_ComputerName
    }
    return id
}

LicFromCache() {
    if (LicApi() = "")
        return {ok: 1, state: "free"}
    if (Get("License", "Key") = "")
        return {ok: 0, state: "nokey"}
    last := Get("License", "LastOk"), exp := Get("License", "ExpiresTs")
    if (last = "")
        return {ok: 0, state: "checking"}
    if (exp != "" && exp < A_NowUTC)
        return {ok: 0, state: "expired"}
    if (DateDiff(A_NowUTC, last, "Hours") >= LIC_GRACE_H)
        return {ok: 0, state: "offline_expired"}
    return {ok: 1, state: "active"}
}

LicPeriodic() => LicenseCheck()

LicenseCheck(*) {
    global Lic
    wasOk := Lic.ok
    api := LicApi(), key := Get("License", "Key")
    if (api = "") {
        Lic := {ok: 1, state: "free"}
    } else if (key = "") {
        Lic := {ok: 0, state: "nokey"}
    } else {
        res := ""
        try {
            req := ComObject("WinHttp.WinHttpRequest.5.1")
            req.Open("POST", api "/api/license/activate", false)
            req.SetTimeouts(4000, 4000, 6000, 8000)
            req.SetRequestHeader("Content-Type", "application/json")
            req.Send(Json(Map("key", key, "hwid", Hwid(), "app", APP_VERSION)))
            res := req.ResponseText
        }
        if !InStr(res, '"valid"') {
            c := LicFromCache()
            Lic := c.ok ? {ok: 1, state: "offline"} : {ok: 0, state: c.state = "checking" ? "offline_expired" : c.state}
        } else if (JsonVal(res, "valid") = "true") {
            ex := JsonVal(res, "expires_unix")
            SetVal("License", "Plan", JsonVal(res, "plan"))
            SetVal("License", "ExpiresTs", (ex = "" || ex = "0") ? "" : DateAdd("19700101000000", Integer(ex), "Seconds"))
            SetVal("License", "LastOk", A_NowUTC)
            Lic := {ok: 1, state: "active"}
        } else {
            err := JsonVal(res, "error")
            Lic := {ok: 0, state: err != "" ? err : "invalid_key"}
            SetVal("License", "LastOk", "")
        }
        SaveIni()
    }
    ApplyEngine()
    UpdateCrosshair()
    PushState()
    if (Lic.ok && !wasOk && Lic.state = "active")
        Notify("Подписка активна")
}

JsonVal(text, name) {
    if RegExMatch(text, '"' name '"\s*:\s*(?:"((?:[^"\\]|\\.)*)"|(true|false|null|-?[\d.]+))', &m)
        return (m[2] != "") ? (m[2] = "null" ? "" : m[2]) : m[1]
    return ""
}

LicState() {
    ts := Get("License", "ExpiresTs"), exp := ""
    if (ts != "")
        exp := FormatTime(DateAdd(ts, DateDiff(A_Now, A_NowUTC, "Seconds"), "Seconds"), "dd.MM.yyyy")
    key := Get("License", "Key")
    return Map("ok", Lic.ok ? 1 : 0, "state", Lic.state, "plan", Get("License", "Plan"), "expires", exp
        , "key", StrLen(key) > 8 ? SubStr(key, 1, 8) "…" SubStr(key, -4) : key, "api", LicApi() != "" ? 1 : 0, "buy", BuyUrl() != "" ? 1 : 0)
}

; ───────────────────────── Язык ─────────────────────────

Lang() => (Get("General", "Language", "ru") = "en") ? "en" : "ru"

; Перевод уведомлений и меню трея (сам интерфейс переводится в ui.html)
Tr(msg) {
    static en := 0, pats := 0
    if (Lang() != "en")
        return msg
    if !en {
        en := Map("FlashMacro запущен", "FlashMacro started", "Макросы выключены", "Macros off", "Макросы включены", "Macros on"
            , "Бинды импортированы", "Binds imported", "Сброшено к стандартным", "Reset to defaults"
            , "Профиль с таким названием уже есть", "A profile with this name already exists"
            , "Нельзя удалить активный профиль", "You can't delete the active profile", "Профиль сохранён в файл", "Profile saved to file"
            , "Макрос с таким названием уже есть", "A macro with this name already exists"
            , "FlashMacro работает в трее. Клик по иконке — открыть меню.", "FlashMacro keeps running in the tray. Click the icon to open the menu."
            , "Рекомендуемые настройки применены", "Recommended settings applied", "Настройки Windows возвращены как были", "Windows settings restored"
            , "Игровой режим включён", "Game mode on", "Игровой режим выключен", "Game mode off"
            , "Запуск от имени администратора отменён", "Running as administrator was cancelled", "Подписка активна", "Subscription active"
            , "Открыть меню", "Open menu", "Макросы вкл/выкл", "Macros on/off", "Прицел вкл/выкл", "Crosshair on/off", "Выход", "Exit")
        pats := [["^Профиль: (.*)$", "Profile: $1"], ["^Создан профиль «(.*)»$", "Profile “$1” created"]
            , ["^Профиль «(.*)» удалён$", "Profile “$1” deleted"], ["^Импортирован профиль «(.*)»$", "Profile “$1” imported"]
            , ["^Применено, кроме: (.*)$", "Applied, except: $1"], ["^Возвращено, кроме \(нужны права администратора\): (.*)$", "Restored, except (admin rights needed): $1"]
            , ["^Не удалось сохранить config.ini: (.*)$", "Could not save config.ini: $1"]
            , ["^(.*) уже занята \((.*)\), (.*) не назначен$", "$1 is already used ($2), $3 was not assigned"]
            , ["^Не удалось назначить клавишу (.*) \((.*)\)$", "Could not assign key $1 ($2)"]
            , ["^(.*): ВКЛ$", "$1: ON"], ["^(.*): ВЫКЛ$", "$1: OFF"]]
    }
    if en.Has(msg)
        return en[msg]
    for p in pats
        if RegExMatch(msg, p[1])
            return RegExReplace(msg, p[1], p[2])
    return msg
}
