; FlashMacro — макросы для клавиатуры и мыши (Fortnite) на AutoHotkey v2.
; Все настройки в config.ini рядом со скриптом. После правки — «Перезагрузить» в трее.

#Requires AutoHotkey v2.0
#SingleInstance Force
#UseHook True
#MaxThreadsPerHotkey 1
InstallKeybdHook
InstallMouseHook
SendMode "Input"
SetKeyDelay -1, -1
SetMouseDelay -1
A_MaxHotkeysPerInterval := 5000
ProcessSetPriority "High"

; Точность Sleep до ~1 мс вместо ~15 мс
DllCall("winmm\timeBeginPeriod", "UInt", 1)
OnExit((*) => DllCall("winmm\timeEndPeriod", "UInt", 1))

CFG := A_ScriptDir "\config.ini"
if !FileExist(CFG) {
    MsgBox "config.ini не найден рядом со скриптом.", "FlashMacro", "Icon!"
    ExitApp
}

C := LoadIni(CFG)
DebugOn := Bool("General", "Debug")
HoldMs := Num("General", "KeyHoldMs", 5)
ClickHold := Num("General", "ClickHoldMs", 5)
Used := Map()          ; занятые триггеры
Macros := []           ; пользовательские макросы
Placing := false       ; держим ли «ЛКМ» для непрерывной стройки
XGui := ""
XPos := ""
XVisible := false

SetupTray()
RegisterAll()
SetupCrosshair()
Notify("FlashMacro запущен")
return

; ───────────────────────── Конфиг ─────────────────────────

LoadIni(path) {
    cfg := Map()
    cfg.CaseSense := "Off"
    sec := ""
    for line in StrSplit(FileRead(path, "UTF-8"), "`n", "`r") {
        line := Trim(line)
        if (line = "" || SubStr(line, 1, 1) = ";")
            continue
        if RegExMatch(line, "^\[(.+)\]$", &m) {
            sec := Trim(m[1])
            if !cfg.Has(sec) {
                s := Map()
                s.CaseSense := "Off"
                cfg[sec] := s
            }
            continue
        }
        if (sec != "" && (p := InStr(line, "="))) {
            val := RegExReplace(Trim(SubStr(line, p + 1)), "\s+;.*$")
            cfg[sec][Trim(SubStr(line, 1, p - 1))] := val
        }
    }
    return cfg
}

Get(sec, key, def := "") {
    return (C.Has(sec) && C[sec].Has(key) && C[sec][key] != "") ? C[sec][key] : def
}

Num(sec, key, def) {
    v := Get(sec, key, def)
    return IsNumber(v) ? Number(v) : def
}

Bool(sec, key, def := false) {
    v := StrLower(Get(sec, key, def ? "1" : "0"))
    return v = "1" || v = "true" || v = "on" || v = "yes"
}

; Игровой бинд из секции [Game]
B(name) => Get("Game", name, "")

; ───────────────────────── Ввод ─────────────────────────

IsMouse(k) => k ~= "i)^([LRM]Button|XButton[12]|Wheel(Up|Down|Left|Right))$"
IsWheel(k) => k ~= "i)^Wheel"
Held(k) => !IsWheel(k) && GetKeyState(k, "P")

Down(k) {
    if (k = "")
        return
    SendInput(IsWheel(k) ? "{Blind}{" k "}" : "{Blind}{" k " down}")
    DebugLog(k " down")
}

