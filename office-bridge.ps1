# Ponte COM entre o Imago e o Microsoft Office (PowerPoint, Word, Excel).
#
# Roda como processo filho do Imago (ver "office" em modules.js). Protocolo por linhas JSON:
#   stdin  <- comandos:  {"cmd":"ppt.next"}  {"cmd":"ppt.goto","index":5} ...
#   stdout -> eventos:   {"type":"state",...} {"type":"slides",...} {"type":"thumb",...}
#
# Toda chamada COM fica dentro de try/catch: o Office recusa chamadas quando
# esta ocupado (ex: celula em edicao), e isso nunca deve derrubar a ponte.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Emit($obj) {
  $json = ConvertTo-Json -InputObject $obj -Compress -Depth 8
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

# ---------- Leitura do stdin em segundo plano (nao bloqueia o laco principal) ----------
$queue = New-Object 'System.Collections.Concurrent.ConcurrentQueue[string]'
$rs = [runspacefactory]::CreateRunspace()
$rs.Open()
$rs.SessionStateProxy.SetVariable('q', $queue)
$reader = [powershell]::Create()
$reader.Runspace = $rs
[void]$reader.AddScript({
  $r = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
  while ($true) {
    $l = $r.ReadLine()
    if ($null -eq $l) { break }
    $q.Enqueue($l)
  }
  $q.Enqueue('__EOF__')
})
[void]$reader.BeginInvoke()

# ---------- Utilidades COM ----------
function Get-App([string]$progId) {
  try { return [System.Runtime.InteropServices.Marshal]::GetActiveObject($progId) } catch { return $null }
}

function Safe([scriptblock]$block, $default = $null) {
  try { return & $block } catch { return $default }
}

$script:target = $null          # @{ app = 'powerpoint'|'word'|'excel'; name = '...' }
$script:lastJson = ''
$script:pptKey = ''             # assinatura da apresentacao (recalcula a lista de slides)
$script:pptDetailIndex = -1     # slide cujas notas/midia ja foram lidas
$script:pptDetail = @{ notes = ''; media = @() }
$script:thumbQueue = New-Object System.Collections.ArrayList
$script:thumbW = 400
$script:slowCache = @{}
$script:showClock = $null
$script:forceSlides = $false
$tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) 'imago-thumbs'
[void][System.IO.Directory]::CreateDirectory($tmpDir)

# ---------- PowerPoint ----------
function Get-PptPresentation($app) {
  $ssw = $null; $pres = $null
  if (Safe { $app.SlideShowWindows.Count } 0) {
    $ssw = $app.SlideShowWindows.Item(1)
    $pres = $ssw.Presentation
    return @{ pres = $pres; ssw = $ssw }
  }
  if ($script:target -and $script:target.app -eq 'powerpoint') {
    foreach ($p in $app.Presentations) {
      if ($p.Name -eq $script:target.name) { return @{ pres = $p; ssw = $null } }
    }
  }
  if (Safe { $app.Presentations.Count } 0) {
    $pres = Safe { $app.ActivePresentation }
    if ($pres) { return @{ pres = $pres; ssw = $null } }
  }
  return $null
}

function Get-SlideTitle($slide, [int]$i) {
  $t = ''
  try {
    if ($slide.Shapes.HasTitle) { $t = [string]$slide.Shapes.Title.TextFrame.TextRange.Text }
  } catch {}
  if (-not $t) {
    try {
      foreach ($sh in $slide.Shapes) {
        if ($sh.HasTextFrame -and $sh.TextFrame.HasText) { $t = [string]$sh.TextFrame.TextRange.Text; break }
      }
    } catch {}
  }
  $t = ($t -replace '[\r\n\v]+', ' ').Trim()
  if ($t.Length -gt 90) { $t = $t.Substring(0, 90) }
  if (-not $t) { $t = "Slide $i" }
  return $t
}

function Get-SlideNotes($slide) {
  try {
    foreach ($sh in $slide.NotesPage.Shapes) {
      if ($sh.Type -eq 14 -and $sh.PlaceholderFormat.Type -eq 2) {
        if ($sh.HasTextFrame -and $sh.TextFrame.HasText) {
          return (([string]$sh.TextFrame.TextRange.Text) -replace '\r', "`n").Trim()
        }
      }
    }
  } catch {}
  return ''
}

function Get-SlideMedia($slide) {
  $list = @()
  try {
    foreach ($sh in $slide.Shapes) {
      if ($sh.Type -eq 16) {
        $kind = 'video'
        if ((Safe { $sh.MediaType } 3) -eq 2) { $kind = 'audio' }
        $list += @{ name = [string]$sh.Name; kind = $kind }
      }
    }
  } catch {}
  return , $list
}

