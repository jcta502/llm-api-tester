' Hidden launcher for Touchstone.
' Runs `npm run desktop` with no console window; only the Electron UI shows.
' On failure it pops a message box so a missing `npm install` is still obvious.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
Dim code
code = sh.Run("cmd /c npm run desktop", 0, True)
If code <> 0 Then
  MsgBox "Launch failed (exit code " & code & "). Run 'npm install' in the project folder first, then try again.", 16, "Touchstone"
End If
