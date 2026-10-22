#Requires -Version 5
<#
  NovaCode — branded NSIS installer asset generator.

  Uses .NET System.Drawing (built into Windows, no external deps) to render the
  artwork electron-builder picks up for the assisted (setup wizard) installer:

    build\installerSidebar.bmp   164x314, 24bpp  -> MUI welcome/finish sidebar
    build\installerHeader.bmp    150x57,  24bpp  -> MUI page header banner
    build\installerIcon.ico      PNG-in-ICO 16..256 -> installer window icon
    build\uninstallerIcon.ico    same, for the uninstaller

  These filenames match electron-builder's getResource() defaults, so they are
  auto-detected from the build/ directory (they are also wired explicitly in
  package.json for clarity).

  Re-run after changing brand colors or the app icon:
    powershell -ExecutionPolicy Bypass -File scripts\make-installer-assets.ps1
#>
[CmdletBinding()]
param(
  [string]$Icon    = '',
  [string]$OutDir  = '',
  [string]$Version = '0.2.0'
)

if (-not $Icon)   { $Icon   = Join-Path $PSScriptRoot '..\build\icon.png' }
if (-not $OutDir) { $OutDir = Join-Path $PSScriptRoot '..\build' }

Add-Type -AssemblyName System.Drawing

# --- Brand palette (mirrors src/styles/variables.css) -----------------------
function C([string]$hex) { [System.Drawing.ColorTranslator]::FromHtml($hex) }
$BG_TOP    = C '#131c33'   # slightly lifted panel so art reads on white taskbars
$BG_BOT    = C '#070b14'   # app canvas
$ACCENT    = C '#7c5cff'   # --accent (violet)
$ACCENT_2  = C '#22d3ee'   # --accent-2 (cyan)
$ACCENT_3  = C '#3b82f6'   # --accent-3 (blue)
$TEXT      = C '#e6ebf4'   # --text
$MUTED     = C '#94a1b8'   # --muted

$ErrorActionPreference = 'Stop'
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }
$IconPath = (Resolve-Path $Icon).Path
# NOTE: use a distinct name; PowerShell vars are case-insensitive, so reusing
# $Icon (a [string] param) would coerce the loaded Image back to a string.
$logoImg = [System.Drawing.Image]::FromFile($IconPath)

# --- Helpers ----------------------------------------------------------------
function New-Canvas([int]$w, [int]$h) {
  $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  return @{ Bmp = $bmp; G = $g }
}

function Fill-VerticalGradient($g, [int]$w, [int]$h, $top, $bot) {
  $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $top, $bot, [System.Drawing.Drawing2D.LinearGradientMode]::Vertical)
  $g.FillRectangle($brush, $rect); $brush.Dispose()
}

# Soft radial accent glow, composited onto the (opaque) background.
function Add-Glow($g, [int]$cx, [int]$cy, [int]$r, $color, [byte]$peakAlpha) {
  $rect = New-Object System.Drawing.Rectangle(($cx - $r), ($cy - $r), ($r * 2), ($r * 2))
  if ($rect.Width -le 0 -or $rect.Height -le 0) { return }
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddEllipse($rect)
  $pgb = New-Object System.Drawing.Drawing2D.PathGradientBrush($path)
  $pgb.CenterColor = [System.Drawing.Color]::FromArgb($peakAlpha, $color.R, $color.G, $color.B)
  $pgb.SurroundColors = @([System.Drawing.Color]::FromArgb(0, $color.R, $color.G, $color.B))
  $blend = New-Object System.Drawing.Drawing2D.ColorBlend
  $blend.Colors  = @([System.Drawing.Color]::FromArgb($peakAlpha, $color.R, $color.G, $color.B),
                     [System.Drawing.Color]::FromArgb(0, $color.R, $color.G, $color.B))
  $blend.Positions = @(0.0, 1.0)
  $pgb.InterpolationColors = $blend
  $g.FillEllipse($pgb, $rect); $pgb.Dispose(); $path.Dispose()
}

function Draw-AccentBar($g, [int]$x, [int]$y, [int]$w, [int]$h) {
  $rect = New-Object System.Drawing.Rectangle($x, $y, $w, $h)
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $ACCENT, $ACCENT_2, [System.Drawing.Drawing2D.LinearGradientMode]::Vertical)
  $g.FillRectangle($brush, $rect); $brush.Dispose()
}

# Centered string; returns baseline Y after drawing.
function Draw-Text($g, [string]$text, [string]$family, [single]$size, [bool]$bold, $color, [int]$cx, [single]$y) {
  $style = if ($bold) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }
  $font = New-Object System.Drawing.Font($family, $size, $style)
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = [System.Drawing.StringAlignment]::Center
  $fmt.LineAlignment = [System.Drawing.StringAlignment]::Near
  $brush = New-Object System.Drawing.SolidBrush($color)
  $pt = New-Object System.Drawing.PointF($cx, $y)
  $g.DrawString($text, $font, $brush, $pt, $fmt)
  $h = $font.GetHeight($g)
  $font.Dispose(); $brush.Dispose(); $fmt.Dispose()
  return ($y + $h)
}

function Draw-Logo($g, $icon, [int]$cx, [int]$cy, [int]$size) {
  # Rounded glow "chip" behind the mark for depth.
  Add-Glow $g $cx ($cy + 2) ([int]($size * 0.95)) $ACCENT 90
  $half = [int]($size / 2)
  $g.DrawImage($icon, ($cx - $half), ($cy - $half), $size, $size)
}

