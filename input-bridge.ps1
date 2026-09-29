# Teclado e mouse do Imago no Windows SEM modulo nativo (nada de robotjs.node).
# O Imago manda uma linha JSON por comando no stdin:
#   {"k":"{RIGHT}"}  -> SendKeys      {"mv":1,"dx":5,"dy":-3} -> mover mouse
#   {"ck":1}         -> clique esquerdo
$ErrorActionPreference = 'Stop'
$sh = $null
try { $sh = New-Object -ComObject WScript.Shell } catch { [Console]::Error.WriteLine('SendKeys indisponivel: ' + $_.Exception.Message) }
$mouseOk = $false
try {
  Add-Type -Namespace Imago -Name Native -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, int e);'
  $mouseOk = $true
} catch { [Console]::Error.WriteLine('Mouse indisponivel: ' + $_.Exception.Message) }

while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $m = $line | ConvertFrom-Json
    if ($m.k -and $sh) { $sh.SendKeys([string]$m.k) }
    elseif ($m.mv -and $mouseOk) { [Imago.Native]::mouse_event(1, [int]$m.dx, [int]$m.dy, 0, 0) }
    elseif ($m.ck -and $mouseOk) { [Imago.Native]::mouse_event(2, 0, 0, 0, 0); [Imago.Native]::mouse_event(4, 0, 0, 0, 0) }
  } catch { [Console]::Error.WriteLine('Erro: ' + $_.Exception.Message) }
}
