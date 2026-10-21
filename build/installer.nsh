; NovaCode NSIS installer hooks.
;
; Registers the `nova` command: <install>\resources\bin\nova.cmd is shipped
; via extraResources and that directory is added to the user PATH here.
; The EnVar plugin bundled with electron-builder's NSIS writes to
; HKCU\Environment for per-user installs (nsis.perMachine is false) and to
; the machine environment for perMachine installs, and broadcasts
; WM_SETTINGCHANGE so new terminals pick the PATH change up.
; The uninstaller already deletes $INSTDIR (including resources\bin);
; customUnInstall only removes the PATH entry.

!macro customInstall
  DetailPrint "Registering the nova command on your PATH..."
  EnVar::Check "PATH" "$INSTDIR\resources\bin"
  Pop $0
  ${If} $0 != "0"
    EnVar::AddValue /NoReset "PATH" "$INSTDIR\resources\bin"
    Pop $0
  ${EndIf}
!macroend

!macro customUnInstall
  DetailPrint "Removing the nova command from your PATH..."
  EnVar::DeleteValue "PATH" "$INSTDIR\resources\bin"
  Pop $0
!macroend