function Send-PptSlides($pres) {
  $slides = @()
  $n = $pres.Slides.Count
  for ($i = 1; $i -le $n; $i++) {
    $s = $pres.Slides.Item($i)
    $sec = ''
    try {
      if ($pres.SectionProperties.Count -gt 0) {
        $si = $s.sectionIndex
        if ($si -gt 0) { $sec = [string]$pres.SectionProperties.Name($si) }
      }
    } catch {}
    $slides += @{
      i = $i
      title = (Get-SlideTitle $s $i)
      hidden = [bool]((Safe { $s.SlideShowTransition.Hidden } 0) -ne 0)
      section = $sec
    }
  }
  Emit @{ type = 'slides'; name = [string]$pres.Name; total = $n; slides = $slides }
}

function Get-PptState($app) {
  $ctx = Get-PptPresentation $app
  if (-not $ctx) { return $null }
  $pres = $ctx.pres; $ssw = $ctx.ssw
  $name = [string]$pres.Name
  $total = [int]$pres.Slides.Count
  $key = "$name|$total|$($pres.FullName)"
  if ($key -ne $script:pptKey -or $script:forceSlides) {
    $script:pptKey = $key
    $script:pptDetailIndex = -1
    $script:forceSlides = $false
    $script:thumbQueue.Clear()
    Send-PptSlides $pres
  }

  $inShow = $false; $current = 1; $showState = 'edit'; $elapsed = 0
  if ($ssw) {
    $inShow = $true
    $view = $ssw.View
    $current = [int](Safe { $view.Slide.SlideIndex } 1)
    $st = [int](Safe { $view.State } 1)
    $showState = switch ($st) { 1 { 'running' } 2 { 'paused' } 3 { 'black' } 4 { 'white' } 5 { 'done' } default { 'running' } }
    $elapsed = [int](Safe { $view.PresentationElapsedTime } 0)
    if ($elapsed -le 0) {
      if (-not $script:showClock) { $script:showClock = [System.Diagnostics.Stopwatch]::StartNew() }
      $elapsed = [int]$script:showClock.Elapsed.TotalSeconds
    }
  } else {
    $script:showClock = $null
    $current = [int](Safe { $app.ActiveWindow.View.Slide.SlideIndex } 1)
  }
  if ($current -lt 1) { $current = 1 }
  if ($current -gt $total) { $current = $total }

  if ($current -ne $script:pptDetailIndex -and $total -gt 0) {
    $slide = $pres.Slides.Item($current)
    $script:pptDetail = @{ notes = (Get-SlideNotes $slide); media = (Get-SlideMedia $slide) }
    $script:pptDetailIndex = $current
  }

  $title = ''; $hidden = $false
  if ($total -gt 0) {
    $slide = $pres.Slides.Item($current)
    $title = Get-SlideTitle $slide $current
    $hidden = [bool]((Safe { $slide.SlideShowTransition.Hidden } 0) -ne 0)
  }

  return @{
    name = $name; total = $total; current = $current; inShow = $inShow; showState = $showState
    elapsed = $elapsed; title = $title; hidden = $hidden
    notes = $script:pptDetail.notes; media = $script:pptDetail.media
  }
}

# ---------- Word ----------
function Get-WordDoc($app) {
  if ($script:target -and $script:target.app -eq 'word') {
    foreach ($d in $app.Documents) { if ($d.Name -eq $script:target.name) { return $d } }
  }
  return (Safe { $app.ActiveDocument })
}

function Get-WordState($app) {
  $doc = Get-WordDoc $app
  if (-not $doc) { return $null }
  $now = [DateTime]::Now
  $k = 'word:' + $doc.Name
  if (-not $script:slowCache.ContainsKey($k) -or ($now - $script:slowCache[$k].at).TotalSeconds -gt 3) {
    $heads = @()
    try {
      $items = $doc.GetCrossReferenceItems(1)
      $i = 0
      foreach ($t in $items) {
        $i++
        $s = [string]$t
        $lead = $s.Length - $s.TrimStart().Length
        $txt = $s.Trim()
        if ($txt.Length -gt 100) { $txt = $txt.Substring(0, 100) }
        $heads += @{ i = $i; text = $txt; lead = $lead }
        if ($i -ge 300) { break }
      }
    } catch {}
    $comments = @()
    try {
      $c = $doc.Comments.Count
      for ($i = 1; $i -le [Math]::Min($c, 100); $i++) {
        $cm = $doc.Comments.Item($i)
        $scope = ''
        try { $scope = [string]$cm.Scope.Text; if ($scope.Length -gt 80) { $scope = $scope.Substring(0, 80) } } catch {}
        $body = [string]$cm.Range.Text
        if ($body.Length -gt 400) { $body = $body.Substring(0, 400) }
        $comments += @{ i = $i; author = [string]$cm.Author; text = $body; scope = $scope }
      }
    } catch {}
    $script:slowCache[$k] = @{ at = $now; heads = $heads; comments = $comments }
  }
  $c = $script:slowCache[$k]
  $zoom = [int](Safe { $app.ActiveWindow.View.Zoom.Percentage } 100)
  return @{ name = [string]$doc.Name; headings = $c.heads; comments = $c.comments; zoom = $zoom }
}

