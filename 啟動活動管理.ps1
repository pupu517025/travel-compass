$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath($PSScriptRoot)
$eventsPath = Join-Path $root 'data\tourism-events.json'
$previewPath = Join-Path $root 'data\tourism-events-preview.js'
$adminDataPath = Join-Path $root 'data\admin-events.js'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$mime = @{
    '.html' = 'text/html; charset=utf-8'
    '.js' = 'text/javascript; charset=utf-8'
    '.json' = 'application/json; charset=utf-8'
    '.css' = 'text/css; charset=utf-8'
    '.svg' = 'image/svg+xml'
}

function Send-Response($Stream, [int]$Status, [string]$Type, [byte[]]$Body) {
    $reason = switch ($Status) { 200 { 'OK' } 400 { 'Bad Request' } 404 { 'Not Found' } 413 { 'Payload Too Large' } default { 'Internal Server Error' } }
    $header = "HTTP/1.1 $Status $reason`r`nContent-Type: $Type`r`nContent-Length: $($Body.Length)`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
    $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
    $Stream.Write($headerBytes, 0, $headerBytes.Length)
    if ($Body.Length -gt 0) { $Stream.Write($Body, 0, $Body.Length) }
    $Stream.Flush()
}

function Send-Json($Stream, [int]$Status, $Value) {
    $json = ConvertTo-Json -InputObject $Value -Depth 100 -Compress
    Send-Response $Stream $Status 'application/json; charset=utf-8' $utf8.GetBytes($json)
}

function Write-TextFile([string]$Path, [string]$Text) {
    $temporary = "$Path.tmp"
    [System.IO.File]::WriteAllText($temporary, $Text, $utf8)
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}

$listener = $null
$port = 8000
for ($candidatePort = 8000; $candidatePort -le 8010; $candidatePort++) {
    try {
        $candidate = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $candidatePort)
        $candidate.Start()
        $listener = $candidate
        $port = $candidatePort
        break
    } catch { if ($candidate) { $candidate.Stop() }; $listener = $null }
}

if (-not $listener) { throw 'No free local port between 8000 and 8010.' }
Write-Host "Travel Compass is running at http://127.0.0.1:$port/"
Write-Host "Open http://127.0.0.1:$port/admin.html to review activities. Press Ctrl+C to stop."

try {
    while ($listener) {
        $client = $listener.AcceptTcpClient()
        $stream = $client.GetStream()
        try {
            $headerBuffer = New-Object 'System.Collections.Generic.List[byte]'
            $matched = 0
            while ($matched -lt 4) {
                $nextByte = $stream.ReadByte()
                if ($nextByte -lt 0) { throw 'Incomplete request headers.' }
                $headerBuffer.Add([byte]$nextByte)
                $matched = switch ($matched) {
                    0 { if ($nextByte -eq 13) { 1 } else { 0 } }
                    1 { if ($nextByte -eq 10) { 2 } elseif ($nextByte -eq 13) { 1 } else { 0 } }
                    2 { if ($nextByte -eq 13) { 3 } else { 0 } }
                    3 { if ($nextByte -eq 10) { 4 } else { 0 } }
                }
                if ($headerBuffer.Count -gt 32768) { throw 'Request headers are too large.' }
            }

            $headerText = [System.Text.Encoding]::ASCII.GetString($headerBuffer.ToArray())
            $lines = $headerText -split "`r`n"
            $requestLine = $lines[0] -split ' ', 3
            if ($requestLine.Count -lt 2) { throw 'Invalid request line.' }
            $method = $requestLine[0].ToUpperInvariant()
            $uri = [System.Uri]::new("http://127.0.0.1:$port$($requestLine[1])")
            $pathname = [System.Uri]::UnescapeDataString($uri.AbsolutePath)
            $headers = @{}
            foreach ($line in $lines | Select-Object -Skip 1) {
                $colon = $line.IndexOf(':')
                if ($colon -gt 0) { $headers[$line.Substring(0, $colon).Trim().ToLowerInvariant()] = $line.Substring($colon + 1).Trim() }
            }

            if ($pathname -eq '/api/events' -and $method -eq 'GET') {
                $bytes = [System.IO.File]::ReadAllBytes($eventsPath)
                Send-Response $stream 200 'application/json; charset=utf-8' $bytes
            } elseif ($pathname -eq '/api/events/status' -and $method -eq 'POST') {
                $contentLength = 0
                if ($headers.ContainsKey('content-length')) { $contentLength = [int]$headers['content-length'] }
                if ($contentLength -gt 16384) { Send-Json $stream 413 @{ error = 'Request too large' } }
                else {
                    $bodyBytes = New-Object byte[] $contentLength
                    $read = 0
                    while ($read -lt $contentLength) {
                        $read += $stream.Read($bodyBytes, $read, $contentLength - $read)
                    }
                    $update = [System.Text.Encoding]::UTF8.GetString($bodyBytes) | ConvertFrom-Json
                    if (-not $update.id -or $update.status -notin @('Approved', 'Pending', 'Rejected')) { Send-Json $stream 400 @{ error = 'Invalid activity status update' } }
                    else {
                        $data = [System.IO.File]::ReadAllText($eventsPath, $utf8) | ConvertFrom-Json
                        $event = $data.events | Where-Object { $_.id -eq $update.id } | Select-Object -First 1
                        if (-not $event) { Send-Json $stream 404 @{ error = 'Activity not found' } }
                        else {
                            $event.status = $update.status
                            $event | Add-Member -NotePropertyName moderated_at -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) -Force
                            $data | Add-Member -NotePropertyName updated_at -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) -Force
                            $allEvents = @($data.events)
                            $data.count = $allEvents.Count
                            Write-TextFile $eventsPath (ConvertTo-Json -InputObject $data -Depth 100)
                            $approved = @($allEvents | Where-Object { $_.status -eq 'Approved' })
                            Write-TextFile $previewPath ('window.LOCAL_APPROVED_EVENTS = ' + (ConvertTo-Json -InputObject $approved -Depth 100 -Compress) + ';' + "`n")
                            Write-TextFile $adminDataPath ('window.ADMIN_EVENTS = ' + (ConvertTo-Json -InputObject $allEvents -Depth 100 -Compress) + ';' + "`n")
                            $pendingCount = @($allEvents | Where-Object { $_.status -eq 'Pending' }).Count
                            Send-Json $stream 200 @{ ok = $true; event = $event; approved_count = $approved.Count; pending_count = $pendingCount }
                        }
                    }
                }
            } elseif ($method -eq 'GET') {
                $relative = $pathname.TrimStart('/').Replace('/', [System.IO.Path]::DirectorySeparatorChar)
                if (-not $relative) { $relative = 'index.html' }
                $target = [System.IO.Path]::GetFullPath((Join-Path $root $relative))
                $rootPrefix = $root.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
                if (-not $target.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $target -PathType Leaf)) {
                    Send-Response $stream 404 'text/plain; charset=utf-8' $utf8.GetBytes('Not found')
                } else {
                    $extension = [System.IO.Path]::GetExtension($target).ToLowerInvariant()
                    $type = if ($mime.ContainsKey($extension)) { $mime[$extension] } else { 'application/octet-stream' }
                    Send-Response $stream 200 $type ([System.IO.File]::ReadAllBytes($target))
                }
            } else { Send-Response $stream 404 'text/plain; charset=utf-8' $utf8.GetBytes('Not found') }
        } catch {
            try { Send-Json $stream 400 @{ error = $_.Exception.Message } } catch {}
        } finally {
            $stream.Dispose()
            $client.Close()
        }
    }
} finally { $listener.Stop() }
