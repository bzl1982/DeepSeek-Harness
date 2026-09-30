@echo off
title 通辽会议测试台启动器
setlocal enabledelayedexpansion
set "MEET=D:\DeepSeek Harness\meeting-lab"
set "ELECTRON=D:\DeepSeek Harness\desktop\node_modules\electron\dist\electron.exe"
set "NODE=D:\Users\Admin\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
set "LOG=%MEET%\启动器日志.txt"

echo [%date% %time%] ==== 启动器开始 ==== >> "%LOG%"

if not exist "%ELECTRON%" echo [%date% %time%] 致命：electron.exe 不存在 %ELECTRON% >> "%LOG%"
if not exist "%ELECTRON%" (
  echo [错误] electron.exe 不存在，详见 "%LOG%"
  pause
  exit /b 1
)

echo [%date% %time%] 清理残留进程... >> "%LOG%"
taskkill /f /im electron.exe >> "%LOG%" 2>&1
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'watchdog' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >> "%LOG%" 2>&1
if exist "%USERPROFILE%\.dsh\profiles\node_modules.lock" (
  del /f /q "%USERPROFILE%\.dsh\profiles\node_modules.lock" >> "%LOG%" 2>&1
  echo [%date% %time%] 已删除孤儿锁 node_modules.lock >> "%LOG%"
)

set ELECTRON_RUN_AS_NODE=
set NODE_OPTIONS=
set CODEBUDDY_SAFE_DELETE_ENABLED=0
echo [%date% %time%] 直接拉起 electron... >> "%LOG%"
start "" "%ELECTRON%" "%MEET%" --no-sandbox --reuse-login --remote-debugging-port=9224

if exist "%NODE%" (
  echo [%date% %time%] 启动看门狗... >> "%LOG%"
  start "" /min "%NODE%" "%MEET%\tools\watchdog.js"
) else (
  echo [%date% %time%] 跳过看门狗（node.exe 缺失） >> "%LOG%"
)

set /a TRY=0
:waitloop
set /a TRY+=1
if %TRY% gtr 12 goto checkresult
ping -n 3 127.0.0.1 >nul
curl -s -m 2 http://127.0.0.1:9224/json/version >nul 2>&1
if %errorlevel%==0 goto ok
goto waitloop
:ok
echo [%date% %time%] OK 测试台已启动（9224 监听中） >> "%LOG%"
echo 测试台已启动（窗口应已出现），本窗口 3 秒后关闭。
ping -n 4 127.0.0.1 >nul
exit /b 0
:checkresult
echo [%date% %time%] FAIL 24秒内 9224 未监听，详见看门狗日志 _watchdog.log >> "%LOG%"
echo [启动失败] 测试台未就绪。详细信息：
echo   启动器日志: "%LOG%"
echo   看门狗日志: "%MEET%\_watchdog.log"
pause
exit /b 1
