# switch-memory-build.ps1 — point the user-scope `memory` MCP server at another build.
#
# Replaces the version string in ~/.claude.json as TEXT, after checking it occurs
# exactly once: that file can hold keys differing only by case (one project opened
# as E:\ and as e:\), and a JSON rewrite would silently drop one of them.
# Idempotent: a second run with the same arguments finds the config already
# pointing at -To and changes nothing. A timestamped .bak is written before every
# change, so repeated switches leave a trail rather than overwriting one backup.
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts/keep/switch-memory-build.ps1 -From 2.4.3-aaaaaaaa -To 2.4.3-bbbbbbbb
# Afterwards EVERY conversation must restart; a server on the old build can fail
# its writes once the new one has migrated the store.
param(
	[Parameter(Mandatory = $true)][string]$From,
	[Parameter(Mandatory = $true)][string]$To
)
$path = "$env:USERPROFILE\.claude.json"
$text = [IO.File]::ReadAllText($path)
$hits = ([regex]::Matches($text, [regex]::Escape($From))).Count
$already = ([regex]::Matches($text, [regex]::Escape($To))).Count
if ($hits -eq 0 -and $already -eq 1) {
	"already pointing at $To, nothing to do"
	exit 0
}
if ($hits -ne 1) {
	Write-Error "expected exactly 1 occurrence of $From in $path, found $hits (and $already of $To)"
	exit 1
}
$backup = "$path.bak-$(Get-Date -Format yyyy-MM-dd-HH-mm)"
[IO.File]::Copy($path, $backup, $true)
[IO.File]::WriteAllText($path, $text.Replace($From, $To), [Text.UTF8Encoding]::new($false))
"backup $backup"
"memory server now: $((Select-String -Path $path -Pattern 'local-memory-mcp-builds' | Select-Object -First 1).Line.Trim())"
