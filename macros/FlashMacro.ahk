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
ProcessSetPriority "High"

; Точность Sleep до ~1 мс вместо ~15 мс
DllCall("winmm\timeBeginPeriod", "UInt", 1)
OnExit((*) => DllCall("winmm\timeEndPeriod", "UInt", 1))

; ───────────────────────── Настройки по умолчанию ─────────────────────────
; Это же шаблон config.ini: порядок секций и ключей при сохранении берётся отсюда.

DEFAULT_INI := "
(
[General]
; Клавиша вкл/выкл всех макросов
SuspendKey=PgDn
; 1 = макросы работают только в окне Fortnite
OnlyInGame=1
GameExe=FortniteClient-Win64-Shipping.exe
; 1 = лог нажатий в левом верхнем углу
Debug=0
KeyHoldMs=5
ClickHoldMs=5
StartHidden=0

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
    {sec: "AutoSprint", name: "Auto sprint", badge: "AUTO"},
    {sec: "Competitive", name: "Competitive", badge: "PEEK"},
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

; Состояние интерфейса
CLR := {bg: "0E0E11", side: "121216", panel: "17171C", card: "1C1C22", key: "26262D", border: "2A2A31"
    , text: "ECECF1", muted: "8B8B96", accent: "E11D2E", accentDim: "3A1217", blue: "3B82F6"
    , green: "22C55E", white: "FFFFFF", off: "3A3A44"}
W := 1100, H := 700, TOP := 50, SIDE := 200, X0 := 220, FY := TOP + 60, FX := X0 + 215
UI := 0, DPI := 1, Bucket := 0, UIShown := false
Pages := Map(), Groups := Map(), Widgets := [], KeyCaps := Map(), CapBase := Map(), Painted := Map()
NavBtns := Map(), NavBars := Map(), SubBtns := Map(), CustomSlots := [], CustomWidgets := []
PillBtn := 0, StatusLbl := 0, CountLbl := 0, CustomNameEd := 0, CustomEmpty := 0
PV := [], XG := 0, XR := []
XVisible := Bool("Crosshair", "ShowOnStart", true)
CurPage := "Dashboard", CurMacro := "DragEdit", CurCustom := ""
FORMS := Map()
SEQ_HELP := "Последовательность через запятую: число — пауза в мс, X — нажать, +X — зажать, -X — отпустить, {Edit} — бинд со страницы Keybinds. Пример: {Wall}, 10, LButton, 15, {Slot1}"

ApplyEngine()
BuildOverlay()
InitForms()
BuildUI()
SetupTray()
RefreshUI()
UpdateCrosshair()
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

SaveIni() {
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
        f := FileOpen(CFG, "w", "UTF-8-RAW")
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
    if Bool("Crosshair", "Enabled")
        Reg("", Get("Crosshair", "ToggleKey"), ToggleCrosshair, "Crosshair toggle")

    ctx := Bool("General", "OnlyInGame", true) ? Get("General", "GameExe", "FortniteClient-Win64-Shipping.exe") : "*"

    if Bool("DragEdit", "Enabled") {
        t := Get("DragEdit", "Trigger")
        Reg(ctx, t, DragEdit.Bind(t), "Drag edit")
    }
    if Bool("InfiniteEdit", "Enabled") {
        t := Get("InfiniteEdit", "Trigger")
        Reg(ctx, t, InfiniteEdit.Bind(t), "Infinite edit")
    }
    if Bool("InstantEdit", "Enabled")
        Reg(ctx, Get("InstantEdit", "Trigger"), InstantEdit, "Instant edit")
    if Bool("InstantBuild", "Enabled") {
        for piece in ["Wall", "Floor", "Stairs", "Cone"]
            Reg(ctx, Get("InstantBuild", piece "Trigger"), Build.Bind(piece), "Instant build")
    }
    if Bool("Pickup", "Enabled") {
        t := Get("Pickup", "Trigger")
        Reg(ctx, t, Pickup.Bind(t), "Pick-up")
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
        Reg(ctx, t, MacroPress.Bind(m, t), m.name)
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
    UpdateTopBar()
}

; ───────────────────────── Импорт биндов из Fortnite ─────────────────────────
; Ищет пары ActionName/Key в конфигах игры. Если игра хранит бинды только
; в облаке/бинарном файле, ничего не найдётся — тогда бинды задаются вручную.

ImportFromFortnite(*) {
    dir := EnvGet("LOCALAPPDATA") "\FortniteGame\Saved\Config\WindowsClient"
    if !DirExist(dir) {
        MsgBox "Папка настроек Fortnite не найдена:`n" dir, "Импорт из Fortnite", "Icon! Owner" UI.Hwnd
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
    if !found.Count {
        MsgBox "В файлах настроек Fortnite бинды не найдены — игра хранит их в своём формате.`nУкажи бинды вручную на этой странице.", "Импорт из Fortnite", "Iconi Owner" UI.Hwnd
        return
    }
    s := ""
    for k, v in found
        s .= k " → " v "`n"
    if MsgBox("Найдены бинды:`n`n" s "`nПрименить?", "Импорт из Fortnite", "YesNo Owner" UI.Hwnd) = "Yes" {
        for k, v in found
            SetVal("Game", k, v)
        Commit()
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
    global XG, XR
    XG := Gui("+AlwaysOnTop -Caption +ToolWindow +E0x20 -DPIScale")
    XG.MarginX := 0, XG.MarginY := 0
    XG.BackColor := "010101"
    loop 5
        XR.Push(XG.AddText("x0 y0 w1 h1 Background00FF00"))
}

CrossColor() {
    c := Get("Crosshair", "Color", "00FF00")
    return (c ~= "^[0-9A-Fa-f]{6}$" && c != "010101") ? c : "00FF00"
}

CrossGeom() {
    style := StrLower(Get("Crosshair", "Style", "crossdot"))
    len := Max(Round(Num("Crosshair", "Length", 8)), 1)
    th := Max(Round(Num("Crosshair", "Thickness", 2)), 1)
    gap := Max(Round(Num("Crosshair", "Gap", 4)), 0)
    dot := Max(Round(Num("Crosshair", "DotSize", 2)), 1)
    hasLines := style ~= "^(cross|crossdot|t|tdot)$"
    hasTop := style ~= "^cross"
    hasDot := style ~= "dot$"
    S := Max(hasLines ? 2 * (gap + len) + th : 0, hasDot ? dot : 0, 1)
    c := Round((S - th) / 2)
    r := []
    if hasLines {
        r.Push([0, c, len, th])                  ; лево
        r.Push([S - len, c, len, th])            ; право
        r.Push([c, S - len, th, len])            ; низ
        if hasTop
            r.Push([c, 0, th, len])              ; верх
    }
    if hasDot
        r.Push([Round((S - dot) / 2), Round((S - dot) / 2), dot, dot])
    return {S: S, rects: r}
}

PaintRects(ctrls, geo, ox, oy, col, show) {
    for i, ctl in ctrls {
        if (show && i <= geo.rects.Length) {
            q := geo.rects[i]
            ctl.Move(ox + q[1], oy + q[2], q[3], q[4])
            ctl.Opt("Background" col)
            ctl.Visible := true
            ctl.Redraw()
        } else
            ctl.Visible := false
    }
}

UpdateCrosshair() {
    geo := CrossGeom()
    col := CrossColor()
    on := Bool("Crosshair", "Enabled") && XVisible
    PaintRects(XR, geo, 0, 0, col, true)
    if on {
        x := Round((A_ScreenWidth - geo.S) / 2) + Round(Num("Crosshair", "OffsetX", 0))
        y := Round((A_ScreenHeight - geo.S) / 2) + Round(Num("Crosshair", "OffsetY", 0))
        XG.Show(Format("x{} y{} w{} h{} NA", x, y, geo.S, geo.S))
        WinSetTransColor("010101", XG)
    } else
        XG.Hide()
    if PV.Length
        PaintRects(PV, geo, X0 + 535 + 162 - geo.S // 2, FY + 150 - geo.S // 2, col, CurPage = "Crosshair")
}

ToggleCrosshair(*) {
    global XVisible
    XVisible := !XVisible
    UpdateCrosshair()
}

; ───────────────────────── Меню: виджеты ─────────────────────────

Track(ctl) {
    if IsObject(Bucket)
        Bucket.Push(ctl)
    return ctl
}

Rnd(ctl, w, h, r) {
    try WinSetRegion(Format("0-0 w{} h{} R{}-{}", Round(w * DPI), Round(h * DPI), Round(r * DPI), Round(r * DPI)), ctl)
}

Rect(x, y, w, h, col, r := 0) {
    ctl := Track(UI.AddText(Format("x{} y{} w{} h{} Background{}", x, y, w, h, col)))
    if r
        Rnd(ctl, w, h, r)
    return ctl
}

Lbl(x, y, w, h, txt, bg, font := "s10", col := "", opts := "", face := "Segoe UI") {
    UI.SetFont("norm " font " c" (col != "" ? col : CLR.text), face)
    return Track(UI.AddText(Format("x{} y{} w{} h{} +0x80 Background{} {}", x, y, w, h, bg, opts), txt))
}

Btn(x, y, w, h, txt, bg, fn, font := "s10", col := "", r := 6) {
    ctl := Lbl(x, y, w, h, txt, bg, font, col, "Center +0x200")
    ctl.OnEvent("Click", fn)
    if r
        Rnd(ctl, w, h, r)
    return ctl
}

NavItem(x, y, w, h, txt, bg, fn, face := "Segoe UI") {
    ctl := Lbl(x, y, w, h, "   " txt, bg, "s10", CLR.text, "+0x200", face)
    ctl.OnEvent("Click", fn)
    Rnd(ctl, w, h, 8)
    return ctl
}

class Toggle {
    __New(x, y, sec, key) {
        this.sec := sec, this.key := key, this.state := false
        this.c := Lbl(x, y, 40, 22, " ●", CLR.off, "s12", CLR.white, "+0x200")
        Rnd(this.c, 40, 22, 22)
        this.c.OnEvent("Click", (*) => this.Click())
        Widgets.Push(this)
    }
    Set(v) {
        v := ToBool(v)
        this.state := v
        this.c.Opt("Background" (v ? CLR.accent : CLR.off) (v ? " +0x2" : " -0x2"))
        this.c.Text := v ? "● " : " ●"
        this.c.Redraw()
    }
    Click() {
        if (this.sec = "")
            return
        SetVal(this.sec, this.key, this.state ? "0" : "1")
        Commit()
    }
}

class CardState {
    __New(x, y, sec, border) {
        this.sec := sec, this.key := "Enabled", this.border := border
        this.c := Lbl(x, y, 60, 16, "OFF", CLR.card, "s8 bold", CLR.muted)
        Widgets.Push(this)
    }
    Set(v) {
        on := ToBool(v)
        this.c.Text := on ? "ON" : "OFF"
        this.c.SetFont("c" (on ? CLR.accent : CLR.muted))
        this.border.Opt("Background" (on ? "7A1A24" : CLR.border))
    }
}

class KeyBadge {
    __New(x, y, w, h, sec, key) {
        this.sec := sec, this.key := key
        this.c := Lbl(x, y, w, h, "—", CLR.key, "s9 bold", CLR.text, "Center +0x200")
        Rnd(this.c, w, h, 6)
        this.c.OnEvent("Click", (*) => this.Click())
        Widgets.Push(this)
    }
    Set(v) {
        this.c.Text := KeyLabel(v)
    }
    Click() {
        if (this.sec = "")
            return
        r := CaptureKey(this.c)
        if r.ok
            SetVal(this.sec, this.key, r.key)
        Commit()
    }
}

class Seg {
    __New(x, y, opts, labels, bw, sec, key) {
        this.sec := sec, this.key := key, this.opts := opts, this.btns := []
        for i, o in opts
            this.btns.Push(Btn(x + (i - 1) * (bw + 4), y, bw, 26, labels[i], CLR.key, this.Pick.Bind(this, o), "s9"))
        Widgets.Push(this)
    }
    Pick(o, *) {
        if (this.sec = "")
            return
        SetVal(this.sec, this.key, o)
        Commit()
    }
    Set(v) {
        for i, o in this.opts {
            this.btns[i].Opt("Background" (StrLower(v) = StrLower(o) ? CLR.accent : CLR.key))
            this.btns[i].Redraw()
        }
    }
}

class EditField {
    __New(x, y, w, sec, key) {
        this.sec := sec, this.key := key
        UI.SetFont("norm s10 c" CLR.text, "Segoe UI")
        this.c := Track(UI.AddEdit(Format("x{} y{} w{} h24 -E0x200 Background{}", x, y, w, CLR.key)))
        this.c.OnEvent("Change", (*) => this.Changed())
        Widgets.Push(this)
    }
    Set(v) {
        if (this.c.Value != v)
            this.c.Value := v
    }
    Changed() {
        if (this.sec = "")
            return
        SetVal(this.sec, this.key, Trim(this.c.Value))
        SetTimer(Commit, -500)
    }
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

; Ждёт нажатие клавиши/кнопки мыши. Esc — отмена, Backspace — очистить.
CaptureKey(ctl) {
    static busy := false
    if busy
        return {ok: false}
    busy := true
    wasSusp := A_IsSuspended
    Suspend(1)
    ctl.Text := "…"
    ctl.Opt("Background" CLR.accent)
    ctl.Redraw()
    ToolTip "Нажми клавишу или кнопку мыши`nEsc — отмена, Backspace — очистить"
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
    ToolTip
    Suspend(wasSusp ? 1 : 0)
    ctl.Opt("Background" CLR.key)
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

; ───────────────────────── Меню: страницы ─────────────────────────

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


AddField(x, y, sec, f, list := 0) {
    switch f.t {
        case "toggle": w := Toggle(x, y + 2, sec, f.k)
        case "key": w := KeyBadge(x, y, 90, 26, sec, f.k)
        case "choice": w := Seg(x, y, f.o, f.l, f.bw, sec, f.k)
        case "text": w := EditField(x, y + 1, f.w, sec, f.k)
        default:
            w := EditField(x, y + 1, 80, sec, f.k)
            Lbl(x + 88, y, 60, 26, f.HasOwnProp("u") ? f.u : "мс", CLR.panel, "s9", CLR.muted, "+0x200")
    }
    if IsObject(list)
        list.Push(w)
    return w
}

PageTitle(txt, sub := "") {
    Rect(X0, TOP + 22, 4, 22, CLR.accent)
    Lbl(X0 + 14, TOP + 16, 180, 34, txt, CLR.bg, "s17 bold", , "+0x200")
    if (sub != "")
        Lbl(X0 + 200, TOP + 22, 420, 24, sub, CLR.bg, "s9", CLR.muted, "+0x200")
}

BuildUI() {
    global UI, DPI, Bucket, PillBtn, StatusLbl, CountLbl, CustomNameEd, CustomEmpty
    DPI := A_ScreenDPI / 96
    UI := Gui("-Caption -MaximizeBox", "FlashMacro")
    UI.BackColor := CLR.bg
    UI.MarginX := 0, UI.MarginY := 0
    try DllCall("dwmapi\DwmSetWindowAttribute", "ptr", UI.Hwnd, "int", 20, "int*", 1, "int", 4)
    try DllCall("dwmapi\DwmSetWindowAttribute", "ptr", UI.Hwnd, "int", 33, "int*", 2, "int", 4)
    UI.OnEvent("Close", (*) => HideUI())
    OnMessage(0x201, DragWindow)

    ; Верхняя панель (своя, вместо стандартного заголовка окна)
    Bucket := 0
    Rect(0, 0, W, TOP, CLR.side)
    Rect(0, 0, W, 2, CLR.accent)
    Lbl(18, 12, 26, 28, "⚡", CLR.side, "s15", CLR.accent, "Center +0x200", "Segoe UI Symbol")
    Lbl(46, 12, 66, 28, "FLASH", CLR.side, "s15 bold", CLR.text, "+0x200")
    Lbl(112, 12, 80, 28, "MACRO", CLR.side, "s15 bold", CLR.accent, "+0x200")
    PillBtn := Btn(220, 13, 120, 26, "MACROS ON", CLR.accent, (*) => ToggleSuspend(), "s9 bold", CLR.white, 13)
    KeyBadge(348, 13, 64, 26, "General", "SuspendKey")
    StatusLbl := Lbl(W - 300, 13, 200, 26, "", CLR.side, "s9", CLR.green, "Right +0x200")
    Btn(W - 88, 12, 36, 28, "—", CLR.side, (*) => UI.Minimize(), "s10", CLR.muted, 6)
    Btn(W - 48, 12, 36, 28, "×", CLR.side, (*) => (UI.Hide(), HideUI()), "s14", CLR.muted, 6)
    Rect(0, TOP, W, 1, CLR.border)

    ; Боковое меню
    Rect(0, TOP + 1, SIDE, H - TOP - 1, CLR.side)
    Rect(SIDE, TOP + 1, 1, H - TOP - 1, CLR.border)
    Lbl(24, TOP + 18, 150, 18, "МЕНЮ", CLR.side, "s8 bold", CLR.muted)
    icons := Map("Dashboard", "▦", "Keybinds", "⌨", "Macros", "⚡", "Custom", "✚", "Crosshair", "◎", "Settings", "⚙", "Support", "?")
    y := TOP + 42
    for name in ["Dashboard", "Keybinds", "Macros", "Custom", "Crosshair", "Settings", "|", "Support"] {
        if (name = "|") {
            Rect(16, y + 6, SIDE - 32, 1, CLR.border)
            y += 16
            continue
        }
        NavBars[name] := Rect(8, y + 6, 3, 24, CLR.accent)
        NavBtns[name] := NavItem(16, y, SIDE - 28, 36, icons[name] "    " name, CLR.side, GoPage.Bind(name), "Segoe UI Symbol")
        y += 42
    }
    Rect(16, H - 62, SIDE - 32, 1, CLR.border)
    Lbl(24, H - 50, 160, 18, "● FlashMacro v2.0", CLR.side, "s8", CLR.green, , "Segoe UI Symbol")
    Lbl(24, H - 32, 160, 18, "AutoHotkey v2 · Windows", CLR.side, "s8", CLR.muted)

    BuildDashboard()
    BuildKeybinds()
    BuildMacros()
    BuildCustom()
    BuildCrosshair()
    BuildSettings()
    BuildSupport()
    Bucket := 0
    ; Тонкая рамка окна
    Rect(0, 0, 1, H, CLR.border), Rect(W - 1, 0, 1, H, CLR.border), Rect(0, H - 1, W, 1, CLR.border)
    ShowPage("Dashboard")
}

; Перетаскивание окна за верхнюю панель
DragWindow(wp, lp, msg, hwnd) {
    if (UI && hwnd = UI.Hwnd && ((lp >> 16) & 0xFFFF) < TOP * DPI)
        PostMessage(0xA1, 2, 0, , "ahk_id " UI.Hwnd)
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

Cap(x, y, w, h, txt, name, r := 6, font := "s8") {
    ctl := Lbl(x, y, w, h, txt, CLR.key, font, CLR.text, "Center +0x200")
    Rnd(ctl, w, h, r)
    KeyCaps[Norm(name)] := ctl
}

BuildDashboard() {
    global Bucket, CountLbl
    Pages["Dashboard"] := Bucket := []
    PageTitle("Dashboard")
    lx := X0 + 200, ly := TOP + 22
    for it in [["Trigger", CLR.accent], ["Pressed by a macro", CLR.white], ["Macros toggle", CLR.blue], ["Crosshair toggle", CLR.green]] {
        Rect(lx, ly + 5, 12, 12, it[2], 4)
        w := 16 + StrLen(it[1]) * 7
        Lbl(lx + 18, ly, w, 22, it[1], CLR.bg, "s9", CLR.muted, "+0x200")
        lx += w + 34
    }

    ; Клавиатура
    ky := TOP + 66
    Rect(X0, ky, 575, 216, CLR.panel, 12)
    u := 33, g := 4, kh := 28
    yy := ky + 12
    for row in KbRows() {
        xx := X0 + 12
        for kk in row {
            w := Round(kk[3] * u + (kk[3] - 1) * g)
            if (kk[2] != "")
                Cap(xx, yy, w, kh, kk[1], kk[2])
            xx += w + g
        }
        yy += kh + g
    }

    ; Мышь
    mx := X0 + 590
    Rect(mx, ky, 160, 216, CLR.panel, 12)
    Cap(mx + 40, ky + 16, 44, 72, "L", "LButton", 16, "s9 bold")
    Cap(mx + 88, ky + 30, 12, 30, "", "MButton", 6)
    Cap(mx + 104, ky + 16, 44, 72, "R", "RButton", 16, "s9 bold")
    Rect(mx + 40, ky + 92, 108, 110, CLR.key, 40)
    Cap(mx + 12, ky + 96, 22, 34, "5", "XButton2", 8)
    Cap(mx + 12, ky + 136, 22, 34, "4", "XButton1", 8)

    ; Карточки макросов
    Rect(X0, ky + 234, 3, 16, CLR.accent)
    Lbl(X0 + 10, ky + 230, 200, 24, "MACROS", CLR.bg, "s9 bold", CLR.muted, "+0x200")
    CountLbl := Lbl(X0 + 560, ky + 230, 300, 24, "", CLR.bg, "s9", CLR.muted, "Right +0x200")
    y0 := ky + 262, cw := 164, ch := 84
    for i, m in BUILTIN
        Card(X0 + Mod(i - 1, 5) * (cw + 10), y0 + ((i - 1) // 5) * (ch + 10), cw, ch, m)
    i := BUILTIN.Length
    Btn(X0 + Mod(i, 5) * (cw + 10), y0 + (i // 5) * (ch + 10), cw, ch, "+   Add macro", CLR.card, (*) => NewCustom(), "s10", CLR.muted, 10)
}

Card(cx, cy, cw, ch, m) {
    static icons := Map("DragEdit", "✎", "InfiniteEdit", "✎", "InstantEdit", "✎", "InstantBuild", "▦", "Pickup", "✋"
        , "AutoSprint", "»", "Competitive", "◉")
    border := Rect(cx, cy, cw, ch, CLR.border, 10)
    Rect(cx + 1, cy + 1, cw - 2, ch - 2, CLR.card, 9)
    Lbl(cx + cw - 36, cy + 12, 24, 24, icons.Has(m.sec) ? icons[m.sec] : "⚔", CLR.card, "s11", CLR.muted, "Center +0x200", "Segoe UI Symbol")
    if m.HasOwnProp("badge")
        Btn(cx + 12, cy + 12, 52, 24, m.badge, CLR.key, GoMacro.Bind(m.sec), "s8 bold", CLR.text, 6)
    else
        KeyBadge(cx + 12, cy + 12, 52, 24, m.sec, "Trigger")
    nm := Lbl(cx + 12, cy + 42, cw - 24, 20, m.name, CLR.card, "s10 bold")
    nm.OnEvent("Click", GoMacro.Bind(m.sec))
    CardState(cx + 12, cy + 62, m.sec, border)
    Toggle(cx + cw - 52, cy + 54, m.sec, "Enabled")
}

BuildKeybinds() {
    global Bucket
    Pages["Keybinds"] := Bucket := []
    PageTitle("Keybinds", "Клавиши из настроек управления Fortnite")
    Btn(X0 + 660, TOP + 18, 200, 30, "Import from Fortnite", CLR.key, ImportFromFortnite, "s9 bold", CLR.text, 8)
    cols := [[["Edit", "Редактирование"], ["Select", "Выбор / выстрел"], ["Wall", "Стена"], ["Floor", "Пол"]
            , ["Stairs", "Лестница"], ["Cone", "Конус (крыша)"], ["Pickaxe", "Кирка"], ["Interact", "Взаимодействие"]]
        , [["Crouch", "Присесть"], ["Jump", "Прыжок"], ["Sprint", "Спринт"], ["Slot1", "Слот оружия 1"]
            , ["Slot2", "Слот оружия 2"], ["Slot3", "Слот оружия 3"], ["Slot4", "Слот оружия 4"], ["Slot5", "Слот оружия 5"]]]
    for ci, col in cols {
        px := X0 + (ci - 1) * 440
        Rect(px, FY, 420, 20 + col.Length * 44, CLR.panel, 12)
        for ri, b in col {
            y := FY + 14 + (ri - 1) * 44
            Lbl(px + 20, y, 145, 28, b[2], CLR.panel, "s10", , "+0x200")
            Lbl(px + 170, y, 110, 28, b[1], CLR.panel, "s9", CLR.muted, "+0x200")
            KeyBadge(px + 300, y + 1, 96, 26, "Game", b[1])
        }
    }
    Lbl(X0, FY + 390, 860, 60, "Бинды должны совпадать с настройками управления в Fortnite — макросы нажимают именно эти клавиши.`nКлик по клавише → нажми новую клавишу или кнопку мыши. Esc — отмена, Backspace — очистить.", CLR.bg, "s9", CLR.muted)
}

BuildMacros() {
    global Bucket
    Pages["Macros"] := Bucket := []
    PageTitle("Macros", "Тонкая настройка каждого макроса")
    Rect(X0, FY, 200, 560, CLR.panel, 12)
    for i, m in BUILTIN
        SubBtns[m.sec] := NavItem(X0 + 8, FY + 8 + (i - 1) * 38, 184, 34, m.name, CLR.panel, SelectMacro.Bind(m.sec))
    Rect(FX, FY, 645, 560, CLR.panel, 12)
    for m in BUILTIN {
        Groups[m.sec] := Bucket := []
        spec := FORMS[m.sec]
        Lbl(FX + 24, FY + 18, 590, 30, m.name, CLR.panel, "s15 bold", , "+0x200")
        Lbl(FX + 24, FY + 52, 590, 48, spec.desc, CLR.panel, "s9", CLR.muted)
        y := FY + 108
        for f in spec.fields {
            Lbl(FX + 24, y, 250, 28, f.label, CLR.panel, "s10", , "+0x200")
            AddField(FX + 280, y, m.sec, f)
            y += 44
        }
        if (SubStr(m.sec, 1, 6) = "Macro:")
            Lbl(FX + 24, y + 8, 600, 54, SEQ_HELP, CLR.panel, "s9", CLR.muted)
    }
}

BuildCustom() {
    global Bucket, CustomNameEd, CustomEmpty
    Pages["Custom"] := Bucket := []
    PageTitle("Custom", "Свои макросы из любых нажатий")
    Rect(X0, FY, 200, 560, CLR.panel, 12)
    Btn(X0 + 10, FY + 10, 180, 32, "+  New macro", CLR.accent, (*) => NewCustom(), "s10 bold", CLR.white, 8)
    loop 12
        CustomSlots.Push(NavItem(X0 + 8, FY + 52 + (A_Index - 1) * 38, 184, 34, "", CLR.panel, SelectCustom.Bind(A_Index)))
    Rect(FX, FY, 645, 560, CLR.panel, 12)
    CustomEmpty := Lbl(FX + 24, FY + 24, 590, 60, "Своих макросов пока нет.`nНажми «+ New macro» слева.", CLR.panel, "s11", CLR.muted)

    Groups["CustomForm"] := Bucket := []
    Lbl(FX + 24, FY + 22, 250, 28, "Название", CLR.panel, "s10", , "+0x200")
    UI.SetFont("norm s11 bold c" CLR.text, "Segoe UI")
    CustomNameEd := Track(UI.AddEdit(Format("x{} y{} w260 h28 -E0x200 Background{}", FX + 280, FY + 22, CLR.key)))
    CustomNameEd.OnEvent("Change", (*) => SetTimer(RenameCustom, -800))
    CustomNameEd.OnEvent("LoseFocus", (*) => RenameCustom())
    y := FY + 70
    for f in MacroFields() {
        Lbl(FX + 24, y, 250, 28, f.label, CLR.panel, "s10", , "+0x200")
        AddField(FX + 280, y, "", f, CustomWidgets)
        y += 44
    }
    Lbl(FX + 24, y + 8, 600, 54, SEQ_HELP, CLR.panel, "s9", CLR.muted)
    Btn(FX + 24, FY + 500, 170, 32, "Удалить макрос", CLR.accentDim, (*) => DeleteCustom(), "s10", CLR.accent, 8)
}

BuildCrosshair() {
    global Bucket
    Pages["Crosshair"] := Bucket := []
    PageTitle("Crosshair", "Свой прицел поверх игры")
    Rect(X0, FY, 520, 560, CLR.panel, 12)
    rows := [Fld("toggle", "Enabled", "Прицел включён"), Fld("toggle", "ShowOnStart", "Показывать при запуске")
        , Fld("key", "ToggleKey", "Клавиша вкл/выкл")
        , Fld("choice", "Style", "Стиль", {o: ["dot", "cross", "crossdot", "t", "tdot"], l: ["•", "+", "+ •", "T", "T •"], bw: 46})
        , Fld("color", "Color", "Цвет")
        , Fld("num", "Length", "Длина линий", {u: "px"}), Fld("num", "Thickness", "Толщина", {u: "px"})
        , Fld("num", "Gap", "Отступ от центра", {u: "px"}), Fld("num", "DotSize", "Размер точки", {u: "px"})
        , Fld("num", "OffsetX", "Сдвиг по X", {u: "px"}), Fld("num", "OffsetY", "Сдвиг по Y", {u: "px"})]
    y := FY + 16
    for f in rows {
        Lbl(X0 + 20, y, 180, 28, f.label, CLR.panel, "s10", , "+0x200")
        if (f.t = "color") {
            for i, c in ["00FF00", "FF2D2D", "00E5FF", "FFE600", "FFFFFF", "FF00E6"]
                Btn(X0 + 200 + (i - 1) * 32, y + 1, 26, 26, "", c, SetColor.Bind(c), "s8", , 13)
            EditField(X0 + 400, y + 2, 90, "Crosshair", "Color")
        } else
            AddField(X0 + 200, y, "Crosshair", f)
        y += 44
    }
    Rect(X0 + 535, FY, 325, 300, "0B0B0E", 12)
    Lbl(X0 + 550, FY + 10, 200, 20, "Превью", "0B0B0E", "s9", CLR.muted)
    loop 5
        PV.Push(Track(UI.AddText("x0 y0 w1 h1 Background00FF00")))
    Lbl(X0 + 535, FY + 312, 325, 80, "Прицел рисуется поверх экрана. В Fortnite выбери режим окна «Оконный полноэкранный», иначе его не будет видно.", CLR.bg, "s9", CLR.muted)
}

BuildSettings() {
    global Bucket
    Pages["Settings"] := Bucket := []
    PageTitle("Settings", "Общие настройки FlashMacro")
    Rect(X0, FY, 640, 380, CLR.panel, 12)
    rows := [Fld("key", "SuspendKey", "Вкл/выкл все макросы"), Fld("toggle", "OnlyInGame", "Работать только в окне Fortnite")
        , Fld("text", "GameExe", "Процесс игры", {w: 280}), Fld("toggle", "Debug", "Лог нажатий на экране (для теста)")
        , Fld("num", "KeyHoldMs", "Удержание клавиши"), Fld("num", "ClickHoldMs", "Удержание кнопки мыши")
        , Fld("toggle", "StartHidden", "Запускать свёрнутым в трей")]
    y := FY + 18
    for f in rows {
        Lbl(X0 + 24, y, 290, 28, f.label, CLR.panel, "s10", , "+0x200")
        AddField(X0 + 320, y, "General", f)
        y += 48
    }
    Btn(X0, FY + 400, 190, 34, "Открыть config.ini", CLR.key, (*) => Run('notepad.exe "' CFG '"'), "s10", CLR.text, 8)
    Btn(X0 + 200, FY + 400, 190, 34, "Открыть папку", CLR.key, (*) => Run(A_ScriptDir), "s10", CLR.text, 8)
    Btn(X0 + 400, FY + 400, 190, 34, "Выйти из FlashMacro", CLR.accentDim, (*) => ExitApp(), "s10", CLR.accent, 8)
}

BuildSupport() {
    global Bucket
    Pages["Support"] := Bucket := []
    PageTitle("Support", "Помощь и советы")
    Rect(X0, FY, 860, 520, CLR.panel, 12)
    txt := "
    (
Как начать
1. Keybinds — укажи те же клавиши, что в настройках управления Fortnite.
2. Dashboard — включи нужные макросы тумблерами. Клик по клавише на карточке меняет клавишу запуска.
3. Macros — тонкая настройка каждого макроса: задержки, режим подтверждения, FPS.
4. Custom — свои макросы из любых нажатий (один раз / пока держишь / вкл-выкл).
5. Crosshair — свой прицел поверх игры.

Настройки Fortnite
• «Подтверждать редактирование при отпускании» — ВКЛ (или включи Competitive Mode).
• «Турбо-строительство» — ВКЛ (для непрерывной стройки).
• Режим окна — «Оконный полноэкранный» (для прицела).

Если макрос не срабатывает
• Увеличь задержки до 15–20 мс — при низком FPS игра не успевает за слишком быстрыми нажатиями.
• Запусти FlashMacro от имени администратора.
• Проверь в Settings, что «Процесс игры» совпадает с процессом в Диспетчере задач.
• Для проверки без игры: Settings → выключи «Работать только в окне Fortnite» и включи «Лог нажатий».

Закрытие окна сворачивает FlashMacro в трей — макросы продолжают работать. Выход — через трей или Settings.
⚠ Epic запрещает макросы в турнирах и соревновательных режимах.
    )"
    Lbl(X0 + 24, FY + 20, 812, 480, txt, CLR.panel, "s10")
}

; ───────────────────────── Меню: логика ─────────────────────────

GoPage(name, *) => ShowPage(name)

GoMacro(sec, *) {
    global CurMacro, CurCustom
    if (sec ~= "i)^Macro:") && !IsPreset(sec) {
        CurCustom := sec
        ShowPage("Custom")
    } else {
        CurMacro := sec
        ShowPage("Macros")
    }
}

SelectMacro(sec, *) {
    global CurMacro
    CurMacro := sec
    ShowPage("Macros")
}

ShowPage(name) {
    global CurPage
    CurPage := name
    DllCall("SendMessage", "ptr", UI.Hwnd, "uint", 0xB, "ptr", 0, "ptr", 0)
    for n, arr in Pages
        if (n != name)
            for ctl in arr
                ctl.Visible := false
    for n, arr in Groups
        for ctl in arr
            ctl.Visible := false
    for ctl in Pages[name]
        ctl.Visible := true
    if (name = "Macros") {
        for ctl in Groups[CurMacro]
            ctl.Visible := true
        for s, b in SubBtns {
            b.Opt("Background" (s = CurMacro ? CLR.accentDim : CLR.panel))
            b.Redraw()
        }
    }
    if (name = "Custom")
        ShowCustomState()
    for n, b in NavBtns {
        b.Opt("Background" (n = name ? CLR.accentDim : CLR.side))
        NavBars[n].Visible := (n = name)
    }
    DllCall("SendMessage", "ptr", UI.Hwnd, "uint", 0xB, "ptr", 1, "ptr", 0)
    DllCall("RedrawWindow", "ptr", UI.Hwnd, "ptr", 0, "ptr", 0, "uint", 0x185)
    if (name = "Crosshair")
        UpdateCrosshair()
}

ShowCustomState() {
    global CurCustom
    list := CustomList()
    if (CurCustom = "" || !C.Has(CurCustom))
        CurCustom := list.Length ? list[1] : ""
    onPage := (CurPage = "Custom")
    for i, s in CustomSlots {
        if (i <= list.Length) {
            s.Text := "   " SubStr(list[i], 7)
            s.Opt("Background" (list[i] = CurCustom ? CLR.accentDim : CLR.panel))
            s.Visible := onPage
            s.Redraw()
        } else
            s.Visible := false
    }
    for w in CustomWidgets {
        w.sec := CurCustom
        w.Set(Get(CurCustom, w.key))
    }
    if (Trim(CustomNameEd.Value) != SubStr(CurCustom, 7))
        CustomNameEd.Value := SubStr(CurCustom, 7)
    for ctl in Groups["CustomForm"]
        ctl.Visible := onPage && CurCustom != ""
    CustomEmpty.Visible := onPage && CurCustom = ""
}

SelectCustom(i, *) {
    global CurCustom
    list := CustomList()
    if (i <= list.Length)
        CurCustom := list[i]
    ShowCustomState()
}

NewCustom(*) {
    global CurCustom
    if (CustomList().Length >= CustomSlots.Length) {
        Notify("Максимум " CustomSlots.Length " своих макросов")
        return
    }
    n := 1
    while C.Has("Macro:Macro " n)
        n++
    sec := "Macro:Macro " n
    for k, v in Map("Enabled", "0", "Trigger", "", "Mode", "once", "Sequence", "", "Speed", "1", "Interval", "10")
        SetVal(sec, k, v)
    CurCustom := sec
    Commit()
    ShowPage("Custom")
}

RenameCustom(*) {
    global CurCustom
    if (CurCustom = "")
        return
    new := Trim(RegExReplace(CustomNameEd.Value, "[\[\]=;:]"))
    old := SubStr(CurCustom, 7)
    if (new = old || new = "")
        return
    target := "Macro:" new
    if C.Has(target) {
        Notify("Макрос с таким названием уже есть")
        return
    }
    C[target] := C[CurCustom]
    C.Delete(CurCustom)
    CurCustom := target
    Commit()
}

DeleteCustom() {
    global CurCustom
    if (CurCustom = "")
        return
    if MsgBox("Удалить макрос «" SubStr(CurCustom, 7) "»?", "FlashMacro", "YesNo Owner" UI.Hwnd) != "Yes"
        return
    C.Delete(CurCustom)
    CurCustom := ""
    Commit()
}

SetColor(c, *) {
    SetVal("Crosshair", "Color", c)
    Commit()
}

Commit(*) {
    SaveIni()
    ApplyEngine()
    RefreshUI()
    UpdateCrosshair()
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
    for s in C
        if (s ~= "i)^Macro:") && Bool(s, "Enabled")
            r.Push(Get(s, "Trigger"))
    return r
}

RefreshUI() {
    global CapBase, Painted
    if !UI
        return
    for w in Widgets
        if (w.sec != "")
            w.Set(Get(w.sec, w.key))
    CapBase := Map()
    for t in EnabledTriggers()
        if (t != "")
            CapBase[Norm(t)] := "trig"
    if (k := Get("General", "SuspendKey"))
        CapBase[Norm(k)] := "sus"
    if Bool("Crosshair", "Enabled") && (k := Get("Crosshair", "ToggleKey"))
        CapBase[Norm(k)] := "xh"
    Painted := Map()
    FlashTick()
    active := 0, total := BUILTIN.Length + CustomList().Length
    for m in BUILTIN
        active += Bool(m.sec, "Enabled")
    for s in CustomList()
        active += Bool(s, "Enabled")
    CountLbl.Text := active " active · " total " total"
    UpdateTopBar()
    if (CurPage = "Custom")
        ShowCustomState()
    ; Перерисовать окно целиком, чтобы наложенные элементы карточек легли в правильном порядке
    if UIShown
        DllCall("RedrawWindow", "ptr", UI.Hwnd, "ptr", 0, "ptr", 0, "uint", 0x185)
}

FlashTick() {
    now := A_TickCount
    for n, ctl in KeyCaps {
        st := CapBase.Get(n, "none")
        if Pressed.Has(n) {
            p := Pressed[n]
            if (p.down || now - p.t < 150)
                st := "press"
            else
                Pressed.Delete(n)
        }
        if (Painted.Get(n, "") != st) {
            switch st {
                case "press": bg := CLR.white, fg := "111111"
                case "trig": bg := CLR.accent, fg := CLR.white
                case "sus": bg := CLR.blue, fg := CLR.white
                case "xh": bg := CLR.green, fg := "111111"
                default: bg := CLR.key, fg := CLR.text
            }
            ctl.Opt("Background" bg)
            ctl.SetFont("c" fg)
            ctl.Redraw()
            Painted[n] := st
        }
    }
}

UpdateTopBar() {
    if !PillBtn
        return
    on := !A_IsSuspended
    PillBtn.Text := on ? "MACROS ON" : "MACROS OFF"
    PillBtn.Opt("Background" (on ? CLR.accent : CLR.off))
    PillBtn.Redraw()
    StatusLbl.Text := on ? "● Макросы активны" : "● На паузе"
    StatusLbl.SetFont("c" (on ? CLR.green : CLR.muted))
}

ShowUI(*) {
    global UIShown
    UI.Show("w" W " h" H)
    UIShown := true
    RefreshUI()
    SetTimer(FlashTick, 40)
}

HideUI() {
    global UIShown
    static told := false
    UIShown := false
    SetTimer(FlashTick, 0)
    if !told {
        told := true
        TrayTip "FlashMacro работает в трее. Клик по иконке — открыть меню.", "FlashMacro"
    }
}

; ───────────────────────── Трей и отладка ─────────────────────────

SetupTray() {
    A_IconTip := "FlashMacro"
    t := A_TrayMenu
    t.Delete()
    t.Add("Открыть меню", ShowUI)
    t.Add("Макросы вкл/выкл", ToggleSuspend)
    t.Add("Прицел вкл/выкл", ToggleCrosshair)
    t.Add()
    t.Add("Выход", (*) => ExitApp())
    t.Default := "Открыть меню"
    t.ClickCount := 1
}

Notify(msg) {
    ToolTip msg
    SetTimer(() => ToolTip(), -1800)
}

DebugLog(msg) {
    static lines := []
    if !DebugOn
        return
    lines.Push(FormatTime(, "HH:mm:ss") "." Format("{:03}", A_MSec) "  " msg)
    if (lines.Length > 15)
        lines.RemoveAt(1)
    s := ""
    for l in lines
        s .= l "`n"
    ToolTip s, 10, 10, 2
}
