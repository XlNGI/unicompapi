Add-Type -AssemblyName System.Drawing
$source = [System.Drawing.Image]::FromFile('C:/Users/ADMINI~1/AppData/Local/Temp/codex-clipboard-da057593-f2f8-4e16-b459-eac713dfc003.png')
$bitmap = New-Object System.Drawing.Bitmap 1686,990
$g = [System.Drawing.Graphics]::FromImage($bitmap)
$g.SmoothingMode = 'AntiAlias'
$g.InterpolationMode = 'HighQualityBicubic'
$g.TextRenderingHint = 'AntiAliasGridFit'
function Fill($color,$x,$y,$w,$h) {
  $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($color))
  $g.FillRectangle($brush,$x,$y,$w,$h)
  $brush.Dispose()
}
function Label($text,$x,$y,$size=12,$color='#293240',$bold=$false) {
  $style = if ($bold) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }
  $font = New-Object System.Drawing.Font 'Microsoft YaHei UI',$size,$style,([System.Drawing.GraphicsUnit]::Pixel)
  $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($color))
  $g.DrawString($text,$font,$brush,$x,$y)
  $font.Dispose()
  $brush.Dispose()
}
function Line($color,$x1,$y1,$x2,$y2,$width=1) {
  $pen = New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml($color)),$width
  $g.DrawLine($pen,$x1,$y1,$x2,$y2)
  $pen.Dispose()
}
$g.DrawImage($source,0,0,1686,990)
Fill '#f7f9fc' 6 610 1680 330
Label '时间线' 22 630 16 '#202833' $true
Label '分割      删除      复制片段      左移      右移      恢复删除' 160 632 12
Label '文字       音乐       封面' 958 632 12
Label '-' 1244 626 23
Line '#cbd3df' 1280 642 1400 642 3
Line '#6657ec' 1280 642 1320 642 3
Fill '#6657ec' 1316 636 8 12
Label '+' 1413 626 21
Label '适配全部' 1460 632 12
Label '收起' 1600 632 12
Line '#dfe5ee' 20 663 1664 663
Fill '#eef2f7' 121 678 1542 40
Fill '#edf1f6' 121 718 1542 86
Fill '#f1f4f8' 121 812 1542 38
Fill '#f1f4f8' 121 858 1542 38
Label '视频主轨' 21 750 12 '#26313f' $true
Label '文字轨' 21 822 12 '#26313f' $true
Label '背景音乐' 21 868 12 '#26313f' $true
for ($sec=0; $sec -le 19; $sec++) {
  $x = 121 + $sec * 80
  Line '#c9d1df' $x 708 $x 717
  if ($sec % 3 -eq 0) { Label ('00:{0:00}' -f $sec) ($x+5) 687 11 '#637083' }
}
$clipWidth=403
Fill '#6657ec' 121 724 $clipWidth 76
Label '片段 1 · file-v' 130 726 11 '#ffffff'
Label '00:05.042' 455 726 11 '#ffffff'
$portrait = New-Object System.Drawing.Rectangle 793,195,174,350
for ($i=0; $i -lt 14; $i++) {
  $left = 123 + $i * 28.5
  $destination = New-Object System.Drawing.RectangleF $left,746,28.5,52
  $g.DrawImage($source,$destination,$portrait,([System.Drawing.GraphicsUnit]::Pixel))
  Line '#ffffff' $left 746 $left 798
}
Fill '#ffffff' 123 752 3 36
Fill '#ffffff' 519 752 3 36
Line '#6657ec' 523 724 523 800 2
Label '+ 添加文字' 137 822 11 '#778295'
Label '+ 添加音乐' 137 868 11 '#778295'
Line '#5865ca' 121 679 121 906 1.5
Fill '#5865ca' 117 677 9 7
Fill '#e2e7ee' 121 914 1542 5
Fill '#bdc6d2' 121 914 320 5
$bitmap.Save((Join-Path $PSScriptRoot 'timeline-layout-review.png'),[System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bitmap.Dispose()
$source.Dispose()
