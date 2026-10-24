; Собирает .exe из AutoHotkey64.exe: кладёт скрипт в ресурс RCDATA #1 (так его ищет AutoHotkey v2) и заменяет иконку.
; Делает то же, что Ahk2Exe, но работает и в 64-битной среде без 32-битного компилятора.
; Запуск: AutoHotkey64.exe compile.ahk <script.ahk> <base.exe> <icon.ico> <out.exe>
#Requires AutoHotkey v2.0
#NoTrayIcon
if (A_Args.Length < 4) {
    FileAppend("usage: compile.ahk script base icon out`n", "*")
    ExitApp 2
}
src := A_Args[1], base := A_Args[2], ico := A_Args[3], out := A_Args[4]
FileCopy(base, out, 1)
h := DllCall("BeginUpdateResourceW", "wstr", out, "int", 0, "ptr")
if !h
    Fail("BeginUpdateResource")

; Скрипт: UTF-8 с BOM, как у Ahk2Exe
text := FileRead(src, "UTF-8")
n := StrPut(text, "UTF-8") - 1
buf := Buffer(n + 3)
NumPut("UChar", 0xEF, "UChar", 0xBB, "UChar", 0xBF, buf)
StrPut(text, buf.Ptr + 3, n, "UTF-8")
if !DllCall("UpdateResourceW", "ptr", h, "ptr", 10, "ptr", 1, "ushort", 0x409, "ptr", buf, "uint", buf.Size)
    Fail("UpdateResource script")

; Иконка: каждая картинка из .ico — ресурс RT_ICON, плюс группа RT_GROUP_ICON с номером 159 (главная иконка AutoHotkey)
f := FileRead(ico, "RAW")
cnt := NumGet(f, 4, "UShort")
grp := Buffer(6 + cnt * 14, 0)
NumPut("UShort", 0, "UShort", 1, "UShort", cnt, grp)
loop cnt {
    e := 6 + (A_Index - 1) * 16
    size := NumGet(f, e + 8, "UInt"), off := NumGet(f, e + 12, "UInt"), id := 200 + A_Index
    if !DllCall("UpdateResourceW", "ptr", h, "ptr", 3, "ptr", id, "ushort", 0x409, "ptr", f.Ptr + off, "uint", size)
        Fail("UpdateResource icon")
    g := 6 + (A_Index - 1) * 14
    DllCall("RtlMoveMemory", "ptr", grp.Ptr + g, "ptr", f.Ptr + e, "uptr", 12)
    NumPut("UShort", id, grp, g + 12)
}
for name in [159, 160, 206, 207, 208]
    DllCall("UpdateResourceW", "ptr", h, "ptr", 14, "ptr", name, "ushort", 0x409, "ptr", 0, "uint", 0)
if !DllCall("UpdateResourceW", "ptr", h, "ptr", 14, "ptr", 159, "ushort", 0x409, "ptr", grp, "uint", grp.Size)
    Fail("UpdateResource group")
if !DllCall("EndUpdateResourceW", "ptr", h, "int", 0)
    Fail("EndUpdateResource")
FileAppend("ok " out "`n", "*")
ExitApp 0

Fail(what) {
    FileAppend("error: " what " " A_LastError "`n", "*")
    ExitApp 1
}