# ---------- Excel ----------
function Get-ExcelBook($app) {
  if ($script:target -and $script:target.app -eq 'excel') {
    foreach ($b in $app.Workbooks) { if ($b.Name -eq $script:target.name) { return $b } }
  }
  return (Safe { $app.ActiveWorkbook })
}

function Get-ExcelState($app) {
  $wb = Get-ExcelBook $app
  if (-not $wb) { return $null }
  $sheets = @()
  $activeName = [string](Safe { $wb.ActiveSheet.Name } '')
  $i = 0
  foreach ($ws in $wb.Sheets) {
    $i++
    $vis = [int](Safe { $ws.Visible } -1)
    if ($vis -ne -1) { continue }
    $sheets += @{ i = $i; name = [string]$ws.Name; active = ([string]$ws.Name -eq $activeName) }
  }
  $objects = @()
  try {
    $j = 0
    foreach ($nm in $wb.Names) {
      $j++
      $vis = Safe { $nm.Visible } $true
      if (-not $vis) { continue }
      $objects += @{ kind = 'name'; i = $j; name = [string]$nm.Name }
      if ($objects.Count -ge 80) { break }
    }
  } catch {}
  try {
    $ws = $wb.ActiveSheet
    $j = 0
    foreach ($lo in $ws.ListObjects) { $j++; $objects += @{ kind = 'table'; i = $j; name = [string]$lo.Name } }
    $j = 0
    foreach ($co in $ws.ChartObjects()) { $j++; $objects += @{ kind = 'chart'; i = $j; name = [string]$co.Name } }
  } catch {}
  $zoom = [int](Safe { $app.ActiveWindow.Zoom } 100)
  return @{ name = [string]$wb.Name; sheets = $sheets; objects = $objects; zoom = $zoom }
}

# ---------- Poll: estado geral ----------
function Poll-State {
  $ppt = Get-App 'PowerPoint.Application'
  $word = Get-App 'Word.Application'
  $xl = Get-App 'Excel.Application'

  $docs = @()
  try { if ($ppt) { foreach ($p in $ppt.Presentations) { $docs += @{ app = 'powerpoint'; name = [string]$p.Name } } } } catch {}
  try { if ($word) { foreach ($d in $word.Documents) { $docs += @{ app = 'word'; name = [string]$d.Name } } } } catch {}
  try { if ($xl) { foreach ($b in $xl.Workbooks) { $docs += @{ app = 'excel'; name = [string]$b.Name } } } } catch {}

  # Apresentacao em andamento tem prioridade; senao respeita o alvo escolhido no celular.
  $appName = $null
  if ($ppt -and (Safe { $ppt.SlideShowWindows.Count } 0)) {
    $appName = 'powerpoint'
    $script:target = @{ app = 'powerpoint'; name = [string]$ppt.SlideShowWindows.Item(1).Presentation.Name }
  } elseif ($script:target) {
    $still = $docs | Where-Object { $_.app -eq $script:target.app -and $_.name -eq $script:target.name }
    if ($still) { $appName = $script:target.app } else { $script:target = $null }
  }
  if (-not $appName -and $docs.Count -gt 0) {
    $first = $docs[0]
    $appName = $first.app
    $script:target = @{ app = $first.app; name = $first.name }
  }

  $state = @{ type = 'state'; app = $appName; docs = $docs; target = $script:target }
  try {
    switch ($appName) {
      'powerpoint' { $state.ppt = Get-PptState $ppt }
      'word'       { $state.word = Get-WordState $word }
      'excel'      { $state.excel = Get-ExcelState $xl }
    }
  } catch { }

  $json = ConvertTo-Json -InputObject $state -Compress -Depth 8
  if ($json -ne $script:lastJson) {
    $script:lastJson = $json
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
  }
}

