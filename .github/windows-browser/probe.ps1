# Windows 브라우저 칸 시험 (windows-browser.yml). 앱을 실행해 시험 페이지를 브라우저 칸에 열고, 화면 사진과 진짜 마우스 · 키보드
# 입력으로 확인한다:
#   1. 칸이 메인 웹뷰 밑에 깔려도 보이는가 (사진에서 자홍색 페이지를 찾는다)
#   2. 칸을 누르면 페이지가 누름을 받는가 (페이지가 초록으로 바뀌고 서버 기록에 down:0 · click)
#   3. 누른 뒤 키보드 · 휠이 페이지로 가는가 (key:a · wheel:1)
#   4. 페이지가 키보드를 잡고 있을 때 Ctrl+Alt+A 가 앱 단축키로 가서 플로팅 패널이 칸 위에 그려지는가 (사진)
# 사진 · 기록은 $Out 에 남기고 workflow 가 올린다. 확인이 하나라도 틀리면 마지막에 실패로 끝난다.
param(
  [string]$Out = "$env:RUNNER_TEMP\windows-browser",
  [string]$Bin = "target\debug"
)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$env:THUMINAL_HOME = Join-Path $Out "home"
$log = Join-Path $Out "events.log"
New-Item -ItemType File -Force -Path $log | Out-Null
$failed = @()

Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class Probe {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(100);
    mouse_event(0x2, 0, 0, 0, UIntPtr.Zero);
    mouse_event(0x4, 0, 0, 0, UIntPtr.Zero);
  }
  public static void Wheel(int x, int y, int delta) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(100);
    mouse_event(0x800, 0, 0, delta, UIntPtr.Zero);
  }
  // 색이 거의 같은 픽셀들의 테두리 상자 [왼, 위, 오른, 아래, 개수]. 없으면 개수 0
  public static int[] Box(Bitmap b, int r, int g, int bl) {
    var d = b.LockBits(new Rectangle(0, 0, b.Width, b.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    var px = new byte[d.Stride * b.Height];
    Marshal.Copy(d.Scan0, px, 0, px.Length);
    b.UnlockBits(d);
    int l = int.MaxValue, t = int.MaxValue, rr = -1, bb = -1, n = 0;
    for (int y = 0; y < b.Height; y++) for (int x = 0; x < b.Width; x++) {
      int i = y * d.Stride + x * 4;
      if (Math.Abs(px[i + 2] - r) < 24 && Math.Abs(px[i + 1] - g) < 24 && Math.Abs(px[i] - bl) < 24) {
        n++; if (x < l) l = x; if (y < t) t = y; if (x > rr) rr = x; if (y > bb) bb = y;
      }
    }
    return new int[] { l, t, rr, bb, n };
  }
}
"@
[Probe]::SetProcessDPIAware() | Out-Null

function Shot([string]$name) {
  $s = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap $s.Width, $s.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($s.Location, [System.Drawing.Point]::Empty, $s.Size)
  $g.Dispose()
  $bmp.Save((Join-Path $Out "$name.png"))
  Write-Host "사진: $name ($($s.Width)x$($s.Height))"
  return $bmp
}

function Events { Get-Content $log -ErrorAction SilentlyContinue }

function Check([string]$what, [bool]$ok) {
  if ($ok) { Write-Host "통과: $what" } else { Write-Host "실패: $what"; $script:failed += $what }
}

function WaitFor([string]$e, [int]$sec = 10) {
  for ($i = 0; $i -lt $sec * 4; $i++) {
    if ((Events) -contains $e) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

$server = Start-Process python -ArgumentList "$PSScriptRoot\probe_server.py", "8765", $log -PassThru -WindowStyle Hidden
$app = Start-Process (Join-Path $Bin "thuminal-desktop.exe") -PassThru -RedirectStandardError (Join-Path $Out "app.err.log") -RedirectStandardOutput (Join-Path $Out "app.out.log")
try {
  for ($i = 0; $i -lt 60 -and $app.MainWindowHandle -eq 0; $i++) { Start-Sleep 1; $app.Refresh() }
  [Probe]::ShowWindow($app.MainWindowHandle, 3) | Out-Null
  [Probe]::SetForegroundWindow($app.MainWindowHandle) | Out-Null
  Start-Sleep 10
  (Shot "1-start").Dispose()

  & (Join-Path $Bin "thuminal.exe") browser open "http://127.0.0.1:8765/probe.html" 2>&1 | Write-Host
  Check "페이지가 열린다" (WaitFor "load" 30)
  Start-Sleep 4
  $bmp = Shot "2-browser"
  $box = [Probe]::Box($bmp, 255, 0, 255)
  $bmp.Dispose()
  Write-Host "자홍색 자리: $($box -join ',')"
  Check "칸이 메인 웹뷰 밑에서 보인다" ($box[4] -gt 20000)
  if ($box[4] -gt 0) {
    $cx = [int](($box[0] + $box[2]) / 2)
    $cy = [int](($box[1] + $box[3]) / 2)
  } else {
    $s = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $cx = [int]($s.Width * 0.65); $cy = [int]($s.Height * 0.6)
  }

  [Probe]::Click($cx, $cy)
  Check "누름이 페이지로 간다" ((WaitFor "down:0") -and (WaitFor "click"))
  Start-Sleep 1
  $bmp = Shot "3-clicked"
  $green = [Probe]::Box($bmp, 0, 255, 0)
  $bmp.Dispose()
  Check "누른 뒤 페이지가 다시 그려진다 (초록)" ($green[4] -gt 20000)

  [System.Windows.Forms.SendKeys]::SendWait("abc")
  Check "키보드가 페이지로 간다" ((WaitFor "key:a") -and (WaitFor "key:c"))
  [Probe]::Wheel($cx, $cy, -120)
  Check "휠이 페이지로 간다" (WaitFor "wheel:1")
  (Shot "4-typed").Dispose()

  # 페이지가 키보드를 잡은 채 앱 단축키 (Ctrl+Alt+A 플로팅 패널)
  [System.Windows.Forms.SendKeys]::SendWait("^%a")
  Start-Sleep 3
  $bmp = Shot "5-floating"
  $after = [Probe]::Box($bmp, 0, 255, 0)
  $bmp.Dispose()
  Write-Host "플로팅 패널을 연 뒤 초록 픽셀: $($after[4]) (앞 $($green[4]))"
  Check "플로팅 패널이 칸 위에 그려진다" ($after[4] -gt 0 -and $after[4] -lt $green[4] * 0.9)
} finally {
  Write-Host "--- 페이지 기록"
  Events | Write-Host
  Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
  Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
  Get-Process thuminald -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}

if ($failed.Count -gt 0) {
  Write-Host "실패한 확인: $($failed -join ', ')"
  exit 1
}
Write-Host "모두 통과"
