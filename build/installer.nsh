; NovaCode — custom NSIS installer script.
; -----------------------------------------------------------------------------
; Auto-included by electron-builder (build/installer.nsh). Kept intentionally
; small and ADDITIVE: it must not redefine any MUI_* symbol that electron-builder
; already passes on the command line, because the installer is compiled with
; makensis -WX (warnings treated as errors).
;
; electron-builder's assisted (setup wizard) installer omits the Welcome page by
; default, so the branded sidebar artwork would only show on the Finish page.
; Inserting a Welcome page here surfaces it from the very first screen.
; -----------------------------------------------------------------------------

!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
!macroend
