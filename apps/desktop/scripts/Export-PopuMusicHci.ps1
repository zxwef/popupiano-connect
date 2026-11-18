[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$BugReport,
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$reportPath = (Resolve-Path -LiteralPath $BugReport).Path
if (!$OutputDirectory) {
    $OutputDirectory = Join-Path (Split-Path -LiteralPath $reportPath) ('PopuMusic-HCI-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
$destination = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputDirectory)

$archive = [IO.Compression.ZipFile]::OpenRead($reportPath)
try {
    $logs = @($archive.Entries | Where-Object { $_.Name -match '^btsnoop_hci\.log(\.last|\.\d+)?$' })
    if ($logs.Count -eq 0) {
        throw 'The ZIP contains no full btsnoop_hci.log or rotated HCI log. Confirm full Bluetooth HCI snoop mode and restart Bluetooth before recording.'
    }

    $number = 0
    foreach ($entry in $logs) {
        $source = $entry.Open()
        try {
            $reader = [IO.BinaryReader]::new($source)
            $header = $reader.ReadBytes(16)
            $magic = if ($header.Length -eq 16) { [Text.Encoding]::ASCII.GetString($header, 0, 8) }
            if ($magic -ne "btsnoop`0") {
                Write-Warning 'Ignored a named HCI log with a missing or invalid BTSnoop header.'
                continue
            }

            $number++
            [IO.Directory]::CreateDirectory($destination) | Out-Null
            $path = Join-Path $destination ('btsnoop_hci-{0:00}.log' -f $number)
            $file = [IO.File]::Open($path, [IO.FileMode]::CreateNew)
            try {
                $file.Write($header, 0, $header.Length)
                $source.CopyTo($file)
            }
            finally { $file.Dispose() }

            Get-Item -LiteralPath $path
        }
        finally { $source.Dispose() }
    }
    if ($number -eq 0) { throw 'None of the HCI logs in the ZIP had a valid BTSnoop header.' }
}
finally { $archive.Dispose() }
