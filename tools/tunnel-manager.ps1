# tunnel-manager.ps1 - Giu 2 tunnel quick (VieNeu 8000, YTDLP 8787) + 2 service local song,
# va tu dong cap nhat env Render (YTDLP_WORKER_URL, VIENEU_BASE_URL) khi URL doi.
# Co mutex chong chay trung. Moi lan chay 1 lan roi thoat.

$ErrorActionPreference = 'Continue'
$base    = 'D:\Rexi AI'
$tools   = Join-Path $base 'tools'
$tundir  = 'D:\Temp\opencode\tunnels'
$cfexe   = Join-Path $tools 'cloudflared\cloudflared.exe'
$nodeexe = 'C:\Program Files\nodejs\node.exe'
$pyexe   = Join-Path $tools 'VieNeu-TTS\.venv\Scripts\python.exe'
$viedir  = Join-Path $tools 'VieNeu-TTS'
$ytdir   = Join-Path $tools 'ytdlp-worker'
$ytjs    = Join-Path $ytdir 'worker.js'
$cookies = 'D:\Temp\opencode\yt-cookies.txt'
$rkeyfile= 'D:\Temp\opencode\render-key-acct3.txt'
$rsvc    = 'srv-davqgebtqb8s73de1m00'
$rbase   = 'https://api.render.com/v1'
New-Item -ItemType Directory -Force -Path $tundir | Out-Null
$mlog = Join-Path $tundir 'manager.log'
function Log($m){ $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'; Add-Content -Path $mlog -Value ("$ts  $m") }

# --- mutex: only one instance at a time ---
$mutex = New-Object System.Threading.Mutex($false, 'Global\RexiTunnelManager')
if (-not $mutex.WaitOne(0)) { Log 'another instance already running -> exit'; exit }

function PortUp($p){ return ((Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0) }

function EnsureVieNeu {
    if (PortUp 8000) { return }
    Log 'VieNeu: not listening -> starting'
    Start-Process -FilePath $pyexe -ArgumentList '-m','apps.openai_speech' -WorkingDirectory $viedir -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $tundir 'vieneu.out.log') -RedirectStandardError (Join-Path $tundir 'vieneu.err.log')
    for ($i=0; $i -lt 40; $i++) { if (PortUp 8000) { Log 'VieNeu: up'; return }; Start-Sleep 3 }
    Log 'VieNeu: FAILED to start'
}

function WorkerHealthy {
    try {
        $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8787/health' -UseBasicParsing -TimeoutSec 8
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

function EnsureWorker {
    if ((PortUp 8787) -and (WorkerHealthy)) { return }
    if (PortUp 8787) {
        Log 'YTDLP worker: port open but UNHEALTHY -> kill + restart'
        Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'ytdlp-worker' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        Get-Process yt-dlp -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep 2
    } else { Log 'YTDLP worker: not listening -> starting' }
    $env:PORT = '8787'; $env:WORKER_TOKEN = 'rexi-ytdlp-2026'; $env:COOKIES_FILE = $cookies
    Start-Process -FilePath $nodeexe -ArgumentList $ytjs -WorkingDirectory $ytdir -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $tundir 'ytdlp.out.log') -RedirectStandardError (Join-Path $tundir 'ytdlp.err.log')
    for ($i=0; $i -lt 20; $i++) { if ((PortUp 8787) -and (WorkerHealthy)) { Log 'YTDLP worker: up + healthy'; return }; Start-Sleep 2 }
    Log 'YTDLP worker: FAILED to become healthy'
}

function EnsureVideoWorker {
    if (PortUp 8099) { return }
    Log 'video worker: not listening -> starting'
    $env:WORKER_PORT = '8099'; $env:WORKER_TOKEN = 'rexi-video-2026'
    Start-Process -FilePath $nodeexe -ArgumentList ('"' + (Join-Path $base 'Backend\video-worker.js') + '"') -WorkingDirectory (Join-Path $base 'Backend') -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $tundir 'video.out.log') -RedirectStandardError (Join-Path $tundir 'video.err.log')
    for ($i=0; $i -lt 25; $i++) { if (PortUp 8099) { Log 'video worker: up'; return }; Start-Sleep 2 }
    Log 'video worker: FAILED to start'
}

function LogUrl($logfile) {
    if (-not (Test-Path $logfile)) { return $null }
    $m = Select-String -Path $logfile -Pattern 'https://[a-z0-9\-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -Last 1
    if ($m) { return $m.Matches.Value.TrimEnd('/') } else { return $null }
}

function HealthOk($url) {
    if (-not $url) { return $false }
    try { $r = Invoke-WebRequest -Uri ($url + '/health') -TimeoutSec 8 -UseBasicParsing; return ($r.StatusCode -eq 200) } catch { return $false }
}

# Ensure a quick tunnel for $port exists and is healthy. Returns its https URL (or $null).
function EnsureTunnel($name, $port, $adoptUrl) {
    $logfile = Join-Path $tundir ($name + '.tunnel.log')
    $procs = @(Get-CimInstance Win32_Process -Filter "name='cloudflared.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match ('127\.0\.0\.1:' + $port) })
    # 1) adopt existing healthy tunnel (ours-by-log or given adoptUrl)
    $url = LogUrl $logfile
    if ($procs.Count -ge 1) {
        if (HealthOk $url) { Log ("${name}: adopt(log) " + $url); return $url }
        if (HealthOk $adoptUrl) { Log ("${name}: adopt(render) " + $adoptUrl); return $adoptUrl }
    }
    # 2) (re)start cleanly
    foreach ($p in $procs) { Log ("${name}: killing cloudflared pid " + $p.ProcessId); Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
    if (Test-Path $logfile) { Remove-Item $logfile -Force -ErrorAction SilentlyContinue }
    Log ("${name}: starting cloudflared -> 127.0.0.1:" + $port)
    Start-Process -FilePath $cfexe -ArgumentList @('tunnel','--url',('http://127.0.0.1:' + $port),'--no-autoupdate','--edge-ip-version','4','--protocol','http2','--logfile',$logfile) -WindowStyle Hidden
    for ($i=0; $i -lt 30; $i++) { $url = LogUrl $logfile; if ($url -and (HealthOk $url)) { Log ("${name}: up -> " + $url); return $url }; Start-Sleep 2 }
    Log ("${name}: tunnel not healthy")
    if (HealthOk $url) { return $url }
    return $null
}

# ---- run ----
Log '=== tunnel-manager run ==='
# read current render env first (for adopt)
$rkey = (Get-Content $rkeyfile -Raw).Trim()
$hdr  = @{ Authorization = 'Bearer ' + $rkey }
$envMap = @{}
try { $cur = Invoke-RestMethod -Uri "$rbase/services/$rsvc/env-vars?limit=100" -Headers $hdr -TimeoutSec 30; foreach ($e in $cur) { $envMap[$e.envVar.key] = $e.envVar.value } } catch { Log ('read env ERROR: ' + $_.Exception.Message) }

EnsureVieNeu | Out-Null
EnsureWorker | Out-Null
EnsureVideoWorker | Out-Null
$vieUrl = EnsureTunnel 'vieneu' 8000 $envMap['VIENEU_BASE_URL']
$ytUrl  = EnsureTunnel 'ytdlp' 8787 $envMap['YTDLP_WORKER_URL']
$vidUrl = EnsureTunnel 'video' 8099 $envMap['VIDEO_WORKER_URL']
Log ('resolved: vieneu=' + $vieUrl + '  ytdlp=' + $ytUrl + '  video=' + $vidUrl)

# ---- sync Render env ----
try {
    $changed = $false
    foreach ($pair in @(@{k='VIENEU_BASE_URL'; v=$vieUrl}, @{k='YTDLP_WORKER_URL'; v=$ytUrl}, @{k='VIDEO_WORKER_URL'; v=$vidUrl}, @{k='VIDEO_WORKER_TOKEN'; v='rexi-video-2026'})) {
        if ($pair.v -and $envMap[$pair.k] -ne $pair.v) {
            $body = @{ value = $pair.v } | ConvertTo-Json -Compress
            Invoke-RestMethod -Method Put -Uri "$rbase/services/$rsvc/env-vars/$($pair.k)" -Headers $hdr -ContentType 'application/json' -Body $body -TimeoutSec 30 | Out-Null
            Log ('Render env set ' + $pair.k + ' = ' + $pair.v)
            $changed = $true
        }
    }
    if ($changed) { $d = Invoke-RestMethod -Method Post -Uri "$rbase/services/$rsvc/deploys" -Headers $hdr -TimeoutSec 30; Log ('Render deploy triggered: ' + $d.id) }
    else { Log 'Render env unchanged' }
} catch { Log ('Render sync ERROR: ' + $_.Exception.Message) }

Log '=== done ==='
$mutex.ReleaseMutex()