# ---------- Miniaturas (uma por vez, sem travar os comandos) ----------
function Process-Thumb {
  if ($script:thumbQueue.Count -eq 0) { return }
  $idx = [int]$script:thumbQueue[0]
  $script:thumbQueue.RemoveAt(0)
  $ppt = Get-App 'PowerPoint.Application'
  if (-not $ppt) { return }
  $ctx = Get-PptPresentation $ppt
  if (-not $ctx) { return }
  $pres = $ctx.pres
  if ($idx -lt 1 -or $idx -gt $pres.Slides.Count) { return }
  $w = [int]$script:thumbW
  $h = [int][Math]::Round($w * $pres.PageSetup.SlideHeight / $pres.PageSetup.SlideWidth)
  $file = Join-Path $tmpDir ("t" + [Guid]::NewGuid().ToString('N') + '.jpg')
  try {
    $pres.Slides.Item($idx).Export($file, 'JPG', $w, $h)
    $bytes = [System.IO.File]::ReadAllBytes($file)
    Emit @{ type = 'thumb'; name = [string]$pres.Name; index = $idx; data = [Convert]::ToBase64String($bytes) }
  } finally {
    Remove-Item -LiteralPath $file -ErrorAction SilentlyContinue
  }
}

# ---------- Comandos ----------
function Get-ShowView {
  $ppt = Get-App 'PowerPoint.Application'
  if ($ppt -and (Safe { $ppt.SlideShowWindows.Count } 0)) { return $ppt.SlideShowWindows.Item(1).View }
  return $null
}