# --- Sidebar 164 x 314 ------------------------------------------------------
$SW = 164; $SH = 314
$canvas = New-Canvas $SW $SH
$g = $canvas.G
Fill-VerticalGradient $g $SW $SH $BG_TOP $BG_BOT
Add-Glow $g ([int]($SW*0.5)) 66 120 $ACCENT   70
Add-Glow $g ([int]($SW*0.85)) 250 120 $ACCENT_2 40
Draw-AccentBar $g ($SW - 3) 0 3 $SH
$cx = [int]($SW/2)
Draw-Logo $g $logoImg $cx 92 88
$y = 150
$y = Draw-Text $g 'NovaCode' 'Segoe UI' 17 $true $TEXT $cx $y
Draw-AccentBar $g ([int]($cx-16)) ($y+2) 32 2
$y = Draw-Text $g 'AI-Powered' 'Segoe UI' 8.5 $false $MUTED $cx ($y+12)
$y = Draw-Text $g 'Code Editor' 'Segoe UI' 8.5 $false $MUTED $cx ($y+1)
Draw-Text $g ("v" + $Version) 'Segoe UI' 7.5 $false ([System.Drawing.Color]::FromArgb(170, $MUTED.R, $MUTED.G, $MUTED.B)) $cx ($SH-24) | Out-Null
$sidebarBmp = Join-Path $OutDir 'installerSidebar.bmp'
$canvas.Bmp.Save($sidebarBmp, [System.Drawing.Imaging.ImageFormat]::Bmp)
$g.Dispose(); $canvas.Bmp.Dispose()

# --- Header 150 x 57 --------------------------------------------------------
$HW = 150; $HH = 57
$canvas = New-Canvas $HW $HH
$g = $canvas.G
Fill-VerticalGradient $g $HW $HH $BG_TOP $BG_BOT
Add-Glow $g 24 28 60 $ACCENT 60
Add-Glow $g $HW 52 70 $ACCENT_3 34
$logoRect = New-Object System.Drawing.Rectangle(12, 12, 33, 33)
$g.DrawImage($logoImg, 12, 12, 33, 33)
$fmtL = New-Object System.Drawing.StringFormat
$fontT = New-Object System.Drawing.Font('Segoe UI', 13.5, [System.Drawing.FontStyle]::Bold)
$bT = New-Object System.Drawing.SolidBrush($TEXT)
$g.DrawString('NovaCode', $fontT, $bT, 52, 12, $fmtL)
$fontS = New-Object System.Drawing.Font('Segoe UI', 7.5, [System.Drawing.FontStyle]::Regular)
$bS = New-Object System.Drawing.SolidBrush($MUTED)
$g.DrawString('Setup Wizard', $fontS, $bS, 53, 34, $fmtL)
Draw-AccentBar $g 0 ($HH-2) $HW 2
$headerBmp = Join-Path $OutDir 'installerHeader.bmp'
$canvas.Bmp.Save($headerBmp, [System.Drawing.Imaging.ImageFormat]::Bmp)
$fontT.Dispose(); $fontS.Dispose(); $bT.Dispose(); $bS.Dispose(); $fmtL.Dispose()
$g.Dispose(); $canvas.Bmp.Dispose()

# --- ICO (PNG-in-ICO, Vista+): 16,24,32,48,64,128,256 -----------------------
$sizes = 16,24,32,48,64,128,256
$blobs = @()
foreach ($s in $sizes) {
  $nb = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $ng = [System.Drawing.Graphics]::FromImage($nb)
  $ng.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $ng.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $ng.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $ng.DrawImage($logoImg, 0, 0, $s, $s)
  $ng.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $nb.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $nb.Dispose()
  $blobs += ,($ms.ToArray())
  $ms.Dispose()
}
function Write-Ico([string]$path, $blobs, $sizes) {
  $fs = New-Object System.IO.FileStream($path, [System.IO.FileMode]::Create)
  $bw = New-Object System.IO.BinaryWriter($fs)
  $bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$blobs.Count)
  $offset = 6 + (16 * $blobs.Count)
  for ($i = 0; $i -lt $blobs.Count; $i++) {
    $s = $sizes[$i]; $b = $blobs[$i]
    $dim = if ($s -ge 256) { 0 } else { $s }
    $bw.Write([byte]$dim); $bw.Write([byte]$dim)   # width, height (0 == 256)
    $bw.Write([byte]0);    $bw.Write([byte]0)      # color count, reserved
    $bw.Write([uint16]1);  $bw.Write([uint16]32)   # planes, bit count
    $bw.Write([uint32]$b.Length); $bw.Write([uint32]$offset)
    $offset += $b.Length
  }
  foreach ($b in $blobs) { $bw.Write($b) }
  $bw.Flush(); $bw.Close(); $fs.Dispose()
}
Write-Ico (Join-Path $OutDir 'installerIcon.ico')   $blobs $sizes
Write-Ico (Join-Path $OutDir 'uninstallerIcon.ico') $blobs $sizes

$logoImg.Dispose()
Write-Host 'Generated:' -ForegroundColor Green
Get-ChildItem $OutDir -Include installerSidebar.bmp,installerHeader.bmp,installerIcon.ico,uninstallerIcon.ico -Recurse |
  ForEach-Object { Write-Host ("  {0}  ({1:N0} bytes)" -f $_.Name, $_.Length) }
