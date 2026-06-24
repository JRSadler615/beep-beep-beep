@echo off
REM ===========================================================================
REM  Beep Beep launcher
REM  Double-click to start everything and open the app in your browser:
REM    - Cloudflare tunnel : ensures the "Cloudflared" Windows service is up
REM                          (needed so eBay's OAuth callback can reach us)
REM    - Backend           : FastAPI on http://localhost:8000  (auto-reloads)
REM    - Frontend          : Vite SPA on http://localhost:3000 (hot-reloads)
REM  The backend/frontend each run in their own window so you can see logs.
REM  Close a window to stop that service.
REM ===========================================================================
setlocal
cd /d "%~dp0"

echo.
echo  Starting Beep Beep...
echo    tunnel   -^> Cloudflared service (eBay OAuth callback)
echo    backend  -^> http://localhost:8000
echo    frontend -^> http://localhost:3000
echo.

REM 1) Cloudflare tunnel: start the service if it isn't already running.
REM    Runs as an installed Windows service, so we ensure it's up rather than
REM    launch a duplicate. Starting a stopped service may require admin rights.
powershell -NoProfile -Command ^
  "$s=Get-Service -Name 'Cloudflared' -ErrorAction SilentlyContinue;" ^
  "if(-not $s){ Write-Host '  [tunnel] Cloudflared service not found - eBay OAuth will not work until it is installed/running.' -ForegroundColor Yellow }" ^
  "elseif($s.Status -eq 'Running'){ Write-Host '  [tunnel] Cloudflared already running.' -ForegroundColor Green }" ^
  "else { try { Start-Service Cloudflared; Write-Host '  [tunnel] Started Cloudflared service.' -ForegroundColor Green } catch { Write-Host '  [tunnel] Could not start Cloudflared automatically (try running this launcher as Administrator).' -ForegroundColor Yellow } }"

REM 2) Backend (FastAPI with hot-reload) in its own window
start "Beep Beep - Backend" cmd /k "cd /d ""%~dp0backend"" && uv run uvicorn app.main:app --reload --port 8000"

REM 3) Frontend (Vite dev server with HMR) in its own window
start "Beep Beep - Frontend" cmd /k "cd /d ""%~dp0frontend"" && npm run dev"

REM 4) Wait until the frontend responds, then open the default browser to it.
powershell -NoProfile -Command ^
  "$u='http://localhost:3000';" ^
  "Write-Host 'Waiting for the frontend to come up...';" ^
  "for($i=0;$i -lt 60;$i++){ try { Invoke-WebRequest -UseBasicParsing -Uri $u -TimeoutSec 2 | Out-Null; break } catch { Start-Sleep -Milliseconds 500 } }" ^
  ";Start-Process $u"

echo.
echo  Browser opened. This window can be closed; the two service windows keep running.
echo.
endlocal
