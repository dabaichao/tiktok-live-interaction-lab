[CmdletBinding()]
param(
    [ValidateRange(1,65535)][int]$Port = 3002,
    [ValidateRange(1,65535)][int]$WebsocketPort = 8767,
    [switch]$EnableGiftModel,
    [switch]$AllowInsecureHttp
)

$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$taskNode = (Get-Command node -ErrorAction Stop).Source
$taskEntry = Join-Path $taskRoot 'dist/douyin-server.js'
if (-not (Test-Path -LiteralPath $taskEntry)) { throw '请先在项目目录完成 npm run build。' }
if ($Port -eq $WebsocketPort) { throw '后台与游戏传输端口不能相同。' }
foreach ($taskPort in @($Port,$WebsocketPort)) {
    if (Get-NetTCPConnection -LocalPort $taskPort -State Listen -ErrorAction SilentlyContinue) {
        throw "端口 $taskPort 已有服务。不会自动结束现有进程，请先确认是否需要重启。"
    }
}

$taskEnv = @{ HOST='127.0.0.1'; DOUYIN_PORT="$Port"; DOUYIN_WS_PORT="$WebsocketPort" }
if ($EnableGiftModel) {
    # Reuse the user-approved, Git-ignored credential. Never copy the key to source or logs.
    $taskPrivatePath = Join-Path $taskRoot 'data/dictionary-proposals/.wordlib-local.json'
    if (-not (Test-Path -LiteralPath $taskPrivatePath)) { throw '本机私有模型配置不存在。' }
    try { $taskModel = Get-Content -LiteralPath $taskPrivatePath -Raw | ConvertFrom-Json }
    catch { throw '本机私有模型配置不是有效 JSON。' }
    foreach ($taskField in @('apiBase','model','apiKey')) {
        if ([string]::IsNullOrWhiteSpace($taskModel.$taskField)) { throw '本机私有模型配置缺少地址、模型或密钥。' }
    }
    $taskUri = [uri]$taskModel.apiBase
    if ($taskUri.Scheme -notin @('http','https') -or $taskUri.UserInfo -or $taskUri.Query -or $taskUri.Fragment) {
        throw '模型地址必须是无凭据、无查询参数的 HTTP/HTTPS 基础地址。'
    }
    if ($taskUri.Scheme -eq 'http' -and -not $taskUri.IsLoopback -and -not $AllowInsecureHttp) {
        throw '公网 HTTP 会明文传输密钥。确认风险后才可添加 -AllowInsecureHttp。'
    }
    $taskBase = $taskModel.apiBase.TrimEnd('/')
    if (-not $taskBase.EndsWith('/v1')) { $taskBase += '/v1' }
    $taskEnv.HINT_LLM_API_KEY = $taskModel.apiKey.Trim()
    $taskEnv.HINT_LLM_BASE_URL = $taskBase
    $taskEnv.HINT_LLM_MODEL = $taskModel.model.Trim()
}

$taskPrevious = @{}
$taskLogDir = Join-Path $taskRoot '.runtime'
New-Item -ItemType Directory -Path $taskLogDir -Force | Out-Null
$taskStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
try {
    foreach ($taskName in $taskEnv.Keys) {
        $taskPrevious[$taskName] = [Environment]::GetEnvironmentVariable($taskName,'Process')
        [Environment]::SetEnvironmentVariable($taskName,$taskEnv[$taskName],'Process')
    }
    $taskProcess = Start-Process -FilePath $taskNode -ArgumentList @(('"' + $taskEntry + '"')) -WorkingDirectory $taskRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $taskLogDir "douyin-$taskStamp.out.log") `
        -RedirectStandardError (Join-Path $taskLogDir "douyin-$taskStamp.err.log")
    # Persisted endpoint/routing choices remain authoritative in the operator's game settings.
    [pscustomobject]@{ ProcessId=$taskProcess.Id; Address="http://127.0.0.1:$Port/douyin-split/"; GiftModelEnabled=[bool]$EnableGiftModel }
}
finally {
    foreach ($taskName in $taskPrevious.Keys) {
        [Environment]::SetEnvironmentVariable($taskName,$taskPrevious[$taskName],'Process')
    }
    $taskModel = $null
    $taskEnv.Clear()
}
