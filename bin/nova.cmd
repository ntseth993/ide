@echo off
rem NovaCode CLI shim (Windows). Installed to <install>\resources\bin\nova.cmd
rem and that directory is added to the user PATH by the NSIS installer.
rem Forwards all arguments to the packaged app; the app resolves `.` against
rem the inherited working directory, so `nova .` opens the current folder.
"%~dp0..\..\NovaCode.exe" %*