Up(k) {
    if (k = "" || IsWheel(k))
        return
    SendInput "{Blind}{" k " up}"
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

; ───────────────────────── Регистрация ─────────────────────────

Bind(trig, fn) {
    if (trig = "")
        return
    k := StrLower(trig)
    if Used.Has(k) {
        MsgBox "Клавиша '" trig "' назначена на несколько макросов. Оставлен первый.", "FlashMacro", "Icon!"
        return
    }
    try {
        Hotkey((IsMouse(trig) ? "*" : "$*") trig, fn, "On")
        Used[k] := true
    } catch Error as e {
        MsgBox "Не удалось назначить клавишу '" trig "':`n" e.Message, "FlashMacro", "Icon!"
    }
}

RegisterAll() {
    ; Глобальные клавиши (работают и на паузе)
    if (k := Get("General", "SuspendKey", "F8"))
        Hotkey k, ToggleSuspend, "S"
    if (k := Get("Crosshair", "ToggleKey", ""))
        Hotkey k, ToggleCrosshair

    if Bool("General", "OnlyInGame", true)
        HotIfWinActive "ahk_exe " Get("General", "GameExe", "FortniteClient-Win64-Shipping.exe")

    if Bool("DragEdit", "Enabled") {
        t := Get("DragEdit", "Trigger")
        Bind(t, DragEdit.Bind(t))
    }
    if Bool("InstantEdit", "Enabled")
        Bind(Get("InstantEdit", "Trigger"), InstantEdit)
    if Bool("InfiniteEdit", "Enabled") {
        t := Get("InfiniteEdit", "Trigger")
        Bind(t, InfiniteEdit.Bind(t))
    }
    if Bool("InstantBuild", "Enabled") {
        for piece in ["Wall", "Floor", "Stairs", "Cone"]
            Bind(Get("InstantBuild", piece "Trigger"), Build.Bind(piece))
    }
    if Bool("Pickup", "Enabled") {
        t := Get("Pickup", "Trigger")
        Bind(t, Pickup.Bind(t))
    }

    ; Пользовательские макросы и пресеты: секции [Macro:Имя]
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
        Bind(t, MacroPress.Bind(m, t))
    }

    ; Непрерывная стройка: эти клавиши отпускают «ЛКМ» (сами клавиши проходят в игру)
    if Bool("InstantBuild", "Enabled") && Bool("InstantBuild", "Continuous") {
        for k in StrSplit(Get("InstantBuild", "StopKeys"), ",", " `t")
            if (k != "" && !Used.Has(StrLower(k)))
                try Hotkey "~*" k, (*) => StopPlace()
        sel := B("Select")
        if (sel != "" && !Used.Has(StrLower(sel)))
            try Hotkey "~*" sel " up", PlaceReleased
    }
    HotIf
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

; Одно редактирование: войти в редактирование → выбрать тайл → подтвердить
EditCycle(sec) {
    Tap(B("Edit"))
    Wait(Num(sec, "EnterDelay", 10))
    Tap(B("Select"))
    if (Get(sec, "ConfirmBy", "release") = "key") {
        Wait(Num(sec, "ConfirmDelay", 10))
        Tap(B("Edit"))
    }
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
    if (Get("DragEdit", "ConfirmBy", "release") = "key") {
        Wait(Num("DragEdit", "ConfirmDelay", 10))
        Tap(B("Edit"))
    }
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
    Notify(A_IsSuspended ? "Макросы на паузе" : "Макросы включены")
}

; ───────────────────────── Прицел ─────────────────────────

SetupCrosshair() {
    global XGui, XPos
    if !Bool("Crosshair", "Enabled")
        return
    style := StrLower(Get("Crosshair", "Style", "cross"))
    col := Get("Crosshair", "Color", "00FF00")
    len := Round(Num("Crosshair", "Length", 8))
    th := Round(Num("Crosshair", "Thickness", 2))
    gap := Round(Num("Crosshair", "Gap", 3))
    dot := Round(Num("Crosshair", "DotSize", 2))

    hasLines := style ~= "^(cross|crossdot|t|tdot)$"
    hasTop := style ~= "^cross"
    hasDot := style ~= "dot$"
    S := Max(hasLines ? 2 * (gap + len) + th : 0, hasDot ? dot : 0, 1)
    c := Round((S - th) / 2)

    g := Gui("+AlwaysOnTop -Caption +ToolWindow +E0x20 -DPIScale")
    g.MarginX := 0, g.MarginY := 0
    g.BackColor := "010101"
    R(x, y, w, h) => g.AddText(Format("x{} y{} w{} h{} Background{}", x, y, w, h, col))
    if hasLines {
        R(0, c, len, th)                 ; лево
        R(S - len, c, len, th)           ; право
        R(c, S - len, th, len)           ; низ
        if hasTop
            R(c, 0, th, len)             ; верх
    }
    if hasDot
        R(Round((S - dot) / 2), Round((S - dot) / 2), dot, dot)

    x := Round((A_ScreenWidth - S) / 2) + Round(Num("Crosshair", "OffsetX", 0))
    y := Round((A_ScreenHeight - S) / 2) + Round(Num("Crosshair", "OffsetY", 0))
    XGui := g
    XPos := Format("x{} y{} w{} h{} NA", x, y, S, S)
    if Bool("Crosshair", "ShowOnStart", true)
        ToggleCrosshair()
}

ToggleCrosshair(*) {
    global XVisible
    if !XGui
        return
    if XVisible {
        XGui.Hide()
    } else {
        XGui.Show(XPos)
        WinSetTransColor "010101", "ahk_id " XGui.Hwnd
    }
    XVisible := !XVisible
}

; ───────────────────────── Трей и отладка ─────────────────────────

SetupTray() {
    A_IconTip := "FlashMacro"
    t := A_TrayMenu
    t.Delete()
    t.Add("Открыть config.ini", (*) => Run('notepad.exe "' CFG '"'))
    t.Add("Перезагрузить настройки", (*) => Reload())
    t.Add("Пауза вкл/выкл", ToggleSuspend)
    t.Add("Прицел вкл/выкл", ToggleCrosshair)
    t.Add()
    t.Add("Выход", (*) => ExitApp())
}

Notify(msg) {
    ToolTip msg
    SetTimer(() => ToolTip(), -1500)
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
