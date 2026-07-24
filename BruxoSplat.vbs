' Abre o BruxoSplat sem nenhuma janela de terminal
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
q = Chr(34)
cmd = q & dir & "\node_modules\electron\dist\electron.exe" & q & " " & q & dir & q
sh.Run cmd, 0, False
