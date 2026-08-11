@echo off
setlocal
pushd "%~dp0"
if errorlevel 1 (
  endlocal
  exit /b 1
)

if exist "%~dp0cli.js" (
  node "%~dp0cli.js" %*
) else if exist "%~dp0dist\src\cli.js" (
  node "%~dp0dist\src\cli.js" %*
) else (
  node --import tsx "%~dp0src\cli.ts" %*
)
set "exitCode=%ERRORLEVEL%"

popd
endlocal & exit /b %exitCode%
