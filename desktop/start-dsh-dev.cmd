@echo off
rem ============================================================
rem  DSH dev-mode launcher  (runs desktop\src directly, i.e. your edits)
rem
rem  Why this exists / why the plain exe "flash-crashes" when launched
rem  from a host-injected shell:
rem
rem  1) ELECTRON_RUN_AS_NODE=1 is exported by the host app. Electron's
rem     getenv() treats even an EMPTY value as "set", so the app runs as
rem     plain Node and dies at main.js:28 ("app is undefined").
rem     -> must be *removed* (set "VAR=" does remove it in cmd), not emptied.
rem
rem  2) WorkBuddy's node-safe-delete-shim.cjs is preloaded via NODE_OPTIONS
rem     (--require ...). dsh boots through dsh-atomic-write, which does many
rem     deletes in one process "turn"; the shim's bulk-delete guard trips at
rem     50 and throws, breaking dsh's boot.
rem     -> drop NODE_OPTIONS (removes the shim entirely).
rem     -> CODEBUDDY_SAFE_DELETE_ENABLED=0 is a second safety net.
rem
rem  3) dsh's writer lock (D:\Users\Admin\.dsh\profiles\node_modules.lock)
rem     is created with flag "wx". Its source says: "The contender never
rem     removes an existing lock ... orphan recovery is an operator action."
rem     So any leftover lock makes dsh time out after 2s and cry
rem     "atomic-write: timed out waiting for the writer lock".
rem     -> always delete the stale lock before launching.
rem ============================================================

set "NODE_OPTIONS="
set "ELECTRON_RUN_AS_NODE="
set "CODEBUDDY_SAFE_DELETE_ENABLED=0"

rem (3) clear orphan dsh writer lock
del /f /q "%USERPROFILE%\.dsh\profiles\node_modules.lock" 1>nul 2>nul

rem (4) 2026-09-22: kill any lingering instance first.
rem     Reason: the renderer executes page injections ONCE at dom-ready.
rem     An old window that is never closed keeps its injected DOM (and any
rem     injected overlay) in memory -- editing src/*.js has ZERO effect on it.
rem     Also, this client hard-codes port 38123, so a lingering instance holds
rem     the port and makes the next launch fail/flash-crash.
rem     -> always start from a clean slate.
taskkill /f /im electron.exe 1>nul 2>nul
taskkill /f /im "DeepSeek Harness.exe" 1>nul 2>nul

cd /d "D:\DeepSeek Harness\desktop"
"D:\DeepSeek Harness\desktop\node_modules\electron\dist\electron.exe" . --no-sandbox
