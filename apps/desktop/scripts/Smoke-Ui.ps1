param([string]$Executable = "$PSScriptRoot\..\..\..\artifacts\win-x64\PopuConnect.exe")
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class PopuWindowCapture {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  private delegate bool VisitWindow(IntPtr hwnd, IntPtr arg);
  [DllImport("user32.dll")] private static extern bool EnumWindows(VisitWindow visit, IntPtr arg);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr hwnd, System.Text.StringBuilder text, int length);
  public static IntPtr FindProcessWindow(int processId, string title) {
    IntPtr result = IntPtr.Zero;
    EnumWindows(delegate(IntPtr hwnd, IntPtr arg) {
      uint pid;
      GetWindowThreadProcessId(hwnd, out pid);
      if (pid != processId) return true;
      var text = new System.Text.StringBuilder(128);
      GetWindowText(hwnd, text, text.Capacity);
      if (text.ToString() != title) return true;
      result = hwnd;
      return false;
    }, IntPtr.Zero);
    return result;
  }
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr dialog, int id);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageW(IntPtr hwnd, uint message, IntPtr wparam, string text);
}
'@
$appPath = (Resolve-Path -LiteralPath $Executable).Path
$output = Join-Path $PSScriptRoot '..\..\..\artifacts\qa'
New-Item -ItemType Directory -Force -Path $output | Out-Null
# The application under test needs a normal interactive window for UI Automation.
$app = Start-Process -FilePath $appPath -WindowStyle Normal -PassThru
try {
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 200
        $app.Refresh()
        $windowHandle = [PopuWindowCapture]::FindProcessWindow($app.Id, 'PopuConnect')
    } while ($windowHandle -eq 0 -and !$app.HasExited -and [DateTime]::UtcNow -lt $deadline)
    if ($app.HasExited -or $windowHandle -eq 0) { throw "Application did not open a window. Exited=$($app.HasExited) ExitCode=$($app.ExitCode)" }
    Start-Sleep -Seconds 2
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($windowHandle)
    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $names = @($all | ForEach-Object { $_.Current.Name })
    if ($names -contains 'Optional: Windows MIDI Services Tools') {
        if (!($names -like 'Windows MIDI · *')) { throw 'Native MIDI discovery did not complete without midi.exe.' }
    } elseif ($names -notcontains 'Prefer USB automatically') { throw 'Missing connection selector.' }
    foreach ($required in @('Connection', 'Lighting', 'Turn off lights', 'Battery', 'Check battery', 'Collect device diagnostics', 'Export diagnostics', 'Apply to all keys', 'Diagnostics and manual IDs')) {
        if ($names -notcontains $required) { throw "Missing UI control: $required" }
    }
    $all | ForEach-Object { '{0} | enabled={1} | {2}' -f $_.Current.Name, $_.Current.IsEnabled, $_.Current.BoundingRectangle } | Set-Content -Encoding UTF8 (Join-Path $output 'ui-elements.txt')
    $offButtons = @($all | Where-Object { $_.Current.Name -eq 'Turn off lights' })
    if ($offButtons.Count -ne 1 -or $offButtons[0].Current.IsEnabled) { throw 'Expected one lighting off button, disabled without a verified endpoint.' }
    foreach ($obsolete in @('Extension type', 'Turn off main module lights', 'Turn off extension lights', 'Turn off all lights')) {
        if ($names -contains $obsolete) { throw "Obsolete lighting control: $obsolete" }
    }
    function Save-WindowImage([string]$Name) {
        $bounds = $root.Current.BoundingRectangle
        $bitmap = New-Object System.Drawing.Bitmap ([int]$bounds.Width), ([int]$bounds.Height)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $hdc = $graphics.GetHdc()
        try { [PopuWindowCapture]::PrintWindow($windowHandle, $hdc, 2) | Out-Null }
        finally { $graphics.ReleaseHdc($hdc); $graphics.Dispose() }
        try { $bitmap.Save((Join-Path $output $Name), [System.Drawing.Imaging.ImageFormat]::Png) }
        finally { $bitmap.Dispose() }
    }
    Save-WindowImage 'window.png'
    function Find-ByName($element, [string]$name) {
        $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $name)
        $element.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
    }
    $collect = Find-ByName $root 'Collect device diagnostics'
    $collect.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    do {
        Start-Sleep -Milliseconds 200
        $ready = Find-ByName $root 'Report ready. You can save it as a text file.'
    } while (!$ready -and [DateTime]::UtcNow -lt $deadline)
    if (!$ready) { throw 'Read-only device diagnostics did not finish.' }
    $capture = Find-ByName $root 'Record USB SysEx'
    $capture.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
        Start-Sleep -Milliseconds 100
        $needsDevice = Find-ByName $root 'Select PopuPiano [USB] from the device list first.'
    } while (!$needsDevice -and [DateTime]::UtcNow -lt $deadline)
    if (!$needsDevice -or (Find-ByName $root 'Stop recording')) { throw 'USB SysEx capture armed without a selected USB device.' }
    $edits = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)))
    $snapshot = $edits | ForEach-Object { $_.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } | Where-Object { $_ -like '*Windows UMP endpoints*' } | Select-Object -First 1
    if (!$snapshot -or $snapshot -notlike '*USB: PnP / Power / HID*' -or $snapshot -notlike '*BLE GATT*') { throw 'The diagnostic preview is incomplete.' }
    Save-WindowImage 'diagnostics.png'
    $exportButton = Find-ByName $root 'Export diagnostics'
    $exportHandle = [IntPtr]$exportButton.Current.NativeWindowHandle
    [PopuWindowCapture]::PostMessage($exportHandle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        Start-Sleep -Milliseconds 200
        $saveHandle = [PopuWindowCapture]::FindProcessWindow($app.Id, 'Export diagnostics')
    } while ($saveHandle -eq 0 -and [DateTime]::UtcNow -lt $deadline)
    if ($saveHandle -eq 0) { throw 'Export did not open the file dialog.' }
    $saveDialog = [System.Windows.Automation.AutomationElement]::FromHandle($saveHandle)
    function Find-ById($element, [string]$id) {
        $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $id)
        $element.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        Start-Sleep -Milliseconds 150
        $hostField = Find-ById $saveDialog 'FileNameControlHost'
        if ($hostField) { $fileName = Find-ById $hostField '1001' }
    } while (!$fileName -and [DateTime]::UtcNow -lt $deadline)
    if (!$fileName) { throw 'Filename field was not found in the Save dialog.' }
    $tempFile = Join-Path $output ('smoke-' + [guid]::NewGuid().ToString('N') + '.txt')
    try {
        [PopuWindowCapture]::SendMessageW([IntPtr]$fileName.Current.NativeWindowHandle, 0x000C, [IntPtr]::Zero, [IO.Path]::GetFullPath($tempFile)) | Out-Null
        $saveButton = [PopuWindowCapture]::GetDlgItem($saveHandle, 1)
        if ($saveButton -eq 0) { throw 'Save button not found.' }
        [PopuWindowCapture]::PostMessage($saveButton, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
        $deadline = [DateTime]::UtcNow.AddSeconds(10)
        do {
            Start-Sleep -Milliseconds 200
            $saved = Find-ByName $root 'Diagnostic report saved.'
        } while (!$saved -and [DateTime]::UtcNow -lt $deadline)
        if (!$saved) { throw "Save dialog did not complete; file exists: $(Test-Path -LiteralPath $tempFile)" }
        $written = [IO.File]::ReadAllText($tempFile).Replace("`r`n", "`n").TrimEnd()
        if ($written -ne $snapshot.Replace("`r`n", "`n").TrimEnd()) { throw "Export differs from preview. File characters=$($written.Length) preview=$($snapshot.TrimEnd().Length)" }
        Copy-Item -LiteralPath $tempFile -Destination (Join-Path $output 'no-device-report.txt') -Force
    } finally { if (Test-Path -LiteralPath $tempFile) { Remove-Item -LiteralPath $tempFile } }
    Write-Output "UI smoke passed. Screenshots: $output"
}
finally {
    if (!$app.HasExited) {
        $dialogHandle = [PopuWindowCapture]::FindProcessWindow($app.Id, 'Export diagnostics')
        if ($dialogHandle -ne 0) { [PopuWindowCapture]::PostMessage($dialogHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null; Start-Sleep -Milliseconds 300 }
        if ($windowHandle -ne 0) { [PopuWindowCapture]::PostMessage($windowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null }
        if (!$app.WaitForExit(5000)) { Stop-Process -Id $app.Id; throw 'Application did not close normally.' }
    }
}