function Handle-Command($c) {
  $ppt = Get-App 'PowerPoint.Application'
  $word = Get-App 'Word.Application'
  $xl = Get-App 'Excel.Application'
  switch ($c.cmd) {
    'ppt.next' {
      $v = Get-ShowView
      if ($v) { $v.Next() } elseif ($ppt) {
        $cur = [int]$ppt.ActiveWindow.View.Slide.SlideIndex
        if ($cur -lt $ppt.ActivePresentation.Slides.Count) { $ppt.ActiveWindow.View.GotoSlide($cur + 1) }
      }
    }
    'ppt.prev' {
      $v = Get-ShowView
      if ($v) { $v.Previous() } elseif ($ppt) {
        $cur = [int]$ppt.ActiveWindow.View.Slide.SlideIndex
        if ($cur -gt 1) { $ppt.ActiveWindow.View.GotoSlide($cur - 1) }
      }
    }
    'ppt.first' {
      $v = Get-ShowView
      if ($v) { $v.First() } elseif ($ppt) { $ppt.ActiveWindow.View.GotoSlide(1) }
    }
    'ppt.last' {
      $v = Get-ShowView
      if ($v) { $v.Last() } elseif ($ppt) { $ppt.ActiveWindow.View.GotoSlide($ppt.ActivePresentation.Slides.Count) }
    }
    'ppt.goto' {
      $n = [int]$c.index
      $v = Get-ShowView
      if ($v) { $v.GotoSlide($n) } elseif ($ppt) { $ppt.ActiveWindow.View.GotoSlide($n) }
    }
    'ppt.start' {
      $ctx = Get-PptPresentation $ppt
      if ($ctx -and -not $ctx.ssw) {
        $w = $ctx.pres.SlideShowSettings.Run()
        if ($c.fromCurrent -and $c.index) { Start-Sleep -Milliseconds 400; $w.View.GotoSlide([int]$c.index) }
      }
    }
    'ppt.end' { $v = Get-ShowView; if ($v) { $v.Exit() } }
    'ppt.black' {
      $v = Get-ShowView
      if ($v) { if ([int]$v.State -eq 3) { $v.State = 1 } else { $v.State = 3 } }
    }
    'ppt.white' {
      $v = Get-ShowView
      if ($v) { if ([int]$v.State -eq 4) { $v.State = 1 } else { $v.State = 4 } }
    }
    'ppt.toggleHidden' {
      $ctx = Get-PptPresentation $ppt
      if ($ctx) {
        $n = [int]$c.index
        $s = $ctx.pres.Slides.Item($n)
        if ((Safe { $s.SlideShowTransition.Hidden } 0) -ne 0) { $s.SlideShowTransition.Hidden = 0 } else { $s.SlideShowTransition.Hidden = -1 }
        $script:forceSlides = $true
      }
    }
    'ppt.media' {
      # Play/pause de midia do slide atual (nome do shape em $c.name)
      $v = Get-ShowView
      if ($v) {
        $sh = $v.Slide.Shapes.Item([string]$c.name)
        $sh.AnimationSettings.PlaySettings.PauseAnimation = $(if ($c.pause) { -1 } else { 0 })
      }
    }
    'ppt.focus' {
      $v = Get-ShowView
      if ($v) { [void](Safe { $ppt.SlideShowWindows.Item(1).Activate() }) }
      elseif ($ppt) { [void](Safe { $ppt.ActiveWindow.Activate() }) }
    }
    'thumbs' {
      if ($c.width) { $script:thumbW = [Math]::Max(120, [Math]::Min(800, [int]$c.width)) }
      # Limita o pedido (uma lista gigante travaria a ponte gerando miniaturas sem fim).
      foreach ($i in @($c.indices | Select-Object -First 500)) {
        $n = [int]$i
        if ($n -lt 1 -or $n -gt 5000) { continue }
        if ($script:thumbQueue.Count -ge 2000) { break }
        if (-not $script:thumbQueue.Contains($n)) { [void]$script:thumbQueue.Add($n) }
      }
    }
    'refresh' { $script:forceSlides = $true; $script:slowCache = @{}; $script:lastJson = '' }
    'select' {
      $script:target = @{ app = [string]$c.app; name = [string]$c.name }
      $script:lastJson = ''
      switch ($c.app) {
        'powerpoint' { foreach ($p in $ppt.Presentations) { if ($p.Name -eq $c.name) { $p.Windows.Item(1).Activate() } } }
        'word'       { foreach ($d in $word.Documents) { if ($d.Name -eq $c.name) { $d.Activate() } } }
        'excel'      { foreach ($b in $xl.Workbooks) { if ($b.Name -eq $c.name) { $b.Activate() } } }
      }
    }
    'word.goto' {
      $doc = Get-WordDoc $word
      if ($doc) {
        $word.Selection.GoTo(11, 1, [int]$c.index) | Out-Null
        [void](Safe { $word.ActiveWindow.ScrollIntoView($word.Selection.Range, $true) })
      }
    }
    'word.comment' {
      $doc = Get-WordDoc $word
      if ($doc) {
        $cm = $doc.Comments.Item([int]$c.index)
        $cm.Scope.Select()
        [void](Safe { $word.ActiveWindow.ScrollIntoView($word.Selection.Range, $true) })
      }
    }
    'word.zoom' {
      $p = [int]$word.ActiveWindow.View.Zoom.Percentage + [int]$c.delta
      $word.ActiveWindow.View.Zoom.Percentage = [Math]::Max(10, [Math]::Min(500, $p))
    }
    'word.focus' { [void](Safe { $word.ActiveWindow.Activate() }) }
    'excel.sheet' {
      $wb = Get-ExcelBook $xl
      if ($wb) { $wb.Sheets.Item([int]$c.index).Activate() }
    }
    'excel.object' {
      $wb = Get-ExcelBook $xl
      if (-not $wb) { break }
      switch ($c.kind) {
        'name' {
          $r = $wb.Names.Item([int]$c.index).RefersToRange
          $r.Worksheet.Activate(); $r.Select()
        }
        'table' { $wb.ActiveSheet.ListObjects.Item([int]$c.index).Range.Select() }
        'chart' { $wb.ActiveSheet.ChartObjects([int]$c.index).Activate() }
      }
    }
    'excel.zoom' {
      $p = [int]$xl.ActiveWindow.Zoom + [int]$c.delta
      $xl.ActiveWindow.Zoom = [Math]::Max(10, [Math]::Min(400, $p))
    }
    'excel.focus' { [void](Safe { $xl.ActiveWindow.Activate() }) }
    default { }
  }
}

# ---------- Laco principal ----------
Emit @{ type = 'ready' }
$running = $true
while ($running) {
  $line = $null
  while ($queue.TryDequeue([ref]$line)) {
    if ($line -eq '__EOF__') { $running = $false; break }
    if (-not $line.Trim()) { continue }
    $cmd = $null
    try {
      $cmd = $line | ConvertFrom-Json
      Handle-Command $cmd
    } catch {
      Emit @{ type = 'error'; cmd = [string]$cmd.cmd; message = $_.Exception.Message }
    }
  }
  if (-not $running) { break }
  try { Poll-State } catch { }
  try { Process-Thumb } catch { Emit @{ type = 'error'; cmd = 'thumbs'; message = $_.Exception.Message } }
  $delay = 200
  if ($script:thumbQueue.Count -gt 0) { $delay = 40 }
  Start-Sleep -Milliseconds $delay
}
