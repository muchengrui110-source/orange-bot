' 以完全隐藏的方式运行 NapCat 守护脚本（不闪现控制台窗口）
' 用法: wscript.exe run-hidden.vbs "脚本路径"
Option Explicit
Dim shell, fso, scriptPath, args, i, cmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

If WScript.Arguments.Count = 0 Then
  WScript.Quit 1
End If

scriptPath = WScript.Arguments(0)

' 用 powershell 执行脚本，窗口模式 0 = 完全隐藏
cmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & scriptPath & """"
shell.Run cmd, 0, False
